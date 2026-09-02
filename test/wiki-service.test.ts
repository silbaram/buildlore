import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectCorpusPort, SearchCorpus } from '../src/compiler/corpus.js';
import type { SessionReviewStore } from '../src/compiler/session/review-store.js';
import type { CompilerCorpusBackend, CompilerWikiBackend } from '../src/compiler/types.js';
import { addProject } from '../src/knowledge/index.js';
import {
  createSourceDocument,
  renderSourceDocument,
} from '../src/projector/source-document.js';
import {
  parseSourceDescriptor,
  SOURCE_DESCRIPTOR_SCHEMA_VERSION,
} from '../src/projector/source-contracts.js';
import {
  createWikiReadService,
} from '../src/wiki/index.js';

const temporaryRoots: string[] = [];

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function corpus(pageBody: string, sourceFile: string): ProjectCorpusPort {
  const snapshot: SearchCorpus = Object.freeze({
    excluded: Object.freeze({ archived: 0, orphaned: 0, stale: 0, unverified: 0 }),
    pages: Object.freeze([Object.freeze({
      body: pageBody,
      freshness: 'fresh' as const,
      pageId: 'concepts/local-search',
      sourceRefs: Object.freeze([sourceFile]),
      summary: 'Provider-free local search.',
      title: 'Local Search',
    })]),
    projectId: 'alpha',
    warnings: Object.freeze([]),
  });
  return Object.freeze({ snapshot: vi.fn(() => Promise.resolve(snapshot)) });
}

interface TestWikiBackend extends CompilerCorpusBackend, CompilerWikiBackend {
  readonly calls: Readonly<{
    readonly exportProject: number;
    readonly getProjectPage: number;
    readonly listProjectPages: number;
  }>;
}

function backend(input: {
  readonly pageBody: string;
  readonly sourceFile: string;
  readonly sourceHash: string;
}, exposeUnverified = false, citationLine = 2): TestWikiBackend {
  const callState = {
    exportProject: 0,
    getProjectPage: 0,
    listProjectPages: 0,
  };
  const sdkPage = {
    archived: false,
    body: input.pageBody,
    links: [],
    orphaned: false,
    pageDirectory: 'concepts',
    slug: 'local-search',
    summary: 'Provider-free local search.',
    tags: [],
    title: 'Local Search',
  };
  return {
    calls: callState,
    exportProject: () => {
      callState.exportProject += 1;
      return Promise.resolve({
        exportedAt: '2026-08-29T00:00:00.000Z',
        pageCount: 1,
        pages: [{
          ...sdkPage,
          citations: [{ end: citationLine, file: input.sourceFile, start: citationLine }],
          contentHash: sha256(input.pageBody).slice('sha256:'.length),
          createdAt: '2026-08-29T00:00:00.000Z',
          freshnessStatus: 'fresh',
          path: 'wiki/concepts/local-search.md',
          sourceHashes: [input.sourceHash],
          sources: [input.sourceFile],
          updatedAt: '2026-08-29T00:00:00.000Z',
        }],
        projectId: 'alpha',
        schemaVersion: 1,
      });
    },
    exportProjectOkf: () => Promise.resolve({}),
    getProjectPage: () => {
      callState.getProjectPage += 1;
      return Promise.resolve(sdkPage);
    },
    listProjectPages: () => {
      callState.listProjectPages += 1;
      return Promise.resolve({
        pages: exposeUnverified
          ? [{
              body: 'Unverified body.',
              pageDirectory: 'concepts',
              slug: 'unverified',
              summary: 'Unverified.',
              title: 'Unverified',
            }]
          : [sdkPage],
      });
    },
  };
}

