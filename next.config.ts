import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No cacheComponents: dashboard pages read the Neon Auth session from
  // cookies and must stay dynamic.
  // The Turbopack CSS rule is required by @tailwindcss/turbopack (the
  // Tailwind v4 pipeline this scaffold uses) — without it, @theme and
  // utilities pass through unprocessed.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  /**
   * Security headers (Milestone 5). Verified by a local production
   * smoke test (curl response headers) — pages still render.
   *
   * - X-Content-Type-Options: nosniff — no MIME sniffing.
   * - Referrer-Policy: strict-origin-when-cross-origin.
   * - Permissions-Policy: camera / microphone / geolocation /
   *   display-capture limited to (self). These are the exact features
   *   the app itself uses (getUserMedia, getDisplayMedia, Geolocation)
   *   on its own origin; delegating them to any other origin would
   *   only ever be a bug. Verified not to break the app's own media
   *   capture, which runs on the same origin.
   * - X-Frame-Options: DENY — the app is never framed anywhere.
   *
   * NO Content-Security-Policy is set (deliberate, see
   * docs/limitations.md): a strict CSP needs per-request nonces
   * plumbed through proxy.ts for Next.js's inline runtime scripts
   * and Tailwind v4's injected styles, and that cannot be verified
   * safe without a real browser pass. Adding an unverified CSP
   * risks breaking the app in production; it is a future item for a
   * browser-verified pass, not a silent omission.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(self), microphone=(self), geolocation=(self), display-capture=(self)",
          },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
