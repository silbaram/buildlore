import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { parseKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createApprovedWikiProjectionStore } from '../src/retrieval/approved-corpus-store.js';

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
    await fixture.setRevision('R2');
    expect(await fixture.cli(['sync', '--project', fixture.projectId])).toMatchObject({ exitCode: 0 });
    const next = await fixture.cli(['compile', 'hierarchy', 'start', '--project', fixture.projectId, '--purpose', purpose]);
    expect(next).toMatchObject({ exitCode: 0 });
    const second = await submitWorkflowFixture(fixture, next.data);
    expect(await fixture.cli(second.approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(directory, 'decisions.md'), 'utf8')).not.toEqual(r1);
    const active = await createApprovedWikiProjectionStore(fixture.knowledgeRoot).readAuthority(fixture.projectId);
    expect(active.knowledgeGeneration?.generations).toHaveLength(2);
    expect(active.knowledgeGeneration?.generations[1]?.records.some((r) => r.lifecycle === 'superseded')).toBe(true);
    expect(await fixture.cli(['wiki', 'read', '--project', fixture.projectId, '--page', 'decisions'])).toMatchObject({
      exitCode: 0, data: { role: 'decisions', generationDigest: second.approved.data.generationDigest } });
    expect(await fixture.cli(['wiki', 'citations', '--project', fixture.projectId, '--page', 'architecture'])).toMatchObject({
      exitCode: 0, data: { role: 'architecture', generationDigest: second.approved.data.generationDigest } });
    expect(await fixture.cli(['search', '--project', fixture.projectId, '--query', 'local', '--mode', 'hybrid', '--intent', 'historical'])).toMatchObject({
      exitCode: 0, data: { requestedIntent: 'historical', generationDigest: second.approved.data.generationDigest,
        fallback: { reasonCode: 'project-knowledge-semantic-index-unavailable' } } });
  }, 60_000);
});
