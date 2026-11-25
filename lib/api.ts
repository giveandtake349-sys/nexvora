import { NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, SUPABASE_NOT_CONFIGURED_MESSAGE } from "@/lib/supabase/config";

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export function notConfiguredResponse() {
  return jsonError(SUPABASE_NOT_CONFIGURED_MESSAGE, 503);
}

export interface AuthContext {
  supabase: SupabaseClient;
  user: User;
}

/**
 * Every API route starts here: Supabase must be configured AND the caller
 * must have a valid session. Returns null after the caller has already
 * sent the error response — callers must `return` it.
 */
export async function requireAuth(): Promise<
  { ctx: AuthContext } | { response: NextResponse }
> {
  if (!isSupabaseConfigured()) return { response: notConfiguredResponse() };
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { response: notConfiguredResponse() };
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { response: jsonError("Not authenticated", 401) };
  return { ctx: { supabase, user } };
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : null;
}
