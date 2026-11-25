import Link from "next/link";
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
 * Milestone 1 remote-access workspace: permission shell only.
 * There is NO live media in Milestone 1, so every live card shows
 * Disconnected. A card shows "Granted" only when a real, valid grant
 * exists — never an active state without a real connection.
 */
export default async function RemoteAccessPage() {
  const data = await getDashboardData();
  return (
    <div>
      <PageHeader
        title="Remote Access"
        subtitle="One card per feature, each with its own permission and state. Live screen, camera, microphone and speaker arrive in Milestone 3; file transfer, location and remote interaction in Milestone 4."
      />
      <div className="mb-6 rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/10 p-4 text-sm text-[#E8F0EE]">
        Live screen / camera / microphone require explicit OS + browser consent at use time (Milestone 3).
        A NEXVORA grant alone never turns on a camera or microphone.
      </div>
      {!data.configured && <ConfigNotice />}
      {data.configured && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PERMISSION_SCOPES.map((scope) => {
            const grant = data.grantedToMe.find((g) => g.scope === scope);
            const validity = grant ? checkGrantValidity(grant, grant.device_id) : "not_found";
            const granted = validity === "valid";
            const milestone = SCOPE_MILESTONE[scope];
            const deviceName =
              data.devices.find((d) => d.id === grant?.device_id)?.name ?? "a device you were granted access to";
            return (
              <Card key={scope}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-white">{SCOPE_LABELS[scope]}</h3>
                  <Badge tone={granted ? "green" : "muted"}>{granted ? "Granted" : "Not granted"}</Badge>
                </div>
                <p className="mt-2 text-sm text-[#8FA3A0]">{SCOPE_DESCRIPTIONS[scope]}</p>
                <div className="mt-3 flex items-center gap-2 text-sm">
                  <span className="inline-block h-2 w-2 rounded-full bg-[#8FA3A0]" />
                  <span className="text-[#8FA3A0]">Disconnected — no live connection in Milestone 1</span>
                </div>
                {grant && (
                  <p className="mt-2 text-xs text-[#8FA3A0]">
                    Grant on {deviceName} ·{" "}
                    {grant.expires_at ? `expires ${new Date(grant.expires_at).toLocaleDateString()}` : "no expiry"} ·{" "}
                    {validity === "expired" ? "expired" : validity === "revoked" ? "revoked" : "valid"}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href="/dashboard/connect">
                    <Button variant="outline">Request Access</Button>
                  </Link>
                  {granted && grant && (
                    <RevokePermissionButton permissionId={grant.id} scope={SCOPE_LABELS[scope]} />
                  )}
                  {milestone > 1 && (
                    <Badge tone="gold">Live in Milestone {milestone}</Badge>
                  )}
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
      )}
    </div>
  );
}
