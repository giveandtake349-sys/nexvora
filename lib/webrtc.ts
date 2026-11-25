/**
 * Live media over WebRTC (Milestone 3) — pure, unit-testable rules.
 *
 * The peer connection itself lives in components/LiveSession.tsx
 * (browser APIs cannot run in vitest). This module holds everything
 * that can be decided without a browser:
 *
 *   - the ICE configuration (public Google STUN only — there is NO
 *     TURN server, see the note below),
 *   - the "nexvora-control" data-channel message format + validation
 *     (mute state, track started/stopped, kill-switch — extended in
 *     Milestone 4 for file-transfer metadata, location, remote
 *     interaction, and notifications; binary file bytes use the
 *     separate "nexvora-file" channel, lib/file-transfer.ts),
 *   - the live-session phase state machine,
 *   - poll backoff (never a tight loop),
 *   - the grant model for publishing tracks: a side may only publish
 *     a track for a scope it holds a live grant for (the device owner
 *     is exempt — they own the device).
 *
 * HARD CONSENT BOUNDARY (non-negotiable, restated here because this
 * module is where media decisions are made): no stealth mode, no
 * hidden indicators, no silent screen capture. Screen sharing is
 * explicitly started by the device owner via getDisplayMedia — the
 * browser/OS system dialog + persistent OS indicator are never
 * bypassed, hidden, or worked around. A NEXVORA grant alone never
 * turns on a camera, microphone, or screen. Every active feature
 * shows a visible indicator on the remote device and the owner can
 * stop/revoke instantly.
 */
import type { PermissionScope } from "./permissions";
import { MAX_FILE_SIZE_BYTES, validateFileName } from "./file-transfer";
import {
  validateDeviceNotification,
  validateLocationFix,
  validateRemoteKeyEvent,
  validateRemotePointerEvent,
} from "./live-features";

/* ------------------------------------------------------------------ */
/* ICE servers — STUN only, NO TURN                                    */
/* ------------------------------------------------------------------ */

/**
 * Public Google STUN server, the only ICE server configured. There is
 * NO TURN server: no credentials exist for one and none is faked.
 * Consequence, stated honestly: direct peer-to-peer connections can
 * fail when both sides sit behind symmetric NATs or restrictive
 * firewalls. A TURN server is a future deployment item (see README /
 * docs/limitations.md) — it is not silently substituted with anything.
 */
export const ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
] as const;

export const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [...ICE_SERVERS],
};

/** Guard for tests: the config must never contain a TURN URL. */
export function iceConfigHasTurn(config: RTCConfiguration): boolean {
  const servers = config.iceServers ?? [];
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
  });
}

/* ------------------------------------------------------------------ */
/* Media tracks + the grant model                                      */
/* ------------------------------------------------------------------ */

/** The three publishable media kinds. Each maps 1:1 to a permission
 *  scope of the same name (lib/permissions.ts). */
export const MEDIA_TRACK_KINDS = ["screen", "camera", "microphone"] as const;

export type MediaTrackKind = (typeof MEDIA_TRACK_KINDS)[number];

export function isMediaTrackKind(value: unknown): value is MediaTrackKind {
  return (
    typeof value === "string" &&
    (MEDIA_TRACK_KINDS as readonly string[]).includes(value)
  );
}

/**
 * May this side publish a track of this kind? The device owner may
 * publish any of the three (they own the device — and the browser
 * still asks them explicitly via getDisplayMedia / getUserMedia).
 * A participant may publish only scopes they hold a live grant for.
 * The caller passes the scopes the server page computed as valid for
 * them — the client never decides grant validity itself.
 */
export function canPublishTrack(
  kind: MediaTrackKind,
  grantedScopes: readonly PermissionScope[],
  isOwner: boolean,
): boolean {
  if (isOwner) return true;
  return grantedScopes.includes(kind);
}

/**
 * May this side play the incoming remote audio (speaker)? Same rule:
 * the owner always may; a participant needs the live `speaker` scope.
 * Speaker playback is a separate control from the microphone mute —
 * muting the mic never mutes the speaker and vice versa.
 */
