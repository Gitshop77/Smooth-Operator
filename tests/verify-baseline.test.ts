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
  buildPhase2RecoveryBoundaryInventory,
  validatePhase2RecoveryBoundary,
  validatePhase4Delta,
  validatePhase5Delta,
  validatePhase6Delta,
  validatePhase7Delta,
  validatePhase8Delta,
  validatePhase9Delta,
  validatePhase10Delta,
  validatePhase11Delta,
  validatePhase12Delta,
  validatePhase13Delta,
  validatePhase14Delta,
  validatePhase15Delta,
  validatePhase19Delta,
  validateLedgerClosed,
  findSecretShapes,
  EXPECTED_BUNDLE_FILES,
} from "../scripts/verify-baseline.mjs";

const manifest = {
  manifest_version: 3,
  version: "1.2.3",
  permissions: [
    "sidePanel", "scripting", "tabs", "activeTab", "storage", "alarms", "debugger",
    "notifications", "downloads", "unlimitedStorage", "power", "webRequest", "cookies",
  ],
  host_permissions: ["http://*/*", "https://*/*"],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self'; frame-ancestors 'none';",
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

  it("freezes the recovery-era boundary and validates a sealed Phase 4 delta", () => {
    const root = process.cwd();
    const frozen = validatePhase2RecoveryBoundary(root);
    expect(frozen.artifactSha256).toBe("7dc75cba030673622e11a614b43f1a239cd9a0034dce948455d6289fed59c995");
    expect(frozen.production.fileCount).toBeGreaterThan(300);
    const recordedPhase4 = validatePhase4Delta(root);
    expect(recordedPhase4.files).toHaveLength(18);
    expect(recordedPhase4.artifactSha256)
      .toBe("4bc10f0a43e7d687ec72e1ff2e265acef3849f05aabe0f9cb7a5b2ab1e87c6ea");
    expect(recordedPhase4.resultingProductionInventory.contentTreeSha256)
      .toBe("5fcf7dbcba92e0e4db236fcdc3f08bbd28d5fa2e01cec7434870eddef75af3d0");

    expect(() => buildPhase2RecoveryBoundaryInventory(root, ["src/extension/options.ts"]))
      .toThrow(/escapes test\/verifier\/docs scope/);

    const resultingProductionInventory = buildPhase2RecoveryBoundaryInventory(root, []).production;
    const sealed = {
      formatVersion: 1,
      boundary: "phase-4-delta-against-phase-2-recovery-era",
      provisional: false,
      baseArtifact: {
        path: "docs/redesign/PHASE2_RECOVERY_BOUNDARY.json",
        sha256: frozen.artifactSha256,
      },
      evidenceLimit: "The aggregate Phase 2 hash cannot identify historical per-file changes; the reviewed allowlist is explicit and the complete resulting tree is pinned.",
      productionDelta: {
        files: ["src/extension/options/connection-test-utils.ts"],
        resultingProductionInventory,
      },
    };
    expect(validatePhase4Delta(root, sealed).currentProduction).toEqual(resultingProductionInventory);
    expect(() => validatePhase4Delta(root, { ...sealed, provisional: true }))
      .toThrow(/provisional/);
    expect(() => validatePhase4Delta(root, {
      ...sealed,
      productionDelta: { ...sealed.productionDelta, files: ["tests/verify-baseline.test.ts"] },
    })).toThrow(/escapes the production/);
    expect(() => validatePhase4Delta(root, {
      ...sealed,
      productionDelta: {
        ...sealed.productionDelta,
        resultingProductionInventory: { ...resultingProductionInventory, contentTreeSha256: "0".repeat(64) },
      },
    })).toThrow(/inventory drifted/);
  });

  it("binds the sealed Phase 5 delta to immutable Phase 4 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase5Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(24);
    expect(recorded.files).toContain("src/lib/agent/capability-policy.ts");
    expect(recorded.phase4.artifactSha256)
      .toBe("4bc10f0a43e7d687ec72e1ff2e265acef3849f05aabe0f9cb7a5b2ab1e87c6ea");
    expect(recorded.artifactSha256)
      .toBe("c8e495a9073e10ee168c08450a8ff06d532ee7fd2602732eb62ec254e21469c0");

    const sealed = {
      formatVersion: 1,
      boundary: "phase-5-delta-against-phase-4",
      provisional: false,
      baseArtifact: {
        path: "docs/redesign/PHASE4_DELTA.json",
        sha256: recorded.phase4.artifactSha256,
      },
      evidenceLimit: "The earlier provisional inventory is sealed only after all Phase 5 owners report paths.",
      productionDelta: {
        files: ["src/lib/agent/capability-policy.ts"],
        resultingProductionInventory: recorded.resultingProductionInventory,
      },
    };
    expect(() => validatePhase5Delta(root, sealed))
      .toThrow(/inventory drifted/);
    expect(() => validatePhase5Delta(root, {
      ...sealed,
      baseArtifact: { ...sealed.baseArtifact, sha256: "0".repeat(64) },
    })).toThrow(/immutable Phase 4/);
    expect(() => validatePhase5Delta(root, {
      ...sealed,
      provisional: true,
    }, { allowProvisional: true })).toThrow(/must not claim a sealed/);
  });

  it("binds the sealed Phase 6 delta to immutable Phase 5 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase6Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(12);
    expect(recorded.files).toContain("src/extension/background/run-command-service.ts");
    expect(recorded.artifactSha256)
      .toBe("04985ffe26a517addb8f847244f5380759f5a7f79f8f161bf341caffadae748b");
    expect(recorded.phase5.artifactSha256)
      .toBe("c8e495a9073e10ee168c08450a8ff06d532ee7fd2602732eb62ec254e21469c0");
    expect(() => validatePhase6Delta(root, {
      formatVersion: 1,
      boundary: "phase-6-delta-against-phase-5",
      provisional: true,
      baseArtifact: {
        path: "docs/redesign/PHASE5_DELTA.json",
        sha256: "0".repeat(64),
      },
      evidenceLimit: "provisional until all owners report",
      productionDelta: {
        files: ["src/extension/background/run-command-service.ts"],
        resultingProductionInventory: null,
      },
    }, { allowProvisional: true })).toThrow(/immutable Phase 5/);
  });

  it("binds sealed Phase 7 paths to immutable Phase 6 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase7Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(19);
    expect(recorded.files).toContain("package.json");
    expect(recorded.files).toContain("package-lock.json");
    expect(recorded.files).toContain("src/extension/background/provider-connection-service.ts");
    expect(recorded.phase6.artifactSha256)
      .toBe("04985ffe26a517addb8f847244f5380759f5a7f79f8f161bf341caffadae748b");
  });

  it("binds sealed Phase 8 paths to immutable Phase 7 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase8Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(14);
    expect(recorded.files).toContain("src/lib/agent/prompts/prompt-compiler.ts");
    expect(recorded.files).toContain("src/lib/agent/prompts/prompt-contract.ts");
    expect(recorded.files).toContain("src/lib/agent/prompts/prompt-token-budget.ts");
    expect(recorded.files).toContain("src/lib/agent/prompts/bounded-prompt-text.ts");
    expect(recorded.files).toContain("src/extension/llm-direct.ts");
    expect(recorded.files).toContain("src/lib/agent/loop/orchestrator-helpers.ts");
    expect(recorded.files).toContain("src/lib/agent/errors-utils.ts");
    expect(recorded.phase7.artifactSha256)
      .toBe("dadafbdf50dba389282f085554ac6e78d0e0296ef2d52cf54489d05cb0c5053b");
  });

  it("binds sealed Phase 9 paths to immutable Phase 8 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase9Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(9);
    expect(recorded.files).toContain("src/lib/agent/loop/run-state-machine.ts");
    expect(recorded.files).toContain("src/lib/agent/loop/phases/fast-path.ts");
    expect(recorded.files).toContain("src/lib/agent/loop/orchestrator-helpers.ts");
    expect(recorded.base.artifactSha256)
      .toBe("9079db150fdd1cb3e0d2e625c2012be4554a9cb2efb005fea046a3bb774698a1");
  });

  it("binds sealed Phase 10 paths to immutable Phase 9 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase10Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(29);
    expect(recorded.files).toContain("src/extension/background/cdp-rect-utils.ts");
    expect(recorded.files).toContain("src/lib/agent/tools/helpers/element-resolver.ts");
    expect(recorded.files).toContain("src/lib/agent/tools/executor.ts");
    expect(recorded.files).toContain("src/extension/content-utils.ts");
    expect(recorded.base.artifactSha256)
      .toBe("06fc314c0a65754fe49cf45d74e349eb96886a3ec07c7b8cf590941b980ab7bd");
  });

  it("binds sealed Phase 11 paths to immutable Phase 10 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase11Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(13);
    expect(recorded.files).toContain("src/lib/agent/storage-version.ts");
    expect(recorded.files).toContain("src/extension/background/webhook-delivery.ts");
    expect(recorded.files).toContain("src/extension/background/history-command.ts");
    expect(recorded.files).toContain("src/lib/agent/scheduled-tasks.ts");
    expect(recorded.base.artifactSha256)
      .toBe("e82611ef5c64c0e5c711ab8cad17df34b41cfab2901b3aef9500bd21c6e8f10c");
  });

  it("binds sealed Phase 12 paths to immutable Phase 11 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase12Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(26);
    expect(recorded.files).toContain("src/extension/options/stores/store.ts");
    expect(recorded.files).toContain("src/extension/sidepanel/run-store.ts");
    expect(recorded.files).toContain("src/extension/sidepanel/controls.ts");
    expect(recorded.files).toContain("src/lib/agent/mutex.ts");
    expect(recorded.base.artifactSha256)
      .toBe("52e3ab78bbe1009bc9bd830766a561ac6b772efbeebdbf3ba7ff807fd1ce4bb8");
  });

  it("binds sealed Phase 13 paths to immutable Phase 12 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase13Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(16);
    expect(recorded.files).toContain("src/extension/tokens.css");
    expect(recorded.files).toContain("src/extension/components.css");
    expect(recorded.files).toContain("src/extension/accessibility.ts");
    expect(recorded.files).toContain("src/extension/sidepanel.css");
    expect(recorded.base.artifactSha256)
      .toBe("201e41ee23db733b9ca4d60eebd199448876ae7c2c0872ee834cf2dc4ed9c87e");
  });

  it("binds sealed Phase 14 paths to immutable Phase 13 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase14Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toHaveLength(13);
    expect(recorded.files).toContain("src/extension/options/settings-sync.ts");
    expect(recorded.files).toContain("src/extension/sidepanel/controls.ts");
    expect(recorded.files).toContain("src/extension/tokens.css");
    expect(recorded.files).toContain("package.json");
    expect(recorded.base.artifactSha256)
      .toBe("8e20e54d8f724b5989023d58682961dae80a546d9ef902bf145a632e264de3ac");
  });

  it("binds sealed Phase 15 paths to immutable Phase 14 bytes", () => {
    const root = process.cwd();
    const recorded = validatePhase15Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toContain("vitest.config.ts");
    expect(recorded.files).toContain("package.json");
    expect(recorded.files).toContain(".github/workflows/ci.yml");
    expect(recorded.base.artifactSha256)
      .toBe("b5b578989e572d3a8ca847bffdddfee8feb6c4cd3335d6c4dcfd8758592f2998");
  });

  it("binds sealed Phase 19 paths to immutable Phase 18 bytes and enforces the ledger gate", () => {
    const root = process.cwd();
    const recorded = validatePhase19Delta(root);
    expect(recorded.provisional).toBe(false);
    expect(recorded.files).toContain("README.md");
    expect(recorded.base.artifactSha256)
      .toBe("9082739dd58186efce8c806f88972f4cb15adb55502e95f62647500672a5afac");
    // Phase 19 ledger-closure gate: no Unreviewed row may remain.
    expect(validateLedgerClosed(root).unreviewed).toBe(0);
  });
});
