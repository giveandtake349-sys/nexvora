"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card } from "./ui";
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
  canPlayRemoteAudio,
  canPublishTrack,
  parseControlMessage,
  transitionLivePhase,
  type ControlMessage,
  type LivePhase,
  type LivePhaseEvent,
  type MediaTrackKind,
} from "@/lib/webrtc";
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

const ACTIVE_PHASES: LivePhase[] = ["waiting", "connecting", "live", "reconnecting"];

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
  const wasLiveRef = useRef(false);
  const micMutedRef = useRef(false);
  const cameraOffRef = useRef(false);
  const remoteTracksRef = useRef<RemoteTrackView[]>([]);
  const localPreviewRef = useRef<HTMLVideoElement | null>(null);
  const remoteScreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const audioAllowed = canPlayRemoteAudio(grantedScopes, isOwner);
  const remoteScreen = remoteTracks.find((t) => t.slot === "screen" && t.kind === "video");
  const remoteCamera = remoteTracks.find((t) => t.slot === "camera" && t.kind === "video");
  const remoteAudio = remoteTracks.find((t) => t.slot === "microphone");
  const remoteScreenOn = Boolean(remoteScreen);
  const remoteCameraOn = Boolean(remoteCamera);
  const remoteMicOn = Boolean(remoteAudio);
  const joined = ACTIVE_PHASES.includes(phase) || phase === "failed" || phase === "peer-disconnected";

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
    pollerRef.current?.stop();
    pollerRef.current = null;
    if (heartbeatRef.current !== null) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
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

  /* ---------------- peer connection ---------------- */

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

  async function createAndSendOffer(): Promise<void> {
    const pc = pcRef.current;
    const client = clientRef.current;
    if (!pc || !client || pc.signalingState !== "stable") return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await client.send("offer", { type: offer.type, sdp: offer.sdp });
      applyPhase("offer-sent");
    } catch (err) {
      setDetail(`Could not create an offer: ${err instanceof Error ? err.message : "unknown error"}`);
      applyPhase("error");
    }
  }

  async function renegotiate(): Promise<void> {
    const pc = pcRef.current;
    if (!pc || pc.signalingState !== "stable") return;
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
      // receives it via ondatachannel.
      setupDataChannel(pc.createDataChannel(CONTROL_CHANNEL_NAME));
    } else {
      pc.ondatachannel = (event) => {
        if (event.channel.label === CONTROL_CHANNEL_NAME) setupDataChannel(event.channel);
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
            {phase === "live" && (
              <span className="inline-flex items-center gap-2 rounded-full border border-[#00E5A8]/30 bg-[#00E5A8]/10 px-2.5 py-0.5 text-xs font-semibold text-[#00E5A8]">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#00E5A8]" />
                LIVE
              </span>
            )}
            <Badge tone={phaseTone[phase]}>{LIVE_PHASE_LABELS[phase]}</Badge>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/10 p-4 text-sm text-[#E8F0EE]">
          Sharing is always visible: your browser and OS show an indicator while screen, camera
          or microphone is active, and the other side sees exactly which tracks are on. A grant
          alone never turns anything on — every track below starts only when you press its button
          and approve the browser prompt. Stop anytime here, or from the browser&apos;s own
          sharing indicator.
        </div>

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

      {joined && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <h3 className="font-semibold text-white">
                Remote screen {remoteScreenOn && <Badge tone="green">Sharing</Badge>}
              </h3>
              <div className="mt-3 flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black">
                {remoteScreenOn ? (
                  <video
                    ref={remoteScreenVideoRef}
                    autoPlay
                    playsInline
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <p className="px-4 text-center text-sm text-[#8FA3A0]">
                    No screen being shared right now.
                  </p>
                )}
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <h4 className="text-sm font-semibold text-white">
                    Remote camera {remoteCameraOn && <Badge tone="green">On</Badge>}
                    {remoteCameraOn && remoteCameraOff && <Badge tone="gold">Paused by peer</Badge>}
                  </h4>
                  <div className="mt-2 flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black">
                    {remoteCameraOn ? (
                      <video
                        ref={remoteCameraVideoRef}
                        autoPlay
                        playsInline
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <p className="px-4 text-center text-xs text-[#8FA3A0]">Camera off.</p>
                    )}
                  </div>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">My preview</h4>
                  <div className="mt-2 flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black">
                    {localPreview ? (
                      <video
                        ref={localPreviewRef}
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
                  </div>
                </div>
              </div>
              {/* Remote audio element — no visible controls; the speaker
                  slider below is its only control, separate from the mic. */}
              <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
            </Card>

            <Card>
              <h3 className="font-semibold text-white">Tracks</h3>
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex items-center justify-between gap-2">
                  <span className="text-[#E8F0EE]">My screen</span>
                  <Badge tone={localScreenOn ? "green" : "muted"}>
                    {localScreenOn ? "Sharing" : "Off"}
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span className="text-[#E8F0EE]">My camera</span>
                  <Badge tone={localCameraOn && !cameraOff ? "green" : "muted"}>
                    {localCameraOn ? (cameraOff ? "Paused" : "On") : "Off"}
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span className="text-[#E8F0EE]">My microphone</span>
                  <Badge tone={localMicOn && !micMuted ? "green" : "muted"}>
                    {localMicOn ? (micMuted ? "Muted" : "Live") : "Off"}
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span className="text-[#E8F0EE]">Remote screen</span>
                  <Badge tone={remoteScreenOn ? "green" : "muted"}>
                    {remoteScreenOn ? "Sharing" : "Off"}
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span className="text-[#E8F0EE]">Remote camera</span>
                  <Badge tone={remoteCameraOn && !remoteCameraOff ? "green" : "muted"}>
                    {remoteCameraOn ? (remoteCameraOff ? "Paused" : "On") : "Off"}
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span className="text-[#E8F0EE]">Remote microphone</span>
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
    </div>
  );
}
