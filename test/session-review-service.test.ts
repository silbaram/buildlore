import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { createProjectCompiler } from '../src/compiler/service.js';
import {
  renderSessionOkfPage,
  renderSessionTypedPage,
} from '../src/compiler/session/admission.js';
import { sessionSha256 } from '../src/compiler/session/canonical.js';
import {
  createSessionReviewCandidate,
  createSessionReviewStore,
  type SessionReviewStore,
} from '../src/compiler/session/review-store.js';
import {
  createSessionReviewService,
  type SessionReviewServicePort,
} from '../src/compiler/session/review-service.js';
import type { SessionCompilePlanSnapshot } from '../src/compiler/session/source-planner.js';
import {
  SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
  SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION,
  type SessionCompileProposalV1,
  type SessionCompileProvenanceV1,
} from '../src/compiler/session/types.js';
import type { ValidatedSessionBatch } from '../src/compiler/session/validator.js';
import { addProject } from '../src/knowledge/index.js';
import { createProjectRetrieval } from '../src/retrieval/index.js';

const temporaryRoots: string[] = [];
const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SOURCE_ID = `source-${'b'.repeat(64)}` as const;
const COMPILER_SOURCE_ID = `markdown--${'d'.repeat(64)}.md` as const;
const COMPILER_SOURCE_BODY = 'Stored sanitized compiler source.\n';
const COMPILER_SOURCE_DIGEST = sessionSha256(COMPILER_SOURCE_BODY);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function batch(): ValidatedSessionBatch {
  const proposal: SessionCompileProposalV1 = {
    schemaVersion: SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
    projectId: 'alpha',
    planDigest: DIGEST,
    proposalId: 'proposal-review-service',
    proposalDigest: DIGEST,
    taskId: `task-${'c'.repeat(64)}`,
    mergeCandidateIds: [],
    pageId: 'concepts/session-concept',
    slug: 'session-concept',
    title: 'Session output',
    kind: 'concept',
    summary: 'Review-only session output.',
    body: 'Evidence.[^evidence]',
    sources: [SOURCE_ID],
    wikilinks: [],
    citations: [{
      file: 'docs/evidence.md',
      id: 'evidence',
      line: 4,
      quote: 'Evidence.',
      sourceId: SOURCE_ID,
    }],
    confidence: 0.75,
    callerHarness: { compatibilityDigest: DIGEST, kind: 'codex', version: '1.0.0' },
  };
  const provenance: SessionCompileProvenanceV1 = {
    schemaVersion: SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION,
    projectId: 'alpha',
    planDigest: DIGEST,
    proposalDigest: DIGEST,
    sourceManifestDigest: DIGEST,
    profileDigest: DIGEST,
    policyDigest: DIGEST,
    callerHarness: proposal.callerHarness,
    contractDigest: DIGEST,
    bindingDigest: DIGEST,
  };
  return Object.freeze({
    batchDigest: DIGEST,
    harness: proposal.callerHarness,
    pages: Object.freeze([Object.freeze({
      proposal,
      provenance,
      citationBindings: Object.freeze([Object.freeze({
        citationId: 'evidence',
        compilerSourceContentDigest: COMPILER_SOURCE_DIGEST,
        compilerSourceId: COMPILER_SOURCE_ID,
        originalFile: 'docs/evidence.md',
        originalLine: 4,
        quoteDigest: DIGEST,
        sourceId: SOURCE_ID,
      })]),
      compilerSources: Object.freeze([Object.freeze({
        compilerSourceContentDigest: COMPILER_SOURCE_DIGEST,
        compilerSourceId: COMPILER_SOURCE_ID,
        sourceId: SOURCE_ID,
      })]),
    })]),
  });
}

