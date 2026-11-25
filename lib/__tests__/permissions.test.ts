import { describe, expect, it } from "vitest";
import {
  checkGrantValidity,
  defaultGrantExpiry,
  isGrantValid,
  isPermissionScope,
  PERMISSION_SCOPES,
  SCOPE_MILESTONE,
  splitScopesByValidity,
  DEFAULT_GRANT_DAYS,
  type DevicePermissionGrant,
} from "../permissions";

const now = new Date("2026-11-25T10:00:00Z");
const deviceId = "device-1";

function grant(overrides: Partial<DevicePermissionGrant> = {}): DevicePermissionGrant {
  return {
    device_id: deviceId,
    scope: "screen",
    is_revoked: false,
    revoked_at: null,
    expires_at: new Date("2026-12-25T10:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("grant validity (server-side check)", () => {
  it("is valid for a live, unexpired grant on the right device", () => {
    expect(checkGrantValidity(grant(), deviceId, now)).toBe("valid");
    expect(isGrantValid(grant(), deviceId, now)).toBe(true);
  });

  it("is not_found when there is no grant", () => {
    expect(checkGrantValidity(null, deviceId, now)).toBe("not_found");
    expect(checkGrantValidity(undefined, deviceId, now)).toBe("not_found");
  });

  it("is revoked after the owner revokes it — even before expiry", () => {
    expect(checkGrantValidity(grant({ is_revoked: true, revoked_at: now.toISOString() }), deviceId, now)).toBe("revoked");
    expect(checkGrantValidity(grant({ revoked_at: now.toISOString() }), deviceId, now)).toBe("revoked");
  });

  it("is expired after expires_at", () => {
    expect(
      checkGrantValidity(grant({ expires_at: new Date("2026-11-25T09:59:59Z").toISOString() }), deviceId, now),
    ).toBe("expired");
  });

  it("is device_mismatch when the device identity changed", () => {
    expect(checkGrantValidity(grant(), "device-2", now)).toBe("device_mismatch");
  });

  it("grants never expire when expires_at is null (explicit no-expiry choice)", () => {
    expect(checkGrantValidity(grant({ expires_at: null }), deviceId, new Date("2030-01-01T00:00:00Z"))).toBe("valid");
  });

  it("defaults to a 30-day expiry", () => {
    const from = new Date("2026-11-25T10:00:00Z");
    const expiry = defaultGrantExpiry(from);
    expect(expiry.getTime() - from.getTime()).toBe(DEFAULT_GRANT_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe("reconnect reuse — only new scopes need approval", () => {
  it("reuses valid grants and asks only for missing/expired ones", () => {
    const grants = [
      grant({ scope: "screen" }),
      grant({ scope: "camera", expires_at: new Date("2026-11-01T00:00:00Z").toISOString() }),
    ];
    const result = splitScopesByValidity(["screen", "camera", "microphone"], grants, deviceId, now);
    expect(result.alreadyGranted).toEqual(["screen"]);
    expect(result.needsApproval).toEqual(["camera", "microphone"]);
  });

  it("asks for everything when there are no grants", () => {
    const result = splitScopesByValidity(["screen"], [], deviceId, now);
    expect(result.alreadyGranted).toEqual([]);
    expect(result.needsApproval).toEqual(["screen"]);
  });
});

describe("notifications scope (9th scope, Milestone 2)", () => {
  it("is a valid permission scope alongside the original 8", () => {
    expect(PERMISSION_SCOPES).toHaveLength(9);
    expect(isPermissionScope("notifications")).toBe(true);
    // The original 8 are untouched.
    for (const scope of [
      "screen",
      "camera",
      "microphone",
      "speaker",
      "file_transfer",
      "location",
      "remote_interaction",
      "device_info",
    ]) {
      expect(isPermissionScope(scope)).toBe(true);
    }
  });

  it("is wired through Milestone 4 like the other sharing scopes", () => {
    expect(SCOPE_MILESTONE.notifications).toBe(4);
  });

  it("a notifications grant validates like any other grant", () => {
    expect(checkGrantValidity(grant({ scope: "notifications" }), deviceId, now)).toBe(
      "valid",
    );
  });
});
