import { describe, expect, it } from "vitest";
import { isDeviceOnline, parseUserAgent, computeDeviceFingerprint } from "../device";

describe("device helpers", () => {
  it("is online only when seen in the last 5 minutes", () => {
    const now = new Date("2026-11-25T10:00:00Z");
    expect(isDeviceOnline("2026-11-25T09:56:00Z", now)).toBe(true);
    expect(isDeviceOnline("2026-11-25T09:54:59Z", now)).toBe(false);
    expect(isDeviceOnline(null, now)).toBe(false);
  });

  it("parses browser and OS from the User-Agent without inventing details", () => {
    const chrome = parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
    expect(chrome.browser).toBe("Chrome");
    expect(chrome.os).toBe("Windows");
    expect(chrome.platform).toBe("desktop");
    expect(parseUserAgent(null).browser).toBe("Unknown browser");
    expect(parseUserAgent("").os).toBe("Unknown OS");
  });

  it("produces a stable fingerprint for the same input", () => {
    expect(computeDeviceFingerprint("a")).toBe(computeDeviceFingerprint("a"));
    expect(computeDeviceFingerprint("a")).not.toBe(computeDeviceFingerprint("b"));
  });
});
