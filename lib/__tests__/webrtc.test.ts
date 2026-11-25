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
  NegotiationGate,
  canPlayRemoteAudio,
  canPublishTrack,
  canShareLocation,
  canShareNotifications,
  canTransferFiles,
  canUseRemoteInteraction,
  iceConfigHasTurn,
  nextPollDelayMs,
  parseControlMessage,
  transitionLivePhase,
  type NegotiationOutcome,
} from "../webrtc";
import { FILE_CHANNEL_NAME } from "../file-transfer";

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

  it("accepts Milestone 4 file-transfer metadata (offer/approve/reject/cancel/complete)", () => {
    expect(
      parseControlMessage({
        type: "file-offer",
        transferId: "t1",
        fileName: "a.pdf",
        fileSizeBytes: 1234,
      }),
    ).toEqual({ type: "file-offer", transferId: "t1", fileName: "a.pdf", fileSizeBytes: 1234 });
    expect(parseControlMessage({ type: "file-approve", transferId: "t1" })).toEqual({
      type: "file-approve",
      transferId: "t1",
    });
    expect(parseControlMessage({ type: "file-reject", transferId: "t1" })).toEqual({
      type: "file-reject",
      transferId: "t1",
    });
    expect(parseControlMessage({ type: "file-cancel", transferId: "t1" })).toEqual({
      type: "file-cancel",
      transferId: "t1",
    });
    expect(parseControlMessage({ type: "file-complete", transferId: "t1" })).toEqual({
      type: "file-complete",
      transferId: "t1",
    });
    // The 50 MB limit is enforced here too — an oversize offer is dropped.
    expect(
      parseControlMessage({
        type: "file-offer",
        transferId: "t1",
        fileName: "a.pdf",
        fileSizeBytes: 50 * 1024 * 1024 + 1,
      }),
    ).toBeNull();
    expect(
      parseControlMessage({ type: "file-offer", transferId: "t1", fileName: "../x", fileSizeBytes: 1 }),
    ).toBeNull(); // the receiver never trusts a client-supplied path
    expect(parseControlMessage({ type: "file-offer", transferId: "", fileName: "a", fileSizeBytes: 1 })).toBeNull();
    expect(parseControlMessage({ type: "file-approve" })).toBeNull();
  });

  it("accepts Milestone 4 location messages and rejects impossible fixes", () => {
    expect(parseControlMessage({ type: "location-start" })).toEqual({ type: "location-start" });
    expect(parseControlMessage({ type: "location-stop" })).toEqual({ type: "location-stop" });
    expect(
      parseControlMessage({
        type: "location-update",
        latitude: 24.7,
        longitude: 46.6,
        accuracy: 10,
        timestamp: 1700000000000,
      }),
    ).toEqual({
      type: "location-update",
      latitude: 24.7,
      longitude: 46.6,
      accuracy: 10,
      timestamp: 1700000000000,
    });
    expect(
      parseControlMessage({ type: "location-update", latitude: 91, longitude: 0, timestamp: 1 }),
    ).toBeNull();
    expect(parseControlMessage({ type: "location-update", latitude: 0, longitude: 0 })).toBeNull();
  });

  it("accepts Milestone 4 interaction messages and rejects out-of-range pointers", () => {
    expect(parseControlMessage({ type: "interaction-start" })).toEqual({
      type: "interaction-start",
    });
    expect(parseControlMessage({ type: "interaction-stop" })).toEqual({
      type: "interaction-stop",
    });
    expect(
      parseControlMessage({ type: "interaction-pointer", kind: "click", x: 0.5, y: 0.5 }),
    ).toEqual({ type: "interaction-pointer", kind: "click", x: 0.5, y: 0.5 });
    expect(
      parseControlMessage({ type: "interaction-pointer", kind: "move", x: 1.2, y: 0.5 }),
    ).toBeNull();
    expect(parseControlMessage({ type: "interaction-key", key: "Enter" })).toEqual({
      type: "interaction-key",
      key: "Enter",
    });
    expect(
      parseControlMessage({ type: "interaction-key", key: "x".repeat(33) }),
    ).toBeNull();
  });

  it("accepts Milestone 4 notification messages and rejects malformed ones", () => {
    expect(parseControlMessage({ type: "notification-sharing-start" })).toEqual({
      type: "notification-sharing-start",
    });
    expect(parseControlMessage({ type: "notification-sharing-stop" })).toEqual({
      type: "notification-sharing-stop",
    });
    expect(
      parseControlMessage({
        type: "notification",
        app: "Messenger",
        title: "Ayesha",
        body: "Hi",
        receivedAt: 1700000000000,
      }),
    ).toEqual({
      type: "notification",
      app: "Messenger",
      title: "Ayesha",
      body: "Hi",
      receivedAt: 1700000000000,
    });
    expect(
      parseControlMessage({
        type: "notification",
        app: "Messenger",
        title: "",
        body: "Hi",
        receivedAt: 1700000000000,
      }),
    ).toBeNull();
    expect(
      parseControlMessage({
        type: "notification",
        app: "Messenger",
        title: "T",
        body: "x".repeat(1001),
        receivedAt: 1700000000000,
      }),
    ).toBeNull();
  });

  it("the file channel is a separate, named channel from the control channel", () => {
    expect(FILE_CHANNEL_NAME).toBe("nexvora-file");
    expect(FILE_CHANNEL_NAME).not.toBe(CONTROL_CHANNEL_NAME);
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

  it("Milestone 4 features are gated on their own scope (owner exempt)", () => {
    for (const fn of [canTransferFiles, canShareLocation, canUseRemoteInteraction, canShareNotifications]) {
      expect(fn([], true)).toBe(true);
      expect(fn([], false)).toBe(false);
    }
    expect(canTransferFiles(["file_transfer"], false)).toBe(true);
    expect(canTransferFiles(["location"], false)).toBe(false);
    expect(canShareLocation(["location"], false)).toBe(true);
    expect(canUseRemoteInteraction(["remote_interaction"], false)).toBe(true);
    expect(canShareNotifications(["notifications"], false)).toBe(true);
    expect(canShareNotifications(["file_transfer"], false)).toBe(false);
  });
});

