/**
 * Shared helper for serializing a Zod schema to a plain JSON Schema object.
 *
 * Single source of truth for the `z.toJSONSchema` compatibility shim that the
 * OpenAI / Gemini / Anthropic protocol files previously duplicated. Centralizing
 * it means the version-specific fallback and error semantics can't drift between
 * the three adapters.
 *
 * Returns the serialized JSON Schema, or throws a clear error when the schema is
 * a Zod object but `z.toJSONSchema` is unavailable (Zod v3) or conversion fails —
 * so a non-serializable schema surfaces to the caller instead of being POSTed as
 * a raw Zod object (which yields an opaque provider `400`).
 */
export async function zodToJsonSchema(schema: unknown): Promise<unknown> {
  const zNS = (await import("zod")).z as unknown as {
    toJSONSchema?: (s: unknown) => unknown;
  };
  if (typeof zNS.toJSONSchema !== "function") {
    throw new Error(
      "Structured-output schema is a Zod object but `z.toJSONSchema` is unavailable " +
        "(requires Zod v4). Upgrade Zod or pass a plain JSON Schema."
    );
  }
  return zNS.toJSONSchema(schema);
}
