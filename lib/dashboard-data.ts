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
  const user = await getSessionUser();
  if (!user) return empty;

  // Each query runs in its own transaction with the RLS session
  // variable set to this user; the policies filter every result to
  // rows the user is allowed to see.
  const [devices, incoming, outgoing, sessions, myPerms, granted, secEvents, sessEvents] =
    await Promise.all([
      withUser(user.id, (db) =>
        db.query<Device>(
          `select * from public.devices where owner_id = $1 order by created_at desc`,
          [user.id],
        ),
      ),
      withUser(user.id, (db) =>
        db.query<ConnectionRequest>(
          `select * from public.connection_requests where owner_id = $1 order by created_at desc`,
          [user.id],
        ),
      ),
      withUser(user.id, (db) =>
        db.query<ConnectionRequest>(
          `select * from public.connection_requests where requester_user_id = $1 order by created_at desc`,
          [user.id],
        ),
      ),
      withUser(user.id, (db) =>
        db.query<RemoteSession>(
          `select * from public.remote_sessions
           where owner_id = $1 or participant_user_id = $1 order by started_at desc`,
          [user.id],
        ),
      ),
      withUser(user.id, (db) =>
        db.query<DevicePermission>(
          `select * from public.device_permissions where owner_id = $1 order by granted_at desc`,
          [user.id],
        ),
      ),
      withUser(user.id, (db) =>
        db.query<DevicePermission>(
          `select * from public.device_permissions where granted_to_user_id = $1 order by granted_at desc`,
          [user.id],
        ),
      ),
      withUser(user.id, (db) =>
        db.query<SecurityEvent>(
          `select * from public.security_events order by created_at desc limit 50`,
        ),
      ),
      withUser(user.id, (db) =>
        db.query<SessionEvent>(
          `select * from public.session_events order by created_at desc limit 50`,
        ),
      ),
    ]);

  return {
    user,
    configured: true,
    devices: devices.rows,
    incomingRequests: incoming.rows,
    outgoingRequests: outgoing.rows,
    sessions: sessions.rows,
    myPermissions: myPerms.rows,
    grantedToMe: granted.rows,
    securityEvents: secEvents.rows,
    sessionEvents: sessEvents.rows,
  };
}
