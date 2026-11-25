import { getDashboardData } from "@/lib/dashboard-data";
import { Badge, Card, ConfigNotice, EmptyState, PageHeader, ScopeBadge } from "@/components/ui";
import { DecideRequestForm } from "@/components/DashboardActions";

export const dynamic = "force-dynamic";

export default async function RequestsPage() {
  const data = await getDashboardData();
  const pending = data.incomingRequests.filter((r) => r.status === "pending");
  const decided = data.incomingRequests.filter((r) => r.status !== "pending");
  return (
    <div>
      <PageHeader title="Connection Requests" subtitle="Approve or reject requests to your devices. Only the scopes you check are granted." />
      {!data.configured && <ConfigNotice />}
      {data.configured && (
        <>
          <h2 className="mb-3 font-semibold text-white">Incoming — awaiting your decision</h2>
          {pending.length === 0 ? (
            <EmptyState title="No pending requests" body="When someone enters your pairing code, their request appears here." />
          ) : (
            <div className="grid gap-4">
              {pending.map((r) => (
                <Card key={r.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-[#E8F0EE]">
                      Request from <span className="font-mono text-xs">{r.requester_user_id.slice(0, 8)}…</span>
                    </p>
                    <Badge tone="gold">Pending</Badge>
                  </div>
                  <p className="mt-1 text-xs text-[#8FA3A0]">
                    Received {new Date(r.created_at).toLocaleString()} · target device{" "}
                    <span className="font-mono">{r.target_device_id.slice(0, 8)}…</span>
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {r.requested_scopes.map((s) => (
                      <ScopeBadge key={s} scope={s} />
                    ))}
                  </div>
                  <div className="mt-4">
                    <DecideRequestForm requestId={r.id} requestedScopes={r.requested_scopes} />
                  </div>
                </Card>
              ))}
            </div>
          )}

          <h2 className="mt-8 mb-3 font-semibold text-white">My outgoing requests</h2>
          {data.outgoingRequests.length === 0 ? (
            <EmptyState title="No outgoing requests" body="Requests you send from the Connect page appear here." />
          ) : (
            <div className="grid gap-4">
              {data.outgoingRequests.map((r) => (
                <Card key={r.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-[#E8F0EE]">{r.requested_scopes.length} permission(s) requested</p>
                    <Badge tone={r.status === "approved" ? "green" : r.status === "rejected" ? "red" : "gold"}>
                      {r.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-[#8FA3A0]">Sent {new Date(r.created_at).toLocaleString()}</p>
                </Card>
              ))}
            </div>
          )}

          {decided.length > 0 && (
            <>
              <h2 className="mt-8 mb-3 font-semibold text-white">Decided incoming requests</h2>
              <div className="grid gap-4">
                {decided.slice(0, 10).map((r) => (
                  <Card key={r.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-[#E8F0EE]">{r.requested_scopes.length} permission(s) requested</p>
                      <Badge tone={r.status === "approved" ? "green" : "red"}>{r.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-[#8FA3A0]">
                      Decided {r.decided_at ? new Date(r.decided_at).toLocaleString() : "—"}
                    </p>
                  </Card>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
