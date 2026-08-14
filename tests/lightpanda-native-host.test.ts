// tests/lightpanda-native-host.test.ts
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

// NOTE: fileURLToPath(new URL("../scripts/...", import.meta.url)) THROWS under
// vitest v4 ("The URL must be of scheme file") — vitest transforms
// import.meta.url. Resolve from the repo root (process.cwd()) instead.
const HOST = join(process.cwd(), "scripts", "lightpanda-native-host.mjs");

function frame(obj: unknown): Buffer {
  const j = Buffer.from(JSON.stringify(obj), "utf8");
  const h = Buffer.alloc(4);
  h.writeUInt32LE(j.length, 0);
  return Buffer.concat([h, j]);
}

interface TestHost {
  proc: ChildProcess;
  send(obj: unknown): void;
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

function startHost(): TestHost {
  const proc = spawn(process.execPath, [HOST], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = Buffer.alloc(0);
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  proc.stdout!.on("data", (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const m = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      buf = buf.subarray(4 + len);
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    }
  });
  return {
    proc,
    send(obj) { proc.stdin!.write(frame(obj)); },
    next(timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no host message within timeout")), timeoutMs);
        const handle = (m: Record<string, unknown>) => { clearTimeout(t); resolve(m); };
        if (queue.length) handle(queue.shift()!);
        else waiters.push(handle);
      });
    },
    close() { proc.kill("SIGTERM"); },
  };
}

describe("lightpanda native host protocol", () => {
  it("answers ping with pong", async () => {
    const host = startHost();
    host.send({ id: 1, type: "ping" });
    await expect(host.next()).resolves.toMatchObject({ id: 1, type: "pong" });
    host.close();
  });

  it("streams stdout/stderr and reports exitCode", async () => {
    const host = startHost();
    host.send({
      id: "a1",
      type: "agent",
      binary: process.execPath,
      args: ["-e", "console.log('hello'); console.error('$usage prompt=1 completion=2 total=3 cached=0 cache_creation=0');"],
    });
    const chunks: string[] = [];
    let done: Record<string, unknown> | undefined;
    for (let i = 0; i < 3; i++) {
      const m = await host.next();
      if (m.type === "chunk") chunks.push(String(m.data ?? ""));
      if (m.type === "done") done = m;
    }
    expect(done?.exitCode).toBe(0);
    expect(chunks.join("")).toContain("hello");
    expect(chunks.join("")).toContain("$usage prompt=1");
    host.close();
  });

  it("serves sequential runs (host is not one-shot)", async () => {
    const host = startHost();
    host.send({ id: "s1", type: "agent", binary: process.execPath, args: ["-e", "console.log('first')"] });
    let done1: Record<string, unknown> | undefined;
    for (let i = 0; i < 3; i++) {
      const m = await host.next();
      if (m.type === "done") { done1 = m; break; }
    }
    expect(done1?.exitCode).toBe(0);
    host.send({ id: "s2", type: "agent", binary: process.execPath, args: ["-e", "console.log('second')"] });
    let done2: Record<string, unknown> | undefined;
    for (let i = 0; i < 3; i++) {
      const m = await host.next();
      if (m.type === "done") { done2 = m; break; }
    }
    expect(done2?.exitCode).toBe(0);
    host.close();
  });

  it("kills on cancel (exactly one terminal message)", async () => {
    const host = startHost();
    // The child must emit SOMETHING first — awaiting host.next() on a silent
    // child would hang until the 10s test timeout.
    host.send({ id: "c1", type: "agent", binary: process.execPath, args: ["-e", "console.log('ready'); setInterval(()=>{},1000)"], timeoutMs: 60000 });
    await expect(host.next()).resolves.toMatchObject({ id: "c1", type: "chunk" });
    host.send({ id: "c1", type: "cancel" });
    await expect(host.next()).resolves.toMatchObject({ id: "c1", type: "cancelled" });
    host.close();
  });

  it("enforces the timeout", async () => {
    const host = startHost();
    // Silent child is fine here: the 1s host timeout produces the done message.
    host.send({ id: "t1", type: "agent", binary: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 1000 });
    const m = await host.next(15_000);
    expect(m.id).toBe("t1");
    expect(m.type === "done" && (m as { timeout?: boolean }).timeout).toBe(true);
    host.close();
  });

  it("rejects non-whitelisted env keys", async () => {
    const host = startHost();
    host.send({ id: "e1", type: "agent", binary: process.execPath, args: ["-e", "console.log(process.env.SECRET_KEY || 'none')"], env: { SECRET_KEY: "leak", OPENAI_API_KEY: "ok" } });
    const chunks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await host.next();
      if (m.type === "chunk") chunks.push(String(m.data ?? ""));
      if (m.type === "done") break;
    }
    expect(chunks.join("")).toContain("none");
    expect(chunks.join("")).not.toContain("leak");
    host.close();
  });

  it("rejects an agent request while busy", async () => {
    const host = startHost();
    host.send({ id: "b1", type: "agent", binary: process.execPath, args: ["-e", "console.log('ready'); setInterval(()=>{},1000)"], timeoutMs: 60000 });
    await expect(host.next()).resolves.toMatchObject({ id: "b1", type: "chunk" });
    host.send({ id: "b2", type: "agent", binary: process.execPath, args: ["-e", "console.log('x')"] });
    await expect(host.next()).resolves.toMatchObject({ id: "b2", type: "error" });
    host.send({ id: "b1", type: "cancel" });
    await expect(host.next()).resolves.toMatchObject({ id: "b1", type: "cancelled" });
    host.close();
  });

  it("rejects unknown message types", async () => {
    const host = startHost();
    host.send({ id: "u1", type: "wat" });
    await expect(host.next()).resolves.toMatchObject({ id: "u1", type: "error" });
    host.close();
  });
});
