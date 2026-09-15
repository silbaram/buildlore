import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { knowledgeTaskMemory, TaskMemoryError } from '../src/compiler/project-knowledge/task-memory.js';
import { knowledgeDevelopmentMemory } from '../src/compiler/project-knowledge/reader-memory.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { digest, record } from '../src/knowledge/project-knowledge/guards.js';
import type { KnowledgeGenerationV1 } from '../src/knowledge/project-knowledge/types.js';
import { fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';

async function fixture(): Promise<KnowledgeGenerationV1> {
  const snapshot = await knowledgeFixtureSnapshot(); const proposal = fixtureProposal(snapshot);
  return createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, 'knowledge-markdown-v2');
}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) + '\n');

import { knowledgeProgressiveMemory as project, validateProgressiveMemoryRequest, ProgressiveMemoryError } from '../src/compiler/project-knowledge/progressive-memory.js';

describe('progressive original claim memory', () => {
  it('preserves original claims and registry closure, legacy projections and input bytes', async () => {
    const g = await fixture(), before = JSON.stringify(g), full = knowledgeDevelopmentMemory(g);
    const legacy = knowledgeTaskMemory(g, { task: 'parcel' });
    const m = project(g, { task: 'parcel', maxBytes: 65536 });
    expect(m.units.length).toBe(3);
    for (const u of m.units) {
      expect(u.claim).toEqual(full.pages[u.pageIndex]?.sections[u.sectionIndex]?.claims[u.claimIndex]);
      for (const f of u.claim.facts) {
        expect(m.facts[f]).toEqual(full.facts[f]);
        for (const e of m.facts[f]?.[6] ?? []) {
          expect(m.evidence[e]).toEqual(full.evidence[e]);
          const tuple = m.evidenceContext.values[m.evidenceContext.aliases[e] ?? ''];
          expect(Object.fromEntries(m.evidenceContext.fields.map((key, n) => [key, tuple?.[n]]))).toEqual(full.evidenceContext[e]);
          const source = m.evidence[e]?.[1] ?? ''; expect(m.sources[source]).toEqual(full.sources[source]);
        }
      }
    }
    expect(bytes(m)).toBe(m.budget.serializedBytes);
    const { memoryDigest, ...basis } = m; expect(memoryDigest).toBe(digest(basis));
    expect(JSON.stringify(g)).toBe(before); expect(knowledgeDevelopmentMemory(g)).toEqual(full);
    expect(knowledgeTaskMemory(g, { task: 'parcel' })).toEqual(legacy);
    const schema = record(JSON.parse(await readFile('schemas/project-knowledge-reader.schema.json', 'utf8')));
    expect(Object.keys(m).sort()).toEqual((record(record(schema.$defs).progressiveMemory).required as string[]).toSorted());
  });
  it('retains historical/current evidence context and deduplicates identical context tuples', async () => {
    const g = await fixture();
    const oldId = Object.values(knowledgeDevelopmentMemory(g).evidence)[0]?.[0];
    const changed = { ...g, snapshot: { ...g.snapshot, evidence: g.snapshot.evidence.filter(e => e.evidenceId !== oldId) } };
    const full = knowledgeDevelopmentMemory(changed), m = project(changed, { task: 'parcel', maxBytes: 65536 });
    for (const e of Object.keys(m.evidence)) {
      const tuple = m.evidenceContext.values[m.evidenceContext.aliases[e] ?? ''];
      expect(Object.fromEntries(m.evidenceContext.fields.map((k, i) => [k, tuple?.[i]]))).toEqual(full.evidenceContext[e]);
    }
    expect(Object.values(m.evidenceContext.values).some(v => !v[0])).toBe(true);
    expect(Object.keys(m.evidenceContext.values).length).toBeLessThanOrEqual(Object.keys(m.evidence).length);
  });
  it('walks bounded cursors in rank order with no duplicate or missing original claims', async () => {
    const g = await fixture();
    const large = { ...g, pages: g.pages.map(p => ({ ...p, sections: p.sections.map(s => ({ ...s,
      claims: Array.from({ length: 6 }, (_, i) => ({ ...(s.claims[0] ?? (() => { throw new Error('Missing claim'); })()), claimId: `claim-${String(i)}`,
        text: 'parcel 조건과 예외 '.repeat(50) + String(i) })) })) })) };
    const expected = project(large, { task: 'parcel', maxBytes: 65536 }).units;
    const actual = []; let cursor: string | undefined;
    for (let reads = 0; ; reads++) {
      expect(reads).toBeLessThan(30);
      const m = project(large, { task: 'parcel', ...(cursor ? { cursor } : {}) });
      expect(bytes(m)).toBeLessThanOrEqual(8192); expect(m.units.length).toBeGreaterThan(0);
      expect(m.coverage.oversizedClaims).toBe(0); expect(m.units.every(u => u.partialSection)).toBe(true);
      actual.push(...m.units.map(u => [u.pageIndex, u.sectionIndex, u.claimIndex, u.claim]));
      if (!m.recovery.nextCursor) break;
      cursor = m.recovery.nextCursor;
    }
    expect(actual).toEqual(expected.map(u => [u.pageIndex, u.sectionIndex, u.claimIndex, u.claim]));
    if (!cursor) throw new Error('Expected continuation');
    for (const changed of [{ ...large, projectId: 'other-project' }, { ...large, generationDigest: digest('new') }]) {
      expect(() => project(changed, { task: 'parcel', cursor })).toThrow();
    }
    expect(() => project(large, { task: 'different', cursor })).toThrow(ProgressiveMemoryError);
    expect(() => project(large, { task: 'parcel', cursor: cursor + 'x' })).toThrow(ProgressiveMemoryError);
  });
  it('recovers oversized original claims, with explicit replay and maximum-budget fallback', async () => {
    const g = await fixture();
    const changed = { ...g, pages: g.pages.map((p, n) => ({ ...p, sections: p.sections.map(s => ({ ...s,
      claims: s.claims.map(c => ({ ...c, text: n === 0 ? 'parcel 조건 '.repeat(1500) + 'except archived.' : c.text })) })) })) };
    const m = project(changed, { task: 'parcel' });
    expect(m.coverage.oversizedClaims).toBe(1); expect(m.units.length).toBeGreaterThan(0);
    const r = m.recovery.oversized; if (!r) throw new Error('Expected recovery');
    const recovered = project(changed, { task: 'parcel', cursor: r.cursor, maxBytes: r.requiredBytes });
    expect(recovered.recovery.replay).toBe(true);
    expect(recovered.units[0]?.claim.text).toMatch(/except archived\.$/u);
    const huge = { ...changed, pages: changed.pages.map(p => ({ ...p, sections: p.sections.map(s => ({ ...s,
      claims: s.claims.map(c => ({ ...c, text: 'parcel '.repeat(20000) })) })) })) };
    const all = project(huge, { task: 'parcel' });
    expect(all.units).toEqual([]); expect(all.coverage).toMatchObject({ outcome: 'budget_limited', oversizedClaims: 3 });
    expect(all.recovery.nextCursor).toBeNull(); expect(all.recovery.oversized?.exceedsMaximum).toBe(true);
  });
  it('honors exact UTF-8 boundaries, normalized task ranking and empty/invalid requests', async () => {
    const g = await fixture(), all = project(g, { task: 'parcel', maxBytes: 65536 });
    let limit = all.budget.serializedBytes, m = all;
    for (let i = 0; i < 3; i++) { m = project(g, { task: 'parcel', maxBytes: limit }); limit = m.budget.serializedBytes; }
    expect(bytes(m)).toBe(limit); expect(m.units.length).toBe(3);
    const less = project(g, { task: 'parcel', maxBytes: limit - 1 });
    expect(bytes(less)).toBeLessThanOrEqual(limit - 1); expect(less.units.length).toBeLessThan(3);
    expect(project(g, { task: 'zzzzzz' }).coverage.outcome).toBe('no_match');
    expect(() => project(g, { task: 'parcel', maxBytes: 2048 })).toThrow('PROGRESSIVE_MEMORY_BUDGET_TOO_SMALL');
    expect(() => validateProgressiveMemoryRequest({ task: 'parcel', cursor: 'invalid' })).toThrow(ProgressiveMemoryError);
    expect(() => project(g, { task: '' })).toThrow(TaskMemoryError);
    expect(() => project(g, { task: 'parcel', maxBytes: 65537 })).toThrow(TaskMemoryError);
    const changed = { ...g, pages: g.pages.map((p, i) => ({ ...p, title: i === 1 ? '배포 CAFÉ' : 'Other',
      sections: p.sections.map(s => ({ ...s, title: 'Context', claims: s.claims.map(c => ({ ...c,
        text: i === 0 ? '배포 only after checks; except archived work.' : 'Other conditions.' })) })) })) };
    expect(project(changed, { task: '배포', maxBytes: 65536 }).units.map(u => u.pageIndex)).toEqual([1, 0]);
    expect(project(changed, { task: '  CAFÉ  ' })).toEqual(project(changed, { task: 'CAFÉ' }));
    expect(project(g, { task: 'parcel parcel' }).units).toEqual(project(g, { task: 'parcel' }).units);
  });
});
