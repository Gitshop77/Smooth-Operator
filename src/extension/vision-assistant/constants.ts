/**
 * Vision Assistant — model constants for LiquidAI LFM2.5-VL-3B ONNX WebGPU (Q4).
 *
 * All URLs, revision pins, architecture constants, and grounding prompts in one
 * place. The model is the official ONNX Q4 export used by the LFM2.5-VL-3B-WebGPU
 * HuggingFace Space:
 *   - Model:  https://huggingface.co/LiquidAI/LFM2.5-VL-3B-ONNX
 *   - Space:  https://huggingface.co/spaces/LiquidAI/LFM2.5-VL-3B-WebGPU
 *   - License: https://huggingface.co/LiquidAI/LFM2.5-VL-3B-ONNX/blob/main/LICENSE
 *
 * Downloads go to the browser Cache Storage API (`CACHE_NAME`) and survive
 * browser restarts, service-worker restarts, AND extension updates (the cache is
 * scoped to the extension origin, which is stable across updates — only
 * uninstalling the extension or clearing its site data wipes it).
 */

/** HuggingFace repo holding the ONNX export. */
export const MODEL_REPO = "LiquidAI/LFM2.5-VL-3B-ONNX";

/**
 * Pinned git commit (content-addressed integrity anchor). transformers.js
 * requests every file under this revision, so both the download URLs and the
 * cache keys are deterministic. Resolved from the Hub API on 2026-08-14.
 */
export const MODEL_REVISION = "020f9311343b8f3c6d9789b4dd300e749ec52cd1";

/** File-serving prefix (matches the URL shape transformers.js computes). */
export const MODEL_BASE_URL = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}`;

// ─── Small config / tokenizer files (every one SHA-256 pinned) ────────────────

export const CONFIG_JSON_URL = `${MODEL_BASE_URL}/config.json`;
export const GENERATION_CONFIG_URL = `${MODEL_BASE_URL}/generation_config.json`;
export const PREPROCESSOR_CONFIG_URL = `${MODEL_BASE_URL}/preprocessor_config.json`;
export const PROCESSOR_CONFIG_URL = `${MODEL_BASE_URL}/processor_config.json`;
export const TOKENIZER_JSON_URL = `${MODEL_BASE_URL}/tokenizer.json`;
export const TOKENIZER_CONFIG_URL = `${MODEL_BASE_URL}/tokenizer_config.json`;
export const CHAT_TEMPLATE_URL = `${MODEL_BASE_URL}/chat_template.jinja`;

// ─── ONNX weights (Q4) ────────────────────────────────────────────────────────
// Decoder: decoder_model_merged_q4.onnx + 5 external-data shards. The shard
// naming is `{graph}_data` (chunk 0) then `{graph}_data_{i}` (i >= 1).
export const DECODER_GRAPH_URL = `${MODEL_BASE_URL}/onnx/decoder_model_merged_q4.onnx`;
const DECODER_DATA_BASE = "decoder_model_merged_q4.onnx_data";
const DECODER_DATA_COUNT = 5; // decoder_model_merged_q4.onnx_data … _data_4
const DATA_SHARD_URLS = (base: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${MODEL_BASE_URL}/onnx/${base}${i === 0 ? "" : `_${i}`}`);
export const DECODER_DATA_URLS = DATA_SHARD_URLS(DECODER_DATA_BASE, DECODER_DATA_COUNT);

// Vision encoder: vision_encoder_q4.onnx + 1 external-data shard.
export const VISION_GRAPH_URL = `${MODEL_BASE_URL}/onnx/vision_encoder_q4.onnx`;
export const VISION_DATA_URL = `${MODEL_BASE_URL}/onnx/vision_encoder_q4.onnx_data`;

// Token embeddings — the manifest ships fp16 and fp32 variants. Chrome GPUs
// almost always expose the `shader-f16` WebGPU feature; when they do we use the
// fp16 embed (~0.5 GB) to save ~500 MB download + VRAM. Otherwise the
// self-contained fp32 `embed_tokens.onnx` (~1.0 GB) is used.
export const EMBED_FP16_GRAPH_URL = `${MODEL_BASE_URL}/onnx/embed_tokens_fp16.onnx`;
export const EMBED_FP16_DATA_URL = `${MODEL_BASE_URL}/onnx/embed_tokens_fp16.onnx_data`;
export const EMBED_FP32_GRAPH_URL = `${MODEL_BASE_URL}/onnx/embed_tokens.onnx`;

