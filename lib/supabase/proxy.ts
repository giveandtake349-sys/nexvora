import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAnonKey, getSupabaseUrl, isSupabaseConfigured } from "./config";

/**
 * Refreshes the Supabase auth session on every proxied request and returns
 * the response to continue with. Called from proxy.ts (Next.js 16 renamed
 * the old middleware.ts convention to proxy.ts).
 *
 * If Supabase is not configured, requests pass through untouched and the
 * dashboard pages themselves render the "not configured" state.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  if (!isSupabaseConfigured()) return response;

  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Refreshing the session also validates it; a missing/expired session
  // simply yields no user — route protection happens in proxy.ts.
  await supabase.auth.getUser();
  return response;
}
