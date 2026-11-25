import { Badge, Button, Card, Wordmark } from "@/components/ui";
import LiveControlDemo from "@/components/LiveControlDemo";
import { PERMISSION_SCOPES, SCOPE_LABELS } from "@/lib/permissions";
import { isAuthConfigured, isDatabaseConfigured } from "@/lib/db/config";

// Direct download from our own Vercel Blob store — no Google Drive page in between.
const APK_URL =
  "https://l4olg2qubqwtv2jv.public.blob.vercel-storage.com/NEXVORA-v0.1.0.apk";

const DOWNLOAD_PILL =
  "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8]";

const FEATURES = [
  {
    title: "Trusted Devices",
    body: "Approve a device once. Valid grants are reused on reconnect — no repeated approval dialogs for permissions that are still valid.",
    icon: (
      <path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z" />
    ),
  },
  {
    title: "One-Time Authorization",
    body: "The owner picks exactly which permissions to grant at pairing. Re-approval is only asked for a new permission, a changed device, an expiry, a revocation, or a security event.",
    icon: (
      <>
        <circle cx="8" cy="12" r="3.5" />
        <path d="M11.5 12H21M18 12v3M15 12v2" />
      </>
    ),
  },
  {
    title: "Owner Is Always in Control",
    body: "Revoke a device and its authorization dies immediately — active sessions end at the same moment. Every grant, change and revocation is audit-logged.",
    icon: (
      <>
        <circle cx="10" cy="8" r="3.5" />
        <path d="M4 20c0-3.3 2.7-5.5 6-5.5 1.5 0 2.9.5 4 1.3M15.5 18.5l1.8 1.8 3.2-3.2" />
      </>
    ),
  },
  {
    title: "OS Consent Is Never Bypassed",
    body: "NEXVORA authorization is separate from browser and Android permissions. A grant alone never turns on a camera, microphone, or screen share.",
    icon: (
      <>
        <path d="M3 5l18 14" />
        <path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c2.5 0 4.9.9 6.8 2.3M6.6 6.6C4.2 8.2 2.6 10 2 12c.6 2.1 2.4 4 4.9 5.2M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      </>
    ),
  },
  {
    title: "Secure Pairing",
    body: "Temporary 6-digit codes, SHA-256 hashed secrets, 10-minute expiry, single use, rate-limited, replay-proof. A code alone never grants access.",
    icon: (
      <>
        <path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13 5l-2 14" />
      </>
    ),
  },
  {
    title: "Personal + Universal Modes",
    body: "Manage your own devices, or request access to another user's device — every new connection needs the owner's explicit approval.",
    icon: (
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 5.5a3.5 3.5 0 0 1 0 5.8M17.5 14.9c2 .8 3.5 2.6 3.5 5.1" />
      </>
    ),
  },
];

