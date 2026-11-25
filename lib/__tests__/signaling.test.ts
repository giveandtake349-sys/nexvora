/**
 * Signaling helper unit tests — pure logic only, no live database.
 * Covers: message-kind validation, 64 KiB payload limit, the
 * signaling-state transition map, heartbeat staleness, poll `after`
 * parsing, and per-party heartbeat / recipient resolution.
 */
import { describe, it, expect } from "vitest";
import {
  HEARTBEAT_STALE_AFTER_MS,
  MAX_SIGNALING_PAYLOAD_BYTES,
  SIGNALING_MESSAGE_KINDS,
  canTransitionSignalingState,
  heartbeatColumnFor,
  isHeartbeatStale,
  isPayloadWithinLimit,
  isSignalingMessageKind,
  otherPartyId,
  parseSignalAfter,
  peerHeartbeat,
  signalingPayloadSizeBytes,
  validateSignalBody,
} from "../signaling";
import type { RemoteSession } from "../types";

function fakeSession(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    connection_request_id: null,
    device_id: "00000000-0000-0000-0000-000000000002",
    owner_id: "owner-1",
    participant_user_id: "participant-1",
    status: "active",
    started_at: new Date().toISOString(),
    ended_at: null,
    signaling_state: "created",
    owner_last_heartbeat_at: null,
    participant_last_heartbeat_at: null,
    ...overrides,
  };
}

describe("signaling message kinds", () => {
  it("accepts the five known kinds", () => {
    for (const kind of SIGNALING_MESSAGE_KINDS) {
      expect(isSignalingMessageKind(kind)).toBe(true);
    }
    expect(SIGNALING_MESSAGE_KINDS).toEqual([
      "offer",
      "answer",
      "ice-candidate",
      "bye",
      "session-state",
    ]);
  });

  it("rejects unknown kinds and non-strings", () => {
    expect(isSignalingMessageKind("sdp")).toBe(false);
    expect(isSignalingMessageKind("OFFER")).toBe(false);
    expect(isSignalingMessageKind("")).toBe(false);
    expect(isSignalingMessageKind(null)).toBe(false);
    expect(isSignalingMessageKind(42)).toBe(false);
  });
});

