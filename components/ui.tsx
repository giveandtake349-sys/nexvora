import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { SUPABASE_NOT_CONFIGURED_MESSAGE } from "@/lib/supabase/config";
import { SCOPE_LABELS, type PermissionScope } from "@/lib/permissions";

/** Geometric Tech Symbol — the NEXVORA logo (inline SVG, no stock image). */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-label="NEXVORA logo">
      <path d="M24 3 42 13.5v21L24 45 6 34.5v-21L24 3Z" stroke="#00E5A8" strokeWidth="2.5" />
      <path d="M24 12 34 18v12l-10 6-10-6V18l10-6Z" fill="#00E5A8" fillOpacity="0.16" stroke="#D4AF37" strokeWidth="1.5" />
      <circle cx="24" cy="24" r="3.5" fill="#00E5A8" />
      <path d="M24 12v8.5M24 27.5V36M14 18l7 4M34 18l-7 4" stroke="#00E5A8" strokeWidth="1.5" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <Logo />
      <span className="leading-none">
        <span className="block text-lg font-bold tracking-[0.22em] text-white">NEXVORA</span>
        <span className="block text-[9px] font-medium tracking-[0.3em] text-[#00E5A8]">
          ONE ECOSYSTEM. EVERY DEVICE.
        </span>
      </span>
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "gold" | "ghost" | "danger" | "outline";
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  const styles: Record<string, string> = {
    primary: "bg-[#00E5A8] text-[#080D12] hover:bg-[#33ecb8]",
    gold: "bg-[#D4AF37] text-[#080D12] hover:bg-[#e0bd55]",
    ghost: "bg-transparent text-[#8FA3A0] hover:text-white hover:bg-white/5",
    danger: "bg-red-500/15 text-red-300 border border-red-500/40 hover:bg-red-500/25",
    outline:
      "bg-transparent text-[#E8F0EE] border border-[#1E2D38] hover:border-[#00E5A8] hover:text-[#00E5A8]",
  };
  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`glass rounded-2xl p-5 ${className}`}>{children}</div>;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-[#1E2D38] bg-[#0D141B] px-3.5 py-2.5 text-sm text-white placeholder:text-[#8FA3A0] outline-none focus:border-[#00E5A8] ${props.className ?? ""}`}
    />
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1.5 block text-xs font-semibold tracking-wide text-[#8FA3A0] uppercase">{children}</label>;
}

export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "green" | "gold" | "red" | "blue";
}) {
  const tones: Record<string, string> = {
    muted: "bg-white/5 text-[#8FA3A0] border-white/10",
    green: "bg-[#00E5A8]/10 text-[#00E5A8] border-[#00E5A8]/30",
    gold: "bg-[#D4AF37]/10 text-[#D4AF37] border-[#D4AF37]/30",
    red: "bg-red-500/10 text-red-300 border-red-500/30",
    blue: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function ScopeBadge({ scope }: { scope: PermissionScope }) {
  return <Badge tone="green">{SCOPE_LABELS[scope]}</Badge>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#1E2D38] p-8 text-center">
      <p className="font-semibold text-white">{title}</p>
      <p className="mt-1 text-sm text-[#8FA3A0]">{body}</p>
    </div>
  );
}

/** Shown on every auth/data surface when no Supabase project is configured. */
export function ConfigNotice() {
  return (
    <div className="rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/10 p-4 text-sm text-[#E8F0EE]">
      <p className="font-semibold text-[#D4AF37]">Supabase not configured</p>
      <p className="mt-1">{SUPABASE_NOT_CONFIGURED_MESSAGE}</p>
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      <p className="mt-1 text-sm text-[#8FA3A0]">{subtitle}</p>
    </div>
  );
}
