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
};

export default nextConfig;
