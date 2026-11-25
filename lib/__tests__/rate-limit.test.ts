import { describe, expect, it, beforeEach } from "vitest";
import { checkRateLimit, resetRateLimits } from "../rate-limit";

describe("pairing rate limit", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the max, then blocks", () => {
    const key = "pairing:redeem:user-1";
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key, 5, 10 * 60 * 1000, 1000).allowed).toBe(true);
    }
    const blocked = checkRateLimit(key, 5, 10 * 60 * 1000, 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("resets after the window passes", () => {
    const key = "pairing:generate:user-2";
    for (let i = 0; i < 5; i++) checkRateLimit(key, 5, 10 * 60 * 1000, 1000);
    expect(checkRateLimit(key, 5, 10 * 60 * 1000, 1000).allowed).toBe(false);
    expect(checkRateLimit(key, 5, 10 * 60 * 1000, 10 * 60 * 1000 + 1001).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 5; i++) checkRateLimit("a", 5, 600000, 1000);
    expect(checkRateLimit("b", 5, 600000, 1000).allowed).toBe(true);
  });
});
