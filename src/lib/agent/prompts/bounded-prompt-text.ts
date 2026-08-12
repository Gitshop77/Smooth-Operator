import { utf8ByteLength } from "./prompt-token-budget";

export interface BoundedPromptTextV1 {
  readonly text: string;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly droppedBytes: number;
  readonly truncated: boolean;
}

export interface BoundPromptTextOptionsV1 {
  readonly maxBytes: number;
  readonly label: string;
}

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("Text byte bound must be a non-negative safe integer");
  }
}

function prefixAtMostBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let low = 0;
  let high = text.length;
  while (low < high) {
    let mid = Math.ceil((low + high) / 2);
    if (mid > 0 && mid < text.length) {
      const code = text.charCodeAt(mid);
      if (code >= 0xdc00 && code <= 0xdfff) mid -= 1;
    }
    if (mid <= low) {
      // The search boundary sits inside a surrogate pair whose start is `low`
      // (or no candidate can advance past `low`). Accepting the last known
      // safe prefix is conservative and correct — it can never return a
      // mid-pair boundary or exceed `maxBytes`, it may only truncate a few
      // bytes earlier than the theoretical maximum.
      break;
    }
    const bytes = utf8ByteLength(text.slice(0, mid));
    if (bytes <= maxBytes) low = mid;
    else high = Math.max(low, mid - 1);
  }
  if (low > 0 && low < text.length) {
    const code = text.charCodeAt(low);
    if (code >= 0xdc00 && code <= 0xdfff) low -= 1;
  }
  return text.slice(0, low);
}

function marker(label: string, droppedBytes: number): string {
  return `\n…[truncated ${droppedBytes} UTF-8 bytes from ${label}]`;
}

/**
 * Deterministically keeps the longest code-point-safe prefix that fits with a
 * byte-count marker. The source is bounded before any caller performs XML
 * escaping or prompt wrapping.
 */
export function boundPromptTextV1(
  source: string,
  options: BoundPromptTextOptionsV1,
): BoundedPromptTextV1 {
  validateMaxBytes(options.maxBytes);
  const originalBytes = utf8ByteLength(source);
  if (originalBytes <= options.maxBytes) {
    return {
      text: source,
      originalBytes,
      retainedBytes: originalBytes,
      droppedBytes: 0,
      truncated: false,
    };
  }

  let retained = prefixAtMostBytes(source, options.maxBytes);
  for (;;) {
    const retainedBytes = utf8ByteLength(retained);
    const droppedBytes = originalBytes - retainedBytes;
    const suffix = marker(options.label, droppedBytes);
    const suffixBytes = utf8ByteLength(suffix);
    if (suffixBytes > options.maxBytes) {
      const boundedMarker = prefixAtMostBytes(suffix, options.maxBytes);
      return {
        text: boundedMarker,
        originalBytes,
        retainedBytes: 0,
        droppedBytes: originalBytes,
        truncated: true,
      };
    }
    const next = prefixAtMostBytes(source, options.maxBytes - suffixBytes);
    if (next === retained) {
      return {
        text: retained + suffix,
        originalBytes,
        retainedBytes,
        droppedBytes,
        truncated: true,
      };
    }
    retained = next;
  }
}
