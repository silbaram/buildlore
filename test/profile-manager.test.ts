import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addProject,
  BUILDLORE_LIFECYCLE_PROFILE_ID,
  BUILDLORE_LIFECYCLE_PROFILE_VERSION,
  parseProjectDescriptor,
  PROJECT_SCHEMA_VERSION_V2,
  resolveProjectProfileBinding,
  showProject,
} from '../src/knowledge/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  createBuildLoreLifecycleProfile,
  createBuiltInProfileBinding,
  createProfileBindingPreflight,
  createProjectLifecycleProfile,
  renderLifecycleProfile,
} from '../src/profile/index.js';

const temporaryRoots: string[] = [];

async function fixture(projectIds: readonly string[] = ['alpha']): Promise<string> {
  const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-profile-manager-'));
  temporaryRoots.push(knowledgeRoot);
  for (const projectId of projectIds) {
    await addProject(knowledgeRoot, {
      displayName: projectId,
      projectId,
      sourceRepository: `https://example.test/${projectId}.git`,
    });
  }
  return knowledgeRoot;
}

function workspace(knowledgeRoot: string, projectId = 'alpha'): string {
  return join(knowledgeRoot, 'projects', projectId);
}

async function writeProfile(
  knowledgeRoot: string,
  language: 'en' | 'ko' = 'en',
  projectId = 'alpha',
): Promise<void> {
  await writeFile(
    join(workspace(knowledgeRoot, projectId), 'profile.json'),
    renderLifecycleProfile(createBuildLoreLifecycleProfile(language)),
    'utf8',
  );
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('project lifecycle profile manager', () => {
  it('plans without writes, applies descriptor-last, and becomes unchanged', async () => {
    const knowledgeRoot = await fixture();
    await writeProfile(knowledgeRoot);
    await writeFile(
      join(workspace(knowledgeRoot), 'profile-binding.json'),
      serializeCanonicalJson(createBuiltInProfileBinding('general', 'en')),
    );
    const manager = createProjectLifecycleProfile({ knowledgeRoot });

    const plan = await manager.plan('alpha');
    expect(plan).toMatchObject({
      disposition: 'compatible-recompile',
      migrationRequired: false,
      outputLanguage: 'en',
      projectId: 'alpha',
      reasonCodes: ['default-to-buildlore', 'profile-binding-update'],
      recompileRequired: true,
    });
    expect(JSON.stringify(plan)).not.toContain(knowledgeRoot);
    await expect(readFile(join(workspace(knowledgeRoot), '.llmwiki', 'profile.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await expect(manager.apply(plan)).resolves.toMatchObject({
      outcome: 'applied',
      profileHash: plan.sourceHash,
      recompileRequired: true,
    });
    const project = await showProject(knowledgeRoot, 'alpha');
    expect(project.descriptor).toEqual({
      outputLanguage: 'en',
      profileHash: plan.sourceHash,
      profileId: BUILDLORE_LIFECYCLE_PROFILE_ID,
      profileVersion: BUILDLORE_LIFECYCLE_PROFILE_VERSION,
      projectId: 'alpha',
      schemaVersion: PROJECT_SCHEMA_VERSION_V2,
      sourceRepository: 'https://example.test/alpha.git',
    });
    await expect(readFile(join(workspace(knowledgeRoot), 'profile-binding.json'), 'utf8'))
      .resolves.toBe(serializeCanonicalJson(createBuiltInProfileBinding('development', 'en')));
    await expect(createProfileBindingPreflight(knowledgeRoot).resolve('alpha')).resolves.toEqual({
      mode: 'custom',
      outputLanguage: 'en',
      workspace: workspace(knowledgeRoot),
    });

    const unchanged = await manager.plan('alpha');
    expect(unchanged).toMatchObject({ disposition: 'unchanged', recompileRequired: false });
    await expect(manager.apply(unchanged)).resolves.toMatchObject({
      outcome: 'unchanged',
      recompileRequired: false,
    });
    await expect(manager.apply(unchanged)).rejects.toMatchObject({
      code: 'PROFILE_BINDING_INVALID',
    });
  });

  it('keeps legacy default descriptors readable and promotes only on explicit apply', async () => {
    const knowledgeRoot = await fixture();
    const before = await readFile(join(workspace(knowledgeRoot), 'project.json'), 'utf8');
    await expect(createProfileBindingPreflight(knowledgeRoot).resolve('alpha')).resolves.toEqual({
      mode: 'default',
      outputLanguage: 'en',
      workspace: workspace(knowledgeRoot),
    });
    await expect(readFile(join(workspace(knowledgeRoot), 'project.json'), 'utf8')).resolves.toBe(before);

    await writeProfile(knowledgeRoot, 'ko');
    const manager = createProjectLifecycleProfile({ knowledgeRoot });
    const plan = await manager.plan('alpha');
    await manager.apply(plan);
    await expect(createProfileBindingPreflight(knowledgeRoot).resolve('alpha')).resolves.toMatchObject({
      mode: 'custom',
      outputLanguage: 'ko',
    });
  });

  it('fails preflight when an explicit adapter binding disagrees with the project profile', async () => {
    const knowledgeRoot = await fixture();
    await writeFile(
      join(workspace(knowledgeRoot), 'profile-binding.json'),
      serializeCanonicalJson(createBuiltInProfileBinding('development', 'ko')),
    );

    await expect(createProfileBindingPreflight(knowledgeRoot).resolve('alpha'))
      .rejects.toMatchObject({ code: 'PROFILE_DRIFT', projectId: 'alpha' });
  });

  it('supports an explicit en-to-ko source update without rewriting materialized schema', async () => {
    const knowledgeRoot = await fixture();
    await writeProfile(knowledgeRoot, 'en');
    const manager = createProjectLifecycleProfile({ knowledgeRoot });
    await manager.apply(await manager.plan('alpha'));
    const materializedBefore = await readFile(
      join(workspace(knowledgeRoot), '.llmwiki', 'profile.json'),
      'utf8',
    );

    await writeProfile(knowledgeRoot, 'ko');
    const plan = await manager.plan('alpha');
    expect(plan).toMatchObject({
      disposition: 'compatible-recompile',
      outputLanguage: 'ko',
      reasonCodes: ['language-update', 'profile-binding-update'],
    });
    await manager.apply(plan);
    await expect(readFile(join(workspace(knowledgeRoot), '.llmwiki', 'profile.json'), 'utf8'))
      .resolves.toBe(materializedBefore);
    await expect(showProject(knowledgeRoot, 'alpha')).resolves.toMatchObject({
      descriptor: { outputLanguage: 'ko', profileHash: plan.sourceHash },
    });
  });

  it('rejects cloned, drifted, foreign, and unsafe plans before a descriptor write', async () => {
    const clonedRoot = await fixture();
    await writeProfile(clonedRoot);
    const clonedManager = createProjectLifecycleProfile({ knowledgeRoot: clonedRoot });
    const bound = await clonedManager.plan('alpha');
    await expect(clonedManager.apply(structuredClone(bound))).rejects.toMatchObject({
      code: 'PROFILE_BINDING_INVALID',
    });

    const driftRoot = await fixture();
    await writeProfile(driftRoot, 'en');
    const driftManager = createProjectLifecycleProfile({ knowledgeRoot: driftRoot });
    const stale = await driftManager.plan('alpha');
    const descriptorBefore = await readFile(join(workspace(driftRoot), 'project.json'), 'utf8');
    await writeProfile(driftRoot, 'ko');
    await expect(driftManager.apply(stale)).rejects.toMatchObject({
      code: 'PROFILE_BINDING_INVALID',
    });
    await expect(readFile(join(workspace(driftRoot), 'project.json'), 'utf8'))
      .resolves.toBe(descriptorBefore);

    const foreignRoot = await fixture();
    await writeProfile(foreignRoot);
    await writeFile(
      join(workspace(foreignRoot), '.llmwiki', 'config.json'),
      '{"version":1}\n',
      'utf8',
    );
    const foreignManager = createProjectLifecycleProfile({ knowledgeRoot: foreignRoot });
    const foreign = await foreignManager.plan('alpha');
    expect(foreign).toMatchObject({
      disposition: 'migration-required',
      migrationRequired: true,
      reasonCodes: ['foreign-config'],
    });
    await expect(foreignManager.apply(foreign)).rejects.toMatchObject({
      code: 'PROFILE_MIGRATION_REQUIRED',
    });

    const unsafeRoot = await fixture();
    const outside = join(unsafeRoot, 'outside-profile.json');
    await writeFile(outside, renderLifecycleProfile(createBuildLoreLifecycleProfile('en')), 'utf8');
    await symlink(outside, join(workspace(unsafeRoot), 'profile.json'));
    await expect(createProjectLifecycleProfile({ knowledgeRoot: unsafeRoot }).plan('alpha'))
      .rejects.toMatchObject({ code: 'PROFILE_UNSAFE' });
  });

  it('confines apply to the selected project', async () => {
    const knowledgeRoot = await fixture(['alpha', 'beta']);
    await writeProfile(knowledgeRoot, 'en', 'alpha');
    const betaBefore = await readFile(join(workspace(knowledgeRoot, 'beta'), 'project.json'), 'utf8');
    const manager = createProjectLifecycleProfile({ knowledgeRoot });
    await manager.apply(await manager.plan('alpha'));
    await expect(readFile(join(workspace(knowledgeRoot, 'beta'), 'project.json'), 'utf8'))
      .resolves.toBe(betaBefore);
    await expect(readFile(join(workspace(knowledgeRoot, 'beta'), '.llmwiki', 'profile.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('parses the exact v2 descriptor union and rejects invalid binding combinations', () => {
    const descriptor = parseProjectDescriptor({
      outputLanguage: 'ko',
      profileHash: `sha256:${'a'.repeat(64)}`,
      profileId: BUILDLORE_LIFECYCLE_PROFILE_ID,
      profileVersion: BUILDLORE_LIFECYCLE_PROFILE_VERSION,
      projectId: 'alpha',
      schemaVersion: PROJECT_SCHEMA_VERSION_V2,
      sourceRepository: 'https://example.test/alpha.git',
    });
    expect(resolveProjectProfileBinding(descriptor)).toEqual({
      mode: 'custom',
      outputLanguage: 'ko',
      profileHash: `sha256:${'a'.repeat(64)}`,
      profileId: BUILDLORE_LIFECYCLE_PROFILE_ID,
      profileVersion: BUILDLORE_LIFECYCLE_PROFILE_VERSION,
    });
    expect(() => parseProjectDescriptor({ ...descriptor, outputLanguage: 'fr' })).toThrow(
      /binding is unsupported/u,
    );
    expect(() => parseProjectDescriptor({ ...descriptor, profileHash: null })).toThrow(
      /profileHash must be a string/u,
    );
    expect(() => parseProjectDescriptor({ ...descriptor, extra: true })).toThrow(
      /unsupported fields/u,
    );
  });
});
