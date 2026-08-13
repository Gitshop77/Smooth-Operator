import type { CredentialReferenceV1 } from "./credential-contract";

export interface ProviderConnectionConfigV1 {
  version: 1;
  provider: string;
  model: string;
  baseUrl?: string;
  resourceName?: string;
  provenance: "user" | "injected";
  credential: CredentialReferenceV1 | null;
  /** Optional manual context-window override currently configured by the user. */
  contextTokens?: number;
}

export type ProviderConnectionDiagnosticCode =
  | "ok"
  | "credential_stale"
  | "invalid_config"
  | "cancelled"
  | "timeout"
  | "policy_blocked"
  | "context_mismatch"
  | "provider_error"
  | "internal_error";

export interface ProviderConnectionResultV1 {
  version: 1;
  ok: boolean;
  code: ProviderConnectionDiagnosticCode;
  latencyMs: number;
  provider: string;
  model: string;
  message: string;
  /** Server-reported per-slot context for a detected llama.cpp endpoint. */
  contextTokens?: number;
  /** Server-reported concurrent slot count, when available. */
  slots?: number;
  /** Whether the detected local endpoint advertises vision input. */
  vision?: boolean;
}

export interface ProviderConnectionTestCommandV1 {
  kind: "connection_test";
  config: ProviderConnectionConfigV1;
}

export interface CredentialStatusCommandV1 {
  kind: "credential_status";
}

export type CredentialStatusSnapshotV1 =
  | { status: "none" }
  | { status: "ready"; reference: CredentialReferenceV1 }
  | { status: "migration-pending" }
  | { status: "corrupt" };

export type OptionsPlatformCommandV1 = ProviderConnectionTestCommandV1 | CredentialStatusCommandV1;

export interface OptionsPlatformCommandMessageV1 {
  type: "OPTIONS_PLATFORM_COMMAND";
  version: 1;
  command: OptionsPlatformCommandV1;
}

export type OptionsPlatformCommandResponseV1 =
  | { ok: true; kind: "connection_test"; result: ProviderConnectionResultV1 }
  | { ok: true; kind: "credential_status"; status: CredentialStatusSnapshotV1 }
  | { ok: false; error: string };
