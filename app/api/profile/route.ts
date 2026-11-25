import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";

/** PATCH /api/profile — update the signed-in user's display name. */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const body = await request.json().catch(() => ({}));
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 80) : "";
  if (!displayName) return jsonError("Display name is required", 400);

  const { error } = await supabase
    .from("profiles")
    .upsert({ id: user.id, display_name: displayName }, { onConflict: "id" });
  if (error) return jsonError(error.message, 500);
  // Keep the Auth user metadata in sync too.
  await supabase.auth.updateUser({ data: { display_name: displayName } });
  return NextResponse.json({ ok: true });
}
