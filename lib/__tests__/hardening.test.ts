/**
 * Milestone 5 hardening unit tests — pure logic only, no live database.
 * Covers: UUID validation (malformed ids must never reach Postgres,
 * where they would raise 22P02 and surface as a 500), the capped JSON
 * body reader (413 over the cap, 400 for malformed JSON, never an
 * unbounded parse), the kill-switch security-audit decision, and the
 * rate-limit headroom for the 2s signaling poll and the 10s heartbeat.
 */
import { describe, it, expect } from "vitest";
import {
  isUuid,
  readJsonBody,
  MAX_SIGNAL_RAW_BODY_BYTES,
  MAX_SMALL_JSON_BODY_BYTES,
} from "../http";
import { shouldLogSecurityEvent } from "../live-features";
import { checkRateLimit, resetRateLimits } from "../rate-limit";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";

describe("UUID validation (isUuid)", () => {
  it("accepts a well-formed uuid (any case)", () => {
    expect(isUuid(VALID_UUID)).toBe(true);
    expect(isUuid(VALID_UUID.toUpperCase())).toBe(true);
  });

  it("rejects the malformed ids that used to reach Postgres as 500s", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("123")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("00000000-0000-0000-0000-000000000001; DROP TABLE devices;")).toBe(false);
    expect(isUuid("00000000000040008000000000000001")).toBe(false); // no dashes
    expect(isUuid("zzzzzzzz-0000-4000-8000-000000000001")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe("capped JSON body reader (readJsonBody)", () => {
  function postRequest(body: string, contentLength?: number): Request {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (contentLength !== undefined) headers["content-length"] = String(contentLength);
    return new Request("http://localhost/api/test", { method: "POST", headers, body });
  }

  it("parses a valid small JSON object", async () => {
    const res = await readJsonBody(postRequest('{"state":"live"}'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body).toEqual({ state: "live" });
  });

  it("returns 400 for malformed JSON instead of crashing", async () => {
    const res = await readJsonBody(postRequest("{not json"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it("returns 400 for an empty body", async () => {
    const res = await readJsonBody(postRequest(""));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it("returns 413 when Content-Length exceeds the cap, without reading the body", async () => {
    const res = await readJsonBody(
      postRequest('{"x":1}', MAX_SMALL_JSON_BODY_BYTES + 1),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
  });

  it("returns 413 when the actual body exceeds the cap with no Content-Length", async () => {
    const big = JSON.stringify({ blob: "x".repeat(MAX_SMALL_JSON_BODY_BYTES) });
    const res = await readJsonBody(postRequest(big));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
  });

  it("accepts a signaling body up to the 128 KiB raw cap (64 KiB payload + wrapper)", async () => {
    const payload = JSON.stringify({ payload: { blob: "x".repeat(60 * 1024) } });
    expect(new TextEncoder().encode(payload).length).toBeLessThan(MAX_SIGNAL_RAW_BODY_BYTES);
    const res = await readJsonBody(postRequest(payload), MAX_SIGNAL_RAW_BODY_BYTES);
    expect(res.ok).toBe(true);
  });

  it("rejects a signaling body over the 128 KiB raw cap with 413", async () => {
    const payload = JSON.stringify({ payload: { blob: "x".repeat(200 * 1024) } });
    const res = await readJsonBody(postRequest(payload), MAX_SIGNAL_RAW_BODY_BYTES);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
  });
});

describe("kill-switch audit decision (shouldLogSecurityEvent)", () => {
  it("logs every sharing start to security_events", () => {
    expect(shouldLogSecurityEvent("location.sharing_started")).toBe(true);
    expect(shouldLogSecurityEvent("notifications.sharing_started")).toBe(true);
    expect(shouldLogSecurityEvent("interaction.started")).toBe(true);
  });

  it("logs the interaction kill-switch to security_events (Milestone 5 fix)", () => {
    expect(shouldLogSecurityEvent("interaction.killed")).toBe(true);
  });

  it("keeps stops session-only — the start already covers the window", () => {
    expect(shouldLogSecurityEvent("location.sharing_stopped")).toBe(false);
    expect(shouldLogSecurityEvent("notifications.sharing_stopped")).toBe(false);
    expect(shouldLogSecurityEvent("interaction.stopped")).toBe(false);
  });
});

describe("rate-limit headroom for polling clients", () => {
  it("the 120/min signal-poll limit allows a full minute of 2s polling with 4x headroom", () => {
    resetRateLimits();
    const key = "poll-headroom";
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      if (checkRateLimit(key, 120, 60_000, 1000).allowed) allowed++;
    }
    expect(allowed).toBe(30);
    // The 121st call inside the same window is the first that blocks.
    for (let i = 0; i < 90; i++) checkRateLimit(key, 120, 60_000, 1000);
    expect(checkRateLimit(key, 120, 60_000, 1000).allowed).toBe(false);
  });

  it("the 60/min heartbeat limit allows a full minute of 10s heartbeats with 10x headroom", () => {
    resetRateLimits();
    const key = "heartbeat-headroom";
    let allowed = 0;
    for (let i = 0; i < 6; i++) {
      if (checkRateLimit(key, 60, 60_000, 1000).allowed) allowed++;
    }
    expect(allowed).toBe(6);
  });

  it("limits are per-user-per-session, so one session cannot throttle another", () => {
    resetRateLimits();
    for (let i = 0; i < 120; i++) checkRateLimit("session-a", 120, 60_000, 1000);
    expect(checkRateLimit("session-a", 120, 60_000, 1000).allowed).toBe(false);
    expect(checkRateLimit("session-b", 120, 60_000, 1000).allowed).toBe(true);
  });
});
