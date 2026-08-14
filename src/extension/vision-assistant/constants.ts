/**
 * Vision Assistant — model constants for LiquidAI LFM2.5-VL-450M ONNX WebGPU (Q4).
 *
 * All URLs, revision pins, architecture constants, and grounding prompts in one
 * place. The model is the official ONNX Q4 export used by the LFM2.5-VL-450M-WebGPU
 * HuggingFace Space:
 *   - Model:  https://huggingface.co/LiquidAI/LFM2.5-VL-450M-ONNX
 *   - Space:  https://huggingface.co/spaces/LiquidAI/LFM2.5-VL-450M-WebGPU
 *   - License: https://huggingface.co/LiquidAI/LFM2.5-VL-450M-ONNX/blob/main/LICENSE
 *
 * WHY ONNX and NOT GGUF: this runtime drives onnxruntime-web through
 * transformers.js, which reads ONNX graphs only — it cannot consume GGUF.
 * GGUF also splits the vision encoder out of the LM (`mmproj-*.gguf`), so a
 * single `.gguf` file is not a complete multimodal model here. The officially
 * supported, browser-runnable WebGPU artifact for the 450M is the ONNX q4
 * export below. It replaces the previous LFM2.5-VL-3B (≈3.5 GB) with a
 * ≈649 MB q4 variant that loads far faster and is small enough to keep warm.
 *
 * Downloads go to the browser Cache Storage API (`CACHE_NAME`) and survive
 * browser restarts, service-worker restarts, AND extension updates (the cache is
 * scoped to the extension origin, which is stable across updates — only
 * uninstalling the extension or clearing its site data wipes it).
 */

/** HuggingFace repo holding the ONNX export. */
export const MODEL_REPO = "LiquidAI/LFM2.5-VL-450M-ONNX";

/**
 * Pinned git commit (content-addressed integrity anchor). transformers.js
 * requests every file under this revision, so both the download URLs and the
 * cache keys are deterministic. Resolved from the Hub API on 2026-08-14.
 */
