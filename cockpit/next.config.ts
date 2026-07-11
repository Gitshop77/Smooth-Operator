import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * The cockpit is a self-contained Next.js app living inside a larger
 * monorepo-style workspace that also has its own root `package-lock.json`.
 * Without an explicit `turbopack.root`, Next.js infers the workspace root
 * (the repo root) and emits a build warning about ambiguous lockfiles.
 * Pinning `turbopack.root` to this directory silences that warning and
 * keeps Turbopack's module resolution scoped to the cockpit app.
 */
const projectRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Baseline security response headers, applied to every response via the
 * Next.js `headers()` API. These are defense-in-depth: the cockpit is a
 * single-purpose internal app, but setting them costs nothing and hardens it
 * against clickjacking / MIME sniffing / downgrade attacks.
 *   • Content-Security-Policy: `frame-ancestors 'none'` blocks embedding.
 *   • X-Frame-Options: DENY — legacy clickjacking guard.
 *   • X-Content-Type-Options: nosniff — stops MIME sniffing.
 *   • Strict-Transport-Security — enforces TLS (only meaningful over HTTPS, but
 *     safe to set).
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "default-src 'self'; frame-ancestors 'none';",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  turbopack: {
    root: projectRoot,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
