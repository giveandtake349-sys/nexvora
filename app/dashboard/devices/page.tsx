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
          <p className="mt-6 mb-3 text-[10px] leading-3 font-bold tracking-[0.06em] text-[rgba(242,247,245,0.62)] uppercase">
            Paired · {data.devices.length} device{data.devices.length === 1 ? "" : "s"}
          </p>
          <div className="grid gap-3">
            {data.devices.length === 0 ? (
              <EmptyState title="No devices yet" body="Register this browser as your first device using the form above." />
            ) : (
              data.devices.map((d) => {
                const online = isDeviceOnline(d.last_seen_at);
                const grants = data.myPermissions.filter((p) => p.device_id === d.id && !p.is_revoked);
                return (
                  <Card key={d.id} className="p-3">
                    <div className="flex items-start gap-3">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-[#00E5A8]/10 font-display text-lg font-bold text-[#00E5A8]" aria-hidden="true">
                        {d.name.trim().charAt(0).toUpperCase() || "D"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[15px] leading-5 font-semibold text-white">{d.name}</h3>
                        <p className="mt-0.5 text-xs text-[#8FA3A0]">
                          {d.os ?? "Unknown OS"} · {d.browser ?? "Unknown browser"} · {d.platform}
                        </p>
                        <p className="text-xs text-[#8FA3A0]">
                          Last seen: {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never"}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Badge tone={online ? "green" : "muted"}>
                            <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${online ? "bg-[#00E5A8]" : "bg-[#8FA3A0]"}`} />
                            {online ? "Online" : "Offline"}
                          </Badge>
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
