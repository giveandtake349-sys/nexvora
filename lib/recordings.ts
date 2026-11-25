/**
 * Session recordings — client-side storage (IndexedDB), v1.
 *
 * A recording is saved ONLY in the viewer's browser: metadata +
 * MediaRecorder chunks (Blobs) in one object store. Nothing is
 * uploaded to the server and nothing is stored in Postgres — there
 * is no migration for recordings, by design. Clearing the browser's
 * site data deletes the recordings; the UI says so on the recordings
 * page.
 *
 * The store is wrapped in small promise functions. Every function
 * takes an optional IDBFactory (default: globalThis.indexedDB) so
 * tests can inject a fake without touching the real browser API.
 */

export const RECORDINGS_DB_NAME = "nexvora-recordings";
export const RECORDINGS_STORE_NAME = "recordings";
export const RECORDINGS_DB_VERSION = 1;

/** Which remote video track a recording captured (for the list UI). */
export type RecordingVideoKind = "screen" | "camera" | "none";

/** Metadata shown in the recordings list (stored WITHOUT chunks). */
export interface RecordingMeta {
  /** crypto.randomUUID() from the recorder, also the store key. */
  id: string;
  sessionId: string;
  deviceName: string;
  /** ms since epoch, when recording started. */
  startedAt: number;
  /** ms since epoch, when recording stopped. */
  endedAt: number;
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
  videoKind: RecordingVideoKind;
  hasAudio: boolean;
}

/** One saved recording: metadata + the MediaRecorder chunks. */
export interface SavedRecording extends RecordingMeta {
  chunks: Blob[];
}

/** A meta row as stored (chunks kept in the same record). */
interface StoredRecording extends RecordingMeta {
  chunks: Blob[];
}

function getFactory(factory?: IDBFactory): IDBFactory {
  const f = factory ?? globalThis.indexedDB;
  if (!f) throw new Error("IndexedDB is not available in this browser.");
  return f;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openRecordingsDb(factory?: IDBFactory): Promise<IDBDatabase> {
  const dbFactory = getFactory(factory);
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = dbFactory.open(RECORDINGS_DB_NAME, RECORDINGS_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDINGS_STORE_NAME)) {
        const store = db.createObjectStore(RECORDINGS_STORE_NAME, { keyPath: "id" });
        store.createIndex("startedAt", "startedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open recordings database"));
  });
}

/**
 * Build the metadata for a finished recording. durationMs is derived
 * from the timestamps (never trusted from the client clock alone —
 * both come from the same device, so the difference is meaningful).
 */
export function buildRecordingMeta(input: {
  id: string;
  sessionId: string;
  deviceName: string;
  startedAt: number;
  endedAt: number;
  sizeBytes: number;
  mimeType: string;
  videoKind: RecordingVideoKind;
  hasAudio: boolean;
}): RecordingMeta {
  return {
    id: input.id,
    sessionId: input.sessionId,
    deviceName: input.deviceName,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType,
    videoKind: input.videoKind,
    hasAudio: input.hasAudio,
  };
}

/** Save one finished recording (metadata + chunks, one record). */
export async function saveRecording(
  record: SavedRecording,
  factory?: IDBFactory,
): Promise<void> {
  const db = await openRecordingsDb(factory);
  try {
    const tx = db.transaction(RECORDINGS_STORE_NAME, "readwrite");
    const store = tx.objectStore(RECORDINGS_STORE_NAME);
    const stored: StoredRecording = {
      id: record.id,
      sessionId: record.sessionId,
      deviceName: record.deviceName,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: record.durationMs,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType,
      videoKind: record.videoKind,
      hasAudio: record.hasAudio,
      chunks: record.chunks,
    };
    await requestToPromise(store.add(stored));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save recording"));
      tx.onabort = () => reject(tx.error ?? new Error("Could not save recording"));
    });
  } finally {
    db.close();
  }
}

/** List recording metadata, newest first — chunks are NOT loaded. */
export async function listRecordingMetas(factory?: IDBFactory): Promise<RecordingMeta[]> {
  const db = await openRecordingsDb(factory);
  try {
    const tx = db.transaction(RECORDINGS_STORE_NAME, "readonly");
    const store = tx.objectStore(RECORDINGS_STORE_NAME);
    const rows = await requestToPromise(store.getAll() as IDBRequest<StoredRecording[]>);
    return rows
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        deviceName: row.deviceName,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationMs: row.durationMs,
        sizeBytes: row.sizeBytes,
        mimeType: row.mimeType,
        videoKind: row.videoKind,
        hasAudio: row.hasAudio,
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
  } finally {
    db.close();
  }
}

/** Load one recording's playback blob (assembled from its chunks). */
export async function loadRecordingBlob(
  id: string,
  factory?: IDBFactory,
): Promise<{ meta: RecordingMeta; blob: Blob } | null> {
  const db = await openRecordingsDb(factory);
  try {
    const tx = db.transaction(RECORDINGS_STORE_NAME, "readonly");
    const store = tx.objectStore(RECORDINGS_STORE_NAME);
    const row = await requestToPromise(store.get(id) as IDBRequest<StoredRecording | undefined>);
    if (!row) return null;
    const meta: RecordingMeta = {
      id: row.id,
      sessionId: row.sessionId,
      deviceName: row.deviceName,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      sizeBytes: row.sizeBytes,
      mimeType: row.mimeType,
      videoKind: row.videoKind,
      hasAudio: row.hasAudio,
    };
    return { meta, blob: new Blob(row.chunks, { type: row.mimeType || "video/webm" }) };
  } finally {
    db.close();
  }
}

/** Delete one recording (metadata + chunks). No-op when missing. */
export async function deleteRecording(id: string, factory?: IDBFactory): Promise<void> {
  const db = await openRecordingsDb(factory);
  try {
    const tx = db.transaction(RECORDINGS_STORE_NAME, "readwrite");
    const store = tx.objectStore(RECORDINGS_STORE_NAME);
    await requestToPromise(store.delete(id) as IDBRequest<undefined>);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not delete recording"));
      tx.onabort = () => reject(tx.error ?? new Error("Could not delete recording"));
    });
  } finally {
    db.close();
  }
}
