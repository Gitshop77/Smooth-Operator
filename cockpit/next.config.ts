import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

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
  async headers() {
    /**
     * Per-request CSP nonce.
     *
     * Next.js's App Router emits required inline `<script>` (RSC flight
     * bootstrap, hydration) and inline `<style>` tags. A static
     * `script-src 'self'` (no nonce / no `'unsafe-inline'`) blocks those
     * inline tags and silently breaks client-side hydration in a real
     * production build. Next.js reads the nonce out of the response
     * `Content-Security-Policy` header and automatically applies the same
     * nonce to the inline scripts and styles it generates, so we can keep a
     * strict policy without `'unsafe-inline'` and still allow the framework's
     * own inline code to run.
     *
     * A fresh nonce is generated per request so it cannot be reused across
     * responses.
     */
    const nonce = randomBytes(16).toString("base64");

    /**
     * Baseline security response headers, applied to every response.
     *   • Content-Security-Policy — `frame-ancestors 'none'` blocks embedding;
     *     strict `script-src`/`style-src` (self + per-request nonce) allow only
     *     the framework's own inline code; `img-src 'self' data:` permits inline
     *     data-URI images; `connect-src 'self'` permits same-origin fetches and
     *     the gateway-proxied socket.io connection (see use-websocket.ts, which
     *     calls `io()` with no URL so it targets the page's own origin).
     *   • X-Frame-Options: DENY — legacy clickjacking guard.
     *   • X-Content-Type-Options: nosniff — stops MIME sniffing.
     *   • Strict-Transport-Security — enforces TLS.
     */
    const securityHeaders = [
      {
        key: "Content-Security-Policy",
        value: [
          `default-src 'self'`,
          `script-src 'self' 'nonce-${nonce}'`,
          `style-src 'self' 'nonce-${nonce}'`,
          `img-src 'self' data:`,
          `connect-src 'self'`,
          `frame-ancestors 'none'`,
        ].join("; "),
      },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      },
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
