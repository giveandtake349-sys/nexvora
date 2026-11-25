/**
 * Role query-param validation unit tests — pure logic only, no live
 * database. Covers the M2 debug fix: a bogus ?role= used to silently
 * fall through to the owner view (?role=bogus returned owner grants /
 * owner requests). Now anything outside the allowed set is a 400.
 */
import { describe, it, expect } from "vitest";
import { parseRoleQueryParam } from "../http";

describe("parseRoleQueryParam", () => {
  it("accepts each allowed role", () => {
    expect(parseRoleQueryParam("owner", ["owner", "granted"])).toEqual({ ok: true, role: "owner" });
    expect(parseRoleQueryParam("granted", ["owner", "granted"])).toEqual({ ok: true, role: "granted" });
    expect(parseRoleQueryParam("requester", ["owner", "requester"])).toEqual({
      ok: true,
      role: "requester",
    });
  });

  it("defaults a missing role to owner", () => {
    expect(parseRoleQueryParam(null, ["owner", "granted"])).toEqual({ ok: true, role: "owner" });
    expect(parseRoleQueryParam(null, ["owner", "requester"])).toEqual({ ok: true, role: "owner" });
  });

  it("rejects a bogus role instead of falling through to owner", () => {
    expect(parseRoleQueryParam("bogus", ["owner", "granted"])).toEqual({
      ok: false,
      error: 'role must be one of: "owner", "granted"',
    });
    expect(parseRoleQueryParam("bogus", ["owner", "requester"])).toEqual({
      ok: false,
      error: 'role must be one of: "owner", "requester"',
    });
    expect(parseRoleQueryParam("granted", ["owner", "requester"])).toEqual({
      ok: false,
      error: 'role must be one of: "owner", "requester"',
    });
  });

  it("rejects empty and case-mismatched roles", () => {
    expect(parseRoleQueryParam("", ["owner", "granted"]).ok).toBe(false);
    expect(parseRoleQueryParam("Owner", ["owner", "granted"]).ok).toBe(false);
    expect(parseRoleQueryParam("OWNER", ["owner", "granted"]).ok).toBe(false);
  });
});
