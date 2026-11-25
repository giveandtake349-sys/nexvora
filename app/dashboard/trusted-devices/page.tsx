import { getDashboardData } from "@/lib/dashboard-data";
import { checkGrantValidity } from "@/lib/permissions";
import { Badge, Card, ConfigNotice, EmptyState, PageHeader, ScopeBadge } from "@/components/ui";
import { DisconnectSessionButton, RevokeDeviceButton, RevokePermissionButton } from "@/components/DashboardActions";

export const dynamic = "force-dynamic";

export default async function TrustedDevicesPage() {
  const data = await getDashboardData();
  return (
    <div>
      <PageHeader
        title="Trusted Devices"
        subtitle="Review every grant on your devices, change access, revoke a device, or disconnect its sessions. Revocation takes effect immediately."
      />
      {!data.configured && <ConfigNotice />}
      {data.configured && (
        <>
          {data.devices.length === 0 ? (
            <EmptyState title="No devices yet" body="Register a device first — grants appear here once you approve a connection request." />
          ) : (
            <div className="grid gap-4">
              {data.devices.map((device) => {
                const grants = data.myPermissions.filter((p) => p.device_id === device.id);
                const liveGrants = grants.filter((g) => checkGrantValidity(g, device.id) === "valid");
                const sessions = data.sessions.filter((s) => s.device_id === device.id && s.status === "active");
                return (
                  <Card key={device.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-white">{device.name}</h3>
                        <p className="mt-1 text-sm text-[#8FA3A0]">
                          {device.os ?? "Unknown OS"} · {device.browser ?? "Unknown browser"} ·{" "}
                          {device.last_seen_at ? `last seen ${new Date(device.last_seen_at).toLocaleString()}` : "never seen"}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Badge tone={liveGrants.length > 0 ? "green" : "muted"}>
                          {liveGrants.length} live grant(s)
                        </Badge>
                        <RevokeDeviceButton deviceId={device.id} deviceName={device.name} />
                      </div>
                    </div>

                    {grants.length === 0 ? (
                      <p className="mt-4 text-sm text-[#8FA3A0]">No permissions granted on this device yet.</p>
                    ) : (
                      <ul className="mt-4 space-y-3">
                        {grants.map((g) => {
                          const validity = checkGrantValidity(g, device.id);
                          return (
                            <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1E2D38] p-3">
                              <div>
                                <ScopeBadge scope={g.scope} />
                                <p className="mt-1.5 text-xs text-[#8FA3A0]">
                                  Granted to <span className="font-mono">{g.granted_to_user_id.slice(0, 8)}…</span> ·{" "}
                                  {new Date(g.granted_at).toLocaleDateString()} ·{" "}
                                  {g.expires_at ? `expires ${new Date(g.expires_at).toLocaleDateString()}` : "no expiry"}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge tone={validity === "valid" ? "green" : validity === "expired" ? "gold" : "red"}>
                                  {validity}
                                </Badge>
                                {!g.is_revoked && (
                                  <RevokePermissionButton permissionId={g.id} scope={g.scope} />
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {sessions.length > 0 && (
                      <div className="mt-4">
                        <p className="text-sm font-semibold text-white">Active sessions on this device</p>
                        <ul className="mt-2 space-y-2">
                          {sessions.map((s) => (
                            <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                              <span className="text-[#8FA3A0]">Started {new Date(s.started_at).toLocaleString()}</span>
                              <DisconnectSessionButton sessionId={s.id} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
