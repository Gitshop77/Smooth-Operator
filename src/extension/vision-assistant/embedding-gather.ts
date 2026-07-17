/**
 * Vision Assistant — INT4 embedding gather.
 *
 * Dequantizes 4-bit packed embeddings to fp32 using group-wise scales.
 * Ported from Reza2kn's gatherEmbed() + f16to32().
 */

/** Reusable scratch buffers for fp16 → fp32 conversion (avoids per-call allocs). */
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/** fp16 → fp32 conversion. */
export function f16to32(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : s ? -Infinity : Infinity;
  const u = (s << 31) | ((e + 112) << 23) | (f << 13);
  _u32[0] = u;
  return _f32[0];
}

export interface EmbeddingMeta {
  vocab: number;
  hidden: number;
  block_size: number;
  n_groups: number;
  zero_point: number;
}

/**
 * Set once after `validateEmbeddingShapes()` passes at init. `gatherEmbed` then
 * skips the immutable meta-level shape checks on every (hot-path) call, keeping
 * only the per-token range check + the cheap per-call buffer-bounds asserts.
 */
let metaValidated = false;

/** Call once after the embedding meta/packed/scales shape validation succeeds. */
export function markEmbeddingMetaValidated(): void {
  metaValidated = true;
}

/**
 * Gather a single token's embedding from the INT4 packed table.
 *
 * Defensive guards: a corrupt/partial cache (meta JSON disagrees with the
 * `.bin` buffers) is rejected up-front in `VisionAssistant.init()`, but these
 * checks here guarantee a single malformed `tokenId` cannot silently read
 * misaligned bytes and produce garbage embeddings. Any violation throws so the
 * caller (not the detector) sees a loud failure instead of confidently-wrong
 * boxes.
 */
export function gatherEmbed(
  tokenId: number,
  dst: Float32Array,
  off: number,
  packed: Uint8Array,
  scales: Float32Array,
  meta: EmbeddingMeta,
): void {
  const H = meta.hidden;
  const B = meta.block_size;
  const NG = meta.n_groups;
  const ZP = meta.zero_point;

 // `H` MUST be even: each byte packs two 4-bit values, so each token consumes
 // exactly `H / 2` packed bytes. A non-even `hidden` would misalign every row.
 // These meta-level invariants are validated once at init; once
 // `metaValidated` is set they are skipped in this hot path (the per-token
 // `tokenId` range check + buffer-bounds asserts below still run every call).
  if (!metaValidated) {
    if (!Number.isInteger(H) || H <= 0 || H % 2 !== 0) {
      throw new Error(`gatherEmbed: meta.hidden=${H} must be a positive even integer`);
    }
    if (!Number.isInteger(meta.vocab) || meta.vocab <= 0) {
      throw new Error(`gatherEmbed: meta.vocab=${meta.vocab} must be a positive integer`);
    }
    if (!Number.isInteger(NG) || NG <= 0) {
      throw new Error(`gatherEmbed: meta.n_groups=${NG} must be a positive integer`);
    }
   // Every group must map to an index in `[0, NG)`; the last element lands in
   // group `(H - 1) / B`, which must stay below `NG`.
    if (!Number.isInteger(B) || B <= 0 || Math.floor((H - 1) / B) >= NG) {
      throw new Error(
        `gatherEmbed: block_size=${B} / n_groups=${NG} disagree with hidden=${H}`,
      );
    }
  }
  if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId >= meta.vocab) {
    throw new Error(`gatherEmbed: token id ${tokenId} out of vocab range [0, ${meta.vocab})`);
  }

  const packedRow = tokenId * (H / 2);
  const scaleRow = tokenId * NG;

 // The cache-wide shape checks in `init()` already guarantee
 // `packed.length === vocab * H/2` and `scales.length === vocab * NG`, so a
 // valid `tokenId` (above) can never overflow. Re-assert cheaply for safety.
  if (packedRow + H / 2 > packed.length) {
    throw new Error(`gatherEmbed: packed buffer too small for token ${tokenId}`);
  }
  if (scaleRow + NG > scales.length) {
    throw new Error(`gatherEmbed: scales buffer too small for token ${tokenId}`);
  }

  for (let j = 0; j < H; j += 2) {
    const byte = packed[packedRow + (j >> 1)];
    const lo = byte & 0x0f;
    const hi = (byte >> 4) & 0x0f;
    const g0 = (j / B) | 0;
    const g1 = ((j + 1) / B) | 0;
    dst[off + j] = (lo - ZP) * scales[scaleRow + g0];
    dst[off + j + 1] = (hi - ZP) * scales[scaleRow + g1];
  }
}