function snapshot(workspace: string): SessionCompilePlanSnapshot {
  return {
    workspace,
    profileMode: 'default',
    pendingSlugs: new Set<string>(),
    plan: {
      projectId: 'alpha',
      profileDigest: DIGEST,
      policyDigest: DIGEST,
      sourceManifestDigest: DIGEST,
      contractDigest: DIGEST,
      allowedLinkTargets: [],
      sources: [{
        sourceId: SOURCE_ID,
        compilerSourceId: COMPILER_SOURCE_ID,
        compilerSourceContentDigest: COMPILER_SOURCE_DIGEST,
      }],
    },
  } as unknown as SessionCompilePlanSnapshot;
}

function reviewCandidate(profileMode: 'custom' | 'default' = 'default') {
  const validated = batch();
  const page = validated.pages[0];
  if (page === undefined) throw new Error('missing test page');
  return createSessionReviewCandidate({
    batch: validated,
    page,
    profileMode,
    renderedPage: profileMode === 'default'
      ? renderSessionOkfPage(page)
      : renderSessionTypedPage(page),
    ...(profileMode === 'custom' ? { upstreamCandidateId: 'upstream-review-candidate' } : {}),
  });
}

function renderedParts(renderedPage: string): Readonly<{
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}> {
  const marker = '\n---\n';
  const end = renderedPage.indexOf(marker, 4);
  if (!renderedPage.startsWith('---\n') || end < 0) {
    throw new Error('invalid rendered page fixture');
  }
  const parsed: unknown = parse(renderedPage.slice(4, end)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('invalid rendered frontmatter fixture');
  }
  return Object.freeze({
    body: renderedPage.slice(end + marker.length),
    frontmatter: parsed,
  });
}

function defaultExportPage(candidate = reviewCandidate()): Readonly<Record<string, unknown>> {
  const rendered = renderedParts(candidate.renderedPage);
  if (typeof rendered.frontmatter.title !== 'string' ||
      typeof rendered.frontmatter.description !== 'string') {
    throw new Error('invalid default frontmatter fixture');
  }
  return Object.freeze({
    path: `wiki/${candidate.pageId}.md`,
    body: rendered.body,
    title: rendered.frontmatter.title,
    summary: rendered.frontmatter.description,
    contentHash: sessionSha256(rendered.body).slice('sha256:'.length),
    sources: candidate.compilerSources.map((source) => source.compilerSourceId),
    sourceHashes: candidate.compilerSources.map((source) =>
      source.compilerSourceContentDigest.slice('sha256:'.length)),
    citations: candidate.citationBindings.map((binding) => ({
      file: binding.compilerSourceId,
      start: binding.originalLine,
      end: binding.originalLine,
    })),
  });
}

function defaultExportDocument(
  candidate = reviewCandidate(),
  page: unknown = defaultExportPage(candidate),
): Readonly<Record<string, unknown>> {
  return Object.freeze({ schemaVersion: 1, projectId: candidate.projectId, pages: [page] });
}

