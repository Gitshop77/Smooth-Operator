/**
 * Vision Assistant — main inference engine.
 *
 * Loads the ONNX model, runs detection on screenshots, returns bounding boxes.
 * Ported from Reza2kn/LocateAnything-3B-WebGPU app.js.
 */

import * as ort from "onnxruntime-web/webgpu";
import { ModelLoader } from "./model-loader";
import { preprocessScreenshot } from "./preprocessor";
import { gatherEmbed, markEmbeddingMetaValidated, type EmbeddingMeta } from "./embedding-gather";
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
  PATCH_SIZE,
  MERGE_FACTOR,
  DETECTION_PROMPT,
  MAX_NEW_TOKENS,
} from "./constants";
import {
  pastKeyNames,
  presentKeyNames,
  pastValueNames,
  presentValueNames,
  EMPTY_PAST,
  argmaxLast,
  getLogits,
  assertKvCacheOutputs,
  assertLogitsOutput,
  assertVisionOutput,
  assertLanguageInputs,
  decodeFp16Scales,
  validateVisionOutput,
  validateLogitsShape,
  validateEmbeddingShapes,
} from "./inference-utils";
import { getTokenizer } from "./tokenizer";
import {
  MemoryWatchdog,
  readMemoryInfo,
  pushMemoryWarning,
} from "./memory-watchdog";

