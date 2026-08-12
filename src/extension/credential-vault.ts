import {
  decodeCredentialHandle,
  decodeCredentialProviderId,
  decodeCredentialReference,
  type CredentialHandleV1,
  type CredentialReferenceV1,
} from "./credential-contract";

interface StoredCredentialV1 {
  handle: CredentialHandleV1;
  version: 1;
  providerId: string;
  revision: number;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

export interface CredentialVault {
  write(handle: CredentialHandleV1, providerId: string, plaintext: string, expectedRevision: number): Promise<CredentialReferenceV1>;
  read(reference: CredentialReferenceV1): Promise<string | null>;
  delete(reference: CredentialReferenceV1): Promise<void>;
}

export const CREDENTIAL_VAULT_DB_NAME = "open-cowork-credential-vault-v1";
export const CREDENTIAL_VAULT_DB_VERSION = 2;
export const CREDENTIAL_VAULT_CREDENTIAL_STORE = "credentials";
export const CREDENTIAL_VAULT_META_STORE = "meta";
export const CREDENTIAL_VAULT_KEY_ID = "aes-key-v1";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Credential vault request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Credential vault transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Credential vault transaction aborted"));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("Credential vault unavailable");
  const req = indexedDB.open(CREDENTIAL_VAULT_DB_NAME, CREDENTIAL_VAULT_DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(CREDENTIAL_VAULT_CREDENTIAL_STORE)) {
      db.createObjectStore(CREDENTIAL_VAULT_CREDENTIAL_STORE, { keyPath: "handle" });
    }
    if (!db.objectStoreNames.contains(CREDENTIAL_VAULT_META_STORE)) db.createObjectStore(CREDENTIAL_VAULT_META_STORE);
  };
  return request(req);
}

function isVaultCryptoKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== "object") return false;
  const key = value as CryptoKey;
  const algorithm = key.algorithm as AesKeyAlgorithm | undefined;
  return key.type === "secret" && key.extractable === false && algorithm?.name === "AES-GCM" &&
    algorithm.length === 256 && key.usages.length === 2 && key.usages.includes("encrypt") && key.usages.includes("decrypt");
}

let cryptoKeyInitialization: Promise<CryptoKey> | null = null;

async function initializeCryptoKey(db: IDBDatabase): Promise<CryptoKey> {
  const readTx = db.transaction(CREDENTIAL_VAULT_META_STORE, "readonly");
  const existing = await request(readTx.objectStore(CREDENTIAL_VAULT_META_STORE).get(CREDENTIAL_VAULT_KEY_ID));
  await transactionDone(readTx);
  if (isVaultCryptoKey(existing)) return existing;

  // Migrate the unreleased raw-byte V1 representation without changing the
  // encryption material; otherwise create a fresh nonextractable key.
  const candidate = existing instanceof Uint8Array && existing.byteLength === 32
    ? await crypto.subtle.importKey("raw", existing as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"])
    : await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const tx = db.transaction(CREDENTIAL_VAULT_META_STORE, "readwrite");
  const store = tx.objectStore(CREDENTIAL_VAULT_META_STORE);
  const current = await request(store.get(CREDENTIAL_VAULT_KEY_ID));
  if (isVaultCryptoKey(current)) {
    await transactionDone(tx);
    return current;
  }
  await request(store.put(candidate, CREDENTIAL_VAULT_KEY_ID));
  await transactionDone(tx);
  return candidate;
}

async function getCryptoKey(db: IDBDatabase): Promise<CryptoKey> {
  cryptoKeyInitialization ??= initializeCryptoKey(db).finally(() => { cryptoKeyInitialization = null; });
  return cryptoKeyInitialization;
}

function aad(reference: CredentialReferenceV1): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    "open-cowork-credential", reference.version, reference.handle, reference.providerId, reference.revision,
  ]));
}

