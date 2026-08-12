import {
  createCredentialHandle,
  decodeCredentialManifest,
  decodeCredentialMigration,
  decodeCredentialProviderId,
  decodeCredentialReference,
  type CredentialManifestV1,
  type CredentialReferenceV1,
} from "./credential-contract";
import { IndexedDbCredentialVault, type CredentialVault } from "./credential-vault";
import { STORAGE_KEYS } from "./options/storage-keys";

export type CredentialStatusV1 =
  | { status: "none" }
  | { status: "ready"; reference: CredentialReferenceV1 }
  | { status: "migration-pending" }
  | { status: "corrupt" };

let testVault: CredentialVault | null = null;
const vault = (): CredentialVault => testVault ?? new IndexedDbCredentialVault();

/** Test-only dependency seam; passing null restores native IndexedDB. */
export function setCredentialVaultForTests(value: CredentialVault | null): void {
  testVault = value;
}

async function localGet(keys: string[]): Promise<Record<string, unknown>> {
  return chrome.storage.local.get(keys);
}

async function sessionHydrateAndVerify(plaintext: string, reference: CredentialReferenceV1): Promise<void> {
  await chrome.storage.session.set({
    [STORAGE_KEYS.apiKey]: plaintext,
    [STORAGE_KEYS.credentialManifest]: reference,
  });
  const stored = await chrome.storage.session.get([STORAGE_KEYS.apiKey, STORAGE_KEYS.credentialManifest]);
  const sessionReference = decodeCredentialManifest({
    ...(stored[STORAGE_KEYS.credentialManifest] as object ?? {}),
    kind: "provider-api-key",
  });
  if (stored[STORAGE_KEYS.apiKey] !== plaintext || !sessionReference ||
      sessionReference.handle !== reference.handle || sessionReference.providerId !== reference.providerId ||
      sessionReference.revision !== reference.revision) {
    throw new Error("Credential session hydration could not be verified");
  }
}

export async function getCredentialStatus(): Promise<CredentialStatusV1> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return { status: "none" };
  const data = await localGet([STORAGE_KEYS.credentialManifest, STORAGE_KEYS.credentialMigration]);
  if (data[STORAGE_KEYS.credentialMigration] !== undefined) {
    return decodeCredentialMigration(data[STORAGE_KEYS.credentialMigration])
      ? { status: "migration-pending" }
      : { status: "corrupt" };
  }
  if (data[STORAGE_KEYS.credentialManifest] === undefined) return { status: "none" };
  const manifest = decodeCredentialManifest(data[STORAGE_KEYS.credentialManifest]);
  return manifest ? { status: "ready", reference: manifest } : { status: "corrupt" };
}

/** Resolve only an exact, current opaque reference. Stale revisions fail closed. */
export async function resolveCredential(reference: CredentialReferenceV1): Promise<string> {
  const decoded = decodeCredentialReference(reference);
  if (!decoded) throw new Error("Malformed credential reference");
  const manifestData = await localGet([STORAGE_KEYS.credentialManifest]);
  const manifest = decodeCredentialManifest(manifestData[STORAGE_KEYS.credentialManifest]);
  if (!manifest || manifest.handle !== decoded.handle || manifest.providerId !== decoded.providerId ||
      manifest.revision !== decoded.revision) {
    throw new Error("Stale or unknown credential reference");
  }
  const plaintext = await vault().read(decoded);
  if (!plaintext) throw new Error("Credential unavailable");
  return plaintext;
}

/**
 * Persist a newly entered credential without ever staging it in local storage.
 * The trusted session copy is verified first; vault/manifest failure leaves
 * that session copy available while local plaintext remains absent.
 */
