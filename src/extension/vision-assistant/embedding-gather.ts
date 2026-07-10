/**
 * Vision Assistant — INT4 embedding gather.
 *
 * Dequantizes 4-bit packed embeddings to fp32 using group-wise scales.
 * Ported from Reza2kn's gatherEmbed() + f16to32().
 */

/** fp16 → fp32 conversion. */
export function f16to32(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : s ? -Infinity : Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

export interface EmbeddingMeta {
  vocab: number;
  hidden: number;
  block_size: number;
  n_groups: number;
  zero_point: number;
}

/** Gather a single token's embedding from the INT4 packed table. */
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
  const packedRow = tokenId * (H / 2);
  const scaleRow = tokenId * NG;

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
