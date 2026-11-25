import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, readJsonBody } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * PATCH /api/profile — update the signed-in user's display name.
 * The profile row is lazily created at sign-in (see
 * lib/auth/session.ts); here we only update the display name — the
 * email is refreshed from the auth session, never from client input.
 * The auth-side display name is updated by the settings form via
 * authClient.updateUser before calling this endpoint; this keeps the
 * profile row in sync with the auth record.
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;

  const limit = checkRateLimit(`profile:update:${user.id}`, 30, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body =
    parsedBody.body !== null && typeof parsedBody.body === "object"
      ? (parsedBody.body as Record<string, unknown>)
      : {};
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 80) : "";
  if (!displayName) return jsonError("Display name is required", 400);

  await db.query(
    `insert into public.profiles (id, email, display_name)
     values ($1, $2, $3)
     on conflict (id) do update set display_name = excluded.display_name`,
    [user.id, user.email || null, displayName],
  );
  return NextResponse.json({ ok: true });
}