describe("payload size limit (64 KiB)", () => {
  it("measures UTF-8 bytes, not characters", () => {
    // "é" is 2 bytes in UTF-8 but 1 JS char.
    expect(signalingPayloadSizeBytes({ s: "é" })).toBe(
      new TextEncoder().encode(JSON.stringify({ s: "é" })).length,
    );
    expect(MAX_SIGNALING_PAYLOAD_BYTES).toBe(64 * 1024);
  });

  it("accepts a small SDP-like payload", () => {
    expect(
      isPayloadWithinLimit({ type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1" }),
    ).toBe(true);
  });

  it("rejects a payload over 64 KiB", () => {
    expect(isPayloadWithinLimit({ blob: "x".repeat(70 * 1024) })).toBe(false);
  });

  it("validateSignalBody: 400 for a bad kind, 413 for oversize, 400 for a non-object payload", () => {
    expect(validateSignalBody({ kind: "sdp", payload: {} })).toEqual({
      ok: false,
      error: expect.stringContaining("kind must be one of"),
      status: 400,
    });
    expect(validateSignalBody({ kind: "offer", payload: "not-an-object" })).toEqual({
      ok: false,
      error: "payload must be a JSON object",
      status: 400,
    });
    expect(
      validateSignalBody({ kind: "offer", payload: { blob: "x".repeat(70 * 1024) } }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("exceeds the 64 KiB limit"),
      status: 413,
    });
    expect(validateSignalBody(null)).toEqual({
      ok: false,
      error: "Request body must be a JSON object",
      status: 400,
    });
  });

  it("validateSignalBody: accepts a valid offer", () => {
    const res = validateSignalBody({ kind: "offer", payload: { type: "offer", sdp: "v=0" } });
    expect(res).toEqual({ ok: true, kind: "offer", payload: { type: "offer", sdp: "v=0" } });
  });
});

describe("signaling-state transitions", () => {
  it("allows the happy path created -> connecting -> live -> ended", () => {
    expect(canTransitionSignalingState("created", "connecting")).toBe(true);
    expect(canTransitionSignalingState("connecting", "live")).toBe(true);
    expect(canTransitionSignalingState("live", "ended")).toBe(true);
  });

  it("allows ending or revoking from any non-terminal state", () => {
    expect(canTransitionSignalingState("created", "ended")).toBe(true);
    expect(canTransitionSignalingState("connecting", "revoked")).toBe(true);
    expect(canTransitionSignalingState("live", "revoked")).toBe(true);
  });

  it("forbids skipping ahead and going backwards", () => {
    expect(canTransitionSignalingState("created", "live")).toBe(false);
    expect(canTransitionSignalingState("live", "connecting")).toBe(false);
    expect(canTransitionSignalingState("connecting", "created")).toBe(false);
    expect(canTransitionSignalingState("live", "created")).toBe(false);
  });

  it("ended and revoked are terminal", () => {
    for (const from of ["ended", "revoked"] as const) {
      for (const to of ["created", "connecting", "live", "ended", "revoked"] as const) {
        expect(canTransitionSignalingState(from, to)).toBe(false);
      }
    }
  });
});

describe("heartbeat staleness (30s threshold)", () => {
  it("is 30 seconds", () => {
    expect(HEARTBEAT_STALE_AFTER_MS).toBe(30_000);
  });

  it("a missing heartbeat is stale", () => {
    expect(isHeartbeatStale(null)).toBe(true);
    expect(isHeartbeatStale("not-a-date")).toBe(true);
  });

  it("a heartbeat 10s ago is fresh, 31s ago is stale", () => {
    const now = new Date("2026-11-25T12:00:30.000Z");
    expect(isHeartbeatStale("2026-11-25T12:00:20.000Z", now)).toBe(false);
    expect(isHeartbeatStale("2026-11-25T11:59:59.000Z", now)).toBe(true);
  });
});

describe("poll after parsing", () => {
  it("defaults to 0 when absent or empty", () => {
    expect(parseSignalAfter(null)).toEqual({ ok: true, after: 0 });
    expect(parseSignalAfter("")).toEqual({ ok: true, after: 0 });
  });

  it("accepts non-negative integers", () => {
    expect(parseSignalAfter("0")).toEqual({ ok: true, after: 0 });
    expect(parseSignalAfter("12345")).toEqual({ ok: true, after: 12345 });
  });

  it("rejects negative, fractional and non-numeric values", () => {
    expect(parseSignalAfter("-1").ok).toBe(false);
    expect(parseSignalAfter("1.5").ok).toBe(false);
    expect(parseSignalAfter("abc").ok).toBe(false);
  });
});

describe("per-party heartbeats and recipient resolution", () => {
  it("each party has its own heartbeat column", () => {
    const session = fakeSession();
    expect(heartbeatColumnFor(session, "owner-1")).toBe("owner_last_heartbeat_at");
    expect(heartbeatColumnFor(session, "participant-1")).toBe(
      "participant_last_heartbeat_at",
    );
    expect(heartbeatColumnFor(session, "stranger")).toBeNull();
  });

  it("the recipient is always the other party, never the caller", () => {
    const session = fakeSession();
    expect(otherPartyId(session, "owner-1")).toBe("participant-1");
    expect(otherPartyId(session, "participant-1")).toBe("owner-1");
    expect(otherPartyId(session, "stranger")).toBeNull();
  });

  it("peer liveness reads the PEER's column, not the caller's", () => {
    const now = new Date("2026-11-25T12:00:30.000Z");
    const session = fakeSession({
      owner_last_heartbeat_at: "2026-11-25T12:00:25.000Z", // fresh
      participant_last_heartbeat_at: "2026-11-25T11:59:00.000Z", // stale
    });
    // Owner asking: peer is the participant (stale).
    expect(peerHeartbeat(session, "owner-1", now)).toEqual({
      peer_last_seen_at: "2026-11-25T11:59:00.000Z",
      peer_alive: false,
    });
    // Participant asking: peer is the owner (fresh).
    expect(peerHeartbeat(session, "participant-1", now)).toEqual({
      peer_last_seen_at: "2026-11-25T12:00:25.000Z",
      peer_alive: true,
    });
    // Stranger: no peer.
    expect(peerHeartbeat(session, "stranger", now)).toEqual({
      peer_last_seen_at: null,
      peer_alive: false,
    });
  });
});
