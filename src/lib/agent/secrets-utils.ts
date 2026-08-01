/** One stored secret. */
export interface SecretEntry {
  name: string;
  value: string;
  createdAt: number;
}

interface RedactionArtifacts {
  pattern: RegExp;
  valueToName: Map<string, string>;
  nameToValue: Map<string, string>;
}

export interface SubstituteSecretsOptions {
  trusted?: boolean;
}

export const PLACEHOLDER_PATTERN = /%([a-zA-Z][a-zA-Z0-9_]*)%/g;

export const HAS_PLACEHOLDER = /%[a-zA-Z][a-zA-Z0-9_]*%/;

export const isValidSecretEntry = (e: unknown): e is SecretEntry =>
  e != null &&
  typeof e === "object" &&
  typeof (e as SecretEntry).name === "string" &&
  typeof (e as SecretEntry).value === "string";

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildRedactionArtifacts(secrets: SecretEntry[]): RedactionArtifacts | null {
  const eligible = secrets
    .filter((s) => s.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);

  if (eligible.length === 0) return null;

  const pattern = new RegExp(eligible.map((s) => escapeRegex(s.value)).join("|"), "g");
  const valueToName = new Map<string, string>();
  for (const s of eligible) {
    if (!valueToName.has(s.value)) valueToName.set(s.value, s.name);
  }
  const nameToValue = new Map<string, string>();
  for (const s of secrets) {
    if (!nameToValue.has(s.name)) nameToValue.set(s.name, s.value);
  }
  return { pattern, valueToName, nameToValue };
}
