"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Toggle } from "./ui";
import { HEARTBEAT_INTERVAL_MS } from "@/lib/signaling";
import {
  createSignalingClient,
  createSignalPoller,
  SignalingApiError,
  type SignalingClient,
} from "@/lib/signaling-client";
import {
  CONTROL_CHANNEL_NAME,
  LIVE_PHASE_LABELS,
  RTC_CONFIGURATION,
  NegotiationGate,
  canPlayRemoteAudio,
  canPublishTrack,
  canShareLocation,
  canShareNotifications,
  canTransferFiles,
  canUseRemoteInteraction,
  parseControlMessage,
  transitionLivePhase,
  type ControlMessage,
  type LivePhase,
  type LivePhaseEvent,
  type MediaTrackKind,
  type NegotiationOutcome,
} from "@/lib/webrtc";
import {
  FILE_BUFFERED_AMOUNT_HIGH_WATERMARK,
  FILE_BUFFERED_AMOUNT_LOW_WATERMARK,
  FILE_CHANNEL_NAME,
  FILE_CHUNK_SIZE_BYTES,
  chunkCountFor,
  decodeFileChunk,
  encodeFileChunk,
  transferProgressPercent,
  validateFileName,
  validateFileSize,
  type FileTransferStatus,
} from "@/lib/file-transfer";
import {
  appendNotificationFeed,
  formatCoordinates,
  openStreetMapLink,
  shouldSendLocationUpdate,
  type DeviceNotification,
  type LiveSessionAuditAction,
  type LocationFix,
} from "@/lib/live-features";
import {
  MAX_RECORDING_DURATION_MS,
  RECORDING_CHUNK_TIMESLICE_MS,
  assembleRecordingBlob,
  canRecord,
  formatRecordingDuration,
  hasRecordableTrack,
  pickRecordingMimeType,
  pickRecordingTracks,
  shouldAutoStopRecording,
  transitionRecordingState,
  type RecordingEvent,
  type RecordingState,
} from "@/lib/recording";
import {
  buildRecordingMeta,
  saveRecording,
  type RecordingVideoKind,
} from "@/lib/recordings";
import type { PermissionScope } from "@/lib/permissions";
import type { SignalingMessage, SignalingState } from "@/lib/types";

/**
 * Live session view (Milestone 3) — WebRTC media over the Milestone 2
 * signaling API. One RTCPeerConnection, short-polled signaling (2s),
 * one "nexvora-control" data channel, STUN-only ICE.
 *
 * Roles (deterministic, so the handshake can never glare): the
 * PARTICIPANT creates the offer; the OWNER (device owner) waits for
 * it and answers. Either side may publish screen / camera / mic, but
 * only for scopes it holds a live grant for (the server page computed
 * `grantedScopes`; the owner implicitly holds all four on their own
 * device).
 *
 * CONSENT — the whole component is built around it:
 * - Screen share starts ONLY from the owner's explicit button click,
 *   via getDisplayMedia: the browser/OS system dialog + persistent OS
 *   indicator appear, and cancelling the dialog is a silent no-op
 *   (no error state, no fake "sharing" indicator).
 * - Camera/mic start ONLY from an explicit button click via
 *   getUserMedia, with the browser/OS indicator while active.
 * - Stopping (button, or the browser's own "Stop sharing") removes
 *   the track and notifies the peer.
 * - Nothing shows as LIVE unless the peer connection is actually
 *   connected; revocation tears everything down immediately.
 *
 * Milestone 4 adds, on the same peer connection: file transfer
 * (metadata over "nexvora-control", bytes over "nexvora-file", owner
 * approval per file, 50 MB limit), location sharing (explicit start
 * + browser Geolocation prompt, live `location` grant only),
 * in-page-only remote interaction (remote cursor overlay + click/key
 * forwarding to the shared view — a browser cannot synthesize
 * OS-level input, and this is never presented as full remote
 * control), and a notification feed fed ONLY by a real reporting
 * device (the web side never sends notification data — browsers
 * cannot capture OS notifications). Every M4 feature shows a visible
 * indicator while active and can be stopped instantly by the owner.
 *
 * Joining is an explicit button click (not auto-start on mount):
 * the click is the user gesture browsers need to allow remote
 * audio/video autoplay with sound.
 */

interface RemoteTrackView {
  id: string;
  slot: "screen" | "camera" | "microphone";
  kind: "video" | "audio";
  stream: MediaStream;
}

/**
 * Module-scope clock. Component-scope functions must never call
 * Date.now() directly (react-hooks/purity forbids impure calls
 * there); every timestamp in this file goes through this helper.
 */
function nowMs(): number {
  return Date.now();
}

const ACTIVE_PHASES: LivePhase[] = ["waiting", "connecting", "live", "reconnecting"];

/* ---------------- Milestone 4 state shapes ---------------- */

/** Local UI status of a transfer. "offered" is the local name for the
 *  server's "pending" status (offer sent / received, awaiting the
 *  receiver's decision). */
type LocalTransferStatus = "offered" | "approved" | "in_progress" | "completed" | "rejected" | "failed";

interface OutgoingTransfer {
  transferId: string;
  fileName: string;
  fileSizeBytes: number;
  status: LocalTransferStatus;
  sentBytes: number;
}

interface IncomingTransfer {
  transferId: string;
  fileName: string;
  fileSizeBytes: number;
  status: LocalTransferStatus;
  receivedBytes: number;
  /** Object URL of the assembled file, once complete. */
  downloadUrl: string | null;
}

const TRANSFER_STATUS_LABELS: Record<LocalTransferStatus, string> = {
  offered: "Waiting for approval",
  approved: "Approved",
  in_progress: "Transferring",
  completed: "Completed",
  rejected: "Rejected",
  failed: "Failed",
};

function isSdpPayload(payload: unknown): payload is RTCSessionDescriptionInit {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.type === "string" &&
    ["offer", "answer", "pranswer", "rollback"].includes(p.type) &&
    typeof p.sdp === "string"
  );
}

