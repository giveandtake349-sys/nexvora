import { createHash } from "node:crypto";

/** A device is "online" when it has been seen in the last 5 minutes. */
export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

export function isDeviceOnline(
  lastSeenAt: string | Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - new Date(lastSeenAt).getTime() <= ONLINE_THRESHOLD_MS;
}

export interface ParsedUserAgent {
  browser: string;
  os: string;
  /** web | android | ios | desktop — Android is future work (Milestone 6). */
  platform: "web" | "android" | "ios" | "desktop";
}

/**
 * Best-effort User-Agent parsing. Only reports what the UA string actually
 * contains — never invents browser/OS details.
 */
export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  const ua = userAgent ?? "";
  let browser = "Unknown browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";

  let os = "Unknown OS";
  let platform: ParsedUserAgent["platform"] = "web";
  if (/Android/.test(ua)) {
    os = "Android";
    platform = "android";
  } else if (/iPhone|iPad|iOS/.test(ua)) {
    os = "iOS";
    platform = "ios";
  } else if (/Windows NT/.test(ua)) {
    os = "Windows";
    platform = "desktop";
  } else if (/Mac OS X/.test(ua)) {
    os = "macOS";
    platform = "desktop";
  } else if (/Linux/.test(ua)) {
    os = "Linux";
    platform = "desktop";
  }
  return { browser, os, platform };
}

/**
 * Stable per-owner device fingerprint from user-controlled inputs
 * (User-Agent + a browser-stored random id). This is an application-level
 * identity helper, not a tracking fingerprint — it only distinguishes
 * devices the user registered.
 */
export function computeDeviceFingerprint(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
