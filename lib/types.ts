import type { PermissionScope } from "./permissions";

/** Row shapes for the Supabase tables created in supabase/migrations/. */

export interface Profile {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Device {
  id: string;
  owner_id: string;
  name: string;
  device_fingerprint: string;
  platform: "web" | "android" | "ios" | "desktop";
  browser: string | null;
  os: string | null;
  last_seen_at: string | null;
  is_trusted: boolean;
  created_at: string;
  updated_at: string;
}

export interface PairingInvitation {
  id: string;
  inviter_user_id: string;
  inviter_device_id: string | null;
  code_hash: string;
  secret_hash: string;
  display_code_hint: string;
  expires_at: string;
  used_at: string | null;
  status: "active" | "used" | "expired" | "revoked";
  created_at: string;
}

export type ConnectionRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

export interface ConnectionRequest {
  id: string;
  requester_user_id: string;
  requester_device_id: string | null;
  target_device_id: string;
  owner_id: string;
  requested_scopes: PermissionScope[];
  status: ConnectionRequestStatus;
  decided_at: string | null;
  created_at: string;
}

export interface DevicePermission {
  id: string;
  owner_id: string;
  device_id: string;
  granted_to_user_id: string;
  scope: PermissionScope;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  is_revoked: boolean;
}

export type RemoteSessionStatus = "active" | "ended" | "revoked";

export interface RemoteSession {
  id: string;
  connection_request_id: string | null;
  device_id: string;
  owner_id: string;
  participant_user_id: string;
  status: RemoteSessionStatus;
  started_at: string;
  ended_at: string | null;
}

export interface SecurityEvent {
  id: string;
  user_id: string | null;
  device_id: string | null;
  actor_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface SessionEvent {
  id: string;
  session_id: string | null;
  device_id: string | null;
  actor_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  created_at: string;
}
