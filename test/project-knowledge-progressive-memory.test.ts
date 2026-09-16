import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { knowledgeTaskMemory, TaskMemoryError } from '../src/compiler/project-knowledge/task-memory.js';
import { knowledgeDevelopmentMemory } from '../src/compiler/project-knowledge/reader-memory.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { digest, record } from '../src/knowledge/project-knowledge/guards.js';
import type { KnowledgeGenerationV1 } from '../src/knowledge/project-knowledge/types.js';
import { fixtureFact, fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';

async function fixture(): Promise<KnowledgeGenerationV1> {
  const snapshot = await knowledgeFixtureSnapshot(); const proposal = fixtureProposal(snapshot);
  return createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, 'knowledge-markdown-v2');
}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) + '\n');

import { knowledgeProgressiveMemory as project, validateProgressiveMemoryRequest, ProgressiveMemoryError } from '../src/compiler/project-knowledge/progressive-memory.js';

function legacyCursor(g: KnowledgeGenerationV1, position = 0): string {
  return `pwm1:n:${String(position)}:${digest({ projectId: g.projectId, generationDigest: g.generationDigest,
    task: 'parcel', position, mode: 'n' })}`;
}

async function repeatedFixture(): Promise<KnowledgeGenerationV1> {
  const g = await fixture(), page = g.pages[0], section = page?.sections[0], claim = section?.claims[0];
  if (!page || !section || !claim) throw new Error('Missing fixture claim');
  return { ...g, pages: [{ ...page, sections: [{ ...section,
    claims: Array.from({ length: 8 }, (_, i) => ({ ...claim, claimId: `claim-${String(i)}`,
      text: 'parcel 条件と例外 '.repeat(35) + (i < 6 ? 'repeat' : `distinct-${String(i)}`) })) }] }] };
}

describe('progressive distinct claim priority', () => {
  it('defers exact repetitions without deleting them and improves bounded distinct coverage', async () => {
    const g = await repeatedFixture(), before = JSON.stringify(g);
    const all = project(g, { task: 'parcel', maxBytes: 65536 });
    expect(all.selectionStrategy).toBe('lexical-claim-v2');
    expect(all.units.map(u => u.claimIndex)).toEqual([0, 6, 7, 1, 2, 3, 4, 5]);
    const first = project(g, { task: 'parcel' });
    const legacy = project(g, { task: 'parcel', cursor: legacyCursor(g) });
    expect(new Set(first.units.map(u => u.claim.text)).size).toBeGreaterThan(new Set(legacy.units.map(u => u.claim.text)).size);
    expect(legacy.selectionStrategy).toBe('lexical-claim-v1');
    expect(legacy.units.map(u => u.claimIndex)).toEqual(legacy.units.map((_, i) => i));
    for (const initialCursor of [undefined, legacyCursor(g)]) {
      const actual = []; let cursor = initialCursor;
      for (let reads = 0; ; reads++) {
        expect(reads).toBeLessThan(20);
        const result = project(g, { task: 'parcel', ...(cursor ? { cursor } : {}), maxBytes: reads % 2 ? 10000 : 8192 });
        expect(result.coverage.oversizedClaims).toBe(0);
        expect(bytes(result)).toBeLessThanOrEqual(result.budget.maxBytes);
        actual.push(...result.units.map(u => u.claimIndex));
        if (!result.recovery.nextCursor) break;
        cursor = result.recovery.nextCursor;
        expect(cursor.startsWith(initialCursor ? 'pwm1:' : 'pwm2:')).toBe(true);
      }
      expect(actual).toEqual(initialCursor ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 6, 7, 1, 2, 3, 4, 5]);
    }
    expect(JSON.stringify(g)).toBe(before);
  });
  it('keeps identical wording in different pages and sections distinct', async () => {
    const g = await fixture();
    const changed = { ...g, pages: g.pages.map(p => ({ ...p,
      sections: Array.from({ length: 2 }, () => ({ ...p.sections[0], title: 'Context',
        claims: [0, 1].map(i => ({ ...(p.sections[0]?.claims[0] ?? (() => { throw new Error('Missing claim'); })()),
          claimId: `claim-${String(i)}` })) })) })) };
    const m = project(changed, { task: 'parcel', maxBytes: 65536 });
    expect(m.units.slice(0, 6).map(u => [u.pageIndex, u.sectionIndex, u.claimIndex])).toEqual([
      [0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [2, 0, 0], [2, 1, 0],
    ]);
    expect(m.units).toHaveLength(12);
  });
  it('preserves relevance within each tier while deferring high-scoring repetitions', async () => {
    const g = await fixture(), page = g.pages[0], section = page?.sections[0], claim = section?.claims[0];
    if (!page || !section || !claim) throw new Error('Missing fixture');
    const changed = { ...g, pages: [{ ...page, sections: [{ ...section,
      claims: ['parcel conditions', 'parcel conditions', 'parcel only', 'parcel only'].map((text, i) => ({
        ...claim, claimId: `claim-${String(i)}`, text })) }] }] };
    expect(project(changed, { task: 'parcel conditions', maxBytes: 65536 }).units.map(u => u.claimIndex)).toEqual([0, 2, 1, 3]);
  });
  it('distinguishes fact identity, presentation and exact text but normalizes fact sets', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const proposal = fixtureProposal(snapshot, [fixtureFact(snapshot), fixtureFact(snapshot, 'Parcel retains local manifests.')]);
    const g = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, 'knowledge-markdown-v2');
    const page = g.pages[0], section = page?.sections[0], claim = section?.claims[0];
    const firstFact = g.records[0]?.id, secondFact = g.records[1]?.id;
    if (!page || !section || !claim || !firstFact || !secondFact) throw new Error('Missing fixture');
    const claims = [
      { ...claim, factIds: [firstFact, secondFact] },
      { ...claim, factIds: [secondFact, firstFact] },
      { ...claim, factIds: [firstFact] },
      { ...claim, factIds: [secondFact] },
      { ...claim, factIds: [firstFact, secondFact], presentation: 'history' as const },
      { ...claim, factIds: [firstFact, secondFact], text: claim.text + ' ' },
      { ...claim, factIds: [firstFact, secondFact], text: claim.text + ' Except archived.' },
      { ...claim, factIds: [secondFact, firstFact, secondFact] },
    ].map((c, i) => ({ ...c, claimId: `claim-${String(i)}` }));
    const changed = { ...g, pages: [{ ...page, sections: [{ ...section, claims }] }] };
    const m = project(changed, { task: 'parcel', maxBytes: 65536 });
    expect(m.units.map(u => u.claimIndex)).toEqual([0, 2, 3, 4, 5, 6, 1, 7]);
    expect(m.units.map(u => u.claim)).toEqual([0, 2, 3, 4, 5, 6, 1, 7].map(i => knowledgeDevelopmentMemory(changed).pages[0]?.sections[0]?.claims[i]));
  });
  it('binds cursor version to its ordering and rejects rewritten or unknown versions', async () => {
    const g = await repeatedFixture();
    const cursor = project(g, { task: 'parcel' }).recovery.nextCursor;
    if (!cursor) throw new Error('Missing cursor');
    for (const invalid of [cursor.replace('pwm2:', 'pwm1:'), cursor.replace('pwm2:', 'pwm3:'),
      legacyCursor(g).replace('pwm1:', 'pwm2:'), cursor.replace(/:[0-9]+:sha256/u, ':9007199254740992:sha256')]) {
      expect(() => project(g, { task: 'parcel', cursor: invalid })).toThrow(ProgressiveMemoryError);
    }
  });
});

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
