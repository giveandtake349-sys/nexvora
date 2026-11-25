/**
 * Milestone 4 live features — pure, unit-testable rules for location
 * sharing, the notification feed, remote interaction, and the audit
 * events the live session writes for them.
 *
 * HARD CONSENT BOUNDARY (applies to everything in this module):
 * - Location is shared ONLY when the owner explicitly starts it
 *   (button click + the browser's Geolocation permission prompt) and
 *   ONLY while a live `location` grant holds. It stops the moment the
 *   owner presses Stop, the grant is revoked, or the session ends.
 *   The OS/browser permission prompt is never bypassed.
 * - Notifications: web browsers CANNOT capture OS notifications, so
 *   the web side has NO "send notification" path and sends no
 *   notification data. The feed populates ONLY from a real reporting
 *   device (Android NotificationListenerService is a Milestone 6
 *   capture route). Nothing here fakes notification data.
 * - Remote interaction in a browser CANNOT synthesize OS-level input
 *   on the remote device. It is in-page only: a remote cursor overlay
 *   + click/key forwarding to the shared view. It is never presented
 *   as full OS remote control, and the controlled side can kill it
 *   instantly with one tap.
 * - Every feature shows a visible indicator on the controlled device
 *   while active, and every start/stop is audit-logged.
 */

/* ------------------------------------------------------------------ */
/* Location                                                            */
/* ------------------------------------------------------------------ */

/** A location fix as sent over the control channel. */
export interface LocationFix {
  latitude: number;
  longitude: number;
  /** Metres, when the browser reports it. */
  accuracy: number | null;
  /** ms since epoch, from the browser's GeolocationPosition. */
  timestamp: number;
}

export const MAX_LOCATION_ACCURACY_METRES = 100_000;

/** Validate an inbound location-update payload. Rejects impossible
 *  coordinates, absurd accuracy, and non-finite numbers — a peer must
 *  never be able to inject a bogus position into the UI. */
export function validateLocationFix(value: unknown): LocationFix | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.latitude !== "number" ||
    !Number.isFinite(v.latitude) ||
    v.latitude < -90 ||
    v.latitude > 90
  ) {
    return null;
  }
  if (
    typeof v.longitude !== "number" ||
    !Number.isFinite(v.longitude) ||
    v.longitude < -180 ||
    v.longitude > 180
  ) {
    return null;
  }
  let accuracy: number | null = null;
  if (v.accuracy !== undefined && v.accuracy !== null) {
    if (
      typeof v.accuracy !== "number" ||
      !Number.isFinite(v.accuracy) ||
      v.accuracy < 0 ||
      v.accuracy > MAX_LOCATION_ACCURACY_METRES
    ) {
      return null;
    }
    accuracy = v.accuracy;
  }
  if (typeof v.timestamp !== "number" || !Number.isSafeInteger(v.timestamp) || v.timestamp <= 0) {
    return null;
  }
  return {
    latitude: v.latitude,
    longitude: v.longitude,
    accuracy,
    timestamp: v.timestamp,
  };
}

/**
 * Minimum time between location-update messages (5s). The browser's
 * watchPosition can fire far more often; throttling keeps the control
 * channel quiet and the peer's UI stable.
 */
export const LOCATION_UPDATE_MIN_INTERVAL_MS = 5_000;

/** Should this fix be sent, given the last one sent at `lastSentAt`? */
export function shouldSendLocationUpdate(nowMs: number, lastSentAtMs: number | null): boolean {
  if (lastSentAtMs === null) return true;
  return nowMs - lastSentAtMs >= LOCATION_UPDATE_MIN_INTERVAL_MS;
}

/**
 * Map link for a fix. OpenStreetMap, no API key, no embedded map —
 * just a link the viewer can open. Built only from validated
 * coordinates.
 */
export function openStreetMapLink(latitude: number, longitude: number): string {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
}

/** Human-readable "lat, lon" for display. */
export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

/* ------------------------------------------------------------------ */
/* Notification feed                                                   */
/* ------------------------------------------------------------------ */

/** One notification as reported by a real reporting device. */
export interface DeviceNotification {
  /** App that posted it, e.g. "Messenger". */
  app: string;
  title: string;
  body: string;
  /** ms since epoch, when the device received it. */
  receivedAt: number;
}

export const MAX_NOTIFICATION_APP_LENGTH = 100;
export const MAX_NOTIFICATION_TITLE_LENGTH = 200;
export const MAX_NOTIFICATION_BODY_LENGTH = 1000;
/** The feed keeps at most this many entries (oldest dropped). */
export const MAX_NOTIFICATION_FEED_ENTRIES = 50;

/**
 * Strict validation for inbound notification messages. A peer that
 * sends an oversized or malformed notification has it dropped — the
 * feed never renders untrusted strings unchecked, and no notification
 * data is ever invented client-side (the web side never constructs
 * one of these itself).
 */
export function validateDeviceNotification(value: unknown): DeviceNotification | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.app !== "string" ||
    !v.app.trim() ||
    v.app.length > MAX_NOTIFICATION_APP_LENGTH
  ) {
    return null;
  }
  if (
    typeof v.title !== "string" ||
    !v.title.trim() ||
    v.title.length > MAX_NOTIFICATION_TITLE_LENGTH
  ) {
    return null;
  }
  if (typeof v.body !== "string" || v.body.length > MAX_NOTIFICATION_BODY_LENGTH) {
    return null;
  }
  if (
    typeof v.receivedAt !== "number" ||
    !Number.isSafeInteger(v.receivedAt) ||
    v.receivedAt <= 0
  ) {
    return null;
  }
  return {
    app: v.app.trim(),
    title: v.title.trim(),
    body: v.body,
    receivedAt: v.receivedAt,
  };
}

