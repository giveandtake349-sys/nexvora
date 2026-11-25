import { getAuth } from "@/lib/auth/server";
import { NextResponse } from "next/server";

/**
 * Managed Better Auth (Neon Auth) handler — the auth client in
 * lib/auth/client.ts talks to this same-origin proxy (/api/auth/*),
 * which forwards to the Neon Auth project (NEON_AUTH_BASE_URL).
 * Covers sign-up, email sign-in, Google OAuth, password reset and
 * session refresh.
 *
 * `auth.handler()` returns the per-method Next.js handlers
 * ({ GET, POST, PUT, PATCH, DELETE }) — it is not itself callable.
 * Each method needs the route's { params } (the [...path] segments).
 *
 * When Neon Auth is not configured the app cannot sign anyone in, so
 * every method answers 503 with the honest message instead of
 * crashing at import time (createNeonAuth throws on a missing or
 * short cookie secret).
 */
function notConfigured() {
  return NextResponse.json(
    {
      error:
        "Authentication is not configured. Set NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET in your environment.",
    },
    { status: 503 },
  );
}

type HandlerContext = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, ctx: HandlerContext) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  return auth.handler().GET(request, ctx);
}

export async function POST(request: Request, ctx: HandlerContext) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  return auth.handler().POST(request, ctx);
}

export async function PUT(request: Request, ctx: HandlerContext) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  return auth.handler().PUT(request, ctx);
}

export async function PATCH(request: Request, ctx: HandlerContext) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  return auth.handler().PATCH(request, ctx);
}

export async function DELETE(request: Request, ctx: HandlerContext) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  return auth.handler().DELETE(request, ctx);
}
