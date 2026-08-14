#!/usr/bin/env node
/**
 * pin-vision-hashes.mjs — promote the LFM2.5-VL-3B vision model's big weight
 * shards from size-pinning to full SHA-256 pinning.
 *
 * The vision-assistant ships with 10 small config/tokenizer/graph files already
 * hash-pinned in MODEL_FILE_HASHES; the ~3 GB external-data shards are
 * size-pinned (MODEL_FILE_SIZES) and re-verified via a recorded digest on every
 * load. For full first-download integrity, download each shard ONCE, compute
 * its SHA-256, and write the hashes back into constants.ts:
 *
 *   node scripts/pin-vision-hashes.mjs            # print only
 *   node scripts/pin-vision-hashes.mjs --write    # update constants.ts
 *
 * The download is large (~3.5 GB for the fp16-embed variant; ~4.0 GB for fp32).
 * Files already present in the browser Cache Storage are NOT read — this script
 * is standalone and downloads via HTTPS from the pinned revision.
 */

import { createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSTANTS = resolve(ROOT, "src/extension/vision-assistant/constants.ts");

// Mirror the constants module's URL construction so the pinned revision is the
// single source of truth (keep in sync with constants.ts).
const MODEL_REPO = "LiquidAI/LFM2.5-VL-3B-ONNX";
const MODEL_REVISION = "020f9311343b8f3c6d9789b4dd300e749ec52cd1";
const BASE = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}`;

const SMALL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "processor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "chat_template.jinja",
];

// Files already hash-pinned in constants.ts (small files + graph stubs).
const ALREADY_PINNED = new Set([
  ...SMALL_FILES.map((f) => `${BASE}/${f}`),
  `${BASE}/onnx/decoder_model_merged_q4.onnx`,
  `${BASE}/onnx/vision_encoder_q4.onnx`,
  `${BASE}/onnx/embed_tokens_fp16.onnx`,
]);

const decoderShards = Array.from({ length: 5 }, (_, i) =>
  `${BASE}/onnx/decoder_model_merged_q4.onnx_data${i === 0 ? "" : `_${i}`}`);

const LARGE_FILES = [
  ...decoderShards,
  `${BASE}/onnx/vision_encoder_q4.onnx_data`,
  `${BASE}/onnx/embed_tokens_fp16.onnx_data`,
  `${BASE}/onnx/embed_tokens.onnx`, // fp32 variant (only used on non-shader-f16 GPUs)
];

const formatMb = (n) => `${(n / 1048576).toFixed(0)} MB`;

async function sha256Url(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") || 0);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    received += value.length;
    const pct = total > 0 ? Math.round((received / total) * 100) : 0;
    process.stdout.write(`\r  ${url.split("/").pop()} ${formatMb(received)} / ${formatMb(total)} (${pct}%)`);
  }
  process.stdout.write("\n");
  return hash.digest("hex");
}

async function main() {
  const write = process.argv.includes("--write");
  const files = [...ALREADY_PINNED, ...LARGE_FILES];
  console.log(`Pinning ${files.length} files (skipping already-pinned where possible)...`);

  const hashes = new Map();
  for (const url of files) {
    if (ALREADY_PINNED.has(url)) continue; // already pinned in constants.ts
    process.stdout.write(`hashing ${url}\n`);
    hashes.set(url, await sha256Url(url));
  }

  // Read the current MODEL_FILE_HASHES block and merge new entries in.
  const src = readFileSync(CONSTANTS, "utf8");
  const blockStart = src.indexOf("export const MODEL_FILE_HASHES");
  const blockEnd = src.indexOf("\n};", blockStart) + 3;
  const existing = src.slice(blockStart, blockEnd);
  const lines = existing.split("\n");
  const insertBefore = lines.findIndex((l) => l.trim().startsWith("};"));

  const entries = [];
  for (const url of LARGE_FILES) {
    const hash = hashes.get(url);
    if (!hash) continue;
    const already = lines.some((l) => l.includes(`[${JSON.stringify(url)}]`) || l.includes(`[${JSON.stringify(url.replace(BASE, "` + MODEL_BASE_URL + `"))}]`));
    if (already) continue;
    entries.push(`  [MODEL_BASE_URL + ${JSON.stringify(url.slice(BASE.length))}]: ${JSON.stringify(hash)},`);
  }

  if (entries.length === 0) {
    console.log("Nothing new to pin — every file already has a hash entry.");
    return;
  }

  if (!write) {
    console.log("\nAdd these to MODEL_FILE_HASHES in constants.ts:\n");
    for (const e of entries) console.log(e);
    console.log("\nRe-run with --write to apply automatically.");
    return;
  }

  lines.splice(insertBefore, 0, ...entries);
  const updated = src.replace(existing, lines.join("\n"));
  writeFileSync(CONSTANTS, updated);
  console.log(`Wrote ${entries.length} new hash entries to ${CONSTANTS}`);
}

main().catch((err) => {
  console.error("pin-vision-hashes failed:", err);
  process.exit(1);
});
