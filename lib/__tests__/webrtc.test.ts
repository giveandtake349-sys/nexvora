/**
 * WebRTC helper unit tests (Milestone 3) — pure logic only, no browser.
 * Covers: STUN-only ICE config (no TURN ever), the "nexvora-control"
 * data-channel message validation, the live-session phase state
 * machine, poll backoff, and the grant model for publishing tracks.
 */
import { describe, it, expect } from "vitest";
import {
  CONTROL_CHANNEL_NAME,
  ICE_SERVERS,
  LIVE_PHASE_LABELS,
  LIVE_POLL_BASE_MS,
  LIVE_POLL_MAX_BACKOFF_MS,
  RTC_CONFIGURATION,
  canPlayRemoteAudio,
  canPublishTrack,
  iceConfigHasTurn,
  nextPollDelayMs,
  parseControlMessage,
  transitionLivePhase,
} from "../webrtc";

describe("ICE servers — STUN only, no TURN", () => {
  it("uses only the public Google STUN server", () => {
    expect(ICE_SERVERS).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
    expect(RTC_CONFIGURATION.iceServers).toEqual([...ICE_SERVERS]);
  });

  it("the shipped config contains no TURN URL", () => {
    expect(iceConfigHasTurn(RTC_CONFIGURATION)).toBe(false);
  });

  it("detects TURN urls when they appear", () => {
    expect(
      iceConfigHasTurn({ iceServers: [{ urls: "turn:example.com:3478" }] }),
    ).toBe(true);
    expect(
      iceConfigHasTurn({ iceServers: [{ urls: ["stun:x", "turns:example.com"] }] }),
    ).toBe(true);
    expect(iceConfigHasTurn({ iceServers: [{ urls: "stun:x" }] })).toBe(false);
  });

  it("the control channel is named nexvora-control", () => {
    expect(CONTROL_CHANNEL_NAME).toBe("nexvora-control");
  });
});

describe("control-channel message validation", () => {
  it("accepts a valid mute-state message", () => {
    expect(
      parseControlMessage({ type: "mute-state", micMuted: true, cameraOff: false }),
    ).toEqual({ type: "mute-state", micMuted: true, cameraOff: false });
  });

  it("accepts track-started / track-stopped / kill-switch", () => {
    expect(
      parseControlMessage({ type: "track-started", track: "screen", trackId: "abc" }),
    ).toEqual({ type: "track-started", track: "screen", trackId: "abc" });
    expect(parseControlMessage({ type: "track-stopped", track: "camera" })).toEqual({
      type: "track-stopped",
      track: "camera",
    });
    expect(
      parseControlMessage({ type: "track-stopped", track: "microphone", trackId: "t1" }),
    ).toEqual({ type: "track-stopped", track: "microphone", trackId: "t1" });
    expect(parseControlMessage({ type: "kill-switch" })).toEqual({ type: "kill-switch" });
  });

  it("rejects unknown types, malformed fields and non-objects", () => {
    expect(parseControlMessage({ type: "file-chunk", data: "x" })).toBeNull();
    expect(parseControlMessage({ type: "mute-state", micMuted: "yes" })).toBeNull();
    expect(parseControlMessage({ type: "mute-state", micMuted: true })).toBeNull();
    expect(parseControlMessage({ type: "track-started", track: "screen" })).toBeNull();
    expect(
      parseControlMessage({ type: "track-started", track: "screen", trackId: "" }),
    ).toBeNull();
    expect(
      parseControlMessage({ type: "track-started", track: "location", trackId: "x" }),
    ).toBeNull();
    expect(parseControlMessage({ type: "track-stopped", track: "screen", trackId: 7 })).toBeNull();
    expect(parseControlMessage(null)).toBeNull();
    expect(parseControlMessage("mute-state")).toBeNull();
    expect(parseControlMessage([])).toBeNull();
    expect(parseControlMessage({})).toBeNull();
  });
});

