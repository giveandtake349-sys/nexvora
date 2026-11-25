import { describe, expect, it } from "vitest";
import {
  checkPairingUsability,
  generatePairingCode,
  hashPairingValue,
  isPairingExpired,
  PAIRING_CODE_TTL_MS,
} from "../pairing";

describe("pairing codes", () => {
  it("generates a 6-digit code with a 10-minute expiry", () => {
    const now = new Date("2026-11-25T10:00:00Z");
    const { code, expiresAt } = generatePairingCode(now);
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt.getTime() - now.getTime()).toBe(PAIRING_CODE_TTL_MS);
  });

  it("generates a different code each time (random secret)", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generatePairingCode().code));
    // 20 draws from 900k possibilities should not all collide.
    expect(codes.size).toBeGreaterThan(1);
  });

  it("hashes deterministically and never returns the plaintext as the hash", () => {
    const code = "123456";
    const hash = hashPairingValue(code);
    expect(hash).toBe(hashPairingValue(code));
    expect(hash).not.toContain(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("expires after the TTL", () => {
    const expiresAt = new Date("2026-11-25T10:10:00Z");
    expect(isPairingExpired(expiresAt, new Date("2026-11-25T10:09:59Z"))).toBe(false);
    expect(isPairingExpired(expiresAt, new Date("2026-11-25T10:10:00Z"))).toBe(true);
    expect(isPairingExpired(expiresAt, new Date("2026-11-25T10:11:00Z"))).toBe(true);
  });

  it("is usable only when active, unused and unexpired (single-use)", () => {
    const base = { expires_at: new Date("2026-11-25T10:10:00Z"), status: "active" as const };
    const now = new Date("2026-11-25T10:00:00Z");
    expect(checkPairingUsability({ ...base, used_at: null }, now)).toBe("usable");
    // After the first successful redeem the invitation is used — replay fails.
    expect(checkPairingUsability({ ...base, used_at: "2026-11-25T10:01:00Z" }, now)).toBe("used");
    expect(checkPairingUsability({ ...base, used_at: null }, new Date("2026-11-25T10:11:00Z"))).toBe("expired");
    expect(checkPairingUsability({ ...base, used_at: null, status: "revoked" }, now)).toBe("revoked");
    expect(checkPairingUsability(null, now)).toBe("expired");
  });
});
