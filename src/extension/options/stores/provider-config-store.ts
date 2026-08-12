/**
 * options/stores/provider-config-store.ts — authoritative provider/model
 * selection state for the Connection tab.
 *
 * The store owns the *selection* and the *derived capabilities* for the current
 * provider/model.  Every provider/model change bumps `generation` and clears
 * anything that could leak from the previous selection (the model id is the
 * biggest stale-cache hazard).  Async work that is bound to a selection
 * (connection tests) tags itself with the generation at which it started and is
 * dropped when a newer selection supersedes it — see
 * connection-diagnostics-store.ts.
 *
 * Sensitive values are never stored here: the API key lives in session storage
 * and the credential *reference* (an opaque id, never the secret) arrives via
 * CREDENTIAL_STATUS_RESOLVED from the background-owned credential service.
 */

import { PROVIDER_META, DEFAULT_PROVIDER_ID, catalogIdFor } from "../providers";
import type { CredentialStatusSnapshotV1 } from "../../options-platform-contract";

/** Derived, display-safe capabilities of the selected provider. */
export interface ProviderCapabilities {
  needsKey: boolean;
  hint: string;
  keyUrl: string;
  keyPlaceholder: string;
  defaultBaseUrl?: string;
  defaultModel?: string;
  /** models.dev catalog id used for model search (undefined → no search). */
  catalogId?: string;
}

export interface ProviderConfigState {
  provider: string;
  model: string;
  baseUrl: string;
  resourceName: string;
  /**
   * Monotonic selection generation. Bumped on every real provider/model
   * change; in-flight results tagged with an older generation are stale.
   */
  generation: number;
  capabilities: ProviderCapabilities;
  /** Opaque credential reference snapshot from the background (never the key). */
  credentialStatus: CredentialStatusSnapshotV1 | null;
  /** Last surfaced configuration error (storage read/write, unknown provider). */
  error?: string;
}

export type ProviderConfigAction =
  | { type: "PROVIDER_SELECTED"; provider: string }
  | { type: "MODEL_SELECTED"; model: string }
  | { type: "BASE_URL_CHANGED"; baseUrl: string }
  | { type: "RESOURCE_NAME_CHANGED"; resourceName: string }
  | { type: "CREDENTIAL_STATUS_RESOLVED"; status: CredentialStatusSnapshotV1 }
  | { type: "CONFIG_ERROR"; error: string }
  | { type: "CONFIG_ERROR_CLEARED" };

/** Pure capability derivation — no DOM, no storage. */
export function capabilitiesForProvider(provider: string): ProviderCapabilities {
  const meta = PROVIDER_META[provider] || PROVIDER_META[DEFAULT_PROVIDER_ID];
  return {
    needsKey: meta.needsKey,
    hint: meta.hint,
    keyUrl: meta.keyUrl,
    keyPlaceholder: meta.keyPlaceholder,
    ...(meta.defaultBaseUrl ? { defaultBaseUrl: meta.defaultBaseUrl } : {}),
    ...(meta.defaultModel ? { defaultModel: meta.defaultModel } : {}),
    ...(catalogIdFor(provider) ? { catalogId: catalogIdFor(provider) } : {}),
  };
}

export const initialProviderConfigState: ProviderConfigState = {
  provider: DEFAULT_PROVIDER_ID,
  model: "",
  baseUrl: "",
  resourceName: "",
  generation: 0,
  capabilities: capabilitiesForProvider(DEFAULT_PROVIDER_ID),
  credentialStatus: null,
};

export function providerConfigReducer(
  state: ProviderConfigState,
  action: ProviderConfigAction,
): ProviderConfigState {
  switch (action.type) {
    case "PROVIDER_SELECTED": {
      const capabilities = capabilitiesForProvider(action.provider);
      if (state.provider === action.provider) {
        // Re-selecting the same provider must not clear a hydrated model or
        // bump the generation (that would invalidate an in-flight test for a
        // selection that did not change). Capabilities are refreshed anyway.
        return { ...state, capabilities };
      }
      // A real provider change: never let the previous provider's model leak
      // into the new selection, and invalidate any in-flight work for the old
      // selection by advancing the generation.
      return {
        ...state,
        provider: action.provider,
        model: "",
        generation: state.generation + 1,
        capabilities,
        error: undefined,
      };
    }
    case "MODEL_SELECTED": {
      const model = action.model.trim();
      if (model === state.model) return state;
      return { ...state, model, generation: state.generation + 1, error: undefined };
    }
    case "BASE_URL_CHANGED":
      return { ...state, baseUrl: action.baseUrl };
    case "RESOURCE_NAME_CHANGED":
      return { ...state, resourceName: action.resourceName };
    case "CREDENTIAL_STATUS_RESOLVED":
      return { ...state, credentialStatus: action.status };
    case "CONFIG_ERROR":
      return { ...state, error: action.error };
    case "CONFIG_ERROR_CLEARED":
      return state.error === undefined ? state : { ...state, error: undefined };
  }
}
