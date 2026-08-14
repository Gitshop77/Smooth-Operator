/**
 * Vision Assistant — main inference engine.
 *
 * Runs LiquidAI LFM2.5-VL-3B (ONNX Q4) locally on WebGPU via transformers.js
 * and answers grounding queries on screenshots, returning 0-1000-normalized
 * bounding boxes converted to pixel coordinates.
 *
 * Ported from the LiquidAI/LFM2.5-VL-3B-WebGPU Space engine
 * (`src/engines/onnx-transformers-engine.js`) and adapted to this extension's
 * model loader (SHA-256/size-verified, Cache-Storage-persisted weights) and the
 * existing `VisionAssistant` public API.
 */

import {
  AutoConfig,
  AutoModelForImageTextToText,
  AutoProcessor,
  env,
  InterruptableStoppingCriteria,
  RawImage,
} from "@huggingface/transformers";
import { ModelLoader } from "./model-loader";
import { groundingToDetections, parseGroundingResponse } from "./grounding-parser";
import { toPixelCoords } from "./box-parser";
import type { DownloadProgress, PixelDetection, StatusCallback, VisionStatus } from "./types";
import {
  CACHE_NAME,
  DETECTION_SYSTEM_PROMPT,
  DETECTION_USER_PROMPT,
  MAX_NEW_TOKENS,
  MODEL_DOWNLOAD_SIZE_LABEL,
  MODEL_REPO,
  MODEL_REVISION,
  modelFileEntries,
  pickEmbeddingPrecision,
  type EmbeddingPrecision,
} from "./constants";
import {
  MemoryWatchdog,
  readMemoryInfo,
  pushMemoryWarning,
} from "./memory-watchdog";

/**
 * Minimal structural types for the transformers.js pieces we drive. Kept local
 * so a transformers.js type upgrade can't ripple through the extension.
 */

/** Tokenizer surface used by the processor. */
interface TokenizerLike {
  apply_chat_template(messages: unknown[], opts: Record<string, unknown>): string;
  decode(ids: number[], opts: { skip_special_tokens: boolean }): string;
}

/** Callable processor (image + chat-formatted text → model inputs). */
interface ProcessorLike {
  tokenizer: TokenizerLike;
  (images: RawImage[], text: string): Promise<Record<string, unknown>>;
}

/** `sequences.tolist()` shape returned by `model.generate`. */
interface SequencesLike {
  tolist?: () => Array<Array<number>>;
}

/** `model.generate` return surface. */
interface GeneratedLike {
  sequences?: SequencesLike;
}

/** The `PreTrainedModel` surface we use. */
interface ModelLike {
  generate(opts: Record<string, unknown>): Promise<GeneratedLike>;
  dispose(): Promise<void>;
}

/** processors/pretrained options; narrowed to the fields we set. */
type PretrainedOptions = Parameters<typeof AutoConfig.from_pretrained>[1];

/** Decode a screenshot data URL to a Blob without depending on `fetch(data:)`
 * (which is unreliable in service-worker contexts). Falls back to `fetch` for
 * non-base64 payloads (e.g. percent-encoded SVGs). */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  try {
    const comma = dataUrl.indexOf(",");
    if (comma === -1) throw new Error("not a data URL");
    const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/png";
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    const r = await fetch(dataUrl);
    if (!r.ok) throw new Error(`Vision detect(): failed to decode screenshot (${r.status}).`);
    return await r.blob();
  }
}

export class VisionAssistant {
  private model: ModelLike | null = null;
  private processor: ProcessorLike | null = null;
  private embeddingPrecision: EmbeddingPrecision | null = null;
  private loader: ModelLoader = new ModelLoader();
  private _status: VisionStatus = "uninitialized";
  private statusCallback: StatusCallback | null = null;
  /**
   * Re-entrancy guard for `init()`. Two concurrent `init()` callers would both
   * pass the `isReady` check (neither is ready yet) and duplicate the ~3.5 GB
   * download + leak a WebGPU session. We cache the in-flight promise and return
   * it; the promise is cleared on settle (success or failure) so a failed init
   * can be retried.
   */
  private initPromise: Promise<void> | null = null;
  /**
   * Re-entrancy guard for `detect()`. Two concurrent `detect()` calls would
   * interleave `model.generate` on the shared WebGPU session. We cache the
   * in-flight promise and return it so a second concurrent caller awaits the
   * same detection instead of racing the tensor feeds. Cleared on settle.
   */
  private detectPromise: Promise<PixelDetection[]> | null = null;
  /** The screenshot `detect()` is currently running on. Lets identical,
   * re-entrant inputs share the in-flight run (see `detect()`) while a
   * different concurrent screenshot is serialized on the chain below. */
  private detectDataUrl: string | null = null;
  /**
   * Serialization chain: when a second `detect()` arrives with a DIFFERENT
   * screenshot, it appends to this chain and awaits the prior run(s), then
   * executes its own `doDetect()` for its own input — so each caller resolves
   * with its own correct detections. The tail is kept alive across rejections
   * (swallowed to `undefined`) so queued calls still execute.
   */
  private chain: Promise<unknown> | null = null;
  /** JS-heap growth watchdog sampled at the end of each detection run. */
  private memoryWatchdog = new MemoryWatchdog();

