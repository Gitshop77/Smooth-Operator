import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BrowserService } from "@/server/browser/service";
import { Logger } from "@/server/logger";
import { SecurityPolicy } from "@/server/policy";
import { testConfig } from "./helpers";

describe("upload filesystem boundary", () => {
  it.each(["directory", "symlink"] as const)("rejects a %s source before staging", async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-upload-source-"));
    const source = join(directory, "source");
    const config = testConfig({ dataDir: directory, security: { ...testConfig().security, allowedFileRoots: [directory] } });
    const service = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
    const internal = service as unknown as { stageUploadFile(path: string): Promise<unknown> };
    try {
      if (kind === "directory") await mkdir(source);
      else await symlink(directory, source, "junction");
      await expect(internal.stageUploadFile(source)).rejects.toMatchObject({ code: "FILE_PATH_BLOCKED" });
      expect(await readdir(directory)).toEqual(["source"]);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-upload-fifo-"));
    const source = join(directory, "pipe");
    const config = testConfig({ dataDir: directory, security: { ...testConfig().security, allowedFileRoots: [directory] } });
    const service = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
    try {
      execFileSync("mkfifo", [source]);
      const internal = service as unknown as { stageUploadFile(path: string): Promise<unknown> };
      await expect(internal.stageUploadFile(source)).rejects.toMatchObject({ code: "FILE_PATH_BLOCKED" });
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not copy upload bytes through a staging-directory symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-upload-staging-"));
    const outside = await mkdtemp(join(tmpdir(), "smooth-upload-outside-"));
    const source = join(directory, "source.txt");
    const config = testConfig({ dataDir: directory, security: { ...testConfig().security, allowedFileRoots: [directory] } });
    const service = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
    try {
      await writeFile(source, "private upload content");
      await symlink(outside, join(directory, "upload-staging"), "junction");
      const internal = service as unknown as { stageUploadFile(path: string): Promise<unknown> };
      await expect(internal.stageUploadFile(source)).rejects.toMatchObject({ code: "FILE_PATH_BLOCKED" });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a staging directory readable by other users", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-upload-permissions-"));
    const staging = join(directory, "upload-staging");
    const source = join(directory, "source.txt");
    const config = testConfig({ dataDir: directory, security: { ...testConfig().security, allowedFileRoots: [directory] } });
    const service = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
    try {
      await writeFile(source, "private upload content");
      await mkdir(staging);
      await chmod(staging, 0o755);
      const internal = service as unknown as { stageUploadFile(path: string): Promise<unknown> };
      await expect(internal.stageUploadFile(source)).rejects.toMatchObject({ code: "FILE_PATH_BLOCKED" });
      expect(await readdir(staging)).toEqual([]);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