/** Tokenizer callable signature (also used for the decode tokenizer below). */
type TokenizeFn = (
  str: string,
  opts: { add_special_tokens: boolean },
) => Promise<{ input_ids: { data: BigInt64Array | number[] } }>;
/** Tokenizer decode signature. */
type DecodeFn = { decode: (ids: number[], opts: unknown) => string };

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
   * pass the `isReady` check (neither is ready yet) and duplicate the ~2 GB
 * download + leak a WebGPU session. We cache the in-flight promise and return
 * it; the promise is cleared on settle (success or failure) so a failed init
 * can be retried — mirroring the `tokenizerLoadPromise` pattern.
 */
  private initPromise: Promise<void> | null = null;
  /**
 * Re-entrancy guard for `detect()`. Two concurrent `detect()` calls would
 * interleave `session.run(feeds)` on the shared vision/language ONNX sessions
 * and clobber the KV-cache/prefill state, producing garbage detections or
 * throwing mid-decode. We cache the in-flight promise and return it so a
 * second concurrent caller awaits the same detection instead of racing the
 * tensor feeds. Mirrors the `initPromise` pattern (cleared on settle so a
 * failed detect can be retried).
 */
  private detectPromise: Promise<PixelDetection[]> | null = null;
  /** The screenshot `detect()` is currently running on. Lets identical,
   * re-entrant inputs share the in-flight run (see `detect()`) while a
   * *different* concurrent screenshot is serialized behind the chain rather
   * than silently being served the wrong detections. */
  private detectDataUrl: string | null = null;
  /**
 * Serialization tail for overlapping `detect()` calls. Two concurrent
 * `detect()` calls on the shared vision/language ONNX sessions would clobber
 * the KV-cache/prefill state. Instead of throwing (the previous behavior), a
 * second call with a DIFFERENT screenshot appends to this chain and awaits the
 * prior run(s), then executes its own `doDetect()` for its own input — so each
 * caller resolves with its own correct detections. The tail is kept alive
 * across rejections (swallowed to `undefined`) so queued calls still execute.
 * Identical-input sharing against the *currently running* run is handled
 * separately by `detectPromise`/`detectDataUrl` and is preserved unchanged.
 */
  private chain: Promise<unknown> | null = null;
  /** JS-heap growth watchdog sampled at the end of each detection run. */
  private memoryWatchdog = new MemoryWatchdog();

  constructor() {
    // Surface the non-fatal supply-chain warning (unpinned-weights opt-in)
    // as a visible status so the UI shows it instead of a silent console.warn.
    this.loader.onWarning((msg) => this.setStatus("warning", msg));
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

  /**
   * Sample Chrome's JS heap after a detection and surface a memory-growth
   * warning when the watchdog fires. The warning goes to the status callback
   * (without flipping `_status`, so a warning never disables an active run)
   * and to the module-level notice registry that the background SW watchdog
   * drains into the side panel.
   */
  private sampleMemory(): void {
    const info = readMemoryInfo();
    if (!info) return;
    const warning = this.memoryWatchdog.record(info);
    if (warning) {
      pushMemoryWarning(warning);
      this.statusCallback?.("warning", warning.message);
    }
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
    // WebGPU has been available in MV3 service workers since Chrome/Edge 124
    // (121–123 expose it in page contexts only). The guard still matters for
    // older versions and WebGPU-disabled contexts — fail with a clear error
    // here rather than mid-detect.
    if (!VisionAssistant.isWebGPUAvailable()) {
      this.setStatus("error", "WebGPU is not available. Use Chrome/Edge 124+ (the minimum for WebGPU in the service worker).");
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
      assertKvCacheOutputs(this.languageSession!);

 // Assert the language ONNX export exposes a `logits` output by the exact
 // name this code reads. The decode loop and prefill both index
 // `res["logits"]`; if the export names it anything else (a model/export
 // version skew — exactly the failure class the KV-assert guards against),
 // `logits.dims[2]` would throw a cryptic "Cannot read properties of
 // undefined (reading 'dims')" mid-`detect()`. Fail loudly here instead.
      assertLogitsOutput(this.languageSession!);

      // Assert the vision ONNX export exposes exactly one output named
      // "visual_features" — the detect loop indexes the run result by
      // position today, and a re-exported model with renamed or extra
      // outputs would silently feed the wrong tensor into the embedding
      // splice. Fail loudly here rather than mid-detect.
      assertVisionOutput(this.visionSession!);

      // Assert the language ONNX export declares every input name the
      // prefill and decode loops feed (input_ids / inputs_embeds /
      // attention_mask / position_ids + past_key_* / past_value_*). The
      // feeds are keyed by name, so a renamed input in a version-skewed
      // export would fail only at the first session.run — which the caller
      // swallows into a silent "no detections". Fail loudly here instead.
      assertLanguageInputs(this.languageSession!);

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
      validateEmbeddingShapes(this.embMeta!, this.embPacked!, scalesBytes);
      markEmbeddingMetaValidated(this.embMeta!);

      this.embScales = decodeFp16Scales(scalesBytes);

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
 * Verify at init time — rather than mid-`detect()` — that the literal
 * `<IMG_CONTEXT>` maps to exactly one tokenizer id equal to
 * `IMG_CONTEXT_TOKEN`. The detection pipeline injects
 * `"<IMG_CONTEXT>".repeat(N)` and then counts occurrences of that token; if
 * the tokenizer BPE-splits the literal, `detect()` would count 0 occurrences
 * and throw — surfacing that here gives a clear, early error instead of a
 * feature that appears to work but detects nothing.
 */
  private async assertImageContextToken(): Promise<void> {
    const t = this.tokenizer as TokenizeFn;
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

  /** Run detection on a screenshot. Returns pixel-coordinate detections.
 * An optional `signal` short-circuits the decode loop when the run is
 * aborted, reclaiming the GPU/CPU that would otherwise be spent finishing
 * an abandoned detection. */
  async detect(screenshotDataUrl: string, signal?: AbortSignal): Promise<PixelDetection[]> {
    // Chrome/Edge expose WebGPU in service workers since 124, so
    // `navigator.gpu` is normally present when detect() runs from the SW.
    // Guard anyway: on 121–123 (page-context WebGPU only) or when WebGPU is
    // disabled, fail with a clear, descriptive error instead of letting the
    // call surface an opaque "WebGPU not available" rejection. (Vision stays
    // bundled in the SW; it just degrades gracefully when WebGPU is absent.)
    if (!VisionAssistant.isWebGPUAvailable()) {
      throw new Error(
        "WebGPU not available; Local Vision requires WebGPU (Chrome/Edge 124+ in the service worker). " +
          "It cannot run in a context without navigator.gpu.",
      );
    }
 // Re-entrancy guard over the shared ONNX sessions. Two concurrent `detect()`
 // calls would interleave `session.run(feeds)` on the same vision/language
 // sessions and clobber the KV-cache/prefill state, producing garbage
 // detections or throwing mid-decode. We serialize so no two `doDetect()`
 // runs ever overlap.

 // (1) Identical-input sharing (preserved from the original): if the SAME
 //     screenshot is currently running, return the cached promise instead of
 //     queueing a duplicate run. This is checked synchronously against the
 //     live run so two overlapping calls for the same input share one result.
 //     An aborted second caller must not be handed the full detection — honor
 //     its signal and throw AbortError like every other abort check.
    if (this.detectPromise && this.detectDataUrl === screenshotDataUrl) {
      if (signal?.aborted) throw new DOMException("Vision detect aborted", "AbortError");
      return this.detectPromise;
    }

 // (2) Serialize a DIFFERENT concurrent screenshot instead of throwing. Append
 //     to the chain and await the prior run, then execute this input's own
 //     `doDetect()`. Each caller resolves with its own correct detections.
    if (this.detectPromise) {
      const tail = this.chain ?? this.detectPromise;
      const run = tail.then(() => this.runDetect(screenshotDataUrl, signal));
 // Keep the chain alive across rejections so later queued calls still run.
      this.chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }

 // (3) No current run — start immediately (synchronous, so identical-input
 //     sharing in a fresh burst still works).
    return this.runDetect(screenshotDataUrl, signal);
  }

  /**
 * Start a single serialized `detect()` run on the shared ONNX sessions. Sets
 * the live-run bookkeeping (`detectPromise`/`detectDataUrl`) synchronously so
 * that an overlapping identical-input call shares this promise, and records the
 * tail of the serialization chain. Cleared on settle so a failed run can be
 * retried.
 */
  private runDetect(screenshotDataUrl: string, signal?: AbortSignal): Promise<PixelDetection[]> {
    this.detectDataUrl = screenshotDataUrl;
    this.detectPromise = this.doDetect(screenshotDataUrl, signal).finally(() => {
      this.detectPromise = null;
      this.detectDataUrl = null;
      this.chain = null;
    });
  // The chain tail is the live run; queued calls append after it.
    this.chain = this.detectPromise;
    return this.detectPromise;
  }

  private sampleNextToken(res: Record<string, ort.Tensor>): number {
    const logits = getLogits(res);
    const V = validateLogitsShape(logits, "Vision detect()");
    return argmaxLast(logits.data as Float32Array, V);
  }

  /** Core detection. See `detect()` for the re-entrancy wrapper. */
  private async doDetect(screenshotDataUrl: string, signal?: AbortSignal): Promise<PixelDetection[]> {
    if (!this.isReady || !this.visionSession || !this.languageSession || !this.embMeta || !this.embPacked || !this.embScales) {
      throw new Error("Vision assistant not ready");
    }

    if (signal?.aborted) throw new DOMException("Vision detect aborted", "AbortError");

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
 // 3. Build prompt + tokenize
    const N = Math.floor((gridHeight * gridWidth) / (MERGE_FACTOR * MERGE_FACTOR));
    validateVisionOutput(visual, H, N);
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
    const tokenizer = this.tokenizer as TokenizeFn;
    const enc = await tokenizer(promptStr, { add_special_tokens: false });
// Build ids array and count IMG_CONTEXT tokens in a single pass.
    const ids: number[] = [];
    let ctxCount = 0;
    for (const x of enc.input_ids.data) {
      const id = Number(x);
      ids.push(id);
      if (id === IMG_CONTEXT_TOKEN) ctxCount++;
    }

// The tokenizer must emit exactly N <IMG_CONTEXT> tokens to match the N
// placeholders injected into the prompt and the N rows of `visual_features`.
// If it emits a different count (e.g. it splits/merges the token for this
// model/input), splicing by occurrence would run `visIdx` past `vdata`
// (length N*H); `subarray` would then clamp to an empty slice that
// `embeds.set` silently writes as a zeroed embedding, degrading detection
// without raising an error. Detect and bail out rather than mis-embed.
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
    const idsBig = BigInt64Array.from(ids);

// Module-level empty past tensors — immutable zero-length sentinels reused
// across every detect() call to avoid re-allocating 72 tensors per detection.
    const attnMaskBuf = new BigInt64Array(L + MAX_NEW_TOKENS);
    attnMaskBuf.fill(BigInt(1));

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", idsBig, [1, L]),
      inputs_embeds: new ort.Tensor("float32", embeds, [1, L, H]),
      attention_mask: new ort.Tensor("int64", attnMaskBuf.subarray(0, L), [1, L]),
      position_ids: new ort.Tensor("int64", BigInt64Array.from({ length: L }, (_, i) => BigInt(i)), [1, L]),
      ...EMPTY_PAST,
    };

    if (signal?.aborted) throw new DOMException("Vision detect aborted", "AbortError");

    let res = await this.languageSession.run(feeds);
    let next = this.sampleNextToken(res);
    const gen: number[] = [next];

// 6. Decode loop with KV cache
    let pastLen = L;
    const emb1 = new Float32Array(H);
    for (let step = 0; step < MAX_NEW_TOKENS - 1; step++) {
      if (next === IM_END_TOKEN) break;
// Short-circuit the decode loop when the run is aborted. `session.run`
// itself isn't interruptible, but skipping the remaining decode steps
// reclaims the GPU/CPU that would otherwise finish an abandoned result.
      if (signal?.aborted) throw new DOMException("Vision detect aborted", "AbortError");
      emb1.fill(0);
      gatherEmbed(next, emb1, 0, this.embPacked, this.embScales, this.embMeta);
      const f: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(next)]), [1, 1]),
        inputs_embeds: new ort.Tensor("float32", emb1, [1, 1, H]),
        attention_mask: new ort.Tensor("int64", attnMaskBuf.subarray(0, pastLen + 1), [1, pastLen + 1]),
        position_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(pastLen)]), [1, 1]),
      };
      for (let i = 0; i < N_LAYERS; i++) {
        f[pastKeyNames[i]] = res[presentKeyNames[i]];
        f[pastValueNames[i]] = res[presentValueNames[i]];
      }
      res = await this.languageSession.run(f);
      next = this.sampleNextToken(res);
      gen.push(next);
      pastLen += 1;
    }

 // 7. Decode + parse
    const decodeTokenizer = this.tokenizer as DecodeFn;
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
    const pixelDetections = toPixelCoords(detections, effectiveWidth, effectiveHeight, originalWidth, originalHeight);
    // Sample the JS heap after a successful run — the first run establishes
    // the baseline, later runs measure growth across detections.
    this.sampleMemory();
    return pixelDetections;
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
    // Sessions released → heap drops back; rebaseline so the next init
    // measures from a fresh episode instead of the pre-cleanup high-water.
    this.memoryWatchdog.reset();
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
}


