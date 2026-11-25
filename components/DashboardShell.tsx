"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { authClient } from "@/lib/auth/client";
import { Button, Wordmark } from "./ui";

const APK_URL =
  "https://l4olg2qubqwtv2jv.public.blob.vercel-storage.com/NEXVORA-v0.1.0.apk";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/devices", label: "My Devices" },
  { href: "/dashboard/connect", label: "Connect Device" },
  { href: "/dashboard/requests", label: "Connection Requests" },
  { href: "/dashboard/remote-access", label: "Remote Access" },
  { href: "/dashboard/trusted-devices", label: "Trusted Devices" },
  { href: "/dashboard/security", label: "Security Center" },
  { href: "/dashboard/history", label: "Session History" },
  { href: "/dashboard/recordings", label: "Recordings" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashboardShell({
  children,
  userEmail,
}: {
  children: ReactNode;
  userEmail: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-[#080D12] lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-white/10 bg-[#0D141B] p-5 lg:flex">
        <Link href="/dashboard">
          <Wordmark />
        </Link>
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`pressable rounded-[14px] px-3 py-2.5 text-sm font-medium ${
                  active
                    ? "bg-[#00E5A8]/10 text-[#00E5A8]"
                    : "text-[rgba(242,247,245,0.62)] hover:bg-white/5 hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto pt-6">
          <p className="truncate text-xs text-[#8FA3A0]">{userEmail ?? "Not signed in"}</p>
          <a
            href={APK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 flex w-full items-center justify-center rounded-[14px] bg-[#00E5A8] px-3 py-2.5 text-sm font-semibold text-[#062018] transition hover:bg-[#33ecb8] active:scale-[0.98]"
          >
            Download App
          </a>
          <Button variant="outline" className="mt-3 w-full" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="glass sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3 lg:hidden">
        <Link href="/dashboard">
          <Wordmark />
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={APK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-full bg-[#00E5A8] px-3 py-2 text-xs font-bold text-[#062018] transition hover:bg-[#33ecb8] active:scale-[0.97]"
          >
            Download App
          </a>
          <Button variant="ghost" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-24 sm:px-6 lg:pb-8 lg:pt-8">{children}</main>

      {/* Mobile bottom navigation */}
      <nav className="glass fixed inset-x-0 bottom-0 z-10 flex overflow-x-auto border-t border-white/10 px-2 py-2 lg:hidden">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`shrink-0 rounded-full px-3 py-2 text-xs font-medium whitespace-nowrap ${
                active ? "bg-[#00E5A8]/10 text-[#00E5A8]" : "text-[rgba(242,247,245,0.62)]"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
