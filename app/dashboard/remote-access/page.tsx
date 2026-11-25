import { getDashboardData } from "@/lib/dashboard-data";
import {
  PERMISSION_SCOPES,
  SCOPE_DESCRIPTIONS,
  SCOPE_LABELS,
  SCOPE_MILESTONE,
  checkGrantValidity,
} from "@/lib/permissions";
import { Badge, Button, Card, ConfigNotice, PageHeader } from "@/components/ui";
import { RevokePermissionButton } from "@/components/DashboardActions";

export const dynamic = "force-dynamic";

/**
 * Milestone 3 remote-access workspace: permission shell + live sessions.
 * Live screen / camera / microphone / speaker run in a live session
 * (dedicated /dashboard/sessions/[id] page, WebRTC over the Milestone 2
 * signaling API), as do the Milestone 4 features (file transfer,
 * location, remote interaction, notification feed). A card shows
 * "Granted" only when a real, valid grant exists, and a session shows
 * as joinable only when it is really active — never an active state
 * without a real connection.
 */
export default async function RemoteAccessPage() {
  const data = await getDashboardData();
  const activeSessions = data.sessions.filter((s) => s.status === "active");
  return (
    <div>
      <PageHeader
        title="Remote Access"
        subtitle="One card per feature, each with its own permission and state. Live screen, camera, microphone and speaker run in live sessions (Milestone 3); file transfer, location, remote interaction and the notification feed run in the same live sessions (Milestone 4)."
      />
      <div className="mb-6 rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/10 p-4 text-sm text-[#E8F0EE]">
        Live screen / camera / microphone require explicit OS + browser consent at use time. A
        NEXVORA grant alone never turns on a camera or microphone — the device owner starts every
        track from the live session and can stop it instantly.
      </div>
      {!data.configured && <ConfigNotice />}
      {data.configured && (
        <>
          <Card className="mb-6">
            <h2 className="font-semibold text-white">Live sessions</h2>
            {activeSessions.length === 0 ? (
              <p className="mt-2 text-sm text-[#8FA3A0]">
                No active sessions right now. Approve a connection request and the session appears
                here — joining it starts the live screen / camera / microphone call.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {activeSessions.map((s) => {
                  const deviceName =
                    data.devices.find((d) => d.id === s.device_id)?.name ?? "Remote device";
                  return (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center justify-between gap-3 text-sm"
                    >
                      <span className="text-[#E8F0EE]">
                        {deviceName} · started {new Date(s.started_at).toLocaleString()} ·{" "}
                        {s.signaling_state}
                      </span>
                      <Button href={`/dashboard/sessions/${s.id}`}>Join live session</Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PERMISSION_SCOPES.map((scope) => {
              const grant = data.grantedToMe.find((g) => g.scope === scope);
              const validity = grant ? checkGrantValidity(grant, grant.device_id) : "not_found";
              const granted = validity === "valid";
              const milestone = SCOPE_MILESTONE[scope];
              const deviceName =
                data.devices.find((d) => d.id === grant?.device_id)?.name ?? "a device you were granted access to";
              const liveNow = milestone <= 4;
              return (
                <Card key={scope}>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-white">{SCOPE_LABELS[scope]}</h3>
                    <Badge tone={granted ? "green" : "muted"}>{granted ? "Granted" : "Not granted"}</Badge>
                  </div>
                  <p className="mt-2 text-sm text-[#8FA3A0]">{SCOPE_DESCRIPTIONS[scope]}</p>
                  <div className="mt-3 flex items-center gap-2 text-sm">
                    <span className="inline-block h-2 w-2 rounded-full bg-[#8FA3A0]" />
                    <span className="text-[#8FA3A0]">
                      {scope === "device_info"
                        ? "Device name, OS, browser and last-seen status are shown on the My Devices page."
                        : liveNow
                          ? activeSessions.length > 0
                            ? "Live in sessions — join one from Live sessions above to start sharing."
                            : "Disconnected — no live session right now. Join an active session above to start sharing."
                          : "Disconnected — no live media yet."}
                    </span>
                  </div>
                  {grant && (
                    <p className="mt-2 text-xs text-[#8FA3A0]">
                      Grant on {deviceName} ·{" "}
                      {grant.expires_at ? `expires ${new Date(grant.expires_at).toLocaleDateString()}` : "no expiry"} ·{" "}
                      {validity === "expired" ? "expired" : validity === "revoked" ? "revoked" : "valid"}
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="outline" href="/dashboard/connect">
                      Request Access
                    </Button>
                    {granted && grant && (
                      <RevokePermissionButton permissionId={grant.id} scope={SCOPE_LABELS[scope]} />
                    )}
                    {milestone > 4 && (
                      <Badge tone="gold">Live in Milestone {milestone}</Badge>
                    )}
                    {milestone === 3 && <Badge tone="green">Live in Milestone 3</Badge>}
                    {milestone === 4 && <Badge tone="green">Live in Milestone 4</Badge>}
                  </div>
                </Card>
              );
            })}
            <Card>
              <h3 className="font-semibold text-white">How access works</h3>
              <p className="mt-2 text-sm leading-relaxed text-[#8FA3A0]">
                Request Access takes you to the Connect page, where you enter a
                pairing code from the device owner. The owner approves only the
                permissions they choose. Valid grants are reused on reconnect —
                you are not asked again until a grant expires, is revoked, or a
                new permission is needed.
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
