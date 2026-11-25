import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import {
  getServiceRoleKey,
  getSupabaseAnonKey,
  getSupabaseUrl,
  isServiceRoleConfigured,
  isSupabaseConfigured,
} from "./config";

/**
 * Server Supabase client bound to the current request's cookies
 * (the signed-in user's session). Returns null when not configured.
 */
export async function createServerSupabaseClient(): Promise<SupabaseClient | null> {
  if (!isSupabaseConfigured()) return null;
  const cookieStore = await cookies();
  return createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component — cookies can only be set in
          // Server Actions / Route Handlers. Safe to ignore here.
        }
      },
    },
  });
}

/**
 * Service-role client for privileged server-side operations only
 * (e.g. ending sessions after a revocation, writing audit rows that RLS
 * would otherwise block). Server-only — never import from client code.
 * Returns null when the service-role key is not configured.
 */
export function createServiceSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured() || !isServiceRoleConfigured()) return null;
  return createAdminClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
