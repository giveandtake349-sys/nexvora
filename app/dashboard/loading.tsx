/**
 * Dashboard loading state — shown INSTANTLY on every navigation
 * inside /dashboard/* while the server component loads. Without this,
 * a tap looked dead for the 4-8s the page took to render (each
 * navigation opened a fresh WebSocket to Neon Singapore), so users
 * reasonably believed the buttons were broken.
 */
export default function DashboardLoading() {
  return (
    <div>
      <div className="mb-6">
        <div className="h-7 w-40 animate-pulse rounded-lg bg-white/10" />
        <div className="mt-2 h-4 w-72 animate-pulse rounded-lg bg-white/5" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-[#1E2D38] bg-[#0D141B] p-5">
            <div className="h-3 w-24 animate-pulse rounded bg-white/10" />
            <div className="mt-3 h-8 w-12 animate-pulse rounded bg-white/10" />
            <div className="mt-2 h-3 w-20 animate-pulse rounded bg-white/5" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-2xl border border-[#1E2D38] bg-[#0D141B] p-5">
            <div className="h-5 w-48 animate-pulse rounded bg-white/10" />
            <div className="mt-4 h-4 w-full animate-pulse rounded bg-white/5" />
            <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-white/5" />
            <div className="mt-4 h-10 w-36 animate-pulse rounded-lg bg-[#00E5A8]/20" />
          </div>
        ))}
      </div>
      <p className="mt-6 text-center text-sm text-[#8FA3A0]">Loading…</p>
    </div>
  );
}
