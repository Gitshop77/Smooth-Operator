/**
 * Shared batch redaction helper for the action handlers.
 *
 * Joins a batch of values into a single `redactSecrets` call, then splits the
 * redacted result back into per-value strings. Batching keeps secret redaction
 * to one vault round-trip per handler invocation instead of one per value.
 */

import { redactSecrets } from "../../secrets";

/** Joins a batch of values into a single `redactSecrets` call, then splits the
 *  redacted result back into per-value strings. */
const BATCH_DELIM = "\x00";

/** Stand-in for every part when the batch redaction cannot be aligned back to
 *  the original values (secret-store failure or a NUL byte inside a value). */
const REDACTION_FAILURE_MASK = "[REDACTED: secret store unavailable]";

export async function redactBatch(parts: string[]): Promise<string[]> {
  if (parts.length === 0) return parts;
  const redacted = (await redactSecrets(parts.join(BATCH_DELIM))).split(BATCH_DELIM);
  // A redaction failure returns a single marker string for the whole batch, and
  // a NUL byte inside a value shifts the split — either way the split no longer
  // lines up with `parts`, and indexing into it would ship RAW values to the
  // LLM. Mask every part instead of leaking.
  if (redacted.length !== parts.length) return parts.map(() => REDACTION_FAILURE_MASK);
  return redacted;
}
