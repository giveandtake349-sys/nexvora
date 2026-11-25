/**
 * In-memory fixed-window rate limiter.
 *
 * NOTE: this is per-server-instance only. It is correct for local dev and
 * single-instance deploys, and it is the layer that enforces the
 * "max 5 pairing attempts per user per 10 minutes" rule in Milestone 1.
 * For multi-instance production, move the counters into Postgres
 * (or Redis) — the API routes call checkRateLimit() through this one
 * function, so the swap is a single-file change. Do NOT present this
 * as distributed rate limiting: on Vercel Hobby each serverless
 * instance keeps its own counters, so a burst spread across instances
 * is only partially throttled.
 *
 * Per-route limits (Milestone 5 audit — every route has one):
 *
 *   Pairing (M1):  generate/redeem 5 per user per 10 min
 *   Devices (M1):  GET 120/min, POST 30/min, DELETE 10/min (per user)
 *   Connection requests (M1): GET 120/min, approve/reject 30/min (per user)
 *   Permissions (M1): GET 120/min, POST/DELETE 30/min (per user)
 *   Profile (M1):  PATCH 30/min (per user)
 *   Disconnect (M1): POST 30/min, disconnect-all 10/min (per user)
 *   Session start (M2): 10/min per user
 *   Signal send (M2): 120/min per user per session
 *   Signal poll (M2): 120/min per user per session — the client polls
 *     every ~2s (≈30/min per party), so 120/min leaves 4x headroom for
 *     reconnect bursts and two tabs; a poll storm above that is abuse.
 *   Heartbeat (M2): 60/min per user per session — the client beats
 *     every ~10s (≈6/min), so 60/min leaves 10x headroom.
 *   Session state (M2): 30/min per user per session
 *   File-transfer offers (M4): 10/min per user per session
 *   File-transfer status (M4): 30/min per user per session
 *   Session events (M4): 30/min per user per session
 *
 * Keys are per-user (and per-session where the route is session-scoped)
 * so one abusive user cannot throttle another user's sessions.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key);
  if (!existing || now >= existing.resetAt) {
    const bucket: Bucket = { count: 1, resetAt: now + windowMs };
    buckets.set(key, bucket);
    return { allowed: true, remaining: maxAttempts - 1, resetAt: bucket.resetAt };
  }
  existing.count += 1;
  return {
    allowed: existing.count <= maxAttempts,
    remaining: Math.max(0, maxAttempts - existing.count),
    resetAt: existing.resetAt,
  };
}

/** Test helper — clears all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}