export const MODEL_REVISION = "95c283d4497a56477a83177079fa6b7121abb1b1";

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
// Decoder: decoder_model_merged_q4.onnx + ONE external-data shard
// (decoder_model_merged_q4.onnx_data). Vision encoder: vision_encoder_q4.onnx
// + ONE shard. Token embeddings come in a self-contained fp32 graph
// (embed_tokens.onnx) or an fp16 graph + one shard (embed_tokens_fp16.onnx*).
export const DECODER_GRAPH_URL = `${MODEL_BASE_URL}/onnx/decoder_model_merged_q4.onnx`;
const DECODER_DATA_BASE = "decoder_model_merged_q4.onnx_data";
const DECODER_DATA_COUNT = 1; // decoder_model_merged_q4.onnx_data (single shard)
const DATA_SHARD_URLS = (base: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${MODEL_BASE_URL}/onnx/${base}${i === 0 ? "" : `_${i}`}`);
export const DECODER_DATA_URLS = DATA_SHARD_URLS(DECODER_DATA_BASE, DECODER_DATA_COUNT);

// Vision encoder: vision_encoder_q4.onnx + 1 external-data shard.
export const VISION_GRAPH_URL = `${MODEL_BASE_URL}/onnx/vision_encoder_q4.onnx`;
export const VISION_DATA_URL = `${MODEL_BASE_URL}/onnx/vision_encoder_q4.onnx_data`;

// Token embeddings — the manifest ships fp16 and fp32 variants. Chrome GPUs
// almost always expose the `shader-f16` WebGPU feature; when they do we use the
// fp16 embed (~128 MB) to save ~134 MB download + VRAM. Otherwise the
// self-contained fp32 `embed_tokens.onnx` (~256 MB) is used.
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
// SHA-256 (lowercase hex) of EVERY model file the loader downloads, computed
// from the pinned `MODEL_REVISION` on 2026-08-14. The large weight blobs use
// their HuggingFace LFS content SHA-256 (`lfs.oid`); the small config/tokenizer
// files were hashed after being fetched from the pinned revision. Because every
// file is hash-pinned, the supply-chain guard is FULL-strength on first download
// AND on every later cache re-verification — no unpinned-weights opt-in is needed.
export const MODEL_FILE_HASHES: Partial<Record<string, string>> = {
  [CONFIG_JSON_URL]: "0827f68c3099103cc2c49235508e38fb4ce1f0fe1aa97f45ed19f7dbb9e30dfa",
  [GENERATION_CONFIG_URL]: "0b428903afb9a1cc2d4993f806c6e4689360fa557d31343ffce31f341619528f",
  [PREPROCESSOR_CONFIG_URL]: "5af96934bef15c4fdb69752c9b5de3918e237d5e50ca5d9191f1cf01706c57ca",
  [PROCESSOR_CONFIG_URL]: "622b75b531b3f49b1cdf4f90626c34e5ffb4f8bba2b8637807af0462398ae718",
  [TOKENIZER_JSON_URL]: "f3910942aa907c48b0cc20ec426ee38bfa8dcda8feecf035ced981918cb30f14",
  [TOKENIZER_CONFIG_URL]: "3013ff2da8f0fd18c053bf9fcc5411ee11607921e094781daf4ce109f217fd26",
  [CHAT_TEMPLATE_URL]: "309e586e2eda3d7f2db1e2a045bfb07f4c83798b23f7ac587954426302d508e9",
  [DECODER_GRAPH_URL]: "26600302bd9db0ef26d1a98fba0aae22dac99468e2195ce6d9b9bc7308c18f68",
  [DECODER_DATA_URLS[0]]: "b930a8ec51f6326c1b5e09e38fd0162fc69840b2f9b926025948a58a4e962c7d",
  [VISION_GRAPH_URL]: "6d4ca528b39be9473a2e483fd8c383bf444423135db087f22a65d672b90737f0",
  [VISION_DATA_URL]: "0c46c194ac38dc7050c5729296d2ac80c25848d0f3895bf29e0e05b481b8a731",
  [EMBED_FP16_GRAPH_URL]: "291d72b491d3187f3cafbb0ec35c5f889360a044d7db815510eff0fabb2af371",
  [EMBED_FP16_DATA_URL]: "6936dd14d4e0fa29f4046159dfa5738363f020216ed39a2ed14d276d8d473aa6",
  [EMBED_FP32_GRAPH_URL]: "3fcae1b697f9e35d181c119d41f06a3d9153bf09b19280ef154b5f77fd64f29c",
};

/** Exact byte sizes of every model file (from the Hub tree at the pinned revision). */
export const MODEL_FILE_SIZES: Partial<Record<string, number>> = {
  [CONFIG_JSON_URL]: 2540,
  [GENERATION_CONFIG_URL]: 131,
  [PREPROCESSOR_CONFIG_URL]: 732,
  [PROCESSOR_CONFIG_URL]: 828,
  [TOKENIZER_JSON_URL]: 4_733_040,
  [TOKENIZER_CONFIG_URL]: 4816,
  [CHAT_TEMPLATE_URL]: 3836,
  [DECODER_GRAPH_URL]: 171_898,
  [DECODER_DATA_URLS[0]]: 481_030_144,
  [VISION_GRAPH_URL]: 144_897,
  [VISION_DATA_URL]: 59_982_848,
  [EMBED_FP16_GRAPH_URL]: 573,
  [EMBED_FP16_DATA_URL]: 134_217_728,
  [EMBED_FP32_GRAPH_URL]: 268_435_815,
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
// downloaded model survives a version bump. Bumped (v1) because the model
// changed from LFM2.5-VL-3B to LFM2.5-VL-450M (different file set); a stale
// cache from the old model would otherwise fail digest checks.
export const CACHE_NAME = "lfm2-5-vl-450m-v1";

// Human-readable total download size (fp16-embed variant), shown in the UI
// before the download starts. Single source so the confirm dialog and any other
// copy cannot drift apart.
export const MODEL_DOWNLOAD_SIZE_LABEL = "~649 MB";
