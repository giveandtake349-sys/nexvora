"use client";

import { useEffect, useState } from "react";

type Quality = "Low" | "Balanced" | "High";

const QUALITY_INFO: Record<Quality, { res: string; fps: string; latency: string }> = {
  Low: { res: "854 × 480", fps: "15 fps", latency: "~180 ms" },
  Balanced: { res: "1280 × 720", fps: "30 fps", latency: "~120 ms" },
  High: { res: "1920 × 1080", fps: "60 fps", latency: "~90 ms" },
};

const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

function formatClock(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function reducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Interactive demo of the live controller — no real device is connected.
 * Tap the screen to move the cursor, type with the on-screen keyboard,
 * switch quality, or end the session. The full-view overlay is an in-page
 * overlay (not the browser's fullscreen API).
 */
export default function LiveControlDemo({ variant }: { variant: "phone" | "wide" }) {
  const [open, setOpen] = useState(false);
  const [recSeconds, setRecSeconds] = useState(7);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>({ x: 62, y: 38 });
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  const [log, setLog] = useState<string[]>(["Connected to Pixel 8 (demo)"]);
  const [note, setNote] = useState("Buy milk, call Amma");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [quality, setQuality] = useState<Quality>("Balanced");
  const [ended, setEnded] = useState(false);
  const [toggles, setToggles] = useState({ screen: true, camera: true, mic: true, location: false });

  useEffect(() => {
    if (ended) return;
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [ended]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open ]);

  const pushLog = (entry: string) => setLog((l) => [entry, ...l].slice(0, 4));

  const handleScreenClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (ended) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 100);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 100);
    setCursor({ x, y });
    if (!reducedMotion()) {
      const id = Date.now();
      setRipple({ x, y, id });
      setTimeout(() => setRipple((r) => (r && r.id === id ? null : r)), 600);
    }
    pushLog(`Tap at ${x}%, ${y}%`);
  };

  const handleScreenKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (ended) return;
    if (e.key === "Backspace") {
      setNote((n) => n.slice(0, -1));
    } else if (e.key.length === 1) {
      setNote((n) => (n + e.key).slice(0, 120));
    }
  };

  const pressKey = (key: string) => {
    if (ended) return;
    if (key === "backspace") setNote((n) => n.slice(0, -1));
    else if (key === "space") setNote((n) => (n + " ").slice(0, 120));
    else setNote((n) => (n + key).slice(0, 120));
  };

  const endSession = () => {
    setEnded(true);
    setOpen(false);
    pushLog("Session ended (demo)");
  };

  const reconnect = () => {
    setEnded(false);
    setRecSeconds(0);
    setLog(["Connected to Pixel 8 (demo)"]);
  };

  const permissionsOn = Object.values(toggles).filter(Boolean).length;

  const renderScreen = (large: boolean) => (
    <div
      role="button"
      tabIndex={0}
      aria-label="Demo remote screen. Activate to move the cursor, or type to edit the note."
      onClick={handleScreenClick}
      onKeyDown={handleScreenKey}
      className={`relative w-full cursor-pointer overflow-hidden rounded-xl bg-gradient-to-br from-[#0D1B26] via-[#10222E] to-[#0A141B] outline-none focus-visible:ring-2 focus-visible:ring-[#00E5A8] ${
        large ? "h-[320px] sm:h-[420px]" : variant === "phone" ? "h-[300px]" : "h-[300px] sm:h-[340px]"
      }`}
    >
      {/* status bar */}
      <div className="flex items-center justify-between px-4 pt-3 text-[11px] text-[#8FA3A0]">
        <span>21:02</span>
        <span>Pixel 8 · Demo</span>
        <span>▰▰▰▱ 82%</span>
      </div>
      {/* live + rec row */}
      <div className="mt-3 flex items-center justify-between px-4">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-0.5 text-[11px] font-bold text-red-300">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400" /> LIVE
        </span>
        <span className="rounded-full bg-black/40 px-2.5 py-0.5 text-[11px] font-semibold text-white">
          ● REC {formatClock(recSeconds)}
        </span>
      </div>
      {/* demo app content */}
      <div className="mx-4 mt-4 rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <p className="text-[11px] font-semibold tracking-wide text-[#8FA3A0] uppercase">Notes</p>
        <p className="mt-1 min-h-5 text-sm text-white">{note || "Tap to type…"}</p>
        <p className="mt-3 text-[11px] text-[#8FA3A0]">
          Owner granted screen, camera &amp; mic at pairing. Recording is on — the owner sees the REC dot too.
        </p>
      </div>
      <div className="mx-4 mt-3 flex gap-2">
        {["Messages", "Photos", "Maps"].map((app) => (
          <span
            key={app}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-[#E8F0EE]"
          >
            {app}
          </span>
        ))}
      </div>
      <p className="absolute inset-x-0 bottom-3 text-center text-[11px] text-[#8FA3A0]">
        {ended ? "Session ended" : "Tap anywhere to move the cursor · Tap Full view for the big screen"}
      </p>
      {/* cursor */}
      {cursor && !ended && (
        <span
          aria-hidden
          className="pointer-events-none absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#00E5A8] shadow-lg transition-all duration-500"
          style={{ left: `${cursor.x}%`, top: `${cursor.y}%` }}
        />
      )}
      {/* ripple */}
      {ripple && !ended && (
        <span
          aria-hidden
          key={ripple.id}
          className="pointer-events-none absolute z-10 h-10 w-10 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-[#00E5A8]"
          style={{ left: `${ripple.x}%`, top: `${ripple.y}%` }}
        />
      )}
      {ended && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#080D12]/85">
          <p className="font-semibold text-white">Session ended</p>
          <p className="text-sm text-[#8FA3A0]">This was an interactive demo — no real device was connected.</p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              reconnect();
            }}
            className="rounded-full bg-[#00E5A8] px-4 py-2 text-sm font-semibold text-[#080D12] hover:bg-[#33ecb8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]"
          >
            Reconnect
          </button>
        </div>
      )}
    </div>
  );

  const renderControls = () => (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setKeyboardOpen((v) => !v)}
        className="rounded-full border border-[#1E2D38] px-3 py-1.5 text-xs font-semibold text-[#E8F0EE] hover:border-[#00E5A8] hover:text-[#00E5A8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]"
      >
        {keyboardOpen ? "Hide keyboard" : "Keyboard"}
      </button>
      <div className="flex items-center gap-1 rounded-full border border-[#1E2D38] p-0.5" role="group" aria-label="Stream quality">
        {(["Low", "Balanced", "High"] as Quality[]).map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => {
              setQuality(q);
              pushLog(`Quality → ${q} (${QUALITY_INFO[q].res})`);
            }}
            aria-pressed={quality === q}
            className={`rounded-full px-2.5 py-1 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8] ${
              quality === q ? "bg-[#00E5A8] text-[#080D12]" : "text-[#8FA3A0] hover:text-white"
            }`}
          >
            {q}
          </button>
        ))}
      </div>
      <span className="text-xs text-[#8FA3A0]">
        {QUALITY_INFO[quality].res} · {QUALITY_INFO[quality].fps} · {QUALITY_INFO[quality].latency}
      </span>
      <span className="ml-auto" />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]"
      >
        Full view
      </button>
      <button
        type="button"
        onClick={endSession}
        className="rounded-full bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-300 border border-red-500/40 hover:bg-red-500/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]"
      >
        End session
      </button>
    </div>
  );

  const renderKeyboard = () =>
    keyboardOpen &&
    !ended && (
      <div className="mt-3 rounded-xl border border-[#1E2D38] bg-[#0D141B] p-2">
        {KEY_ROWS.map((row) => (
          <div key={row} className="flex justify-center gap-1 py-0.5">
            {row.split("").map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => pressKey(k)}
                className="h-8 w-7 rounded-md bg-white/5 text-sm text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[#00E5A8] sm:w-8"
              >
                {k}
              </button>
            ))}
          </div>
        ))}
        <div className="flex justify-center gap-1 py-0.5">
          <button
            type="button"
            onClick={() => pressKey("space")}
            className="h-8 w-40 rounded-md bg-white/5 text-sm text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[#00E5A8]"
          >
            Space
          </button>
          <button
            type="button"
            onClick={() => pressKey("backspace")}
            className="h-8 w-16 rounded-md bg-white/5 text-sm text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[#00E5A8]"
          >
            ⌫
          </button>
        </div>
      </div>
    );

  const renderLog = () => (
    <ul className="mt-3 space-y-1 text-xs text-[#8FA3A0]" aria-live="polite">
      {log.map((entry, i) => (
        <li key={`${entry}-${i}`}>› {entry}</li>
      ))}
    </ul>
  );

  if (variant === "phone") {
    return (
      <div className="mx-auto w-full max-w-[400px]">
        <div className="rounded-[2rem] border border-[#1E2D38] bg-[#0D141B] p-2.5 shadow-2xl shadow-black/50">
          <div className="mx-auto mb-2 h-1.5 w-24 rounded-full bg-white/10" aria-hidden />
          {renderScreen(false)}
          <div className="mt-3 px-1">
            <p className="flex items-center justify-between text-xs text-[#8FA3A0]">
              <span>Permissions on</span>
              <span className="font-semibold text-white">
                {permissionsOn} of 4
              </span>
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  ["screen", "Screen"],
                  ["camera", "Camera"],
                  ["mic", "Microphone"],
                  ["location", "Location"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="switch"
                  aria-checked={toggles[key]}
                  onClick={() => setToggles((t) => ({ ...t, [key]: !t[key] }))}
                  className="flex items-center justify-between rounded-lg border border-[#1E2D38] bg-white/[0.03] px-3 py-2 text-xs font-semibold text-[#E8F0EE] hover:border-[#00E5A8]/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]"
                >
                  {label}
                  <span
                    className={`inline-block h-4 w-7 rounded-full p-0.5 transition-colors ${
                      toggles[key] ? "bg-[#00E5A8]" : "bg-white/15"
                    }`}
                  >
                    <span
                      className={`block h-3 w-3 rounded-full bg-white transition-transform ${
                        toggles[key] ? "translate-x-3" : ""
                      }`}
                    />
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-3 w-full rounded-full bg-[#00E5A8] px-4 py-2 text-sm font-semibold text-[#080D12] hover:bg-[#33ecb8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]"
            >
              Tap for full view
            </button>
            <p className="mt-2 text-center text-[11px] text-[#8FA3A0]">
              Illustrated demo — no real device is connected.
            </p>
          </div>
        </div>
        {open && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Live controller, full view (demo)"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setOpen(false)}
          >
            <div
              className="w-full max-w-3xl rounded-2xl border border-[#1E2D38] bg-[#080D12] p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between">
                <p className="font-semibold text-white">
                  Live controller <span className="text-xs font-normal text-[#8FA3A0]">· Pixel 8 · demo</span>
                </p>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close full view"
                  className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]"
                >
                  ✕ Close · Esc
                </button>
              </div>
              {renderScreen(true)}
              {renderControls()}
              {renderKeyboard()}
              {renderLog()}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {renderScreen(false)}
      {renderControls()}
      {renderKeyboard()}
      {renderLog()}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Live controller, full view (demo)"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-3xl rounded-2xl border border-[#1E2D38] bg-[#080D12] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="font-semibold text-white">
                Live controller <span className="text-xs font-normal text-[#8FA3A0]">· Pixel 8 · demo</span>
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close full view"
                className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]"
              >
                ✕ Close · Esc
              </button>
            </div>
            {renderScreen(true)}
            {renderControls()}
            {renderKeyboard()}
            {renderLog()}
          </div>
        </div>
      )}
    </div>
  );
}
