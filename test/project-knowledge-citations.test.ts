import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createKnowledgeGeneration, parseKnowledgeGenerationChain } from '../src/compiler/project-knowledge/generation.js';
import { renderKnowledgeFiles } from '../src/compiler/project-knowledge/markdown.js';
import { createKnowledgeEvidenceCoverage, knowledgeEvidenceContentKind, knowledgeFactSupport } from '../src/compiler/project-knowledge/citation-support.js';
import { inspectKnowledgeProposalGrounding } from '../src/compiler/project-knowledge/grounding-diagnostic.js';
import { inspectClaimEvidenceOverlap } from '../src/compiler/hierarchy/quality.js';
import { createKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { digest, list, ProjectKnowledgeError, record, sha256, text } from '../src/knowledge/project-knowledge/guards.js';
import { parseJsonStrict } from '../src/knowledge/strict-json.js';
import { fixtureFact, fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';

async function projectedFixture() {
  const original = await knowledgeFixtureSnapshot();
  const content = '## /storage\n"json-file"\n## /verification\n# Heading with adjacent prose\nThis is actual prose.\n';
  const source = { sourceId: 'projected-settings', sourceRef: 'projected-settings.md', format: 'markdown' as const,
    content, sourceContentDigest: sha256(content), sourceRevision: 'R2', codeRevision: null, tracked: true,
    origins: [1, 2, 3].map(projectedLine => ({ projectedLine, sourceRef: 'settings.json',
      jsonPointer: projectedLine === 3 ? '/verification' : '/storage',
      range: { startLine: projectedLine, startColumn: 1, endLine: projectedLine, endColumn: 20 } })) };
  const snapshot = createKnowledgeSnapshot({ projectId: 'parcel', selectionDigest: original.selectionDigest,
    sanitizerPolicyDigest: original.sanitizerPolicyDigest, sanitizerRulesVersion: original.sanitizerRulesVersion,
    sources: [source] }, 'parcel');
  const heading = snapshot.evidence.find(e => e.excerpt === '## /storage');
  const value = snapshot.evidence.find(e => e.excerpt === '"json-file"');
  if (!heading || !value) throw new Error('Missing synthetic projection.');
  const fact = { ...fixtureFact(original), statement: 'The documented storage is json-file.', evidenceIds: [heading.evidenceId, value.evidenceId] };
  const proposal = fixtureProposal(snapshot, [fact]);
  const generation = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null);
  return { snapshot, proposal, generation, heading, value };
}

describe('versioned knowledge citations and generic coverage', () => {
  it('renders separate heading and value citations with escaped exact excerpts and fact state', async () => {
    const f = await projectedFixture();
    const body = renderKnowledgeFiles(f.generation)[0]?.body ?? '';
    expect(f.generation.rendererVersion).toBe('knowledge-markdown-v2');
    expect(body).toContain(`cite: [evidence:${f.heading.evidenceId}]; kind: heading;`);
    expect(body).toContain(`cite: [evidence:${f.value.evidenceId}]; kind: json-value;`);
    expect(body).toContain('excerpt: "\\\\"json-file\\\\""');
    expect(body).toContain(`cite: [fact:${f.generation.records[0]?.id ?? ''}]`);
    expect(body).toContain(`Snapshot: ${f.snapshot.snapshotDigest}`);
    expect(body).toContain('absent evidence does not prove feature removal');
    expect(body).not.toContain('This is actual prose.'); // Uncited inventory is not copied into pages.
    const mixed = f.snapshot.evidence.find(e => e.excerpt.includes('actual prose'));
    if (!mixed) throw new Error('Missing prose.');
    expect(knowledgeEvidenceContentKind(mixed)).toBe('text');
  });

  it('retains legacy render bytes and replays a mixed renderer chain without silent migration', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const proposal = fixtureProposal(snapshot);
    const first = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, 'knowledge-markdown-v1');
    const before = renderKnowledgeFiles(first);
    expect(before[0]?.body).toContain('## Evidence and scope');
    expect(before[0]?.body).not.toContain('excerpt=');
    const nextProposal = createKnowledgeProposal({ projectId: 'parcel', snapshotDigest: snapshot.snapshotDigest,
      baselineGenerationDigest: first.generationDigest, actor: proposal.actor, facts: [fixtureFact(snapshot)],
      pages: proposal.pages, supersessions: [], conflicts: [] }, snapshot);
    const next = createKnowledgeGeneration(snapshot, nextProposal, fixtureReview(nextProposal), first);
    const replayed = parseKnowledgeGenerationChain([first, next], 'parcel');
    expect(replayed.map(g => g.rendererVersion)).toEqual(['knowledge-markdown-v1', 'knowledge-markdown-v2']);
    expect(renderKnowledgeFiles(replayed[0] ?? first)).toEqual(before);
    expect(() => parseKnowledgeGenerationChain([{ ...first, rendererVersion: 'knowledge-markdown-v3' }], 'parcel')).toThrow(ProjectKnowledgeError);
    expect(() => parseKnowledgeGenerationChain([{ ...first, rendererVersion: 'knowledge-markdown-v2' }], 'parcel')).toThrow(ProjectKnowledgeError);
  });

  it('exposes stale state with exact snapshot membership, without inventing feature deletion', async () => {
    const r1 = await knowledgeFixtureSnapshot();
    const fact = fixtureFact(r1);
    const extra = r1.evidence.find(e => e.sourceRef === 'architecture.md');
    if (!extra) throw new Error('Missing evidence.');
    const firstProposal = fixtureProposal(r1, [{ ...fact, evidenceIds: [...fact.evidenceIds, extra.evidenceId] }]);
    const first = createKnowledgeGeneration(r1, firstProposal, fixtureReview(firstProposal), null);
    const r2 = createKnowledgeSnapshot({ projectId: 'parcel', selectionDigest: digest('reduced-selection'),
      sanitizerPolicyDigest: r1.sanitizerPolicyDigest, sanitizerRulesVersion: r1.sanitizerRulesVersion,
      sources: r1.sources.filter(s => s.sourceRef !== 'architecture.md') }, 'parcel');
    const newFact = { ...fixtureFact(r2), subject: 'additional-note' };
    const template = fixtureProposal(r2, [newFact]);
    const proposal = createKnowledgeProposal({ projectId: 'parcel', snapshotDigest: r2.snapshotDigest,
      baselineGenerationDigest: first.generationDigest, actor: template.actor, facts: [newFact],
      pages: template.pages, supersessions: [], conflicts: [] }, r2);
    const second = createKnowledgeGeneration(r2, proposal, fixtureReview(proposal), first);
    const prior = first.records[0];
    if (!prior) throw new Error('Missing record.');
    const support = knowledgeFactSupport(second, prior.id);
    expect(support).toMatchObject({ generationDigest: second.generationDigest, snapshotDigest: r2.snapshotDigest,
      selectionDigest: r2.selectionDigest, baselineGenerationDigest: first.generationDigest,
      fact: { lifecycle: 'stale', supersededBy: [] }, presentEvidenceIds: fact.evidenceIds, absentEvidenceIds: [extra.evidenceId] });
    expect(() => knowledgeFactSupport(second, extra.evidenceId)).toThrow(ProjectKnowledgeError);
  });

  it('checks exact generic projection coverage, distinguishing headings from values and omitted details', async () => {
    const f = await projectedFixture();
    const result = createKnowledgeEvidenceCoverage(f.snapshot, [
      { id: 'storage', sourceRef: 'settings.json', jsonPointer: '/storage', contentKind: 'json-value' },
      { id: 'verification', sourceRef: 'settings.json', jsonPointer: '/verification', contentKind: 'json-value' },
      { id: 'unselected', sourceRef: 'missing.json', jsonPointer: '/results', contentKind: 'json-value' },
    ], 'parcel');
    expect(result.complete).toBe(false);
    expect(result.requirements).toEqual([
      { id: 'storage', status: 'available', evidenceIds: [f.value.evidenceId] },
      { id: 'verification', status: 'heading-only', evidenceIds: [] },
      { id: 'unselected', status: 'unavailable', evidenceIds: [] },
    ]);
    expect(JSON.stringify(result)).not.toContain('missing.json');
    const req = { id: 'storage', sourceRef: 'settings.json', jsonPointer: '/storage', contentKind: 'json-value' };
    expect(createKnowledgeEvidenceCoverage(f.snapshot, [req], 'parcel').complete).toBe(true);
    for (const requirements of [[], [req, req], [{ ...req, jsonPointer: '/~2' }], [{ ...req, sourceRef: '../private.json' }],
      [{ ...req, unknown: true }], Array.from({ length: 257 }, (_, i) => ({ ...req, id: `req-${String(i)}` }))]) {
      expect(() => createKnowledgeEvidenceCoverage(f.snapshot, requirements, 'parcel')).toThrow(ProjectKnowledgeError);
    }
    expect(() => createKnowledgeEvidenceCoverage(f.snapshot, [req], 'lantern')).toThrow(ProjectKnowledgeError);
  });

  it('makes the existing lexical gate diagnosable without replacing independent semantic judgment', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const proposal = fixtureProposal(snapshot, [fixtureFact(snapshot, 'Astronomical zebras dance.')]);
    const diagnostic = inspectKnowledgeProposalGrounding(snapshot, proposal, 'parcel');
    expect(diagnostic.semanticReviewRequired).toBe(true);
    expect(diagnostic.claims).toHaveLength(3);
    expect(diagnostic.claims.every(c => !c.lexicalCheckPassed && c.minimumBasisPoints === 2500)).toBe(true);
    const fact = proposal.facts[0];
    if (!fact) throw new Error('Missing fact.');
    const contents = snapshot.evidence.filter(e => fact.evidenceIds.includes(e.evidenceId)).map(e => e.excerpt);
    expect(diagnostic.claims[0]).toMatchObject(inspectClaimEvidenceOverlap(fact.statement, contents));
    expect(inspectClaimEvidenceOverlap('json-file', ['"json-file"']).lexicalCheckPassed).toBe(true);
    const previous = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null);
    expect(() => inspectKnowledgeProposalGrounding(snapshot, proposal, 'parcel', [previous])).toThrow(ProjectKnowledgeError);
  });

  it('publishes every field of the new closed support contracts', async () => {
    const f = await projectedFixture();
    const fact = f.generation.records[0];
    if (!fact) throw new Error('Missing fact.');
    const schema = record(parseJsonStrict(await readFile('schemas/project-knowledge.schema.json', 'utf8')));
    const defs = record(schema.$defs);
    const examples = { factSupport: knowledgeFactSupport(f.generation, fact.id),
      evidenceCoverage: createKnowledgeEvidenceCoverage(f.snapshot, [{ id: 'storage', sourceRef: 'settings.json', jsonPointer: '/storage', contentKind: 'json-value' }], 'parcel'),
      groundingDiagnostic: inspectKnowledgeProposalGrounding(f.snapshot, f.proposal, 'parcel') };
    for (const [name, value] of Object.entries(examples)) {
      const shape = record(defs[name]);
      expect(shape.additionalProperties).toBe(false);
      expect(Object.keys(record(shape.properties)).sort()).toEqual(Object.keys(value).sort());
      expect(list(shape.required, 32).map(k => text(k)).sort()).toEqual(Object.keys(value).sort());
    }
  });
});
