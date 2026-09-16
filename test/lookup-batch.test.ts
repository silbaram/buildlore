import { describe, expect, it } from 'vitest';
import { knowledgeReaderLookupBatch, LookupBatchError } from '../src/compiler/project-knowledge/lookup-batch.js';
import { knowledgeReaderLookup } from '../src/compiler/project-knowledge/reader-surface.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { digest } from '../src/knowledge/project-knowledge/guards.js';
import { fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';
import { connectedFixture } from './helpers/connected-fixture.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { readConnectedWiki } from '../src/application/wiki-read-service.js';
import { withReadCancellation } from '../src/application/read-cancellation.js';
import { parseReadTool } from '../src/mcp/requests.js';
import { parseCliArguments } from '../src/cli/parser.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import type { ReadMeasurement } from '../src/retrieval/read-observer.js';

async function fixture() {
  const snapshot = await knowledgeFixtureSnapshot(), proposal = fixtureProposal(snapshot);
  return createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, 'knowledge-markdown-v2');
}
describe('bounded canonical lookup', () => {
  it.each(['evidence', 'fact'] as const)('returns complete %s results once in first-seen order with exact bytes', async kind => {
    const g = await fixture();
    const ids = kind === 'evidence' ? g.evidence.map(e => e.evidenceId) : g.records.map(f => f.id);
    const input = [...ids].reverse().concat(ids);
    const before = JSON.stringify(g), batch = knowledgeReaderLookupBatch(g, kind, input);
    expect(batch.items).toEqual([...new Set(input)].map(id => ({ id, result: knowledgeReaderLookup(g, kind, id).result })));
    expect(batch.requestedCount).toBe(input.length); expect(batch.uniqueCount).toBe(ids.length);
    expect(batch.budget.usedBytes).toBe(Buffer.byteLength(JSON.stringify(batch) + '\n'));
    expect(JSON.stringify(g)).toBe(before);
    expect(() => knowledgeReaderLookupBatch(g, kind, [...ids, digest('missing')])).toThrow();
    expect(() => knowledgeReaderLookupBatch(g, kind, Array.from({ length: 17 }, () => ids[0] ?? digest('empty')))).toThrow();
    expect(knowledgeReaderLookupBatch(g, kind, Array.from({ length: 16 }, () => ids[0] ?? digest('empty'))))
      .toMatchObject({ requestedCount: 16, uniqueCount: 1 });
  });
  it('accounts for multibyte evidence and budget digits without truncation', async () => {
    const g = await fixture(), first = g.evidence[0]; if (!first) throw new Error('Missing evidence');
    // Pure projection fixture; the production reader separately screens and authenticates it.
    const large = { ...g, evidence: [{ ...first, excerpt: '한글🙂'.repeat(700) }] };
    const roomy = knowledgeReaderLookupBatch(large, 'evidence', [first.evidenceId], { maxBytes: 10000 });
    let exact = roomy.budget.usedBytes;
    for (;;) {
      try {
        const result = knowledgeReaderLookupBatch(large, 'evidence', [first.evidenceId], { maxBytes: exact });
        if (result.budget.usedBytes === exact) break;
        exact = result.budget.usedBytes;
      } catch (error) { if (!(error instanceof LookupBatchError)) throw error; exact = error.requiredBytes; }
    }
    expect(() => knowledgeReaderLookupBatch(large, 'evidence', [first.evidenceId], { maxBytes: exact - 1 })).toThrow(LookupBatchError);
    expect(knowledgeReaderLookupBatch(large, 'evidence', [first.evidenceId], { maxBytes: exact }).items[0]?.result).toEqual(knowledgeReaderLookup(large, 'evidence', first.evidenceId).result);
    for (const maxBytes of [2047, 65537, 1.5, NaN, Infinity]) expect(() => knowledgeReaderLookupBatch(g, 'evidence', [first.evidenceId], { maxBytes })).toThrow();
    expect(() => { Reflect.apply(knowledgeReaderLookupBatch, undefined, [g, 'evidence', [first.evidenceId], { maxBytes: null }]); }).toThrow();
  });
  it('rejects ambiguous and unbounded CLI/MCP inputs', () => {
    const id = digest('id'), generation = digest('generation');
    const base = { kind: 'evidence', expectedGeneration: generation };
    for (const extra of [{}, { ids: [] }, { id, ids: [id] }, { id, maxBytes: 2048 }, { ids: [id], maxBytes: 1 },
      { ids: Array.from({ length: 17 }, () => id) }, { ids: ['invalid'] }, { ids: [id], projectId: 'other' }]) {
      expect(() => parseReadTool('lookup', { ...base, ...extra })).toThrow();
    }
    const args = ['wiki', 'lookup', '--project', 'parcel', '--kind', 'evidence', '--expect-generation', generation];
    for (const extra of [[], ['--ids', ''], ['--ids', id + ','], ['--ids', id + ', ' + id], ['--id', id, '--ids', id],
      ['--id', id, '--max-bytes', '2048'], ['--ids', id, '--max-bytes', '1'], ['--ids', id, '--ids', id]]) {
      expect(() => parseCliArguments([...args, ...extra])).toThrow();
    }
    expect(parseReadTool('lookup', { ...base, ids: [id, id] })).toMatchObject({ ids: [id, id] });
    expect(() => parseCliArguments([...args, '--ids', id + ',' + id])).not.toThrow();
  });
  it('shares validation within a batch but checks policy again on the next request', async () => {
    const f = await connectedFixture(true);
    try {
      const events: ReadMeasurement[] = [];
      const reader = createKnowledgeWikiReader(f.knowledgeRoot, { observer: event => events.push(event) });
      const page = await reader.read(f.projectId, 'overview'); if (!page?.evidence[0]) throw new Error('Missing evidence');
      const id = page.evidence[0].evidenceId, generation = page.generationDigest;
      events.length = 0;
      const batch = await reader.lookupBatch(f.projectId, generation, 'evidence', [id, id]);
      expect(events.filter(e => e.phase === 'policy')).toHaveLength(1);
      expect(events.filter(e => e.phase === 'publication')).toHaveLength(1);
      for (const event of events) { expect(Object.keys(event).sort()).toEqual(['count', 'durationMs', 'phase']); expect(event.durationMs).toBeGreaterThanOrEqual(0); }
      expect(batch.items[0]?.result).toEqual((await reader.lookup(f.projectId, generation, 'evidence', id)).result);
      const throwing = createKnowledgeWikiReader(f.knowledgeRoot, { observer: () => { throw new Error('Observer'); } });
      expect(await throwing.lookupBatch(f.projectId, generation, 'evidence', [id, id])).toEqual(batch);
      expect((await f.cli(['wiki', 'lookup', '--project', f.projectId, '--kind', 'evidence', '--ids', id + ',' + id,
        '--expect-generation', generation])).data).toEqual(batch);
      await expect(readConnectedWiki(f.context, { operation: 'lookup', kind: 'evidence', ids: [id], expectedGeneration: digest('stale') })).rejects.toMatchObject({ code: 'GENERATION_CHANGED' });
      await expect(reader.lookupBatch('other', generation, 'evidence', [id])).rejects.toThrow();
      const controller = new AbortController(); controller.abort();
      await expect(withReadCancellation(controller.signal, () => reader.lookupBatch(f.projectId, generation, 'evidence', [id]))).rejects.toThrow();
      await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: [] });
      await expect(reader.lookupBatch(f.projectId, generation, 'evidence', [id])).rejects.toThrow();
    } finally { await f.cleanup(); }
  }, 30000);
});
