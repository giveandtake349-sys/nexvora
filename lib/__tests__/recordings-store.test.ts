/**
 * Recordings IndexedDB store tests — the store wrapper runs against a
 * hand-rolled in-memory fake IDBFactory (vitest runs in node, which
 * has no indexedDB, and no fake-indexeddb package is installed).
 * The fake implements exactly the IDB surface the wrapper uses:
 * open (+ onupgradeneeded creating the store), transaction,
 * objectStore, add / get / getAll / delete, and transaction
 * completion. Covers: save + list (newest first), load blob,
 * delete, duplicate-key rejection, and the missing-IndexedDB guard.
 */
import { describe, it, expect } from "vitest";
import {
  RECORDINGS_STORE_NAME,
  buildRecordingMeta,
  deleteRecording,
  listRecordingMetas,
  loadRecordingBlob,
  saveRecording,
  type SavedRecording,
} from "../recordings";

/* ---------------- minimal in-memory fake IndexedDB ---------------- */

class FakeIDBRequest<T = unknown> {
  result: T | undefined = undefined;
  error: Error | null = null;
  onsuccess: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  succeed(result: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({}));
  }

  fail(error: Error): void {
    this.error = error;
    queueMicrotask(() => this.onerror?.({}));
  }
}

class FakeObjectStore {
  private records = new Map<string, unknown>();
  private currentTx: FakeTransaction | null = null;

  constructor(private readonly keyPath: string) {}

  bind(tx: FakeTransaction): this {
    this.currentTx = tx;
    return this;
  }

  createIndex(): Record<string, unknown> {
    return {};
  }

  add(value: Record<string, unknown>): FakeIDBRequest<string> {
    const req = new FakeIDBRequest<string>();
    const key = String(value[this.keyPath]);
    if (this.records.has(key)) {
      req.fail(new Error("Key already exists"));
    } else {
      this.records.set(key, value);
      req.succeed(key);
    }
    this.currentTx?.scheduleComplete();
    return req;
  }

  get(key: string): FakeIDBRequest<unknown> {
    const req = new FakeIDBRequest<unknown>();
    req.succeed(this.records.get(key));
    this.currentTx?.scheduleComplete();
    return req;
  }

  getAll(): FakeIDBRequest<unknown[]> {
    const req = new FakeIDBRequest<unknown[]>();
    req.succeed([...this.records.values()]);
    this.currentTx?.scheduleComplete();
    return req;
  }

  delete(key: string): FakeIDBRequest<undefined> {
    const req = new FakeIDBRequest<undefined>();
    this.records.delete(key);
    req.succeed(undefined);
    this.currentTx?.scheduleComplete();
    return req;
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private completeScheduled = false;

  constructor(private readonly stores: Map<string, FakeObjectStore>) {}

  objectStore(name: string): FakeObjectStore {
    const store = this.stores.get(name);
    if (!store) throw new Error(`No such object store: ${name}`);
    return store.bind(this);
  }

  scheduleComplete(): void {
    if (this.completeScheduled) return;
    this.completeScheduled = true;
    // Macrotask, not microtask: the wrapper assigns tx.oncomplete
    // only after the request promise resolves, so completing on a
    // microtask would fire before the handler exists.
    setTimeout(() => this.oncomplete?.(), 0);
  }
}

class FakeIDBDatabase {
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };
  private readonly stores = new Map<string, FakeObjectStore>();

  createObjectStore(name: string, options: { keyPath: string }): FakeObjectStore {
    const store = new FakeObjectStore(options.keyPath);
    this.stores.set(name, store);
    return store;
  }

  transaction(storeName: string): FakeTransaction {
    void storeName;
    return new FakeTransaction(this.stores);
  }

  close(): void {
    // No-op in the fake.
  }
}

class FakeIDBFactory {
  private readonly databases = new Map<string, FakeIDBDatabase>();

