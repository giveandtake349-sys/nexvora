import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { isAuthConfigured, isDatabaseConfigured } from "@/lib/db/config";
import { withUser } from "@/lib/db/client";
import type {
  ConnectionRequest,
  Device,
  DevicePermission,
  RemoteSession,
  SecurityEvent,
  SessionEvent,
} from "./types";

export interface DashboardData {
  user: SessionUser | null;
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
  const configured = isDatabaseConfigured() && isAuthConfigured();
  const empty: DashboardData = {
    user: null,
    configured,
    devices: [],
    incomingRequests: [],
    outgoingRequests: [],
    sessions: [],
    myPermissions: [],
    grantedToMe: [],
    securityEvents: [],
    sessionEvents: [],
  };
  if (!configured) return empty;
  // No profile upsert here — it runs inside the single transaction
  // below, so the whole page costs ONE database connection instead of
  // nine (Vercel us-east -> Neon Singapore handshakes are what made
  // every dashboard navigation take 4-8s with no feedback).
  const user = await getSessionUser({ ensureProfile: false });
  if (!user) return empty;

  // One transaction with the RLS session variable set; the profile
  // upsert and all eight reads share the same held connection.
  const data = await withUser(user.id, async (db) => {
    await db.query(
      `insert into public.profiles (id, email, display_name)
       values ($1, $2, $3)
       on conflict (id) do update set email = excluded.email`,
      [user.id, user.email || null, user.displayName],
    );
    const devices = await db.query<Device>(
      `select * from public.devices where owner_id = $1 order by created_at desc`,
      [user.id],
    );
    const incoming = await db.query<ConnectionRequest>(
      `select * from public.connection_requests where owner_id = $1 order by created_at desc`,
      [user.id],
    );
    const outgoing = await db.query<ConnectionRequest>(
      `select * from public.connection_requests where requester_user_id = $1 order by created_at desc`,
      [user.id],
    );
    const sessions = await db.query<RemoteSession>(
      `select * from public.remote_sessions
       where owner_id = $1 or participant_user_id = $1 order by started_at desc`,
      [user.id],
    );
    const myPerms = await db.query<DevicePermission>(
      `select * from public.device_permissions where owner_id = $1 order by granted_at desc`,
      [user.id],
    );
    const granted = await db.query<DevicePermission>(
      `select * from public.device_permissions where granted_to_user_id = $1 order by granted_at desc`,
      [user.id],
    );
    const secEvents = await db.query<SecurityEvent>(
      `select * from public.security_events order by created_at desc limit 50`,
    );
    const sessEvents = await db.query<SessionEvent>(
      `select * from public.session_events order by created_at desc limit 50`,
    );
    return {
      devices: devices.rows,
      incomingRequests: incoming.rows,
      outgoingRequests: outgoing.rows,
      sessions: sessions.rows,
      myPermissions: myPerms.rows,
      grantedToMe: granted.rows,
      securityEvents: secEvents.rows,
      sessionEvents: sessEvents.rows,
    };
  });

  return { user, configured: true, ...data };
}
