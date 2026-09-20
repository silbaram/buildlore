import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectProject, resolveConnection, assertConnectionCurrent, disconnectProject, relocateHub } from '../src/connection/service.js';
import { connectionStatus, readConnectedWiki } from '../src/application/wiki-read-service.js';
import { parseRegistry } from '../src/connection/contracts.js';
import { addProject } from '../src/knowledge/workspace.js';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { git } from './helpers/connected-fixture.js';

describe('direct workspace connections', () => {
  it('reads approved generations, isolates projects, preserves legacy entries and detects drift', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    const configDir = join(f.root, 'read-config');
    try {
      await mkdir(configDir);
      const legacy = { knowledgeRepository: 'https://example.test/legacy.git', knowledgeRepositoryDigest: 'sha256:7a0e14c3527fc37d839f57d7d95a0a4beebff134c1d05c886a2dac9a7d056ea0', hubRoot: join(f.root, 'legacy') };
      // Derive the exact legacy identity with the same public portable digest contract.
      const { hash } = await import('../src/connection/contracts.js');
      legacy.knowledgeRepositoryDigest = hash(legacy.knowledgeRepository);
      await writeFile(join(configDir, 'connections.json'), JSON.stringify({ schemaVersion: 'buildlore.read-connections.v1', hubs: [legacy], bindings: [] }));
      const options = { configDir }, input = { workspace: f.hubRoot, projectId: f.projectId, sourceRepository: 'https://example.test/parcel.git' };
      const context = await connectProject(f.sourceRoot, input, options);
      expect(await connectionStatus(context)).toMatchObject({ schemaVersion: 'buildlore.connection-status.v2', pin: 'not_applicable', readable: false });
      await expect(readConnectedWiki(context, { operation: 'list' })).rejects.toMatchObject({ code: 'APPROVAL_MISSING' });
      const shared = await readFile(join(f.sourceRoot, '.buildlore/connection.json'));
      const registry = await readFile(join(configDir, 'connections.json'));
      expect(parseRegistry(JSON.parse(registry.toString()) as unknown).hubs).toContainEqual(legacy);
      await connectProject(f.sourceRoot, input, options);
      expect(await readFile(join(f.sourceRoot, '.buildlore/connection.json'))).toEqual(shared);
      expect(await readFile(join(configDir, 'connections.json'))).toEqual(registry);
      expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      const purpose = await f.json('purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2', projectId: f.projectId,
        generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
      const started = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
      const approved = await submitWorkflowFixture(f, started.data);
      expect(await f.cli(approved.approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
      const status = await connectionStatus(context);
      expect(status).toMatchObject({ readable: true, pin: 'not_applicable', approval: 'ready' });
      const list = await readConnectedWiki(context, { operation: 'list' });
      expect(list.readContext.generation).toBe(status.generation);
      expect(await readConnectedWiki(context, { operation: 'read', page: 'overview', expectedGeneration: list.readContext.generation })).toHaveProperty('data');
      await expect(readConnectedWiki(context, { operation: 'read', page: 'overview', expectedGeneration: 'sha256:' + 'f'.repeat(64) })).rejects.toMatchObject({ code: 'GENERATION_CHANGED' });
      const other = join(f.root, 'other-source');
      await mkdir(other); await git(other, 'init');
      await addProject(f.knowledgeRoot, { projectId: 'other', displayName: 'Other', sourceRepository: 'https://example.test/other.git' });
      const second = await connectProject(other, { workspace: f.hubRoot, projectId: 'other', sourceRepository: 'https://example.test/other.git' }, options);
      await expect(readConnectedWiki(second, { operation: 'list' })).rejects.toMatchObject({ code: 'APPROVAL_MISSING' });
      await expect(connectProject(other, { ...input, sourceRepository: 'https://example.test/other.git' }, options)).rejects.toMatchObject({ code: 'SOURCE_IDENTITY_MISMATCH' });
      const nested = join(f.hubRoot, 'nested'); await mkdir(nested); await git(nested, 'init');
      await expect(connectProject(nested, input, options)).rejects.toMatchObject({ code: 'READ_BOUNDARY_VIOLATION' });
      await expect(connectProject(f.sourceRoot, { hub: f.hubRoot, projectId: f.projectId }, options)).rejects.toThrow();
      await git(f.hubRoot, 'remote', 'set-url', 'origin', 'https://example.test/wrong.git');
      await expect(assertConnectionCurrent(context)).rejects.toMatchObject({ code: 'KNOWLEDGE_IDENTITY_MISMATCH' });
    } finally { await f.cleanup(); }
  }, 60000);

  it('relocates an explicitly registered direct repository and preserves shared bindings', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      const options = { configDir: join(f.root, 'config') };
      const context = await connectProject(f.sourceRoot, { workspace: f.hubRoot, projectId: f.projectId, sourceRepository: 'https://example.test/parcel.git' }, options);
      const moved = join(f.root, 'moved knowledge');
      await rename(f.hubRoot, moved);
      const input = { from: f.hubRoot, to: moved, knowledgeRepository: '../knowledge.git' };
      const plan = await relocateHub(input, options);
      expect(plan).toMatchObject({ changed: true, applied: false });
      await relocateHub({ ...input, apply: true, expectedPlan: plan.planDigest }, options);
      expect(await resolveConnection(f.sourceRoot, options)).toMatchObject({ projectId: f.projectId });
      await expect(assertConnectionCurrent(context)).rejects.toMatchObject({ code: 'CONNECTION_CONFLICT' });
      await disconnectProject(f.sourceRoot, true, options);
      expect(await resolveConnection(f.sourceRoot, options)).toBeNull();
    } finally { await f.cleanup(); }
  }, 30000);
});