function customExportDocument(candidate = reviewCandidate('custom')): Readonly<Record<string, unknown>> {
  const rendered = renderedParts(candidate.renderedPage);
  return Object.freeze({
    schemaVersion: 1,
    projectId: candidate.projectId,
    profile: Object.freeze({
      entityPages: Object.freeze([Object.freeze({
        id: candidate.pageId,
        body: rendered.body,
        frontmatter: rendered.frontmatter,
      })]),
    }),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('session review service', () => {
  it('creates a deterministic candidate once under concurrent staging', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-race-'));
    temporaryRoots.push(workspace);
    const validated = batch();
    const page = validated.pages[0];
    if (page === undefined) throw new Error('missing test page');
    const candidate = createSessionReviewCandidate({
      batch: validated,
      page,
      profileMode: 'default',
      renderedPage: renderSessionOkfPage(page),
    });

    const results = await Promise.allSettled([
      createSessionReviewStore(workspace, 'alpha').stage([candidate]),
      createSessionReviewStore(workspace, 'alpha').stage([candidate]),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: {
        candidateRefs: [candidate.candidateId],
        code: 'SESSION_CANDIDATE_DUPLICATE',
      },
      status: 'rejected',
    });
    await expect(createSessionReviewStore(workspace, 'alpha').list())
      .resolves.toMatchObject([{ candidate: { candidateDigest: candidate.candidateDigest } }]);
  });

  it('lists safe summaries, approves exactly one default candidate, and preserves proof bindings', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-'));
    temporaryRoots.push(workspace);
    const validated = batch();
    const page = validated.pages[0];
    if (page === undefined) throw new Error('missing test page');
    const candidate = createSessionReviewCandidate({
      batch: validated,
      page,
      profileMode: 'default',
      renderedPage: renderSessionOkfPage(page),
    });
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.stage([candidate]);

    let live = false;
    const body = `Evidence.^[${COMPILER_SOURCE_ID}:4]\n`;
    const exportPage = {
      path: 'wiki/concepts/session-concept.md',
      body,
      title: 'Session output',
      summary: 'Review-only session output.',
      contentHash: sessionSha256(body).slice('sha256:'.length),
      sources: [COMPILER_SOURCE_ID],
      sourceHashes: [COMPILER_SOURCE_DIGEST.slice('sha256:'.length)],
      citations: [{ file: COMPILER_SOURCE_ID, start: 4, end: 4 }],
    };
    const importOkf = vi.fn<SessionReviewServicePort['importOkf']>(() => {
      live = true;
      return Promise.resolve();
    });
    const port: SessionReviewServicePort = {
      exportJson: (_workspace, projectId) => Promise.resolve({
        schemaVersion: 1,
        projectId,
        pages: live ? [exportPage] : [],
      }),
      importOkf,
      promoteStagedPage: () => Promise.reject(new Error('unexpected custom promotion')),
    };
    const service = createSessionReviewService({ port });

    await expect(service.list(workspace, 'alpha')).resolves.toMatchObject({
      legacyPendingCount: 0,
      managedPendingCount: 1,
      candidates: [{
        candidateId: candidate.candidateId,
        lifecycle: 'pending',
        pageId: candidate.pageId,
        targetPath: candidate.target,
      }],
    });
    await expect(service.approve(
      workspace,
      'alpha',
      candidate.candidateId,
      () => Promise.resolve(snapshot(workspace)),
    )).resolves.toMatchObject({
      candidateId: candidate.candidateId,
      outcome: 'approved',
      pageId: candidate.pageId,
      providerUsed: false,
    });
    expect(importOkf).toHaveBeenCalledOnce();
    expect(importOkf.mock.calls[0]?.[2]).toEqual({ trusted: true });
    await expect(store.list()).resolves.toEqual([]);
    const proofs = await store.listProofs();
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({
      candidateId: candidate.candidateId,
      citationBindings: [{
        compilerSourceId: COMPILER_SOURCE_ID,
        originalFile: 'docs/evidence.md',
        originalLine: 4,
        quoteDigest: DIGEST,
      }],
      compilerSources: [{ compilerSourceId: COMPILER_SOURCE_ID }],
      pageId: candidate.pageId,
    });
    await expect(service.approve(
      workspace,
      'alpha',
      candidate.candidateId,
      () => Promise.resolve(snapshot(workspace)),
    )).rejects.toMatchObject({ code: 'SESSION_CANDIDATE_ALREADY_APPROVED' });
  });

  it('recovers an exact approving candidate before refreshing a stale snapshot', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-recover-'));
    temporaryRoots.push(workspace);
    const candidate = reviewCandidate();
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.stage([candidate]);
    await store.claim(candidate.candidateId);
    const refreshSnapshot = vi.fn<() => Promise<SessionCompilePlanSnapshot>>(() =>
      Promise.reject(new Error('stale snapshot must not be read')));
    const importOkf = vi.fn<SessionReviewServicePort['importOkf']>(() =>
      Promise.reject(new Error('mutation must not be repeated')));
    const service = createSessionReviewService({
      port: {
        exportJson: () => Promise.resolve(defaultExportDocument(candidate)),
        importOkf,
        promoteStagedPage: () => Promise.reject(new Error('mutation must not be repeated')),
      },
    });

    await expect(service.approve(
      workspace,
      'alpha',
      candidate.candidateId,
      refreshSnapshot,
    )).resolves.toMatchObject({
      candidateId: candidate.candidateId,
      outcome: 'approved',
      providerUsed: false,
      sideEffectsPossible: false,
      warnings: [{ code: 'recovered-approving-candidate' }],
    });
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect(importOkf).not.toHaveBeenCalled();
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.listProofs()).resolves.toMatchObject([{
      candidateId: candidate.candidateId,
      pageId: candidate.pageId,
    }]);
    await expect(service.approve(
      workspace,
      'alpha',
      candidate.candidateId,
      refreshSnapshot,
    )).rejects.toMatchObject({ code: 'SESSION_CANDIDATE_ALREADY_APPROVED' });
  });

  it('classifies default export mismatches without exposing compared values', async () => {
    const sensitive = 'private-mismatch-value';
    const baseCandidate = reviewCandidate();
    const basePage = defaultExportPage(baseCandidate);
    const baseDocument = defaultExportDocument(baseCandidate, basePage);
    const cases: readonly Readonly<{
      readonly document: unknown;
      readonly fields: readonly string[];
      readonly mismatchKind: string;
      readonly name: string;
    }>[] = [
      { name: 'document', document: null, mismatchKind: 'export-shape', fields: ['document'] },
      {
        name: 'schema version',
        document: { ...baseDocument, schemaVersion: 2 },
        mismatchKind: 'schema-version',
        fields: ['schemaVersion'],
      },
      {
        name: 'project binding',
        document: { ...baseDocument, projectId: 'beta' },
        mismatchKind: 'project-binding',
        fields: ['projectId'],
      },
      {
        name: 'page cardinality',
        document: { ...baseDocument, pages: [basePage, basePage] },
        mismatchKind: 'page-cardinality',
        fields: ['page'],
      },
      {
        name: 'page shape',
        document: defaultExportDocument(baseCandidate, { ...basePage, title: null }),
        mismatchKind: 'page-shape',
        fields: ['title'],
      },
      ...([
        ['body', { ...basePage, body: sensitive }],
        ['title', { ...basePage, title: sensitive }],
        ['summary', { ...basePage, summary: sensitive }],
        ['sourceRefs', { ...basePage, sources: ['different-source'] }],
        ['sourceHashes', { ...basePage, sourceHashes: ['e'.repeat(64)] }],
        ['citations', { ...basePage, citations: [] }],
        ['contentHash', { ...basePage, contentHash: 'e'.repeat(64) }],
      ] as const).map(([field, page]) => ({
        name: field,
        document: defaultExportDocument(baseCandidate, page),
        mismatchKind: 'field-value',
        fields: [field],
      })),
    ];

    for (const mismatchCase of cases) {
      const workspace = await mkdtemp(join(
        process.cwd(),
        `.test-tmp-session-review-mismatch-${mismatchCase.name.replaceAll(' ', '-')}-`,
      ));
      temporaryRoots.push(workspace);
      const candidate = reviewCandidate();
      const store = createSessionReviewStore(workspace, 'alpha');
      await store.stage([candidate]);
      await store.claim(candidate.candidateId);
      const refreshSnapshot = vi.fn(() => Promise.resolve(snapshot(workspace)));
      const service = createSessionReviewService({
        port: {
          exportJson: () => Promise.resolve(mismatchCase.document),
          importOkf: () => Promise.reject(new Error('unexpected mutation')),
          promoteStagedPage: () => Promise.reject(new Error('unexpected mutation')),
        },
      });

      const error = await service.approve(
        workspace,
        'alpha',
        candidate.candidateId,
        refreshSnapshot,
      ).catch((reason: unknown) => reason);
      expect(error, mismatchCase.name).toMatchObject({
        code: 'SESSION_CANDIDATE_RECOVERY_REQUIRED',
        exportInspection: {
          fields: mismatchCase.fields,
          mismatchKind: mismatchCase.mismatchKind,
        },
        recoveryAction: 'status',
        sideEffectsPossible: true,
      });
      expect(refreshSnapshot, mismatchCase.name).not.toHaveBeenCalled();
      expect(JSON.stringify(error), mismatchCase.name).not.toContain(sensitive);
      await expect(store.list()).resolves.toMatchObject([{
        lifecycle: 'approving',
        candidate: { candidateId: candidate.candidateId },
      }]);
      await expect(store.listProofs()).resolves.toEqual([]);
    }
  });

  it('classifies custom export mismatches and recovers only an exact export', async () => {
    const candidate = reviewCandidate('custom');
    const exactDocument = customExportDocument(candidate);
    const profile = exactDocument.profile;
    const entityPages: unknown = isRecord(profile) ? profile.entityPages : undefined;
    if (!Array.isArray(entityPages) || entityPages.length !== 1) {
      throw new Error('invalid custom export fixture');
    }
    const exactPage: unknown = entityPages[0];
    if (!isRecord(exactPage) || !isRecord(exactPage.frontmatter)) {
      throw new Error('invalid custom page fixture');
    }
    const sensitive = 'private-custom-mismatch-value';
    const customDocument = (page: unknown): unknown => ({
      ...exactDocument,
      profile: { entityPages: [page] },
    });
    const cases: readonly Readonly<{
      readonly document: unknown;
      readonly fields: readonly string[];
      readonly mismatchKind: string;
      readonly name: string;
    }>[] = [
      { name: 'document', document: null, mismatchKind: 'export-shape', fields: ['document'] },
      {
        name: 'schema version',
        document: { ...exactDocument, schemaVersion: 2 },
        mismatchKind: 'schema-version',
        fields: ['schemaVersion'],
      },
      {
        name: 'project binding',
        document: { ...exactDocument, projectId: 'beta' },
        mismatchKind: 'project-binding',
        fields: ['projectId'],
      },
      {
        name: 'page collection',
        document: { ...exactDocument, profile: {} },
        mismatchKind: 'export-shape',
        fields: ['pageCollection'],
      },
      {
        name: 'page cardinality',
        document: { ...exactDocument, profile: { entityPages: [exactPage, exactPage] } },
        mismatchKind: 'page-cardinality',
        fields: ['page'],
      },
      {
        name: 'body shape',
        document: customDocument({ ...exactPage, body: null }),
        mismatchKind: 'page-shape',
        fields: ['body'],
      },
      {
        name: 'frontmatter shape',
        document: customDocument({ ...exactPage, frontmatter: null }),
        mismatchKind: 'page-shape',
        fields: ['frontmatter', 'sourceRefs'],
      },
      {
        name: 'title shape',
        document: customDocument({
          ...exactPage,
          frontmatter: { ...exactPage.frontmatter, title: null },
        }),
        mismatchKind: 'page-shape',
        fields: ['title'],
      },
      {
        name: 'summary shape',
        document: customDocument({
          ...exactPage,
          frontmatter: { ...exactPage.frontmatter, summary: null },
        }),
        mismatchKind: 'page-shape',
        fields: ['summary'],
      },
      {
        name: 'source refs shape',
        document: customDocument({
          ...exactPage,
          frontmatter: { ...exactPage.frontmatter, sourceRefs: null },
        }),
        mismatchKind: 'page-shape',
        fields: ['sourceRefs'],
      },
      {
        name: 'body value',
        document: customDocument({ ...exactPage, body: sensitive }),
        mismatchKind: 'field-value',
        fields: ['body'],
      },
      {
        name: 'frontmatter value',
        document: customDocument({
          ...exactPage,
          frontmatter: { ...exactPage.frontmatter, additionalField: sensitive },
        }),
        mismatchKind: 'field-value',
        fields: ['frontmatter'],
      },
      ...([
        ['title', { ...exactPage.frontmatter, title: sensitive }],
        ['summary', { ...exactPage.frontmatter, summary: sensitive }],
        ['sourceRefs', { ...exactPage.frontmatter, sourceRefs: [sensitive] }],
      ] as const).map(([field, frontmatter]) => ({
        name: `${field} value`,
        document: customDocument({ ...exactPage, frontmatter }),
        mismatchKind: 'field-value',
        fields: ['frontmatter', field],
      })),
    ];
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-custom-'));
    temporaryRoots.push(workspace);
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.stage([candidate]);
    await store.claim(candidate.candidateId);
    for (const mismatchCase of cases) {
      const mismatchService = createSessionReviewService({
        port: {
          exportJson: () => Promise.resolve(mismatchCase.document),
          importOkf: () => Promise.reject(new Error('unexpected default mutation')),
          promoteStagedPage: () => Promise.reject(new Error('unexpected custom mutation')),
        },
      });
      const error = await mismatchService.approve(
        workspace,
        'alpha',
        candidate.candidateId,
        () => Promise.reject(new Error('snapshot must not be read')),
      ).catch((reason: unknown) => reason);
      expect(error, mismatchCase.name).toMatchObject({
        code: 'SESSION_CANDIDATE_RECOVERY_REQUIRED',
        exportInspection: {
          fields: mismatchCase.fields,
          mismatchKind: mismatchCase.mismatchKind,
        },
      });
      expect(JSON.stringify(error), mismatchCase.name).not.toContain(sensitive);
    }
    const exactService = createSessionReviewService({
      port: {
        exportJson: () => Promise.resolve(exactDocument),
        importOkf: () => Promise.reject(new Error('unexpected default mutation')),
        promoteStagedPage: () => Promise.reject(new Error('unexpected custom mutation')),
      },
    });
    await expect(exactService.approve(
      workspace,
      'alpha',
      candidate.candidateId,
      () => Promise.reject(new Error('snapshot must not be read')),
    )).resolves.toMatchObject({
      outcome: 'approved',
      warnings: [{ code: 'recovered-approving-candidate' }],
    });
    await expect(store.listProofs()).resolves.toHaveLength(1);
  });

  it('restores an absent approving candidate before enforcing the current snapshot', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-absent-'));
    temporaryRoots.push(workspace);
    const candidate = reviewCandidate();
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.stage([candidate]);
    await store.claim(candidate.candidateId);
    const stale = snapshot(workspace);
    const service = createSessionReviewService({
      port: {
        exportJson: () => Promise.resolve({ schemaVersion: 1, projectId: 'alpha', pages: [] }),
        importOkf: () => Promise.reject(new Error('unexpected mutation')),
        promoteStagedPage: () => Promise.reject(new Error('unexpected mutation')),
      },
    });

    await expect(service.approve(
      workspace,
      'alpha',
      candidate.candidateId,
      () => Promise.resolve({
        ...stale,
        plan: { ...stale.plan, policyDigest: `sha256:${'f'.repeat(64)}` },
      } as SessionCompilePlanSnapshot),
    )).rejects.toMatchObject({ code: 'SESSION_CANDIDATE_STALE' });
    await expect(store.list()).resolves.toMatchObject([{
      lifecycle: 'pending',
      candidate: { candidateId: candidate.candidateId },
    }]);
    await expect(store.listProofs()).resolves.toEqual([]);
  });

  it('keeps an approving candidate fail-closed when the live export is unavailable', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-unavailable-'));
    temporaryRoots.push(workspace);
    const candidate = reviewCandidate();
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.stage([candidate]);
    await store.claim(candidate.candidateId);
    const sensitive = 'private-export-provider-detail';
    const refreshSnapshot = vi.fn(() => Promise.resolve(snapshot(workspace)));
    const service = createSessionReviewService({
      port: {
        exportJson: () => Promise.reject(new Error(sensitive)),
        importOkf: () => Promise.reject(new Error('unexpected mutation')),
        promoteStagedPage: () => Promise.reject(new Error('unexpected mutation')),
      },
    });

    const error = await service.approve(
      workspace,
      'alpha',
      candidate.candidateId,
      refreshSnapshot,
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: 'SESSION_CANDIDATE_RECOVERY_REQUIRED',
      exportInspection: undefined,
      recoveryAction: 'status',
      sideEffectsPossible: true,
    });
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain(sensitive);
    await expect(store.list()).resolves.toMatchObject([{
      lifecycle: 'approving',
      candidate: { candidateId: candidate.candidateId },
    }]);
    await expect(store.listProofs()).resolves.toEqual([]);
  });

  it('keeps proof completion failures partial and retries the same proof idempotently', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-complete-'));
    temporaryRoots.push(workspace);
    const candidate = reviewCandidate();
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.stage([candidate]);
    await store.claim(candidate.candidateId);
    const sensitive = 'private-candidate-completion-detail';
    const complete = vi.fn<SessionReviewStore['complete']>(() => Promise.reject(
      new Error(sensitive),
    ));
    const failingStore: SessionReviewStore = Object.freeze({ ...store, complete });
    const service = createSessionReviewService({
      storeFactory: () => failingStore,
      port: {
        exportJson: () => Promise.resolve(defaultExportDocument(candidate)),
        importOkf: () => Promise.reject(new Error('unexpected mutation')),
        promoteStagedPage: () => Promise.reject(new Error('unexpected mutation')),
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await service.approve(
        workspace,
        'alpha',
        candidate.candidateId,
        () => Promise.reject(new Error('snapshot must not be read')),
      ).catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        candidateRefs: [candidate.candidateId],
        code: 'SESSION_CANDIDATE_RECOVERY_REQUIRED',
        recoveryAction: 'status',
        sideEffectsPossible: true,
      });
      expect(JSON.stringify(error)).not.toContain(sensitive);
      await expect(store.listProofs()).resolves.toHaveLength(1);
      await expect(store.list()).resolves.toMatchObject([{
        lifecycle: 'approving',
        candidate: { candidateId: candidate.candidateId },
      }]);
    }
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('preserves bounded mismatch diagnostics when temporary cleanup also fails', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-cleanup-'));
    temporaryRoots.push(workspace);
    const candidate = reviewCandidate();
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.stage([candidate]);
    const sensitive = 'private-cleanup-detail';
    let cleanupPath: string | undefined;
    const exportJson = vi.fn<SessionReviewServicePort['exportJson']>()
      .mockResolvedValueOnce(defaultExportDocument(candidate, {
        ...defaultExportPage(candidate),
        body: 'changed-body',
      }))
      .mockResolvedValue(defaultExportDocument(candidate, {
        ...defaultExportPage(candidate),
        title: 'changed-title',
      }));
    const service = createSessionReviewService({
      removeTemporary: (path) => {
        cleanupPath = path;
        return Promise.reject(new Error(sensitive));
      },
      port: {
        exportJson,
        importOkf: () => Promise.resolve(undefined),
        promoteStagedPage: () => Promise.reject(new Error('unexpected mutation')),
      },
    });

    try {
      const error = await service.approve(
        workspace,
        'alpha',
        candidate.candidateId,
        () => Promise.resolve(snapshot(workspace)),
      ).catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        candidateRefs: [candidate.candidateId],
        code: 'SESSION_CANDIDATE_RECOVERY_REQUIRED',
        exportInspection: { fields: ['body'], mismatchKind: 'field-value' },
        recoveryAction: 'status',
        sideEffectsPossible: true,
      });
      expect(JSON.stringify(error)).not.toContain(sensitive);
      await expect(store.list()).resolves.toMatchObject([{
        lifecycle: 'approving',
        candidate: { candidateId: candidate.candidateId },
      }]);
      await expect(store.listProofs()).resolves.toEqual([]);
      expect(exportJson).toHaveBeenCalledTimes(2);
    } finally {
      if (cleanupPath !== undefined) await rm(cleanupPath, { force: true, recursive: true });
    }
  });

  it('restores a claimed candidate when the SDK fails before a live write', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-fail-'));
    temporaryRoots.push(workspace);
    const validated = batch();
    const page = validated.pages[0];
    if (page === undefined) throw new Error('missing test page');
    const candidate = createSessionReviewCandidate({
      batch: validated,
      page,
      profileMode: 'default',
      renderedPage: renderSessionOkfPage(page),
    });
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.stage([candidate]);
    const service = createSessionReviewService({
      port: {
        exportJson: (_workspace, projectId) => Promise.resolve({
          schemaVersion: 1,
          projectId,
          pages: [],
        }),
        importOkf: () => Promise.reject(new Error('private SDK detail')),
        promoteStagedPage: () => Promise.resolve(),
      },
    });

    const error = await service.approve(
      workspace,
      'alpha',
      candidate.candidateId,
      () => Promise.resolve(snapshot(workspace)),
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      candidateRefs: [candidate.candidateId],
      code: 'SESSION_CANDIDATE_APPROVAL_FAILED',
      recoveryAction: 'retry',
      retryable: true,
      sideEffectsPossible: false,
    });
    expect(JSON.stringify(error)).not.toContain('private SDK detail');
    await expect(store.list()).resolves.toMatchObject([{
      lifecycle: 'pending',
      candidate: { candidateId: candidate.candidateId },
    }]);
  });

  it('promotes through the exact installed public SDK without a provider', async () => {
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-session-review-sdk-'));
    temporaryRoots.push(knowledgeRoot);
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    const workspace = join(knowledgeRoot, 'projects', 'alpha');
    await writeFile(
      join(workspace, 'sources', COMPILER_SOURCE_ID),
      COMPILER_SOURCE_BODY,
      'utf8',
    );
    const validated = batch();
    const page = validated.pages[0];
    if (page === undefined) throw new Error('missing test page');
    const candidate = createSessionReviewCandidate({
      batch: validated,
      page,
      profileMode: 'default',
      renderedPage: renderSessionOkfPage(page),
    });
    const store = createSessionReviewStore(workspace, 'alpha');
    await store.stage([candidate]);
    const compiler = createProjectCompiler({ environment: {}, knowledgeRoot });
    await expect(compiler.execute({ capability: 'status', projectId: 'alpha' }))
      .resolves.toMatchObject({ data: { pageCount: 0, pendingCandidates: 1 } });

    const service = createSessionReviewService();
    await expect(service.approve(
      workspace,
      'alpha',
      candidate.candidateId,
      () => Promise.resolve(snapshot(workspace)),
    )).resolves.toMatchObject({ outcome: 'approved', providerUsed: false });

    const livePage = await readFile(
      join(workspace, 'wiki', 'concepts', 'session-concept.md'),
      'utf8',
    );
    expect(livePage).toContain(`^[${COMPILER_SOURCE_ID}:4]`);
    const proofs = await store.listProofs();
    expect(proofs[0]?.sourceHashes).toEqual([
      COMPILER_SOURCE_DIGEST.slice('sha256:'.length),
    ]);
    expect(proofs[0]?.citationBindings).toHaveLength(1);
    await expect(compiler.execute({ capability: 'status', projectId: 'alpha' }))
      .resolves.toMatchObject({ data: { pageCount: 1, pendingCandidates: 0 } });
    const evaluation = await compiler.execute({ capability: 'eval-fast', projectId: 'alpha' });
    expect(evaluation).toMatchObject({ data: { citationCoveragePercent: 100 } });
    const retrieval = createProjectRetrieval({ knowledgeRoot });
    await expect(retrieval.search({
      mode: 'lexical',
      projectId: 'alpha',
      query: 'session output evidence',
    })).resolves.toMatchObject({
      excluded: { unverified: 0 },
      hits: [{ pageId: 'concepts/session-concept' }],
    });
    await expect(retrieval.context({
      projectId: 'alpha',
      prompt: 'session output evidence',
      topChunks: 0,
    })).resolves.toMatchObject({
      data: { primary: [{ id: 'concepts/session-concept' }] },
    });
    await Promise.all([
      rm(join(workspace, '.llmwiki', 'buildlore-session', 'pending'), { recursive: true }),
      rm(join(workspace, '.llmwiki', 'buildlore-session', 'approving'), { recursive: true }),
    ]);
    await expect(createSessionReviewStore(workspace, 'alpha').listProofs())
      .resolves.toHaveLength(1);
  });
});
