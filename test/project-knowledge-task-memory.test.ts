import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { knowledgeTaskMemory, validateTaskMemoryRequest, TaskMemoryError } from '../src/compiler/project-knowledge/task-memory.js';
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

describe('task memory projection', () => {
  it('keeps original claims, reference closure, provenance and full memory unchanged', async () => {
    const generation = await fixture(); const before = JSON.stringify(generation);
    const full = knowledgeDevelopmentMemory(generation);
    const memory = knowledgeTaskMemory(generation, { task: 'parcel', maxBytes: 65536 });
    expect(memory.coverage).toMatchObject({ relevantSections: 3, includedSections: 3, partial: false });
    for (const page of memory.pages) for (const section of page.sections) {
      expect(section.claims).toEqual(full.pages[page.pageIndex]?.sections[section.sectionIndex]?.claims);
      for (const claim of section.claims) for (const alias of claim.facts) {
        const fact = memory.facts[alias]; expect(fact).toEqual(full.facts[alias]);
        for (const e of fact?.[6] ?? []) {
          expect(memory.evidence[e]).toEqual(full.evidence[e]);
          const tuple = memory.evidenceContext.values[memory.evidenceContext.aliases[e] ?? ''];
          expect(tuple).toBeDefined();
          expect(Object.fromEntries(memory.evidenceContext.fields.map((key, index) => [key, tuple?.[index]]))).toEqual(full.evidenceContext[e]);
          expect(memory.sources[memory.evidence[e]?.[1] ?? '']).toBeDefined();
        }
      }
    }
    expect(bytes(memory)).toBe(memory.budget.serializedBytes);
    const { memoryDigest, ...basis } = memory; expect(memoryDigest).toBe(digest(basis));
    expect(memory.lookup.expectedGeneration).toBe(generation.generationDigest);
    expect(JSON.stringify(generation)).toBe(before);
    expect(knowledgeDevelopmentMemory(generation)).toEqual(full);
    expect(memory.instructions).toContain('not a complete answer');
    const schema = record(JSON.parse(await readFile('schemas/project-knowledge-reader.schema.json', 'utf8')));
    expect(Object.keys(memory).sort()).toEqual((record(record(schema.$defs).taskMemory).required as string[]).toSorted());
  });

  it('uses title before body before source matches and stable generation order for ties', async () => {
    const g = await fixture();
    const changed = { ...g, pages: g.pages.map((p, i) => ({ ...p, title: i === 1 ? '배포 CAFÉ' : 'Other',
      sections: p.sections.map(s => ({ ...s, title: 'Context', claims: s.claims.map(c => ({ ...c,
        text: i === 0 ? '배포 only after checks; except archived work.' : 'Other conditions remain intact.' })) })) })) };
    const result = knowledgeTaskMemory(changed, { task: '배포', maxBytes: 65536 });
    expect(result.pages.map(p => p.pageIndex)).toEqual([1, 0]);
    expect(result.pages[1]?.sections[0]?.claims[0]?.text).toContain('except archived');
    expect(knowledgeTaskMemory(changed, { task: 'CAFÉ', maxBytes: 65536 }).pages.map(p => p.pageIndex)).toEqual([1]);
    expect(knowledgeTaskMemory(g, { task: 'README.md', maxBytes: 65536 }).pages.map(p => p.pageIndex)).toEqual([0, 1, 2]);
    expect(knowledgeTaskMemory(g, { task: 'parcel parcel', maxBytes: 65536 }).pages).toEqual(
      knowledgeTaskMemory(g, { task: 'parcel', maxBytes: 65536 }).pages);
  });

  it('handles exact UTF-8 boundaries and oversized whole sections without clipping exceptions', async () => {
    const g = await fixture(); const all = knowledgeTaskMemory(g, { task: 'parcel', maxBytes: 65536 });
    let limit = all.budget.serializedBytes;
    let exact = knowledgeTaskMemory(g, { task: 'parcel', maxBytes: limit });
    limit = exact.budget.serializedBytes; exact = knowledgeTaskMemory(g, { task: 'parcel', maxBytes: limit });
    expect(bytes(exact)).toBe(limit); expect(exact.coverage.includedSections).toBe(3);
    const less = knowledgeTaskMemory(g, { task: 'parcel', maxBytes: limit - 1 });
    expect(bytes(less)).toBeLessThanOrEqual(limit - 1); expect(less.coverage.omittedRelevantSections).toBeGreaterThan(0);
    const large = { ...g, pages: g.pages.map(p => ({ ...p, sections: p.sections.map(s => ({ ...s,
      claims: s.claims.map(c => ({ ...c, text: 'parcel 조건 '.repeat(1500) + 'except archived work.' })) })) })) };
    const empty = knowledgeTaskMemory(large, { task: 'parcel' });
    expect(empty.pages).toEqual([]); expect(empty.coverage.outcome).toBe('budget_limited');
    expect(empty.recovery.nextSection?.minimumRequiredBytes).toBeGreaterThan(8192);
    expect(bytes(empty)).toBeLessThanOrEqual(8192);
    expect(knowledgeTaskMemory(large, { task: 'parcel', maxBytes: 65536 }).pages[0]?.sections[0]?.claims[0]?.text).toMatch(/except archived work\.$/u);
  });

  it('reports no matches, validates SDK input and exposes metadata budget errors without input echoes', async () => {
    const g = await fixture(); const empty = knowledgeTaskMemory(g, { task: 'zzzz_nonexistent' });
    expect(empty.coverage).toMatchObject({ outcome: 'no_match', relevantSections: 0, unmatchedSections: 3 });
    expect(empty.pages).toEqual([]); expect(empty.recovery.instructions).toContain('wiki list/read');
    for (const request of [{ task: '' }, { task: '한'.repeat(684) }, { task: 'x', maxBytes: 1 },
      { task: 'x', maxBytes: 8192.5 }, { task: 'x', maxBytes: 65537 }]) {
      expect(() => validateTaskMemoryRequest(request)).toThrow(TaskMemoryError);
    }
    expect(() => knowledgeTaskMemory(g, { task: 'parcel', maxBytes: 2048 })).toThrow('TASK_MEMORY_BUDGET_TOO_SMALL');
    expect(knowledgeTaskMemory(g, { task: '  PARCEL  ' })).toEqual(knowledgeTaskMemory(g, { task: 'parcel' }));
  });
});