// ─── Embedding precision selection ────────────────────────────────────────────
/** Which embedding variant to download; chosen from the GPU's WebGPU features. */
export type EmbeddingPrecision = "fp16" | "fp32";

/**
 * Probe the WebGPU adapter and pick the embedding precision: `fp16` when the
 * adapter advertises `shader-f16` (the common Chrome case), otherwise `fp32`.
 * Fails toward `fp32` (the manifest default) so an unprobeable context still
 * gets a valid — if larger — download.
 */
export async function pickEmbeddingPrecision(): Promise<EmbeddingPrecision> {
  try {
    const gpu = (navigator as { gpu?: { requestAdapter?: (o?: unknown) => Promise<{ features: Set<string> } | null> } }).gpu;
    const adapter = gpu?.requestAdapter ? await gpu.requestAdapter({ powerPreference: "high-performance" }) : null;
    if (adapter && adapter.features?.has?.("shader-f16")) return "fp16";
  } catch {
    /* fall through to fp32 */
  }
  return "fp32";
}

/** Model file list (name + url) for a given embedding precision. */
export interface ModelFile {
  url: string;
  name: string;
}

export function modelFileEntries(precision: EmbeddingPrecision = "fp16"): ModelFile[] {
  const files: ModelFile[] = [
    { url: CONFIG_JSON_URL, name: "config.json" },
    { url: GENERATION_CONFIG_URL, name: "generation_config.json" },
    { url: PREPROCESSOR_CONFIG_URL, name: "preprocessor_config.json" },
    { url: PROCESSOR_CONFIG_URL, name: "processor_config.json" },
    { url: TOKENIZER_JSON_URL, name: "tokenizer.json" },
    { url: TOKENIZER_CONFIG_URL, name: "tokenizer_config.json" },
    { url: CHAT_TEMPLATE_URL, name: "chat_template.jinja" },
    { url: DECODER_GRAPH_URL, name: "decoder graph" },
    ...DECODER_DATA_URLS.map((url, i) => ({ url, name: i === 0 ? "decoder data" : `decoder data ${i}` })),
    { url: VISION_GRAPH_URL, name: "vision graph" },
    { url: VISION_DATA_URL, name: "vision data" },
  ];
  if (precision === "fp16") {
    files.push({ url: EMBED_FP16_GRAPH_URL, name: "embed graph" });
    files.push({ url: EMBED_FP16_DATA_URL, name: "embed data" });
  } else {
    files.push({ url: EMBED_FP32_GRAPH_URL, name: "embed data" });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Integrity pinning (supply-chain protection)
// ---------------------------------------------------------------------------
// SHA-256 (lowercase hex) of each model file that is cheap to pin. The 10
// small config/tokenizer/graph files below ARE pinned (computed from the
// pinned `MODEL_REVISION` on 2026-08-14). The ~3 GB external-data shards are
// pinned by exact byte SIZE in `MODEL_FILE_SIZES`; the loader still records
// their computed SHA-256 on first download and re-verifies that digest on every
// subsequent load, so a poisoned/corrupted cache entry is still rejected. To
// promote the big shards to full hash pinning, run:
//   node scripts/pin-vision-hashes.mjs   (one-time ~3.5 GB download)
export const MODEL_FILE_HASHES: Partial<Record<string, string>> = {
  [CONFIG_JSON_URL]: "8619c5cb0ba521ce8bc876603531d5fa9ac35325d0d661ea2a710c042a554a90",
  [GENERATION_CONFIG_URL]: "e78ebc863fdfa96c34085cc75ad00e5b0e3119c1771f49b8fa093910253bfb4a",
  [PREPROCESSOR_CONFIG_URL]: "235cbf2de0f144efce495e818fd5edf02051f9a9377c528d233fde337fb5804d",
  [PROCESSOR_CONFIG_URL]: "ec549d27ef491d90a40fdd457fb618544c245771ceb1f3f84ff651bcd33e619d",
  [TOKENIZER_JSON_URL]: "8096ecb9f54599d756c8de728a598a340bc1e43c0deb77ddd62456c38349fcee",
  [TOKENIZER_CONFIG_URL]: "9e6591c664976500b21cf8b4ede6c11135a5c783e33ef63b7f511be2dc4c4c63",
  [CHAT_TEMPLATE_URL]: "86f4770449a4797c9b4212d110b0cc70fb993c1ce960095bcfb12eea22f61cca",
  [DECODER_GRAPH_URL]: "4f5bb32eff02733d19362e815142cce1ac53682300a44ce65fcced93c70bf716",
  [VISION_GRAPH_URL]: "8fbf10eb1b77c498c1419f96d64ba77453ea5fbcc4ed1908707aac885468e62a",
  [EMBED_FP16_GRAPH_URL]: "963acb7a88f7f400f85a1153e6cd1cf115574920da882ce6f24e3c916f906aff",
};

/** Exact byte sizes of every model file (from the Hub tree at the pinned revision). */
export const MODEL_FILE_SIZES: Partial<Record<string, number>> = {
  [CONFIG_JSON_URL]: 5421,
  [GENERATION_CONFIG_URL]: 234,
  [PREPROCESSOR_CONFIG_URL]: 732,
  [PROCESSOR_CONFIG_URL]: 828,
  [TOKENIZER_JSON_URL]: 17_905_750,
  [TOKENIZER_CONFIG_URL]: 6199,
  [CHAT_TEMPLATE_URL]: 5436,
  [DECODER_GRAPH_URL]: 314_561,
  [DECODER_DATA_URLS[0]]: 32_768_000,
  [DECODER_DATA_URLS[1]]: 1_048_576_000,
  [DECODER_DATA_URLS[2]]: 531_226_624,
  [DECODER_DATA_URLS[3]]: 534_642_688,
  [DECODER_DATA_URLS[4]]: 456_916_992,
  [VISION_GRAPH_URL]: 294_322,
  [VISION_DATA_URL]: 269_097_152,
  [EMBED_FP16_GRAPH_URL]: 573,
  [EMBED_FP16_DATA_URL]: 524_288_000,
  [EMBED_FP32_GRAPH_URL]: 1_048_576_359,
};

/** URL-only view of `modelFileEntries`, for cache probes that don't need names. */
export function allModelFileUrls(precision: EmbeddingPrecision = "fp16"): string[] {
  return modelFileEntries(precision).map((f) => f.url);
}

/**
 * `ALL_MODEL_FILE_URLS` (fp16 variant — the common Chrome case). Kept as a
 * static export for backward compatibility; callers that probe the GPU first
 * should use `allModelFileUrls(await pickEmbeddingPrecision())` instead.
 */
export const ALL_MODEL_FILE_URLS = allModelFileUrls("fp16");


// ─── Grounding prompts ────────────────────────────────────────────────────────
// LFM2.5-VL does referring-expression grounding natively: give it a system
// prompt that demands a strict JSON array of 0-1000 normalized bounding boxes
// and it emits one `bbox_2d` per detected element. `grounding-parser.ts` parses
// that output; `box-parser.ts#toPixelCoords` maps the 0-1000 coords back to the
// screenshot's pixel space (the model normalizes over the full input image —
// matching the LFM Space's `left: xmin/10%` overlay math).

export const DETECTION_SYSTEM_PROMPT = `When asked for bounding boxes for objects, return a valid JSON array.
Each array item must be an object with:
- image_id: the 0-based index of the image
- bbox_2d: [xmin, ymin, xmax, ymax] normalized integer coordinates in [0, 1000]
- label: a concise label you choose for the predicted object or region

Return one item per visible matching object or region. Return [] if none are visible.`;

export const DETECTION_USER_PROMPT =
  "Provide bounding boxes for every visible interactive element in this browser screenshot, " +
  "including: buttons, links, inputs, selects, textareas, checkboxes, radio buttons, dropdowns, " +
  "menus, tabs, icons, images, canvas elements, charts, graphs, modals, dialogs, popups, banners, " +
  "notifications and alerts. Return a JSON array of bounding boxes.";

// ─── Generation limits ────────────────────────────────────────────────────────
// Matches the LFM Space's default decode budget; generous enough to emit a
// JSON array for a dense page while the eos token (`<|im_end|>`) stops early.
export const MAX_NEW_TOKENS = 384;

// ─── Download settings ────────────────────────────────────────────────────────
export const DOWNLOAD_CHUNK_SIZE = 48 * 1024 * 1024; // 48 MB
export const DOWNLOAD_MAX_RETRIES = 5;
export const DOWNLOAD_STALL_MS = 30_000;

// Cache Storage key — stable across extension updates so a previously
// downloaded model survives a version bump. Bump deliberately (with a
// migration) if the model/revision changes shape.
export const CACHE_NAME = "lfm2-5-vl-model-v1";

// Human-readable total download size (fp16-embed variant), shown in the UI
// before the multi-GB download starts. Single source so the confirm dialog and
// any other copy cannot drift apart.
export const MODEL_DOWNLOAD_SIZE_LABEL = "~3.5 GB";

