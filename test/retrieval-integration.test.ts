import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectCorpus } from '../src/compiler/corpus.js';
import type { ProjectCompilerPort } from '../src/compiler/index.js';
import { addProject } from '../src/knowledge/index.js';
import { createProjectRetrievalWithPorts } from '../src/retrieval/service.js';

const temporaryRoots: string[] = [];

function exportedPage(projectId: 'alpha' | 'beta') {
  return {
    archived: false,
    body: `${projectId.toUpperCase()}-ONLY compiled body.`,
    citations: [],
    contradicted: false,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-21T00:00:00.000Z',
    freshnessStatus: 'fresh',
    links: [],
    pageDirectory: 'concepts',
    path: 'wiki/concepts/shared-topic.md',
    slug: 'shared-topic',
    sourceHashes: ['b'.repeat(64)],
    sources: [`${projectId}.md`],
    summary: `${projectId} project summary.`,
    tags: [],
    title: `${projectId} architecture`,
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('provider-free project retrieval integration', () => {
  it('[V9-V-19][V10-V-11] reads only the selected confined corpus without provider work', async () => {
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-retrieval-integration-'));
    temporaryRoots.push(knowledgeRoot);
    for (const projectId of ['alpha', 'beta'] as const) {
      await addProject(knowledgeRoot, {
        displayName: projectId,
        projectId,
        sourceRepository: `https://example.test/${projectId}.git`,
      });
    }
    const exportProject = vi.fn((_workspace: string, projectId: string) => Promise.resolve({
      exportedAt: '2026-08-21T00:00:00.000Z',
      pageCount: 1,
      pages: [exportedPage(projectId as 'alpha' | 'beta')],
      projectId,
      schemaVersion: 1,
    }));
    const corpus = createProjectCorpus({ backend: { exportProject }, knowledgeRoot });
    const execute = vi.fn(() => Promise.reject(new Error('Provider must not be invoked.')));
    const compiler: ProjectCompilerPort = {
      execute,
      status: () => Promise.reject(new Error('Status must not be invoked.')),
    };
    const retrieval = createProjectRetrievalWithPorts({ compiler, corpus, environment: {} });

    const result = await retrieval.search({
      mode: 'lexical',
      projectId: 'alpha',
      query: 'alpha architecture',
    });

    expect(result).toMatchObject({
      hits: [{ pageId: 'concepts/shared-topic', score: 1, title: 'alpha architecture' }],
      projectId: 'alpha',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(exportProject).toHaveBeenCalledOnce();
    expect(exportProject).toHaveBeenCalledWith(
      join(knowledgeRoot, 'projects', 'alpha'),
      'alpha',
    );
    expect(JSON.stringify(result)).not.toMatch(/ALPHA-ONLY|BETA-ONLY|projects\/beta/u);
  });
});
