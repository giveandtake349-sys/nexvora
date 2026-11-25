# NEXVORA — Debug Fix Report: Signed-Out API 307s + Role Validation

Two bugs found by the full debug sweep (parent agent, Nov 25 17:45). Both
fixed, verified locally, pushed. No schema change, no migration.

## BUG M1 (MAJOR): signed-out API calls returned 307 to /login, not JSON 401

**Root cause (verified in source):** `proxy.ts` ran the Neon Auth SDK
middleware over everything except publicRoutes `["/", "/login",
"/register", "/forgot-password", "/reset-password"]`. Route handlers
already return 401 (`lib/api.ts` `requireAuth()` → `jsonError("Not
authenticated", 401)`), but that code was unreachable for
unauthenticated requests — the middleware intercepted first.
Consequence: a session cookie expiring mid-call made the signaling
client follow the 307 to the login page, get 200 HTML, fail
`res.json()`, and retry forever (no max consecutive failures) instead
of ending the call cleanly.

**Fix:** `lib/public-routes.ts` (new, import-free module) exports
`PUBLIC_ROUTES`, now including `"/api"`. The SDK matches a route and
its slash-delimited subpaths, so `"/api"` covers all `/api/*`.
`proxy.ts` uses that list. `/api` is public TO THE MIDDLEWARE ONLY:
every `/api/*` handler except the Better Auth handler
(`/api/auth/*`) still starts with `requireAuth()` — verified by grep,
all other `app/api/**/route.ts` files call it — so auth behavior is
unchanged; only the redirect is gone. `/api/auth/*` keeps working
(the SDK's default skip routes already cover it; signed-out GET
`/api/auth/get-session` still returns 200 null, verified locally).
Signed-out `/dashboard/*` pages still 307 to `/login` (verified
locally).

**Why the constant lives in `lib/public-routes.ts`, not `proxy.ts`:**
`proxy.ts` imports the Neon Auth SDK, whose `next/headers` import
cannot load in the Vitest node environment — the first proxy unit
test failed to even collect. The import-free module keeps the list
unit-testable; `proxy.ts` imports it.

## BUG M2 (MINOR): bogus `?role=` silently treated as owner

`GET /api/permissions?role=bogus` returned owner grants;
`GET /api/connection-requests?role=bogus` returned owner requests
(pattern: `role === "granted" ? … : "owner_id"`).

**Fix:** `parseRoleQueryParam()` in `lib/http.ts` (re-exported from
`lib/api.ts`): absent defaults to `"owner"`; anything outside the
allowed set → 400 `role must be one of: "owner", "granted"` /
`"owner", "requester"`. Both GET handlers validate right after
`requireAuth()`, before the rate limit. Grep for `role ===` confirms
these were the only two routes with the pattern.

## Verification (local, Nov 25 ~17:50)

- `npm test`: **149 passed, 6 skipped** (was 142 passed; +7 new:
  4 role-validation + 3 proxy-routes). Lint clean. `npm run build`
  passes.
- Dev server + curl (signed out, routes warm):
  - `GET /api/devices` → **401 `{"error":"Not authenticated"}`**
    (was 307). `POST /api/sessions/:id/signal` → 401.
  - `GET /api/auth/get-session` → 200 (unchanged).
  - `GET /dashboard` → 307 to `/login` (unchanged).
  - `GET /api/permissions?role=bogus` → 401 (auth runs before role
    validation, and — critically — no 307).
  - Note: the very first `/api/devices` curl returned empty (cold
    route compile in dev mode exceeded the 25s curl timeout); the
    warm retry returned 401 instantly. Not a bug.
- **Not verifiable from this VM:** the authenticated
  `?role=bogus` → 400 path (no session can be minted locally — the
  VM cannot reach Neon Auth). The validator is unit-tested; the live
  400 needs checking on the deployed URL after this push.

## Files changed

- `proxy.ts` — uses `PUBLIC_ROUTES` from `lib/public-routes.ts`.
- `lib/public-routes.ts` — new; the public-routes list incl. `"/api"`.
- `lib/http.ts` — `parseRoleQueryParam()`.
- `lib/api.ts` — re-exports `parseRoleQueryParam`.
- `app/api/permissions/route.ts` — role validation in GET.
- `app/api/connection-requests/route.ts` — role validation in GET.
- `lib/__tests__/role-validation.test.ts` — new (4 tests).
- `lib/__tests__/proxy.test.ts` — new (3 tests).
- `DEBUG-FIX-REPORT.md` — this file.

## Still needs a live check (parent: after Vercel deploys this push)

1. Signed-out `GET https://nexvora-seven.vercel.app/api/devices` →
   401 JSON, not a 307.
2. Signed-in `GET /api/permissions?role=bogus` → 400 and
   `GET /api/connection-requests?role=bogus` → 400.
3. Signed-out `GET /api/auth/get-session` → 200 null (regression
   check) and signed-out `/dashboard` → redirect to `/login`.
4. Happy path unchanged: pairing/approve/session/signaling still
   work (the live two-browser media test running during this push
   exercises exactly that).
