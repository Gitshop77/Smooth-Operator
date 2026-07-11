/**
 * Stream framing — SSE and JSON-line parsing.
 *
 * Defines how a response stream is cut into protocol frames (e.g. SSE lines).
 *
 * SSE notes: per the Server-Sent Events spec an "event" is a block of fields
 * terminated by a blank line, and multiple `data:` lines within one event MUST
 * be joined with `\n` into a single payload. The HTTP transport feeds this
 * framer one complete line at a time (`line + "\n"`) and flushes any leftover
 * tail without a trailing newline. We accumulate `data:` lines across those
 * calls and emit exactly one frame per event, on the blank-line boundary,
 * concatenating multi-line `data:` with `\n`.
 */

export type Frame = string;

export interface Framing<FrameType = Frame> {
  readonly parse: (chunk: string) => FrameType[];
}

/**
 * Build a stateful SSE framer.
 *
 * Because framing buffers `data:` lines across calls, a given instance must be
 * driven by a single stream. This holds in the callers here (one `frames()`
 * generator per request), and reusing one instance across concurrent streams
 * would interleave their events.
 */
function createSSEFramer(): Framing {
  let dataLines: string[] = [];

  // Emit the accumulated `data:` lines as a single frame (joined with "\n")
  // and reset the buffer. Returns `[]` (and leaves state empty) when there is
  // no pending data, so stray blank lines between events are harmless.
  const flush = (): Frame[] => {
    if (dataLines.length === 0) return [];
    const frame = dataLines.join("\n");
    dataLines = [];
    return [frame];
  };

  return {
    parse: (chunk: string): Frame[] => {
      const frames: Frame[] = [];
      // A chunk that does not end in "\n" is the transport's final flush of a
      // partial tail (truncated / idle-close stream); treat end-of-input as an
      // implicit terminator so a final unterminated event is not dropped.
      const endsWithNewline = chunk.endsWith("\n");

      // The transport appends "\n" to every complete line it forwards; that
      // trailing newline is NOT a real blank-line terminator, so drop the
      // empty element it produces before scanning for genuine boundaries.
      const lines = chunk.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }

      for (const line of lines) {
        if (line === "") {
          // Blank line → event boundary. Flush whatever data we accumulated.
          frames.push(...flush());
          continue;
        }
        if (line.startsWith(":")) {
          // Comment line — ignored by the SSE spec.
          continue;
        }
        const colon = line.indexOf(":");
        if (colon === -1) {
          // No colon: the whole line is the field name and the value is empty.
          if (line.trim() === "data") dataLines.push("");
          continue;
        }
        const name = line.slice(0, colon).trim();
        if (name !== "data") continue;
        // The spec strips a single leading U+0020 that follows the colon.
        let value = line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        dataLines.push(value);
      }

      if (!endsWithNewline) {
        frames.push(...flush());
      }

      return frames;
    },
  };
}

/** Server-Sent Events framing — splits `data: ...\n\n` frames. */
export const sse: Framing = createSSEFramer();

export * as Framing from "./framing";