describe("live-session phase state machine", () => {
  it("follows the happy path idle -> starting -> waiting -> connecting -> live -> ended", () => {
    let phase = transitionLivePhase("idle", "begin");
    expect(phase).toBe("starting");
    phase = transitionLivePhase(phase, "started");
    expect(phase).toBe("waiting");
    phase = transitionLivePhase(phase, "offer-sent");
    expect(phase).toBe("connecting");
    phase = transitionLivePhase(phase, "connected");
    expect(phase).toBe("live");
    phase = transitionLivePhase(phase, "end");
    expect(phase).toBe("ended");
  });

  it("labels live honestly — only the live phase reads as Live", () => {
    expect(LIVE_PHASE_LABELS.live).toBe("Live");
    expect(LIVE_PHASE_LABELS.waiting).toContain("Waiting");
    expect(LIVE_PHASE_LABELS.failed).toBe("Connection failed");
  });

  it("a lost connection can recover, or fail", () => {
    expect(transitionLivePhase("live", "connection-lost")).toBe("reconnecting");
    expect(transitionLivePhase("reconnecting", "recovered")).toBe("live");
    expect(transitionLivePhase("reconnecting", "ice-failed")).toBe("failed");
    expect(transitionLivePhase("live", "ice-failed")).toBe("failed");
  });

  it("failed and peer-disconnected allow a manual retry, nothing auto-retries", () => {
    expect(transitionLivePhase("failed", "retry")).toBe("starting");
    expect(transitionLivePhase("peer-disconnected", "retry")).toBe("starting");
    // No event other than an explicit retry leaves failed.
    expect(transitionLivePhase("failed", "connected")).toBe("failed");
    expect(transitionLivePhase("failed", "offer-sent")).toBe("failed");
  });

  it("bye / peer-gone / revoked / session-ended tear down from any active phase", () => {
    for (const from of ["waiting", "connecting", "live", "reconnecting"] as const) {
      expect(transitionLivePhase(from, "bye")).toBe("peer-disconnected");
      expect(transitionLivePhase(from, "peer-gone")).toBe("peer-disconnected");
      expect(transitionLivePhase(from, "revoked")).toBe("revoked");
      expect(transitionLivePhase(from, "session-ended")).toBe("ended");
    }
  });

  it("ended and revoked are terminal", () => {
    for (const from of ["ended", "revoked"] as const) {
      for (const event of [
        "begin",
        "started",
        "connected",
        "retry",
        "end",
        "revoked",
      ] as const) {
        expect(transitionLivePhase(from, event)).toBe(from);
      }
    }
  });

  it("cannot skip ahead: idle cannot jump to live, waiting cannot jump to live without connecting", () => {
    expect(transitionLivePhase("idle", "connected")).toBe("idle");
    expect(transitionLivePhase("starting", "connected")).toBe("starting");
  });
});

describe("poll backoff — never a tight loop", () => {
  it("is 2s with no failures and doubles up to the 30s cap", () => {
    expect(LIVE_POLL_BASE_MS).toBe(2000);
    expect(LIVE_POLL_MAX_BACKOFF_MS).toBe(30_000);
    expect(nextPollDelayMs(0)).toBe(2000);
    expect(nextPollDelayMs(-1)).toBe(2000);
    expect(nextPollDelayMs(1)).toBe(4000);
    expect(nextPollDelayMs(2)).toBe(8000);
    expect(nextPollDelayMs(3)).toBe(16000);
    expect(nextPollDelayMs(4)).toBe(30000);
    expect(nextPollDelayMs(10)).toBe(30000);
  });
});

describe("grant model for publishing tracks", () => {
  it("the owner may publish any track; a participant only granted scopes", () => {
    expect(canPublishTrack("screen", [], true)).toBe(true);
    expect(canPublishTrack("camera", [], true)).toBe(true);
    expect(canPublishTrack("microphone", [], true)).toBe(true);
    expect(canPublishTrack("screen", ["screen"], false)).toBe(true);
    expect(canPublishTrack("screen", ["camera"], false)).toBe(false);
    expect(canPublishTrack("camera", ["camera", "microphone"], false)).toBe(true);
    expect(canPublishTrack("microphone", [], false)).toBe(false);
  });

  it("speaker playback is gated separately from the microphone", () => {
    expect(canPlayRemoteAudio(["microphone"], false)).toBe(false);
    expect(canPlayRemoteAudio(["speaker"], false)).toBe(true);
    expect(canPlayRemoteAudio([], true)).toBe(true);
    expect(canPlayRemoteAudio([], false)).toBe(false);
  });
});
