import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addProject,
  KNOWLEDGE_SCHEMA_VERSION,
  parseKnowledgeManifest,
  parseProjectDescriptor,
  PROJECT_SCHEMA_VERSION,
  readManifest,
  showProject,
  validateProjectRegistry,
  validateProjectId,
  validateRepositoryLocator,
  writeManifest,
} from '../src/knowledge/index.js';
import { type AtomicWriteHooks } from '../src/knowledge/atomic-file.js';
import { withRegistryLock } from '../src/knowledge/registry.js';

const temporaryRoots: string[] = [];
const atomicFailureHooks: ReadonlyArray<{
  readonly hooks: AtomicWriteHooks;
  readonly name: string;
}> = [
  {
    hooks: { beforeWrite: () => Promise.reject(new Error('injected write failure')) },
    name: 'write',
  },
  {
    hooks: { beforeSync: () => Promise.reject(new Error('injected sync failure')) },
    name: 'sync',
  },
  {
    hooks: { beforeClose: () => Promise.reject(new Error('injected close failure')) },
    name: 'close',
  },
  {
    hooks: { beforeRename: () => Promise.reject(new Error('injected rename failure')) },
    name: 'rename',
  },
];

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function createKnowledgeRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-knowledge-registry-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'knowledge'));
  return join(root, 'knowledge');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('knowledge registry', () => {
  it('creates deterministic, isolated project workspaces', async () => {
    const knowledgeRoot = await createKnowledgeRoot();
    await addProject(knowledgeRoot, {
      displayName: 'Zulu',
      projectId: 'zulu',
      sourceRepository: 'https://example.test/zulu.git',
    });
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'git@example.test:alpha.git',
    });

    const manifest = await readManifest(knowledgeRoot);
    expect(manifest).toEqual({
      projects: [
        {
          displayName: 'Alpha',
          path: 'projects/alpha',
          projectId: 'alpha',
          sourceRepository: 'git@example.test:alpha.git',
        },
        {
          displayName: 'Zulu',
          path: 'projects/zulu',
          projectId: 'zulu',
          sourceRepository: 'https://example.test/zulu.git',
        },
      ],
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    });
    const alpha = await showProject(knowledgeRoot, 'alpha');
    expect(alpha.descriptor).toEqual({
      profileVersion: 'llmwiki.default.v1',
      projectId: 'alpha',
      schemaVersion: PROJECT_SCHEMA_VERSION,
      sourceRepository: 'git@example.test:alpha.git',
    });
    await expect(readFile(join(knowledgeRoot, 'projects/alpha/log.md'), 'utf8')).resolves.toBe(
      '# BuildLore project log\n',
    );
    await expect(readFile(join(knowledgeRoot, 'manifest.json'), 'utf8')).resolves.toMatch(
      /"projectId": "alpha"[\s\S]*"projectId": "zulu"/u,
    );
  });

  it('rejects malformed identifiers, duplicate registrations, and unsafe schemas', async () => {
    expect(() => validateProjectId('Upper_Case')).toThrow(/lowercase kebab-case/u);
    expect(() => validateProjectId('shared')).toThrow(/non-reserved/u);
    expect(() =>
      parseKnowledgeManifest({
        projects: [
          {
            displayName: 'Unsafe',
            path: '../unsafe',
            projectId: 'unsafe',
            sourceRepository: 'https://example.test/unsafe.git',
          },
        ],
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      }),
    ).toThrow(/canonical/u);
    expect(() =>
      parseKnowledgeManifest({ projects: [], schemaVersion: KNOWLEDGE_SCHEMA_VERSION, extra: true }),
    ).toThrow(/unsupported fields/u);
    expect(() =>
      parseKnowledgeManifest({ projects: [], schemaVersion: 'buildlore.knowledge.v2' }),
    ).toThrow(/unsupported/u);
    expect(() =>
      parseKnowledgeManifest({
        projects: [
          {
            displayName: 'Alpha',
            path: 'projects/alpha',
            projectId: 'alpha',
            sourceRepository: 'https://example.test/alpha.git',
          },
          {
            displayName: 'Duplicate',
            path: 'projects/alpha',
            projectId: 'alpha',
            sourceRepository: 'https://example.test/duplicate.git',
          },
        ],
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      }),
    ).toThrow(/duplicate/u);
    for (const path of [
      '/absolute/alpha',
      'C:\\alpha',
      '\\\\server\\alpha',
      'projects\\alpha',
      'projects/../alpha',
      'projects/%2e%2e/alpha',
    ]) {
      expect(() =>
        parseKnowledgeManifest({
          projects: [
            {
              displayName: 'Alpha',
              path,
              projectId: 'alpha',
              sourceRepository: 'https://example.test/alpha.git',
            },
          ],
          schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        }),
      ).toThrow(/canonical/u);
    }
    expect(() =>
      parseProjectDescriptor({
        profileVersion: 'future.profile.v2',
        projectId: 'alpha',
        schemaVersion: PROJECT_SCHEMA_VERSION,
        sourceRepository: 'https://example.test/alpha.git',
      }),
    ).toThrow(/profileVersion is unsupported/u);

    const knowledgeRoot = await createKnowledgeRoot();
    const input = {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    } as const;
    await addProject(knowledgeRoot, input);
    await expect(addProject(knowledgeRoot, input)).rejects.toMatchObject({ code: 'PROJECT_EXISTS' });
  });

  it.each(atomicFailureHooks)(
    'preserves the prior manifest when atomic $name fails',
    async ({ hooks }) => {
    const knowledgeRoot = await createKnowledgeRoot();
    await writeManifest(knowledgeRoot, {
      projects: [],
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    });
    const before = await readFile(join(knowledgeRoot, 'manifest.json'), 'utf8');

    await expect(
      writeManifest(
        knowledgeRoot,
        {
          projects: [
            {
              displayName: 'Alpha',
              path: 'projects/alpha',
              projectId: 'alpha',
              sourceRepository: 'https://example.test/alpha.git',
            },
          ],
          schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        },
        hooks,
      ),
    ).rejects.toMatchObject({ code: 'REGISTRY_WRITE_FAILED' });
    await expect(readFile(join(knowledgeRoot, 'manifest.json'), 'utf8')).resolves.toBe(before);
      await expect(readdir(knowledgeRoot)).resolves.not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^\.manifest\.json\..+\.tmp$/u)]),
      );
    },
  );

  it('serializes concurrent mutations with an exclusive registry lock', async () => {
    const knowledgeRoot = await createKnowledgeRoot();
    await withRegistryLock(knowledgeRoot, async () => {
      await writeManifest(knowledgeRoot, {
        projects: [],
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      });
      await expect(
        addProject(knowledgeRoot, {
          displayName: 'Busy',
          projectId: 'busy',
          sourceRepository: 'https://example.test/busy.git',
        }),
      ).rejects.toMatchObject({
        code: 'REGISTRY_BUSY',
        recoveryCommand: ['project', 'validate'],
      });
    });
    await expect(readManifest(knowledgeRoot)).resolves.toEqual({
      projects: [],
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    });
  });

  it('removes a newly created lock when lock initialization fails', async () => {
    const knowledgeRoot = await createKnowledgeRoot();
    await expect(
      withRegistryLock(
        knowledgeRoot,
        () => Promise.resolve(),
        {
          afterOpen: () => {
            throw new Error('injected lock initialization failure');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'REGISTRY_WRITE_FAILED' });
    await expect(pathExists(join(knowledgeRoot, 'manifest.json.lock'))).resolves.toBe(false);
    await expect(withRegistryLock(knowledgeRoot, () => Promise.resolve('recovered'))).resolves.toBe(
      'recovered',
    );
  });

  it('releases the registry lock when an action throws synchronously', async () => {
    const knowledgeRoot = await createKnowledgeRoot();
    await expect(
      withRegistryLock(knowledgeRoot, () => {
        throw new Error('synchronous action failure');
      }),
    ).rejects.toThrow('synchronous action failure');
    await expect(pathExists(join(knowledgeRoot, 'manifest.json.lock'))).resolves.toBe(false);
  });

  it('does not create a persistent ignore policy when the manifest is invalid', async () => {
    const knowledgeRoot = await createKnowledgeRoot();
    await writeFile(join(knowledgeRoot, 'manifest.json'), '{invalid json\n', 'utf8');
    await expect(
      addProject(knowledgeRoot, {
        displayName: 'Alpha',
        projectId: 'alpha',
        sourceRepository: 'https://example.test/alpha.git',
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
    await expect(pathExists(join(knowledgeRoot, '.gitignore'))).resolves.toBe(false);
  });

  it('rejects a semantically valid but non-canonical project order on read', async () => {
    const knowledgeRoot = await createKnowledgeRoot();
    await writeFile(
      join(knowledgeRoot, 'manifest.json'),
      `${JSON.stringify({
        projects: [
          {
            displayName: 'Zulu',
            path: 'projects/zulu',
            projectId: 'zulu',
            sourceRepository: 'https://example.test/zulu.git',
          },
          {
            displayName: 'Alpha',
            path: 'projects/alpha',
            projectId: 'alpha',
            sourceRepository: 'https://example.test/alpha.git',
          },
        ],
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      })}\n`,
      'utf8',
    );
    await expect(readManifest(knowledgeRoot)).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
  });

  it('validates every registered workspace when no project id is selected', async () => {
    const knowledgeRoot = await createKnowledgeRoot();
    for (const projectId of ['alpha', 'beta']) {
      await addProject(knowledgeRoot, {
        displayName: projectId,
        projectId,
        sourceRepository: `https://example.test/${projectId}.git`,
      });
    }
    await rm(join(knowledgeRoot, 'projects', 'beta', 'sources'), { recursive: true });
    await expect(validateProjectRegistry(knowledgeRoot)).rejects.toMatchObject({
      code: 'MANIFEST_INVALID',
    });
  });

  it('rejects ambiguous credentials and Windows drive-relative repository locators', () => {
    expect(() => validateRepositoryLocator('user:password@example.test:repo.git')).toThrow(
      /unsupported transport/u,
    );
    expect(() => validateRepositoryLocator('C:private-repo')).toThrow(/credential-free/u);
    expect(validateRepositoryLocator('example.test:repo.git')).toBe('example.test:repo.git');
  });

  it('caps project descriptor reads before parsing', async () => {
    const knowledgeRoot = await createKnowledgeRoot();
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    await writeFile(
      join(knowledgeRoot, 'projects', 'alpha', 'project.json'),
      'x'.repeat(64 * 1024 + 1),
      'utf8',
    );
    await expect(showProject(knowledgeRoot, 'alpha')).rejects.toMatchObject({
      code: 'MANIFEST_INVALID',
    });
  });

  it('rejects an oversized manifest before replacing the prior valid bytes', async () => {
    const knowledgeRoot = await createKnowledgeRoot();
    await writeManifest(knowledgeRoot, {
      projects: [],
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    });
    const before = await readFile(join(knowledgeRoot, 'manifest.json'), 'utf8');
    const projects = Array.from({ length: 8_000 }, (_, index) => {
      const projectId = `project-${index}`;
      return {
        displayName: `Project ${index}`,
        path: `projects/${projectId}`,
        projectId,
        sourceRepository: `https://example.test/${projectId}.git`,
      };
    });
    await expect(
      writeManifest(knowledgeRoot, {
        projects,
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
    await expect(readFile(join(knowledgeRoot, 'manifest.json'), 'utf8')).resolves.toBe(before);
  });

  it('returns structured recovery guidance for a read-only knowledge root', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const knowledgeRoot = await createKnowledgeRoot();
    await chmod(knowledgeRoot, 0o500);
    try {
      await expect(
        addProject(knowledgeRoot, {
          displayName: 'Alpha',
          projectId: 'alpha',
          sourceRepository: 'https://example.test/alpha.git',
        }),
      ).rejects.toMatchObject({
        code: 'REGISTRY_WRITE_FAILED',
        recoveryCommand: ['project', 'validate'],
      });
    } finally {
      await chmod(knowledgeRoot, 0o700);
    }
  });
});
