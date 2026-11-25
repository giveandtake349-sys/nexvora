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
 */
export default function RecordingsList() {
  const [metas, setMetas] = useState<RecordingMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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
    }
  }

  if (loading) {
    return <p className="text-sm text-[#8FA3A0]">Loading recordings…</p>;
  }

  return (
    <div>
      <p className="text-sm text-[#8FA3A0]">
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
        <div className="mt-4 grid gap-4">
          {metas.map((meta) => (
            <Card key={meta.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-white">
                  {meta.deviceName}{" "}
                  <Badge tone="muted">{VIDEO_KIND_LABELS[meta.videoKind]}</Badge>{" "}
                  {meta.hasAudio && <Badge tone="muted">Audio</Badge>}
                </p>
                <p className="text-xs text-[#8FA3A0]">
                  {new Date(meta.startedAt).toLocaleString()}
                </p>
              </div>
              <p className="mt-1 text-sm text-[#8FA3A0]">
                {formatRecordingDuration(meta.durationMs)} · {formatRecordingSize(meta.sizeBytes)} ·{" "}
                .webm
              </p>
              {playingId === meta.id && playingUrl && (
                <video
                  src={playingUrl}
                  controls
                  autoPlay
                  playsInline
                  className="mt-3 w-full overflow-hidden rounded-xl bg-black"
                />
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busyId === meta.id}
                  onClick={() => void play(meta.id)}
                >
                  {playingId === meta.id ? "Hide player" : "Play"}
                </Button>
                <Button
                  variant="outline"
                  disabled={busyId === meta.id}
                  onClick={() => void download(meta.id, meta)}
                >
                  Download .webm
                </Button>
                <Button
                  variant="danger"
                  disabled={busyId === meta.id}
                  onClick={() => void remove(meta.id)}
                >
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
