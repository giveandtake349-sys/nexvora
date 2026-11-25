import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, parseRoleQueryParam } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
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
  const parsedRole = parseRoleQueryParam(request.nextUrl.searchParams.get("role"), ["owner", "requester"]);
  if (!parsedRole.ok) return jsonError(parsedRole.error, 400);
  const role = parsedRole.role;

  const limit = checkRateLimit(`connection-requests:list:${user.id}`, 120, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const column = role === "requester" ? "requester_user_id" : "owner_id";
  const { rows } = await db.query<ConnectionRequest>(
    `select * from public.connection_requests
     where ${column} = $1 order by created_at desc`,
    [user.id],
  );
  return NextResponse.json({ requests: rows });
}
