import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addProject,
  KNOWLEDGE_SCHEMA_VERSION,
  readManifest,
  resolveProjectWorkspace,
  showProject,
} from '../src/knowledge/index.js';

const temporaryRoots: string[] = [];

async function fixture(): Promise<{ knowledge: string; outside: string; root: string }> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-path-confinement-'));
  temporaryRoots.push(root);
  const knowledge = join(root, 'knowledge');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(knowledge), mkdir(outside)]);
  return { knowledge, outside, root };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('knowledge path confinement', () => {
  it('rejects a symlinked projects ancestor', async () => {
    const { knowledge, outside } = await fixture();
    await symlink(outside, join(knowledge, 'projects'), 'dir');
    await expect(resolveProjectWorkspace(knowledge, 'alpha')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_KNOWLEDGE',
    });
  });

  it('rejects a symlinked project leaf even when it points inside the root', async () => {
    const { knowledge } = await fixture();
    await mkdir(join(knowledge, 'projects'));
    await mkdir(join(knowledge, 'real-alpha'));
    await symlink(join(knowledge, 'real-alpha'), join(knowledge, 'projects/alpha'), 'dir');
    await expect(resolveProjectWorkspace(knowledge, 'alpha')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_KNOWLEDGE',
    });
  });

  it('rejects a symlinked manifest instead of following it', async () => {
    const { knowledge, outside } = await fixture();
    const outsideManifest = join(outside, 'manifest.json');
    await writeFile(
      outsideManifest,
      `${JSON.stringify({ projects: [], schemaVersion: KNOWLEDGE_SCHEMA_VERSION })}\n`,
      'utf8',
    );
    await symlink(outsideManifest, join(knowledge, 'manifest.json'));
    await expect(readManifest(knowledge)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_KNOWLEDGE',
    });
  });

  it('does not treat a dangling manifest symlink as a missing manifest', async () => {
    const { knowledge, outside } = await fixture();
    await symlink(join(outside, 'missing.json'), join(knowledge, 'manifest.json'));
    await expect(readManifest(knowledge, { allowMissing: true })).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_KNOWLEDGE',
    });
  });

  it('rejects a required workspace directory replaced by an escaping symlink', async () => {
    const { knowledge, outside } = await fixture();
    await addProject(knowledge, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    await rm(join(knowledge, 'projects', 'alpha', 'sources'), { recursive: true });
    await symlink(outside, join(knowledge, 'projects', 'alpha', 'sources'), 'dir');
    await expect(showProject(knowledge, 'alpha')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_KNOWLEDGE',
    });
  });
});
