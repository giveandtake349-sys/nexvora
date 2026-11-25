/**
 * In-memory fixed-window rate limiter for pairing endpoints.
 *
 * NOTE: this is per-server-instance only. It is correct for local dev and
 * single-instance deploys, and it is the layer that enforces the
 * "max 5 pairing attempts per user per 10 minutes" rule in Milestone 1.
 * For multi-instance production, move the counters into Postgres
 * (or Redis) — the API routes call checkRateLimit() through this one
 * function, so the swap is a single-file change.
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
