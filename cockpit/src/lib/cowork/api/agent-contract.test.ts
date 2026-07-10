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

describe('agent contract manifest (F-8 drift guard)', () => {
  it('declares DELETE for the four destructive endpoints that have DELETE handlers', async () => {
    const manifest = await getManifest();
    const flat = flatten(manifest);

    // These routes implement a DELETE export, so the manifest MUST advertise it.
    expect(flat.filter(endsWith('/api/cowork/history')).some((e) => e.method === 'DELETE')).toBe(true);
    expect(flat.filter(endsWith('/api/cowork/memory/site')).some((e) => e.method === 'DELETE')).toBe(true);
    expect(flat.filter(endsWith('/api/cowork/memory/form')).some((e) => e.method === 'DELETE')).toBe(true);
    expect(flat.filter(endsWith('/api/cowork/ai/chat')).some((e) => e.method === 'DELETE')).toBe(true);
  });

  it('documents the ?all=1 mass-delete capability on /history', async () => {
    const manifest = await getManifest();
    const flat = flatten(manifest);
    const historyDelete = flat.find((e) => e.method === 'DELETE' && endsWith('/api/cowork/history')(e));
    expect(historyDelete).toBeDefined();
    expect(historyDelete?.description).toContain('all=1');
  });

  it('forbids mass-deletion without confirmation in the operating rules', async () => {
    const manifest = await getManifest();
    const rules: string[] = (manifest as unknown as { operatingRules?: string[] }).operatingRules ?? [];
    expect(rules.some((r) => /mass-deletion|\?all=1|delete-all/.test(r))).toBe(true);
  });
});