export async function saveEnteredCredential(
  plaintext: string,
  providerIdValue: string,
  remember: boolean,
): Promise<CredentialReferenceV1 | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.session || !chrome.storage?.local) return null;
  const providerId = decodeCredentialProviderId(providerIdValue);
  if (!providerId) throw new Error("Invalid credential provider");

  await chrome.storage.session.set({ [STORAGE_KEYS.apiKey]: plaintext });
  if ((await chrome.storage.session.get([STORAGE_KEYS.apiKey]))[STORAGE_KEYS.apiKey] !== plaintext) {
    throw new Error("Credential session write could not be verified");
  }

  if (!remember || plaintext.length === 0) {
    const status = await getCredentialStatus();
    if (status.status === "corrupt") throw new Error("Corrupt credential metadata");
    await forgetRememberedCredential(status.status === "ready" ? status.reference.revision : 0);
    return null;
  }

  // A local plaintext value can only predate this call. Preserve the legacy
  // retention/journal contract, then restore the newly entered session value.
  const legacy = await localGet([STORAGE_KEYS.apiKey]);
  if (legacy[STORAGE_KEYS.apiKey] !== undefined) {
    await migrateRememberedCredential();
    await chrome.storage.session.set({ [STORAGE_KEYS.apiKey]: plaintext });
  }
  if ((await localGet([STORAGE_KEYS.apiKey]))[STORAGE_KEYS.apiKey] !== undefined) {
    throw new Error("Legacy credential migration incomplete");
  }

  const manifestData = await localGet([STORAGE_KEYS.credentialManifest, STORAGE_KEYS.credentialMigration]);
  if (manifestData[STORAGE_KEYS.credentialMigration] !== undefined) {
    throw new Error("Credential migration incomplete");
  }
  const current = decodeCredentialManifest(manifestData[STORAGE_KEYS.credentialManifest]);
  if (manifestData[STORAGE_KEYS.credentialManifest] !== undefined && !current) {
    throw new Error("Corrupt credential manifest");
  }
  const sameProvider = current?.providerId === providerId;
  const handle = sameProvider ? current.handle : createCredentialHandle();
  const expectedRevision = sameProvider ? current.revision : 0;
  const reference = await vault().write(handle, providerId, plaintext, expectedRevision);
  if (await vault().read(reference) !== plaintext) throw new Error("Credential vault verification mismatch");

  const manifest: CredentialManifestV1 = { ...reference, kind: "provider-api-key" };
  await chrome.storage.local.set({
    [STORAGE_KEYS.credentialManifest]: manifest,
    [STORAGE_KEYS.rememberApiKey]: true,
  });
  const verify = await localGet([STORAGE_KEYS.apiKey, STORAGE_KEYS.credentialManifest]);
  const storedManifest = decodeCredentialManifest(verify[STORAGE_KEYS.credentialManifest]);
  if (verify[STORAGE_KEYS.apiKey] !== undefined || !storedManifest ||
      storedManifest.handle !== reference.handle || storedManifest.providerId !== reference.providerId ||
      storedManifest.revision !== reference.revision) {
    throw new Error("Credential manifest verification failed");
  }
  await sessionHydrateAndVerify(plaintext, reference);
  return reference;
}

/**
 * Resumable two-phase migration. The local journal contains no secret; the
 * legacy plaintext is removed only after vault round-trip and session verify.
 */
