"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, EmptyState } from "./ui";
import {
  formatRecordingDuration,
  formatRecordingSize,
  recordingFileName,
} from "@/lib/recording";
import {
  deleteRecording,
  listRecordingMetas,
  loadRecordingBlob,
  type RecordingMeta,
} from "@/lib/recordings";

const VIDEO_KIND_LABELS: Record<RecordingMeta["videoKind"], string> = {
  screen: "Screen",
  camera: "Camera",
  none: "Audio only",
};

/**
 * Recordings list (client component) — reads from this browser's
 * IndexedDB only. Nothing here touches the server: v1 recordings
 * are never uploaded, and a recording made in another browser (or
 * after clearing site data) simply is not listed here. The UI says
 * so, so an empty list is never mistaken for "no recordings exist".
 *
 * Spec Chapter 5: storage bar (real, from navigator.storage),
 * card with duration badge, 36px glass icon buttons, delete
 * confirm sheet, inline player.
 */
export default function RecordingsList() {
  const [metas, setMetas] = useState<RecordingMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);
  const playingUrlRef = useRef<string | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setMetas(await listRecordingMetas());
    } catch {
      setError("Could not read recordings from this browser.");
    } finally {
      setLoading(false);
    }
  }

  // Initial load: state is set only inside the async callbacks, never
  // synchronously in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    // Loading already starts true (useState initial value) — no
    // synchronous setState here (react-hooks/set-state-in-effect).
    listRecordingMetas()
      .then((list) => {
        if (cancelled) return;
        setMetas(list);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Could not read recordings from this browser.");
        setLoading(false);
      });
    // Real storage usage for this origin (best-effort).
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      navigator.storage
        .estimate()
        .then((est) => {
          if (cancelled) return;
          if (typeof est.usage === "number" && typeof est.quota === "number" && est.quota > 0) {
            setStorage({ used: est.usage, quota: est.quota });
          }
        })
        .catch(() => {
          // Storage estimate unavailable — the bar simply stays hidden.
        });
    }
    return () => {
      cancelled = true;
      if (playingUrlRef.current) URL.revokeObjectURL(playingUrlRef.current);
    };
  }, []);

  function stopPlaying(): void {
    if (playingUrlRef.current) URL.revokeObjectURL(playingUrlRef.current);
    playingUrlRef.current = null;
    setPlayingUrl(null);
    setPlayingId(null);
  }

  async function play(id: string): Promise<void> {
    if (playingId === id) {
      stopPlaying();
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      const loaded = await loadRecordingBlob(id);
      if (!loaded) {
        setError("That recording is no longer in this browser.");
        await refresh();
        return;
      }
      stopPlaying();
      const url = URL.createObjectURL(loaded.blob);
      playingUrlRef.current = url;
      setPlayingUrl(url);
      setPlayingId(id);
    } catch {
      setError("Could not load that recording.");
    } finally {
      setBusyId(null);
    }
  }

  async function download(id: string, meta: RecordingMeta): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      const loaded = await loadRecordingBlob(id);
      if (!loaded) {
        setError("That recording is no longer in this browser.");
        await refresh();
        return;
      }
      const url = URL.createObjectURL(loaded.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = recordingFileName(meta.deviceName, meta.startedAt);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError("Could not download that recording.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      if (playingId === id) stopPlaying();
      await deleteRecording(id);
      setMetas((current) => current.filter((m) => m.id !== id));
    } catch {
      setError("Could not delete that recording.");
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-[#8FA3A0]">Loading recordings…</p>;
  }

  const usedBytes = metas.reduce((sum, m) => sum + m.sizeBytes, 0);
  const confirmMeta = confirmDeleteId ? metas.find((m) => m.id === confirmDeleteId) : undefined;

  return (
    <div>
      {/* Spec Ch. 5 header: storage bar + Newest sort (list is newest-first). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {storage ? (
          <div className="min-w-0 flex-1">
            <p className="text-xs text-[#8FA3A0]">
              {formatRecordingSize(storage.used)} of {formatRecordingSize(storage.quota)} used
              {usedBytes > 0 && ` · recordings use ${formatRecordingSize(usedBytes)}`}
            </p>
            <div className="mt-2 h-1 w-full max-w-xs overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-[#00E5A8]"
                style={{ width: `${Math.min(100, (storage.used / storage.quota) * 100)}%` }}
              />
            </div>
          </div>
        ) : (
          <p className="text-xs text-[#8FA3A0]">
            {metas.length > 0 && `Recordings use ${formatRecordingSize(usedBytes)} in this browser.`}
          </p>
        )}
        <span className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 text-xs font-semibold text-white">
          Newest
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </div>

      <p className="mt-4 text-sm text-[#8FA3A0]">
        Recordings are stored only in this browser (IndexedDB) — nothing is uploaded to the
        server. Clearing this browser&apos;s site data deletes them, and recordings made in
        another browser do not appear here.
      </p>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {metas.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No recordings in this browser"
            body="Record a live session from its Session recording card (the device owner approves first) and it will appear here."
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          {metas.map((meta) => (
            <Card key={meta.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[15px] leading-5 font-semibold text-white">
                    {meta.deviceName}{" "}
                    <Badge tone="muted">{VIDEO_KIND_LABELS[meta.videoKind]}</Badge>{" "}
                    {meta.hasAudio && <Badge tone="muted">Audio</Badge>}
                  </p>
                  <p className="mt-1 text-xs text-[#8FA3A0]">
                    {new Date(meta.startedAt).toLocaleString()} ·{" "}
                    {formatRecordingDuration(meta.durationMs)} ·{" "}
                    {formatRecordingSize(meta.sizeBytes)} · .webm
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-white/10 bg-black/40 px-2 py-0.5 font-display text-[10px] leading-3 font-bold tracking-[0.06em] text-white tabular-nums">
                  {formatRecordingDuration(meta.durationMs)}
                </span>
              </div>
              {playingId === meta.id && playingUrl && (
                <video
                  src={playingUrl}
                  controls
                  autoPlay
                  playsInline
                  className="mt-3 w-full overflow-hidden rounded-2xl bg-black"
                />
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  aria-label={playingId === meta.id ? "Hide player" : "Play recording"}
                  title={playingId === meta.id ? "Hide player" : "Play"}
                  disabled={busyId === meta.id}
                  onClick={() => void play(meta.id)}
                  className="pressable flex h-9 w-9 items-center justify-center rounded-[14px] border border-white/10 bg-white/5 text-[#00E5A8] disabled:opacity-40"
                >
                  {playingId === meta.id ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <rect x="5" y="4" width="5" height="16" rx="1" />
                      <rect x="14" y="4" width="5" height="16" rx="1" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M7 4.5v15l13-7.5-13-7.5z" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Download recording"
                  title="Download .webm"
                  disabled={busyId === meta.id}
                  onClick={() => void download(meta.id, meta)}
                  className="pressable flex h-9 w-9 items-center justify-center rounded-[14px] border border-white/10 bg-white/5 text-white disabled:opacity-40"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v12" />
                    <path d="M6 11l6 6 6-6" />
                    <path d="M4 21h16" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label="Delete recording"
                  title="Delete"
                  disabled={busyId === meta.id}
                  onClick={() => setConfirmDeleteId(meta.id)}
                  className="pressable flex h-9 w-9 items-center justify-center rounded-[14px] border border-white/10 bg-white/5 text-[#FF4757] disabled:opacity-40"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 7h16" />
                    <path d="M9 7V5h6v2" />
                    <path d="M6 7l1 13h10l1-13" />
                  </svg>
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Spec Ch. 5 delete flow: confirm sheet. */}
      {confirmMeta && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            className="sheet-up glass w-full max-w-[428px] rounded-t-[20px] p-4 pb-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white">Delete recording?</h3>
            <p className="mt-1 text-sm text-[#8FA3A0]">
              {confirmMeta.deviceName} · {new Date(confirmMeta.startedAt).toLocaleString()}.
              This can&apos;t be undone.
            </p>
            <div className="mt-4 space-y-2">
              <Button
                variant="danger"
                className="h-11 w-full"
                disabled={busyId === confirmMeta.id}
                onClick={() => void remove(confirmMeta.id)}
              >
                Delete
              </Button>
              <Button
                variant="glass"
                className="h-11 w-full"
                onClick={() => setConfirmDeleteId(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