export function canPlayRemoteAudio(
  grantedScopes: readonly PermissionScope[],
  isOwner: boolean,
): boolean {
  if (isOwner) return true;
  return grantedScopes.includes("speaker");
}

/**
 * Milestone 4 gating — same rule for all four: the owner may always
 * (they own the device — and the browser/OS still asks them explicitly
 * at use time); a participant needs the live scope of the same name.
 * The caller passes the scopes the server page computed as valid —
 * the client never decides grant validity itself.
 */
export function canTransferFiles(
  grantedScopes: readonly PermissionScope[],
  isOwner: boolean,
): boolean {
  if (isOwner) return true;
  return grantedScopes.includes("file_transfer");
}

export function canShareLocation(
  grantedScopes: readonly PermissionScope[],
  isOwner: boolean,
): boolean {
  if (isOwner) return true;
  return grantedScopes.includes("location");
}

export function canUseRemoteInteraction(
  grantedScopes: readonly PermissionScope[],
  isOwner: boolean,
): boolean {
  if (isOwner) return true;
  return grantedScopes.includes("remote_interaction");
}

export function canShareNotifications(
  grantedScopes: readonly PermissionScope[],
  isOwner: boolean,
): boolean {
  if (isOwner) return true;
  return grantedScopes.includes("notifications");
}

/* ------------------------------------------------------------------ */
/* "nexvora-control" data channel (Milestone 4 extends this)          */
/* ------------------------------------------------------------------ */

/**
 * The single control channel on the peer connection. Created by the
 * offerer (the participant) and received by the answerer (the owner)
 * via `ondatachannel`. It carries only small JSON control messages —
 * never media, never file bytes. Milestone 4 extends it for file
 * transfer metadata (offer/approve/reject/cancel/complete), location,
 * remote interaction, and notifications. Binary file bytes are the
 * one exception: they use the dedicated "nexvora-file" channel
 * (lib/file-transfer.ts) so a stalled transfer can never delay a
 * kill-switch or any other control message.
 */
export const CONTROL_CHANNEL_NAME = "nexvora-control";

/** Mute state, sent whenever the local mic/camera mute changes. */
export interface MuteStateMessage {
  type: "mute-state";
  micMuted: boolean;
  cameraOff: boolean;
}

/** A track started publishing (screen / camera / microphone). The
 *  trackId lets the receiver label the incoming MediaStreamTrack in
 *  the right slot (screen vs camera) instead of guessing. */
export interface TrackStartedMessage {
  type: "track-started";
  track: MediaTrackKind;
  trackId: string;
}

export interface TrackStoppedMessage {
  type: "track-stopped";
  track: MediaTrackKind;
  trackId?: string;
}

/**
 * Kill-switch: the device owner ends the session for the other side
 * right now. The receiver tears down immediately (same as receiving
 * `bye` + session ended). This is an owner action, never a silent
 * one — the receiver sees a clear "session ended by the owner" state.
 */
export interface KillSwitchMessage {
  type: "kill-switch";
}

/* ------------------------------------------------------------------ */
/* Milestone 4 control messages                                        */
/*                                                                     */
/* File-transfer METADATA, location, remote interaction and            */
/* notifications all travel over this same "nexvora-control"          */
/* channel as small JSON messages. Binary file bytes are the ONLY     */
/* thing that does not: they use the dedicated "nexvora-file"         */
/* channel (lib/file-transfer.ts) so a stalled transfer can never     */
/* delay a kill-switch, a mute state, or an interaction stop.         */
/* ------------------------------------------------------------------ */

/**
 * File offer: the sender's per-file approval request. `transferId`
 * is the server-issued `file_transfers` row id (the sender creates
 * the metadata row via the API first, so the receiver can trust the
 * id is recorded). No bytes flow until the receiver answers with
 * `file-approve`. The receiver re-checks the declared size against
 * the 50 MB limit — a peer that lies about size is rejected here
 * before anything is downloaded.
 */
