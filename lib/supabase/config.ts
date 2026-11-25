/**
 * Supabase configuration helpers.
 *
 * The app must build and render even when no Supabase project exists yet.
 * In that state every auth / data surface shows a clear
 * "Supabase not configured" message and disables its forms — it never
 * fakes a login with localStorage or mock data.
 */

export function getSupabaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
}

export function getSupabaseAnonKey(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
}

export function getServiceRoleKey(): string {
  // Server-only. Never read this from client code.
  return (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
}

export function isSupabaseConfigured(): boolean {
  const url = getSupabaseUrl();
  return url.startsWith("http://") || url.startsWith("https://")
    ? getSupabaseAnonKey().length > 0
    : false;
}

export function isServiceRoleConfigured(): boolean {
  return getServiceRoleKey().length > 0;
}

export const SUPABASE_NOT_CONFIGURED_MESSAGE =
  "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (see .env.example and README.md).";
