import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(root, "src/server/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  outfile: resolve(root, "dist/smooth-operator.mjs"),
  sourcemap: true,
  sourcesContent: false,
});
