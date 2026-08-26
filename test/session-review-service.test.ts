import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectCompiler } from '../src/compiler/service.js';
import { renderSessionOkfPage } from '../src/compiler/session/admission.js';
import { sessionSha256 } from '../src/compiler/session/canonical.js';
import {
  createSessionReviewCandidate,
  createSessionReviewStore,
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
