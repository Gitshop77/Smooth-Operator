import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashRawLockfile,
  parseOptions,
  validateManifest,
  validateNvmrc,
  validatePackagePrerequisites,
  validateArtifactInventories,
  validateIndependentBuildArtifacts,
  validateRawLockfileHashes,
  validateThirdPartyLicenseInventory,
  validateBuiltBundleSecretHygiene,
  validateBuiltBundleSessionAccessPolicy,
  hasUnsafeBuiltSessionAccessPolicy,
  findSecretShapes,
  EXPECTED_BUNDLE_FILES,
} from "../scripts/verify-baseline.mjs";

const manifest = {
  manifest_version: 3,
  version: "1.2.3",
  permissions: [
    "sidePanel", "scripting", "tabs", "activeTab", "storage", "alarms", "debugger",
    "nativeMessaging",
    "notifications", "downloads", "unlimitedStorage", "power", "webRequest", "cookies",
  ],
  host_permissions: ["http://*/*", "https://*/*"],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self'; frame-ancestors 'none'; connect-src 'self' http: https: ws: wss:;",
  },
  background: { service_worker: "background.js" },
  side_panel: { default_path: "sidepanel.html" },
};

describe("verify-baseline preflight helpers", () => {
  it("accepts the reviewed package and MV3 manifest contracts", () => {
    expect(validatePackagePrerequisites(
      { packageManager: "npm@10.9.8", engines: { node: "22.23.2", npm: "10.9.8" }, dependencies: {}, devDependencies: {}, overrides: {} },
      { lockfileVersion: 3, packages: { "": { dependencies: {}, devDependencies: {}, engines: { node: "22.23.2", npm: "10.9.8" } } } },
      "22.23.2",
      "10.9.8",
    ).lockfileVersion).toBe(3);
    expect(validateManifest(manifest, "1.2.3").permissions).toContain("sidePanel");
  });

  it("fails closed for drifted lock roots, unsafe CSP, and incompatible options", () => {
    expect(() => validatePackagePrerequisites(
      { packageManager: "npm@10.9.8", engines: { node: "22.23.2", npm: "10.9.8" }, dependencies: { zod: "1" } },
      { lockfileVersion: 3, packages: { "": { dependencies: {} } } },
      "22.23.2",
      "10.9.8",
    )).toThrow(/does not match/);
    expect(() => validatePackagePrerequisites(
      { packageManager: "npm@10.9.8", engines: { node: "22.23.2", npm: "10.9.8" }, dependencies: {} },
      { lockfileVersion: 3, packages: { "": { dependencies: {} } } },
      "22.23.1",
      "10.9.8",
    )).toThrow(/Node 22\.23\.2/);
    expect(() => validatePackagePrerequisites(
      { packageManager: "npm@10.9.8", engines: { node: "22.23.2", npm: "10.9.8" }, dependencies: {} },
      { lockfileVersion: 3, packages: { "": { dependencies: {} } } },
      "22.23.2",
      "11.0.0",
    )).toThrow(/npm 10\.9\.8/);
    expect(() => validateNvmrc("22.23.1\n", { engines: { node: "22.23.2" } }))
      .toThrow(/\.nvmrc must pin Node 22\.23\.2/);
    expect(() => validateManifest({
      ...manifest,
      content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'self';" },
    }, "1.2.3")).toThrow(/CSP/);
    expect(() => validateManifest({ ...manifest, permissions: ["sidePanel", "management"] }, "1.2.3")).toThrow(/permission inventory/);
    expect(() => parseOptions(["--clean-install", "--skip-install"])).toThrow(/either/);
  });

  it("requires the exact reviewed package and byte-identical consecutive builds", () => {
    const inventory = EXPECTED_BUNDLE_FILES.map((file, index) => ({
      file,
      bytes: index + 1,
      sha256: `hash-${index}`,
    }));
    expect(validateArtifactInventories(inventory)).toHaveLength(EXPECTED_BUNDLE_FILES.length);
    expect(() => validateArtifactInventories(inventory.filter((item) => item.file !== "sidepanel.css")))
      .toThrow(/sidepanel\.css/);
    expect(() => validateArtifactInventories([...inventory, { file: "unexpected.js", bytes: 1, sha256: "x" }]))
      .toThrow(/unexpected\.js/);
    expect(() => validateArtifactInventories(inventory, inventory.map((item) =>
      item.file === "background.js" ? { ...item, sha256: "different" } : item,
    ))).toThrow(/artifact bytes differ/);
  });

  it("hashes the raw complete lockfile rather than selected parsed fields", () => {
    const compact = Buffer.from('{"lockfileVersion":3,"packages":{}}\n');
    const formatted = Buffer.from('{\n  "lockfileVersion": 3,\n  "packages": {}\n}\n');
    const compactHash = hashRawLockfile(compact);
    expect(compactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRawLockfile(formatted)).not.toBe(compactHash);
    expect(() => validateRawLockfileHashes(compactHash, hashRawLockfile(formatted), "root", "isolated build 1"))
      .toThrow(/raw package-lock SHA-256 differs between root/);
  });

  it("fails when an independent clean-install artifact drifts from the root build", () => {
    const inventory = EXPECTED_BUNDLE_FILES.map((file, index) => ({
      file,
      bytes: index + 1,
      sha256: `hash-${index}`,
    }));
    expect(() => validateIndependentBuildArtifacts(
      inventory,
      inventory,
      inventory.map((item) => item.file === "background.js" ? { ...item, sha256: "isolated-drift" } : item),
    )).toThrow(/root build and isolated build 2/);
  });

  it("requires a valid shipped notice for every direct runtime dependency", () => {
    const complete = {
      formatVersion: 1,
      dependencies: [
        { name: "runtime-a", version: "1.0.0", license: "MIT", artifact: "LICENSE-MIT" },
      ],
    };
    expect(validateThirdPartyLicenseInventory({ "runtime-a": "1.0.0" }, complete)).toHaveLength(1);
    expect(() => validateThirdPartyLicenseInventory(
      { "runtime-a": "1.0.0", "runtime-b": "2.0.0" },
      complete,
    )).toThrow(/every direct runtime dependency/);
    expect(() => validateThirdPartyLicenseInventory(
      { "runtime-a": "1.0.0" },
      { ...complete, dependencies: [{ ...complete.dependencies[0], artifact: "MISSING-LICENSE" }] },
    )).toThrow(/invalid third-party license entry/);
  });

  it("keeps the exact-package secret scanner positive-controlled", () => {
    expect(findSecretShapes("ordinary bundled source")).toEqual([]);
    expect(findSecretShapes("sk-ant-A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0"))
      .toContain("anthropic");
    const bundle = mkdtempSync(path.join(tmpdir(), "verify-baseline-secret-test-"));
    try {
      writeFileSync(path.join(bundle, "background.js"), "const harmless = true;\n", "utf8");
      expect(validateBuiltBundleSecretHygiene(bundle)).toEqual({ scannedJavaScriptFiles: 1 });
      writeFileSync(path.join(bundle, "background.js"), "const key = 'sk-ant-A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0';\n", "utf8");
      expect(() => validateBuiltBundleSecretHygiene(bundle)).toThrow(/exact package contains secret-shaped literals/);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });

  it("allows a trusted-only package restriction and rejects session-access widening", () => {
    const bundle = mkdtempSync(path.join(tmpdir(), "verify-baseline-session-access-test-"));
    try {
      writeFileSync(path.join(bundle, "content.js"), "const harmless = true;\n", "utf8");
      expect(validateBuiltBundleSessionAccessPolicy(bundle)).toEqual({ scannedJavaScriptFiles: 1 });
      const safeRestriction =
        "chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });\n";
      expect(hasUnsafeBuiltSessionAccessPolicy(safeRestriction)).toBe(false);
      writeFileSync(path.join(bundle, "content.js"), safeRestriction, "utf8");
      expect(validateBuiltBundleSessionAccessPolicy(bundle)).toEqual({ scannedJavaScriptFiles: 1 });

      writeFileSync(
        path.join(bundle, "content.js"),
        "chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });\n",
        "utf8",
      );
      expect(hasUnsafeBuiltSessionAccessPolicy(
        "chrome.storage.session.setAccessLevel({ accessLevel: configuredLevel });",
      )).toBe(true);
      expect(hasUnsafeBuiltSessionAccessPolicy(
        "chrome.storage.session.setAccessLevel({ accessLevel: configuredLevel, note: 'TRUSTED_CONTEXTS' });",
      )).toBe(true);
      expect(() => validateBuiltBundleSessionAccessPolicy(bundle))
        .toThrow(/widens chrome\.storage\.session access/);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });

});