  open(name: string): FakeIDBRequest<FakeIDBDatabase> {
    const req = new FakeIDBRequest<FakeIDBDatabase>();
    let db = this.databases.get(name);
    const isNew = !db;
    if (!db) {
      db = new FakeIDBDatabase();
      this.databases.set(name, db);
    }
    const target = db;
    setTimeout(() => {
      // First open for a name runs the upgrade (creates the store);
      // later opens go straight to success — like the real API.
      // result is set BEFORE the upgrade fires: the upgrade handler
      // reads request.result to create the store.
      req.result = target;
      if (isNew) {
        (req as unknown as { onupgradeneeded: ((event: unknown) => void) | null }).onupgradeneeded?.(
          {},
        );
      }
      req.succeed(target);
    }, 0);
    return req;
  }
}

function fakeFactory(): IDBFactory {
  return new FakeIDBFactory() as unknown as IDBFactory;
}

function makeRecording(overrides: Partial<SavedRecording> = {}): SavedRecording {
  return {
    id: "rec-1",
    sessionId: "session-1",
    deviceName: "Muse Test Laptop",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_065_000,
    durationMs: 65_000,
    sizeBytes: 3,
    mimeType: "video/webm",
    videoKind: "screen",
    hasAudio: true,
    chunks: [new Blob(["ab"]), new Blob(["c"])],
    ...overrides,
  };
}

describe("recordings IndexedDB store", () => {
  it("saves and lists recordings, newest first", async () => {
    const factory = fakeFactory();
    await saveRecording(makeRecording({ id: "old", startedAt: 1000, endedAt: 2000 }), factory);
    await saveRecording(makeRecording({ id: "new", startedAt: 3000, endedAt: 4000 }), factory);
    const metas = await listRecordingMetas(factory);
    expect(metas.map((m) => m.id)).toEqual(["new", "old"]);
    expect(metas[0]).toMatchObject({
      deviceName: "Muse Test Laptop",
      videoKind: "screen",
      hasAudio: true,
    });
  });

  it("loads a recording blob assembled from its chunks", async () => {
    const factory = fakeFactory();
    await saveRecording(makeRecording(), factory);
    const loaded = await loadRecordingBlob("rec-1", factory);
    expect(loaded).not.toBeNull();
    expect(loaded?.meta.id).toBe("rec-1");
    expect(loaded?.blob.size).toBe(3);
    expect(loaded?.blob.type).toBe("video/webm");
    expect(await loadRecordingBlob("missing", factory)).toBeNull();
  });

  it("deletes a recording and lists it no more", async () => {
    const factory = fakeFactory();
    await saveRecording(makeRecording(), factory);
    await deleteRecording("rec-1", factory);
    expect(await listRecordingMetas(factory)).toEqual([]);
    // Deleting a missing id is a no-op, not an error.
    await deleteRecording("rec-1", factory);
  });

  it("rejects a duplicate id (add, not put)", async () => {
    const factory = fakeFactory();
    await saveRecording(makeRecording(), factory);
    await expect(saveRecording(makeRecording(), factory)).rejects.toThrow();
  });

  it("throws a clear error when IndexedDB is unavailable", async () => {
    await expect(saveRecording(makeRecording())).rejects.toThrow("IndexedDB is not available");
  });
});

describe("buildRecordingMeta", () => {
  it("derives duration from the timestamps and passes fields through", () => {
    const meta = buildRecordingMeta({
      id: "r1",
      sessionId: "s1",
      deviceName: "Phone",
      startedAt: 1000,
      endedAt: 66_000,
      sizeBytes: 1234,
      mimeType: "video/webm",
      videoKind: "camera",
      hasAudio: false,
    });
    expect(meta.durationMs).toBe(65_000);
    expect(meta.videoKind).toBe("camera");
    expect(meta.hasAudio).toBe(false);
    expect(meta.sizeBytes).toBe(1234);
  });

  it("never reports a negative duration", () => {
    const meta = buildRecordingMeta({
      id: "r1",
      sessionId: "s1",
      deviceName: "Phone",
      startedAt: 5000,
      endedAt: 1000,
      sizeBytes: 0,
      mimeType: "video/webm",
      videoKind: "none",
      hasAudio: true,
    });
    expect(meta.durationMs).toBe(0);
  });

  it("keeps the store name stable (the page and the recorder must agree)", () => {
    expect(RECORDINGS_STORE_NAME).toBe("recordings");
  });
});
