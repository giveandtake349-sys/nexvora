import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth/server";

/**
 * Next.js 16 route protection (the old middleware.ts convention is
 * deprecated and renamed to proxy.ts). Delegates to the Neon Auth
 * (Managed Better Auth) SDK middleware: it validates the session on
 * every request and redirects unauthenticated visitors away from
 * protected routes to /login.
 *
 * When Neon Auth is not configured, requests pass through and the
 * pages themselves render the "not configured" state.
 *
 * Public routes (besides the SDK's built-in /api/auth/* auth routes):
 * the landing page and the auth pages. Everything else — including
 * /dashboard/* — requires a session.
 *
 * Note: unlike the old Supabase proxy, the SDK middleware does not
 * append a ?next= parameter to the login redirect; after sign-in the
 * login form falls back to /dashboard.
 */
export async function proxy(request: NextRequest) {
  const auth = getAuth();
  if (!auth) return NextResponse.next();
  const middleware = auth.middleware({
    loginUrl: "/login",
    publicRoutes: ["/", "/login", "/register", "/forgot-password", "/reset-password"],
  });
  return middleware(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
