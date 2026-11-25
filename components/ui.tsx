import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { NEON_AUTH_NOT_CONFIGURED_MESSAGE } from "@/lib/db/config";
import { SCOPE_LABELS, type PermissionScope } from "@/lib/permissions";

import Image from "next/image";

/** Official NEXVORA logo mark — the white hexagonal N, transparent background. */
export function Logo({ size = 32 }: { size?: number }) {
  const width = Math.round((size * 268) / 305);
  return (
    <Image src="/logo.png" alt="NEXVORA logo" width={width} height={size} className="shrink-0" />
  );
}

/**
 * Spec Chapter 1 logo lockup: NEXVORA wordmark, Space Grotesk 22/700,
 * tracking 0.04em, with a 32×3px teal underline.
 */
export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <Logo />
      <span className="leading-none">
        <span className="block font-display text-[22px] font-bold tracking-[0.04em] text-white">
          NEXVORA
        </span>
        <span className="mt-1 block h-[3px] w-8 rounded-full bg-[#00E5A8]" aria-hidden="true" />
        <span className="mt-1 block text-[9px] font-medium tracking-[0.3em] text-[#00E5A8]">
          ONE ECOSYSTEM. EVERY DEVICE.
        </span>
      </span>
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "gold" | "ghost" | "danger" | "outline" | "glass";
  /** When set, renders a real link styled as a button (never a <button> nested inside an <a> — that markup is invalid and taps on it do nothing on mobile browsers). */
  href?: string;
};

/**
 * Spec Chapter 0 + 7: radius 14, 44px min touch target, press
 * 150ms ease-out scale 0.97, focus ring 2px teal offset 2px.
 * Danger is a solid #FF4757 fill (spec: End session / Delete).
 */
export function Button({ variant = "primary", className = "", href, ...props }: ButtonProps) {
  const base =
    "pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[14px] px-4 py-2.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8] disabled:cursor-not-allowed disabled:opacity-40";
  const styles: Record<string, string> = {
    primary: "bg-[#00E5A8] text-[#062018] hover:bg-[#00C790]",
    gold: "bg-[#D4AF37] text-[#080D12] hover:bg-[#e0bd55]",
    ghost: "bg-transparent text-[#8FA3A0] hover:text-white hover:bg-white/5",
    danger: "bg-[#FF4757] text-white hover:bg-[#ff5c6b]",
    outline:
      "bg-transparent text-[#F2F7F5] border border-[#1E2D38] hover:border-[#00E5A8] hover:text-[#00E5A8]",
    glass:
      "bg-[rgba(18,27,36,0.72)] text-[#F2F7F5] border border-white/10 backdrop-blur-[20px] hover:border-white/20",
  };
  const cls = `${base} ${styles[variant]} ${className}`;
  if (href) {
    return (
      <Link href={href} className={cls}>
        {props.children}
      </Link>
    );
  }
  return <button className={cls} {...props} />;
}

/** Spec Chapter 0: cards radius 20, padding 16, border + shadow. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`glass rounded-[20px] p-4 shadow-[0_8px_24px_rgba(0,0,0,0.35)] ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Spec Chapter 1: input h 48, radius 12, bg surface-2; focus teal
 * border 1.5px + 4px glow rgba(0,229,168,0.25); error via className.
 */
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-12 w-full rounded-xl border border-[#1E2D38] bg-[#121B24] px-3.5 text-[15px] text-white placeholder:text-[rgba(242,247,245,0.38)] outline-none focus:border-[#00E5A8] focus:shadow-[0_0_0_4px_rgba(0,229,168,0.25)] disabled:opacity-50 ${props.className ?? ""}`}
    />
  );
}

/** Spec Chapter 0: micro label — 10/12 uppercase, letter-spacing 0.06em. */
export function Label({ children }: { children: ReactNode }) {
  return (
    <label className="mb-1.5 block text-[10px] leading-3 font-bold tracking-[0.06em] text-[rgba(242,247,245,0.62)] uppercase">
      {children}
    </label>
  );
}

export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "green" | "gold" | "red" | "blue";
}) {
  const tones: Record<string, string> = {
    muted: "bg-white/5 text-[rgba(242,247,245,0.62)] border-white/10",
    green: "bg-[#00E5A8]/10 text-[#00E5A8] border-[#00E5A8]/30",
    gold: "bg-[#D4AF37]/10 text-[#D4AF37] border-[#D4AF37]/30",
    red: "bg-[#FF4757]/10 text-[#FF4757] border-[#FF4757]/30",
    blue: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function ScopeBadge({ scope }: { scope: PermissionScope }) {
  return <Badge tone="green">{SCOPE_LABELS[scope]}</Badge>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[20px] border border-dashed border-[#1E2D38] p-8 text-center">
      <p className="font-semibold text-white">{title}</p>
      <p className="mt-1 text-sm text-[#8FA3A0]">{body}</p>
    </div>
  );
}

/** Shown on every auth/data surface when Neon Auth is not configured. */
export function ConfigNotice() {
  return (
    <div className="rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/10 p-4 text-sm text-[#F2F7F5]">
      <p className="font-semibold text-[#D4AF37]">Neon Auth not configured</p>
      <p className="mt-1">{NEON_AUTH_NOT_CONFIGURED_MESSAGE}</p>
    </div>
  );
}

/** Spec Chapter 0: H1 28/34 700, subtitle secondary 13/18. */
export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-[28px] leading-[34px] font-bold text-white">{title}</h1>
      <p className="mt-1 text-[13px] leading-[18px] text-[rgba(242,247,245,0.62)]">{subtitle}</p>
    </div>
  );
}

/**
 * Spec Chapter 7 toggle: off track rgba(255,255,255,0.08) with
 * #F2F7F5 knob; on teal track with #062018 knob; 150ms fill.
 * Default 44×26; `compact` renders the 36×20 first-look size.
 */
export function Toggle({
  on,
  onChange,
  label,
  disabled = false,
  compact = false,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const size = compact ? "h-5 w-9" : "h-[26px] w-11";
  const knob = compact ? "h-4 w-4" : "h-[22px] w-[22px]";
  const translate = compact ? "translate-x-4" : "translate-x-5";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`pressable relative inline-flex shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8] disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-[#00E5A8]" : "bg-white/10"
      } ${size}`}
    >
      <span
        className={`inline-block rounded-full transition-transform ${
          on ? "bg-[#062018]" : "bg-[#F2F7F5]"
        } ${knob} ${on ? translate : "translate-x-0.5"}`}
      />
    </button>
  );
}
