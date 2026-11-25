import { getDashboardData } from "@/lib/dashboard-data";
import { isDeviceOnline } from "@/lib/device";
import { Badge, Button, Card, ConfigNotice, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getDashboardData();
  if (!data.configured) {
    return (
      <div>
        <PageHeader title="Overview" subtitle="Your devices, requests and sessions at a glance." />
        <ConfigNotice />
        <p className="mt-4 text-sm text-[#8FA3A0]">
          Once Neon is configured, this page shows your real devices, pending connection requests,
          active sessions and recent security events. Follow the setup steps in README.md.
        </p>
      </div>
    );
  }
  if (!data.user) {
    return (
      <div>
        <PageHeader title="Overview" subtitle="Your devices, requests and sessions at a glance." />
        <EmptyState title="Sign in required" body="Please sign in to see your dashboard." />
        <div className="mt-4">
          <Button href="/login">Sign in</Button>
        </div>
      </div>
    );
  }

  const pending = data.incomingRequests.filter((r) => r.status === "pending");
  const activeSessions = data.sessions.filter((s) => s.status === "active");
  const onlineDevices = data.devices.filter((d) => isDeviceOnline(d.last_seen_at));
  const liveGrants = data.myPermissions.filter((p) => !p.is_revoked);

  return (
    <div>
      <PageHeader title="Overview" subtitle={`Welcome back, ${data.user.displayName ?? data.user.email}.`} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-[10px] leading-3 font-bold tracking-[0.06em] text-[rgba(242,247,245,0.62)] uppercase">My devices</p>
          <p className="mt-2 font-display text-[28px] leading-[34px] font-bold text-white">{data.devices.length}</p>
          <p className="text-sm text-[#8FA3A0]">{onlineDevices.length} online now</p>
        </Card>
        <Card>
          <p className="text-[10px] leading-3 font-bold tracking-[0.06em] text-[rgba(242,247,245,0.62)] uppercase">Pending requests</p>
          <p className="mt-2 font-display text-[28px] leading-[34px] font-bold text-[#D4AF37]">{pending.length}</p>
          <p className="text-sm text-[#8FA3A0]">awaiting your approval</p>
        </Card>
        <Card>
          <p className="text-[10px] leading-3 font-bold tracking-[0.06em] text-[rgba(242,247,245,0.62)] uppercase">Active sessions</p>
          <p className="mt-2 font-display text-[28px] leading-[34px] font-bold text-[#00E5A8]">{activeSessions.length}</p>
          <p className="text-sm text-[#8FA3A0]">live connections</p>
        </Card>
        <Card>
          <p className="text-[10px] leading-3 font-bold tracking-[0.06em] text-[rgba(242,247,245,0.62)] uppercase">Live grants</p>
          <p className="mt-2 font-display text-[28px] leading-[34px] font-bold text-white">{liveGrants.length}</p>
          <p className="text-sm text-[#8FA3A0]">permissions you granted</p>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-white">Pending connection requests</h2>
          {pending.length === 0 ? (
            <p className="mt-3 text-sm text-[#8FA3A0]">No pending requests. New requests appear here for your approval.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {pending.slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-[#E8F0EE]">
                    {r.requested_scopes.length} permission(s) requested
                  </span>
                  <Badge tone="gold">Pending</Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <Button variant="outline" href="/dashboard/requests">
              Review requests
            </Button>
          </div>
        </Card>
        <Card>
          <h2 className="font-semibold text-white">Active sessions</h2>
          {activeSessions.length === 0 ? (
            <p className="mt-3 text-sm text-[#8FA3A0]">No active sessions right now.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {activeSessions.slice(0, 5).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-[#E8F0EE]">Session started {new Date(s.started_at).toLocaleString()}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone="green">Active</Badge>
                    <Button variant="outline" href={`/dashboard/sessions/${s.id}`}>
                      Join live session
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex gap-2">
            <Button variant="outline" href="/dashboard/devices">
              My Devices
            </Button>
            <Button variant="outline" href="/dashboard/connect">
              Connect a device
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
