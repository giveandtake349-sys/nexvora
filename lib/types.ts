import type { PermissionScope } from "./permissions";

/**
 * Row shapes for the Neon Postgres tables created in db/migrations/.
 *
 * User ids are Better Auth ids — opaque strings, NOT uuids — so every
 * user-id column is text. Device / session / request ids are uuids.
 */

export interface Profile {
  id: string;
  email: string | null;
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

export type SignalingState = "created" | "connecting" | "live" | "ended" | "revoked";

export interface RemoteSession {
  id: string;
  connection_request_id: string | null;
  device_id: string;
  owner_id: string;
  participant_user_id: string;
  status: RemoteSessionStatus;
  started_at: string;
  ended_at: string | null;
  /** Milestone 2: WebRTC signaling lifecycle (see lib/signaling.ts). */
  signaling_state: SignalingState;
  /** Per-party heartbeats — one shared column could not tell the
   *  parties apart, so each side has its own (Milestone 2). */
  owner_last_heartbeat_at: string | null;
  participant_last_heartbeat_at: string | null;
}

export type SignalingMessageKind =
  | "offer"
  | "answer"
  | "ice-candidate"
  | "bye"
  | "session-state";

/** One DB-backed signaling message (Milestone 2). `seq` comes from the
 *  global signaling_message_seq sequence: strictly increasing across
 *  all sessions, so polling with `after=<seq>` never misses or
 *  double-delivers a message. */
export interface SignalingMessage {
  id: string;
  session_id: string;
  sender_user_id: string;
  recipient_user_id: string;
  kind: SignalingMessageKind;
  payload: Record<string, unknown>;
  seq: number;
  created_at: string;
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
