import { describe, it, expect } from 'vitest';

import { GET } from '@/app/api/cowork/agent/manifest/route';

type ManifestEndpoint = { method?: string; path?: string; description?: string };

async function getManifest(): Promise<{ endpoints: Record<string, Record<string, ManifestEndpoint>> }> {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as { endpoints: Record<string, Record<string, ManifestEndpoint>> };
}

/** Flatten every declared endpoint group into a single list of entries. */
function flatten(manifest: { endpoints: Record<string, Record<string, ManifestEndpoint>> }): ManifestEndpoint[] {
  const out: ManifestEndpoint[] = [];
  for (const group of Object.values(manifest.endpoints)) {
    for (const entry of Object.values(group)) {
      if (entry && typeof entry.path === 'string' && typeof entry.method === 'string') {
        out.push(entry);
      }
    }
  }
  return out;
}

const endsWith = (p: string) => (e: ManifestEndpoint) => !!e.path && e.path.endsWith(p);

describe('agent contract manifest (drift guard)', () => {
  it('declares DELETE for the four destructive endpoints that have DELETE handlers', async () => {
    const manifest = await getManifest();
    const flat = flatten(manifest);

 // These routes implement a DELETE export, so the manifest MUST advertise it.
    for (const p of ['/api/cowork/history', '/api/cowork/memory/site', '/api/cowork/memory/form', '/api/cowork/ai/chat']) {
      expect(flat.filter(endsWith(p)).some((e) => e.method === 'DELETE')).toBe(true);
    }
  });

  it('does not disclose the ?all=1 mass-delete mechanism in the manifest (AU-3)', async () => {
    const manifest = await getManifest();
    const flat = flatten(manifest);
    const historyDelete = flat.find((e) => e.method === 'DELETE' && endsWith('/api/cowork/history')(e));
    expect(historyDelete).toBeDefined();
 // The manifest is a discovery surface; it must NOT reveal the destructive
 // ?all=1 bulk-delete capability (defense-in-depth against exposing
 // destructive/internal endpoints).
    expect(historyDelete?.description).not.toContain('all=1');

 // Token-agnostic backstop: renaming the bulk-delete param (e.g. `?all=true`,
 // `?purge=1`) or rephrasing the description must not reintroduce the disclosure.
 // Every DELETE endpoint's path and description is scanned (not only history), so
 // a future bulk-delete wording added to ai/chat, memory/site, or memory/form
 // also fails this guard. operatingRules are excluded so the required
 // mass-deletion confirmation wording survives.
    expect(historyDelete?.path ?? '').not.toContain('?');
    const bulkKeywords = /all=|purge|wipe|bulk|reset|delete-all|mass-delet/i;
    for (const e of flat.filter((e) => e.method === 'DELETE')) {
      expect(bulkKeywords.test(e.path ?? '')).toBe(false);
      expect(bulkKeywords.test(e.description ?? '')).toBe(false);
    }

 // The disclosure guard also applies to the operating rules, which are emitted
 // verbatim into the manifest. Scan the full serialized manifest for the
 // query-param-style mechanism tokens so any re-introduction fails this guard.
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('all=1');
    expect(serialized).not.toContain('delete-all');
  });

  it('forbids mass-deletion without confirmation in the operating rules', async () => {
    const manifest = await getManifest();
    const rules: string[] = (manifest as unknown as { operatingRules?: string[] }).operatingRules ?? [];
    expect(rules.some((r) => /mass-deletion|\?all=1|delete-all/.test(r))).toBe(true);
  });
});
