/**
 * Trusted Device permission scopes + server-side validity checks.
 *
 * One row in `device_permissions` = one scope granted to one user for one
 * device. A grant is valid ONLY when all of these hold:
 *   - it exists
 *   - it is not revoked
 *   - it has not expired
 *   - the device identity matches the device being accessed
 *
 * Re-authorization is required only when a NEW scope is requested, the
 * device identity changes, the grant expires, the owner revokes it, or a
 * security event requires it. Valid grants are reused on reconnect.
 */

export const PERMISSION_SCOPES = [
  "screen",
  "camera",
  "microphone",
  "speaker",
  "file_transfer",
  "location",
  "remote_interaction",
  "device_info",
] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export const SCOPE_LABELS: Record<PermissionScope, string> = {
  screen: "Screen Sharing",
  camera: "Camera",
  microphone: "Microphone",
  speaker: "Speaker / Audio Output",
  file_transfer: "File Transfer",
  location: "Location Sharing",
  remote_interaction: "Remote Interaction",
  device_info: "Device Information",
};

export const SCOPE_DESCRIPTIONS: Record<PermissionScope, string> = {
  screen: "View the remote device screen. Live in Milestone 3.",
  camera: "View the remote camera stream. Live in Milestone 3.",
  microphone: "Hear live audio from the remote microphone. Live in Milestone 3.",
  speaker: "Play audio on the remote device speaker. Live in Milestone 3.",
  file_transfer: "Send and receive files. Live in Milestone 4.",
  location: "See the device location while sharing is active. Live in Milestone 4.",
  remote_interaction: "Interact with the remote device. Live in Milestone 4.",
  device_info: "See device name, OS, browser and last-seen status.",
};

/** Milestone in which the scope becomes usable for live access. */
export const SCOPE_MILESTONE: Record<PermissionScope, number> = {
  screen: 3,
  camera: 3,
  microphone: 3,
  speaker: 3,
  file_transfer: 4,
  location: 4,
  remote_interaction: 4,
  device_info: 1,
};

export function isPermissionScope(value: unknown): value is PermissionScope {
  return (
    typeof value === "string" &&
    (PERMISSION_SCOPES as readonly string[]).includes(value)
  );
}

/** Default grant lifetime: 30 days from approval. */
export const DEFAULT_GRANT_DAYS = 30;

export function defaultGrantExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + DEFAULT_GRANT_DAYS * 24 * 60 * 60 * 1000);
}

export interface DevicePermissionGrant {
  device_id: string;
  scope: string;
  /** True when revoked_at is set. Kept in the row for fast filtering. */
  is_revoked: boolean;
  revoked_at: string | null;
  expires_at: string | null;
}

export type GrantValidity =
  | "valid"
  | "not_found"
  | "revoked"
  | "expired"
  | "device_mismatch";

/**
 * Pure server-side validity check. Used by every API route before any
 * access is allowed, and by the Trusted Devices page to display state.
 * Never trust a client-side "granted" flag.
 */
export function checkGrantValidity(
  grant: DevicePermissionGrant | null | undefined,
  deviceId: string,
  now: Date = new Date(),
): GrantValidity {
  if (!grant) return "not_found";
  if (grant.is_revoked || grant.revoked_at) return "revoked";
  if (grant.device_id !== deviceId) return "device_mismatch";
  if (grant.expires_at && new Date(grant.expires_at).getTime() <= now.getTime())
    return "expired";
  return "valid";
}

export function isGrantValid(
  grant: DevicePermissionGrant | null | undefined,
  deviceId: string,
  now: Date = new Date(),
): boolean {
  return checkGrantValidity(grant, deviceId, now) === "valid";
}

/**
 * Of the requested scopes, which ones already have a valid grant
 * (reuse — no re-approval) and which ones still need owner approval?
 */
export function splitScopesByValidity(
  requested: PermissionScope[],
  grants: DevicePermissionGrant[],
  deviceId: string,
  now: Date = new Date(),
): { alreadyGranted: PermissionScope[]; needsApproval: PermissionScope[] } {
  const alreadyGranted: PermissionScope[] = [];
  const needsApproval: PermissionScope[] = [];
  for (const scope of requested) {
    const grant = grants.find((g) => g.scope === scope);
    if (isGrantValid(grant, deviceId, now)) alreadyGranted.push(scope);
    else needsApproval.push(scope);
  }
  return { alreadyGranted, needsApproval };
}
