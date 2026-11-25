import { Badge, Button, Card, Wordmark } from "@/components/ui";
import { PERMISSION_SCOPES, SCOPE_LABELS } from "@/lib/permissions";
import { isAuthConfigured, isDatabaseConfigured } from "@/lib/db/config";

// Direct download (not the Drive viewer page, which does not install the APK on mobile).
const APK_URL =
  "https://drive.google.com/uc?export=download&id=1LWUCQ4DzV5dYArnd9lohyjWaffO2Q8Gs";

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
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-[#00E5A8] focus:px-4 focus:py-2 focus:text-[#080D12]"
      >
        Skip to content
      </a>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Wordmark />
        <nav aria-label="Primary" className="flex items-center gap-3">
          <a
            href={APK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors bg-transparent text-[#E8F0EE] border border-[#1E2D38] hover:border-[#00E5A8] hover:text-[#00E5A8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8] sm:inline-flex"
          >
            Download App
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <Button variant="ghost" href="/login">
            Sign in
          </Button>
          <Button href="/register">Get started</Button>
        </nav>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-6 pb-20">
        <section className="py-16 text-center sm:py-24">
          <Badge tone="green">Milestone 1 — Foundation is live</Badge>
          <h1 className="mx-auto mt-6 max-w-3xl text-5xl leading-tight tracking-tight font-bold text-white sm:text-6xl">
            ONE ECOSYSTEM. <span className="text-[#00E5A8]">EVERY DEVICE.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-[#8FA3A0]">
            NEXVORA is a premium remote device access and management platform.
            Register your devices, pair securely, and grant access once — with
            the owner in control at every step.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button href="/register" className="px-6 py-3 text-base">
              Create your account
            </Button>
            <Button href="/dashboard" variant="outline" className="px-6 py-3 text-base">
              Open dashboard
            </Button>
            <a
              href={APK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3 text-base font-semibold transition-colors bg-[#00E5A8] text-[#080D12] hover:bg-[#33ecb8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]"
            >
              Download App
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>
          <p className="mt-4 text-sm text-[#8FA3A0]">
            Android APK · v0.1.0 · Direct install — Play Store coming soon.
            Live screen &amp; camera sharing arrive in the next update.
          </p>
          {!configured && (
            <p className="mx-auto mt-6 max-w-xl rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/10 px-4 py-3 text-sm text-[#E8F0EE]">
              Demo mode: no Neon project is configured yet, so sign-in and
              device data are disabled. Set the env vars in{" "}
              <code className="font-mono">.env.local</code> to enable them — see
              README.md.
            </p>
          )}
        </section>

        <section aria-labelledby="features-heading" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <h2 id="features-heading" className="sr-only">Core features</h2>
          {FEATURES.map((f) => (
            <Card key={f.title}>
              <h3 className="font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[#8FA3A0]">{f.body}</p>
            </Card>
          ))}
        </section>

        <section aria-labelledby="scopes-heading" className="mt-14">
          <Card>
            <h2 id="scopes-heading" className="text-lg font-semibold text-white">Permission scopes — granted only by the owner</h2>
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

        <footer className="mt-16 flex flex-col items-center gap-2 text-center text-sm text-[#8FA3A0]">
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
