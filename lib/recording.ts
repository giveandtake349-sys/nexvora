/**
 * Session recording v1 — pure, unit-testable rules.
 *
 * The viewer (controller) records the remote stream (screen/camera
 * video + audio) with MediaRecorder. The recording itself lives in
 * components/LiveSession.tsx (browser APIs cannot run in vitest);
 * this module holds everything that can be decided without a browser:
 *
 *   - the one-time grant gate (canRecord),
 *   - the recording state machine (idle / recording / stopped),
 *   - which remote tracks go into the recording,
 *   - the MediaRecorder mime-type pick,
 *   - chunk assembly + display formatting.
 *
 * GRANT MODEL (user decision, Nov 25 2026 — the one-time grant at
 * pairing covers recording, same as every other live feature): NO
 * per-session owner approval is asked for recording. The owner
 * granted screen / camera / microphone once at first pairing, and
 * that grant is the permission — the Record button starts right
 * away. The guardrails that stay: both sides always see a visible
 * REC indicator while recording is active; recording stops
 * immediately when access is revoked, the session ends, or the peer
 * leaves; every start/stop is audit-logged (recording.started /
 * recording.stopped). Nothing is ever recorded silently, and nothing
 * is uploaded anywhere — v1 stores recordings only in the viewer's
 * browser (IndexedDB, lib/recordings.ts).
 */

import type { PermissionScope } from "./permissions";

/* ------------------------------------------------------------------ */
/* Grant gate — the one-time pairing grant covers recording            */
/* ------------------------------------------------------------------ */

/**
 * May this side record the session? The device owner always may
 * (they own the device). A participant may record when they hold a
 * live grant for ANY of screen / camera / microphone — the same
 * "any-media" rule the events route enforces server-side for the
 * recording audit actions. No separate recording scope exists and
 * no approval is asked again in-session: the grant was given once
 * at pairing.
 */
export function canRecord(
  grantedScopes: readonly PermissionScope[],
  isOwner: boolean,
): boolean {
  if (isOwner) return true;
  return (
    grantedScopes.includes("screen") ||
    grantedScopes.includes("camera") ||
    grantedScopes.includes("microphone")
  );
}

/* ------------------------------------------------------------------ */
/* Recording state machine                                             */
/* ------------------------------------------------------------------ */

/**
 * Recording states for MY side:
 * - idle: nothing happening.
 * - recording: MediaRecorder is running on my side.
 * - stopped: a recording ran and has now stopped (saved or failed).
 */
export const RECORDING_STATES = ["idle", "recording", "stopped"] as const;

export type RecordingState = (typeof RECORDING_STATES)[number];

export type RecordingEvent =
  | "start" // start recording (idle -> recording)
  | "stop" // recorder stops (recording -> stopped)
  | "reset"; // back to idle from a terminal state

/**
 * Pure recording transitions. Anything not listed is ignored
 * (returns the current state) — a stray event can never move the
 * recorder into a state the UI cannot represent.
 */
export function transitionRecordingState(
  state: RecordingState,
  event: RecordingEvent,
): RecordingState {
  switch (state) {
    case "idle":
      if (event === "start") return "recording";
      return state;
    case "recording":
      if (event === "stop") return "stopped";
      return state;
    case "stopped":
      if (event === "reset") return "idle";
      return state;
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/* Track picking — what goes into the recording                        */
/* ------------------------------------------------------------------ */

/** The minimal track shape this module needs (a real
 *  MediaStreamTrack in the component, a plain object in tests). */
export interface RecordingTrackLike {
  readyState: string;
}

export interface RecordingTrackPick {
  /** Screen video wins; camera video is the fallback; null when
   *  neither is live. MediaRecorder records one video track — two
   *  video tracks are never composited, so the choice is explicit. */
  video: RecordingTrackLike | null;
  /** Remote microphone audio, when live. Muted still counts as live
   *  (it records silence, honestly — mute is never faked as audio). */
  audio: RecordingTrackLike | null;
}

/**
 * Pick the tracks for one recording from the remote tracks the
 * viewer currently receives. Returns nulls when nothing is live —
 * the component must refuse to start and say so, never record an
 * empty stream.
 */
export function pickRecordingTracks(tracks: {
  screen?: RecordingTrackLike | null;
  camera?: RecordingTrackLike | null;
  audio?: RecordingTrackLike | null;
}): RecordingTrackPick {
  const live = (t?: RecordingTrackLike | null): RecordingTrackLike | null =>
    t && t.readyState === "live" ? t : null;
  return {
    video: live(tracks.screen) ?? live(tracks.camera),
    audio: live(tracks.audio),
  };
}

/** True when the pick contains anything worth recording. */
export function hasRecordableTrack(pick: RecordingTrackPick): boolean {
  return pick.video !== null || pick.audio !== null;
}

/* ------------------------------------------------------------------ */
/* MediaRecorder setup                                                 */
/* ------------------------------------------------------------------ */

/** One chunk per second — the save path gets regular, small pieces
 *  instead of one giant blob at the end, and a crash mid-recording
 *  loses at most the last second. */
export const RECORDING_CHUNK_TIMESLICE_MS = 1000;

/**
 * Safety cap: one hour per recording, then the recorder auto-stops.
 * An unbounded recording could fill the browser's storage quota
 * silently; the cap keeps v1 honest (the UI says so before starting).
 */
export const MAX_RECORDING_DURATION_MS = 60 * 60 * 1000;

export function shouldAutoStopRecording(elapsedMs: number): boolean {
  return elapsedMs >= MAX_RECORDING_DURATION_MS;
}

/** Mime types, best first. The component asks the browser which it
 *  supports via MediaRecorder.isTypeSupported and takes the first
 *  hit; "" means "browser default" (used only when none matches). */
export const RECORDING_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm",
] as const;

export function pickRecordingMimeType(
  isSupported: (mimeType: string) => boolean,
): string {
  for (const candidate of RECORDING_MIME_CANDIDATES) {
    try {
      if (isSupported(candidate)) return candidate;
    } catch {
      // A throwing isTypeSupported is treated as "not supported".
    }
  }
  return "";
}

/** Assemble the collected MediaRecorder chunks into one .webm blob. */
export function assembleRecordingBlob(chunks: Blob[], mimeType: string): Blob {
  return new Blob(chunks, { type: mimeType || "video/webm" });
}

/* ------------------------------------------------------------------ */
/* Display formatting                                                  */
/* ------------------------------------------------------------------ */

/** "04:32" under an hour, "1:04:32" above it. */
export function formatRecordingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "812 KB" / "12.4 MB" / "1.2 GB" — one decimal, binary units. */
export function formatRecordingSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024)
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Download file name: nexvora-recording-<device>-<yyyy-mm-dd-hhmm>.webm.
 * The device name is sanitised to [a-z0-9-] so a peer-supplied name
 * can never inject a path or a strange extension.
 */
export function recordingFileName(
  deviceName: string,
  startedAt: number,
): string {
  const safe = deviceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `nexvora-recording-${safe || "device"}-${stamp}.webm`;
}
