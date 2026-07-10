/**
 * Stream framing — SSE and JSON-line parsing.
 * Defines how a response stream is cut into protocol frames (e.g. SSE lines).
 */

export type Frame = string;

export interface Framing<FrameType = Frame> {
  readonly parse: (chunk: string) => FrameType[];
}

/** Server-Sent Events framing — splits `data: ...\n\n` frames. */
export const sse: Framing = {
  parse: (chunk: string): Frame[] => {
    const frames: Frame[] = [];
    const lines = chunk.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        frames.push(trimmed.slice(5).trim());
      }
    }
    return frames;
  },
};

export * as Framing from "./framing";
