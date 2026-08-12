import { beforeEach, describe, expect, test } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import type { CredentialVault } from "../src/extension/credential-vault";
import type { CredentialHandleV1, CredentialReferenceV1 } from "../src/extension/credential-contract";
import {
  forgetRememberedCredential,
  getCredentialStatus,
  migrateRememberedCredential,
  resolveCredential,
  saveEnteredCredential,
  setCredentialVaultForTests,
} from "../src/extension/credential-service";

class ControlledVault implements CredentialVault {
  records = new Map<CredentialHandleV1, { value: string; revision: number }>();
  failWrite = false;
  mismatchRead = false;
  failDelete = false;

  async write(handle: CredentialHandleV1, providerId: string, value: string, expectedRevision: number): Promise<CredentialReferenceV1> {
    if (this.failWrite) throw new Error("write failed");
    const current = this.records.get(handle)?.revision ?? 0;
    if (current !== expectedRevision) throw new Error("stale");
    const revision = current + 1;
    this.records.set(handle, { value, revision });
    return { version: 1, handle, providerId, revision };
  }

  async read(reference: CredentialReferenceV1): Promise<string | null> {
    const current = this.records.get(reference.handle);
    if (!current || current.revision !== reference.revision) return null;
    return this.mismatchRead ? `${current.value}-mismatch` : current.value;
  }

  async delete(reference: CredentialReferenceV1): Promise<void> {
    if (this.failDelete) throw new Error("delete failed");
    const current = this.records.get(reference.handle);
    if (!current || current.revision !== reference.revision) throw new Error("stale");
    this.records.delete(reference.handle);
  }
}

let local: Map<string, unknown>;
let session: Map<string, unknown>;
let vault: ControlledVault;

function seedLegacy(value = "sk-legacy"): void {
  local.set("apiKey", value);
  local.set("rememberApiKey", true);
}