async function fixture(): Promise<Readonly<{
  readonly knowledgeRoot: string;
  readonly pageBody: string;
  readonly changedSourceBytes: string;
  readonly sourceFile: string;
  readonly sourceHash: string;
}>> {
  const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-wiki-read-'));
  temporaryRoots.push(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });
  const workspace = join(knowledgeRoot, 'projects', 'alpha');
  await mkdir(join(workspace, 'sources'), { recursive: true });
  const original = 'export const localSearch = "portable";';
  const canonical = `\`\`\`typescript\n${original}\n\`\`\``;
  const revision = sha256(original);
  const sourceUri = 'buildlore+source:/https%3A%2F%2Fexample.test%2Falpha.git/alpha/code/code/docs%2Fsearch.ts';
  const descriptor = parseSourceDescriptor({
    adapterId: 'buildlore.generic',
    adapterVersion: 1,
    contentHash: revision,
    declarationId: 'code',
    kind: 'code',
    mediaType: 'text/x-source-code',
    projectId: 'alpha',
    schemaVersion: SOURCE_DESCRIPTOR_SCHEMA_VERSION,
    sourceRef: 'docs/search.ts',
    sourceRevision: revision,
    sourceUri,
  });
  const sourceFile = `code--${sha256(sourceUri).slice('sha256:'.length)}.md`;
  const document = createSourceDocument({
    body: canonical,
    descriptor,
    ingestedAt: '1970-01-01T00:00:00.000Z',
    originMappings: [{
      canonical: { endColumn: original.length + 1, endLine: 2, startColumn: 1, startLine: 2 },
      origin: { endColumn: original.length + 1, endLine: 1, startColumn: 1, startLine: 1 },
    }],
    producer: 'buildlore',
    projectId: 'alpha',
    source: sourceUri,
    sourceKind: 'code',
    sourceRevision: revision,
    sourceType: 'file',
    title: 'search',
  });
  const sourceBytes = renderSourceDocument(document);
  const changedOriginal = 'export const localSearch = "drifted";';
  const changedSourceBytes = renderSourceDocument(createSourceDocument({
    body: `\`\`\`typescript\n${changedOriginal}\n\`\`\``,
    descriptor,
    ingestedAt: '1970-01-01T00:00:00.000Z',
    originMappings: [{
      canonical: {
        endColumn: changedOriginal.length + 1,
        endLine: 2,
        startColumn: 1,
        startLine: 2,
      },
      origin: {
        endColumn: changedOriginal.length + 1,
        endLine: 1,
        startColumn: 1,
        startLine: 1,
      },
    }],
    producer: 'buildlore',
    projectId: 'alpha',
    source: sourceUri,
    sourceKind: 'code',
    sourceRevision: revision,
    sourceType: 'file',
    title: 'search',
  }));
  await writeFile(join(workspace, 'sources', sourceFile), sourceBytes);
  return {
    changedSourceBytes,
    knowledgeRoot,
    pageBody: 'Local retrieval uses a portable lexical index.',
    sourceFile,
    sourceHash: sha256(sourceBytes).slice('sha256:'.length),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('provider-free Wiki reads', () => {
  it('lists and reads only the verified project snapshot and maps citations to origin lines', async () => {
    const current = await fixture();
    const sdk = backend(current);
    const service = createWikiReadService({
      backend: sdk,
      corpus: corpus(current.pageBody, current.sourceFile),
      knowledgeRoot: current.knowledgeRoot,
      reviewStoreFactory: () => ({
        listProofs: () => Promise.resolve([]),
      }) as unknown as SessionReviewStore,
    });

    const snapshot = await service.snapshot('alpha');
    expect(snapshot.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(snapshot).toMatchObject({
      pages: [{
        citations: [{ sourceRef: 'docs/search.ts' }],
        pageRef: 'concepts/local-search',
      }],
      projectId: 'alpha',
    });

    await expect(service.list({ projectId: 'alpha' })).resolves.toMatchObject({
      pages: [{ pageRef: 'concepts/local-search', verified: true }],
      projectId: 'alpha',
      schemaVersion: 'buildlore.wiki-list.v1',
      total: 1,
    });
    await expect(service.read({
      pageRef: 'concepts/local-search',
      projectId: 'alpha',
    })).resolves.toMatchObject({
      body: current.pageBody,
      pageRef: 'concepts/local-search',
      sourceRefs: [current.sourceFile],
    });
    await expect(service.citations({
      pageRef: 'concepts/local-search',
      projectId: 'alpha',
    })).resolves.toMatchObject({
      citations: [{
        range: { endColumn: 39, endLine: 1, startColumn: 1, startLine: 1 },
        sourceRef: 'docs/search.ts',
      }],
      pageRef: 'concepts/local-search',
      projectId: 'alpha',
    });
    expect(sdk.calls.listProjectPages).toBeGreaterThan(0);
    expect(sdk.calls.getProjectPage).toBeGreaterThan(0);
    expect(sdk.calls.exportProject).toBeGreaterThan(0);
  });

  it('fails closed when the SDK exposes a page outside the verified snapshot', async () => {
    const current = await fixture();
    const sdk = backend(current, true);
    const service = createWikiReadService({
      backend: sdk,
      corpus: corpus(current.pageBody, current.sourceFile),
      knowledgeRoot: current.knowledgeRoot,
    });

    await expect(service.list({ projectId: 'alpha' })).rejects.toMatchObject({
      code: 'WIKI_CONTRACT_INVALID',
      projectId: 'alpha',
    });
  });

  it('rejects duplicate or non-canonical corpus page ordering', async () => {
    const current = await fixture();
    const stable = corpus(current.pageBody, current.sourceFile);
    const malformed: ProjectCorpusPort = {
      async snapshot(projectId) {
        const value = await stable.snapshot(projectId);
        return { ...value, pages: [...value.pages, ...value.pages] };
      },
    };
    const service = createWikiReadService({
      backend: backend(current),
      corpus: malformed,
      knowledgeRoot: current.knowledgeRoot,
    });

    await expect(service.list({ projectId: 'alpha' })).rejects.toMatchObject({
      code: 'WIKI_CONTRACT_INVALID',
    });
  });

  it('rejects an incomplete export fallback and stale promotion proofs', async () => {
    const current = await fixture();
    const sdk = backend(current);
    const incomplete = {
      ...sdk,
      exportProject: () => Promise.resolve({
        pages: [],
        projectId: 'alpha',
        schemaVersion: 1,
      }),
    };
    const incompleteService = createWikiReadService({
      backend: incomplete,
      corpus: corpus(current.pageBody, current.sourceFile),
      knowledgeRoot: current.knowledgeRoot,
      reviewStoreFactory: () => ({
        listProofs: () => Promise.resolve([]),
      }) as unknown as SessionReviewStore,
    });
    await expect(incompleteService.snapshot('alpha')).rejects.toMatchObject({
      code: 'WIKI_CONTRACT_INVALID',
    });

    const staleProofService = createWikiReadService({
      backend: sdk,
      corpus: corpus(current.pageBody, current.sourceFile),
      knowledgeRoot: current.knowledgeRoot,
      reviewStoreFactory: () => ({
        listProofs: () => Promise.resolve([{
          pageId: 'concepts/stale-page',
          projectId: 'alpha',
        }]),
      }) as unknown as SessionReviewStore,
    });
    await expect(staleProofService.snapshot('alpha')).rejects.toMatchObject({
      code: 'WIKI_CITATION_INVALID',
    });
  });

  it('rejects extra pages in the citation export inventory', async () => {
    const current = await fixture();
    const sdk = backend(current);
    const service = createWikiReadService({
      backend: {
        ...sdk,
        async exportProject(workspaceRoot, projectId) {
          const raw = await sdk.exportProject(workspaceRoot, projectId) as {
            readonly pages: readonly Record<string, unknown>[];
          } & Record<string, unknown>;
          const page = raw.pages[0];
          if (page === undefined) throw new Error('export page fixture is missing');
          return {
            ...raw,
            pageCount: 2,
            pages: [...raw.pages, { ...page, slug: 'foreign-page' }],
          };
        },
      },
      corpus: corpus(current.pageBody, current.sourceFile),
      knowledgeRoot: current.knowledgeRoot,
    });

    await expect(service.citations({
      pageRef: 'concepts/local-search',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'WIKI_CONTRACT_INVALID' });
  });

  it('rejects a proof inventory that changes before a snapshot is returned', async () => {
    const current = await fixture();
    let proofReads = 0;
    const service = createWikiReadService({
      backend: backend(current),
      corpus: corpus(current.pageBody, current.sourceFile),
      knowledgeRoot: current.knowledgeRoot,
      reviewStoreFactory: () => ({
        listProofs: () => {
          proofReads += 1;
          return Promise.resolve(proofReads === 1 ? [] : [{
            pageId: 'concepts/stale-page',
            projectId: 'alpha',
          }]);
        },
      }) as unknown as SessionReviewStore,
    });

    await expect(service.snapshot('alpha')).rejects.toMatchObject({
      code: 'WIKI_SNAPSHOT_CHANGED',
    });
  });

  it('rejects a project profile binding that changes during a read', async () => {
    const current = await fixture();
    const stableCorpus = corpus(current.pageBody, current.sourceFile);
    let corpusReads = 0;
    const driftingCorpus: ProjectCorpusPort = {
      async snapshot(projectId) {
        corpusReads += 1;
        const snapshot = await stableCorpus.snapshot(projectId);
        if (corpusReads === 2) {
          await writeFile(
            join(current.knowledgeRoot, 'projects/alpha/profile-binding.json'),
            '{}\n',
          );
        }
        return snapshot;
      },
    };
    const service = createWikiReadService({
      backend: backend(current),
      corpus: driftingCorpus,
      knowledgeRoot: current.knowledgeRoot,
    });

    await expect(service.read({
      pageRef: 'concepts/local-search',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'WIKI_SNAPSHOT_CHANGED' });
  });

  it('rejects citations that target the canonical trailing newline sentinel', async () => {
    const current = await fixture();
    const service = createWikiReadService({
      backend: backend(current, false, 4),
      corpus: corpus(current.pageBody, current.sourceFile),
      knowledgeRoot: current.knowledgeRoot,
      reviewStoreFactory: () => ({
        listProofs: () => Promise.resolve([]),
      }) as unknown as SessionReviewStore,
    });

    await expect(service.citations({
      pageRef: 'concepts/local-search',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'WIKI_CITATION_INVALID' });
  });

  it('rejects an export fallback citation to a valid but page-unbound source', async () => {
    const current = await fixture();
    const unrelated = `markdown--${'b'.repeat(64)}.md`;
    const service = createWikiReadService({
      backend: backend(current),
      corpus: corpus(current.pageBody, unrelated),
      knowledgeRoot: current.knowledgeRoot,
      reviewStoreFactory: () => ({
        listProofs: () => Promise.resolve([]),
      }) as unknown as SessionReviewStore,
    });

    await expect(service.citations({
      pageRef: 'concepts/local-search',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'WIKI_CONTRACT_INVALID' });
  });

  it('rejects an export fallback citation after its recorded compiler source drifts', async () => {
    const current = await fixture();
    await writeFile(
      join(current.knowledgeRoot, 'projects/alpha/sources', current.sourceFile),
      current.changedSourceBytes,
    );
    const service = createWikiReadService({
      backend: backend(current),
      corpus: corpus(current.pageBody, current.sourceFile),
      knowledgeRoot: current.knowledgeRoot,
      reviewStoreFactory: () => ({
        listProofs: () => Promise.resolve([]),
      }) as unknown as SessionReviewStore,
    });

    await expect(service.citations({
      pageRef: 'concepts/local-search',
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'WIKI_CITATION_INVALID' });
  });
});
