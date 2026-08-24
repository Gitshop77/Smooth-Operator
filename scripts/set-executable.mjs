import { chmod } from "node:fs/promises";
import process from "node:process";

const path = process.argv[2];
if (!path || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/set-executable.mjs <path>");
}

// npm creates a platform-specific bin shim on Windows, where Unix execute
// bits are not meaningful. Preserve the executable bit on Unix-like systems.
if (process.platform !== "win32") {
  await chmod(path, 0o755);
}
