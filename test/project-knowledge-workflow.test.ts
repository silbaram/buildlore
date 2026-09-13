import { latestKnowledgeGeneration, knowledgeAuthorityHistory } from '../src/retrieval/project-knowledge-authority.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { parseKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createApprovedWikiProjectionStore } from '../src/retrieval/approved-corpus-store.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { preparePlannedKnowledgeSession } from '../src/compiler/project-knowledge/planned-sources.js';
import { createHierarchyPayloadStore } from '../src/cli/hierarchical-run-store.js';
import { digest, hash, record } from '../src/knowledge/project-knowledge/guards.js';
import { knowledgeMarkdownRendererDigest, KNOWLEDGE_MARKDOWN_RENDERER_DIGEST } from '../src/retrieval/hierarchical-markdown.js';
import { createCliReaderAnswerEvaluationContract } from '../src/compiler/project-knowledge/answer-evaluation-contract.js';
import { createKnowledgeAnswerEvaluationService } from '../src/compiler/project-knowledge/answer-evaluation-service.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.cleanup())); });

describe('project knowledge public CLI workflow', () => {
  it.each(['generic-md-json', 'optional-p2a'] as const)('collects %s through real sync and starts a resumable sanitized exchange', async (sample) => {
    const fixture = await createKnowledgeWorkflowFixture(sample);
    fixtures.push(fixture);
    const sync = await fixture.cli(['sync', '--project', fixture.projectId]);
    expect(sync.stderr).toBe('');
    expect(sync, 'Real source sync must succeed without an AI provider.').toMatchObject({ exitCode: 0 });
    const purpose = await fixture.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId: fixture.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
    const started = await fixture.cli(['compile', 'hierarchy', 'start', '--project', fixture.projectId, '--purpose', purpose]);
    expect(started).toMatchObject({ exitCode: 0, data: { phase: 'awaiting-proposal', generationModel: 'project-knowledge-v1' } });
    const exchange = started.data.exchange as { snapshot: unknown };
    const snapshot = parseKnowledgeSnapshot(exchange.snapshot, fixture.projectId);
    expect(snapshot.evidence.some((e) => e.origin?.jsonPointer === '/storage' || e.origin?.jsonPointer === '/maxDepth')).toBe(true);
    const resumed = await fixture.cli(['compile', 'hierarchy', 'status', '--project', fixture.projectId, '--run', String(started.data.runId)]);
    expect(resumed).toEqual(started);
    const first = await submitWorkflowFixture(fixture, started.data);
    expect(await fixture.cli(first.approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
    const directory = join(fixture.knowledgeRoot, 'projects', fixture.projectId, 'wiki/buildlore-hierarchy');
    expect((await readdir(directory)).sort()).toEqual(['architecture.md', 'decisions.md', 'evidence.json', 'knowledge.json', 'manifest.json', 'overview.md']);
    const r1 = await readFile(join(directory, 'decisions.md'), 'utf8');
    const manifest = record(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as unknown);
    expect(manifest.rendererDigest).toBe(knowledgeMarkdownRendererDigest('knowledge-markdown-v2'));
    expect(manifest.rendererDigest).not.toBe(KNOWLEDGE_MARKDOWN_RENDERER_DIGEST);
    await fixture.setRevision('R2');
    expect(await fixture.cli(['sync', '--project', fixture.projectId])).toMatchObject({ exitCode: 0 });
    const next = await fixture.cli(['compile', 'hierarchy', 'start', '--project', fixture.projectId, '--purpose', purpose]);
    expect(next).toMatchObject({ exitCode: 0 });
    const second = await submitWorkflowFixture(fixture, next.data);
    expect(await fixture.cli(second.approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(directory, 'decisions.md'), 'utf8')).not.toEqual(r1);
    const active = await createApprovedWikiProjectionStore(fixture.knowledgeRoot).readAuthority(fixture.projectId);
    if (active.schemaVersion !== 'buildlore.approved-wiki-authority.v3') throw new Error('Expected pointer authority.');
    expect(active.knowledgeGeneration.history.generationCount).toBe('2');
    expect(active.knowledgeGeneration).not.toHaveProperty('generations');
    const current = latestKnowledgeGeneration(active.knowledgeGeneration);
    expect(current.records.some((r) => r.lifecycle === 'superseded')).toBe(true);
    const historical = current?.records.find(r => r.lifecycle === 'superseded');
    if (!current || !historical) throw new Error('Missing active fixture history.');
    expect(current.rendererVersion).toBe('knowledge-markdown-v2');
    const reader = createKnowledgeWikiReader(fixture.knowledgeRoot);
    expect(await reader.fact(fixture.projectId, current.generationDigest, historical.id)).toMatchObject({
      generationDigest: current.generationDigest, fact: { lifecycle: 'superseded', supersededBy: historical.supersededBy } });
    await expect(reader.fact(fixture.projectId, digest('stale generation'), historical.id)).rejects.toThrow();
    await expect(reader.fact(fixture.projectId, current.generationDigest, historical.evidenceIds[0] ?? digest('missing'))).rejects.toThrow();
    await expect(reader.fact('unregistered-project', current.generationDigest, historical.id)).rejects.toThrow();
    expect(await fixture.cli(['wiki', 'read', '--project', fixture.projectId, '--page', 'decisions'])).toMatchObject({
      exitCode: 0, data: { role: 'decisions', generationDigest: second.approved.data.generationDigest } });
    expect(await fixture.cli(['wiki', 'citations', '--project', fixture.projectId, '--page', 'architecture'])).toMatchObject({
      exitCode: 0, data: { role: 'architecture', generationDigest: second.approved.data.generationDigest } });
    const contract = createCliReaderAnswerEvaluationContract({ projectId: fixture.projectId, sampleId: sample, revision: 'R2',
      fixtureDigest: current.snapshot.snapshotDigest, oracleDigest: digest('synthetic protocol check, not an independent answer review'),
      questions: Array.from({ length: 5 }, (_, i) => ({ id: `q-${String(i)}`, question: 'Explain the documented change and limits.',
        criteria: [{ id: 'mandatory', kind: 'mandatory', statement: 'Withheld synthetic criterion.' }] })) }, fixture.projectId);
    const evaluator = await createKnowledgeAnswerEvaluationService({ knowledgeRoot: fixture.knowledgeRoot }).prepare({
      projectId: fixture.projectId, contract, history: knowledgeAuthorityHistory(active.knowledgeGeneration) });
    for (const page of current.pages) {
      const compact = await fixture.cli(['wiki', 'read', '--project', fixture.projectId, '--page', page.role, '--view', 'reader']);
      expect(compact).toMatchObject({ exitCode: 0, data: { schemaVersion: 'buildlore.knowledge-reader-page.v1',
        page: page.role, generationDigest: current.generationDigest } });
      const context = evaluator.initialContext.find(item => item.ref === `${page.role}.md`);
      expect(context?.body).toBe(serializeCanonicalJson(compact.data));
      expect(context?.utf8Bytes).toBe(Buffer.byteLength(serializeCanonicalJson(compact.data)));
      expect(context?.utf8Bytes).toBeGreaterThan(Buffer.byteLength(String(compact.data.markdown)));
      expect(compact.data).not.toHaveProperty('evidence');
      expect(compact.data).not.toHaveProperty('facts');
      const full = await fixture.cli(['wiki', 'read', '--project', fixture.projectId, '--page', page.role, '--view', 'full']);
      expect(Buffer.byteLength(JSON.stringify(compact.data))).toBeLessThan(Buffer.byteLength(JSON.stringify(full.data)));
      expect(full.data.markdown).toBe(await readFile(join(directory, `${page.role}.md`), 'utf8'));
    }
    for (const [kind, id] of [['fact', historical.id], ['evidence', historical.evidenceIds[0] ?? digest('missing')]] as const) {
      const args = ['wiki', 'lookup', '--project', fixture.projectId, '--kind', kind, '--id', id, '--expect-generation'];
      const lookup = await fixture.cli([...args, current.generationDigest]);
      expect(lookup).toMatchObject({ exitCode: 0, data: { kind, id, generationDigest: current.generationDigest } });
      const audited = kind === 'fact' ? await evaluator.lookupFacts('q-0', [id]) : await evaluator.lookup('q-0', [id]);
      expect(audited.returned.body).toBe(serializeCanonicalJson(lookup.data));
      expect(audited.returned.utf8Bytes).toBe(Buffer.byteLength(serializeCanonicalJson(lookup.data)));
      expect((await fixture.cli([...args, digest('stale')])).exitCode).not.toBe(0);
    }
    await expect(reader.lookup(fixture.projectId, current.generationDigest, 'evidence', historical.id)).rejects.toThrow();
    await expect(reader.lookup('unregistered-project', current.generationDigest, 'fact', historical.id)).rejects.toThrow();
    await expect(evaluator.lookupFacts('q-0', [historical.id, historical.id])).rejects.toThrow();
    expect(await fixture.cli(['search', '--project', fixture.projectId, '--query', 'local', '--mode', 'hybrid', '--intent', 'historical'])).toMatchObject({
      exitCode: 0, data: { requestedIntent: 'historical', generationDigest: second.approved.data.generationDigest,
        fallback: { reasonCode: 'semantic-index-unavailable' } } });
  }, 60_000);

  it('resumes and finalizes a persisted v1 run using the original exchange and renderer', async () => {
    const fixture = await createKnowledgeWorkflowFixture('generic-md-json');
    fixtures.push(fixture);
    expect(await fixture.cli(['sync', '--project', fixture.projectId])).toMatchObject({ exitCode: 0 });
    const { session } = await preparePlannedKnowledgeSession({ hubRoot: fixture.hubRoot, knowledgeRoot: fixture.knowledgeRoot,
      projectId: fixture.projectId, outputLanguage: 'en', rendererVersion: 'knowledge-markdown-v1', previousGenerations: [] });
    // A deterministic, genuine v1 exchange seeds only this disposable fixture's old run record.
    const basis = { schemaVersion: 'buildlore.project-knowledge-workflow-run.v1', projectId: fixture.projectId,
      runId: `run-${'a'.repeat(64)}`, revision: 0, phase: 'awaiting-proposal', outputLanguage: 'en',
      snapshotDigest: session.exchange.snapshot.snapshotDigest, exchangeDigest: session.exchange.exchangeDigest,
      baselineAuthorityDigest: null, proposal: null, semanticReview: null, ledgerDigest: null, approvedAuthorityDigest: null };
    const store = createHierarchyPayloadStore(fixture.hubRoot, value => {
      const r = record(value);
      if (r.projectId !== basis.projectId || r.runId !== basis.runId || r.revision !== 0) throw new Error('Invalid test seed.');
      return { ...basis, recordDigest: hash(r.recordDigest) };
    });
    await store.create({ ...basis, recordDigest: digest(basis) });
    const started = await fixture.cli(['compile', 'hierarchy', 'status', '--project', fixture.projectId, '--run', basis.runId]);
    expect(started).toMatchObject({ exitCode: 0, data: { phase: 'awaiting-proposal', exchange: session.exchange } });
    const completed = await submitWorkflowFixture(fixture, started.data);
    const activated = await fixture.cli(completed.approved.data.activationArgs as string[]);
    expect(activated.stderr).toBe('');
    expect(activated).toMatchObject({ exitCode: 0 });
    const authority = await createApprovedWikiProjectionStore(fixture.knowledgeRoot).readAuthority(fixture.projectId);
    if (!authority.knowledgeGeneration) throw new Error('Expected knowledge authority.');
    expect(latestKnowledgeGeneration(authority.knowledgeGeneration).rendererVersion).toBe('knowledge-markdown-v1');
    const body = await readFile(join(fixture.knowledgeRoot, 'projects/parcel/wiki/buildlore-hierarchy/overview.md'), 'utf8');
    expect(body).toContain('## Evidence and scope');
    expect(body).not.toContain('## Knowledge state');
    const manifest = record(JSON.parse(await readFile(join(fixture.knowledgeRoot, 'projects/parcel/wiki/buildlore-hierarchy/manifest.json'), 'utf8')) as unknown);
    expect(manifest.rendererDigest).toBe(KNOWLEDGE_MARKDOWN_RENDERER_DIGEST);
  }, 60_000);
});
