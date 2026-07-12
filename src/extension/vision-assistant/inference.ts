/**
 * Vision Assistant — main inference engine.
 *
 * Loads the ONNX model, runs detection on screenshots, returns bounding boxes.
 * Ported from Reza2kn/LocateAnything-3B-WebGPU app.js.
 */

import * as ort from "onnxruntime-web";
import { ModelLoader } from "./model-loader";
import { preprocessScreenshot } from "./preprocessor";
import { gatherEmbed, f16to32, type EmbeddingMeta } from "./embedding-gather";
import { parseBoxes, toPixelCoords } from "./box-parser";
import type { PixelDetection, DownloadProgress, StatusCallback, VisionStatus } from "./types";
import {
  VISION_GRAPH_URL,
  VISION_DATA_URL,
  LANGUAGE_GRAPH_URL,
  LANGUAGE_DATA_URL,
  EMBED_PACKED_URL,
  EMBED_SCALES_URL,
  EMBED_META_URL,
  VISION_DATA_NAME,
  LANGUAGE_DATA_NAME,
  IMG_CONTEXT_TOKEN,
  IM_END_TOKEN,
  N_LAYERS,
  KV_HEADS,
  HEAD_DIM,
  PATCH_SIZE,
  MERGE_FACTOR,
  DETECTION_PROMPT,
  MAX_NEW_TOKENS,
  MODEL_REPO,
} from "./constants";

// Lazy-load transformers.js only when needed (keeps the extension bundle small).
// Reset the cached promise on rejection so a transient fetch failure (network
// drop, HuggingFace outage, auth issue) doesn't permanently disable Local
// Vision until SW restart — the next call retries from scratch.
let tokenizerLoadPromise: Promise<unknown> | null = null;
async function getTokenizer(): Promise<unknown> {
  if (!tokenizerLoadPromise) {
    tokenizerLoadPromise = import("@huggingface/transformers").then((mod) => {
      return mod.AutoTokenizer.from_pretrained(MODEL_REPO);
    }).catch((e) => {
      tokenizerLoadPromise = null; // allow retry on next call
      throw e;
    });
  }
  return tokenizerLoadPromise;
}

export class VisionAssistant {
  private visionSession: ort.InferenceSession | null = null;
  private languageSession: ort.InferenceSession | null = null;
  private tokenizer: unknown = null;
  private embPacked: Uint8Array | null = null;
  private embScales: Float32Array | null = null;
  private embMeta: EmbeddingMeta | null = null;
  private loader: ModelLoader = new ModelLoader();
  private _status: VisionStatus = "uninitialized";
  private statusCallback: StatusCallback | null = null;
  /**
 * Re-entrancy guard for `init()`. Two concurrent `init()` callers would both
 * pass the `isReady` check (neither is ready yet) and duplicate the ~2.1 GB
 * download + leak a WebGPU session. We cache the in-flight promise and return
 * it; the promise is cleared on settle (success or failure) so a failed init
 * can be retried — mirroring the `tokenizerLoadPromise` pattern.
 */
  private initPromise: Promise<void> | null = null;

  get status(): VisionStatus {
    return this._status;
  }

  get isReady(): boolean {
    return this._status === "ready" && this.visionSession !== null && this.languageSession !== null;
  }

  setStatus(status: VisionStatus, message?: string): void {
    this._status = status;
    this.statusCallback?.(status, message);
  }

  onStatus(callback: StatusCallback): void {
    this.statusCallback = callback;
  }

