import {
  PROMPT_CACHE_KEY_VERSION,
  PROMPT_CONTRACT_VERSION,
  type PromptCacheDescriptorV1,
  type PromptSectionV1,
} from "./prompt-contract";

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Length-prefix each id and exact UTF-8 body so distinct section boundaries
 * cannot collide before SHA-256 hashing.
 */
function stableSectionBytes(sections: PromptSectionV1[]): Uint8Array {
  const encoder = new TextEncoder();
  const framed = sections.map((section) => {
    const id = encoder.encode(section.id);
    const body = encoder.encode(section.text);
    return `${id.byteLength}:${section.id}${body.byteLength}:${section.text}`;
  }).join("");
  return encoder.encode(`${PROMPT_CACHE_KEY_VERSION}\0${framed}`);
}

export interface PromptCacheDescriptorOptionsV1 {
  cacheEligible: boolean;
  invalidationKeys: string[];
}

export async function createPromptCacheDescriptorV1(
  sections: PromptSectionV1[],
  options: PromptCacheDescriptorOptionsV1,
): Promise<PromptCacheDescriptorV1> {
  const firstVolatile = sections.findIndex((section) => section.cache !== "stable");
  const stableSections = firstVolatile === -1 ? sections : sections.slice(0, firstVolatile);
  const volatileSections = firstVolatile === -1 ? [] : sections.slice(firstVolatile);
  const cacheEligible = options.cacheEligible && stableSections.length > 0;
  const stableBytes = stableSectionBytes(stableSections);
  const stableKey = cacheEligible
    ? `sha256:${hex(await crypto.subtle.digest("SHA-256", stableBytes.slice().buffer as ArrayBuffer))}`
    : null;
  return {
    version: PROMPT_CONTRACT_VERSION,
    keyVersion: PROMPT_CACHE_KEY_VERSION,
    cacheEligible,
    stableKey,
    stableSectionIds: stableSections.map((section) => section.id),
    volatileSectionIds: volatileSections.map((section) => section.id),
    volatileBoundary: firstVolatile,
    invalidationKeys: [...new Set(options.invalidationKeys)].sort(),
  };
}