export async function migrateRememberedCredential(): Promise<CredentialReferenceV1 | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local || !chrome.storage?.session) return null;
  const data = await localGet([
    STORAGE_KEYS.apiKey, STORAGE_KEYS.rememberApiKey,
    STORAGE_KEYS.credentialManifest, STORAGE_KEYS.credentialMigration, STORAGE_KEYS.provider,
  ]);
  const providerId = decodeCredentialProviderId(data[STORAGE_KEYS.provider]) ?? "openai";
  const legacy = data[STORAGE_KEYS.apiKey];
  if (data[STORAGE_KEYS.rememberApiKey] !== true) {
    if (typeof legacy !== "string" || legacy.length === 0) return null;
    const session = await chrome.storage.session.get([STORAGE_KEYS.apiKey]);
    const existing = session[STORAGE_KEYS.apiKey];
    if (typeof existing === "string" && existing.length > 0 && existing !== legacy) return null;
    if (existing !== legacy) await chrome.storage.session.set({ [STORAGE_KEYS.apiKey]: legacy });
    if ((await chrome.storage.session.get([STORAGE_KEYS.apiKey]))[STORAGE_KEYS.apiKey] !== legacy) {
      throw new Error("Legacy credential session copy could not be verified");
    }
    await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
    if ((await localGet([STORAGE_KEYS.apiKey]))[STORAGE_KEYS.apiKey] !== undefined) {
      throw new Error("Legacy credential deletion could not be verified");
    }
    return null;
  }
  const currentManifest = decodeCredentialManifest(data[STORAGE_KEYS.credentialManifest]);
  const currentJournal = decodeCredentialMigration(data[STORAGE_KEYS.credentialMigration]);
  if (data[STORAGE_KEYS.credentialManifest] !== undefined && !currentManifest) throw new Error("Corrupt credential manifest");
  if (data[STORAGE_KEYS.credentialMigration] !== undefined && !currentJournal) throw new Error("Corrupt credential migration journal");

  // A crash after legacy deletion is recoverable from the already verified
  // manifest. An incomplete journal without either source is ambiguous.
  if (typeof legacy !== "string" || legacy.length === 0) {
    if (!currentManifest) {
      if (currentJournal) throw new Error("Credential migration source unavailable");
      return null;
    }
    const plaintext = await vault().read(currentManifest);
    if (!plaintext) throw new Error("Credential unavailable");
    await sessionHydrateAndVerify(plaintext, currentManifest);
    await chrome.storage.local.remove(STORAGE_KEYS.credentialMigration);
    return currentManifest;
  }

  const handle = currentJournal?.handle ?? currentManifest?.handle ?? createCredentialHandle();
  const boundProviderId = currentJournal?.providerId ?? currentManifest?.providerId ?? providerId;
  if (!currentJournal) {
    if (currentManifest && await vault().read(currentManifest) === legacy) {
      await sessionHydrateAndVerify(legacy, currentManifest);
      await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
      if ((await localGet([STORAGE_KEYS.apiKey]))[STORAGE_KEYS.apiKey] !== undefined) {
        throw new Error("Legacy credential deletion could not be verified");
      }
      return currentManifest;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.credentialMigration]: {
        version: 1, kind: "legacy-api-key", handle, providerId: boundProviderId,
        sourceRevision: currentManifest?.revision ?? 0, stage: "copying",
      },
    });
  }

  const sourceRevision = currentJournal?.sourceRevision ?? currentManifest?.revision ?? 0;
  const targetReference: CredentialReferenceV1 = {
    version: 1, handle, providerId: boundProviderId, revision: sourceRevision + 1,
  };
  const journaledCopy = await vault().read(targetReference);
  if (journaledCopy !== null && journaledCopy !== legacy) {
    throw new Error("Credential migration verification mismatch");
  }
  const reference = journaledCopy === legacy
    ? targetReference
    : await vault().write(handle, boundProviderId, legacy, sourceRevision);
  const copied = await vault().read(reference);
  if (copied !== legacy) throw new Error("Credential migration verification mismatch");
  const manifest: CredentialManifestV1 = { ...reference, kind: "provider-api-key" };
  await chrome.storage.local.set({
    [STORAGE_KEYS.credentialManifest]: manifest,
    [STORAGE_KEYS.credentialMigration]: {
      version: 1, kind: "legacy-api-key", handle, providerId: boundProviderId,
      sourceRevision, stage: "manifested",
    },
  });

  await sessionHydrateAndVerify(legacy, reference);
  const beforeDelete = await localGet([STORAGE_KEYS.apiKey]);
  if (beforeDelete[STORAGE_KEYS.apiKey] !== legacy) throw new Error("Credential migration source changed");
  await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
  const verify = await localGet([STORAGE_KEYS.apiKey]);
  if (verify[STORAGE_KEYS.apiKey] !== undefined) throw new Error("Legacy credential deletion could not be verified");
  await chrome.storage.local.remove(STORAGE_KEYS.credentialMigration);
  return reference;
}

/** Delete the persistent credential only at the caller's exact revision. */
export async function forgetRememberedCredential(expectedRevision: number): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid credential revision");
  const data = await localGet([STORAGE_KEYS.credentialManifest, STORAGE_KEYS.credentialMigration, STORAGE_KEYS.apiKey]);
  const manifest = decodeCredentialManifest(data[STORAGE_KEYS.credentialManifest]);
  const journal = decodeCredentialMigration(data[STORAGE_KEYS.credentialMigration]);
  if (data[STORAGE_KEYS.credentialManifest] !== undefined && !manifest) throw new Error("Corrupt credential manifest");
  if (data[STORAGE_KEYS.credentialMigration] !== undefined && !journal) throw new Error("Corrupt credential migration journal");
  if (manifest) {
    if (expectedRevision !== manifest.revision) throw new Error("Stale credential revision");
    await vault().delete(manifest);
  } else {
    if (expectedRevision !== 0) throw new Error("Stale credential revision");
    if (journal) {
      const interrupted: CredentialReferenceV1 = {
        version: 1, handle: journal.handle, providerId: journal.providerId, revision: 1,
      };
      if (await vault().read(interrupted) !== null) await vault().delete(interrupted);
    }
  }
  await chrome.storage.local.remove([STORAGE_KEYS.apiKey, STORAGE_KEYS.credentialManifest, STORAGE_KEYS.credentialMigration]);
  const verify = await localGet([STORAGE_KEYS.apiKey, STORAGE_KEYS.credentialManifest, STORAGE_KEYS.credentialMigration]);
  if (Object.keys(verify).length !== 0) throw new Error("Credential deletion could not be verified");
  await chrome.storage.local.set({ [STORAGE_KEYS.rememberApiKey]: false });
}
