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
 *     (mute state, track started/stopped, kill-switch — the channel
 *     Milestone 4 will extend for file transfer / location / remote
 *     interaction),
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

/* ------------------------------------------------------------------ */
/* "nexvora-control" data channel (Milestone 4 extends this)          */
/* ------------------------------------------------------------------ */

/**
 * The single data channel on the peer connection. Created by the
 * offerer (the participant) and received by the answerer (the owner)
 * via `ondatachannel`. It carries only small control messages —
 * never media, never file content. Milestone 4 will extend this same
 * channel for file transfer / location / remote interaction; no
 * second channel is planned.
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

export type ControlMessage =
  | MuteStateMessage
  | TrackStartedMessage
  | TrackStoppedMessage
  | KillSwitchMessage;

export const CONTROL_MESSAGE_TYPES = [
  "mute-state",
  "track-started",
  "track-stopped",
  "kill-switch",
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