function validStoredRecord(value: unknown, reference: CredentialReferenceV1): value is StoredCredentialV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && decodeCredentialHandle(record.handle) === reference.handle &&
    decodeCredentialProviderId(record.providerId) === reference.providerId && record.revision === reference.revision &&
    Object.prototype.toString.call(record.iv) === "[object Uint8Array]" &&
    (record.iv as Uint8Array).byteLength === 12 &&
    Object.prototype.toString.call(record.ciphertext) === "[object ArrayBuffer]" &&
    (record.ciphertext as ArrayBuffer).byteLength >= 16;
}

export class IndexedDbCredentialVault implements CredentialVault {
  async write(handle: CredentialHandleV1, providerIdValue: string, plaintext: string, expectedRevision: number): Promise<CredentialReferenceV1> {
    const providerId = decodeCredentialProviderId(providerIdValue);
    if (!decodeCredentialHandle(handle) || !providerId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || plaintext.length === 0) {
      throw new Error("Invalid credential write");
    }
    const revision = expectedRevision + 1;
    const reference: CredentialReferenceV1 = { version: 1, handle, providerId, revision };
    const db = await openDatabase();
    try {
      const key = await getCryptoKey(db);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(reference) as BufferSource },
        key,
        new TextEncoder().encode(plaintext),
      );
      const tx = db.transaction(CREDENTIAL_VAULT_CREDENTIAL_STORE, "readwrite");
      const store = tx.objectStore(CREDENTIAL_VAULT_CREDENTIAL_STORE);
      const current = await request(store.get(handle)) as StoredCredentialV1 | undefined;
      if ((current?.revision ?? 0) !== expectedRevision) {
        tx.abort();
        throw new Error("Stale credential revision");
      }
      await request(store.put({ ...reference, iv, ciphertext } satisfies StoredCredentialV1));
      await transactionDone(tx);
      return reference;
    } finally {
      db.close();
    }
  }

  async read(referenceValue: CredentialReferenceV1): Promise<string | null> {
    const reference = decodeCredentialReference(referenceValue);
    if (!reference) throw new Error("Malformed credential reference");
    const db = await openDatabase();
    try {
      const key = await getCryptoKey(db);
      const tx = db.transaction(CREDENTIAL_VAULT_CREDENTIAL_STORE, "readonly");
      const record = await request(tx.objectStore(CREDENTIAL_VAULT_CREDENTIAL_STORE).get(reference.handle));
      await transactionDone(tx);
      if (record === undefined) return null;
      if (!validStoredRecord(record, reference)) throw new Error("Corrupt credential metadata");
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: record.iv as BufferSource, additionalData: aad(reference) as BufferSource },
          key,
          record.ciphertext,
        );
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } catch {
        throw new Error("Credential decryption failed");
      }
    } finally {
      db.close();
    }
  }

  async delete(referenceValue: CredentialReferenceV1): Promise<void> {
    const reference = decodeCredentialReference(referenceValue);
    if (!reference) throw new Error("Malformed credential reference");
    const db = await openDatabase();
    try {
      const tx = db.transaction(CREDENTIAL_VAULT_CREDENTIAL_STORE, "readwrite");
      const store = tx.objectStore(CREDENTIAL_VAULT_CREDENTIAL_STORE);
      const current = await request(store.get(reference.handle));
      if (!validStoredRecord(current, reference)) {
        tx.abort();
        throw new Error("Stale or corrupt credential reference");
      }
      await request(store.delete(reference.handle));
      await transactionDone(tx);
      const verifyTx = db.transaction(CREDENTIAL_VAULT_CREDENTIAL_STORE, "readonly");
      const remains = await request(verifyTx.objectStore(CREDENTIAL_VAULT_CREDENTIAL_STORE).get(reference.handle));
      await transactionDone(verifyTx);
      if (remains !== undefined) throw new Error("Credential deletion could not be verified");
    } finally {
      db.close();
    }
  }
}
