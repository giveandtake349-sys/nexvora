import { getDashboardData } from "@/lib/dashboard-data";
import { Badge, Card, ConfigNotice, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const data = await getDashboardData();
  return (
    <div>
      <PageHeader title="Session History" subtitle="Past sessions and session events, newest first." />
      {!data.configured && <ConfigNotice />}
      {data.configured && (
        <>
          {data.sessions.length === 0 ? (
            <EmptyState title="No sessions yet" body="Sessions appear here once a connection request is approved." />
          ) : (
            <div className="grid gap-4">
              {data.sessions.map((s) => (
                <Card key={s.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-[#E8F0EE]">
                      Started {new Date(s.started_at).toLocaleString()}
                      {s.ended_at ? ` · ended ${new Date(s.ended_at).toLocaleString()}` : ""}
                    </p>
                    <Badge tone={s.status === "active" ? "green" : s.status === "revoked" ? "red" : "muted"}>
                      {s.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-[#8FA3A0]">
                    Device <span className="font-mono">{s.device_id.slice(0, 8)}…</span> · participant{" "}
                    <span className="font-mono">{s.participant_user_id.slice(0, 8)}…</span>
                  </p>
                </Card>
              ))}
            </div>
          )}
          {data.sessionEvents.length > 0 && (
            <>
              <h2 className="mt-8 mb-3 font-semibold text-white">Session events</h2>
              <Card>
                <ul className="space-y-2">
                  {data.sessionEvents.slice(0, 30).map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="font-mono text-xs text-[#E8F0EE]">{e.action}</span>
                      <span className="text-xs text-[#8FA3A0]">{new Date(e.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
