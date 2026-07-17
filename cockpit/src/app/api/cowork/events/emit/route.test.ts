/**
 * SERVER_OWNED_CHANNELS drift test.
 *
 * The cockpit `events/emit` HTTP ingress and the cowork-events mini-service's
 * socket ingress both enforce the SAME impersonation boundary: a caller holding
 * a valid `X-Cowork-Token` must not be able to emit server-owned status/chat
 * streams. The cockpit route hardcodes its deny-list and a comment instructs it
 * be kept in sync with the mini-service's `SERVER_OWNED_CHANNELS`. This test
 * fails the build if the two sets drift, so a channel added on one side only
 * (silently weakening the boundary) is caught.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

// Mock the broadcast so no real socket.io hop is made; this isolates the
// POST validation/security boundary in the cockpit route. The drift test
// below reads the route source from disk and does not depend on this mock.
const { broadcastEvent } = vi.hoisted(() => ({ broadcastEvent: vi.fn() }));
vi.mock('@/lib/cowork/events/client', () => ({
  broadcastEvent,
}));

import { POST } from '@/app/api/cowork/events/emit/route';

function reqWithBody(body: unknown): any {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(bytes);
      ctrl.close();
    },
  });
  return { body: stream, headers: new Headers() };
}

afterEach(() => {
  broadcastEvent.mockReset();
});

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo root is 7 levels up from .../cockpit/src/app/api/cowork/events/emit
const repoRoot = join(__dirname, '..', '..', '..', '..', '..', '..', '..');
const cockpitEmitRoute = join(__dirname, 'route.ts');
const miniService = join(repoRoot, 'mini-services', 'cowork-events', 'index.ts');

// Extract the channel strings from a `SERVER_OWNED_CHANNELS = new Set([...])`
// literal (with or without a `<string>` generic).
function extractChannels(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/SERVER_OWNED_CHANNELS = new Set(?:<[^>]*>)?\(\[([\s\S]*?)\]\)/);
  expect(m, `could not find SERVER_OWNED_CHANNELS in ${file}`).not.toBeNull();
  const body = m![1];
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

describe('SERVER_OWNED_CHANNELS stays in sync with the mini-service', () => {
  it('cockpit emit deny-list matches the mini-service deny-list', () => {
    const cockpit = extractChannels(cockpitEmitRoute);
    const mini = extractChannels(miniService);
    expect(cockpit).toEqual(mini);
  });
});

describe('POST /api/cowork/events/emit (impersonation boundary)', () => {
  it('rejects a server-owned channel with 400', async () => {
    const res = await POST(reqWithBody({ channel: 'chat:message', payload: { x: 1 } }));
    expect(res.status).toBe(400);
    expect(broadcastEvent).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('channel is reserved for server-originated events');
  });

  it('rejects a channel with control characters with 400', async () => {
    const res = await POST(reqWithBody({ channel: 'a\x01b', payload: {} }));
    expect(res.status).toBe(400);
    expect(broadcastEvent).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('channel contains invalid characters');
  });

  it('rejects a 129-char channel with 400', async () => {
    const res = await POST(reqWithBody({ channel: 'c'.repeat(129), payload: {} }));
    expect(res.status).toBe(400);
    expect(broadcastEvent).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('channel must be at most 128 chars');
  });

  it('rejects a payload larger than 64KB serialized with 400', async () => {
    const res = await POST(reqWithBody({ channel: 'custom:evt', payload: { big: 'x'.repeat(100_000) } }));
    expect(res.status).toBe(400);
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it('broadcasts a valid channel+payload (200)', async () => {
    broadcastEvent.mockResolvedValue({ ok: true, id: '1', channel: 'custom:evt' });
    const res = await POST(reqWithBody({ channel: 'custom:evt', payload: { a: 1 } }));
    expect(res.status).toBe(200);
    expect(broadcastEvent).toHaveBeenCalledWith('custom:evt', { a: 1 });
  });

  it('redacts secret shapes from the broadcast payload', async () => {
    broadcastEvent.mockResolvedValue({ ok: true, id: '1', channel: 'custom:evt' });
    const res = await POST(
      reqWithBody({
        channel: 'custom:evt',
        payload: {
          headers: { Authorization: 'Bearer tok-0123456789ABCDEF' },
          note: 'key sk-ant-SECRET0123456789ABCDEF',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const sent = broadcastEvent.mock.calls[0][1] as {
      headers: { Authorization: string };
      note: string;
    };
    expect(sent.headers.Authorization).toBe('Bearer ***');
    expect(sent.note).not.toContain('sk-ant-SECRET0123456789ABCDEF');
    expect(JSON.stringify(sent)).toContain('***');
  });

  it('returns 500 and never echoes the upstream error on broadcast failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const upstreamDetail = 'upstream exploded with sk-ant-SECRET0123456789ABCDEF';
    broadcastEvent.mockResolvedValue({ ok: false, error: upstreamDetail });
    const res = await POST(reqWithBody({ channel: 'custom:evt', payload: { a: 1 } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('sk-ant-SECRET0123456789ABCDEF');
    expect(JSON.stringify(body)).not.toContain(upstreamDetail);
    const redactedCall = errorSpy.mock.calls.find(
      (c) => typeof c[1] === 'object' && c[1] !== null && (c[1] as { error?: unknown }).error !== undefined,
    );
    expect(redactedCall).toBeTruthy();
    const logged = (redactedCall![1] as { error: string }).error;
    expect(logged).toContain('***');
    expect(logged).not.toContain('sk-ant-SECRET0123456789ABCDEF');
    errorSpy.mockRestore();
  });
});
