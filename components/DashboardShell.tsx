"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { Button, Wordmark } from "./ui";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/devices", label: "My Devices" },
  { href: "/dashboard/connect", label: "Connect Device" },
  { href: "/dashboard/requests", label: "Connection Requests" },
  { href: "/dashboard/remote-access", label: "Remote Access" },
  { href: "/dashboard/trusted-devices", label: "Trusted Devices" },
  { href: "/dashboard/security", label: "Security Center" },
  { href: "/dashboard/history", label: "Session History" },
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
    const supabase = createBrowserSupabaseClient();
    if (supabase) await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-[#080D12] lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-[#1E2D38] bg-[#0D141B] p-5 lg:flex">
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
                className={`rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-[#00E5A8]/10 text-[#00E5A8]"
                    : "text-[#8FA3A0] hover:bg-white/5 hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto pt-6">
          <p className="truncate text-xs text-[#8FA3A0]">{userEmail ?? "Not signed in"}</p>
          <Button variant="outline" className="mt-3 w-full" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="flex items-center justify-between border-b border-[#1E2D38] bg-[#0D141B] px-4 py-3 lg:hidden">
        <Link href="/dashboard">
          <Wordmark />
        </Link>
        <Button variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      </header>

      <main className="flex-1 px-4 py-6 pb-24 sm:px-6 lg:pb-8 lg:pt-8">{children}</main>

      {/* Mobile bottom navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex overflow-x-auto border-t border-[#1E2D38] bg-[#0D141B] px-2 py-2 lg:hidden">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`shrink-0 rounded-lg px-3 py-2 text-xs font-medium whitespace-nowrap ${
                active ? "bg-[#00E5A8]/10 text-[#00E5A8]" : "text-[#8FA3A0]"
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
