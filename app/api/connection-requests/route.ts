import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/api";
import type { ConnectionRequest } from "@/lib/types";

/**
 * GET /api/connection-requests?role=owner|requester
 * Owner: requests targeting my devices. Requester: requests I made.
 * Both sides can see the request — only the owner can decide it.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const role = request.nextUrl.searchParams.get("role") ?? "owner";

  const column = role === "requester" ? "requester_user_id" : "owner_id";
  const { rows } = await db.query<ConnectionRequest>(
    `select * from public.connection_requests
     where ${column} = $1 order by created_at desc`,
    [user.id],
  );
  return NextResponse.json({ requests: rows });
}
