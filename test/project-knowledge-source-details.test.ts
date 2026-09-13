import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeWorkflowFixture, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { createKnowledgeEvidenceCoverage } from '../src/compiler/project-knowledge/citation-support.js';
import { parseKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { record } from '../src/knowledge/project-knowledge/guards.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup())); });

describe('optional source detail profiles through the generic JSON adapter', () => {
  it('delivers empty arrays and task/spec declarations when the caller selects generic detail profiles', async () => {
    const fixture = await createKnowledgeWorkflowFixture('optional-p2a', { sourceDetails: true });
    fixtures.push(fixture);
    const purpose = await fixture.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId: fixture.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
    for (const revision of ['R1', 'R2'] as const) {
      await fixture.setRevision(revision);
      const sync = await fixture.cli(['sync', '--project', fixture.projectId]);
      expect(sync).toMatchObject({ exitCode: 0, stderr: '' });
      const started = await fixture.cli(['compile', 'hierarchy', 'start', '--project', fixture.projectId, '--purpose', purpose]);
      expect(started).toMatchObject({ exitCode: 0, stderr: '' });
      const snapshot = parseKnowledgeSnapshot(record(started.data.exchange).snapshot, fixture.projectId);
      const run = 'artifacts/runs/v1-links/run-2026-08-01T00-00-00-000Z-task-001.json';
      const requirements = [
        { id: 'run-verification', sourceRef: run, jsonPointer: '/verification', contentKind: 'text' },
        { id: 'envelope-verification', sourceRef: run, jsonPointer: '/executionEnvelope/verification', contentKind: 'text' },
        { id: 'task-status', sourceRef: 'artifacts/iterations/v1-links/gate-c-task-graph/task-graph.json', jsonPointer: '/tasks/0/status', contentKind: 'json-value' },
        { id: 'spec-verification', sourceRef: 'artifacts/iterations/v1-links/gate-b-spec/spec.json', jsonPointer: '/implementation/verification', contentKind: 'text' },
        { id: 'spec-approval', sourceRef: 'artifacts/iterations/v1-links/gate-b-spec/spec.json', jsonPointer: '/approval', contentKind: 'json-value' },
      ];
      const coverage = createKnowledgeEvidenceCoverage(snapshot, requirements, fixture.projectId);
      expect(coverage.complete).toBe(true);
      for (const id of ['run-verification', 'envelope-verification', 'spec-verification']) {
        const evidenceIds = coverage.requirements.find(item => item.id === id)?.evidenceIds ?? [];
        expect(snapshot.evidence.filter(item => evidenceIds.includes(item.evidenceId)).map(item => item.excerpt)).toContain('_Empty array._');
      }
      expect(snapshot.evidence.some(item => item.excerpt === '"finished"')).toBe(true);
    }
    const runPath = join(fixture.sourceRoot, 'artifacts/runs/v1-links/run-2026-08-01T00-00-00-000Z-task-001.json');
    const original = record(JSON.parse(await readFile(runPath, 'utf8')) as unknown);
    const sentinel = `ghp_${'1234567890'.repeat(3)}123456`;
    await writeFile(runPath, JSON.stringify({ ...original, notes: [sentinel] }));
    const sync = await fixture.cli(['sync', '--project', fixture.projectId]);
    expect(JSON.stringify(sync)).not.toContain(sentinel);
    const denied = await fixture.cli(['compile', 'hierarchy', 'start', '--project', fixture.projectId, '--purpose', purpose]);
    expect(denied.exitCode).not.toBe(0);
    expect(JSON.stringify(denied)).not.toContain(sentinel);
  }, 60_000);
});
