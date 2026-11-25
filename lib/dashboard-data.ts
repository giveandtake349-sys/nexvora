import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { User } from "@supabase/supabase-js";
import type {
  ConnectionRequest,
  Device,
  DevicePermission,
  RemoteSession,
  SecurityEvent,
  SessionEvent,
} from "./types";

export interface DashboardData {
  user: User | null;
  configured: boolean;
  devices: Device[];
  incomingRequests: ConnectionRequest[];
  outgoingRequests: ConnectionRequest[];
  sessions: RemoteSession[];
  myPermissions: DevicePermission[];
  grantedToMe: DevicePermission[];
  securityEvents: SecurityEvent[];
  sessionEvents: SessionEvent[];
}

/** One server-side fetch for all dashboard pages. Safe when unconfigured. */
export async function getDashboardData(): Promise<DashboardData> {
  const empty: DashboardData = {
    user: null,
    configured: isSupabaseConfigured(),
    devices: [],
    incomingRequests: [],
    outgoingRequests: [],
    sessions: [],
    myPermissions: [],
    grantedToMe: [],
    securityEvents: [],
    sessionEvents: [],
  };
  if (!isSupabaseConfigured()) return empty;
  const supabase = await createServerSupabaseClient();
  if (!supabase) return empty;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return empty;

  const [devices, incoming, outgoing, sessions, myPerms, granted, secEvents, sessEvents] =
    await Promise.all([
      supabase.from("devices").select("*").eq("owner_id", user.id).order("created_at", { ascending: false }),
      supabase.from("connection_requests").select("*").eq("owner_id", user.id).order("created_at", { ascending: false }),
      supabase.from("connection_requests").select("*").eq("requester_user_id", user.id).order("created_at", { ascending: false }),
      supabase.from("remote_sessions").select("*").or(`owner_id.eq.${user.id},participant_user_id.eq.${user.id}`).order("started_at", { ascending: false }),
      supabase.from("device_permissions").select("*").eq("owner_id", user.id).order("granted_at", { ascending: false }),
      supabase.from("device_permissions").select("*").eq("granted_to_user_id", user.id).order("granted_at", { ascending: false }),
      supabase.from("security_events").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("session_events").select("*").order("created_at", { ascending: false }).limit(50),
    ]);

  return {
    user,
    configured: true,
    devices: (devices.data ?? []) as Device[],
    incomingRequests: (incoming.data ?? []) as ConnectionRequest[],
    outgoingRequests: (outgoing.data ?? []) as ConnectionRequest[],
    sessions: (sessions.data ?? []) as RemoteSession[],
    myPermissions: (myPerms.data ?? []) as DevicePermission[],
    grantedToMe: (granted.data ?? []) as DevicePermission[],
    securityEvents: (secEvents.data ?? []) as SecurityEvent[],
    sessionEvents: (sessEvents.data ?? []) as SessionEvent[],
  };
}