/** Append a notification to the feed, newest first, capped at 50. */
export function appendNotificationFeed(
  feed: DeviceNotification[],
  next: DeviceNotification,
): DeviceNotification[] {
  return [next, ...feed].slice(0, MAX_NOTIFICATION_FEED_ENTRIES);
}

/* ------------------------------------------------------------------ */
/* Remote interaction (in-page only — never OS-level input)            */
/* ------------------------------------------------------------------ */

/** Pointer position normalised to the shared view (0–1 each axis). */
export interface RemotePointerEvent {
  kind: "move" | "click";
  /** 0–1 across the shared view. */
  x: number;
  /** 0–1 down the shared view. */
  y: number;
}

/** Validate an inbound pointer event. Out-of-range coordinates are
 *  rejected, not clamped — a peer must not be able to address a point
 *  outside the shared view. */
export function validateRemotePointerEvent(value: unknown): RemotePointerEvent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== "move" && v.kind !== "click") return null;
  if (
    typeof v.x !== "number" ||
    !Number.isFinite(v.x) ||
    v.x < 0 ||
    v.x > 1 ||
    typeof v.y !== "number" ||
    !Number.isFinite(v.y) ||
    v.y < 0 ||
    v.y > 1
  ) {
    return null;
  }
  return { kind: v.kind, x: v.x, y: v.y };
}

export const MAX_REMOTE_KEY_LENGTH = 32;

/** Validate an inbound key event. Only single keys / short named
 *  keys (e.g. "Enter") are forwarded, and only as a visible log entry
 *  on the controlled side — never injected into the OS or the DOM. */
export function validateRemoteKeyEvent(value: unknown): { key: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const key = (value as Record<string, unknown>).key;
  if (typeof key !== "string" || !key || key.length > MAX_REMOTE_KEY_LENGTH) return null;
  return { key };
}

/* ------------------------------------------------------------------ */
/* Session audit events (POST /api/sessions/[id]/events)               */
/* ------------------------------------------------------------------ */

/**
 * The only audit actions a live-session client may write. Each maps
 * to one Milestone 4 feature's start/stop, so the Security Center
 * shows exactly what was shared, when — and nothing else can be
 * injected through this route.
 */
export const LIVE_SESSION_AUDIT_ACTIONS = [
  "location.sharing_started",
  "location.sharing_stopped",
  "notifications.sharing_started",
  "notifications.sharing_stopped",
  "interaction.started",
  "interaction.stopped",
  "interaction.killed",
  "recording.started",
  "recording.stopped",
] as const;

export type LiveSessionAuditAction = (typeof LIVE_SESSION_AUDIT_ACTIONS)[number];

export function isLiveSessionAuditAction(value: unknown): value is LiveSessionAuditAction {
  return (
    typeof value === "string" &&
    (LIVE_SESSION_AUDIT_ACTIONS as readonly string[]).includes(value)
  );
}

/** Max JSON size of the audit details object (2 KiB). */
export const MAX_AUDIT_DETAILS_BYTES = 2 * 1024;

/** Validate the events-route body: { action, details? }. */
export function validateSessionEventBody(
  body: unknown,
): { ok: true; action: LiveSessionAuditAction; details: Record<string, unknown> } | { ok: false; error: string; status: number } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object", status: 400 };
  }
  const b = body as Record<string, unknown>;
  if (!isLiveSessionAuditAction(b.action)) {
    return {
      ok: false,
      error: `action must be one of: ${LIVE_SESSION_AUDIT_ACTIONS.join(", ")}`,
      status: 400,
    };
  }
  const details = b.details ?? {};
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return { ok: false, error: "details must be a JSON object", status: 400 };
  }
  if (new TextEncoder().encode(JSON.stringify(details)).length > MAX_AUDIT_DETAILS_BYTES) {
    return { ok: false, error: "details exceed the 2 KiB limit", status: 413 };
  }
  return { ok: true, action: b.action, details: details as Record<string, unknown> };
}

/**
 * Which audit actions also go to security_events (not just
 * session_events). Sharing starts are security-relevant, and so is
 * the interaction kill-switch — the owner ending remote interaction
 * is a security decision the Security Center must show. Stops are
 * session_events only: they close a sharing window that was already
 * logged at its start.
 *
 * Milestone 5 fix: `interaction.killed` was previously session-only.
 */
export function shouldLogSecurityEvent(action: LiveSessionAuditAction): boolean {
  return (
    action.endsWith("_started") ||
    action === "interaction.started" ||
    action === "interaction.killed" ||
    action === "recording.started"
  );
}

/**
 * Which permission scope gates each audit action (owner exempt, as
 * everywhere else). The events route enforces this server-side.
 * "any-media" is special: the action is allowed when the caller
 * holds a live grant for ANY of screen / camera / microphone —
 * recording captures whichever remote tracks are live, so no single
 * scope fits it (the route checks the three scopes for these
 * actions).
 */
export const AUDIT_ACTION_SCOPE: Record<
  LiveSessionAuditAction,
  "location" | "notifications" | "remote_interaction" | "any-media"
> = {
  "location.sharing_started": "location",
  "location.sharing_stopped": "location",
  "notifications.sharing_started": "notifications",
  "notifications.sharing_stopped": "notifications",
  "interaction.started": "remote_interaction",
  "interaction.stopped": "remote_interaction",
  "interaction.killed": "remote_interaction",
  "recording.started": "any-media",
  "recording.stopped": "any-media",
};
