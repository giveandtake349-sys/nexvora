import { NextResponse } from "next/server";

/**
 * Milestone 5 hardening helpers — pure request hygiene with no auth
 * or database imports, so unit tests can import this module directly.
 * (Kept free of lib/api.ts on purpose: api.ts pulls in the Neon Auth
 * session, which cannot load in the Vitest node environment.)
 *
 * - UUID validation: every id the database stores as uuid (sessions,
 *   devices, transfers, connection requests, permissions) must be
 *   checked BEFORE it reaches a query. Postgres raises error 22P02
 *   (invalid text representation) for a malformed uuid literal, and
 *   an uncaught query error becomes a 500. A malformed id is answered
 *   with the same 404 as "not found" — no existence leak, never a 500.
 * - Capped JSON bodies: `request.json()` reads the whole body before
 *   any limit can apply, so the semantic caps in lib/signaling.ts
 *   (64 KiB payload) and lib/live-features.ts (2 KiB details) were
 *   only enforced AFTER a potentially huge body had already been
 *   parsed into memory. These caps are checked first — via
 *   Content-Length when present, and again on the raw text — before
 *   JSON.parse runs.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Local error shape — identical to lib/api.ts `jsonError`. */
function httpError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** 404 for a malformed or unknown id — same shape as every other
 *  "not found" in this codebase. */
export function invalidIdResponse() {
  return httpError("Not found", 404);
}

/**
 * Validate a `?role=` list parameter (permissions, connection
 * requests). A bogus role must never silently fall through to the
 * owner view — that used to happen: any value other than the
 * "granted"/"requester" branch was treated as "owner", so
 * ?role=bogus returned owner data. Absent defaults to "owner".
 */
export function parseRoleQueryParam(
  raw: string | null,
  allowedRoles: readonly string[],
): { ok: true; role: string } | { ok: false; error: string } {
  const role = raw ?? "owner";
  if (!allowedRoles.includes(role)) {
    return {
      ok: false,
      error: `role must be one of: ${allowedRoles.map((r) => `"${r}"`).join(", ")}`,
    };
  }
  return { ok: true, role };
}

/** Raw JSON-body size caps. */
export const MAX_SIGNAL_RAW_BODY_BYTES = 128 * 1024; // 64 KiB payload + wrapper
export const MAX_SMALL_JSON_BODY_BYTES = 16 * 1024; // state / events / transfers / M1 writes

export type JsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse };

/**
 * Read a JSON request body with a hard size cap. Returns a 413 when
 * the body exceeds `maxBytes` and a 400 when it is not valid JSON
 * (or not a JSON value at all). Callers then run their existing
 * semantic validators on `body`.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_SMALL_JSON_BODY_BYTES,
): Promise<JsonBodyResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return {
        ok: false,
        response: httpError(
          `Request body exceeds the ${Math.round(maxBytes / 1024)} KiB limit`,
          413,
        ),
      };
    }
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: httpError("Could not read request body", 400) };
  }
  if (new TextEncoder().encode(text).length > maxBytes) {
    return {
      ok: false,
      response: httpError(
        `Request body exceeds the ${Math.round(maxBytes / 1024)} KiB limit`,
        413,
      ),
    };
  }
  if (!text.trim()) {
    return { ok: false, response: httpError("Request body must be a JSON object", 400) };
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: httpError("Request body must be valid JSON", 400) };
  }
}
