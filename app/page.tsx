import Link from "next/link";
import { Badge, Button, Card, Wordmark } from "@/components/ui";
import { PERMISSION_SCOPES, SCOPE_LABELS } from "@/lib/permissions";
import { isAuthConfigured, isDatabaseConfigured } from "@/lib/db/config";

const FEATURES = [
  {
    title: "Trusted Devices",
    body: "Approve a device once. Valid grants are reused on reconnect — no repeated approval dialogs for permissions that are still valid.",
  },
  {
    title: "One-Time Authorization",
    body: "The owner picks exactly which permissions to grant at pairing. Re-approval is only asked for a new permission, a changed device, an expiry, a revocation, or a security event.",
  },
  {
    title: "Owner Is Always in Control",
    body: "Revoke a device and its authorization dies immediately — active sessions end at the same moment. Every grant, change and revocation is audit-logged.",
  },
  {
    title: "OS Consent Is Never Bypassed",
    body: "NEXVORA authorization is separate from browser and Android permissions. A grant alone never turns on a camera, microphone, or screen share.",
  },
  {
    title: "Secure Pairing",
    body: "Temporary 6-digit codes, SHA-256 hashed secrets, 10-minute expiry, single use, rate-limited, replay-proof. A code alone never grants access.",
  },
  {
    title: "Personal + Universal Modes",
    body: "Manage your own devices, or request access to another user's device — every new connection needs the owner's explicit approval.",
  },
];

export default function Home() {
  const configured = isDatabaseConfigured() && isAuthConfigured();
  return (
    <div className="min-h-screen bg-[#080D12]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Wordmark />
        <nav className="flex items-center gap-3">
          <Link href="/login">
            <Button variant="ghost">Sign in</Button>
          </Link>
          <Link href="/register">
            <Button>Get started</Button>
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-20">
        <section className="py-16 text-center sm:py-24">
          <Badge tone="green">Milestone 1 — Foundation is live</Badge>
          <h1 className="mx-auto mt-6 max-w-3xl text-5xl leading-tight font-bold text-white sm:text-6xl">
            ONE ECOSYSTEM. <span className="text-[#00E5A8]">EVERY DEVICE.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-[#8FA3A0]">
            NEXVORA is a premium remote device access and management platform.
            Register your devices, pair securely, and grant access once — with
            the owner in control at every step.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/register">
              <Button className="px-6 py-3 text-base">Create your account</Button>
            </Link>
            <Link href="/dashboard">
              <Button variant="outline" className="px-6 py-3 text-base">
                Open dashboard
              </Button>
            </Link>
          </div>
          {!configured && (
            <p className="mx-auto mt-6 max-w-xl rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/10 px-4 py-3 text-sm text-[#E8F0EE]">
              Demo mode: no Neon project is configured yet, so sign-in and
              device data are disabled. Set the env vars in{" "}
              <code className="font-mono">.env.local</code> to enable them — see
              README.md.
            </p>
          )}
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Card key={f.title}>
              <h3 className="font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[#8FA3A0]">{f.body}</p>
            </Card>
          ))}
        </section>

        <section className="mt-14">
          <Card>
            <h2 className="text-lg font-semibold text-white">Permission scopes — granted only by the owner</h2>
            <p className="mt-1 text-sm text-[#8FA3A0]">
              Live screen, camera, microphone and speaker access arrive in
              Milestone 3; file transfer, location and remote interaction in
              Milestone 4. In Milestone 1 these scopes can be granted and
              managed — nothing live is switched on.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {PERMISSION_SCOPES.map((s) => (
                <Badge key={s} tone="green">
                  {SCOPE_LABELS[s]}
                </Badge>
              ))}
            </div>
          </Card>
        </section>

        <footer className="mt-16 flex flex-col items-center gap-2 text-center text-xs text-[#8FA3A0]">
          <p>NEXVORA — Premium Remote Device Access &amp; Management</p>
          <p>
            Milestone 1: brand, authentication, database, device registration,
            secure pairing, approval &amp; revocation.
          </p>
        </footer>
      </main>
    </div>
  );
}
