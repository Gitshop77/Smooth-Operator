import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/server/errors";
import { callBatchTool, callTool, callVisualTool, jsonResource, safeResourceRead, sanitizeMcpOutput } from "@/server/envelope";

describe("MCP envelope helpers", () => {
  it("serializes tool success and bounds tool failures", async () => {
    const success = await callTool(async () => ({ ok: true, value: 1 }));
    expect(success.isError).not.toBe(true);
    expect(success.structuredContent).toEqual({ ok: true, value: 1 });
    const text = success.content.find((item) => item.type === "text");
    expect(text && "text" in text ? JSON.parse(text.text) : undefined).toEqual(success.structuredContent);

    const failure = await callTool(async () => {
      throw new AppError("INVALID_ARGUMENT", "bad");
    });
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("keeps logging failures from changing the protocol error path", async () => {
    const logger = { logger: { warn: () => {
      throw new Error("log sink failed");
    } } } as unknown as Parameters<typeof callTool>[1];
    const result = await callTool(async () => {
      throw new Error("tool failed");
    }, logger);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });

  it("preserves batch results through the batch envelope", async () => {
    const result = await callBatchTool(async () => ({ results: [{ ok: true }, { ok: true }] }));
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { results: unknown[] }).results).toHaveLength(2);
    const failed = await callBatchTool(async () => {
      throw new AppError("SCRIPT_INVALID", "bad batch");
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ ok: false, error: { code: "SCRIPT_INVALID" } });
  });

  it("returns screenshots as MCP image content and rejects oversized images", async () => {
    const ok = await callVisualTool(async () => ({ screenshotBase64: "aGVsbG8=", mimeType: "image/jpeg", ok: true }));
    expect(ok.isError).not.toBe(true);
    expect(ok.content).toEqual(expect.arrayContaining([
      { type: "text", text: expect.any(String) },
      { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
    ]));
    const tooLarge = await callVisualTool(async () => ({ screenshotBase64: "A".repeat(12_000_000), mimeType: "image/png" }));
    expect(tooLarge.isError).toBe(true);
    expect(tooLarge.structuredContent).toMatchObject({ ok: false, error: { code: "OUTPUT_TOO_LARGE" } });
  });

  it("wraps resource failures without leaking filesystem paths", async () => {
    const resource = jsonResource("smooth-operator://server/capabilities", { ok: true });
    expect(resource.contents[0]?.uri).toBe("smooth-operator://server/capabilities");
    expect(JSON.parse(resource.contents[0]?.text ?? "")).toEqual({ ok: true });
    const warn = vi.fn();
    await expect(safeResourceRead(async () => {
      throw new Error("ENOENT /secret/path");
    }, { logger: { warn } } as unknown as Parameters<typeof safeResourceRead>[1])).rejects.toMatchObject({ message: expect.stringContaining("could not be read") });
    expect(warn).toHaveBeenCalled();
  });

  it("marks truncation when a payload exceeds the MCP record budget", () => {
    const bounded = sanitizeMcpOutput({ text: "x".repeat(40_000) }) as Record<string, unknown>;
    expect(bounded.truncated === true || bounded.mcpOutputTruncated === true).toBe(true);
    const oversized = sanitizeMcpOutput({
      pageId: "page-1",
      blob: "y".repeat(40_000),
      extra: "z".repeat(40_000),
    }) as Record<string, unknown>;
    expect(oversized.mcpOutputTruncated).toBe(true);
    expect(oversized.omittedFields).toEqual(expect.arrayContaining(["blob", "extra"]));
  });
});
