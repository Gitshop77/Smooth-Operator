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

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

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