  /** Check if WebGPU is available in this browser. */
  static isWebGPUAvailable(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  /** Initialize: download model (if needed) + create ONNX sessions. */
  async init(onProgress?: (p: DownloadProgress) => void): Promise<void> {
 // Already fully initialized — cheap fast-path.
    if (this.isReady) return;
 // A concurrent init() is in flight — join it instead of double-downloading
 // and leaking a second WebGPU session.
    if (this.initPromise) return this.initPromise;

 // Cache the in-flight promise; clear it on settle so a failed init can be
 // retried and a subsequent call re-runs from scratch.
    this.initPromise = this.doInit(onProgress).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  /** Core initialization. See `init()` for the re-entrancy wrapper. */
  private async doInit(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (this.isReady) return;

    if (!VisionAssistant.isWebGPUAvailable()) {
      this.setStatus("error", "WebGPU is not available. Use Chrome/Edge 121+.");
      throw new Error("WebGPU not available");
    }

    try {
 // 1. Download / verify cache
      this.setStatus("checking");
      await this.loader.init();
      const cached = await this.loader.isCached();
      if (!cached) {
        this.setStatus("downloading");
        await this.loader.downloadAll(onProgress);
      }

 // 2. Create ONNX sessions
      this.setStatus("compiling");
 // `executionProviders` accepts strings per the
 // onnxruntime-common type definition (`ExecutionProviderConfig` includes
 // `string` in its union), so we can drop the previous `as any` cast.
      const sessOpts: ort.InferenceSession.SessionOptions = {
        executionProviders: ["webgpu", "wasm"],
        graphOptimizationLevel: "all",
      };

 // Vision session
      const visGraph = await this.loader.getBuffer(VISION_GRAPH_URL);
      const visData = await this.loader.getBuffer(VISION_DATA_URL);
      this.visionSession = await ort.InferenceSession.create(visGraph, {
        ...sessOpts,
        externalData: [{ path: VISION_DATA_NAME, data: visData }],
      });

 // Language session
      const langGraph = await this.loader.getBuffer(LANGUAGE_GRAPH_URL);
      const langData = await this.loader.getBuffer(LANGUAGE_DATA_URL);
      this.languageSession = await ort.InferenceSession.create(langGraph, {
        ...sessOpts,
        externalData: [{ path: LANGUAGE_DATA_NAME, data: langData }],
      });

 // Assert the ONNX export names its KV-cache outputs as expected
 // (`present_key_${i}` / `present_value_${i}`). The decode loop feeds
 // these straight back as `past_key_*` / `past_value_*`; a differently
 // named export would silently feed `undefined` and break every decode
 // step. Fail loudly here rather than mid-detection.
      this.assertKvCacheOutputs();

 // Assert the language ONNX export exposes a `logits` output by the exact
 // name this code reads. The decode loop and prefill both index
 // `res["logits"]`; if the export names it anything else (a model/export
 // version skew — exactly the failure class the KV-assert guards against),
 // `logits.dims[2]` would throw a cryptic "Cannot read properties of
 // undefined (reading 'dims')" mid-`detect()`. Fail loudly here instead.
      this.assertLogitsOutput();

 // 3. Load tokenizer + embedding table
      this.tokenizer = await getTokenizer();
 // Fail fast at init (rather than mid-`detect()`) if the tokenizer does not
 // map the literal "<IMG_CONTEXT>" to exactly one id equal to
 // IMG_CONTEXT_TOKEN. See `assertImageContextToken` for why this matters.
      await this.assertImageContextToken();
      this.embMeta = (await this.loader.getJSON(EMBED_META_URL)) as EmbeddingMeta;
      this.embPacked = await this.loader.getBuffer(EMBED_PACKED_URL);
      const scalesBytes = await this.loader.getBuffer(EMBED_SCALES_URL);

 // Reject a corrupt/partial cache up-front: the meta JSON MUST agree with
 // the binary layout, otherwise `gatherEmbed` reads misaligned bytes and
 // emits silently-garbage embeddings. (Further per-call guards live in
 // `gatherEmbed`.)
      this.validateEmbeddingShapes(scalesBytes);

      const sv = new DataView(scalesBytes.buffer);
      this.embScales = new Float32Array(scalesBytes.length >> 1);
      for (let i = 0; i < this.embScales.length; i++) {
        this.embScales[i] = f16to32(sv.getUint16(i * 2, true));
      }

      this.setStatus("ready");
    } catch (e) {
 // if init() threw partway through (e.g. vision session created
 // successfully but language session failed, or tokenizer/embedding
 // fetch failed after both sessions were up), the partially-created
 // ONNX sessions + embedding buffers would be leaked — ONNX WebGPU
 // sessions hold GPU memory that JS GC cannot free without an explicit
 // `session.release()` (see `cleanup()` below). Call cleanup() before
 // re-throwing so VRAM is reclaimed and the next init() attempt starts
 // from a clean slate. cleanup() is idempotent (re-entrant guard via
 // field-nulling) so this is safe even if it has already been called.
      await this.cleanup();
      this.setStatus("error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /**
 * Reject a `meta.json` that disagrees with the binary embedding buffers.
 * `packed` must hold exactly `vocab * hidden / 2` bytes (two 4-bit values per
 * byte) and `scales` must hold exactly `vocab * n_groups` fp16 values. The
 * group layout must also cover every hidden dimension (`n_groups * block_size
 * === hidden`). Throws on any mismatch so a partial/version-skewed cache
 * fails loudly instead of yielding garbage detections.
 */
  private validateEmbeddingShapes(scalesBytes: Uint8Array): void {
    const meta = this.embMeta;
    const packed = this.embPacked;
    if (!meta || !packed) {
      throw new Error("validateEmbeddingShapes: embedding meta/packed not loaded");
    }
    const { vocab, hidden, block_size, n_groups } = meta;
    for (const [name, v] of Object.entries({ vocab, hidden, block_size, n_groups })) {
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(`Embedding meta.${name}=${v} must be a positive integer`);
      }
    }
    if (hidden % 2 !== 0) {
      throw new Error(`Embedding meta.hidden=${hidden} must be even (INT4 packs 2 values/byte)`);
    }
    if (n_groups * block_size !== hidden) {
      throw new Error(
        `Embedding meta mismatch: n_groups(${n_groups}) * block_size(${block_size}) !== hidden(${hidden})`,
      );
    }
    const expectedPacked = vocab * (hidden / 2);
    if (packed.length !== expectedPacked) {
      throw new Error(
        `Embedding packed buffer length ${packed.length} !== expected vocab*H/2 = ${expectedPacked} ` +
          `(version skew or partial cache?)`,
      );
    }
    if (scalesBytes.length % 2 !== 0) {
      throw new Error(
        `Embedding scales buffer length ${scalesBytes.length} is odd; fp16 scale stream is corrupt`,
      );
    }
    const expectedScales = vocab * n_groups;
    if (scalesBytes.length / 2 !== expectedScales) {
      throw new Error(
        `Embedding scales buffer length ${scalesBytes.length} !== expected 2*vocab*n_groups = ${expectedScales * 2} ` +
          `(version skew or partial cache?)`,
      );
    }
  }

  /**
 * Assert the language ONNX export exposes KV-cache outputs named
 * `present_key_${i}` / `present_value_${i}` for every layer, deriving the
 * expected count from `N_LAYERS`. If the export names them differently, the
 * decode loop would feed `undefined` into `past_key_0` and fail silently, so
 * we surface the real available names in the error.
 */
  private assertKvCacheOutputs(): void {
    const session = this.languageSession;
    if (!session) {
      throw new Error("assertKvCacheOutputs: language session not created");
    }
    const names = new Set(session.outputNames);
    const missing: string[] = [];
    for (let i = 0; i < N_LAYERS; i++) {
      if (!names.has(`present_key_${i}`)) missing.push(`present_key_${i}`);
      if (!names.has(`present_value_${i}`)) missing.push(`present_value_${i}`);
    }
    if (missing.length) {
      throw new Error(
        `Language ONNX export missing expected KV-cache outputs: ${missing.join(", ")}. ` +
          `Actual outputs: ${session.outputNames.join(", ")}`,
      );
    }
  }

  /**
 * Assert the language ONNX export exposes a `logits` output named exactly
 * `"logits"` — the key read by both the prefill (`res["logits"]`) and every
 * decode step (`res["logits"]`). A model/export version skew that renames the
 * output (e.g. to `logits_0`) would otherwise make `res["logits"]` undefined
 * and throw a cryptic `Cannot read properties of undefined (reading 'dims')`
 * mid-`detect()`, masked by the caller's `.catch(() => [])` into silent
 * zero-detection. Surface the real available names here instead.
 */
  private assertLogitsOutput(): void {
    const session = this.languageSession;
    if (!session) {
      throw new Error("assertLogitsOutput: language session not created");
    }
    if (!session.outputNames.includes("logits")) {
      throw new Error(
        `Language ONNX export missing expected "logits" output. ` +
          `Actual outputs: ${session.outputNames.join(", ")}`,
      );
    }
  }

  /** Read the `logits` output from a language-session run, failing loudly if
 * the export did not produce it (defensive — name validity is asserted at
 * init via `assertLogitsOutput`). */
  private getLogits(res: Record<string, ort.Tensor>): ort.Tensor {
    const logits = res["logits"];
    if (!logits) {
      throw new Error(
        `Language session produced no "logits" output. ` +
          `Actual keys: ${Object.keys(res).join(", ")}`,
      );
    }
    return logits;
  }

  /**
 * Verify at init time — rather than mid-`detect()` — that the literal
 * `<IMG_CONTEXT>` maps to exactly one tokenizer id equal to
 * `IMG_CONTEXT_TOKEN`. The detection pipeline injects
 * `"<IMG_CONTEXT>".repeat(N)` and then counts occurrences of that token; if
 * the tokenizer BPE-splits the literal, `detect()` would count 0 occurrences
 * and throw — surfacing that here gives a clear, early error instead of a
 * feature that appears to work but detects nothing.
 */
  private async assertImageContextToken(): Promise<void> {
    const t = this.tokenizer as (
      str: string,
      opts: { add_special_tokens: boolean },
    ) => Promise<{ input_ids: { data: BigInt64Array | number[] } }>;
    const enc = await t("<IMG_CONTEXT>", { add_special_tokens: false });
    const ids = Array.from(enc.input_ids.data, (x: unknown) => Number(x));
    if (ids.length !== 1 || ids[0] !== IMG_CONTEXT_TOKEN) {
      throw new Error(
        `Vision init: literal "<IMG_CONTEXT>" tokenized to ${JSON.stringify(ids)} ` +
          `(expected a single id === IMG_CONTEXT_TOKEN=${IMG_CONTEXT_TOKEN}). ` +
          `Local Vision cannot function with this tokenizer/model.`,
      );
    }
  }

  /** Run detection on a screenshot. Returns pixel-coordinate detections. */
  async detect(screenshotDataUrl: string): Promise<PixelDetection[]> {
    if (!this.isReady || !this.visionSession || !this.languageSession || !this.embMeta || !this.embPacked || !this.embScales) {
      throw new Error("Vision assistant not ready");
    }

    const H = this.embMeta.hidden;

 // 1. Preprocess screenshot
    const { pixelValues, gridHeight, gridWidth, nPatches, originalWidth, originalHeight, targetWidth, targetHeight, rescaledWidth, rescaledHeight } =
      await preprocessScreenshot(screenshotDataUrl);

 // 2. Vision session: pixel_values → visual_features
    const pvTensor = new ort.Tensor("float32", pixelValues, [nPatches, 3, PATCH_SIZE, PATCH_SIZE]);
    const ghTensor = new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(gridHeight), BigInt(gridWidth)]),
      [1, 2],
    );
    const vOut = await this.visionSession.run({
      pixel_values: pvTensor,
      image_grid_hws: ghTensor,
    });
    const visual = vOut[this.visionSession.outputNames[0]];
 // The vision encoder's feature width MUST equal the LM embedding dim `H`
 // from meta.json. If they differ, every <IMG_CONTEXT> slot reads the wrong
 // H floats at the wrong byte offset (`visIdx*H` instead of `visIdx*width`)
 // and the model emits confidently-wrong boxes with no error. Fail loudly
 // before any splicing occurs. (Replaces the misleading hard-coded `[N, 2048]`
 // comment, which contradicted the actual stride used below.)
    if (!visual || visual.dims.length !== 2 || Number(visual.dims[1]) !== H) {
      throw new Error(
        `Vision encoder output shape mismatch: feature width ` +
          `${visual ? visual.dims[1] : "n/a"} !== embedding hidden ${H} ` +
          `(dims=${JSON.stringify(visual?.dims)})`,
      );
    }

 // 3. Build prompt + tokenize
    const N = Math.floor((gridHeight * gridWidth) / (MERGE_FACTOR * MERGE_FACTOR));
    const promptStr =
      `<|im_start|>system\nYou are a helpful assistant.\n<|im_end|>\n<|im_start|>user\n<image 1><img>` +
      "<IMG_CONTEXT>".repeat(N) +
      `</img>${DETECTION_PROMPT}<|im_end|>\n<|im_start|>assistant\n`;

 // transformers.js `PreTrainedTokenizer` extends `Callable` — the tokenizer
 // is invoked directly as a function (the `Callable` closure delegates to
 // `_call`), there is no `__call__` method. The previous `.__call__(...)`
 // cast compiled but threw `TypeError: tokenizer.__call__ is not a function`
 // at runtime, silently killing Local Vision. Cast to the actual callable
 // signature instead.
    const tokenizer = this.tokenizer as (
      str: string,
      opts: { add_special_tokens: boolean },
    ) => Promise<{ input_ids: { data: BigInt64Array | number[] } }>;
    const enc = await tokenizer(promptStr, { add_special_tokens: false });
    const ids = Array.from(enc.input_ids.data, (x: unknown) => Number(x));

 // The tokenizer must emit exactly N <IMG_CONTEXT> tokens to match the N
 // placeholders injected into the prompt and the N rows of `visual_features`.
 // If it emits a different count (e.g. it splits/merges the token for this
 // model/input), splicing by occurrence would run `visIdx` past `vdata`
 // (length N*H); `subarray` would then clamp to an empty slice that
 // `embeds.set` silently writes as a zeroed embedding, degrading detection
 // without raising an error. Detect and bail out rather than mis-embed.
    const ctxCount = ids.reduce((acc: number, id: number) => acc + (id === IMG_CONTEXT_TOKEN ? 1 : 0), 0);
    if (ctxCount !== N) {
      const msg = `Vision detect(): tokenizer emitted ${ctxCount} <IMG_CONTEXT> tokens but ${N} were injected; aborting to avoid mis-embedding.`;
      console.warn(msg);
      throw new Error(msg);
    }

 // 4. Build inputs_embeds: INT4 gather + visual splice at IMG_CONTEXT positions
    const L = ids.length;
    const embeds = new Float32Array(L * H);
    let visIdx = 0;
    const vdata = visual.data as Float32Array;
    for (let i = 0; i < L; i++) {
      if (ids[i] === IMG_CONTEXT_TOKEN) {
        embeds.set(vdata.subarray(visIdx * H, (visIdx + 1) * H), i * H);
        visIdx++;
      } else {
        gatherEmbed(ids[i], embeds, i * H, this.embPacked, this.embScales, this.embMeta);
      }
    }

 // 5. KV-cache prefill
    const idsBig = BigInt64Array.from(ids.map((x: number) => BigInt(x)));
    const mkEmptyPast = (): Record<string, ort.Tensor> => {
      const f: Record<string, ort.Tensor> = {};
      for (let i = 0; i < N_LAYERS; i++) {
        f[`past_key_${i}`] = new ort.Tensor("float32", new Float32Array(0), [1, KV_HEADS, 0, HEAD_DIM]);
        f[`past_value_${i}`] = new ort.Tensor("float32", new Float32Array(0), [1, KV_HEADS, 0, HEAD_DIM]);
      }
      return f;
    };

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", idsBig, [1, L]),
      inputs_embeds: new ort.Tensor("float32", embeds, [1, L, H]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(new Array(L).fill(BigInt(1))), [1, L]),
      position_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map((_: number, i: number) => BigInt(i))), [1, L]),
      ...mkEmptyPast(),
    };

    let res = await this.languageSession.run(feeds);
    let present = res as Record<string, ort.Tensor>;
    const logits = this.getLogits(res);
    const V = logits.dims[2];
    let next = argmaxLast(logits.data as Float32Array, V);
    const gen: number[] = [next];

 // 6. Decode loop with KV cache
    let pastLen = L;
    for (let step = 0; step < MAX_NEW_TOKENS - 1; step++) {
      if (next === IM_END_TOKEN) break;
      const emb1 = new Float32Array(H);
      gatherEmbed(next, emb1, 0, this.embPacked, this.embScales, this.embMeta);
      const f: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(next)]), [1, 1]),
        inputs_embeds: new ort.Tensor("float32", emb1, [1, 1, H]),
        attention_mask: new ort.Tensor("int64", BigInt64Array.from(new Array(pastLen + 1).fill(BigInt(1))), [1, pastLen + 1]),
        position_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(pastLen)]), [1, 1]),
      };
      for (let i = 0; i < N_LAYERS; i++) {
        f[`past_key_${i}`] = present[`present_key_${i}`];
        f[`past_value_${i}`] = present[`present_value_${i}`];
      }
      res = await this.languageSession.run(f);
      present = res as Record<string, ort.Tensor>;
      next = argmaxLast(this.getLogits(res).data as Float32Array, V);
      gen.push(next);
      pastLen += 1;
    }

 // 7. Decode + parse
    const decodeTokenizer = this.tokenizer as { decode: (ids: number[], opts: unknown) => string };
    const text = decodeTokenizer.decode(gen, { skip_special_tokens: false });
    const detections = parseBoxes(text);

 // Convert normalized 0-1000 coordinates to pixel coordinates in the
 // ORIGINAL screenshot's pixel space. The model normalizes over the
 // PADDED canvas (targetWidth × targetHeight), so we must account for
 // both the rescale (original → rescaled) and the padding (rescaled →
 // target) when mapping back to original device pixels.
 // Formula: X_original = (X_model / 1000) * targetWidth * (originalWidth / rescaledWidth)
 // Guard against a degenerate screenshot (e.g. 1x1) that drives rescaledWidth/
 // rescaledHeight to 0 after `Math.floor(w * scale)`; dividing by 0 would yield
 // Infinity/NaN coordinates flowing into CDP Input.dispatchMouseEvent.
    if (!(rescaledWidth > 0) || !(rescaledHeight > 0)) {
      throw new Error(
        `Vision detect(): non-positive rescaled screenshot dimension ` +
          `(rescaledWidth=${rescaledWidth}, rescaledHeight=${rescaledHeight}); ` +
          `cannot map to pixel coords`,
      );
    }
    const effectiveWidth = targetWidth * (originalWidth / rescaledWidth);
    const effectiveHeight = targetHeight * (originalHeight / rescaledHeight);
 // Clamp to the ORIGINAL screenshot bounds (originalWidth ×
 // originalHeight), not the padded canvas bounds (effectiveWidth ×
 // effectiveHeight). effectiveWidth ≥ originalWidth due to padding; clamping
 // to effectiveWidth-1 would allow coords 3-6 CSS px beyond the viewport.
    return toPixelCoords(detections, effectiveWidth, effectiveHeight, originalWidth, originalHeight);
  }

  /** Release ONNX sessions and free VRAM. */
  async cleanup(): Promise<void> {
 // ONNX WebGPU InferenceSessions hold GPU memory that JavaScript GC
 // cannot free — only an explicit `await session.release()` reclaims it.
 // Capture the sessions into locals BEFORE nulling the fields so we can
 // release them even if `cleanup()` is re-entered concurrently (the field
 // reads happen first; the second call sees nulls and skips the release).
 // Wrap each release in try/catch because `release()` can throw if the
 // session is already released/disposed (e.g. user toggled off twice or
 // the WebGPU device was lost).
    const vision = this.visionSession;
    const language = this.languageSession;
    this.visionSession = null;
    this.languageSession = null;
    this.tokenizer = null;
    this.embPacked = null;
    this.embScales = null;
    this.embMeta = null;
    this.setStatus("uninitialized");
    if (vision) {
      try {
        await vision.release();
      } catch {
 // Already released or device lost — safe to ignore.
      }
    }
    if (language) {
      try {
        await language.release();
      } catch {
 // Already released or device lost — safe to ignore.
      }
    }
  }

  /** Delete cached model files. */
  async clearCache(): Promise<void> {
    await this.loader.clearCache();
    await this.cleanup();
  }
}

/** Argmax over the last row of logits [1, T, V]. */
function argmaxLast(arr: Float32Array, V: number): number {
  const base = arr.length - V;
  let best = 0;
  let bv = -Infinity;
  for (let i = 0; i < V; i++) {
    const v = arr[base + i];
    if (v > bv) {
      bv = v;
      best = i;
    }
  }
  return best;
}
