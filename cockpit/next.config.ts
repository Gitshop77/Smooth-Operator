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
  reactStrictMode: false,
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
