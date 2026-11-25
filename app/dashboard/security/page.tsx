import { getDashboardData } from "@/lib/dashboard-data";
import { Badge, Card, ConfigNotice, PageHeader } from "@/components/ui";
import { DisconnectAllButton, DisconnectSessionButton } from "@/components/DashboardActions";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const data = await getDashboardData();
  const activeSessions = data.sessions.filter((s) => s.status === "active");
  const pending = data.incomingRequests.filter((r) => r.status === "pending");
  return (
    <div>
      <PageHeader title="Security Center" subtitle="Active sessions, pending requests, permission history and audit logs." />
      {!data.configured && <ConfigNotice />}
      {data.configured && (
        <div className="grid gap-4">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold text-white">Active sessions ({activeSessions.length})</h2>
              <DisconnectAllButton />
            </div>
            {activeSessions.length === 0 ? (
              <p className="mt-3 text-sm text-[#8FA3A0]">No active sessions.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {activeSessions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                    <span className="text-[#E8F0EE]">
                      Started {new Date(s.started_at).toLocaleString()} · device{" "}
                      <span className="font-mono text-xs">{s.device_id.slice(0, 8)}…</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone="green">Active</Badge>
                      <DisconnectSessionButton sessionId={s.id} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="font-semibold text-white">Pending connection requests ({pending.length})</h2>
            {pending.length === 0 ? (
              <p className="mt-3 text-sm text-[#8FA3A0]">Nothing awaiting your decision.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {pending.map((r) => (
                  <li key={r.id} className="text-sm text-[#E8F0EE]">
                    {r.requested_scopes.length} permission(s) requested · {new Date(r.created_at).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="font-semibold text-white">Permission history</h2>
            {data.myPermissions.length === 0 ? (
              <p className="mt-3 text-sm text-[#8FA3A0]">No grants yet. Grants, changes and revocations are listed here.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.myPermissions.slice(0, 20).map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-[#E8F0EE]">
                      {p.scope} → <span className="font-mono text-xs">{p.granted_to_user_id.slice(0, 8)}…</span>
                    </span>
                    <span className="flex gap-2">
                      <Badge tone={p.is_revoked ? "red" : "green"}>{p.is_revoked ? "Revoked" : "Live"}</Badge>
                      {p.expires_at && (
                        <Badge tone="gold">expires {new Date(p.expires_at).toLocaleDateString()}</Badge>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="font-semibold text-white">Security events (audit log)</h2>
            {data.securityEvents.length === 0 ? (
              <p className="mt-3 text-sm text-[#8FA3A0]">
                No security events recorded yet. Grants, revocations, pairing outcomes and disconnects are logged here.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.securityEvents.slice(0, 30).map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-mono text-xs text-[#E8F0EE]">{e.action}</span>
                    <span className="text-xs text-[#8FA3A0]">{new Date(e.created_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="font-semibold text-white">Login history</h2>
            <p className="mt-3 text-sm text-[#8FA3A0]">
              Login history is recorded from Neon Auth events in Milestone 1 via the security audit log
              (sign-ins that go through this app write a <span className="font-mono">session.started</span> event
              when a connection is approved). A dedicated auth-event table is a Milestone 2 hardening item —
              no login rows are invented here.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
