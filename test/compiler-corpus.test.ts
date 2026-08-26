import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProjectCorpus,
  ProjectCorpusError,
} from '../src/compiler/corpus.js';
import { digestSessionValue, sessionSha256 } from '../src/compiler/session/canonical.js';
import {
  createSessionReviewStore,
  finalizeSessionPromotionProof,
} from '../src/compiler/session/review-store.js';
import type { CompilerCorpusBackend } from '../src/compiler/types.js';
import { addProject } from '../src/knowledge/index.js';
import {
  createBuildLoreLifecycleProfile,
  createProjectLifecycleProfile,
  renderLifecycleProfile,
} from '../src/profile/index.js';

const temporaryRoots: string[] = [];

function page(
  slug: string,
  options: {
    readonly archived?: boolean;
    readonly body?: string;
    readonly contradicted?: boolean;
    readonly citations?: readonly Readonly<Record<string, unknown>>[];
    readonly contentHash?: string;
    readonly freshnessStatus?: 'fresh' | 'stale' | 'unverified';
    readonly sourceHashes?: readonly string[];
    readonly sources?: readonly string[];
  } = {},
): Readonly<Record<string, unknown>> {
  return {
    archived: options.archived ?? false,
    body: options.body ?? `Safe compiled knowledge for ${slug}.`,
    citations: options.citations ?? [],
    contradicted: options.contradicted ?? false,
    contentHash: options.contentHash ?? 'a'.repeat(64),
    createdAt: '2026-08-21T00:00:00.000Z',
    freshnessStatus: options.freshnessStatus ?? 'fresh',
    links: [],
    pageDirectory: 'concepts',
    path: `wiki/concepts/${slug}.md`,
    slug,
    sourceHashes: options.sourceHashes ?? ['b'.repeat(64)],
    sources: options.sources ?? [`${slug}.md`],
    summary: `Summary for ${slug}.`,
    tags: [],
    title: `Title ${slug}`,
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

function document(projectId: string, pages: readonly Readonly<Record<string, unknown>>[]) {
  return {
    exportedAt: '2026-08-21T00:00:00.000Z',
    pageCount: pages.length,
    pages,
    projectId,
    schemaVersion: 1,
  };
}

async function fixture(backend: CompilerCorpusBackend) {
  const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-corpus-'));
  temporaryRoots.push(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });
  await addProject(knowledgeRoot, {
    displayName: 'Beta',
    projectId: 'beta',
    sourceRepository: 'https://example.test/beta.git',
  });
  return {
    corpus: createProjectCorpus({ backend, knowledgeRoot }),
    knowledgeRoot,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('project-scoped compiler corpus', () => {
  it('returns deterministic fresh verified pages and counts every excluded class', async () => {
    const exportProject = vi.fn(() => Promise.resolve(document('alpha', [
      page('zeta'),
      page('archived', { archived: true }),
      page('stale', { freshnessStatus: 'stale' }),
      page('unverified', { freshnessStatus: 'unverified' }),
      page('contradicted', { contradicted: true }),
      page('no-source', { sources: [] }),
      page('alpha'),
    ])));
    const { corpus, knowledgeRoot } = await fixture({ exportProject });

    await expect(corpus.snapshot('alpha')).resolves.toMatchObject({
      excluded: { archived: 1, orphaned: 0, stale: 1, unverified: 3 },
      pages: [
        { pageId: 'concepts/alpha', title: 'Title alpha' },
        { pageId: 'concepts/zeta', title: 'Title zeta' },
      ],
      projectId: 'alpha',
    });
    expect(exportProject).toHaveBeenCalledOnce();
    expect(exportProject).toHaveBeenCalledWith(
      join(knowledgeRoot, 'projects', 'alpha'),
      'alpha',
    );
    expect(JSON.stringify(await corpus.snapshot('alpha'))).not.toContain('projects/beta');
  });

  it('rejects a cross-project export identity and unsafe source reference', async () => {
    let raw: unknown = document('beta', [page('alpha')]);
    const { corpus } = await fixture({ exportProject: () => Promise.resolve(raw) });
    await expect(corpus.snapshot('alpha')).rejects.toMatchObject({
      code: 'CORPUS_CONTRACT_VIOLATION',
      projectId: 'alpha',
    });

    raw = document('alpha', [page('alpha', { sources: ['../beta/private.md'] })]);
    await expect(corpus.snapshot('alpha')).rejects.toMatchObject({
      code: 'CORPUS_CONTRACT_VIOLATION',
    });
  });

  it('admits an unverified imported page only while its exact promotion proof and source remain current', async () => {
    const compilerSourceId = `markdown--${'d'.repeat(64)}.md`;
    const sourceId = `source-${'b'.repeat(64)}`;
    const candidateId = `candidate-${'c'.repeat(64)}`;
    const sourceBody = 'Sanitized compiler source.\n';
    const sourceDigest = sessionSha256(sourceBody);
    const body = `Promoted evidence.^[${compilerSourceId}:4]`;
    const citations = [{ file: compilerSourceId, start: 4, end: 4 }];
    const promoted = page('promoted', {
      body,
      citations,
      contentHash: sessionSha256(body).slice('sha256:'.length),
      freshnessStatus: 'unverified',
      sourceHashes: [sourceDigest.slice('sha256:'.length)],
      sources: [compilerSourceId],
    });
    const { corpus, knowledgeRoot } = await fixture({
      exportProject: () => Promise.resolve(document('alpha', [promoted])),
    });
    const workspace = join(knowledgeRoot, 'projects', 'alpha');
    await writeFile(join(workspace, 'sources', compilerSourceId), sourceBody, 'utf8');
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.writeProof(finalizeSessionPromotionProof({
      projectId: 'alpha',
      candidateId,
      candidateDigest: `sha256:${'e'.repeat(64)}`,
      pageId: 'concepts/promoted',
      profileMode: 'default',
      bodyDigest: sessionSha256(body),
      titleDigest: sessionSha256('Title promoted'),
      summaryDigest: sessionSha256('Summary for promoted.'),
      sourceRefsDigest: digestSessionValue([compilerSourceId]),
      citationsDigest: digestSessionValue(citations),
      contentHash: sessionSha256(body).slice('sha256:'.length),
      sourceHashes: [sourceDigest.slice('sha256:'.length)],
      citationBindings: [{
        citationId: 'evidence',
        compilerSourceContentDigest: sourceDigest,
        compilerSourceId,
        originalFile: 'docs/evidence.md',
        originalLine: 4,
        quoteDigest: `sha256:${'f'.repeat(64)}`,
        sourceId,
      }],
      compilerSources: [{
        compilerSourceContentDigest: sourceDigest,
        compilerSourceId,
        sourceId,
      }],
    }));

    await expect(corpus.snapshot('alpha')).resolves.toMatchObject({
      excluded: { unverified: 0 },
      pages: [{ pageId: 'concepts/promoted' }],
    });

    await writeFile(join(workspace, 'sources', compilerSourceId), 'Changed source.\n', 'utf8');
    await expect(corpus.snapshot('alpha')).resolves.toMatchObject({
      excluded: { unverified: 1 },
      pages: [],
    });
  });

  it('reads only active verified entities from an applied lifecycle profile', async () => {
    const revision = `sha256:${'a'.repeat(64)}`;
    const entity = (
      entityType: 'decisions' | 'verifications',
      slug: string,
      status: string,
    ) => ({
      body: `Safe typed knowledge for ${slug}.`,
      directory: `wiki/${entityType}`,
      entityType,
      frontmatter: {
        archived: status === 'archived',
        confidence: 0.9,
        provenanceState: 'extracted',
        sourceRefs: [`repo@revision:docs/${slug}.md`],
        sourceRevision: revision,
        status,
        summary: `Summary for ${slug}.`,
        title: `Title ${slug}`,
      },
      id: `${entityType}/${slug}`,
      path: `wiki/${entityType}/${slug}.md`,
      slug,
    });
    const raw = {
      ...document('alpha', []),
      profile: {
        entityPages: [
          entity('verifications', 'recorded-check', 'recorded'),
          entity('decisions', 'archived-choice', 'archived'),
          entity('decisions', 'active-choice', 'active'),
          entity('verifications', 'passed-check', 'passed'),
        ],
        profileId: 'buildlore-lifecycle',
        version: 1,
      },
    };
    const { corpus, knowledgeRoot } = await fixture({
      exportProject: () => Promise.resolve(raw),
    });
    const workspace = join(knowledgeRoot, 'projects', 'alpha');
    await writeFile(
      join(workspace, 'profile.json'),
      renderLifecycleProfile(createBuildLoreLifecycleProfile('en')),
      'utf8',
    );
    const manager = createProjectLifecycleProfile({ knowledgeRoot });
    await manager.apply(await manager.plan('alpha'));

    await expect(corpus.snapshot('alpha')).resolves.toMatchObject({
      excluded: { archived: 1, orphaned: 0, stale: 0, unverified: 1 },
      pages: [
        { pageId: 'decisions/active-choice' },
        { pageId: 'verifications/passed-check' },
      ],
    });
  });

  it('hard-fails suspected secrets without reflecting the source value', async () => {
    const secret = ['gh', 'p_', 'A1b2C3d4E5f6G7h8J9k0', 'LmNoPq'].join('');
    const { corpus } = await fixture({
      exportProject: () => Promise.resolve(document('alpha', [
        page('alpha', { body: `Compiled page ${secret}` }),
      ])),
    });
    const failure = await corpus.snapshot('alpha').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProjectCorpusError);
    expect(failure).toMatchObject({ code: 'CORPUS_SECURITY_DENIED', projectId: 'alpha' });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it('rejects duplicate page identities and unsupported export warnings', async () => {
    let raw: unknown = document('alpha', [page('same'), page('same')]);
    const { corpus } = await fixture({ exportProject: () => Promise.resolve(raw) });
    await expect(corpus.snapshot('alpha')).rejects.toMatchObject({
      code: 'CORPUS_CONTRACT_VIOLATION',
    });

    raw = {
      ...document('alpha', [page('alpha')]),
      warnings: [{ code: 'future-warning', message: 'raw upstream detail' }],
    };
    const failure = await corpus.snapshot('alpha').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'CORPUS_CONTRACT_VIOLATION' });
    expect(JSON.stringify(failure)).not.toContain('raw upstream detail');
  });
});
