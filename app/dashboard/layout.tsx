import type { ReactNode } from "react";
import DashboardShell from "@/components/DashboardShell";
import { getDashboardData } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const data = await getDashboardData();
  return <DashboardShell userEmail={data.user?.email ?? null}>{children}</DashboardShell>;
}
