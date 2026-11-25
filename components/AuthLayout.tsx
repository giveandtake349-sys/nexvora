import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "./ui";

/**
 * Spec Chapter 1 — Sign-In: single centered column over #080D12 with
 * a subtle teal radial glow at top; logo lockup, H1 "Access anything,
 * from anywhere." (28/34), glass form card (radius 20, padding 20).
 */
export default function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#080D12] px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_at_top,rgba(0,229,168,0.06),transparent_70%)]"
      />
      <div className="relative mt-6">
        <Link href="/">
          <Wordmark />
        </Link>
      </div>
      <h1 className="relative mt-8 text-center text-[28px] leading-[34px] font-bold text-white">
        Access anything, from anywhere.
      </h1>
      <div className="glass relative mt-8 w-full max-w-md rounded-[20px] p-5 shadow-[0_8px_24px_rgba(0,0,0,0.35)] sm:p-6">
        <h2 className="text-xl font-bold text-white">{title}</h2>
        <p className="mt-1 text-sm text-[#8FA3A0]">{subtitle}</p>
        <div className="mt-6">{children}</div>
        <div className="mt-6 text-center text-[13px] text-[#8FA3A0]">{footer}</div>
      </div>
    </div>
  );
}
