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

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
 // Strict mode is intentionally ON. The double-invocation of effects in
 // development is the most effective built-in detector of missing effect
 // cleanups and stale-closure bugs. The realtime `useCoworkWebSocket` hook
 // already guards against double-mount with a `disposed` flag plus
 // `removeAllListeners`/`disconnect` cleanup, so it tolerates strict-mode
 // remounting without opening duplicate sockets. Leaving this off would only
 // mask real defects across the (stateful) zustand / react-query / socket.io
 // dashboard.
  reactStrictMode: true,
  turbopack: {
    root: projectRoot,
  },
  headers() {
    /**
 * Baseline static security response headers applied to every response.
 *
 * The Content-Security-Policy is intentionally NOT set here: `headers()` is
 * evaluated ONCE at build/startup, so any nonce minted here would be a single
 * static value baked into every response — providing no CSP protection and
 * never applied to Next.js's own inline RSC/hydration scripts. The strict,
 * per-request nonce'd CSP is set instead in `src/middleware.ts`, which runs on
 * every request. See that file for the connect-src contract (kept in sync with
 * src/hooks/use-websocket.ts: same-origin socket.io over `connect-src 'self'`).
 *
 * • X-Frame-Options: DENY — legacy clickjacking guard.
 * • X-Content-Type-Options: nosniff — stops MIME sniffing.
 * • Strict-Transport-Security — enforces TLS (production only).
 */
    const securityHeaders = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value:
          "geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()",
      },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
 // Strict-Transport-Security is only meaningful over TLS. Emitting it on
 // plaintext `next dev` (http://127.0.0.1) is a no-op today, but if the dev
 // server is ever reached over a real hostname via a proxy it would cache an
 // HSTS policy the deployment may not honor. Gate it to production only so
 // the policy is set exactly where TLS is actually terminated.
      ...(process.env.NODE_ENV === "production"
        ? [
            {
              key: "Strict-Transport-Security",
              value: "max-age=63072000; includeSubDomains",
            },
          ]
        : []),
    ];

    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
