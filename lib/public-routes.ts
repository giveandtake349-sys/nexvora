/**
 * Routes the Neon Auth middleware lets through without a session.
 * Page routes (landing, auth pages) are listed individually; "/api"
 * covers every /api/* subpath (the SDK matches a route and its
 * slash-delimited subpaths).
 *
 * /api is public TO THE MIDDLEWARE ONLY. Every /api/* handler except
 * the Better Auth handler (/api/auth/*) starts with requireAuth()
 * (lib/api.ts) and returns a JSON 401 when signed out. If the
 * middleware redirected /api/* to /login instead, an expired session
 * mid-call would make the client follow a 307 to an HTML login page
 * instead of receiving the 401 its error handling expects — e.g. the
 * signaling poller would parse HTML as JSON, fail, and retry forever
 * instead of ending the call cleanly. So /api must be listed here.
 * Signed-out /dashboard/* pages still redirect to /login (they are
 * not in this list).
 *
 * Kept in this import-free module (instead of proxy.ts) so unit
 * tests can import it: proxy.ts pulls in the Neon Auth SDK, whose
 * next/headers import cannot load in the Vitest node environment.
 */
export const PUBLIC_ROUTES = [
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/api",
];