const STEPS = [
  {
    n: "1",
    title: "Register your device",
    body: "Create an account and add each device you own — phone, laptop, anything.",
  },
  {
    n: "2",
    title: "Pair with a code",
    body: "A temporary 6-digit code links the device. It expires in 10 minutes and works once.",
  },
  {
    n: "3",
    title: "Grant once, control forever",
    body: "The owner picks the permissions once. Valid grants are reused — no repeated approval.",
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
      <header className="sticky top-0 z-40 border-b border-[#1E2D38]/60 bg-[#080D12]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <Wordmark />
          <nav aria-label="Primary" className="flex items-center gap-3">
            <a
              href={APK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`${DOWNLOAD_PILL} hidden border border-[#1E2D38] bg-transparent text-[#E8F0EE] hover:border-[#00E5A8] hover:text-[#00E5A8] sm:inline-flex`}
            >
              Download App
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <Button variant="ghost" href="/login">
              Sign in
            </Button>
            <Button href="/register">Get started</Button>
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-6 pb-20">
        <section className="grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="text-center lg:text-left">
            <Badge tone="green">Recording &amp; live control are live</Badge>
            <h1 className="mx-auto mt-6 max-w-3xl font-display text-5xl leading-tight tracking-tight font-bold text-white sm:text-6xl lg:mx-0">
              ONE ECOSYSTEM. <span className="text-[#00E5A8]">EVERY DEVICE.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg text-[#8FA3A0] lg:mx-0">
              NEXVORA is a premium remote device access and management platform.
              Register your devices, pair securely, and grant access once — with
              the owner in control at every step.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
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
                className={`${DOWNLOAD_PILL} bg-[#00E5A8] text-[#080D12] hover:bg-[#33ecb8]`}
              >
                Download App
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </div>
            <p className="mt-4 text-sm text-[#8FA3A0]">
              Android APK · v0.1.0-m6-step3 · Direct install — Play Store coming soon.
            </p>
            {!configured && (
              <p className="mx-auto mt-6 max-w-xl rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/10 px-4 py-3 text-sm text-[#E8F0EE] lg:mx-0">
                Demo mode: no Neon project is configured yet, so sign-in and
                device data are disabled. Set the env vars in{" "}
                <code className="font-mono">.env.local</code> to enable them — see
                README.md.
              </p>
            )}
          </div>
          <LiveControlDemo variant="phone" />
        </section>

        <section aria-label="Trust" className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 border-y border-[#1E2D38]/60 py-4 text-sm text-[#8FA3A0]">
          <span><span className="text-[#00E5A8]">✓</span> 9 permission scopes</span>
          <span><span className="text-[#00E5A8]">✓</span> Owner approves every connection</span>
          <span><span className="text-[#00E5A8]">✓</span> Revoke anytime — sessions end instantly</span>
          <span><span className="text-[#00E5A8]">✓</span> No silent access — always visible</span>
        </section>

        <section aria-labelledby="features-heading" className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <h2 id="features-heading" className="sr-only">Core features</h2>
          {FEATURES.map((f) => (
            <Card key={f.title} className="transition-colors hover:border-[#00E5A8]/40">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[#00E5A8]/10 text-[#00E5A8]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
                  {f.icon}
                </svg>
              </span>
              <h3 className="mt-3 font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[#8FA3A0]">{f.body}</p>
            </Card>
          ))}
        </section>

        <section aria-labelledby="how-heading" className="mt-14">
          <h2 id="how-heading" className="text-center text-2xl font-bold text-white">How it works</h2>
          <p className="mx-auto mt-2 max-w-xl text-center text-sm text-[#8FA3A0]">
            Three steps, and your devices are under your control — from anywhere.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <Card key={s.n}>
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#00E5A8] text-sm font-bold text-[#080D12]">
                  {s.n}
                </span>
                <h3 className="mt-3 font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#8FA3A0]">{s.body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section aria-labelledby="recording-heading" className="mt-14">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <h2 id="recording-heading" className="text-lg font-semibold text-white">
                  Session recording &amp; replay
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-[#8FA3A0]">
                  Record a live session — screen, camera and mic — into a .webm
                  file, then replay it from your dashboard. Recording is covered
                  by the same one-time grant from pairing, so there is no extra
                  approval step — but a red REC indicator is always visible on
                  both sides while recording, and revoking ends it instantly.
                  Recordings stay in the viewer&apos;s browser.
                </p>
              </div>
              <Button href="/dashboard/recordings" variant="outline">
                Open recordings
              </Button>
            </div>
            <div className="mt-5" aria-hidden>
              <div className="relative h-2 rounded-full bg-white/10">
                <div className="absolute inset-y-0 left-0 w-2/3 rounded-full bg-gradient-to-r from-[#00E5A8] to-[#D4AF37]" />
                <span className="absolute top-1/2 left-[18%] h-3 w-3 -translate-y-1/2 rounded-full border-2 border-[#080D12] bg-[#00E5A8]" />
                <span className="absolute top-1/2 left-[45%] h-3 w-3 -translate-y-1/2 rounded-full border-2 border-[#080D12] bg-[#D4AF37]" />
                <span className="absolute top-1/2 left-[66%] h-3 w-3 -translate-y-1/2 rounded-full border-2 border-[#080D12] bg-red-400" />
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-[#8FA3A0]">
                <span>00:00 · session started</span>
                <span>08:12 · screen shared</span>
                <span>12:48 · recording saved</span>
              </div>
            </div>
          </Card>
        </section>

        <section aria-labelledby="control-heading" className="mt-14">
          <h2 id="control-heading" className="text-center text-2xl font-bold text-white">Try the live controller</h2>
          <p className="mx-auto mt-2 max-w-xl text-center text-sm text-[#8FA3A0]">
            Tap the screen to move the cursor, type with the keyboard, switch
            quality — just like controlling a real device. Interactive demo — no
            real device is connected.
          </p>
          <div className="mx-auto mt-8 max-w-3xl">
            <LiveControlDemo variant="wide" />
          </div>
        </section>

        <section aria-labelledby="scopes-heading" className="mt-14">
          <Card>
            <h2 id="scopes-heading" className="text-lg font-semibold text-white">Permission scopes — granted only by the owner</h2>
            <p className="mt-1 text-sm text-[#8FA3A0]">
              Every scope is granted only by the device owner at pairing — and
              can be revoked anytime. Recording is covered by the same one-time
              grant; a red REC indicator is always visible while recording.
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

        <section className="mt-14">
          <Card className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Get NEXVORA on Android</h2>
              <p className="mt-1 text-sm text-[#8FA3A0]">
                The app keeps live access working even after the browser is closed. Play Store coming soon.
              </p>
            </div>
            <a
              href={APK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`${DOWNLOAD_PILL} bg-[#00E5A8] text-[#080D12] hover:bg-[#33ecb8]`}
            >
              Download App
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Card>
        </section>

        <footer className="mt-16 flex flex-col items-center gap-2 text-center text-sm text-[#8FA3A0]">
          <p>NEXVORA — Premium Remote Device Access &amp; Management</p>
          <p>
            Live screen, camera, mic, file transfer, location, remote control,
            notifications and session recording — all owner-controlled.
          </p>
        </footer>
      </main>
    </div>
  );
}
