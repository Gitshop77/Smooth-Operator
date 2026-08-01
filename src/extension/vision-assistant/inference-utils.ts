import * as ort from "onnxruntime-web/webgpu";
import type { EmbeddingMeta } from "./embedding-gather";
import { f16to32 } from "./embedding-gather";
import { N_LAYERS, KV_HEADS, HEAD_DIM, VISION_FEATURE_OUTPUT } from "./constants";

export const pastKeyNames = Array.from({ length: N_LAYERS }, (_, i) => `past_key_${i}`);
export const presentKeyNames = Array.from({ length: N_LAYERS }, (_, i) => `present_key_${i}`);
export const pastValueNames = Array.from({ length: N_LAYERS }, (_, i) => `past_value_${i}`);
export const presentValueNames = Array.from({ length: N_LAYERS }, (_, i) => `present_value_${i}`);

export const EMPTY_PAST: Record<string, ort.Tensor> = (() => {
  const f: Record<string, ort.Tensor> = {};
  for (let i = 0; i < N_LAYERS; i++) {
    f[pastKeyNames[i]] = new ort.Tensor("float32", new Float32Array(0), [1, KV_HEADS, 0, HEAD_DIM]);
    f[pastValueNames[i]] = new ort.Tensor("float32", new Float32Array(0), [1, KV_HEADS, 0, HEAD_DIM]);
  }
  return f;
})();

export function argmaxLast(arr: Float32Array, V: number): number {
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

export function getLogits(res: Record<string, ort.Tensor>): ort.Tensor {
  const logits = res["logits"];
  if (!logits) {
    throw new Error(
      `Language session produced no "logits" output. ` +
        `Actual keys: ${Object.keys(res).join(", ")}`,
    );
  }
  return logits;
}

export function assertKvCacheOutputs(session: ort.InferenceSession): void {
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

export function assertLogitsOutput(session: ort.InferenceSession): void {
  if (!session.outputNames.includes("logits")) {
    throw new Error(
      `Language ONNX export missing expected "logits" output. ` +
        `Actual outputs: ${session.outputNames.join(", ")}`,
    );
  }
}

/**
 * Assert the vision ONNX export exposes EXACTLY ONE output named
 * `visual_features`. The detect loop indexes the run result by
 * `outputNames[0]`; a re-exported model with a renamed or reordered output
 * set would silently feed a wrong tensor into the embedding splice and emit
 * garbage boxes. Fail loudly here at init rather than mid-detect.
 */
export function assertVisionOutput(session: ort.InferenceSession): void {
  const names = session.outputNames;
  if (names.length !== 1 || names[0] !== VISION_FEATURE_OUTPUT) {
    throw new Error(
      `Vision ONNX export must expose exactly one output named ` +
        `"${VISION_FEATURE_OUTPUT}" (got ${names.length === 0 ? "none" : names.join(", ")}). ` +
        `The detect loop reads it by position; a re-exported model with renamed ` +
        `or extra outputs would silently feed the wrong tensor.`,
    );
  }
}

/**
 * Assert the language ONNX export declares every input name the prefill and
 * decode loops feed (`input_ids`, `inputs_embeds`, `attention_mask`,
 * `position_ids`, plus `past_key_${i}` / `past_value_${i}` per layer).
 * `session.run(feeds)` keys tensors by name, so a renamed input in a
 * version-skewed export would fail only at the first run — which callers
 * swallow into a silent "no detections". Fail loudly here at init instead.
 */
export function assertLanguageInputs(session: ort.InferenceSession): void {
  const names = new Set(session.inputNames);
  const missing: string[] = [];
  for (const name of ["input_ids", "inputs_embeds", "attention_mask", "position_ids"]) {
    if (!names.has(name)) missing.push(name);
  }
  for (let i = 0; i < N_LAYERS; i++) {
    if (!names.has(pastKeyNames[i])) missing.push(pastKeyNames[i]);
    if (!names.has(pastValueNames[i])) missing.push(pastValueNames[i]);
  }
  if (missing.length) {
    throw new Error(
      `Language ONNX export missing expected input names: ${missing.join(", ")}. ` +
        `Actual inputs: ${session.inputNames.join(", ")}`,
    );
  }
}

export function decodeFp16Scales(scalesBytes: Uint8Array): Float32Array {
  const sv = new DataView(scalesBytes.buffer, scalesBytes.byteOffset, scalesBytes.byteLength);
  const scales = new Float32Array(scalesBytes.length >> 1);
  for (let i = 0; i < scales.length; i++) {
    scales[i] = f16to32(sv.getUint16(i * 2, true));
  }
  return scales;
}

export function validateVisionOutput(visual: ort.Tensor, H: number, N: number): void {
  if (!visual || visual.dims.length !== 2 || Number(visual.dims[1]) !== H) {
    throw new Error(
      `Vision encoder output shape mismatch: feature width ` +
        `${visual ? visual.dims[1] : "n/a"} !== embedding hidden ${H} ` +
        `(dims=${JSON.stringify(visual?.dims)})`,
    );
  }
  if (Number(visual.dims[0]) !== N) {
    throw new Error(
      `Vision encoder output token count ${visual.dims[0]} !== injected <IMG_CONTEXT> count ${N}`,
    );
  }
}

export function validateLogitsShape(logits: ort.Tensor, label: string): number {
  if (logits.dims.length !== 3 || !Number.isFinite(Number(logits.dims[2])) || Number(logits.dims[2]) <= 0) {
    throw new Error(`${label}: logits tensor is not a valid 3-D [1,T,V] tensor (dims=${JSON.stringify(logits.dims)})`);
  }
  return logits.dims[2] as number;
}

export function validateEmbeddingShapes(
  meta: EmbeddingMeta,
  packed: Uint8Array,
  scalesBytes: Uint8Array,
): void {
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
  if (!Number.isInteger(meta.zero_point) || meta.zero_point < 0 || meta.zero_point > 15) {
    throw new Error(
      `Embedding meta.zero_point=${meta.zero_point} must be an integer in [0, 15] (INT4 range)`,
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