export interface FileOfferMessage {
  type: "file-offer";
  transferId: string;
  fileName: string;
  fileSizeBytes: number;
}

export interface FileApproveMessage {
  type: "file-approve";
  transferId: string;
}

export interface FileRejectMessage {
  type: "file-reject";
  transferId: string;
}

export interface FileCancelMessage {
  type: "file-cancel";
  transferId: string;
}

/** The receiver assembled every chunk: the transfer is complete. */
export interface FileCompleteMessage {
  type: "file-complete";
  transferId: string;
}

/**
 * Location sharing. `location-start` / `location-stop` bracket the
 * session; `location-update` carries one validated fix (latitude /
 * longitude / accuracy / timestamp). Sharing starts ONLY from an
 * explicit button click + the browser Geolocation prompt, and only
 * under a live `location` grant — never silently, never in the
 * background.
 */
export interface LocationStartMessage {
  type: "location-start";
}

export interface LocationStopMessage {
  type: "location-stop";
}

export interface LocationUpdateMessage {
  type: "location-update";
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
}

/**
 * Remote interaction (in-page ONLY — a browser cannot synthesize
 * OS-level input on the remote device). `interaction-start` is the
 * controlled side explicitly allowing it; `interaction-stop` is
 * either side ending it instantly (the owner's one-tap kill-switch
 * for interaction). `interaction-pointer` carries a normalised
 * pointer position / click on the shared view, rendered as a remote
 * cursor overlay; `interaction-key` carries a key the participant
 * pressed while focused on the shared view, shown as a visible log
 * entry on the controlled side — never injected anywhere.
 */
export interface InteractionStartMessage {
  type: "interaction-start";
}

export interface InteractionStopMessage {
  type: "interaction-stop";
}

export interface InteractionPointerMessage {
  type: "interaction-pointer";
  kind: "move" | "click";
  x: number;
  y: number;
}

export interface InteractionKeyMessage {
  type: "interaction-key";
  key: string;
}

/**
 * Notification feed. `notification-sharing-start` / `-stop` bracket
 * sharing from a real reporting device; `notification` carries one
 * validated notification (app / title / body / receivedAt). The web
 * side NEVER sends these — browsers cannot capture OS notifications
 * — so the feed populates only from a real reporting device
 * (Android NotificationListenerService, Milestone 6). No notification
 * data is faked anywhere.
 */
export interface NotificationSharingStartMessage {
  type: "notification-sharing-start";
}

export interface NotificationSharingStopMessage {
  type: "notification-sharing-stop";
}

export interface NotificationMessage {
  type: "notification";
  app: string;
  title: string;
  body: string;
  receivedAt: number;
}

/**
 * Session recording (v1). The recorder tells the peer when a
 * recording starts/stops (`recording-started` / `recording-stopped`)
 * so both sides always see the REC indicator. There is NO
 * per-session approval handshake: the one-time grant the owner gave
 * at pairing covers recording (any live screen / camera /
 * microphone grant — the "any-media" rule), so the Record button
 * starts right away. Recording stops immediately when access is
 * revoked, the session ends, or the peer leaves.
 */
export interface RecordingStartedMessage {
  type: "recording-started";
}

export interface RecordingStoppedMessage {
  type: "recording-stopped";
}

export type ControlMessage =
  | MuteStateMessage
  | TrackStartedMessage
  | TrackStoppedMessage
  | KillSwitchMessage
  | FileOfferMessage
  | FileApproveMessage
  | FileRejectMessage
  | FileCancelMessage
  | FileCompleteMessage
  | LocationStartMessage
  | LocationStopMessage
  | LocationUpdateMessage
  | InteractionStartMessage
  | InteractionStopMessage
  | InteractionPointerMessage
  | InteractionKeyMessage
  | NotificationSharingStartMessage
  | NotificationSharingStopMessage
  | NotificationMessage
  | RecordingStartedMessage
  | RecordingStoppedMessage;

