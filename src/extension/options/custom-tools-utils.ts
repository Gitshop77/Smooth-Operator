import { isRecord } from "@/extension/shared";
import { STORAGE_KEYS } from "./storage-keys";

/** A user-defined custom tool. */
export interface CustomToolEntry {
  name: string;
  description: string;
  code: string;
  createdAt?: number;
  codeHash?: string;
}

export const DESC_MAX = 500;
export const CODE_MAX = 50_000;

/**
 * Maximum number of custom tools the store accepts. Every tool's name +
 * description is inlined into the `<custom_tools>` prompt block on each agent
 * run, so an unbounded store silently bloats every prompt and the storage
 * quota. The runtime loader (`registry-utils.ts` `formatCustomToolsBlock`)
 * must enforce the same cap — keep the two sides in lockstep.
 */
export const MAX_CUSTOM_TOOLS = 50;

let mutationQueue: Promise<unknown> = Promise.resolve();
export function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function validateCustomTools(raw: unknown): CustomToolEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    // Log the shape only — the payload can contain tool `code` (and possibly
    // embedded key material) and must not be dumped to the console.
    console.warn(`[custom-tools] stored value is not an array (got ${typeof raw}); ignoring.`);
    return [];
  }
  const out: CustomToolEntry[] = [];
  raw.forEach((entry, i) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.description !== "string" ||
      typeof entry.code !== "string"
    ) {
      console.warn(`[custom-tools] dropping malformed entry at index ${i} (expected {name, description, code} strings).`);
      return;
    }
    const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : undefined;
    const codeHash = typeof entry.codeHash === "string" ? entry.codeHash : undefined;
    out.push({ name: entry.name, description: entry.description, code: entry.code, createdAt, codeHash });
  });
  return out;
}

export async function readCustomTools(): Promise<CustomToolEntry[]> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.customTools);
  return validateCustomTools(res[STORAGE_KEYS.customTools]);
}

export async function writeCustomTools(tools: CustomToolEntry[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.customTools]: tools });
}

export async function computeCodeHash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

const DANGEROUS_PATTERNS: [RegExp, string][] = [
  [/fetch\s*\(/, "network fetch() — could exfiltrate data"],
  [/XMLHttpRequest/, "XMLHttpRequest — could exfiltrate data"],
  [/chrome\.\s*(runtime|tabs|storage|permissions)/, "chrome.* API — could modify extension state"],
  [/\bimport\s*\(/, "dynamic import() — could load external modules"],
];

export function dangerousCodeWarnings(code: string): string[] {
  return DANGEROUS_PATTERNS
    .filter(([re]) => re.test(code))
    .map(([, desc]) => `  - ${desc}`);
}
