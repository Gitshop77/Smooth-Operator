/**
 * Vision Assistant — transformers.js tokenizer loader.
 *
 * The ONNX weights are SHA-256-pinned and re-verified on every load
 * (`MODEL_FILE_HASHES`), but `AutoTokenizer.from_pretrained` fetches the
 * tokenizer files directly from the Hub without an integrity check — it is
 * the one unpinned executable input in an otherwise fail-closed supply-chain
 * design. A tampered tokenizer can change the token→id mapping and, combined
 * with the pinned model, influence detection output (misdirected click
 * coordinates — bounded impact, no code execution).
 *
 * Pinning the tokenizer files (or routing them through the ModelLoader) is
 * pending; until then every successful load logs loudly so an unpinned state
 * is never silent.
 */

import { MODEL_REPO } from "./constants";

// Lazy-load transformers.js only when needed. (esbuild bundles it into
// background.js either way — the dynamic import defers execution until the
// tokenizer is first requested; it does not shrink the bundle.)
// Reset the cached promise on rejection so a transient fetch failure (network
// drop, HuggingFace outage, auth issue) doesn't permanently disable Local
// Vision until SW restart — the next call retries from scratch.
let tokenizerLoadPromise: Promise<unknown> | null = null;

export async function getTokenizer(): Promise<unknown> {
  if (!tokenizerLoadPromise) {
    tokenizerLoadPromise = import("@huggingface/transformers")
      .then((mod) => mod.AutoTokenizer.from_pretrained(MODEL_REPO))
      .then((tokenizer) => {
        console.error(
          `[vision-assistant] SECURITY: the tokenizer for ${MODEL_REPO} is ` +
            `loaded WITHOUT an integrity check (transformers.js fetches it ` +
            `directly from the Hub; it is not covered by the MODEL_FILE_HASHES ` +
            `pinning framework). Pin its files before shipping to guard against ` +
            `tampered token→id mappings.`,
        );
        return tokenizer;
      })
      .catch((e) => {
        tokenizerLoadPromise = null; // allow retry on next call
        throw e;
      });
  }
  return tokenizerLoadPromise;
}