  constructor() {
    // Surface the non-fatal supply-chain warning (unpinned-weights / unpinned-hash
    // record-mode) as a visible status so the UI shows it instead of a silent
    // console.warn.
    this.loader.onWarning((msg) => this.setStatus("warning", msg));
  }

  get isReady(): boolean {
    return this._status === "ready" && this.model !== null && this.processor !== null;
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
    return typeof navigator !== "undefined" &&
      "gpu" in navigator &&
      (navigator as { gpu?: unknown }).gpu != null;
  }

  /** Initialize: download model (if needed) + create the WebGPU sessions. */
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
    // (121-123 expose it in page contexts only). Fail with a clear error here
    // rather than mid-detect.
    if (!VisionAssistant.isWebGPUAvailable()) {
      this.setStatus("error", "WebGPU is not available. Use Chrome/Edge 124+ (the minimum for WebGPU in the service worker).");
      throw new Error("WebGPU not available");
    }

    try {
      // 1. Determine the embedding variant and download / verify the cache.
      this.setStatus("checking");
      this.embeddingPrecision = await pickEmbeddingPrecision();
      const files = modelFileEntries(this.embeddingPrecision);
      this.loader.setFiles(files);
      await this.loader.init();
      const cached = await this.loader.isCached();
      if (!cached) {
        // Surface what is about to happen — a multi-GB, multi-file download —
        // instead of a silent "downloading" flip. downloadAll then reports
        // live per-file + aggregate progress through onProgress.
        this.setStatus(
          "downloading",
          `Downloading ${files.length} model files (${MODEL_DOWNLOAD_SIZE_LABEL})…`,
        );
        await this.loader.downloadAll(onProgress);
      }

      // 2. Wire transformers.js to read ONLY from the SHA-256/size-verified
      // cache. `allowRemoteModels=false` makes every file miss fail loudly
      // instead of silently fetching unpinned weights (fail-closed).
      this.setStatus("compiling");
      const dtype = {
        decoder_model_merged: "q4",
        vision_encoder: "q4",
        embed_tokens: this.embeddingPrecision,
      };
      const use_external_data_format: Record<string, number> = {
        "decoder_model_merged_q4.onnx": 5,
        "vision_encoder_q4.onnx": 1,
        ...(this.embeddingPrecision === "fp16" ? { "embed_tokens_fp16.onnx": 1 } : {}),
      };

      env.allowLocalModels = false;
      env.allowRemoteModels = false;
      env.useBrowserCache = false;
      env.useCustomCache = true;
      env.customCache = await caches.open(CACHE_NAME);
      // `webgpu` is optional and read-only in the ORT env type; mutate through
      // a narrowed cast so powerPreference can be set safely.
      const onnxEnv = env.backends.onnx as unknown as {
        logLevel: string;
        webgpu: { powerPreference: string } | undefined;
      };
      onnxEnv.logLevel = "warning";
      onnxEnv.webgpu = (onnxEnv.webgpu ?? {}) as { powerPreference: string };
      onnxEnv.webgpu.powerPreference = "high-performance";

      const options = {
        revision: MODEL_REVISION,
        device: "webgpu",
        dtype,
        use_external_data_format,
        session_options: {
          executionProviders: ["webgpu", "wasm"],
          logSeverityLevel: 2,
        },
      } as PretrainedOptions & { config?: unknown };

      // 3. Load config, then the processor + model in parallel.
      const modelConfig = await AutoConfig.from_pretrained(MODEL_REPO, options);
      (modelConfig as unknown as { "transformers.js_config": Record<string, unknown> })["transformers.js_config"] = {
        ...((modelConfig as unknown as { "transformers.js_config"?: Record<string, unknown> })["transformers.js_config"] || {}),
        dtype,
        device: "webgpu",
        use_external_data_format,
      };
      options.config = modelConfig;

      [this.processor, this.model] = await Promise.all([
        AutoProcessor.from_pretrained(MODEL_REPO, options),
        AutoModelForImageTextToText.from_pretrained(MODEL_REPO, options),
      ]) as unknown as [ProcessorLike, ModelLike];

      this.setStatus("ready", "Local Vision model ready (LFM2.5-VL-3B · Q4 · WebGPU)");
    } catch (e) {
      // If init() threw partway through, a partially-created session/model
      // would leak GPU memory. cleanup() is idempotent and releases sessions.
      await this.cleanup();
      this.setStatus("error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }


  /** Run grounding detection on a screenshot. Returns pixel-coordinate detections.
   * An optional `signal` short-circuits the decode loop when the run is
   * aborted, reclaiming the GPU/CPU that would otherwise be spent finishing
   * an abandoned detection. */
  async detect(screenshotDataUrl: string, signal?: AbortSignal): Promise<PixelDetection[]> {
    // Chrome/Edge expose WebGPU in service workers since 124, so
    // `navigator.gpu` is normally present when detect() runs from the SW.
    // Guard anyway so a WebGPU-disabled context gets a clear error instead of
    // an opaque rejection from the transformers.js load.
    if (!VisionAssistant.isWebGPUAvailable()) {
      throw new Error(
        "WebGPU not available; Local Vision requires WebGPU (Chrome/Edge 124+ in the service worker). " +
          "It cannot run in a context without navigator.gpu.",
      );
    }

    // (1) Identical-input sharing: if the SAME screenshot is currently running,
    //     return the cached promise instead of queueing a duplicate run. An
    //     aborted second caller must not be handed the full detection — honor
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

  /** Start a single serialized `detect()` run. Sets the live-run bookkeeping
   * (`detectPromise`/`detectDataUrl`) synchronously so an overlapping
   * identical-input call shares this promise. Cleared on settle. */
  private runDetect(screenshotDataUrl: string, signal?: AbortSignal): Promise<PixelDetection[]> {
    this.detectDataUrl = screenshotDataUrl;
    this.detectPromise = this.doDetect(screenshotDataUrl, signal).finally(() => {
      this.detectPromise = null;
      this.detectDataUrl = null;
      this.chain = null;
    });
    this.chain = this.detectPromise;
    return this.detectPromise;
  }


  /** Core detection. See `detect()` for the re-entrancy wrapper. */
  private async doDetect(screenshotDataUrl: string, signal?: AbortSignal): Promise<PixelDetection[]> {
    if (!this.isReady || !this.model || !this.processor) {
      throw new Error(
        `Vision detect(): assistant not ready (status=${this._status}). ` +
          `Call init() first; a failed init must be retried before detect().`,
      );
    }
    if (signal?.aborted) throw new DOMException("Vision detect aborted", "AbortError");

    // 1. Decode the screenshot. RawImage works in the MV3 SW (createImageBitmap
    //    + OffscreenCanvas — both available in ServiceWorkerGlobalScope).
    const blob = await dataUrlToBlob(screenshotDataUrl);
    const image = await RawImage.read(blob);
    if (signal?.aborted) throw new DOMException("Vision detect aborted", "AbortError");

    // 2. Build the grounding conversation and apply the model's chat template.
    const messages = [
      { role: "system", content: DETECTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image" },
          { type: "text", text: DETECTION_USER_PROMPT },
        ],
      },
    ];
    const prompt = this.processor.tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      tokenize: false,
    });

    // 3. Preprocess (image → pixel_values, text → input_ids).
    const inputs = await this.processor([image], prompt);

    // 4. Generate the grounding JSON. Abort wiring: transformers.js sessions
    //    are not interruptible mid-run, but the stopping criterion short-circuits
    //    the decode loop so an abandoned detection stops wasting GPU/CPU.
    const stopping = new InterruptableStoppingCriteria();
    const abort = () => stopping.interrupt();
    signal?.addEventListener("abort", abort, { once: true });
    let generated: GeneratedLike;
    try {
      generated = await this.model.generate({
        ...inputs,
        max_new_tokens: MAX_NEW_TOKENS,
        do_sample: true,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 50,
        stopping_criteria: [stopping],
      });
    } finally {
      signal?.removeEventListener("abort", abort);
    }

    // 5. Decode the generated tokens (skip the prompt prefix).
    const sequences = (generated?.sequences ?? generated) as SequencesLike;
    const promptLength = ((inputs.input_ids as { dims?: number[] } | undefined)?.dims?.at(-1)) ?? 0;
    const generatedIds = sequences?.tolist?.()?.[0]?.slice(promptLength) || [];
    const text = this.processor.tokenizer.decode(generatedIds, { skip_special_tokens: false });

    // 6. Parse the grounding response and map 0-1000 coords to the ORIGINAL
    //    screenshot's pixel space (the model normalizes over the full input
    //    image, matching the LFM Space's `x/10%` overlay math).
    const parsed = parseGroundingResponse(text, 1);
    const detections = parsed ? groundingToDetections(parsed) : [];
    const pixelDetections = toPixelCoords(detections, image.width, image.height);

    // Sample the JS heap after a successful run — the first run establishes
    // the baseline, later runs measure growth across detections.
    this.sampleMemory();
    return pixelDetections;
  }

  /** Release the WebGPU sessions and free GPU memory. */
  async cleanup(): Promise<void> {
    // transformers.js `dispose()` releases the ORT WebGPU sessions (GPU memory
    // JS GC cannot free on its own). Capture the model into a local BEFORE
    // nulling the field so a re-entered cleanup still disposes it, and wrap in
    // try/catch because `dispose()` can throw if the device was lost.
    const model = this.model;
    this.model = null;
    this.processor = null;
    this.embeddingPrecision = null;
    this.setStatus("uninitialized");
    // Sessions released → heap drops back; rebaseline so the next init
    // measures from a fresh episode instead of the pre-cleanup high-water.
    this.memoryWatchdog.reset();
    if (model) {
      try {
        await model.dispose();
      } catch {
        // Already disposed or device lost — safe to ignore.
      }
    }
  }
}
