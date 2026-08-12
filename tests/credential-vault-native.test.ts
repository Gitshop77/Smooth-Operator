import { beforeEach, describe, expect, test } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  CREDENTIAL_VAULT_CREDENTIAL_STORE,
  CREDENTIAL_VAULT_DB_NAME,
  CREDENTIAL_VAULT_DB_VERSION,
  CREDENTIAL_VAULT_KEY_ID,
  CREDENTIAL_VAULT_META_STORE,
  IndexedDbCredentialVault,
} from "../src/extension/credential-vault";
import { decodeCredentialHandle } from "../src/extension/credential-contract";

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

async function openVaultDb(): Promise<IDBDatabase> {
  return request(indexedDB.open(CREDENTIAL_VAULT_DB_NAME, CREDENTIAL_VAULT_DB_VERSION));
}

async function readStore(storeName: string, key: IDBValidKey): Promise<unknown> {
  const db = await openVaultDb();
  try {
    return await request(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
  } finally {
    db.close();
  }
}

async function writeRecord(record: unknown): Promise<void> {
  const db = await openVaultDb();
  try {
    const tx = db.transaction(CREDENTIAL_VAULT_CREDENTIAL_STORE, "readwrite");
    await request(tx.objectStore(CREDENTIAL_VAULT_CREDENTIAL_STORE).put(record));
  } finally {
    db.close();
  }
}

describe("native IndexedDbCredentialVault", () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  test("stores a nonextractable CryptoKey and authenticates ciphertext metadata", async () => {
    const vault = new IndexedDbCredentialVault();
    const handleA = decodeCredentialHandle("cred_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")!;
    const handleB = decodeCredentialHandle("cred_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")!;
    const refA = await vault.write(handleA, "openai", "secret-a", 0);
    const refB = await vault.write(handleB, "openai", "secret-b", 0);

    const storedKey = await readStore(CREDENTIAL_VAULT_META_STORE, CREDENTIAL_VAULT_KEY_ID);
    expect(storedKey).toBeInstanceOf(CryptoKey);
    expect((storedKey as CryptoKey).extractable).toBe(false);
    expect((storedKey as CryptoKey).algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", storedKey as CryptoKey)).rejects.toThrow();

    const recordA = await readStore(CREDENTIAL_VAULT_CREDENTIAL_STORE, handleA) as Record<string, unknown>;
    const recordB = await readStore(CREDENTIAL_VAULT_CREDENTIAL_STORE, handleB) as Record<string, unknown>;
    await writeRecord({ ...recordA, ciphertext: recordB.ciphertext });
    await expect(vault.read(refA)).rejects.toThrow();

    await writeRecord(recordA);
    await expect(vault.read({ ...refA, revision: refA.revision + 1 })).rejects.toThrow("metadata");
    await expect(vault.read({ ...refA, providerId: "anthropic" })).rejects.toThrow("metadata");

    await writeRecord({ ...recordA, providerId: "anthropic" });
    await expect(vault.read({ ...refA, providerId: "anthropic" })).rejects.toThrow();
    expect(await vault.read(refB)).toBe("secret-b");
  });
});