export default function LiveSession({
  sessionId,
  deviceName,
  isOwner,
  grantedScopes,
  peerLabel,
}: {
  sessionId: string;
  deviceName: string;
  isOwner: boolean;
  /** Media scopes the caller may publish (server-computed, valid grants). */
  grantedScopes: PermissionScope[];
  peerLabel: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<LivePhase>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [peerAlive, setPeerAlive] = useState(false);
  const [signalingState, setSignalingState] = useState<SignalingState>("created");
  const [controlOpen, setControlOpen] = useState(false);
  const [localScreenOn, setLocalScreenOn] = useState(false);
  const [localCameraOn, setLocalCameraOn] = useState(false);
  const [localMicOn, setLocalMicOn] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [localPreview, setLocalPreview] = useState<MediaStream | null>(null);
  const [remoteTracks, setRemoteTracks] = useState<RemoteTrackView[]>([]);
  const [remoteMicMuted, setRemoteMicMuted] = useState(false);
  const [remoteCameraOff, setRemoteCameraOff] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [speakerVolume, setSpeakerVolume] = useState(80);

  /* ---------------- Milestone 4 state ---------------- */
  const [fileChannelOpen, setFileChannelOpen] = useState(false);
  const [outgoingTransfer, setOutgoingTransfer] = useState<OutgoingTransfer | null>(null);
  const [incomingTransfer, setIncomingTransfer] = useState<IncomingTransfer | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sharingLocation, setSharingLocation] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [peerLocation, setPeerLocation] = useState<LocationFix | null>(null);
  const [peerSharingLocation, setPeerSharingLocation] = useState(false);
  const [allowInteraction, setAllowInteraction] = useState(false);
  const [peerAllowsInteraction, setPeerAllowsInteraction] = useState(false);
  const [remoteCursor, setRemoteCursor] = useState<{ x: number; y: number; kind: "move" | "click"; at: number } | null>(null);
  const [interactionKeys, setInteractionKeys] = useState<string[]>([]);
  const [notificationFeed, setNotificationFeed] = useState<DeviceNotification[]>([]);
  const [peerSharingNotifications, setPeerSharingNotifications] = useState(false);

  /* ---------------- Session recording (v1) state ---------------- */
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [peerRecording, setPeerRecording] = useState(false);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordingSavedAt, setRecordingSavedAt] = useState<number | null>(null);

  /* ---------------- Redesign (Opus Spec v2.0 Ch. 3–4) state ---------------- */
  const [fullView, setFullView] = useState(false);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [qualitySheetOpen, setQualitySheetOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const [typeText, setTypeText] = useState("");
  const [clockNow, setClockNow] = useState(() => nowMs());
  const padPosRef = useRef({ x: 0.5, y: 0.5 });
  const padDraggingRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const phaseRef = useRef<LivePhase>("idle");
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const clientRef = useRef<SignalingClient | null>(null);
  const pollerRef = useRef<ReturnType<typeof createSignalPoller> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const localStreamsRef = useRef(new Map<MediaTrackKind, MediaStream>());
  const sendersRef = useRef(new Map<MediaTrackKind, RTCRtpSender>());
  const trackKindByIdRef = useRef(new Map<string, MediaTrackKind>());
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const negotiationGateRef = useRef(new NegotiationGate());
  const wasLiveRef = useRef(false);
  const micMutedRef = useRef(false);
  const cameraOffRef = useRef(false);
  const remoteTracksRef = useRef<RemoteTrackView[]>([]);
  const localPreviewRef = useRef<HTMLVideoElement | null>(null);
  const remoteScreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileChannelRef = useRef<RTCDataChannel | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const outgoingFileRef = useRef<File | null>(null);
  const outgoingTransferRef = useRef<OutgoingTransfer | null>(null);
  const incomingTransferRef = useRef<IncomingTransfer | null>(null);
  const incomingChunksRef = useRef(new Map<number, Uint8Array<ArrayBuffer>>());
  const locationWatchRef = useRef<number | null>(null);
  const lastLocationSentRef = useRef<number | null>(null);
  const peerSharingLocationRef = useRef(false);
  const peerSharingNotificationsRef = useRef(false);
  const allowInteractionRef = useRef(false);
  const peerAllowsInteractionRef = useRef(false);
  const remoteScreenBoxRef = useRef<HTMLDivElement | null>(null);
  const recordingStateRef = useRef<RecordingState>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingMimeRef = useRef("");
  const recordingVideoKindRef = useRef<RecordingVideoKind>("none");
  const recordingHasAudioRef = useRef(false);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);

  const audioAllowed = canPlayRemoteAudio(grantedScopes, isOwner);
  const remoteScreen = remoteTracks.find((t) => t.slot === "screen" && t.kind === "video");
  const remoteCamera = remoteTracks.find((t) => t.slot === "camera" && t.kind === "video");
  const remoteAudio = remoteTracks.find((t) => t.slot === "microphone");
  const remoteScreenOn = Boolean(remoteScreen);
  const remoteCameraOn = Boolean(remoteCamera);
  const remoteMicOn = Boolean(remoteAudio);
  const joined = ACTIVE_PHASES.includes(phase) || phase === "failed" || phase === "peer-disconnected";

  /** Render-time check: is any remote track live right now? Derived
   *  from STATE (remoteTracks), never from refs — refs must not be
   *  read during render (react-hooks/refs). */
  const remoteTracksLiveNow = remoteTracks.some((t) =>
    t.stream.getTracks().some((track) => track.readyState === "live"),
  );

  /* ---------------- phase + teardown ---------------- */

  function applyPhase(event: LivePhaseEvent): void {
    const next = transitionLivePhase(phaseRef.current, event);
    phaseRef.current = next;
    setPhase(next);
  }

  function setRemoteTrackViews(next: RemoteTrackView[]): void {
    remoteTracksRef.current = next;
    setRemoteTracks(next);
  }

  function setOutgoing(next: OutgoingTransfer | null): void {
    outgoingTransferRef.current = next;
    setOutgoingTransfer(next);
  }

  function setIncoming(next: IncomingTransfer | null): void {
    incomingTransferRef.current = next;
    setIncomingTransfer(next);
  }

  /** Stop Milestone 4 activity (location watch, transfers, interaction). */
  function stopMilestone4(): void {
    if (locationWatchRef.current !== null) {
      navigator.geolocation.clearWatch(locationWatchRef.current);
      locationWatchRef.current = null;
    }
    lastLocationSentRef.current = null;
    setSharingLocation(false);
    setPeerSharingLocation(false);
    peerSharingLocationRef.current = false;
    setPeerLocation(null);
    setAllowInteraction(false);
    allowInteractionRef.current = false;
    setPeerAllowsInteraction(false);
    peerAllowsInteractionRef.current = false;
    setRemoteCursor(null);
    setInteractionKeys([]);
    outgoingFileRef.current = null;
    incomingChunksRef.current.clear();
    const incoming = incomingTransferRef.current;
    if (incoming?.downloadUrl) URL.revokeObjectURL(incoming.downloadUrl);
    setOutgoing(null);
    setIncoming(null);
    setFileChannelOpen(false);
  }

  function stopLocalTracks(): void {
    for (const stream of localStreamsRef.current.values()) {
      for (const track of stream.getTracks()) track.stop();
    }
    localStreamsRef.current.clear();
    sendersRef.current.clear();
    trackKindByIdRef.current.clear();
    setLocalScreenOn(false);
    setLocalCameraOn(false);
    setLocalMicOn(false);
    setMicMuted(false);
    setCameraOff(false);
    micMutedRef.current = false;
    cameraOffRef.current = false;
    setLocalPreview(null);
  }

  function teardownSession(): void {
    negotiationGateRef.current.reset();
    pollerRef.current?.stop();
    pollerRef.current = null;
    if (heartbeatRef.current !== null) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    stopRecordingForTeardown();
    if (fileChannelRef.current) {
      try {
        fileChannelRef.current.close();
      } catch {
        // Already closed — teardown continues regardless.
      }
      fileChannelRef.current = null;
    }
    stopMilestone4();
    if (dcRef.current) {
      try {
        dcRef.current.close();
      } catch {
        // Already closed — teardown continues regardless.
      }
      dcRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        // Already closed — teardown continues regardless.
      }
      pcRef.current = null;
    }
    pendingIceRef.current = [];
    stopLocalTracks();
    setRemoteTrackViews([]);
    setControlOpen(false);
  }

  function teardownPeerOnly(): void {
    negotiationGateRef.current.reset();
    stopRecordingForTeardown();
    if (fileChannelRef.current) {
      try {
        fileChannelRef.current.close();
      } catch {
        // Already closed.
      }
      fileChannelRef.current = null;
    }
    stopMilestone4();
    if (dcRef.current) {
      try {
        dcRef.current.close();
      } catch {
        // Already closed.
      }
      dcRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        // Already closed.
      }
      pcRef.current = null;
    }
    pendingIceRef.current = [];
    setControlOpen(false);
    setRemoteTrackViews([]);
  }

  function revoke(): void {
    teardownSession();
    applyPhase("revoked");
    setDetail("Your access to this device was revoked or expired. All streams were stopped immediately.");
  }

  function endByServer(state: SignalingState): void {
    teardownSession();
    if (state === "revoked") {
      applyPhase("revoked");
      setDetail("Your access to this device was revoked. All streams were stopped immediately.");
    } else {
      applyPhase("session-ended");
      setDetail("The session was ended.");
    }
  }

  /* ---------------- control channel ---------------- */

  function sendControl(message: ControlMessage): void {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    try {
      dc.send(JSON.stringify(message));
    } catch {
      // Channel closed mid-send — the session loop will surface it.
    }
  }

  function sendMuteState(): void {
    sendControl({ type: "mute-state", micMuted: micMutedRef.current, cameraOff: cameraOffRef.current });
  }

  function handleControlMessage(message: ControlMessage): void {
    switch (message.type) {
      case "mute-state":
        setRemoteMicMuted(message.micMuted);
        setRemoteCameraOff(message.cameraOff);
        break;
      case "track-started": {
        // The peer started publishing: label the already-received
        // track in the right slot (screen vs camera).
        setRemoteTrackViews(
          remoteTracksRef.current.map((t) =>
            t.id === message.trackId ? { ...t, slot: message.track } : t,
          ),
        );
        trackKindByIdRef.current.set(message.trackId, message.track);
        // The peer (owner) cannot create an offer — the initiator
        // (participant) must renegotiate to pick the new track up.
        if (!isOwner) void renegotiate();
        break;
      }
      case "track-stopped": {
        setRemoteTrackViews(
          remoteTracksRef.current.filter(
            (t) => (message.trackId ? t.id !== message.trackId : t.slot !== message.track),
          ),
        );
        if (!isOwner) void renegotiate();
        break;
      }
      case "kill-switch":
        teardownSession();
        applyPhase("session-ended");
        setDetail("The session was ended by the device owner.");
        break;
      /* ---------------- Milestone 4 ---------------- */
      case "file-offer":
        // The sender already validated size server-side; parseControl
        // Message re-checked the 50 MB limit here too. A second offer
        // while one is pending is ignored — one transfer at a time.
        if (incomingTransferRef.current) break;
        incomingChunksRef.current.clear();
        setIncoming({
          transferId: message.transferId,
          fileName: message.fileName,
          fileSizeBytes: message.fileSizeBytes,
          status: "offered",
          receivedBytes: 0,
          downloadUrl: null,
        });
        break;
      case "file-approve": {
        const outgoing = outgoingTransferRef.current;
        if (!outgoing || outgoing.transferId !== message.transferId) break;
        if (outgoing.status !== "offered") break;
        setOutgoing({ ...outgoing, status: "approved" });
        void sendFileChunks();
        break;
      }
      case "file-reject": {
        const outgoing = outgoingTransferRef.current;
        if (!outgoing || outgoing.transferId !== message.transferId) break;
        outgoingFileRef.current = null;
        setOutgoing({ ...outgoing, status: "rejected" });
        break;
      }
      case "file-cancel": {
        const outgoing = outgoingTransferRef.current;
        if (outgoing && outgoing.transferId === message.transferId) {
          outgoingFileRef.current = null;
          setOutgoing({ ...outgoing, status: "failed" });
          setFileError("The other side cancelled the transfer.");
        }
        const incoming = incomingTransferRef.current;
        if (incoming && incoming.transferId === message.transferId) {
          incomingChunksRef.current.clear();
          setIncoming({ ...incoming, status: "failed" });
          setFileError("The other side cancelled the transfer.");
        }
        break;
      }
      case "file-complete": {
        const outgoing = outgoingTransferRef.current;
        if (outgoing && outgoing.transferId === message.transferId) {
          setOutgoing({ ...outgoing, status: "completed", sentBytes: outgoing.fileSizeBytes });
        }
        break;
      }
      case "location-start":
        setPeerSharingLocation(true);
        peerSharingLocationRef.current = true;
        break;
      case "location-stop":
        setPeerSharingLocation(false);
        peerSharingLocationRef.current = false;
        setPeerLocation(null);
        break;
      case "location-update":
        // Only accept fixes while the peer says it is sharing — a
        // stray update outside a sharing session is dropped.
        if (!peerSharingLocationRef.current) break;
        setPeerLocation({
          latitude: message.latitude,
          longitude: message.longitude,
          accuracy: message.accuracy,
          timestamp: message.timestamp,
        });
        break;
      case "interaction-start":
        setPeerAllowsInteraction(true);
        peerAllowsInteractionRef.current = true;
        break;
      case "interaction-stop":
        setPeerAllowsInteraction(false);
        peerAllowsInteractionRef.current = false;
        setRemoteCursor(null);
        break;
      case "interaction-pointer":
        // Rendered as a remote-cursor overlay on my shared view —
        // visible, in-page only, never injected as input.
        setRemoteCursor({ x: message.x, y: message.y, kind: message.kind, at: nowMs() });
        break;
      case "interaction-key":
        setInteractionKeys((keys) => [...keys.slice(-19), message.key]);
        break;
      case "notification-sharing-start":
        setPeerSharingNotifications(true);
        peerSharingNotificationsRef.current = true;
        void postSessionEvent("notifications.sharing_started", { peer: true });
        break;
      case "notification-sharing-stop":
        setPeerSharingNotifications(false);
        peerSharingNotificationsRef.current = false;
        void postSessionEvent("notifications.sharing_stopped", { peer: true });
        break;
      case "notification":
        // Only accept notifications while the peer says it is sharing
        // them — anything else is dropped, never rendered.
        if (!peerSharingNotificationsRef.current) break;
        setNotificationFeed((feed) =>
          appendNotificationFeed(feed, {
            app: message.app,
            title: message.title,
            body: message.body,
            receivedAt: message.receivedAt,
          }),
        );
        break;
      /* ---------------- Session recording (v1) ---------------- */
      case "recording-started":
        // The peer started recording: show the indicator. (My own
        // recording-started is never echoed back — the peer sends
        // theirs only when THEY record.)
        setPeerRecording(true);
        break;
      case "recording-stopped":
        setPeerRecording(false);
        break;
    }
  }

  function setupDataChannel(dc: RTCDataChannel): void {
    dcRef.current = dc;
    dc.onopen = () => {
      setControlOpen(true);
      sendMuteState();
    };
    dc.onclose = () => setControlOpen(false);
    dc.onmessage = (event) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return;
      }
      const message = parseControlMessage(parsed);
      if (message) handleControlMessage(message);
    };
  }

  /* ---------------- Milestone 4: audit + file transfer ---------------- */

  /** Best-effort audit write for M4 start/stop events. A failed audit
   *  write never breaks the feature it records — the feature already
   *  happened; the Security Center simply misses one row. */
  async function postSessionEvent(
    action: LiveSessionAuditAction,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, details }),
      });
    } catch {
      // Audit is best-effort (same rule as lib/audit.ts).
    }
  }

  /** Best-effort server status update for a transfer row. The
   *  peer-to-peer transfer itself does not depend on it. */
  async function updateTransferStatus(
    transferId: string,
    status: FileTransferStatus,
  ): Promise<void> {
    try {
      await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/file-transfers/${encodeURIComponent(transferId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
    } catch {
      // Metadata is best-effort; the transfer state machine is local.
    }
  }

  function setupFileChannel(dc: RTCDataChannel): void {
    fileChannelRef.current = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = FILE_BUFFERED_AMOUNT_LOW_WATERMARK;
    dc.onopen = () => setFileChannelOpen(true);
    dc.onclose = () => setFileChannelOpen(false);
    dc.onmessage = (event) => {
      if (typeof event.data === "string") return; // File channel is binary only.
      handleFileChunk(event.data as ArrayBuffer);
    };
  }

  /** Assemble one received binary chunk into the incoming transfer. */
  function handleFileChunk(buffer: ArrayBuffer): void {
    const incoming = incomingTransferRef.current;
    if (!incoming || (incoming.status !== "approved" && incoming.status !== "in_progress")) {
      return;
    }
    const chunk = decodeFileChunk(buffer);
    if (!chunk) return;
    const total = chunkCountFor(incoming.fileSizeBytes);
    if (chunk.index >= total) return;
    if (incomingChunksRef.current.has(chunk.index)) return; // Duplicate — ignore.
    // Copy into a fresh ArrayBuffer-backed array: the decoded view
    // shares the message buffer (header included), and Blob needs
    // exactly the payload bytes.
    incomingChunksRef.current.set(chunk.index, new Uint8Array(chunk.data));
    const receivedBytes = [...incomingChunksRef.current.values()].reduce(
      (sum, part) => sum + part.length,
      0,
    );
    const status: LocalTransferStatus =
      receivedBytes >= incoming.fileSizeBytes ? "completed" : "in_progress";
    if (status === "completed") {
      // Every byte is here — but only trust it when every chunk
      // index is present, not just when the byte count matches.
      if (incomingChunksRef.current.size !== total) return;
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (let i = 0; i < total; i++) {
        const part = incomingChunksRef.current.get(i);
        if (!part) return;
        parts.push(part);
      }
      const blob = new Blob(parts as BlobPart[], { type: "application/octet-stream" });
      const downloadUrl = URL.createObjectURL(blob);
      incomingChunksRef.current.clear();
      setIncoming({ ...incoming, status: "completed", receivedBytes, downloadUrl });
      void updateTransferStatus(incoming.transferId, "completed");
      sendControl({ type: "file-complete", transferId: incoming.transferId });
      return;
    }
    setIncoming({ ...incoming, status, receivedBytes });
  }

  /** Send the outgoing file in 16 KiB chunks with backpressure. Runs
   *  only after the receiver approved (file-approve). */
  async function sendFileChunks(): Promise<void> {
    const dc = fileChannelRef.current;
    const outgoing = outgoingTransferRef.current;
    const file = outgoingFileRef.current;
    if (!dc || dc.readyState !== "open" || !outgoing || !file) return;
    if (outgoing.status !== "approved") return;
    setOutgoing({ ...outgoing, status: "in_progress", sentBytes: 0 });
    void updateTransferStatus(outgoing.transferId, "in_progress");
    const total = chunkCountFor(file.size);
    let sentBytes = 0;
    try {
      for (let index = 0; index < total; index++) {
        // Backpressure: pause while the channel buffer is full.
        while (dc.bufferedAmount > FILE_BUFFERED_AMOUNT_HIGH_WATERMARK) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (outgoingTransferRef.current?.transferId !== outgoing.transferId) return;
          if (outgoingTransferRef.current?.status === "failed") return;
        }
        const start = index * FILE_CHUNK_SIZE_BYTES;
        const end = Math.min(start + FILE_CHUNK_SIZE_BYTES, file.size);
        const slice = file.slice(start, end);
        const bytes = new Uint8Array(await slice.arrayBuffer());
        dc.send(encodeFileChunk(index, bytes));
        sentBytes += bytes.length;
        const current = outgoingTransferRef.current;
        if (current && current.transferId === outgoing.transferId) {
          setOutgoing({ ...current, sentBytes });
        }
      }
      // All chunks sent. The receiver confirms with file-complete;
      // until then the sender shows the sent state, not "completed".
      const current = outgoingTransferRef.current;
      if (current && current.transferId === outgoing.transferId) {
        setOutgoing({ ...current, sentBytes });
      }
      void updateTransferStatus(outgoing.transferId, "completed");
    } catch {
      const current = outgoingTransferRef.current;
      if (current && current.transferId === outgoing.transferId) {
        setOutgoing({ ...current, status: "failed" });
      }
      setFileError("Sending the file failed. The transfer was stopped.");
      void updateTransferStatus(outgoing.transferId, "failed");
    }
  }

  /** Pick a file -> validate -> record metadata server-side -> offer. */
  async function offerFile(file: File): Promise<void> {
    setFileError(null);
    if (!canTransferFiles(grantedScopes, isOwner)) return;
    if (outgoingTransferRef.current && outgoingTransferRef.current.status === "in_progress") {
      setFileError("A transfer is already in progress. Wait for it to finish first.");
      return;
    }
    const name = validateFileName(file.name);
    if (!name.ok) {
      setFileError(`Cannot send this file: ${name.error}`);
      return;
    }
    const size = validateFileSize(file.size);
    if (!size.ok) {
      setFileError(`Cannot send this file: ${size.error}`);
      return;
    }
    let transferId: string | null = null;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file-transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: name.name, fileSizeBytes: size.size }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setFileError(
          typeof data.error === "string" ? data.error : "Could not record the file transfer.",
        );
        return;
      }
      const transfer = data.transfer as { id?: unknown } | undefined;
      if (!transfer || typeof transfer.id !== "string") {
        setFileError("Could not record the file transfer.");
        return;
      }
      transferId = transfer.id;
    } catch {
      setFileError("Could not record the file transfer. Check your connection and try again.");
      return;
    }
    outgoingFileRef.current = file;
    setOutgoing({
      transferId,
      fileName: name.name,
      fileSizeBytes: size.size,
      status: "offered",
      sentBytes: 0,
    });
    sendControl({ type: "file-offer", transferId, fileName: name.name, fileSizeBytes: size.size });
  }

  function approveIncomingTransfer(): void {
    const incoming = incomingTransferRef.current;
    if (!incoming || incoming.status !== "offered") return;
    incomingChunksRef.current.clear();
    setIncoming({ ...incoming, status: "approved", receivedBytes: 0 });
    sendControl({ type: "file-approve", transferId: incoming.transferId });
    void updateTransferStatus(incoming.transferId, "approved");
  }

  function rejectIncomingTransfer(): void {
    const incoming = incomingTransferRef.current;
    if (!incoming || incoming.status !== "offered") return;
    setIncoming({ ...incoming, status: "rejected" });
    sendControl({ type: "file-reject", transferId: incoming.transferId });
    void updateTransferStatus(incoming.transferId, "rejected");
  }

  function cancelOutgoingTransfer(): void {
    const outgoing = outgoingTransferRef.current;
    if (!outgoing) return;
    outgoingFileRef.current = null;
    setOutgoing({ ...outgoing, status: "failed" });
    sendControl({ type: "file-cancel", transferId: outgoing.transferId });
    void updateTransferStatus(outgoing.transferId, "failed");
  }

  function cancelIncomingTransfer(): void {
    const incoming = incomingTransferRef.current;
    if (!incoming) return;
    incomingChunksRef.current.clear();
    setIncoming({ ...incoming, status: "failed" });
    sendControl({ type: "file-cancel", transferId: incoming.transferId });
    void updateTransferStatus(incoming.transferId, "failed");
  }

  /* ---------------- Milestone 4: location ---------------- */

  async function startLocationSharing(): Promise<void> {
    if (!canShareLocation(grantedScopes, isOwner)) return;
    if (locationWatchRef.current !== null) return;
    setLocationError(null);
    if (!("geolocation" in navigator)) {
      setLocationError("Geolocation is not available in this browser.");
      return;
    }
    lastLocationSentRef.current = null;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const now = Date.now();
        const first = lastLocationSentRef.current === null;
        if (!first && !shouldSendLocationUpdate(now, lastLocationSentRef.current)) return;
        lastLocationSentRef.current = now;
        if (first) {
          // First fix: announce sharing (visible indicator on the peer)
          // and audit it, then send the fix itself.
          sendControl({ type: "location-start" });
          setSharingLocation(true);
          void postSessionEvent("location.sharing_started", {});
        }
        sendControl({
          type: "location-update",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        });
      },
      (error) => {
        // Permission denied (or unavailable/timeout): NOT an error
        // state — simply not sharing, no indicator, honest message.
        if (error.code === error.PERMISSION_DENIED) {
          setLocationError("Location permission was denied — nothing is being shared.");
        } else {
          setLocationError("Could not read your location — nothing is being shared.");
        }
        stopLocationSharing();
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
    locationWatchRef.current = watchId;
  }

  function stopLocationSharing(): void {
    if (locationWatchRef.current !== null) {
      navigator.geolocation.clearWatch(locationWatchRef.current);
      locationWatchRef.current = null;
    }
    lastLocationSentRef.current = null;
    if (sharingLocation) {
      sendControl({ type: "location-stop" });
      void postSessionEvent("location.sharing_stopped", {});
    }
    setSharingLocation(false);
  }

  /* ---------------- Milestone 4: remote interaction ---------------- */

  /** I allow the peer to interact with MY shared view. Explicit
   *  opt-in, instantly revocable. */
  function toggleAllowInteraction(): void {
    const next = !allowInteractionRef.current;
    allowInteractionRef.current = next;
    setAllowInteraction(next);
    if (next) {
      sendControl({ type: "interaction-start" });
      void postSessionEvent("interaction.started", {});
    } else {
      sendControl({ type: "interaction-stop" });
      void postSessionEvent("interaction.stopped", {});
    }
  }

  /** Owner kill-switch for interaction: one tap ends it immediately.
   *  (The session itself keeps running — only interaction stops.) */
  function killInteraction(): void {
    allowInteractionRef.current = false;
    setAllowInteraction(false);
    setRemoteCursor(null);
    sendControl({ type: "interaction-stop" });
    void postSessionEvent("interaction.killed", {});
  }

  /** Pointer over the remote screen: forward only while the peer
   *  allows interaction, normalised to the shared view. */
  function forwardPointer(kind: "move" | "click", event: React.PointerEvent<HTMLDivElement>): void {
    if (!peerAllowsInteractionRef.current) return;
    const box = remoteScreenBoxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    sendControl({ type: "interaction-pointer", kind, x, y });
  }

  function forwardKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!peerAllowsInteractionRef.current) return;
    // Single keys and short named keys only; never the whole input.
    if (event.key.length > 32) return;
    sendControl({ type: "interaction-key", key: event.key });
  }

  /* ---------------- Session recording (v1) ---------------- */

  /** Keep the recording-state ref and state in sync. */
  function setRecording(next: RecordingState): void {
    recordingStateRef.current = next;
    setRecordingState(next);
  }

  function applyRecordingEvent(event: RecordingEvent): void {
    setRecording(transitionRecordingState(recordingStateRef.current, event));
  }

  /**
   * MediaRecorder's onstop handler: assemble the chunks, save the
   * .webm to this browser's IndexedDB, and audit the stop. Runs on
   * every stop (user, owner revoke, 1-hour cap, session teardown) —
   * the audit is posted here exactly once per recording, and a save
   * failure is reported honestly instead of pretending the file
   * exists.
   */
  async function finishRecording(): Promise<void> {
    const startedAt = recordingStartedAtRef.current;
    const chunks = recordingChunksRef.current;
    const mimeType = recordingMimeRef.current;
    const videoKind = recordingVideoKindRef.current;
    const hasAudio = recordingHasAudioRef.current;
    recordingChunksRef.current = [];
    recordingStartedAtRef.current = null;
    mediaRecorderRef.current = null;
    recordingStreamRef.current = null;
    const endedAt = nowMs();
    const durationMs = startedAt === null ? 0 : Math.max(0, endedAt - startedAt);
    let saved = false;
    let sizeBytes = 0;
    if (startedAt !== null && chunks.length > 0) {
      const blob = assembleRecordingBlob(chunks, mimeType);
      sizeBytes = blob.size;
      const meta = buildRecordingMeta({
        id: crypto.randomUUID(),
        sessionId,
        deviceName,
        startedAt,
        endedAt,
        sizeBytes: blob.size,
        mimeType: blob.type,
        videoKind,
        hasAudio,
      });
      try {
        await saveRecording({ ...meta, chunks });
        saved = true;
        setRecordingSavedAt(endedAt);
      } catch {
        setRecordingError(
          "Recording stopped, but saving it to this browser failed (storage may be full). The recording is lost.",
        );
      }
    }
    void postSessionEvent("recording.stopped", {
      durationMs,
      sizeBytes,
      saved,
    });
  }

  /**
   * Build the recording stream and start MediaRecorder. Returns true
   * only when recording actually started — the caller applies the
   * transition (idle --start--> recording). On failure nothing is
   * recorded and the caller keeps its state.
   */
  async function startRecording(): Promise<boolean> {
    setRecordingError(null);
    if (typeof MediaRecorder === "undefined") {
      setRecordingError("Recording is not supported in this browser.");
      return false;
    }
    const screen = remoteTracksRef.current.find((t) => t.slot === "screen" && t.kind === "video");
    const camera = remoteTracksRef.current.find((t) => t.slot === "camera" && t.kind === "video");
    const audio = remoteTracksRef.current.find((t) => t.slot === "microphone");
    const screenTrack = screen?.stream.getVideoTracks()[0] ?? null;
    const cameraTrack = camera?.stream.getVideoTracks()[0] ?? null;
    const audioTrack = audio?.stream.getAudioTracks()[0] ?? null;
    const pick = pickRecordingTracks({ screen: screenTrack, camera: cameraTrack, audio: audioTrack });
    if (!hasRecordableTrack(pick)) {
      setRecordingError(
        "Nothing to record yet — the other side is not sharing screen, camera or microphone.",
      );
      return false;
    }
    const tracks: MediaStreamTrack[] = [];
    if (pick.video) tracks.push(pick.video as MediaStreamTrack);
    if (pick.audio) tracks.push(pick.audio as MediaStreamTrack);
    const stream = new MediaStream(tracks);
    recordingStreamRef.current = stream;
    const mimeType = pickRecordingMimeType((m) => {
      try {
        return MediaRecorder.isTypeSupported(m);
      } catch {
        return false;
      }
    });
    recordingMimeRef.current = mimeType;
    recordingVideoKindRef.current = pick.video
      ? pick.video === screenTrack
        ? "screen"
        : "camera"
      : "none";
    recordingHasAudioRef.current = pick.audio !== null;
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      setRecordingError("Could not start recording in this browser.");
      return false;
    }
    recordingChunksRef.current = [];
    recordingStartedAtRef.current = nowMs();
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordingChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      void finishRecording();
    };
    try {
      recorder.start(RECORDING_CHUNK_TIMESLICE_MS);
    } catch {
      setRecordingError("Could not start recording in this browser.");
      mediaRecorderRef.current = null;
      recordingStartedAtRef.current = null;
      return false;
    }
    setRecordingElapsedMs(0);
    setRecordingSavedAt(null);
    sendControl({ type: "recording-started" });
    void postSessionEvent("recording.started", {
      videoKind: recordingVideoKindRef.current,
      hasAudio: recordingHasAudioRef.current,
    });
    return true;
  }

  /** Stop an active recording. The save + audit happen in onstop
   *  (finishRecording) — this only stops the recorder and tells the
   *  peer, so every stop path funnels through one place. */
  function stopRecording(reason: "user" | "limit" | "teardown"): void {
    if (recordingStateRef.current !== "recording") return;
    setRecording("stopped");
    if (reason !== "teardown") sendControl({ type: "recording-stopped" });
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already stopped — onstop still fires and saves.
      }
    }
    if (reason === "limit") {
      setRecordingError(
        `Recording stopped automatically after ${Math.round(MAX_RECORDING_DURATION_MS / 3600000)} hour (the v1 limit).`,
      );
    }
  }

  /** Session teardown (revoke / end / unmount): stop the recorder
   *  without notifying the peer — the channel is closing — but the
   *  onstop save still runs, so a recording is not lost because the
   *  session ended. */
  function stopRecordingForTeardown(): void {
    if (recordingStateRef.current === "recording") {
      stopRecording("teardown");
    }
    setPeerRecording(false);
  }

  /**
   * Start recording right away. No per-session approval is asked:
   * recording is covered by the permissions the owner granted once
   * at pairing (any live screen / camera / microphone grant —
   * canRecord). If starting fails (no live tracks / browser cannot
   * record), stay idle with an honest error instead of pretending
   * to record.
   */
  async function startRecordingNow(): Promise<void> {
    setRecordingError(null);
    if (!controlOpen || !joined) return;
    if (!canRecord(grantedScopes, isOwner)) {
      setRecordingError(
        "Recording needs a screen, camera or microphone permission granted at pairing.",
      );
      return;
    }
    if (recordingStateRef.current !== "idle" && recordingStateRef.current !== "stopped") return;
    if (await startRecording()) applyRecordingEvent("start");
  }

  async function flushPendingIce(): Promise<void> {
    const pc = pcRef.current;
    if (!pc) return;
    const pending = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // A stale candidate is not fatal — ICE keeps gathering.
      }
    }
  }

  /**
   * One offer attempt, run exclusively through the negotiation gate.
   * The pc is captured up front and re-checked after every await:
   * if a retry/teardown replaced the peer connection mid-flight, the
   * attempt aborts instead of negotiating on a dead connection.
   */
  async function attemptOffer(): Promise<NegotiationOutcome> {
    const pc = pcRef.current;
    const client = clientRef.current;
    if (!pc || !client) return "failed";
    if (pc.signalingState !== "stable") return "not-stable";
    try {
      const offer = await pc.createOffer();
      if (pcRef.current !== pc) return "failed";
      await pc.setLocalDescription(offer);
      if (pcRef.current !== pc) return "failed";
      await client.send("offer", { type: offer.type, sdp: offer.sdp });
      applyPhase("offer-sent");
      return "negotiated";
    } catch (err) {
      if (pcRef.current !== pc) return "failed";
      setDetail(`Could not create an offer: ${err instanceof Error ? err.message : "unknown error"}`);
      applyPhase("error");
      return "failed";
    }
  }

  async function createAndSendOffer(): Promise<void> {
    await negotiationGateRef.current.request(attemptOffer);
  }

  async function renegotiate(): Promise<void> {
    // No signaling-state check here on purpose: the gate remembers
    // the request when the connection is mid-handshake and retries
    // it once an answer lands (see the "answer" handler's drain).
    // Checking here would silently drop the renegotiation.
    await createAndSendOffer();
  }

  function attachRemoteTrack(track: MediaStreamTrack): void {
    if (remoteTracksRef.current.some((t) => t.id === track.id)) return;
    const knownKind = trackKindByIdRef.current.get(track.id);
    const slot: RemoteTrackView["slot"] =
      knownKind ?? (track.kind === "video" ? "camera" : "microphone");
    const stream = new MediaStream([track]);
    const view: RemoteTrackView = {
      id: track.id,
      slot,
      kind: track.kind === "video" ? "video" : "audio",
      stream,
    };
    track.onended = () => {
      setRemoteTrackViews(remoteTracksRef.current.filter((t) => t.id !== track.id));
    };
    setRemoteTrackViews([...remoteTracksRef.current, view]);
  }

  async function handleSignalMessage(message: SignalingMessage): Promise<void> {
    const pc = pcRef.current;
    const client = clientRef.current;
    if (!pc || !client) return;
    try {
      switch (message.kind) {
        case "offer": {
          if (!isSdpPayload(message.payload)) return;
          await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
          await flushPendingIce();
          applyPhase("offer-received");
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await client.send("answer", { type: answer.type, sdp: answer.sdp });
          break;
        }
        case "answer": {
          if (!isSdpPayload(message.payload)) return;
          if (pc.signalingState !== "stable") {
            await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
            await flushPendingIce();
          }
          // The connection is stable again: if a renegotiation was
          // requested while our offer was in flight, run it now.
          // Without this, a track added mid-handshake would never be
          // negotiated (the request was remembered, not dropped).
          negotiationGateRef.current.drain(attemptOffer);
          break;
        }
        case "ice-candidate": {
          const candidate = (message.payload as Record<string, unknown>).candidate;
          if (candidate && typeof candidate === "object") {
            if (pc.remoteDescription) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate as RTCIceCandidateInit));
              } catch {
                // Stale candidate — ICE keeps gathering.
              }
            } else {
              pendingIceRef.current.push(candidate as RTCIceCandidateInit);
            }
          }
          break;
        }
        case "bye":
          teardownSession();
          applyPhase("bye");
          setDetail("The other side left the session.");
          break;
        case "session-state": {
          // Fallback renegotiation trigger for when the data channel
          // is not open yet (e.g. the owner added a track before the
          // channel opened). The initiator creates the new offer.
          if (
            (message.payload as Record<string, unknown>).renegotiate === true &&
            !isOwner
          ) {
            await renegotiate();
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      setDetail(`Signaling failed: ${err instanceof Error ? err.message : "unknown error"}`);
      applyPhase("error");
    }
  }

  function createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIGURATION);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void clientRef.current
          ?.send("ice-candidate", { candidate: event.candidate.toJSON() })
          .catch(() => {
            // A dropped candidate is not fatal — ICE keeps gathering,
            // and a 403 here is surfaced by the poll loop instead.
          });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        wasLiveRef.current = true;
        applyPhase("connected");
        void clientRef.current?.setState("live").catch(() => {
          // State is advisory; the poll loop reports the truth.
        });
      } else if (pc.connectionState === "failed") {
        applyPhase("ice-failed");
        setDetail(
          "The peer-to-peer connection failed (direct connection could not be established — there is no TURN server yet, so strict NATs/firewalls can block it). Check your network and retry.",
        );
      } else if (pc.connectionState === "disconnected") {
        applyPhase("connection-lost");
      } else if (pc.connectionState === "closed") {
        // Teardown already handled by the caller.
      }
    };
    pc.ontrack = (event) => {
      attachRemoteTrack(event.track);
    };
    pc.onnegotiationneeded = () => {
      // Only the initiator (participant) creates offers. The owner
      // signals track changes over the control channel / session-state
      // instead, and the participant renegotiates from there.
      if (!isOwner) void renegotiate();
    };
    if (!isOwner) {
      // The offerer creates the control channel; the answerer
      // receives it via ondatachannel. Same for the file channel:
      // the offerer creates "nexvora-file" for binary chunks so a
      // stalled transfer can never block control messages.
      setupDataChannel(pc.createDataChannel(CONTROL_CHANNEL_NAME));
      setupFileChannel(pc.createDataChannel(FILE_CHANNEL_NAME));
    } else {
      pc.ondatachannel = (event) => {
        if (event.channel.label === CONTROL_CHANNEL_NAME) setupDataChannel(event.channel);
        else if (event.channel.label === FILE_CHANNEL_NAME) setupFileChannel(event.channel);
      };
    }
    return pc;
  }

  /* ---------------- session lifecycle ---------------- */

  function startHeartbeat(): void {
    if (heartbeatRef.current !== null) return;
    heartbeatRef.current = setInterval(() => {
      void clientRef.current?.heartbeat().catch((err: unknown) => {
        if (err instanceof SignalingApiError && err.status === 403) revoke();
        // Any other heartbeat failure is transient — the poll loop
        // (with backoff) is the authority on session state.
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function startPoller(): void {
    const client = clientRef.current;
    if (!client || pollerRef.current?.running) return;
    const poller = createSignalPoller(client, {
      onMessages: (messages) => {
        void (async () => {
          for (const message of messages) await handleSignalMessage(message);
        })();
      },
      onMeta: (result) => {
        setPeerAlive(result.peer_alive);
        setSignalingState(result.signaling_state);
        if (!result.grantsValid) {
          revoke();
          return;
        }
        // Peer gone: only meaningful once the call was actually live
        // — before that, peer_alive=false just means "not joined yet".
        if (!result.peer_alive && wasLiveRef.current) {
          teardownSession();
          applyPhase("peer-gone");
          setDetail("The other side stopped responding (no heartbeat for over 30 seconds).");
        }
      },
      onRevoked: () => revoke(),
      onSessionEnded: (state) => endByServer(state),
      onError: () => {
        // Transient poll failure — the poller already backs off.
      },
    });
    pollerRef.current = poller;
    poller.start();
  }

  function handleStartError(err: unknown): void {
    if (err instanceof SignalingApiError && err.status === 403) {
      applyPhase("revoked");
      setDetail("Your access to this device was revoked or expired.");
      return;
    }
    setDetail(
      `Could not start the session: ${err instanceof Error ? err.message : "unknown error"}`,
    );
    applyPhase("error");
  }

  async function boot(): Promise<void> {
    // "starting" is the phase retry() leaves us in; idle is the
    // first join; failed / peer-disconnected are the other retries.
    if (
      phaseRef.current !== "idle" &&
      phaseRef.current !== "starting" &&
      phaseRef.current !== "failed" &&
      phaseRef.current !== "peer-disconnected"
    ) {
      return;
    }
    setDetail(null);
    wasLiveRef.current = false;
    negotiationGateRef.current.reset();
    const client = createSignalingClient(sessionId);
    clientRef.current = client;
    applyPhase("begin");
    try {
      await client.start();
    } catch (err) {
      handleStartError(err);
      return;
    }
    applyPhase("started");
    const pc = createPeerConnection();
    pcRef.current = pc;
    // Re-attach any local tracks kept across a retry (their streams
    // are still live — only the peer connection was replaced).
    for (const [kind, stream] of localStreamsRef.current) {
      const track = stream.getTracks()[0];
      if (track && track.readyState === "live") {
        try {
          sendersRef.current.set(kind, pc.addTrack(track, stream));
        } catch {
          // A track that cannot be re-added stays stopped; the user
          // can start it again from the controls.
        }
      }
    }
    startHeartbeat();
    startPoller();
    if (!isOwner) await createAndSendOffer();
  }

  async function endSession(): Promise<void> {
    const client = clientRef.current;
    if (client) {
      // Tell the peer first, then end server-side — the peer sees
      // `bye` before the session disappears from polling.
      await client.send("bye", {}).catch(() => {});
      await client.disconnect().catch(() => {});
    }
    teardownSession();
    applyPhase("end");
    setDetail("Session ended.");
  }

  async function retry(): Promise<void> {
    teardownPeerOnly();
    applyPhase("retry");
    await boot();
  }

  // Unmount: stop everything. No `bye` is sent here — closing the
  // page is not an explicit End, and the peer learns about it from
  // the stale heartbeat (peer-disconnected) instead.
  useEffect(() => {
    return () => {
      teardownSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- local media ---------------- */

  function addLocalTrack(kind: MediaTrackKind, stream: MediaStream): boolean {
    const track = stream.getTracks()[0];
    if (!track) return false;
    localStreamsRef.current.set(kind, stream);
    trackKindByIdRef.current.set(track.id, kind);
    const pc = pcRef.current;
    if (pc) {
      try {
        sendersRef.current.set(kind, pc.addTrack(track, stream));
      } catch {
        return false;
      }
    }
    if (kind === "screen") {
      setLocalScreenOn(true);
    } else if (kind === "camera") {
      setLocalCameraOn(true);
    } else {
      setLocalMicOn(true);
    }
    // Local preview always shows the screen if one is active, else
    // the camera — one rule, computed from the live track map.
    setLocalPreview(
      localStreamsRef.current.get("screen") ?? localStreamsRef.current.get("camera") ?? null,
    );
    // Tell the peer a track started. If the data channel is not open
    // yet, the initiator still needs to renegotiate — fall back to a
    // signaling session-state message for the owner side.
    sendControl({ type: "track-started", track: kind, trackId: track.id });
    if (dcRef.current?.readyState !== "open") {
      if (!isOwner) void renegotiate();
      else {
        void clientRef.current
          ?.send("session-state", { renegotiate: true })
          .catch(() => {});
      }
    }
    return true;
  }

  function removeLocalTrack(kind: MediaTrackKind): void {
    const sender = sendersRef.current.get(kind);
    if (sender && pcRef.current) {
      try {
        pcRef.current.removeTrack(sender);
      } catch {
        // Sender already removed.
      }
    }
    sendersRef.current.delete(kind);
    const stream = localStreamsRef.current.get(kind);
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    localStreamsRef.current.delete(kind);
    trackKindByIdRef.current.forEach((value, key) => {
      if (value === kind) trackKindByIdRef.current.delete(key);
    });
    if (kind === "screen") {
      setLocalScreenOn(false);
    } else if (kind === "camera") {
      setLocalCameraOn(false);
    } else {
      setLocalMicOn(false);
      setMicMuted(false);
      micMutedRef.current = false;
    }
    setLocalPreview(
      localStreamsRef.current.get("screen") ?? localStreamsRef.current.get("camera") ?? null,
    );
    sendControl({ type: "track-stopped", track: kind });
    if (dcRef.current?.readyState !== "open") {
      if (!isOwner) void renegotiate();
      else {
        void clientRef.current
          ?.send("session-state", { renegotiate: true })
          .catch(() => {});
      }
    }
  }

  async function startScreen(): Promise<void> {
    if (!canPublishTrack("screen", grantedScopes, isOwner)) return;
    try {
      // Explicit user gesture -> system dialog. The browser/OS shows
      // its own sharing indicator for as long as this is active.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      // The browser's own "Stop sharing" button ends the track —
      // treat it exactly like pressing Stop here.
      track.onended = () => removeLocalTrack("screen");
      if (!addLocalTrack("screen", stream)) {
        for (const t of stream.getTracks()) t.stop();
      }
    } catch (err) {
      // The owner cancelled the system dialog (or the browser denied
      // it): NOT an error state — simply not sharing, no indicator.
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
        return;
      }
      setDetail(
        `Could not start screen sharing: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  async function startCamera(): Promise<void> {
    if (!canPublishTrack("camera", grantedScopes, isOwner)) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      track.onended = () => removeLocalTrack("camera");
      if (!addLocalTrack("camera", stream)) {
        for (const t of stream.getTracks()) t.stop();
      }
    } catch (err) {
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
        return;
      }
      setDetail(
        `Could not start the camera: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  async function startMic(): Promise<void> {
    if (!canPublishTrack("microphone", grantedScopes, isOwner)) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const track = stream.getAudioTracks()[0];
      if (!track) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      track.onended = () => removeLocalTrack("microphone");
      if (!addLocalTrack("microphone", stream)) {
        for (const t of stream.getTracks()) t.stop();
      }
    } catch (err) {
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
        return;
      }
      setDetail(
        `Could not start the microphone: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  function toggleMicMute(): void {
    const stream = localStreamsRef.current.get("microphone");
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    track.enabled = !next;
    setMicMuted(next);
    sendMuteState();
  }

  function toggleCameraOff(): void {
    const stream = localStreamsRef.current.get("camera");
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    const next = !cameraOffRef.current;
    cameraOffRef.current = next;
    track.enabled = !next;
    setCameraOff(next);
    sendMuteState();
  }

  /* ---------------- element wiring ---------------- */

  useEffect(() => {
    const el = localPreviewRef.current;
    if (el) el.srcObject = localPreview;
  }, [localPreview]);

  useEffect(() => {
    const el = remoteScreenVideoRef.current;
    if (el) el.srcObject = remoteScreen?.stream ?? null;
  }, [remoteScreen]);

  useEffect(() => {
    const el = remoteCameraVideoRef.current;
    if (el) el.srcObject = remoteCamera?.stream ?? null;
  }, [remoteCamera]);

  useEffect(() => {
    const el = remoteAudioRef.current;
    if (el) el.srcObject = remoteAudio?.stream ?? null;
  }, [remoteAudio]);

  // Speaker (remote audio output) is controlled separately from the
  // microphone mute: this effect only ever touches the <audio> element.
  useEffect(() => {
    const el = remoteAudioRef.current;
    if (!el) return;
    el.muted = speakerMuted || !audioAllowed;
    el.volume = speakerVolume / 100;
  }, [speakerMuted, speakerVolume, audioAllowed, remoteAudio]);

  // Recording elapsed timer + 1-hour auto-stop. Runs only while
  // recording; the interval is cleared on every other state. The
  // timer reads refs only, so a stale closure cannot stop the wrong
  // recording.
  useEffect(() => {
    if (recordingState !== "recording") {
      if (recordingTimerRef.current !== null) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      return;
    }
    const startedAt = recordingStartedAtRef.current ?? nowMs();
    recordingTimerRef.current = setInterval(() => {
      const elapsed = nowMs() - startedAt;
      setRecordingElapsedMs(elapsed);
      if (shouldAutoStopRecording(elapsed)) stopRecording("limit");
    }, 1000);
    return () => {
      if (recordingTimerRef.current !== null) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingState]);

  /* ---------------- Redesign (Opus Spec v2.0 Ch. 3–4) helpers ---------------- */

  /**
   * Callback refs: the video elements live in the first-look tree OR
   * the full-view tree (never both), so the ref must re-attach the
   * live stream every time the element remounts. The existing
   * useEffects still handle stream changes while mounted.
   */
  const setRemoteScreenVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteScreenVideoRef.current = el;
    if (el) {
      el.srcObject =
        remoteTracksRef.current.find((t) => t.slot === "screen" && t.kind === "video")
          ?.stream ?? null;
    }
  }, []);

  const setRemoteCameraVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteCameraVideoRef.current = el;
    if (el) {
      el.srcObject =
        remoteTracksRef.current.find((t) => t.slot === "camera" && t.kind === "video")
          ?.stream ?? null;
    }
  }, []);

  const setLocalPreviewVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      localPreviewRef.current = el;
      if (el) el.srcObject = localPreview;
    },
    [localPreview],
  );

  const setRemoteScreenBox = useCallback((el: HTMLDivElement | null) => {
    remoteScreenBoxRef.current = el;
  }, []);

  function logActivity(message: string): void {
    setActivityLog((prev) => [...prev.slice(-19), message]);
  }

  function showToast(message: string): void {
    setToast(message);
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }

  /**
   * Deck keys (Back / Home / Recents / Power): forwarded over the
   * existing interaction-key channel, only while the peer allows
   * interaction — the same channel as typed keys.
   */
  function sendDeckKey(key: string): void {
    if (!peerAllowsInteractionRef.current) return;
    sendControl({ type: "interaction-key", key });
    logActivity(`${key} pressed`);
  }

  /** Swipe pad: drag forwards pointer moves (normalised to the pad),
   *  remembering the last position for TAP. */
  function handlePadPointer(event: React.PointerEvent<HTMLDivElement>): void {
    if (!peerAllowsInteractionRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    padPosRef.current = { x, y };
    sendControl({ type: "interaction-pointer", kind: "move", x, y });
  }

  function handlePadTap(event: React.PointerEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    if (!peerAllowsInteractionRef.current) return;
    const { x, y } = padPosRef.current;
    sendControl({ type: "interaction-pointer", kind: "click", x, y });
    logActivity("Tap sent to device");
  }

  function stepVolume(delta: number): void {
    const next = Math.min(100, Math.max(0, speakerVolume + delta));
    setSpeakerVolume(next);
    logActivity(`Volume ${next}%`);
  }

  /**
   * Screenshot the remote screen as currently seen: draw the live
   * video frame to a canvas and download it as a PNG.
   */
  function takeScreenshot(): void {
    const video = remoteScreenVideoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      showToast("No remote screen to capture yet.");
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        showToast("Could not capture the remote screen.");
        return;
      }
      ctx.drawImage(video, 0, 0);
      setFlash(true);
      window.setTimeout(() => setFlash(false), 120);
      canvas.toBlob((blob) => {
        if (!blob) {
          showToast("Could not capture the remote screen.");
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `nexvora-screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        showToast("Screenshot saved");
        logActivity("Screenshot saved");
      }, "image/png");
    } catch {
      showToast("Could not capture the remote screen.");
    }
  }

  /** Type box: forward each character as an interaction key. */
  function sendTypedText(): void {
    if (!peerAllowsInteractionRef.current) return;
    const text = typeText;
    if (text.length === 0) return;
    for (const ch of text) sendControl({ type: "interaction-key", key: ch });
    logActivity(`Typed: ${text.slice(0, 40)}`);
    setTypeText("");
  }

  // Live clock for the first-look status row (30s tick).
  useEffect(() => {
    const timer = setInterval(() => setClockNow(nowMs()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Escape exits full view; the session keeps running.
  useEffect(() => {
    if (!fullView) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullView(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullView]);

  /* ---------------- render ---------------- */

  const phaseTone: Record<LivePhase, "green" | "gold" | "red" | "muted" | "blue"> =
    {
      idle: "muted",
      starting: "gold",
      waiting: "gold",
      connecting: "gold",
      live: "green",
      reconnecting: "gold",
      failed: "red",
      ended: "muted",
      revoked: "red",
      "peer-disconnected": "red",
    };

  const canPublish = (kind: MediaTrackKind) =>
    canPublishTrack(kind, grantedScopes, isOwner);

  /* First-look permission rows (hero order): granted scopes, read-only —
   * grants change only from Trusted Devices, never from this card. */
  const permRows = [
    { label: "Screen", granted: isOwner || grantedScopes.includes("screen") },
    { label: "Camera", granted: isOwner || grantedScopes.includes("camera") },
    { label: "Microphone", granted: isOwner || grantedScopes.includes("microphone") },
    { label: "Location", granted: isOwner || grantedScopes.includes("location") },
  ];
  const permOnCount = permRows.filter((r) => r.granted).length;
  const clockLabel = new Date(clockNow).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const isRecording = recordingState === "recording" || peerRecording;
  const recLabel =
    recordingState === "recording"
      ? `REC ${formatRecordingDuration(recordingElapsedMs)}`
      : "REC — peer";
  const volumeSegments = Math.round((speakerVolume / 100) * 8);
  const logLines = activityLog.slice(-2);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Live session — {deviceName}</h2>
            <p className="mt-1 text-sm text-[#8FA3A0]">
              {isOwner ? "You are the device owner." : "You are the participant."} The other side
              is the {peerLabel}. Signaling: {signalingState} · Peer{" "}
              {peerAlive ? "alive" : "not seen yet"} · Control channel{" "}
              {controlOpen ? "open" : "not open"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isRecording && (
              <span className="inline-flex items-center gap-2 rounded-full border border-[#FF4757]/40 bg-[#FF4757]/10 px-2.5 py-0.5 text-xs font-semibold text-[#FF4757]">
                <span className="live-dot inline-block h-2 w-2 rounded-full bg-[#FF4757]" />
                REC — this session is being recorded
              </span>
            )}
            {phase === "live" && (
              <span className="inline-flex items-center gap-2 rounded-full border border-[#00E5A8]/30 bg-[#00E5A8]/10 px-2.5 py-0.5 text-xs font-semibold text-[#00E5A8]">
                <span className="live-dot inline-block h-2 w-2 rounded-full bg-[#00E5A8]" />
                LIVE
              </span>
            )}
            <Badge tone={phaseTone[phase]}>{LIVE_PHASE_LABELS[phase]}</Badge>
          </div>
        </div>

        <details className="mt-4 rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/10 px-4 py-3 text-sm text-[#F2F7F5]">
          <summary className="cursor-pointer font-semibold text-[#D4AF37]">
            Sharing is always visible — how consent works
          </summary>
          <p className="mt-2">
            Your browser and OS show an indicator while screen, camera or microphone is active,
            and the other side sees exactly which tracks are on. A grant alone never turns
            anything on — every track below starts only when you press its button and approve the
            browser prompt. Stop anytime here, or from the browser&apos;s own sharing indicator.
            The same rule covers file transfer (every file needs the other side&apos;s approval),
            location (explicit start + browser prompt), and remote interaction (in-page cursor
            only, stoppable instantly). Recording (below) is covered by the permissions the owner
            granted once at pairing — no approval is asked again in-session. It shows a REC
            indicator on both sides, stops instantly if access is revoked, and saves only in the
            recorder&apos;s browser.
          </p>
        </details>

        {phase === "idle" && (
          <div className="mt-4">
            <p className="text-sm text-[#8FA3A0]">
              This session was already approved — joining starts signaling and the peer connection.
              No new session is created here.
            </p>
            <div className="mt-3">
              <Button onClick={() => void boot()}>Join live session</Button>
            </div>
          </div>
        )}

        {detail && (
          <p
            className={`mt-4 text-sm ${
              phase === "failed" || phase === "revoked" || phase === "peer-disconnected"
                ? "text-red-300"
                : "text-[#8FA3A0]"
            }`}
          >
            {detail}
          </p>
        )}

        {(phase === "failed" || phase === "peer-disconnected") && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => void retry()}>Retry connection</Button>
            <Button variant="outline" onClick={() => router.push("/dashboard/remote-access")}>
              Back to Remote Access
            </Button>
          </div>
        )}
      </Card>

      {ACTIVE_PHASES.includes(phase) && !fullView && (
        <>
          {/* ---------- FIRST LOOK (Spec Ch. 3, hero-corrected) ---------- */}
          <div className="mx-auto w-full max-w-[428px]">
            <div className="glass rounded-[24px] p-4 shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
              <div className="flex items-center justify-between text-[15px] leading-5 font-semibold text-white">
                <span className="font-display tabular-nums">{clockLabel}</span>
                <span className="min-w-0 truncate px-2">{deviceName}</span>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-[#FF4757]">
                  {phase === "live" && (
                    <>
                      <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[#FF4757]" />
                      LIVE
                    </>
                  )}
                </span>
              </div>

              <div className="mt-3 flex h-6 items-center justify-between">
                {phase === "live" ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#FF4757]/30 bg-[#FF4757]/10 px-2.5 py-0.5 text-[10px] leading-3 font-bold tracking-[0.06em] text-[#FF4757] uppercase">
                    <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[#FF4757]" />
                    Live
                  </span>
                ) : (
                  <Badge tone={phaseTone[phase]}>{LIVE_PHASE_LABELS[phase]}</Badge>
                )}
                {isRecording && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 font-display text-[15px] leading-5 font-semibold text-[#D4AF37] tabular-nums">
                    <span className="inline-block h-2 w-2 rounded-full bg-white" />
                    {recLabel}
                  </span>
                )}
              </div>

              <div
                ref={setRemoteScreenBox}
                tabIndex={0}
                role="button"
                aria-label="Remote screen. Activate to open the full controller."
                onClick={() => setFullView(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setFullView(true);
                  }
                }}
                className="relative mt-3 flex aspect-video cursor-pointer items-center justify-center overflow-hidden rounded-2xl bg-black outline-none focus:ring-2 focus:ring-[#00E5A8]/60"
              >
                {remoteScreenOn ? (
                  <video
                    ref={setRemoteScreenVideo}
                    autoPlay
                    playsInline
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <p className="px-4 text-center text-sm text-[#8FA3A0]">
                    No screen being shared right now.
                  </p>
                )}
                {peerAllowsInteraction && remoteScreenOn && (
                  <p className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[11px] text-[#00E5A8]">
                    Remote interaction on — your pointer and keys are shown to the other side
                    (in-page only, never OS control).
                  </p>
                )}
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-[#8FA3A0]">Permissions on</p>
                  <p className="font-display text-sm font-semibold text-white">
                    {permOnCount} of 4
                  </p>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {permRows.map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5"
                      title="Granted at pairing — change it from Trusted Devices"
                    >
                      <span className="text-[15px] leading-5 font-semibold text-white">
                        {row.label}
                      </span>
                      <Toggle on={row.granted} onChange={() => {}} disabled compact label={row.label} />
                    </div>
                  ))}
                </div>
              </div>

              <Button
                className="mt-3 h-14 w-full text-base"
                onClick={() => setFullView(true)}
              >
                Tap for full view
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </Button>
              <p className="mt-2 text-center text-xs text-[rgba(242,247,245,0.38)]">
                Tap the phone to open the full controller.
              </p>
            </div>
          </div>

          {/* Remote camera + my preview */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <h4 className="text-sm font-semibold text-white">
                Remote camera {remoteCameraOn && <Badge tone="green">On</Badge>}
                {remoteCameraOn && remoteCameraOff && <Badge tone="gold">Paused by peer</Badge>}
              </h4>
              <div className="mt-2 flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-black">
                {remoteCameraOn ? (
                  <video
                    ref={setRemoteCameraVideo}
                    autoPlay
                    playsInline
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <p className="px-4 text-center text-xs text-[#8FA3A0]">Camera off.</p>
                )}
              </div>
            </Card>
            <Card>
              <h4 className="text-sm font-semibold text-white">My preview</h4>
              <div className="relative mt-2 flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-black">
                {localPreview ? (
                  <video
                    ref={setLocalPreviewVideo}
                    autoPlay
                    playsInline
                    muted
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <p className="px-4 text-center text-xs text-[#8FA3A0]">
                    Start your camera or screen to preview it here.
                  </p>
                )}
                {remoteCursor && localPreview && (
                  <span
                    aria-label="Remote cursor"
                    className="pointer-events-none absolute z-10 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                    style={{ left: `${remoteCursor.x * 100}%`, top: `${remoteCursor.y * 100}%` }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#00E5A8" stroke="#080D12" strokeWidth="1.5" aria-hidden="true">
                      <path d="M5 3l14 7-6.5 1.5L9 18 5 3z" />
                    </svg>
                    {remoteCursor.kind === "click" && (
                      <span className="absolute h-6 w-6 animate-ping rounded-full border-2 border-[#00E5A8]" />
                    )}
                  </span>
                )}
              </div>
              {remoteCursor && localPreview && (
                <p className="mt-1 text-xs text-[#8FA3A0]">
                  The other side&apos;s pointer is on your shared view — in-page overlay only.
                  Stop it instantly from Remote interaction below.
                </p>
              )}
            </Card>
          </div>

          {/* Tracks + sharing + speaker */}
          <Card>
            <h3 className="font-semibold text-white">Tracks</h3>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex items-center justify-between gap-2">
                <span className="text-[#F2F7F5]">My screen</span>
                <Badge tone={localScreenOn ? "green" : "muted"}>
                  {localScreenOn ? "Sharing" : "Off"}
                </Badge>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-[#F2F7F5]">My camera</span>
                <Badge tone={localCameraOn && !cameraOff ? "green" : "muted"}>
                  {localCameraOn ? (cameraOff ? "Paused" : "On") : "Off"}
                </Badge>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-[#F2F7F5]">My microphone</span>
                <Badge tone={localMicOn && !micMuted ? "green" : "muted"}>
                  {localMicOn ? (micMuted ? "Muted" : "Live") : "Off"}
                </Badge>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-[#F2F7F5]">Remote screen</span>
                <Badge tone={remoteScreenOn ? "green" : "muted"}>
                  {remoteScreenOn ? "Sharing" : "Off"}
                </Badge>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-[#F2F7F5]">Remote camera</span>
                <Badge tone={remoteCameraOn && !remoteCameraOff ? "green" : "muted"}>
                  {remoteCameraOn ? (remoteCameraOff ? "Paused" : "On") : "Off"}
                </Badge>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-[#F2F7F5]">Remote microphone</span>
                <Badge tone={remoteMicOn && !remoteMicMuted ? "green" : "muted"}>
                  {remoteMicOn ? (remoteMicMuted ? "Muted" : "Live") : "Off"}
                </Badge>
              </li>
            </ul>

            <h3 className="mt-5 font-semibold text-white">My sharing</h3>
            <div className="mt-3 flex flex-col gap-2">
              <Button
                variant="outline"
                disabled={!canPublish("screen") || !joined}
                onClick={() => (localScreenOn ? removeLocalTrack("screen") : void startScreen())}
              >
                {localScreenOn ? "Stop sharing screen" : "Share screen"}
              </Button>
              {!canPublish("screen") && (
                <p className="text-xs text-[#8FA3A0]">
                  Screen sharing is not granted to you — ask the device owner to approve it.
                </p>
              )}
              <Button
                variant="outline"
                disabled={!canPublish("camera") || !joined}
                onClick={() => (localCameraOn ? removeLocalTrack("camera") : void startCamera())}
              >
                {localCameraOn ? "Stop camera" : "Start camera"}
              </Button>
              {!canPublish("camera") && (
                <p className="text-xs text-[#8FA3A0]">
                  Camera is not granted to you — ask the device owner to approve it.
                </p>
              )}
              <Button
                variant="outline"
                disabled={!canPublish("microphone") || !joined}
                onClick={() => (localMicOn ? removeLocalTrack("microphone") : void startMic())}
              >
                {localMicOn ? "Stop microphone" : "Start microphone"}
              </Button>
              {!canPublish("microphone") && (
                <p className="text-xs text-[#8FA3A0]">
                  Microphone is not granted to you — ask the device owner to approve it.
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={!localMicOn}
                  onClick={toggleMicMute}
                >
                  {micMuted ? "Unmute mic" : "Mute mic"}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={!localCameraOn}
                  onClick={toggleCameraOff}
                >
                  {cameraOff ? "Camera on" : "Camera off"}
                </Button>
              </div>
            </div>

            <h3 className="mt-5 font-semibold text-white">Speaker (remote audio)</h3>
            <p className="mt-1 text-xs text-[#8FA3A0]">
              Plays the remote microphone. Separate from your microphone mute — muting your mic
              never mutes the speaker.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="outline"
                disabled={!audioAllowed || !remoteMicOn}
                onClick={() => setSpeakerMuted((v) => !v)}
              >
                {speakerMuted ? "Unmute speaker" : "Mute speaker"}
              </Button>
              <input
                type="range"
                min={0}
                max={100}
                value={speakerVolume}
                disabled={!audioAllowed || !remoteMicOn}
                onChange={(e) => setSpeakerVolume(Number(e.target.value))}
                aria-label="Speaker volume"
                className="flex-1 accent-[#00E5A8]"
              />
              <span className="w-10 text-right text-xs text-[#8FA3A0]">{speakerVolume}%</span>
            </div>
            {!audioAllowed && (
              <p className="mt-2 text-xs text-[#8FA3A0]">
                Speaker playback is not granted to you — ask the device owner to approve the
                speaker permission.
              </p>
            )}
            {!remoteMicOn && audioAllowed && (
              <p className="mt-2 text-xs text-[#8FA3A0]">
                The remote microphone is off, so there is no audio to play yet.
              </p>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* ---------- File transfer ---------- */}
            <Card>
              <h3 className="font-semibold text-white">
                File transfer{" "}
                {canTransferFiles(grantedScopes, isOwner) ? (
                  <Badge tone="green">Granted</Badge>
                ) : (
                  <Badge tone="muted">Not granted</Badge>
                )}
              </h3>
              <p className="mt-1 text-xs text-[#8FA3A0]">
                Peer-to-peer only (the server never stores file bytes), 50&nbsp;MB max per file,
                16&nbsp;KB chunks. Every file needs the other side&apos;s approval first — nothing
                is sent silently.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void offerFile(file);
                }}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!canTransferFiles(grantedScopes, isOwner) || !fileChannelOpen}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Send a file…
                </Button>
                {outgoingTransfer &&
                  (outgoingTransfer.status === "offered" ||
                    outgoingTransfer.status === "in_progress") && (
                    <Button variant="outline" onClick={cancelOutgoingTransfer}>
                      Cancel sending
                    </Button>
                  )}
              </div>
              {!fileChannelOpen && canTransferFiles(grantedScopes, isOwner) && (
                <p className="mt-2 text-xs text-[#8FA3A0]">
                  The file channel is not open yet — it opens with the peer connection.
                </p>
              )}
              {!canTransferFiles(grantedScopes, isOwner) && (
                <p className="mt-2 text-xs text-[#8FA3A0]">
                  File transfer is not granted to you — ask the device owner to approve it.
                </p>
              )}
              {fileError && <p className="mt-2 text-sm text-red-300">{fileError}</p>}
              {outgoingTransfer && (
                <div className="mt-3 rounded-lg border border-[#1E2D38] p-3 text-sm">
                  <p className="text-[#F2F7F5]">
                    Sending: <span className="font-semibold">{outgoingTransfer.fileName}</span> ·{" "}
                    {(outgoingTransfer.fileSizeBytes / 1024).toFixed(1)} KB
                  </p>
                  <p className="mt-1 text-xs text-[#8FA3A0]">
                    {TRANSFER_STATUS_LABELS[outgoingTransfer.status]}
                    {outgoingTransfer.status === "in_progress" &&
                      ` — ${transferProgressPercent(outgoingTransfer.sentBytes, outgoingTransfer.fileSizeBytes)}%`}
                    {outgoingTransfer.status === "approved" && " — starting…"}
                    {outgoingTransfer.status === "completed" &&
                      " — the other side confirmed receipt."}
                    {outgoingTransfer.status === "rejected" && " — the other side declined."}
                  </p>
                  {(outgoingTransfer.status === "in_progress" ||
                    outgoingTransfer.status === "approved") && (
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full bg-[#00E5A8]"
                        style={{
                          width: `${transferProgressPercent(outgoingTransfer.sentBytes, outgoingTransfer.fileSizeBytes)}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
              {incomingTransfer && (
                <div className="mt-3 rounded-lg border border-[#1E2D38] p-3 text-sm">
                  <p className="text-[#F2F7F5]">
                    Receiving: <span className="font-semibold">{incomingTransfer.fileName}</span>{" "}
                    · {(incomingTransfer.fileSizeBytes / 1024).toFixed(1)} KB
                  </p>
                  <p className="mt-1 text-xs text-[#8FA3A0]">
                    {TRANSFER_STATUS_LABELS[incomingTransfer.status]}
                    {incomingTransfer.status === "in_progress" &&
                      ` — ${transferProgressPercent(incomingTransfer.receivedBytes, incomingTransfer.fileSizeBytes)}%`}
                  </p>
                  {incomingTransfer.status === "offered" && (
                    <div className="mt-2 flex gap-2">
                      <Button variant="primary" onClick={approveIncomingTransfer}>
                        Approve &amp; receive
                      </Button>
                      <Button variant="outline" onClick={rejectIncomingTransfer}>
                        Reject
                      </Button>
                    </div>
                  )}
                  {incomingTransfer.status === "in_progress" && (
                    <>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full bg-[#00E5A8]"
                          style={{
                            width: `${transferProgressPercent(incomingTransfer.receivedBytes, incomingTransfer.fileSizeBytes)}%`,
                          }}
                        />
                      </div>
                      <div className="mt-2">
                        <Button variant="outline" onClick={cancelIncomingTransfer}>
                          Cancel receiving
                        </Button>
                      </div>
                    </>
                  )}
                  {incomingTransfer.status === "completed" && incomingTransfer.downloadUrl && (
                    <div className="mt-2">
                      <a
                        href={incomingTransfer.downloadUrl}
                        download={incomingTransfer.fileName}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[14px] bg-[#00E5A8] px-4 py-2.5 text-sm font-semibold text-[#062018] hover:bg-[#00C790]"
                      >
                        Download {incomingTransfer.fileName}
                      </a>
                    </div>
                  )}
                </div>
              )}
            </Card>

            {/* ---------- Location ---------- */}
            <Card>
              <h3 className="font-semibold text-white">
                Location{" "}
                {canShareLocation(grantedScopes, isOwner) ? (
                  <Badge tone="green">Granted</Badge>
                ) : (
                  <Badge tone="muted">Not granted</Badge>
                )}
              </h3>
              <p className="mt-1 text-xs text-[#8FA3A0]">
                Shared only when you explicitly start it and approve the browser&apos;s location
                prompt — never silently, never in the background. Stop anytime; the other side
                sees the same indicator you do.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!canShareLocation(grantedScopes, isOwner) || !joined}
                  onClick={() => (sharingLocation ? stopLocationSharing() : void startLocationSharing())}
                >
                  {sharingLocation ? "Stop sharing my location" : "Share my location"}
                </Button>
              </div>
              {!canShareLocation(grantedScopes, isOwner) && (
                <p className="mt-2 text-xs text-[#8FA3A0]">
                  Location sharing is not granted to you — ask the device owner to approve it.
                </p>
              )}
              {locationError && <p className="mt-2 text-sm text-red-300">{locationError}</p>}
              {sharingLocation && (
                <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-[#00E5A8]/30 bg-[#00E5A8]/10 px-2.5 py-0.5 text-xs font-semibold text-[#00E5A8]">
                  <span className="live-dot inline-block h-2 w-2 rounded-full bg-[#00E5A8]" />
                  Sharing my location
                </p>
              )}
              {peerSharingLocation && (
                <div className="mt-3 rounded-lg border border-[#1E2D38] p-3 text-sm">
                  <p className="text-[#F2F7F5]">
                    <span className="font-semibold">The other side is sharing location</span>
                  </p>
                  {peerLocation ? (
                    <>
                      <p className="mt-1 text-xs text-[#8FA3A0]">
                        {formatCoordinates(peerLocation.latitude, peerLocation.longitude)}
                        {peerLocation.accuracy !== null &&
                          ` · ±${Math.round(peerLocation.accuracy)} m`}
                        {" · "}
                        {new Date(peerLocation.timestamp).toLocaleTimeString()}
                      </p>
                      <a
                        href={openStreetMapLink(peerLocation.latitude, peerLocation.longitude)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-sm font-semibold text-[#00E5A8] hover:underline"
                      >
                        Open in OpenStreetMap
                      </a>
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-[#8FA3A0]">Waiting for the first fix…</p>
                  )}
                </div>
              )}
              {!peerSharingLocation && !sharingLocation && (
                <p className="mt-3 text-xs text-[#8FA3A0]">Nobody is sharing location right now.</p>
              )}
            </Card>

            {/* ---------- Remote interaction ---------- */}
            <Card>
              <h3 className="font-semibold text-white">
                Remote interaction{" "}
                {canUseRemoteInteraction(grantedScopes, isOwner) ? (
                  <Badge tone="green">Granted</Badge>
                ) : (
                  <Badge tone="muted">Not granted</Badge>
                )}
              </h3>
              <p className="mt-1 text-xs text-[#8FA3A0]">
                In-page only: a remote cursor overlay plus click/key forwarding to the shared
                view. A browser cannot synthesize OS-level input on the remote device — this is
                NOT full remote control. The controlled side can stop it instantly.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!canUseRemoteInteraction(grantedScopes, isOwner) || !joined}
                  onClick={toggleAllowInteraction}
                >
                  {allowInteraction
                    ? "Stop allowing remote interaction"
                    : "Allow remote interaction on my view"}
                </Button>
                {allowInteraction && (
                  <Button variant="danger" onClick={killInteraction}>
                    Kill interaction now
                  </Button>
                )}
              </div>
              {!canUseRemoteInteraction(grantedScopes, isOwner) && (
                <p className="mt-2 text-xs text-[#8FA3A0]">
                  Remote interaction is not granted to you — ask the device owner to approve it.
                </p>
              )}
              <ul className="mt-3 space-y-1 text-sm">
                <li className="flex items-center justify-between gap-2">
                  <span className="text-[#F2F7F5]">I allow interaction on my view</span>
                  <Badge tone={allowInteraction ? "green" : "muted"}>
                    {allowInteraction ? "On" : "Off"}
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span className="text-[#F2F7F5]">The other side allows me to interact</span>
                  <Badge tone={peerAllowsInteraction ? "green" : "muted"}>
                    {peerAllowsInteraction ? "On" : "Off"}
                  </Badge>
                </li>
              </ul>
              {peerAllowsInteraction && (
                <p className="mt-2 text-xs text-[#8FA3A0]">
                  Move your pointer over the remote screen above (click the screen area first to
                  send keys). Your pointer shows as a remote cursor on the other side&apos;s view.
                </p>
              )}
              {interactionKeys.length > 0 && (
                <div className="mt-3 rounded-lg border border-[#1E2D38] p-3 text-sm">
                  <p className="font-semibold text-white">Keys sent by the other side</p>
                  <p className="mt-1 text-xs text-[#8FA3A0]">
                    Shown here only — never typed into this device or its OS.
                  </p>
                  <p className="mt-1 break-all text-[#F2F7F5]">
                    {interactionKeys.map((k) => (k === " " ? "␣" : k)).join(" ")}
                  </p>
                </div>
              )}
            </Card>

            {/* ---------- Notification feed ---------- */}
            <Card>
              <h3 className="font-semibold text-white">
                Notification feed{" "}
                {canShareNotifications(grantedScopes, isOwner) ? (
                  <Badge tone="green">Granted</Badge>
                ) : (
                  <Badge tone="muted">Not granted</Badge>
                )}
              </h3>
              <p className="mt-1 text-xs text-[#8FA3A0]">
                Shows notifications the reporting device sends while sharing is active. Web
                browsers cannot capture OS notifications, so this browser sends none — the feed
                fills only from a real reporting device (Android, Milestone 6). No notification
                data is faked here.
              </p>
              {peerSharingNotifications && (
                <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-[#00E5A8]/30 bg-[#00E5A8]/10 px-2.5 py-0.5 text-xs font-semibold text-[#00E5A8]">
                  <span className="live-dot inline-block h-2 w-2 rounded-full bg-[#00E5A8]" />
                  Notification sharing active
                </p>
              )}
              {!canShareNotifications(grantedScopes, isOwner) && (
                <p className="mt-3 text-xs text-[#8FA3A0]">
                  Notifications are not granted to you — ask the device owner to approve them.
                </p>
              )}
              {canShareNotifications(grantedScopes, isOwner) && !peerSharingNotifications && (
                <p className="mt-3 text-xs text-[#8FA3A0]">
                  The other side is not sharing notifications right now.
                </p>
              )}
              {notificationFeed.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {notificationFeed.map((n, i) => (
                    <li key={`${n.receivedAt}-${i}`} className="rounded-lg border border-[#1E2D38] p-3 text-sm">
                      <p className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-white">{n.title}</span>
                        <span className="text-xs text-[#8FA3A0]">{n.app}</span>
                      </p>
                      {n.body && <p className="mt-1 text-[#F2F7F5]">{n.body}</p>}
                      <p className="mt-1 text-xs text-[#8FA3A0]">
                        {new Date(n.receivedAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* ---------- Session recording (v1) ---------- */}
            <Card>
              <h3 className="font-semibold text-white">
                Session recording{" "}
                <Badge tone={recordingState === "recording" || peerRecording ? "red" : "muted"}>
                  {recordingState === "recording"
                    ? "Recording"
                    : peerRecording
                      ? "Peer recording"
                      : "Off"}
                </Badge>
              </h3>
              <p className="mt-1 text-xs text-[#8FA3A0]">
                Records the remote screen/camera + microphone into a .webm file saved only in
                this browser — nothing is uploaded to the server. Recording is covered by the
                permissions the owner granted once at pairing, so it starts right away with no
                extra approval. It stops instantly if access is revoked, and never runs longer
                than 1 hour.
              </p>
              {isRecording && (
                <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-[#FF4757]/40 bg-[#FF4757]/10 px-2.5 py-0.5 text-xs font-semibold text-[#FF4757]">
                  <span className="live-dot inline-block h-2 w-2 rounded-full bg-[#FF4757]" />
                  REC
                  {recordingState === "recording"
                    ? ` — recording ${formatRecordingDuration(recordingElapsedMs)}`
                    : " — the other side is recording this session"}
                </p>
              )}
              {(recordingState === "idle" || recordingState === "stopped") && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={
                      !joined ||
                      !controlOpen ||
                      !remoteTracksLiveNow ||
                      !canRecord(grantedScopes, isOwner)
                    }
                    onClick={() => void startRecordingNow()}
                  >
                    Record remote session
                  </Button>
                </div>
              )}
              {recordingState === "recording" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="danger" onClick={() => stopRecording("user")}>
                    Stop recording
                  </Button>
                </div>
              )}
              {!remoteTracksLiveNow && recordingState === "idle" && (
                <p className="mt-2 text-xs text-[#8FA3A0]">
                  Start the other side&apos;s screen, camera or microphone first — there is
                  nothing to record yet.
                </p>
              )}
              {!canRecord(grantedScopes, isOwner) && recordingState === "idle" && (
                <p className="mt-2 text-xs text-[#8FA3A0]">
                  Recording needs a screen, camera or microphone permission granted at pairing.
                </p>
              )}
              {recordingError && <p className="mt-2 text-sm text-red-300">{recordingError}</p>}
              {recordingSavedAt !== null && recordingState === "stopped" && (
                <p className="mt-3 text-sm text-[#00E5A8]">
                  Recording saved in this browser.{" "}
                  <a href="/dashboard/recordings" className="font-semibold underline">
                    View recordings
                  </a>
                </p>
              )}
            </Card>
          </div>

          <Card>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="danger" onClick={() => void endSession()}>
                End session
              </Button>
              <p className="text-sm text-[#8FA3A0]">
                Ending stops every track, closes the peer connection, and notifies the other side.
                The device owner can also revoke access at any time from Trusted Devices.
              </p>
            </div>
            <p className="mt-3 text-xs text-[#8FA3A0]">
              Direct peer-to-peer only (public Google STUN, no TURN server yet). If both sides are
              behind strict NATs or firewalls the connection may fail — retry, or try a different
              network. A TURN server is a future deployment item.
            </p>
          </Card>
        </>
      )}

      {ACTIVE_PHASES.includes(phase) && fullView && (
        <div className="fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden bg-[#080D12]">
          {/* ---------- FULL VIEW top bar (Spec 4.1, pinned) ---------- */}
          <div className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[rgba(18,27,36,0.72)] px-3 backdrop-blur-[20px]">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setFullView(false)}
                aria-label="Back to first look"
                className="pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              {phase === "live" && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#FF4757]/30 bg-[#FF4757]/10 px-2.5 py-0.5 text-[10px] leading-3 font-bold tracking-[0.06em] text-[#FF4757] uppercase">
                  <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[#FF4757]" />
                  Live
                </span>
              )}
            </div>
            <div className="min-w-0 text-center">
              <p className="truncate text-[15px] leading-5 font-semibold text-white">
                {deviceName}
              </p>
              {isRecording && (
                <p className="font-display text-xs font-semibold text-[#D4AF37] tabular-nums">
                  {recLabel}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setEndConfirmOpen(true)}
              className="pressable flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[#FF4757] px-3 text-[13px] font-bold text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v8" />
                <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
              </svg>
              End Session
            </button>
          </div>

          {/* ---------- FULL VIEW video area (Spec 4.2, dominant) ---------- */}
          <div className="relative mx-2 mt-3 min-h-[240px] flex-1 overflow-hidden rounded-2xl bg-black">
            <div
              ref={setRemoteScreenBox}
              tabIndex={0}
              aria-label="Remote screen. When the other side allows remote interaction, moving your pointer here shows a remote cursor on their view. Tap the screen to control it."
              onPointerMove={(e) => forwardPointer("move", e)}
              onPointerDown={(e) => forwardPointer("click", e)}
              onKeyDown={(e) => forwardKey(e)}
              className="absolute inset-0 outline-none focus:ring-2 focus:ring-inset focus:ring-[#00E5A8]/60"
            >
              {remoteScreenOn ? (
                <video
                  ref={setRemoteScreenVideo}
                  autoPlay
                  playsInline
                  className="h-full w-full object-contain"
                />
              ) : (
                <p className="flex h-full items-center justify-center px-4 text-center text-sm text-[#8FA3A0]">
                  No screen being shared right now.
                </p>
              )}
            </div>
            {isRecording && (
              <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-2.5 py-0.5 text-[10px] leading-3 font-bold tracking-[0.06em] text-white uppercase backdrop-blur-[20px]">
                <span className="live-dot inline-block h-2 w-2 rounded-full bg-[#FF4757]" />
                Rec
              </span>
            )}
            <span className="absolute top-3 right-3 rounded-full border border-white/10 bg-black/60 px-2.5 py-0.5 text-[10px] leading-3 font-bold tracking-[0.06em] text-white uppercase backdrop-blur-[20px]">
              Auto
            </span>
            {remoteCameraOn && (
              <div className="absolute bottom-2 left-2 w-28 overflow-hidden rounded-lg border border-white/10 bg-black">
                <video
                  ref={setRemoteCameraVideo}
                  autoPlay
                  playsInline
                  className="aspect-video w-full object-contain"
                />
              </div>
            )}
            {localPreview && (
              <div className="absolute right-2 bottom-2 w-28 overflow-hidden rounded-lg border border-white/10 bg-black">
                <video
                  ref={setLocalPreviewVideo}
                  autoPlay
                  playsInline
                  muted
                  className="aspect-video w-full object-contain"
                />
                {remoteCursor && (
                  <span
                    aria-label="Remote cursor"
                    className="pointer-events-none absolute z-10 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                    style={{ left: `${remoteCursor.x * 100}%`, top: `${remoteCursor.y * 100}%` }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#00E5A8" stroke="#080D12" strokeWidth="1.5" aria-hidden="true">
                      <path d="M5 3l14 7-6.5 1.5L9 18 5 3z" />
                    </svg>
                    {remoteCursor.kind === "click" && (
                      <span className="absolute h-6 w-6 animate-ping rounded-full border-2 border-[#00E5A8]" />
                    )}
                  </span>
                )}
              </div>
            )}
            {flash && <div className="flash-overlay pointer-events-none absolute inset-0 bg-white" />}
            {peerAllowsInteraction && remoteScreenOn && (
              <p className="absolute bottom-2 left-1/2 hidden -translate-x-1/2 rounded bg-black/70 px-2 py-1 text-[11px] whitespace-nowrap text-[#00E5A8] sm:block">
                Remote interaction on — tap the screen to control
              </p>
            )}
          </div>

          {/* ---------- FULL VIEW control deck (Spec 4.3, compact) ---------- */}
          <div className="glass mx-3 mt-3 mb-3 shrink-0 rounded-[20px] p-4 shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                aria-label="Back"
                disabled={!peerAllowsInteraction}
                onClick={() => sendDeckKey("Back")}
                className="pressable flex h-9 w-[72px] items-center justify-center rounded-[10px] border border-white/10 bg-white/5 text-white disabled:opacity-40"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Home"
                disabled={!peerAllowsInteraction}
                onClick={() => sendDeckKey("Home")}
                className="pressable flex h-9 w-[72px] items-center justify-center rounded-[10px] border border-white/10 bg-white/5 text-white disabled:opacity-40"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="8" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Recents"
                disabled={!peerAllowsInteraction}
                onClick={() => sendDeckKey("Recents")}
                className="pressable flex h-9 w-[72px] items-center justify-center rounded-[10px] border border-white/10 bg-white/5 text-white disabled:opacity-40"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            </div>

            <div className="mt-3 flex items-start justify-center gap-4">
              {/* Volume rocker + meter */}
              <div className="flex w-14 flex-col items-center gap-2">
                <button
                  type="button"
                  aria-label="Volume up"
                  disabled={!audioAllowed || !remoteMicOn}
                  onClick={() => stepVolume(10)}
                  className="pressable flex h-14 w-14 items-center justify-center rounded-[14px] border border-white/10 bg-white/5 text-white disabled:opacity-40"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M11 5L6 9H3v6h3l5 4V5z" />
                    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
                  </svg>
                </button>
                <div className="flex h-8 w-1 flex-col gap-[2px]" aria-hidden="true">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <span
                      key={i}
                      className={`flex-1 rounded-full ${i < volumeSegments ? "bg-[#00E5A8]" : "bg-white/10"}`}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  aria-label="Volume down"
                  disabled={!audioAllowed || !remoteMicOn}
                  onClick={() => stepVolume(-10)}
                  className="pressable flex h-14 w-14 items-center justify-center rounded-[14px] border border-white/10 bg-white/5 text-white disabled:opacity-40"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M11 5L6 9H3v6h3l5 4V5z" />
                    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  </svg>
                </button>
              </div>

              {/* Swipe pad + TAP */}
              <div
                role="application"
                aria-label="Swipe pad. Drag to move the remote pointer, tap TAP to click."
                className={`relative h-[168px] w-[168px] touch-none rounded-[20px] border border-white/10 bg-white/5 ${
                  peerAllowsInteraction ? "" : "opacity-40"
                }`}
                onPointerDown={(e) => {
                  padDraggingRef.current = true;
                  handlePadPointer(e);
                }}
                onPointerMove={(e) => {
                  if (padDraggingRef.current) handlePadPointer(e);
                }}
                onPointerUp={() => {
                  padDraggingRef.current = false;
                }}
                onPointerLeave={() => {
                  padDraggingRef.current = false;
                }}
              >
                <span className="absolute top-1/2 left-0 h-px w-full bg-white/5" aria-hidden="true" />
                <span className="absolute top-0 left-1/2 h-full w-px bg-white/5" aria-hidden="true" />
                <button
                  type="button"
                  aria-label="Tap the remote screen"
                  disabled={!peerAllowsInteraction}
                  onPointerDown={handlePadTap}
                  className="pressable absolute top-1/2 left-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#00E5A8] bg-[#121B24] text-[11px] font-bold text-[#00E5A8] disabled:opacity-40"
                >
                  TAP
                </button>
              </div>

              {/* Power + Screenshot */}
              <div className="flex w-14 flex-col gap-2">
                <button
                  type="button"
                  aria-label="Power"
                  disabled={!peerAllowsInteraction}
                  onClick={() => sendDeckKey("Power")}
                  className="pressable flex h-14 w-14 items-center justify-center rounded-[14px] border border-white/10 bg-white/5 text-white active:border-[#FF4757]/40 active:text-[#FF4757] disabled:opacity-40"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v8" />
                    <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label="Screenshot"
                  onClick={takeScreenshot}
                  className="pressable flex h-14 w-14 items-center justify-center rounded-[14px] border border-white/10 bg-white/5 text-white"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 8h3l2-3h6l2 3h3v11H4V8z" />
                    <circle cx="12" cy="13" r="3.5" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Type box */}
            <div className="mt-3 flex items-center gap-2">
              <input
                value={typeText}
                onChange={(e) => setTypeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendTypedText();
                }}
                placeholder="Type a message or command…"
                aria-label="Type text to send to the remote device"
                disabled={!peerAllowsInteraction}
                className="h-11 flex-1 rounded-xl border border-[#1E2D38] bg-[#121B24] px-3.5 text-[13px] text-white placeholder:text-[rgba(242,247,245,0.38)] outline-none focus:border-[#00E5A8] disabled:opacity-50"
              />
              <button
                type="button"
                aria-label="Send text"
                onClick={sendTypedText}
                disabled={!peerAllowsInteraction || typeText.length === 0}
                className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#00E5A8] text-[#062018] disabled:opacity-40"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 2L11 13" />
                  <path d="M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              </button>
            </div>

            {/* Quality + activity log */}
            <div className="mt-3 flex items-start justify-between gap-3">
              <button
                type="button"
                onClick={() => setQualitySheetOpen(true)}
                className="pressable flex h-8 shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 text-xs font-semibold text-white"
              >
                Auto
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <div className="min-w-0 flex-1 text-right" aria-live="polite">
                {logLines.length === 0 ? (
                  <p className="truncate text-[11px] text-[rgba(242,247,245,0.38)]">
                    {peerAllowsInteraction
                      ? "Tap the phone screen directly, or use the pad below."
                      : "Remote interaction is off — ask the other side to allow it."}
                  </p>
                ) : (
                  logLines.map((line, i) => (
                    <p
                      key={`${i}-${line}`}
                      className={`truncate text-[11px] ${
                        i === logLines.length - 1
                          ? "text-[#F2F7F5]"
                          : "text-[rgba(242,247,245,0.38)]"
                      }`}
                    >
                      {line}
                    </p>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* End-session confirm sheet */}
          {endConfirmOpen && (
            <div
              className="absolute inset-0 z-[60] flex items-end justify-center bg-black/60"
              onClick={() => setEndConfirmOpen(false)}
            >
              <div
                className="sheet-up glass w-full max-w-[428px] rounded-t-[20px] p-4 pb-6"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="text-lg font-semibold text-white">End session?</h3>
                <p className="mt-1 text-sm text-[#8FA3A0]">
                  The recording will be saved to Recordings.
                </p>
                <div className="mt-4 space-y-2">
                  <Button
                    variant="danger"
                    className="h-11 w-full"
                    onClick={() => {
                      setEndConfirmOpen(false);
                      setFullView(false);
                      void endSession();
                    }}
                  >
                    End session
                  </Button>
                  <Button
                    variant="glass"
                    className="h-11 w-full"
                    onClick={() => setEndConfirmOpen(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Quality sheet — web quality adapts automatically; no fake setting. */}
          {qualitySheetOpen && (
            <div
              className="absolute inset-0 z-[60] flex items-end justify-center bg-black/60"
              onClick={() => setQualitySheetOpen(false)}
            >
              <div
                className="sheet-up glass w-full max-w-[428px] rounded-t-[20px] p-4 pb-6"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="text-lg font-semibold text-white">Stream quality</h3>
                <p className="mt-1 text-sm text-[#8FA3A0]">
                  Quality adapts automatically to the connection on web — there is no manual
                  setting. The remote side sends the best quality the connection supports.
                </p>
                <div className="mt-4">
                  <Button
                    variant="glass"
                    className="h-11 w-full"
                    onClick={() => setQualitySheetOpen(false)}
                  >
                    Close
                  </Button>
                </div>
              </div>
            </div>
          )}

          {toast && (
            <div className="absolute top-[64px] left-1/2 z-[70] -translate-x-1/2 rounded-full border border-white/10 bg-[rgba(18,27,36,0.9)] px-4 py-2 text-sm font-semibold whitespace-nowrap text-white shadow-lg">
              {toast}
            </div>
          )}
        </div>
      )}

      {(phase === "ended" || phase === "revoked") && (
        <Card>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => router.push("/dashboard/remote-access")}>
              Back to Remote Access
            </Button>
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              Back to Overview
            </Button>
          </div>
        </Card>
      )}

      {/* Remote audio element — no visible controls; the speaker slider is its only control. */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
    </div>
  );
}
