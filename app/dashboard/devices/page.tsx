import { getDashboardData } from "@/lib/dashboard-data";
import { isDeviceOnline } from "@/lib/device";
import { Badge, Card, ConfigNotice, EmptyState, PageHeader } from "@/components/ui";
import { RegisterDeviceForm, RemoveDeviceButton } from "@/components/DashboardActions";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const data = await getDashboardData();
  return (
    <div>
      <PageHeader title="My Devices" subtitle="Register, rename and remove your devices. Online means seen in the last 5 minutes." />
      {!data.configured && <ConfigNotice />}
      {data.configured && (
        <>
          <Card>
            <RegisterDeviceForm />
          </Card>
          <div className="mt-6 grid gap-4">
            {data.devices.length === 0 ? (
              <EmptyState title="No devices yet" body="Register this browser as your first device using the form above." />
            ) : (
              data.devices.map((d) => {
                const online = isDeviceOnline(d.last_seen_at);
                const grants = data.myPermissions.filter((p) => p.device_id === d.id && !p.is_revoked);
                return (
                  <Card key={d.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-white">{d.name}</h3>
                        <p className="mt-1 text-sm text-[#8FA3A0]">
                          {d.os ?? "Unknown OS"} · {d.browser ?? "Unknown browser"} · {d.platform}
                        </p>
                        <p className="text-sm text-[#8FA3A0]">
                          Last seen: {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never"}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <Badge tone={online ? "green" : "muted"}>{online ? "Online" : "Offline"}</Badge>
                          {d.is_trusted && <Badge tone="gold">Trusted</Badge>}
                          <Badge tone="blue">{grants.length} live grant(s)</Badge>
                        </div>
                      </div>
                      <RemoveDeviceButton deviceId={d.id} deviceName={d.name} />
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
