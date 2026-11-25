import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAnonKey, getSupabaseUrl, isSupabaseConfigured } from "./config";

/**
 * Browser Supabase client. Returns null when Supabase is not configured,
 * so pages can render an honest "not configured" state instead of crashing
 * or faking auth.
 */
export function createBrowserSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  return createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey());
}
