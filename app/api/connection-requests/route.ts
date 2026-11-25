import { NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";

/**
 * GET /api/connection-requests?role=owner|requester
 * Owner: requests targeting my devices. Requester: requests I made.
 * Both sides can see the request — only the owner can decide it.
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const role = new URL(request.url).searchParams.get("role") ?? "owner";

  const query = supabase.from("connection_requests").select("*").order("created_at", { ascending: false });
  const { data, error } =
    role === "requester"
      ? await query.eq("requester_user_id", user.id)
      : await query.eq("owner_id", user.id);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ requests: data ?? [] });
}
