/**
 * Neon configuration helpers (database + Managed Better Auth).
 *
 * The app must build and render even when no Neon project is configured
 * yet. In that state every auth / data surface shows a clear
 * "not configured" message and disables its forms — it never fakes a
 * login with localStorage or mock data.
 *
 * Server-only values (DATABASE_URL, NEON_AUTH_COOKIE_SECRET) are read
 * here but never exposed to client code: only the *message* constants
 * below are imported by client components.
 */

/**
 * Connection string the app connects with: the pooled URL when set,
 * otherwise the direct (unpooled) URL. Pooled is preferred for the
 * runtime Pool; direct exists so a deployment with only one string
 * still works.
 */
export function getDatabaseUrl(): string {
  return (
    (process.env.DATABASE_URL ?? "").trim() ||
    (process.env.DATABASE_URL_UNPOOLED ?? "").trim()
  );
}

export function getDatabaseUrlUnpooled(): string {
  return (process.env.DATABASE_URL_UNPOOLED ?? "").trim();
}

/** Pooled Neon connection string must be present for any data access. */
export function isDatabaseConfigured(): boolean {
  const url = getDatabaseUrl();
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export function getNeonAuthBaseUrl(): string {
  return (process.env.NEON_AUTH_BASE_URL ?? "").trim();
}

export function getNeonAuthCookieSecret(): string {
  return (process.env.NEON_AUTH_COOKIE_SECRET ?? "").trim();
}

/**
 * Managed Better Auth is configured when the branch Auth URL is set and
 * the cookie secret is long enough. The @neon/auth SDK throws at
 * startup when the secret is shorter than 32 characters, so the length
 * check here is what keeps the app booting while unconfigured.
 */
export function isAuthConfigured(): boolean {
  const baseUrl = getNeonAuthBaseUrl();
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) return false;
  return getNeonAuthCookieSecret().length >= 32;
}

export const DATABASE_NOT_CONFIGURED_MESSAGE =
  "Neon is not configured. Set DATABASE_URL and NEON_AUTH_BASE_URL + NEON_AUTH_COOKIE_SECRET in .env.local (see .env.example and README.md).";

export const AUTH_NOT_CONFIGURED_MESSAGE =
  "Neon Auth is not configured. Enable Managed Better Auth in the Neon Console (Better Auth page) and set NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET in .env.local (see README.md).";

/** Alias used by client components (ConfigNotice). */
export const NEON_AUTH_NOT_CONFIGURED_MESSAGE = AUTH_NOT_CONFIGURED_MESSAGE;
