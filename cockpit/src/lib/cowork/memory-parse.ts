// Framework-free memory parsing + secret-masking helpers.
//
// Pure, deterministic logic extracted from `memory-view` so it can be unit-tested
// without loading the React/UI stack. The secret-masking guard here is a security
// surface: it stops captured passwords/tokens/CVV/card numbers from rendering in
// plaintext in the cockpit UI.

export const SENSITIVE_FIELD =
  /pass|pwd|password|secret|cvv|card|ssn|token|otp|pin/i;

export const maskValue = (field: string, value: string): string =>
  SENSITIVE_FIELD.test(field) ? "••••••" : value;

// Heuristic: does a *scalar* value look like a secret worth masking? Used as a
// fallback when no parseable field name is available (e.g. an unparseable raw
// form-memory blob), so generic/entropy-shaped secrets are still masked in the
// cockpit display. Mirrors the server-side `looksLikeSecret` in the memory/form
// route, and is biased toward masking: a keyword match is not gated by length,
// while only the generic token-shape branch requires the length floor.
export function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (/(password|passwd|secret|token|api[_-]?key|access[_-]?token|cvv|otp|ssn|pin)/i.test(t))
    return true;
  return t.length >= 20 && /^[A-Za-z0-9+/=_-]{20,}$/.test(t);
}

export function parseSiteData(e: {
  dataJson: string;
}): { visitCount: number; diffCount: number; preview: string } {
  const empty = { visitCount: 0, diffCount: 0, preview: "" };
  if (typeof e.dataJson !== "string" || e.dataJson.length === 0) return empty;
  try {
    const parsed = JSON.parse(e.dataJson) as Record<string, unknown>;
    const visits = Array.isArray(parsed.visits) ? parsed.visits.length : 0;
    const diffs = Array.isArray(parsed.diffs) ? parsed.diffs.length : 0;
    const preview =
      e.dataJson.length > 120 ? e.dataJson.slice(0, 120) + "…" : e.dataJson;
    return { visitCount: visits, diffCount: diffs, preview };
  } catch {
    return { ...empty, preview: e.dataJson.slice(0, 120) };
  }
}

export function parseFormEntries(
  e: { formDataJson: string },
): Array<{ field: string; value: string }> {
  if (typeof e.formDataJson !== "string" || e.formDataJson.length === 0) return [];
  try {
    const parsed = JSON.parse(e.formDataJson) as Record<string, unknown>;
    if (Array.isArray(parsed.entries)) {
      return parsed.entries
        .filter(
          (x): x is { field: string; value: string } =>
            x != null &&
            typeof x === "object" &&
            "field" in x &&
            "value" in x &&
            typeof (x as { field: unknown }).field === "string" &&
            typeof (x as { value: unknown }).value === "string",
        )
        .map((x) => ({ field: x.field, value: x.value }));
    }
    return Object.entries(parsed)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => ({ field: k, value: String(v) }));
  } catch {
    return [];
  }
}