export const CONTROL_MESSAGE_TYPES = [
  "mute-state",
  "track-started",
  "track-stopped",
  "kill-switch",
  "file-offer",
  "file-approve",
  "file-reject",
  "file-cancel",
  "file-complete",
  "location-start",
  "location-stop",
  "location-update",
  "interaction-start",
  "interaction-stop",
  "interaction-pointer",
  "interaction-key",
  "notification-sharing-start",
  "notification-sharing-stop",
  "notification",
  "recording-started",
  "recording-stopped",
] as const;

/**
 * Strict validation for inbound data-channel messages. Anything
 * malformed or of an unknown type is ignored (returns null) — a peer
 * must never be able to crash the session or inject a state the UI
 * cannot represent by sending a bad control message.
 */
export function parseControlMessage(value: unknown): ControlMessage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const msg = value as Record<string, unknown>;
  switch (msg.type) {
    case "mute-state":
      if (typeof msg.micMuted !== "boolean" || typeof msg.cameraOff !== "boolean") return null;
      return { type: "mute-state", micMuted: msg.micMuted, cameraOff: msg.cameraOff };
    case "track-started":
      if (!isMediaTrackKind(msg.track) || typeof msg.trackId !== "string" || !msg.trackId) return null;
      return { type: "track-started", track: msg.track, trackId: msg.trackId };
    case "track-stopped":
      if (!isMediaTrackKind(msg.track)) return null;
      if (msg.trackId !== undefined && typeof msg.trackId !== "string") return null;
      return {
        type: "track-stopped",
        track: msg.track,
        ...(typeof msg.trackId === "string" ? { trackId: msg.trackId } : {}),
      };
    case "kill-switch":
      return { type: "kill-switch" };
    case "file-offer": {
      if (typeof msg.transferId !== "string" || !msg.transferId) return null;
      // The receiver never trusts a client-supplied path: only a
      // validated bare name is accepted (same rule as the server).
      const name = validateFileName(msg.fileName);
      if (!name.ok) return null;
      if (
        typeof msg.fileSizeBytes !== "number" ||
        !Number.isSafeInteger(msg.fileSizeBytes) ||
        msg.fileSizeBytes <= 0 ||
        msg.fileSizeBytes > MAX_FILE_SIZE_BYTES
      ) {
        return null;
      }
      return {
        type: "file-offer",
        transferId: msg.transferId,
        fileName: name.name,
        fileSizeBytes: msg.fileSizeBytes,
      };
    }
    case "file-approve":
    case "file-reject":
    case "file-cancel":
    case "file-complete":
      if (typeof msg.transferId !== "string" || !msg.transferId) return null;
      return { type: msg.type, transferId: msg.transferId };
    case "location-start":
      return { type: "location-start" };
    case "location-stop":
      return { type: "location-stop" };
    case "location-update": {
      const fix = validateLocationFix(msg);
      if (!fix) return null;
      return { type: "location-update", ...fix };
    }
    case "interaction-start":
      return { type: "interaction-start" };
    case "interaction-stop":
      return { type: "interaction-stop" };
    case "interaction-pointer": {
      const pointer = validateRemotePointerEvent(msg);
      if (!pointer) return null;
      return { type: "interaction-pointer", ...pointer };
    }
    case "interaction-key": {
      const key = validateRemoteKeyEvent(msg);
      if (!key) return null;
      return { type: "interaction-key", ...key };
    }
    case "notification-sharing-start":
      return { type: "notification-sharing-start" };
    case "notification-sharing-stop":
      return { type: "notification-sharing-stop" };
    case "notification": {
      const notification = validateDeviceNotification(msg);
      if (!notification) return null;
      return { type: "notification", ...notification };
    }
    case "recording-started":
      return { type: "recording-started" };
    case "recording-stopped":
      return { type: "recording-stopped" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Live-session phase state machine                                    */
/* ------------------------------------------------------------------ */

/**
 * What the session UI shows. Only `live` means media is flowing and
 * the LIVE indicator is shown — every other phase shows its own
 * honest state (waiting / connecting / failed / ended / revoked /
 * peer disconnected), never a fake "live".
 */
export const LIVE_PHASES = [
  "idle",
  "starting",
  "waiting",
  "connecting",
  "live",
  "reconnecting",
  "failed",
  "ended",
  "revoked",
  "peer-disconnected",
] as const;

export type LivePhase = (typeof LIVE_PHASES)[number];

export const LIVE_PHASE_LABELS: Record<LivePhase, string> = {
  idle: "Not started",
  starting: "Starting session…",
  waiting: "Waiting for the other side to join…",
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Connection lost — trying to reconnect…",
  failed: "Connection failed",
  ended: "Session ended",
  revoked: "Access revoked",
  "peer-disconnected": "Peer disconnected",
};

export type LivePhaseEvent =
  | "begin"
  | "started"
  | "offer-sent"
  | "offer-received"
  | "connected"
  | "ice-failed"
  | "connection-lost"
  | "recovered"
  | "bye"
  | "session-ended"
  | "revoked"
  | "peer-gone"
  | "retry"
  | "end"
  | "error";

/**
 * Pure phase transitions. `ended` and `revoked` are terminal — a
 * session that ended or was revoked never returns to live without a
 * brand-new approved session. `peer-disconnected` and `failed` allow
 * a manual retry (the retry button); nothing retries in a loop.
 */
export function transitionLivePhase(phase: LivePhase, event: LivePhaseEvent): LivePhase {
  switch (phase) {
    case "idle":
      return event === "begin" ? "starting" : phase;
    case "starting":
      if (event === "started") return "waiting";
      if (event === "revoked") return "revoked";
      if (event === "error") return "failed";
      if (event === "end" || event === "session-ended") return "ended";
      return phase;
    case "waiting":
      if (event === "offer-sent" || event === "offer-received") return "connecting";
      if (event === "connected") return "live";
      if (event === "bye" || event === "peer-gone") return "peer-disconnected";
      if (event === "session-ended" || event === "end") return "ended";
      if (event === "revoked") return "revoked";
      return phase;
    case "connecting":
      if (event === "connected") return "live";
      if (event === "ice-failed" || event === "error") return "failed";
      if (event === "bye" || event === "peer-gone") return "peer-disconnected";
      if (event === "session-ended" || event === "end") return "ended";
      if (event === "revoked") return "revoked";
      return phase;
    case "live":
      if (event === "ice-failed" || event === "error") return "failed";
      if (event === "connection-lost") return "reconnecting";
      if (event === "bye" || event === "peer-gone") return "peer-disconnected";
      if (event === "session-ended" || event === "end") return "ended";
      if (event === "revoked") return "revoked";
      return phase;
    case "reconnecting":
      if (event === "connected" || event === "recovered") return "live";
      if (event === "ice-failed" || event === "error") return "failed";
      if (event === "bye" || event === "peer-gone") return "peer-disconnected";
      if (event === "session-ended" || event === "end") return "ended";
      if (event === "revoked") return "revoked";
      return phase;
    case "failed":
      if (event === "retry") return "starting";
      if (event === "end" || event === "session-ended") return "ended";
      if (event === "revoked") return "revoked";
      return phase;
    case "peer-disconnected":
      if (event === "retry") return "starting";
      if (event === "end" || event === "session-ended") return "ended";
      if (event === "revoked") return "revoked";
      return phase;
    case "ended":
    case "revoked":
      return phase;
    default:
      return phase;
  }
}

/* ------------------------------------------------------------------ */
/* Poll backoff — never a tight loop                                   */
/* ------------------------------------------------------------------ */

/** Base short-poll interval (2s, from the Milestone 2 contract). */
export const LIVE_POLL_BASE_MS = 2000;
/** Backoff ceiling for consecutive poll failures. */
export const LIVE_POLL_MAX_BACKOFF_MS = 30_000;

/**
 * Delay before the next poll after `consecutiveFailures` failures in
 * a row (0 failures = the normal 2s interval). Exponential backoff,
 * capped at 30s — a dead network never turns into a tight retry loop,
 * and a recovered network is picked up within 30s at worst.
 */
export function nextPollDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return LIVE_POLL_BASE_MS;
  const delay = LIVE_POLL_BASE_MS * 2 ** consecutiveFailures;
  return Math.min(delay, LIVE_POLL_MAX_BACKOFF_MS);
}

/* ------------------------------------------------------------------ */
/* Offer negotiation gate — one offer in flight, none lost             */
/* ------------------------------------------------------------------ */

/**
 * What one negotiation attempt reports back to the gate.
 * - "negotiated": an offer was created, set as the local description
 *   and sent. The peer connection is now awaiting an answer.
 * - "not-stable": the peer connection is mid-handshake
 *   (have-local-offer / have-remote-offer), so no offer may be
 *   created right now. The need is remembered, not dropped.
 * - "failed": the attempt itself errored (createOffer /
 *   setLocalDescription / send threw, or the peer connection was
 *   replaced mid-flight). The need is remembered unless the caller
 *   says otherwise.
 */
export type NegotiationOutcome = "negotiated" | "not-stable" | "failed";

/**
 * Serialises offer creation for ONE RTCPeerConnection.
 *
 * ROOT CAUSE (live bug, Nov 25 2026 — reproduced 5/5 in headless
 * Chrome): `onnegotiationneeded` fires when the data channels are
 * created at peer-connection setup, and `boot()` ALSO creates an
 * offer explicitly. Both paths check `signalingState === "stable"`
 * and both call `createOffer()` while the state is still "stable"
 * (the first `setLocalDescription` has not run yet), so TWO offers
 * are created concurrently. The first `setLocalDescription` wins;
 * the second throws exactly:
 *   "Failed to execute 'setLocalDescription' on 'RTCPeerConnection':
 *    Failed to set local offer sdp: The order of m-lines in
 *    subsequent offer doesn't match order from previous
 *    offer/answer."
 * The losing call then surfaced as "Could not create an offer" and
 * flipped the phase to failed, while the winning offer's handshake
 * still needed an answer — the session never went live.
 *
 * The gate fixes this without touching signaling: at most one
 * attempt runs at a time. A request that arrives while one is in
 * flight is remembered (`pending`) and retried once the in-flight
 * attempt finishes; a request that finds the connection mid-handshake
 * ("not-stable") is likewise remembered and retried via `drain()`,
 * which the caller invokes after applying a remote answer — the
 * moment the connection is stable again. Nothing is ever dropped
 * silently, and no second offer can be created while one is pending.
 */
export class NegotiationGate {
  private busy = false;
  private pending = false;

  /**
   * Request one negotiation attempt. If another attempt is running,
   * the request is remembered and retried automatically when it
   * finishes — the caller never has to re-request.
   */
  async request(attempt: () => Promise<NegotiationOutcome>): Promise<void> {
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    try {
      for (;;) {
        const outcome = await attempt();
        if (outcome === "negotiated" && this.pending) {
          // A change arrived while we worked (e.g. a track was
          // added): negotiate again for it — but only once per
          // remembered request, so this loop always terminates.
          this.pending = false;
          continue;
        }
        if (outcome === "not-stable") this.pending = true;
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Retry a remembered negotiation now that the connection is stable
   * again — call after applying a remote answer. No-op when nothing
   * is pending or an attempt is already running (its loop picks the
   * pending request up).
   */
  drain(attempt: () => Promise<NegotiationOutcome>): void {
    if (!this.pending || this.busy) return;
    this.pending = false;
    void this.request(attempt);
  }

  /** Forget everything (peer connection torn down / retry / unmount).
   *  An attempt already in flight finishes harmlessly — it checks
   *  that its peer connection is still current before touching it. */
  reset(): void {
    this.busy = false;
    this.pending = false;
  }
}
