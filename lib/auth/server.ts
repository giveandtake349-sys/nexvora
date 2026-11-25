import { createNeonAuth } from "@neon/auth/next/server";
import {
  getNeonAuthBaseUrl,
  getNeonAuthCookieSecret,
  isAuthConfigured,
} from "@/lib/db/config";

/**
 * Managed Better Auth (Neon Auth) server instance — created lazily.
 *
 * The SDK throws at creation time when the cookie secret is shorter
 * than 32 characters, so the instance must NOT be built at module
 * import: the app has to boot (and render the honest "not configured"
 * state) when no Neon Auth project exists yet. Callers use getAuth()
 * and treat null as "auth not configured".
 */
export type NeonAuthInstance = ReturnType<typeof createNeonAuth>;

let cached: NeonAuthInstance | null = null;

export function getAuth(): NeonAuthInstance | null {
  if (cached) return cached;
  if (!isAuthConfigured()) return null;
  cached = createNeonAuth({
    baseUrl: getNeonAuthBaseUrl(),
    cookies: { secret: getNeonAuthCookieSecret() },
  });
  return cached;
}
