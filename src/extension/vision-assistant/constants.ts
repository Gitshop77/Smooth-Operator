/**
 * Vision Assistant — model constants for LocateAnything-3B ONNX WebGPU INT4.
 *
 * All URLs, token IDs, and architecture constants in one place.
 * Ported from Reza2kn/LocateAnything-3B-WebGPU app.js.
 */

/**
 * HuggingFace repo for the ONNX INT4 model.
 *
 * `MODEL_REPO_URL` is the human-readable repo page (for documentation / README).
 * `MODEL_BASE_URL` is the file-serving prefix — HuggingFace serves individual
 * files at `{repo}/resolve/main/{path}`, which 302-redirects to the CDN.
 * The bare `/resolve/main` URL 404s in a browser, but appending a file path
 * (e.g. `/onnx/vision_mlp_int4.onnx`) yields a valid download. This is how the
 * model-loader fetches the 2.1 GB of ONNX weights.
 *
 * The original model is NVIDIA's LocateAnything-3B:
 *   https://huggingface.co/nvidia/LocateAnything-3B
 * This is the in-browser ONNX INT4 port by Reza2kn.
 */
export const MODEL_REPO = "Reza2kn/LocateAnything-3B-ONNX-WebGPU-INT4";
export const MODEL_REPO_URL = `https://huggingface.co/${MODEL_REPO}`;
export const MODEL_BASE_URL = `${MODEL_REPO_URL}/resolve/main`;

// Model file URLs (7 files, ~2.1 GB total)
export const VISION_GRAPH_URL = `${MODEL_BASE_URL}/onnx/vision_mlp_int4.onnx`;
export const VISION_DATA_URL = `${MODEL_BASE_URL}/onnx/vision_mlp_int4.onnx.data`;
export const LANGUAGE_GRAPH_URL = `${MODEL_BASE_URL}/onnx/language_tail_kv_int4.onnx`;
export const LANGUAGE_DATA_URL = `${MODEL_BASE_URL}/onnx/language_tail_kv_int4.onnx.data`;
export const EMBED_PACKED_URL = `${MODEL_BASE_URL}/onnx/embed_tokens_int4_packed.bin`;
export const EMBED_SCALES_URL = `${MODEL_BASE_URL}/onnx/embed_tokens_int4_scales.bin`;
export const EMBED_META_URL = `${MODEL_BASE_URL}/onnx/embed_tokens_int4_meta.json`;

// Internal file names for ONNX externalData
export const VISION_DATA_NAME = "vision_mlp_int4.onnx.data";
export const LANGUAGE_DATA_NAME = "language_tail_kv_int4.onnx.data";

// Token IDs (from Qwen2.5-3B config)
export const IMG_CONTEXT_TOKEN = 151665;
export const IM_END_TOKEN = 151645;

// Model architecture (Qwen2.5-3B)
export const N_LAYERS = 36;
export const KV_HEADS = 2;
export const HEAD_DIM = 128;

// Image preprocessing (MoonViT)
export const PATCH_SIZE = 14;
export const MERGE_FACTOR = 2;
export const MAX_IMAGE_PATCHES = 256;
export const IMAGE_MEAN = 0.5;
export const IMAGE_STD = 0.5;

// Detection prompt — what we ask LocateAnything to find on each screenshot
export const DETECTION_PROMPT =
  "Locate all the instances that matches the following description: " +
  "button, link, input, select, textarea, submit, search, login, " +
  "checkbox, radio, dropdown, menu, tab, icon, image, canvas element, " +
  "chart, graph, modal, dialog, popup, banner, notification, alert.";

// Generation limits
export const MAX_NEW_TOKENS = 128;

// Download settings
export const DOWNLOAD_CHUNK_SIZE = 48 * 1024 * 1024; // 48 MB
export const DOWNLOAD_MAX_RETRIES = 5;
export const DOWNLOAD_STALL_MS = 30_000;

// Cache Storage key
export const CACHE_NAME = "locateanything-model";