describe("offer negotiation gate — one offer in flight, none lost", () => {
  // Regression test for the live bug of Nov 25 2026: onnegotiationneeded
  // (fired by createDataChannel at setup) raced boot()'s explicit
  // createOffer, so two createOffer() calls ran concurrently while
  // signalingState was still "stable" — the second setLocalDescription
  // threw "The order of m-lines in subsequent offer doesn't match
  // order from previous offer/answer" and the session never went live.
  // The gate serialises attempts; a request that arrives while one is
  // running is remembered and retried — never dropped, never parallel.
  it("serialises concurrent requests: attempts never overlap, requests coalesce into one re-run", async () => {
    const gate = new NegotiationGate();
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const attempt = async (): Promise<NegotiationOutcome> => {
      calls++;
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return "negotiated";
    };
    await Promise.all([gate.request(attempt), gate.request(attempt), gate.request(attempt)]);
    expect(maxRunning).toBe(1);
    // Three requests, two runs: the first runs immediately, the two
    // concurrent ones coalesce into a single re-run (the re-run's
    // offer reflects the current peer-connection state, which already
    // includes every change both requests stood for).
    expect(calls).toBe(2);
  });

  it("a not-stable attempt is remembered and retried by drain()", async () => {
    const gate = new NegotiationGate();
    let calls = 0;
    const attempt = async (): Promise<NegotiationOutcome> => {
      calls++;
      return calls === 1 ? "not-stable" : "negotiated";
    };
    await gate.request(attempt);
    expect(calls).toBe(1);
    gate.drain(attempt);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
  });

  it("drain() is a no-op when nothing is pending", async () => {
    const gate = new NegotiationGate();
    let calls = 0;
    const attempt = async (): Promise<NegotiationOutcome> => {
      calls++;
      return "negotiated";
    };
    await gate.request(attempt);
    gate.drain(attempt);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
  });

  it("a failed attempt does not loop on its own", async () => {
    const gate = new NegotiationGate();
    let calls = 0;
    const attempt = async (): Promise<NegotiationOutcome> => {
      calls++;
      return "failed";
    };
    await gate.request(attempt);
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
  });

  it("reset() forgets a pending request (teardown / retry)", async () => {
    const gate = new NegotiationGate();
    let calls = 0;
    const slow = async (): Promise<NegotiationOutcome> => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return "negotiated";
    };
    const first = gate.request(slow);
    await gate.request(slow); // queued as pending while the first runs
    gate.reset();
    await first;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1); // the pending re-run was forgotten by reset
  });
});
