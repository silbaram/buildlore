import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
  createHierarchicalWorkflowRunRecord,
  createHierarchicalWorkflowRunStore,
} from '../src/cli/hierarchical-run-store.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { HIERARCHICAL_WORKFLOW_PURPOSE_INPUT_SCHEMA_VERSION } from
  '../src/cli/hierarchical-workflow.js';
import {
  createHierarchicalWorkflowTestFixture,
  type HierarchicalWorkflowTestFixtureV1,
} from './helpers/hierarchical-workflow-fixture.js';

const fixtures: HierarchicalWorkflowTestFixtureV1[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('hierarchical workflow run store v2', () => {
  it('round-trips the resubmission audit field and refuses a stale CAS writer', async () => {
    const fixture = await createHierarchicalWorkflowTestFixture('hierarchy-run-store');
    fixtures.push(fixture);
    const purposeFile = await fixture.writeJson('purpose.json', {
      schemaVersion: HIERARCHICAL_WORKFLOW_PURPOSE_INPUT_SCHEMA_VERSION,
      projectId: fixture.projectId,
      audience: ['Maintainers'],
      goals: ['Explain durable hierarchy runs'],
      keyQuestions: ['How does a run remain deterministic?'],
      scopeHints: ['Local run storage'],
      excludedTopics: ['Hosted execution'],
      outputLanguage: 'en',
      requestedPageRoles: ['overview'],
    });
    const started = await fixture.createService().start(fixture.projectId, purposeFile);
    const store = createHierarchicalWorkflowRunStore(fixture.hubRoot);
    const record = await store.read(fixture.projectId, started.runId);
    expect(record).toMatchObject({
      schemaVersion: HIERARCHICAL_WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
      revision: 0,
      resubmissions: [],
    });
    const { recordDigest: _digest, schemaVersion: _version, ...basis } = record;
    void _digest;
    void _version;
    const next = createHierarchicalWorkflowRunRecord({ ...basis, revision: 1 });
    await store.replace({
      expectedRecordDigest: record.recordDigest,
      expectedRevision: record.revision,
      next,
      projectId: fixture.projectId,
      runId: started.runId,
    });
    await expect(store.replace({
      expectedRecordDigest: record.recordDigest,
      expectedRevision: record.revision,
      next,
      projectId: fixture.projectId,
      runId: started.runId,
    })).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_CONFLICT' });
    await expect(store.read(fixture.projectId, started.runId)).resolves.toEqual(next);
  });

  it('reports a digest-valid in-progress v1 run as policy-outdated without interpreting it',
    async () => {
      const fixture = await createHierarchicalWorkflowTestFixture('hierarchy-run-store-outdated');
      fixtures.push(fixture);
      const purposeFile = await fixture.writeJson('purpose.json', {
        schemaVersion: HIERARCHICAL_WORKFLOW_PURPOSE_INPUT_SCHEMA_VERSION,
        projectId: fixture.projectId,
        audience: ['Maintainers'],
        goals: ['Explain durable hierarchy runs'],
        keyQuestions: ['How does a run remain deterministic?'],
        scopeHints: ['Local run storage'],
        excludedTopics: ['Hosted execution'],
        outputLanguage: 'en',
        requestedPageRoles: ['overview'],
      });
      const started = await fixture.createService().start(fixture.projectId, purposeFile);
      const store = createHierarchicalWorkflowRunStore(fixture.hubRoot);
      const record = await store.read(fixture.projectId, started.runId);
      const {
        recordDigest: _recordDigest,
        resubmissions: _resubmissions,
        schemaVersion: _schemaVersion,
        ...currentBasis
      } = record;
      void _recordDigest;
      void _resubmissions;
      void _schemaVersion;
      const legacyBasis = Object.freeze({
        ...currentBasis,
        schemaVersion: 'buildlore.hierarchical-workflow-run-record.v1',
      });
      const legacy = Object.freeze({
        ...legacyBasis,
        recordDigest: `sha256:${createHash('sha256')
          .update(serializeCanonicalJson(legacyBasis)).digest('hex')}`,
      });
      await writeFile(join(
        fixture.hubRoot,
        '.buildlore',
        'hierarchy-runs',
        fixture.projectId,
        started.runId,
        'run.json',
      ), serializeCanonicalJson(legacy), 'utf8');

      await expect(store.read(fixture.projectId, started.runId)).rejects.toMatchObject({
        code: 'HIERARCHICAL_WORKFLOW_RUN_POLICY_OUTDATED',
      });
      await expect(store.read(fixture.projectId, started.runId)).rejects.not.toHaveProperty(
        'submission',
      );
    });
});
