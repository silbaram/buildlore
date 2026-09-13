import { latestKnowledgeGeneration } from '../src/retrieval/project-knowledge-authority.js';
import { readFile, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovedWikiPublicationReader } from '../src/retrieval/approved-corpus-store.js';
import * as authority from '../src/retrieval/project-knowledge-authority.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture,
  type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map(f => f.cleanup()));
});

async function fixture() {
  const f = await createKnowledgeWorkflowFixture('generic-md-json');
  fixtures.push(f);
  const purpose = await f.json('cache-purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
    projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
  expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
  const start = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
  const completed = await submitWorkflowFixture(f, start.data);
  expect(await f.cli(completed.approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
  return { ...f, path: join(f.knowledgeRoot, 'projects', f.projectId,
    '.llmwiki/buildlore-hierarchy/approved-authority.json') };
}

describe('content-bound publication reader cache', () => {
  it('replays once, freezes descendants, and rejects same-length tampering even with restored mtime', async () => {
    const f = await fixture();
    const parse = vi.spyOn(authority, 'resolveKnowledgeAuthorityExtension');
    const reader = createApprovedWikiPublicationReader(f.knowledgeRoot);
    const first = await reader.read(f.projectId);
    if (!first) throw new Error('Missing test publication.');
    const count = parse.mock.calls.length;
    expect(count).toBeGreaterThan(0);
    expect(await reader.read(f.projectId)).toBe(first);
    expect(parse).toHaveBeenCalledTimes(count);
    const generation = first.authority.knowledgeGeneration && latestKnowledgeGeneration(first.authority.knowledgeGeneration);
    if (!generation) throw new Error('Missing test knowledge.');
    expect(Object.isFrozen(generation.records)).toBe(true);
    expect(Object.isFrozen(generation.records[0])).toBe(true);
    expect(Object.isFrozen(first.projection.corpus.pages[0]?.sections[0])).toBe(true);
    expect(Reflect.set(generation.records, '0', {})).toBe(false);
    const bytes = await readFile(f.path);
    const before = await stat(f.path);
    const changed = bytes.toString('utf8').replace('"accepted"', '"tampered"');
    expect(Buffer.byteLength(changed)).toBe(bytes.length);
    expect(changed).not.toBe(bytes.toString('utf8'));
    await writeFile(f.path, changed);
    await utimes(f.path, before.atime, before.mtime);
    await expect(reader.read(f.projectId)).rejects.toThrow();
    await writeFile(f.path, bytes);
    expect(await reader.read(f.projectId)).not.toBe(first);
  }, 30_000);

  it('does not reuse a cache for missing files, symlinks or another project', async () => {
    const f = await fixture();
    const reader = createApprovedWikiPublicationReader(f.knowledgeRoot);
    const first = await reader.read(f.projectId);
    const bytes = await readFile(f.path);
    await expect(reader.read('lantern')).rejects.toThrow();
    await unlink(f.path);
    expect(await reader.read(f.projectId)).toBeNull();
    await writeFile(`${f.path}.fixture`, bytes);
    await symlink(`${f.path}.fixture`, f.path);
    await expect(reader.read(f.projectId)).rejects.toThrow();
    await unlink(f.path);
    await writeFile(f.path, bytes);
    expect(await reader.read(f.projectId)).not.toBe(first);
  }, 30_000);

  it('rechecks security policy on a cached Wiki read', async () => {
    const f = await fixture();
    const reader = createKnowledgeWikiReader(f.knowledgeRoot);
    expect(await reader.read(f.projectId, 'overview')).not.toBeNull();
    await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { classification: 'internal' });
    await expect(reader.read(f.projectId, 'overview')).rejects.toThrow();
  }, 30_000);
});
