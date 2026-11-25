import { getDashboardData } from "@/lib/dashboard-data";
import { checkGrantValidity, type PermissionScope } from "@/lib/permissions";
import { Button, Card, ConfigNotice, EmptyState, PageHeader } from "@/components/ui";
import LiveSession from "@/components/LiveSession";

export const dynamic = "force-dynamic";

/**
 * Dedicated live-session page (Milestone 3) — /dashboard/sessions/[id].
 *
 * Why a dedicated page instead of embedding the session in the Remote
 * Access page: a live call wants the full screen (remote video,
 * controls, track states) and a deep link the other side can open
 * directly; the Remote Access page stays the permission workspace and
 * links here for every active session. The page creates NO session —
 * it only renders the LiveSession client component for a session that
 * already exists (approved in Milestone 1) and is still active. The
 * component itself calls the Milestone 2 start endpoint on Join.
 *
 * Server-side checks here: the caller must be a party of the session
 * (owner or participant) and the session must still be active. The
 * granted media scopes are computed server-side from valid grants —
 * the owner implicitly holds all eight on their own device; a
 * participant gets only the scopes with a live, unrevoked, unexpired
 * grant. The client never decides grant validity.
 */
const MEDIA_SCOPES: PermissionScope[] = ["screen", "camera", "microphone", "speaker"];
/** Milestone 4 scopes, live in the same session (file transfer /
 *  location / remote interaction / notifications). */
const MILESTONE_4_SCOPES: PermissionScope[] = [
  "file_transfer",
  "location",
  "remote_interaction",
  "notifications",
];
const LIVE_SCOPES: PermissionScope[] = [...MEDIA_SCOPES, ...MILESTONE_4_SCOPES];

export default async function LiveSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getDashboardData();

  if (!data.configured) {
    return (
      <div>
        <PageHeader title="Live session" subtitle="Start a live screen, camera and microphone session." />
        <ConfigNotice />
      </div>
    );
  }
  if (!data.user) {
    return (
      <div>
        <PageHeader title="Live session" subtitle="Start a live screen, camera and microphone session." />
        <EmptyState title="Sign in required" body="Please sign in to join a live session." />
        <div className="mt-4">
          <Button href="/login">Sign in</Button>
        </div>
      </div>
    );
  }

  const session = data.sessions.find((s) => s.id === id);
  if (!session) {
    return (
      <div>
        <PageHeader title="Live session" subtitle="Start a live screen, camera and microphone session." />
        <EmptyState title="Session not found" body="This session does not exist or is not yours." />
        <div className="mt-4">
          <Button variant="outline" href="/dashboard/remote-access">
            Back to Remote Access
          </Button>
        </div>
      </div>
    );
  }

  const isOwner = session.owner_id === data.user.id;
  const isParticipant = session.participant_user_id === data.user.id;
  if (!isOwner && !isParticipant) {
    return (
      <div>
        <PageHeader title="Live session" subtitle="Start a live screen, camera and microphone session." />
        <EmptyState
          title="Not your session"
          body="Only the device owner and the approved participant can join this live session."
        />
        <div className="mt-4">
          <Button variant="outline" href="/dashboard/remote-access">
            Back to Remote Access
          </Button>
        </div>
      </div>
    );
  }

  if (session.status !== "active") {
    return (
      <div>
        <PageHeader title="Live session" subtitle="Start a live screen, camera and microphone session." />
        <Card>
          <h2 className="font-semibold text-white">This session has ended</h2>
          <p className="mt-2 text-sm text-[#8FA3A0]">
            The session is {session.status}
            {session.ended_at ? ` (ended ${new Date(session.ended_at).toLocaleString()})` : ""}. A
            new live session needs a new approved connection — request access from the Connect page
            and have the device owner approve it.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" href="/dashboard/remote-access">
              Back to Remote Access
            </Button>
            <Button variant="outline" href="/dashboard/connect">
              Request access
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const device = data.devices.find((d) => d.id === session.device_id);
  const deviceName = device?.name ?? "Remote device";
  const grantedScopes: PermissionScope[] = isOwner
    ? [...LIVE_SCOPES]
    : LIVE_SCOPES.filter((scope) => {
        const grant = data.grantedToMe.find(
          (g) => g.device_id === session.device_id && g.scope === scope,
        );
        return grant !== undefined && checkGrantValidity(grant, session.device_id) === "valid";
      });

  return (
    <div>
      <PageHeader
        title="Live session"
        subtitle={`Session started ${new Date(session.started_at).toLocaleString()} · ${deviceName}`}
      />
      <LiveSession
        sessionId={session.id}
        deviceName={deviceName}
        isOwner={isOwner}
        grantedScopes={grantedScopes}
        peerLabel={isOwner ? "participant" : "device owner"}
      />
    </div>
  );
}
