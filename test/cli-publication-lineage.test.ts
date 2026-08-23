import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CliPublicationIdentityError,
  createCliPublicationLineageResolver,
} from '../src/cli/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import type { PublicationInspectionPort } from '../src/knowledge/publication-inspection.js';
import { addProject } from '../src/knowledge/workspace.js';

const temporaryRoots: string[] = [];
const parentRevision = 'a'.repeat(40);
const invalidStampCases: readonly (readonly Readonly<Record<string, string>>[])[] = [
  [],
  [{ modelId: 'model-a' }],
  [{ modelId: 'https://private.example/model', promptVersion: 'prompt-v1' }],
  [{ modelId: 'model-a', promptVersion: 'token-secret' }],
];

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function inspector(): PublicationInspectionPort {
  return {
    inspectCommit: () => Promise.reject(new Error('unexpected')),
    inspectPushConfiguration: () => Promise.reject(new Error('unexpected')),
    inspectReferenceSnapshot: () => Promise.reject(new Error('unexpected')),
    inspectRepository: () => Promise.resolve({
      baseRevision: parentRevision,
      branchRef: 'refs/heads/main',
      indexEntries: [],
      indexSnapshotDigest: digest('index'),
      localUpstreamRevision: null,
      repositoryIdentityDigest: digest('repository'),
      repositoryRoot: 'not-presented',
    }),
    inspectWorktreePathIdentity: () => Promise.reject(new Error('unexpected')),
    readHeadFile: () => Promise.reject(new Error('unexpected')),
    readIndexBlob: () => Promise.reject(new Error('unexpected')),
    readWorktreeFile: () => Promise.reject(new Error('unexpected')),
  };
}

async function fixture(): Promise<Readonly<{ parentRoot: string; workspace: string }>> {
  const parentRoot = await mkdtemp(join(tmpdir(), 'buildlore-cli-lineage-'));
  temporaryRoots.push(parentRoot);
  const knowledgeRoot = join(parentRoot, 'knowledge');
  await mkdir(knowledgeRoot);
  const project = await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });
  return { parentRoot, workspace: join(knowledgeRoot, project.workspacePath) };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('CLI publication lineage resolver', () => {
  it('binds parent HEAD, configured profile/embedding, and ordered unique compile-time stamps', async () => {
    const { parentRoot, workspace } = await fixture();
    const resolver = createCliPublicationLineageResolver(parentRoot, {
      compilerExport: {
        exportProject: () => Promise.resolve({
          pageCount: 3,
          pages: [
            { body: 'must-not-be-hashed', modelId: 'model-b', promptVersion: 'prompt-v2' },
            { body: 'different-body', modelId: 'model-a', promptVersion: 'prompt-v1' },
            { body: 'third-body', modelId: 'model-b', promptVersion: 'prompt-v1' },
          ],
          projectId: 'alpha',
          schemaVersion: 1,
        }),
      },
      environment: { LLMWIKI_PROVIDER: 'openai', LLMWIKI_EMBEDDING_MODEL: 'embed-safe' },
      inspector: inspector(),
      profilePreflight: {
        resolve: () => Promise.resolve({ mode: 'default', outputLanguage: 'en', workspace }),
      },
    });

    const actual = await resolver.resolve('alpha');
    expect(actual).toEqual({
      codeRevision: parentRevision,
      embeddingCompatibilityDigest: digest(serializeCanonicalJson({
        compilerVersion: '1.1.0',
        modelId: 'embed-safe',
        providerId: 'openai',
      })),
      modelCompatibilityDigest: digest(serializeCanonicalJson({
        identities: ['model-a', 'model-b'],
        kind: 'compile-time-model-set',
        schemaVersion: 1,
      })),
      profileDigest: digest(serializeCanonicalJson({
        mode: 'default',
        outputLanguage: 'en',
        profileHash: null,
        profileId: null,
        profileVersion: 'llmwiki.default.v1',
      })),
      promptDigest: digest(serializeCanonicalJson({
        identities: ['prompt-v1', 'prompt-v2'],
        kind: 'compile-time-prompt-set',
        schemaVersion: 1,
      })),
    });
    expect(JSON.stringify(actual)).not.toContain('must-not-be-hashed');
    expect(JSON.stringify(actual)).not.toContain(workspace);
  });

  it.each(invalidStampCases)(
    'fails closed for empty, missing, or unsafe stamps without reflecting them',
    async (pages) => {
    const { parentRoot, workspace } = await fixture();
    const resolver = createCliPublicationLineageResolver(parentRoot, {
      compilerExport: {
        exportProject: () => Promise.resolve({
          pageCount: pages.length,
          pages,
          projectId: 'alpha',
          schemaVersion: 1,
        }),
      },
      environment: { LLMWIKI_PROVIDER: 'openai' },
      inspector: inspector(),
      profilePreflight: {
        resolve: () => Promise.resolve({ mode: 'default', outputLanguage: 'en', workspace }),
      },
    });

      await expect(resolver.resolve('alpha')).rejects.toEqual(new CliPublicationIdentityError());
    },
  );

  it('accepts boundary-safe identity words and rejects non-empty export warnings', async () => {
    const { parentRoot, workspace } = await fixture();
    const exportDocument = {
      pageCount: 1,
      pages: [{ modelId: 'author-model', promptVersion: 'tokenizer-v1' }],
      projectId: 'alpha',
      schemaVersion: 1,
      warnings: [] as string[],
    };
    const resolver = createCliPublicationLineageResolver(parentRoot, {
      compilerExport: { exportProject: () => Promise.resolve(exportDocument) },
      environment: { LLMWIKI_PROVIDER: 'openai' },
      inspector: inspector(),
      profilePreflight: {
        resolve: () => Promise.resolve({ mode: 'default', outputLanguage: 'en', workspace }),
      },
    });
    await expect(resolver.resolve('alpha')).resolves.toMatchObject({ codeRevision: parentRevision });
    exportDocument.warnings.push('incomplete-compile');
    await expect(resolver.resolve('alpha')).rejects.toEqual(new CliPublicationIdentityError());
  });
});