describe("credential service V1", () => {
  beforeEach(() => {
    local = new Map();
    session = new Map();
    vault = new ControlledVault();
    (globalThis as unknown as { chrome: unknown }).chrome = makeChromeStorageMock(local, session);
    setCredentialVaultForTests(vault);
  });

  test("verified migration leaves only a non-secret manifest and hydrates session", async () => {
    seedLegacy();
    const reference = await migrateRememberedCredential();
    expect(reference).toMatchObject({ version: 1, revision: 1 });
    expect(local.has("apiKey")).toBe(false);
    expect(local.has("open_cowork_credential_migration_v1")).toBe(false);
    expect(JSON.stringify(local.get("open_cowork_credential_manifest_v1"))).not.toContain("sk-legacy");
    expect(session.get("apiKey")).toBe("sk-legacy");
    expect(await resolveCredential(reference!)).toBe("sk-legacy");
  });

  test("new credential goes directly to session and vault without local plaintext", async () => {
    const reference = await saveEnteredCredential("sk-new", "openai", true);
    expect(reference).toMatchObject({ version: 1, providerId: "openai", revision: 1 });
    expect(session.get("apiKey")).toBe("sk-new");
    expect(local.has("apiKey")).toBe(false);
    expect(local.get("open_cowork_credential_manifest_v1")).toMatchObject(reference!);
  });

  test("new credential vault failure retains session but never creates local plaintext", async () => {
    vault.failWrite = true;
    await expect(saveEnteredCredential("sk-new", "openai", true)).rejects.toThrow("write failed");
    expect(session.get("apiKey")).toBe("sk-new");
    expect(local.has("apiKey")).toBe(false);
    expect(local.has("open_cowork_credential_manifest_v1")).toBe(false);
  });

  test("unconsented legacy plaintext is verified in session before local removal", async () => {
    local.set("apiKey", "sk-session-only");
    expect(await migrateRememberedCredential()).toBeNull();
    expect(session.get("apiKey")).toBe("sk-session-only");
    expect(local.has("apiKey")).toBe(false);
    expect(local.has("open_cowork_credential_manifest_v1")).toBe(false);
  });

  test("a differing newer session credential retains the legacy source", async () => {
    local.set("apiKey", "sk-legacy");
    session.set("apiKey", "sk-newer");
    expect(await migrateRememberedCredential()).toBeNull();
    expect(session.get("apiKey")).toBe("sk-newer");
    expect(local.get("apiKey")).toBe("sk-legacy");
  });

  test("write failure retains legacy plaintext and resumable journal", async () => {
    seedLegacy();
    vault.failWrite = true;
    await expect(migrateRememberedCredential()).rejects.toThrow("write failed");
    expect(local.get("apiKey")).toBe("sk-legacy");
    expect(local.get("open_cowork_credential_migration_v1")).toMatchObject({ stage: "copying" });
  });

  test("decrypt byte mismatch retains the legacy source", async () => {
    seedLegacy();
    vault.mismatchRead = true;
    await expect(migrateRememberedCredential()).rejects.toThrow("verification mismatch");
    expect(local.get("apiKey")).toBe("sk-legacy");
  });

  test("crash after vault write resumes idempotently without a second revision", async () => {
    seedLegacy();
    const handle = "cred_v1_11111111111111111111111111111111" as CredentialHandleV1;
    local.set("open_cowork_credential_migration_v1", {
      version: 1, kind: "legacy-api-key", handle, providerId: "openai", sourceRevision: 0, stage: "copying",
    });
    vault.records.set(handle, { value: "sk-legacy", revision: 1 });
    const reference = await migrateRememberedCredential();
    expect(reference?.revision).toBe(1);
    expect(vault.records.get(handle)?.revision).toBe(1);
    expect(local.has("apiKey")).toBe(false);
  });

  test("restart with no local plaintext verifies vault before session hydration", async () => {
    seedLegacy();
    const reference = await migrateRememberedCredential();
    session.clear();
    expect(await migrateRememberedCredential()).toMatchObject(reference!);
    expect(session.get("apiKey")).toBe("sk-legacy");
  });

  test("remembered key replacement advances the revision without losing the new value", async () => {
    seedLegacy("sk-old");
    const oldReference = (await migrateRememberedCredential())!;
    seedLegacy("sk-new");
    const newReference = (await migrateRememberedCredential())!;
    expect(newReference.handle).toBe(oldReference.handle);
    expect(newReference.revision).toBe(oldReference.revision + 1);
    expect(await resolveCredential(newReference)).toBe("sk-new");
    expect(local.has("apiKey")).toBe(false);
  });

  test("stale reference resolution and stale opt-out revision fail closed", async () => {
    seedLegacy();
    const reference = (await migrateRememberedCredential())!;
    await expect(resolveCredential({ ...reference, revision: reference.revision + 1 })).rejects.toThrow("Stale");
    await expect(forgetRememberedCredential(reference.revision + 1)).rejects.toThrow("Stale");
    expect(await resolveCredential(reference)).toBe("sk-legacy");
  });

  test("corrupt manifest is reported and never interpreted as legacy", async () => {
    local.set("rememberApiKey", true);
    local.set("open_cowork_credential_manifest_v1", { version: 99, handle: "bad", revision: 1 });
    expect(await getCredentialStatus()).toEqual({ status: "corrupt" });
    await expect(migrateRememberedCredential()).rejects.toThrow("Corrupt credential manifest");
  });

  test("verified opt-out deletes vault and all persistent metadata but retains session", async () => {
    seedLegacy();
    const reference = (await migrateRememberedCredential())!;
    await forgetRememberedCredential(reference.revision);
    expect(vault.records.size).toBe(0);
    expect(local.get("rememberApiKey")).toBe(false);
    expect(local.has("open_cowork_credential_manifest_v1")).toBe(false);
    expect(session.get("apiKey")).toBe("sk-legacy");
  });

  test("vault delete failure preserves manifest and consent for retry", async () => {
    seedLegacy();
    const reference = (await migrateRememberedCredential())!;
    vault.failDelete = true;
    await expect(forgetRememberedCredential(reference.revision)).rejects.toThrow("delete failed");
    expect(local.get("rememberApiKey")).toBe(true);
    expect(local.has("open_cowork_credential_manifest_v1")).toBe(true);
  });
});
