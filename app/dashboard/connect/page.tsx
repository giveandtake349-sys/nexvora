import { getDashboardData } from "@/lib/dashboard-data";
import { Card, ConfigNotice, PageHeader } from "@/components/ui";
import { GenerateCodeForm, RedeemCodeForm } from "@/components/DashboardActions";

export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const data = await getDashboardData();
  return (
    <div>
      <PageHeader
        title="Connect Device"
        subtitle="Share a device with another user, or enter a code to request access to theirs. A code only creates a request — the owner must approve it."
      />
      {!data.configured && <ConfigNotice />}
      {data.configured && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="font-semibold text-white">Share one of my devices</h2>
            <p className="mt-1 mb-4 text-sm text-[#8FA3A0]">
              Generate a temporary 6-digit code (10 minutes, single use). The other user enters it below.
            </p>
            <GenerateCodeForm devices={data.devices.map((d) => ({ id: d.id, name: d.name }))} />
          </Card>
          <Card>
            <h2 className="font-semibold text-white">Request access with a code</h2>
            <p className="mt-1 mb-4 text-sm text-[#8FA3A0]">
              Choose the permissions you need. The owner sees your request and picks which ones to grant.
            </p>
            <RedeemCodeForm />
          </Card>
        </div>
      )}
    </div>
  );
}
