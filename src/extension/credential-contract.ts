export const CREDENTIAL_SCHEMA_VERSION = 1 as const;

declare const credentialHandleBrand: unique symbol;
export type CredentialHandleV1 = string & { readonly [credentialHandleBrand]: true };

export interface CredentialReferenceV1 {
  version: typeof CREDENTIAL_SCHEMA_VERSION;
  handle: CredentialHandleV1;
  providerId: string;
  revision: number;
}

export interface CredentialManifestV1 extends CredentialReferenceV1 {
  kind: "provider-api-key";
}

export interface CredentialMigrationV1 {
  version: typeof CREDENTIAL_SCHEMA_VERSION;
  kind: "legacy-api-key";
  handle: CredentialHandleV1;
  providerId: string;
  sourceRevision: number;
  stage: "copying" | "manifested";
}

const HANDLE_RE = /^cred_v1_[0-9a-f]{32}$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function createCredentialHandle(randomBytes = crypto.getRandomValues(new Uint8Array(16))): CredentialHandleV1 {
  return `cred_v1_${Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as CredentialHandleV1;
}

export function decodeCredentialHandle(value: unknown): CredentialHandleV1 | null {
  return typeof value === "string" && HANDLE_RE.test(value) ? value as CredentialHandleV1 : null;
}

export function decodeCredentialProviderId(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_ID_RE.test(value) ? value : null;
}

function decodeRevision(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

export function decodeCredentialReference(value: unknown): CredentialReferenceV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const handle = decodeCredentialHandle(record.handle);
  const providerId = decodeCredentialProviderId(record.providerId);
  const revision = decodeRevision(record.revision);
  return record.version === CREDENTIAL_SCHEMA_VERSION && handle && providerId && revision
    ? { version: CREDENTIAL_SCHEMA_VERSION, handle, providerId, revision }
    : null;
}

export function decodeCredentialManifest(value: unknown): CredentialManifestV1 | null {
  const reference = decodeCredentialReference(value);
  return reference && (value as Record<string, unknown>).kind === "provider-api-key"
    ? { ...reference, kind: "provider-api-key" }
    : null;
}

export function decodeCredentialMigration(value: unknown): CredentialMigrationV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const handle = decodeCredentialHandle(record.handle);
  const providerId = decodeCredentialProviderId(record.providerId);
  const stage = record.stage;
  const sourceRevision = record.sourceRevision;
  return record.version === CREDENTIAL_SCHEMA_VERSION && record.kind === "legacy-api-key" && handle && providerId &&
    Number.isSafeInteger(sourceRevision) && (sourceRevision as number) >= 0 &&
    (stage === "copying" || stage === "manifested")
    ? { version: CREDENTIAL_SCHEMA_VERSION, kind: "legacy-api-key", handle, providerId, sourceRevision: sourceRevision as number, stage }
    : null;
}
