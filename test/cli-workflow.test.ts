import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWiki } from 'llm-wiki-compiler';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SessionCompileError,
  type CompilerOperationResult,
  type CompilerRequest,
  type ProjectCheckSummary,
  type ProjectCompilerPort,
  type ProjectSessionCompilerPort,
  type SessionCompileApplyRequest,
  type SessionCompilePlanV1,
  type SessionCompilePlanRequest,
  type SessionCompileProposalV1,
  type SessionReviewCandidateV1,
} from '../src/compiler/index.js';
import { createLlmWikiCompilerBackend } from '../src/compiler/backend.js';
import {
  callerHarnessCompatibilityDigest,
  proposalDigest,
} from '../src/compiler/session/contracts.js';
import {
  createSessionReviewStore,
} from '../src/compiler/session/review-store.js';
import { createProjectSessionCompilerForTest } from '../src/compiler/session/service.js';
import {
  HIERARCHICAL_WIKI_ACTIVATION_RESULT_SCHEMA_VERSION,
  runCli,
  type CliIo,
  type CliRuntime,
} from '../src/cli/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION,
  KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
  PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION,
  PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION,
  type KnowledgePublishCommitInput,
  type KnowledgePublishPlan,
  type KnowledgePublishPlanInput,
  type KnowledgePublishPushInput,
  type ParentKnowledgePinInput,
  type PublicationDigest,
} from '../src/knowledge/index.js';
import {
  PROJECT_SYNC_SCHEMA_VERSION,
  type ProjectSyncInput,
  type ProjectSyncSummary,
} from '../src/projector/index.js';
import {
  createProjectRetrieval,
  LOCAL_WIKI_INDEX_REBUILD_SCHEMA_VERSION,
  LOCAL_WIKI_INDEX_STATUS_SCHEMA_VERSION,
  LocalWikiRetrievalError,
  RETRIEVAL_STRATEGY,
  RETRIEVAL_RESULT_V2_SCHEMA_VERSION,
  type EmbeddingCompatibility,
  type LocalWikiOperatorPort,
  type ProjectContextRequest,
  type ProjectContextResult,
  type ProjectSearchRequest,
  type ProjectSearchResult,
} from '../src/retrieval/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import type { WikiExportPort, WikiReadPort } from '../src/wiki/index.js';

const temporaryRoots: string[] = [];
const PLAN_FINGERPRINT =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const oid = (character: string): string => character.repeat(40);
const digest = (character: string): PublicationDigest => `sha256:${character.repeat(64)}`;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionPlanFrom(output: string): SessionCompilePlanV1 {
  const envelope: unknown = JSON.parse(output);
  const data = isRecord(envelope) ? envelope.data : undefined;
  if (!isRecord(data) || data.schemaVersion !== 'buildlore.compile-plan.v5' ||
      !Array.isArray(data.sources) || !Array.isArray(data.tasks)) {
    throw new Error('invalid session plan CLI envelope');
  }
  return data as unknown as SessionCompilePlanV1;
}

async function writeSessionProposal(
  cwd: string,
  plan: SessionCompilePlanV1,
  input: {
    readonly body: string;
    readonly slug: string;
    readonly summary: string;
    readonly title: string;
  },
): Promise<string> {
  const task = plan.tasks.find((item) => item.requestedPageKinds.includes('concept'));
  const source = task === undefined
    ? undefined
    : plan.sources.find((item) => task.allowedSourceIds.includes(item.sourceId) &&
        item.citationAnchors.length > 0);
  const citation = source?.citationAnchors[0];
  if (task === undefined || source === undefined || citation === undefined) {
    throw new Error('session plan lacks deterministic proposal evidence');
  }
  const draft: SessionCompileProposalV1 = {
    schemaVersion: 'buildlore.compile-proposal.v1',
    projectId: plan.projectId,
    planDigest: plan.planDigest,
    proposalId: `proposal-${input.slug}`,
    proposalDigest: digest('0'),
    taskId: task.taskId,
    mergeCandidateIds: [],
    pageId: `concepts/${input.slug}`,
    slug: input.slug,
    title: input.title,
    kind: 'concept',
    summary: input.summary,
    body: `${input.body}[^evidence]`,
    sources: task.allowedSourceIds,
    wikilinks: [],
    citations: [{
      file: citation.originalFile,
      id: 'evidence',
      line: citation.originalLine,
      quote: citation.quote,
      sourceId: citation.sourceId,
    }],
    confidence: 1,
    callerHarness: {
      compatibilityDigest: callerHarnessCompatibilityDigest('codex', '1.0.0'),
      kind: 'codex',
      version: '1.0.0',
    },
  };
  const proposal = Object.freeze({ ...draft, proposalDigest: proposalDigest(draft) });
  const path = join(cwd, `${input.slug}.proposal.json`);
  await writeFile(path, serializeCanonicalJson(proposal), 'utf8');
  return path;
}

async function importCandidatePage(
  workspace: string,
  candidate: SessionReviewCandidateV1,
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'buildlore-cli-session-bundle-'));
  temporaryRoots.push(parent);
  const bundle = join(parent, 'bundle');
  await mkdir(bundle);
  await writeFile(
    join(bundle, 'index.md'),
    '---\nokf_version: "0.1"\n---\n\n# CLI recovery fixture\n',
    'utf8',
  );
  const target = join(bundle, candidate.target);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, candidate.renderedPage, 'utf8');
  await createWiki({ root: workspace }).importOkf(bundle, { trusted: true });
}

function publicationPlan(eligible = true): KnowledgePublishPlan {
  return {
    schemaVersion: KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION,
    projectId: 'alpha',
    repositoryIdentityDigest: digest('1'),
    baseRevision: oid('a'),
    localUpstreamRevision: null,
    sourceRevision: oid('b'),
    codeRevision: oid('c'),
    selectedPaths: eligible ? [{
      classification: 'always-track',
      contentSha256: digest('2'),
      mode: '100644',
      numstat: { added: 1, deleted: null },
      reasonCode: 'selected',
      relativePath: 'projects/alpha/sources/entry.md',
      status: 'modified',
    }] : [],
    foreignChanges: {
      digest: digest('3'),
      staged: { count: 0, entries: [], overflow: false },
      unstaged: { count: 0, entries: [], overflow: false },
      untracked: { count: 0, entries: [], overflow: false },
    },
    registrationManifest: null,
    trackingPolicyDigest: digest('4'),
    lineageDigest: digest('5'),
    indexSnapshotDigest: digest('6'),
    eligible,
    blockReasons: eligible ? [] : ['EMPTY_SELECTION'],
    planDigest: digest('7'),
  };
}

interface CapturedCli {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`Git fixture command failed: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
}

async function capture(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<CapturedCli> {
  let stderr = '';
  let stdout = '';
  const io: CliIo = {
    stderr: (message) => {
      stderr += message;
    },
    stdout: (message) => {
      stdout += message;
    },
  };
  return {
    exitCode: await runCli(args, io, runtime),
    stderr,
    stdout,
  };
}

async function createConfiguredRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-cli-workflow-'));
  temporaryRoots.push(root);
  const knowledgeOrigin = join(root, 'knowledge.git');
  const knowledgeSeed = join(root, 'knowledge-seed');
  const code = join(root, 'code');

  await git(root, ['init', '--bare', '--initial-branch=main', knowledgeOrigin]);
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', knowledgeOrigin, knowledgeSeed]);
  await configureIdentity(knowledgeSeed);
  await writeFile(join(knowledgeSeed, 'README.md'), '# Knowledge fixture\n', 'utf8');
  await git(knowledgeSeed, ['add', 'README.md']);
  await git(knowledgeSeed, ['commit', '-m', 'seed knowledge']);
  await git(knowledgeSeed, ['push', 'origin', 'main']);

  await mkdir(code);

  const bootstrapRuntime: CliRuntime = { cwd: code };
  const initialized = await capture(
    ['init', '--knowledge-repo', '../knowledge.git', '--branch', 'main'],
    bootstrapRuntime,
  );
  if (initialized.exitCode !== 0) throw new Error('Canonical workspace initialization failed.');
  await configureIdentity(code);
  for (const projectId of ['alpha', 'beta']) {
    const sourceRepository = `https://example.test/${projectId}.git`;
    const sourceRoot = join(root, `${projectId}-source`);
    await mkdir(sourceRoot);
    await git(sourceRoot, ['init', '--initial-branch=main']);
    await configureIdentity(sourceRoot);
    await Promise.all([
      mkdir(join(sourceRoot, '.buildlore')),
      mkdir(join(sourceRoot, 'docs')),
    ]);
    await writeFile(join(sourceRoot, 'docs', 'overview.md'), `# ${projectId}\n`, 'utf8');
    await writeFile(
      join(sourceRoot, '.buildlore', 'sources.json'),
      JSON.stringify({
        projectId,
        schemaVersion: 'buildlore.sources.v1',
        sourceRepository,
        sources: [{
          documentKind: 'markdown',
          id: 'docs',
          path: 'docs',
          pathType: 'directory',
          recursive: true,
        }],
      }, null, 2) + '\n',
      'utf8',
    );
    await git(sourceRoot, ['add', '.']);
    await git(sourceRoot, ['commit', '-m', 'seed source']);
    const added = await capture(
      [
        'project',
        'add',
        '--id',
        projectId,
        '--source-repo',
        sourceRepository,
        '--source-root',
        sourceRoot,
      ],
      bootstrapRuntime,
    );
    if (added.exitCode !== 0) {
      throw new Error(`Project fixture creation failed: ${added.stderr}`);
    }
  }
  return code;
}

async function createDryRunFixture(cwd: string): Promise<void> {
  const workspace = join(cwd, 'knowledge', 'projects', 'alpha');
  await Promise.all([
    mkdir(join(workspace, '.llmwiki'), { recursive: true }),
    mkdir(join(workspace, 'sources'), { recursive: true }),
    mkdir(join(workspace, 'wiki', 'decisions'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspace, '.llmwiki', 'state.json'), '{"state":"clean"}\n', 'utf8'),
    writeFile(join(workspace, 'sources', 'workflow.md'), '# Workflow source\n', 'utf8'),
    writeFile(join(workspace, 'wiki', 'decisions', 'workflow.md'), '# Workflow page\n', 'utf8'),
  ]);
}

async function dryRunState(cwd: string): Promise<Readonly<Record<string, string>>> {
  const workspace = join(cwd, 'knowledge', 'projects', 'alpha');
  const paths = [
    '.llmwiki/state.json',
    'project.json',
    'sources/workflow.md',
    'wiki/decisions/workflow.md',
  ];
  const files = await Promise.all(paths.map(async (path) =>
    [path, (await readFile(join(workspace, path))).toString('base64')] as const));
  return Object.freeze({
    codeGit: await git(cwd, ['status', '--porcelain=v2', '--untracked-files=all']),
    knowledgeGit: await git(
      join(cwd, 'knowledge'),
      ['status', '--porcelain=v2', '--untracked-files=all'],
    ),
    ...Object.fromEntries(files),
  });
}

function compilerResult(request: CompilerRequest): CompilerOperationResult {
  switch (request.capability) {
    case 'compile':
      return {
        capability: 'compile',
        data: {
          candidateCount: request.review === true ? 1 : 0,
          candidates: request.review === true
            ? [{ disposition: 'held', id: 'candidate-1', reasons: ['manual-review-requested'], slug: 'candidate-1' }]
            : [],
          compiled: 1,
          deleted: 0,
          pageIds: ['decision/cli-contract'],
          skipped: 0,
        },
        ok: true,
        outcome: 'succeeded',
        projectId: request.projectId,
        warnings: [],
      };
    case 'query':
      return {
        capability: 'query',
        data: { answer: 'Bounded answer.', pageIds: ['decision/cli-contract'] },
        ok: true,
        outcome: 'succeeded',
        projectId: request.projectId,
        warnings: [{ code: 'query-log-written' }],
      };
    default:
      throw new Error('Unexpected compiler request in CLI workflow fixture.');
  }
}

function checkSummary(projectId: string, passed = true): ProjectCheckSummary {
  return {
    evalFast: {
      citationCoveragePercent: 100,
      citationPrecisionPercent: 100,
      embeddingsAvailable: true,
      healthScore: 100,
      pageCount: 1,
      pendingReviews: 0,
      sourceCount: 1,
      suite: 'fast',
      thresholdViolationCount: passed ? 0 : 1,
    },
    gateCodes: passed ? [] : ['eval-threshold-violations'],
    lint: { errors: 0, findings: [], info: 0, warnings: 0 },
    passed,
    projectId,
    status: {
      lastCompiledAt: '2026-08-21T00:00:00.000Z',
      orphanedCount: 0,
      orphanedPages: [],
      pageCount: 1,
      pendingCandidates: 0,
      pendingChanges: [],
      pendingChangesCount: 0,
      sourceCount: 1,
      staleCount: 0,
      stalePages: [],
      stateStatus: 'ok',
    },
    warnings: [],
  };
}

function syncSummary(input: ProjectSyncInput): ProjectSyncSummary {
  const emptyPlan = {
    counts: { blocked: 0, error: 0, exclude: 0, include: 0, quarantine: 0 },
    entries: [],
    planFingerprint: PLAN_FINGERPRINT,
  };
  return {
    appliedCount: 0,
    dryRun: input.dryRun,
    execution: emptyPlan,
    partial: false,
    planning: emptyPlan,
    projectId: input.projectId,
    remainingCount: 0,
    schemaVersion: PROJECT_SYNC_SCHEMA_VERSION,
    warnings: [],
    writes: [],
  };
}

function searchResult(request: ProjectSearchRequest): ProjectSearchResult {
  const requestedMode = request.mode ?? 'hybrid';
  const embeddingCompatibility: EmbeddingCompatibility = requestedMode === 'lexical'
    ? { currentIdentity: null, reasonCode: null, rebuildRequired: false, state: 'not-applicable' }
    : {
        currentIdentity: null,
        reasonCode: 'provider-unconfigured',
        rebuildRequired: false,
        state: 'unavailable',
      };
  return {
    embeddingCompatibility,
    effectiveMode: requestedMode === 'lexical' ? 'lexical' : 'lexical',
    excluded: { archived: 0, orphaned: 0, stale: 0, unverified: 0 },
    fallback: requestedMode === 'lexical'
      ? null
      : { fromMode: requestedMode, reasonCode: 'provider-unconfigured', toMode: 'lexical' },
    hits: [],
    partial: requestedMode !== 'lexical',
    projectId: request.projectId,
    recoveryAction: requestedMode === 'lexical'
      ? null
      : { command: ['compile', '--project', request.projectId], rebuildRequired: false },
    requestedMode,
    retrievalStrategy: RETRIEVAL_STRATEGY,
    warnings: requestedMode === 'lexical' ? [] : [{ code: 'provider-unconfigured' }],
  };
}

function contextResult(request: ProjectContextRequest): ProjectContextResult {
  return {
    data: {
      budget: { estimatedTokens: 0, requestedTokens: 1200, truncated: false },
      gaps: [],
      primary: [],
      version: 1,
    },
    fallback: { fromMode: 'hybrid', reasonCode: 'provider-unconfigured', toMode: 'lexical' },
    partial: true,
    projectId: request.projectId,
    warnings: [{ code: 'provider-unconfigured' }],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('canonical CLI workflow', () => {
  it('routes caller-owned plan/apply without legacy compile or agent execution and returns reviewRequired safe refs, counts, digests, and recovery action', async () => {
    const cwd = await createConfiguredRepository();
    const candidateId = `candidate-${'a'.repeat(64)}`;
    const planRequests: SessionCompilePlanRequest[] = [];
    const applyRequests: SessionCompileApplyRequest[] = [];
    const candidateRequests: Array<{ readonly projectId: string }> = [];
    const approveRequests: Array<{ readonly candidateId: string; readonly projectId: string }> = [];
    let legacyCalls = 0;
    const sessionCompiler: ProjectSessionCompilerPort = {
      plan: (request) => {
        planRequests.push(request);
        return Promise.resolve({
          schemaVersion: 'buildlore.compile-plan.v5',
          projectId: request.projectId,
          planDigest: digest('1'),
          contractDigest: digest('2'),
          profileDigest: digest('3'),
          policyDigest: digest('4'),
          selectionDigest: digest('5'),
          sourceManifestDigest: digest('6'),
          existingKnowledgeDigest: digest('7'),
          algorithmVersion: 'buildlore.session-planner.v4',
          limits: {
            maxCitationsPerPage: 512,
            maxLinksPerPage: 256,
            maxMergeCandidates: 131072,
            maxRelationCandidatesPerTask: 32,
            maxPageBytes: 524288,
            maxPlanBytes: 33554432,
            maxProposalBytes: 524288,
            maxApplyProposals: 8192,
            maxProposalsPerBatch: 50,
            maxQuoteCodeUnits: 512,
            maxSourceBytes: 524288,
            maxSources: 4096,
            maxTasks: 8192,
          },
          sources: [],
          tasks: [],
          mergeCandidates: [],
          allowedLinkTargets: [],
        });
      },
      apply: (request) => {
        applyRequests.push(request);
        return Promise.resolve({
          schemaVersion: 'buildlore.compile-apply-result.v2',
          projectId: request.projectId,
          planDigest: digest('1'),
          batchDigest: digest('8'),
          outcome: 'staged',
          reviewRequired: true,
          admissionKind: 'buildlore-review',
          admittedCount: request.proposalFiles.length,
          heldCount: request.proposalFiles.length,
          skippedCount: 0,
          candidateRefs: [candidateId],
          sideEffectsPossible: false,
          recoveryAction: 'review',
          warnings: [],
        });
      },
      candidates: (request) => {
        candidateRequests.push(request);
        return Promise.resolve({
          schemaVersion: 'buildlore.session-candidate-list.v1',
          projectId: request.projectId,
          candidates: [{
            candidateId,
            heldReasons: ['manual-review-requested'],
            lifecycle: 'pending',
            targetPath: 'concepts/session-page.md',
            pageId: 'concepts/session-page',
            slug: 'session-page',
          }],
          managedPendingCount: 1,
          legacyPendingCount: 0,
          warnings: [],
        });
      },
      approve: (request) => {
        approveRequests.push(request);
        return Promise.resolve({
          schemaVersion: 'buildlore.session-candidate-approval.v1',
          projectId: request.projectId,
          candidateId: request.candidateId,
          pageId: 'concepts/session-page',
          outcome: 'approved',
          providerUsed: false,
          sideEffectsPossible: false,
          warnings: [],
        });
      },
    };
    const runtime: CliRuntime = {
      cwd,
      projectCompiler: {
        execute: () => {
          legacyCalls += 1;
          return Promise.reject(new Error('legacy compile must not run'));
        },
        status: () => Promise.resolve({ pendingChanges: [], pendingChangesCount: 0, stateStatus: 'ok' }),
      },
      sessionCompiler,
    };

    const planned = await capture(['compile', 'plan', '--project', 'alpha', '--json'], runtime);
    const applied = await capture([
      'compile', 'apply', '--project', 'alpha', '--page', 'one.json', '--page', 'two.json',
      '--json',
    ], runtime);
    const candidates = await capture([
      'compile', 'candidates', '--project', 'alpha', '--json',
    ], runtime);
    const approved = await capture([
      'compile', 'approve', '--project', 'alpha', '--candidate', candidateId, '--json',
    ], runtime);

    expect(JSON.parse(planned.stdout)).toMatchObject({
      command: 'compile.plan',
      data: { schemaVersion: 'buildlore.compile-plan.v5' },
      ok: true,
    });
    expect(JSON.parse(applied.stdout)).toMatchObject({
      command: 'compile.apply',
      data: { admissionKind: 'buildlore-review', reviewRequired: true },
      ok: true,
    });
    expect(JSON.parse(candidates.stdout)).toMatchObject({
      command: 'compile.candidates',
      data: { candidates: [{ candidateId, targetPath: 'concepts/session-page.md' }] },
      ok: true,
    });
    expect(JSON.parse(approved.stdout)).toMatchObject({
      command: 'compile.approve',
      data: { candidateId, outcome: 'approved', providerUsed: false },
      ok: true,
    });
    expect(planRequests).toEqual([{ projectId: 'alpha' }]);
    expect(applyRequests).toEqual([{
      projectId: 'alpha',
      proposalFiles: ['one.json', 'two.json'],
    }]);
    expect(candidateRequests).toEqual([{ projectId: 'alpha' }]);
    expect(approveRequests).toEqual([{ candidateId, projectId: 'alpha' }]);
    expect(legacyCalls).toBe(0);
  });

  it('renders recovery-required approval as a partial failure with a safe candidates command', async () => {
    const cwd = await createConfiguredRepository();
    const candidateId = `candidate-${'d'.repeat(64)}`;
    const sessionCompiler: ProjectSessionCompilerPort = {
      plan: () => Promise.reject(new Error('unexpected plan')),
      apply: () => Promise.reject(new Error('unexpected apply')),
      candidates: () => Promise.reject(new Error('unexpected candidates')),
      approve: () => Promise.reject(new SessionCompileError(
        'SESSION_CANDIDATE_RECOVERY_REQUIRED',
        'alpha',
        {
          candidateRefs: [candidateId],
          exportInspection: { fields: ['contentHash'], mismatchKind: 'field-value' },
          recoveryAction: 'status',
          sideEffectsPossible: true,
        },
      )),
    };
    const runtime: CliRuntime = {
      cwd,
      projectCompiler: {
        execute: () => Promise.reject(new Error('legacy compile must not run')),
        status: () => Promise.resolve({ pendingChanges: [], pendingChangesCount: 0, stateStatus: 'ok' }),
      },
      sessionCompiler,
    };

    const json = await capture([
      'compile', 'approve', '--project', 'alpha', '--candidate', candidateId, '--json',
    ], runtime);
    const human = await capture([
      'compile', 'approve', '--project', 'alpha', '--candidate', candidateId,
    ], runtime);

    expect(json.exitCode).toBe(4);
    expect(JSON.parse(json.stderr)).toMatchObject({
      command: 'compile.approve',
      data: {
        candidateRefs: [candidateId],
        exportInspection: { fields: ['contentHash'], mismatchKind: 'field-value' },
        recoveryAction: 'status',
        sideEffectsPossible: true,
      },
      errors: [{ recoveryCommand: ['compile', 'candidates', '--project', 'alpha'] }],
      ok: false,
      partial: true,
    });
    expect(human.exitCode).toBe(4);
    expect(human.stderr).toContain('recovery: buildlore compile candidates --project alpha\n');
  });

  it('completes fresh and recovered approvals through the CLI with proof-backed lexical hits', async () => {
    const cwd = await createConfiguredRepository();
    const knowledgeRoot = join(cwd, 'knowledge');
    const workspace = join(knowledgeRoot, 'projects', 'alpha');
    const store = createSessionReviewStore(workspace, 'alpha');
    await writeSecurityPolicy(knowledgeRoot, 'alpha');
    const synchronized = await capture(['sync', '--project', 'alpha', '--json'], { cwd });
    expect(synchronized.exitCode).toBe(0);
    expect(JSON.parse(synchronized.stdout)).toMatchObject({
      command: 'sync',
      data: { projectId: 'alpha' },
      ok: true,
    });

    const planned = await capture(['compile', 'plan', '--project', 'alpha', '--json'], { cwd });
    expect(planned.exitCode, planned.stderr).toBe(0);
    const freshProposal = await writeSessionProposal(cwd, sessionPlanFrom(planned.stdout), {
      body: 'Fresh retrieval evidence.',
      slug: 'fresh-cli-approval',
      summary: 'Fresh CLI approval retrieval proof.',
      title: 'Fresh CLI approval',
    });
    const applied = await capture([
      'compile', 'apply', '--project', 'alpha', '--page', freshProposal, '--json',
    ], { cwd });
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      command: 'compile.apply',
      data: { admittedCount: 1, heldCount: 1, reviewRequired: true },
      ok: true,
    });
    const freshStored = await store.list();
    const freshCandidate = freshStored[0]?.candidate;
    if (freshCandidate === undefined) throw new Error('missing fresh CLI candidate');
    const listed = await capture([
      'compile', 'candidates', '--project', 'alpha', '--json',
    ], { cwd });
    const freshApproved = await capture([
      'compile', 'approve', '--project', 'alpha', '--candidate',
      freshCandidate.candidateId, '--json',
    ], { cwd });
    const historicalFixture: unknown = JSON.parse(await readFile(
      new URL('./fixtures/hierarchical-corpus-negative.json', import.meta.url),
      'utf8',
    ));
    if (!isRecord(historicalFixture) ||
        !isRecord(historicalFixture.expectedLegacyApprovalCheck)) {
      throw new Error('invalid historical approval check expectation');
    }
    const historicalExpectation = historicalFixture.expectedLegacyApprovalCheck;

    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      data: { candidates: [{ candidateId: freshCandidate.candidateId, lifecycle: 'pending' }] },
    });
    expect(freshApproved.exitCode).toBe(0);
    expect(JSON.parse(freshApproved.stdout)).toMatchObject({
      command: 'compile.approve',
      data: {
        candidateId: freshCandidate.candidateId,
        outcome: historicalExpectation.approvalOutcome,
        providerUsed: historicalExpectation.providerUsed,
        sideEffectsPossible: historicalExpectation.sideEffectsPossible,
        warnings: [],
      },
      ok: true,
    });
    const freshProof = await store.readProof(freshCandidate.candidateId);
    expect(freshProof).toMatchObject({
      candidateId: freshCandidate.candidateId,
      candidateDigest: freshCandidate.candidateDigest,
      pageId: freshCandidate.pageId,
      projectId: 'alpha',
    });
    const checkedAfterApproval = await capture([
      'check', '--project', 'alpha', '--json',
    ], { cwd });
    expect(checkedAfterApproval.exitCode).toBe(historicalExpectation.checkExitCode);
    expect(JSON.parse(checkedAfterApproval.stderr)).toMatchObject({
      command: 'check',
      data: {
        gateCodes: historicalExpectation.gateCodes,
        passed: false,
        status: {
          pendingChangesCount: historicalExpectation.pendingChangesCount,
          sourceCount: historicalExpectation.sourceCount,
          stateStatus: historicalExpectation.stateStatus,
        },
      },
      errors: [{ code: historicalExpectation.errorCode }],
      ok: false,
    });

    const recoveryPlanResult = await capture([
      'compile', 'plan', '--project', 'alpha', '--json',
    ], { cwd });
    expect(recoveryPlanResult.exitCode).toBe(0);
    const recoveryProposal = await writeSessionProposal(
      cwd,
      sessionPlanFrom(recoveryPlanResult.stdout),
      {
        body: 'Recovered retrieval evidence.',
        slug: 'recovered-cli-approval',
        summary: 'Recovered CLI approval retrieval proof.',
        title: 'Recovered CLI approval',
      },
    );
    const recoveryApplied = await capture([
      'compile', 'apply', '--project', 'alpha', '--page', recoveryProposal, '--json',
    ], { cwd });
    expect(recoveryApplied.exitCode).toBe(0);
    const recoveredCandidate = (await store.list())
      .find((item) => item.candidate.slug === 'recovered-cli-approval')?.candidate;
    if (recoveredCandidate === undefined) throw new Error('missing recovery CLI candidate');
    await store.claim(recoveredCandidate.candidateId);
    await importCandidatePage(workspace, recoveredCandidate);
    const recoveredCompiler = createProjectSessionCompilerForTest({
      hubRoot: cwd,
      knowledgeRoot,
      planner: {
        create: () => Promise.reject(new Error('stale snapshot must not be read during recovery')),
      },
    });
    const recoveredApproved = await capture([
      'compile', 'approve', '--project', 'alpha', '--candidate',
      recoveredCandidate.candidateId, '--json',
    ], { cwd, sessionCompiler: recoveredCompiler });

    expect(recoveredApproved.exitCode).toBe(0);
    expect(JSON.parse(recoveredApproved.stdout)).toMatchObject({
      command: 'compile.approve',
      data: {
        candidateId: recoveredCandidate.candidateId,
        outcome: 'approved',
        providerUsed: false,
        warnings: [{ code: 'recovered-approving-candidate' }],
      },
      ok: true,
    });
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.listProofs()).resolves.toHaveLength(2);

    const searched = await capture([
      'search', '--project', 'alpha', '--query', 'recovered approval retrieval',
      '--mode', 'lexical', '--json',
    ], { cwd });
    expect(searched.exitCode).toBe(0);
    const searchEnvelope: unknown = JSON.parse(searched.stdout);
    expect(searchEnvelope).toMatchObject({
      command: 'search',
      data: {
        effectiveMode: 'lexical',
        excluded: { unverified: 0 },
        requestedMode: 'lexical',
      },
      ok: true,
    });
    if (!isRecord(searchEnvelope) || !isRecord(searchEnvelope.data) ||
        !Array.isArray(searchEnvelope.data.hits)) {
      throw new Error('invalid search envelope fixture');
    }
    expect(searchEnvelope.data.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageId: recoveredCandidate.pageId }),
    ]));
    const retrieval = await createProjectRetrieval({ knowledgeRoot }).search({
      mode: 'lexical',
      projectId: 'alpha',
      query: 'fresh recovered approval retrieval',
    });
    expect(retrieval.excluded.unverified).toBe(0);
    expect(retrieval.hits.map((hit) => hit.pageId)).toEqual(expect.arrayContaining([
      freshCandidate.pageId,
      recoveredCandidate.pageId,
    ]));
    expect(retrieval.hits.flatMap((hit) => hit.sourceRefs)
      .filter((sourceRef) => sourceRef.startsWith('okf:'))).toEqual([]);
  }, 15_000);

  it('applies more than 50 pages through the real CLI and carries every candidate through approval, proof, and retrieval', async () => {
    const cwd = await createConfiguredRepository();
    const knowledgeRoot = join(cwd, 'knowledge');
    const workspace = join(knowledgeRoot, 'projects', 'alpha');
    await writeSecurityPolicy(knowledgeRoot, 'alpha');
    const synchronized = await capture(['sync', '--project', 'alpha', '--json'], { cwd });
    expect(synchronized.exitCode, synchronized.stderr).toBe(0);

    const planned = await capture(['compile', 'plan', '--project', 'alpha', '--json'], { cwd });
    expect(planned.exitCode, planned.stderr).toBe(0);
    const plan = sessionPlanFrom(planned.stdout);
    const proposalFiles = await Promise.all(Array.from({ length: 51 }, async (_, index) => {
      const suffix = String(index).padStart(3, '0');
      return writeSessionProposal(cwd, plan, {
        body: suffix === '050'
          ? [
              '# Literal citation fixture',
              '',
              '```text',
              '^[fenced-example]',
              '```',
              '',
              `Bulk E2E evidence token bulk-e2e-token-${suffix} with ^[example].`,
            ].join('\n')
          : `Bulk E2E evidence token bulk-e2e-token-${suffix}.`,
        slug: `bulk-cli-${suffix}`,
        summary: `Bulk CLI approval proof ${suffix}.`,
        title: `Bulk CLI page ${suffix}`,
      });
    }));
    const applied = await capture([
      'compile', 'apply', '--project', 'alpha',
      ...proposalFiles.flatMap((path) => ['--page', path]),
      '--json',
    ], { cwd });
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      command: 'compile.apply',
      data: { admittedCount: 51, heldCount: 51, reviewRequired: true },
      ok: true,
    });

    const listed = await capture([
      'compile', 'candidates', '--project', 'alpha', '--json',
    ], { cwd });
    expect(listed.exitCode, listed.stderr).toBe(0);
    const listEnvelope: unknown = JSON.parse(listed.stdout);
    if (!isRecord(listEnvelope) || !isRecord(listEnvelope.data) ||
        !Array.isArray(listEnvelope.data.candidates)) {
      throw new Error('invalid bulk candidate-list envelope fixture');
    }
    expect(listEnvelope.data).toMatchObject({
      legacyPendingCount: 0,
      managedPendingCount: 51,
    });
    const candidates: Array<Readonly<{
      readonly candidateId: string;
      readonly pageId: string;
      readonly slug: string;
    }>> = [];
    for (const value of listEnvelope.data.candidates) {
      if (!isRecord(value) || typeof value.candidateId !== 'string' ||
          typeof value.pageId !== 'string' || typeof value.slug !== 'string') {
        throw new Error('invalid bulk candidate summary fixture');
      }
      candidates.push(Object.freeze({
        candidateId: value.candidateId,
        pageId: value.pageId,
        slug: value.slug,
      }));
    }
    expect(candidates).toHaveLength(51);
    const secondChunkCandidate = candidates.find((candidate) => candidate.slug === 'bulk-cli-050');
    if (secondChunkCandidate === undefined) throw new Error('missing second-chunk candidate');

    for (const candidate of candidates) {
      const approved = await capture([
        'compile', 'approve', '--project', 'alpha', '--candidate',
        candidate.candidateId, '--json',
      ], { cwd });
      expect(approved.exitCode, `${candidate.slug}: ${approved.stderr}`).toBe(0);
    }
    const store = createSessionReviewStore(workspace, 'alpha');
    await expect(store.list()).resolves.toEqual([]);
    const proofs = await store.listProofs();
    expect(proofs).toHaveLength(51);
    expect(proofs).toEqual(expect.arrayContaining([expect.objectContaining({
      candidateId: secondChunkCandidate.candidateId,
      pageId: secondChunkCandidate.pageId,
    })]));
    const secondChunkProof = proofs.find((proof) =>
      proof.candidateId === secondChunkCandidate.candidateId);
    const citationBinding = secondChunkProof?.citationBindings[0];
    if (citationBinding === undefined) throw new Error('missing second-chunk citation proof');
    const finalPage = await readFile(
      join(workspace, 'wiki', `${secondChunkCandidate.pageId}.md`),
      'utf8',
    );
    expect(finalPage).toContain('^\\[example]');
    expect(finalPage).not.toContain('^[example]');
    expect(finalPage).toContain('```text\n^[fenced-example]\n```');

    const exported: unknown = await createLlmWikiCompilerBackend().exportProject(
      workspace,
      'alpha',
    );
    if (!isRecord(exported) || !Array.isArray(exported.pages)) {
      throw new Error('invalid bulk export fixture');
    }
    const exportedPage: unknown = exported.pages.find((value: unknown) =>
      isRecord(value) && value.path === `wiki/${secondChunkCandidate.pageId}.md`);
    if (!isRecord(exportedPage) || typeof exportedPage.body !== 'string' ||
        !Array.isArray(exportedPage.citations)) {
      throw new Error('missing bulk exported page fixture');
    }
    expect(exportedPage.body).toContain('^\\[example]');
    expect(exportedPage.body).not.toContain('^[example]');
    expect(exportedPage.body).toContain('```text\n^[fenced-example]\n```');
    expect(exportedPage.citations).toEqual([{
      end: citationBinding.originalLine,
      file: citationBinding.compilerSourceId,
      start: citationBinding.originalLine,
    }]);

    const searched = await capture([
      'search', '--project', 'alpha', '--query', 'bulk-e2e-token-050',
      '--mode', 'lexical', '--json',
    ], { cwd });
    expect(searched.exitCode, searched.stderr).toBe(0);
    const searchEnvelope: unknown = JSON.parse(searched.stdout);
    expect(searchEnvelope).toMatchObject({
      data: { excluded: { unverified: 0 } },
      ok: true,
    });
    if (!isRecord(searchEnvelope) || !isRecord(searchEnvelope.data) ||
        !Array.isArray(searchEnvelope.data.hits)) {
      throw new Error('invalid bulk search envelope fixture');
    }
    expect(searchEnvelope.data.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageId: secondChunkCandidate.pageId }),
    ]));
  }, 180_000);

  it('runs the credential-free empty non-Git workflow, proves sync dry-run byte and Git invariance without compiler or provider calls, and completes init through query', async () => {
    const cwd = await createConfiguredRepository();
    await createDryRunFixture(cwd);
    const compilerRequests: CompilerRequest[] = [];
    const searchRequests: ProjectSearchRequest[] = [];
    const contextRequests: ProjectContextRequest[] = [];
    const syncInputs: ProjectSyncInput[] = [];
    const projectCompiler: ProjectCompilerPort = {
      execute: (request) => {
        compilerRequests.push(request);
        return Promise.resolve(compilerResult(request));
      },
      status: () => Promise.resolve({ pendingChanges: [], pendingChangesCount: 0, stateStatus: 'ok' }),
    };
    const runtime: CliRuntime = {
      check: { check: (projectId) => Promise.resolve(checkSummary(projectId)) },
      cwd,
      projectCompiler,
      retrieval: {
        context: (request) => {
          contextRequests.push(request);
          return Promise.resolve(contextResult(request));
        },
        search: (request) => {
          searchRequests.push(request);
          return Promise.resolve(searchResult(request));
        },
      },
      sync: {
        sync: (input) => {
          syncInputs.push(input);
          return Promise.resolve(syncSummary(input));
        },
      },
    };

    const beforeDryRun = await dryRunState(cwd);
    const dryRun = await capture(['sync', '--project', 'alpha', '--dry-run'], runtime);
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: '' });
    expect(dryRun.stdout).toContain('sync: ok\nproject: alpha\n');
    expect(await dryRunState(cwd)).toEqual(beforeDryRun);
    expect(compilerRequests).toEqual([]);
    expect(searchRequests).toEqual([]);
    expect(contextRequests).toEqual([]);

    const synchronized = await capture(['sync', '--project', 'alpha'], runtime);
    expect(synchronized).toMatchObject({ exitCode: 0, stderr: '' });

    const compiled = await capture(
      ['compile', '--project', 'alpha', '--review', '--json'],
      runtime,
    );
    expect(JSON.parse(compiled.stdout)).toMatchObject({
      command: 'compile',
      data: { capability: 'compile', data: { candidateCount: 1 } },
      ok: true,
      projectId: 'alpha',
    });
    await expect(capture(['check', '--project', 'alpha', '--json'], runtime)).resolves.toMatchObject({
      exitCode: 0,
      stderr: '',
    });

    const searched = await capture(
      ['search', '--project', 'alpha', '--query', 'failure', '--json'],
      runtime,
    );
    expect(JSON.parse(searched.stdout)).toMatchObject({
      command: 'search',
      data: { effectiveMode: 'lexical', requestedMode: 'hybrid' },
      ok: true,
      partial: true,
      warnings: [{ code: 'provider-unconfigured' }],
    });

    const queried = await capture(
      ['query', '--project', 'beta', '--question', 'why', '--json'],
      runtime,
    );
    expect(JSON.parse(queried.stdout)).toMatchObject({
      command: 'query',
      ok: true,
      projectId: 'beta',
      warnings: [{ code: 'query-log-written' }],
    });
    const context = await capture(
      ['context', '--project', 'beta', '--prompt', 'fix it', '--json'],
      runtime,
    );
    expect(JSON.parse(context.stdout)).toMatchObject({
      command: 'context',
      ok: true,
      partial: true,
      projectId: 'beta',
    });

    expect(syncInputs).toEqual([
      {
        dryRun: true,
        hubRoot: cwd,
        projectId: 'alpha',
      },
      {
        dryRun: false,
        hubRoot: cwd,
        projectId: 'alpha',
      },
    ]);
    expect(compilerRequests).toEqual([
      { capability: 'compile', projectId: 'alpha', review: true },
      { capability: 'query', projectId: 'beta', question: 'why' },
    ]);
    expect(searchRequests).toEqual([
      { mode: 'hybrid', projectId: 'alpha', query: 'failure' },
    ]);
    expect(contextRequests).toEqual([{ projectId: 'beta', prompt: 'fix it' }]);
  });

  it('[V13-V-04] presents compatibility warnings as a successful partial sync', async () => {
    const cwd = await createConfiguredRepository();
    const runtime: CliRuntime = {
      cwd,
      sync: {
        sync: (input) => Promise.resolve({
          ...syncSummary(input),
          partial: true,
          warnings: [{
            code: 'p2a-additive-field-ignored',
            fieldName: 'future_summary',
            sourceKind: 'planning',
            sourceRef: 'iterations/v1/gate-b-spec/spec.json',
          }],
        }),
      },
    };

    const json = await capture(['sync', '--project', 'alpha', '--dry-run', '--json'], runtime);
    expect(json).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(json.stdout)).toMatchObject({
      data: {
        partial: true,
        warnings: [{ code: 'p2a-additive-field-ignored' }],
      },
      ok: true,
      partial: true,
      warnings: [{ code: 'p2a-additive-field-ignored' }],
    });

    const human = await capture(['sync', '--project', 'alpha', '--dry-run'], runtime);
    expect(human).toMatchObject({ exitCode: 0, stderr: '' });
    expect(human.stdout).toContain('partial: yes\n');
    expect(human.stdout).toContain('warning p2a-additive-field-ignored:');
  });

  it('presents every value-free sanitizer redaction aggregate without code-based loss', async () => {
    const cwd = await createConfiguredRepository();
    const sentinel = '/opt/synthetic-buildlore/private-source.md';
    const runtime: CliRuntime = {
      cwd,
      sync: {
        sync: (input) => Promise.resolve({
          ...syncSummary(input),
          partial: true,
          warnings: [
            {
              code: 'sanitization-redaction-applied',
              occurrenceCount: 2,
              ruleId: 'credential.provider.openai',
              sourceCount: 2,
            },
            {
              code: 'sanitization-redaction-applied',
              occurrenceCount: 4,
              ruleId: 'path.absolute',
              sourceCount: 2,
            },
          ],
        }),
      },
    };

    const json = await capture(['sync', '--project', 'alpha', '--dry-run', '--json'], runtime);
    const envelope = JSON.parse(json.stdout) as {
      readonly data: { readonly warnings: readonly unknown[] };
      readonly warnings: readonly { readonly code: string; readonly message: string }[];
    };
    expect(json).toMatchObject({ exitCode: 0, stderr: '' });
    expect(envelope.data.warnings).toHaveLength(2);
    expect(envelope.warnings).toEqual([
      {
        code: 'sanitization-redaction-applied',
        message: 'Sanitizer rule credential.provider.openai redacted 2 occurrence(s) across 2 source(s).',
      },
      {
        code: 'sanitization-redaction-applied',
        message: 'Sanitizer rule path.absolute redacted 4 occurrence(s) across 2 source(s).',
      },
    ]);

    const human = await capture(['sync', '--project', 'alpha', '--dry-run'], runtime);
    expect(human).toMatchObject({ exitCode: 0, stderr: '' });
    expect(human.stdout).toContain(envelope.warnings[0]?.message);
    expect(human.stdout).toContain(envelope.warnings[1]?.message);
    expect(`${json.stdout}${human.stdout}`).not.toContain(sentinel);
  });

  it('rejects an impossible sanitizer aggregate at the CLI warning boundary', async () => {
    const cwd = await createConfiguredRepository();
    const runtime: CliRuntime = {
      cwd,
      sync: {
        sync: (input) => Promise.resolve({
          ...syncSummary(input),
          partial: true,
          warnings: [{
            code: 'sanitization-redaction-applied',
            occurrenceCount: 1,
            ruleId: 'path.absolute',
            sourceCount: 2,
          }],
        }),
      },
    };

    const json = await capture(['sync', '--project', 'alpha', '--dry-run', '--json'], runtime);
    expect(JSON.parse(json.stdout)).toMatchObject({
      data: { warnings: [{ occurrenceCount: 1, sourceCount: 2 }] },
      warnings: [],
    });
    const human = await capture(['sync', '--project', 'alpha', '--dry-run'], runtime);
    expect(human.stdout).not.toContain('warning sanitization-redaction-applied:');
  });

  it('returns quality exit 5 and rejects an unknown project before domain execution', async () => {
    const cwd = await createConfiguredRepository();
    const compilerRequests: CompilerRequest[] = [];
    const runtime: CliRuntime = {
      check: { check: (projectId) => Promise.resolve(checkSummary(projectId, false)) },
      cwd,
      projectCompiler: {
        execute: (request) => {
          compilerRequests.push(request);
          return Promise.resolve(compilerResult(request));
        },
        status: () => Promise.resolve({ pendingChanges: [], pendingChangesCount: 0, stateStatus: 'ok' }),
      },
    };

    const quality = await capture(['check', '--project', 'alpha', '--json'], runtime);
    expect(quality.exitCode).toBe(5);
    expect(JSON.parse(quality.stderr)).toMatchObject({
      command: 'check',
      data: { gateCodes: ['eval-threshold-violations'], passed: false },
      errors: [{ code: 'QUALITY_GATE_FAILED' }],
      ok: false,
      projectId: 'alpha',
    });

    const missing = await capture(
      ['compile', '--project', 'missing', '--review', '--json'],
      runtime,
    );
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stderr)).toMatchObject({
      errors: [{ code: 'PROJECT_NOT_FOUND' }],
      ok: false,
      projectId: 'missing',
    });
    expect(compilerRequests).toEqual([]);
  });

  it('rejects invalid retrieval text before repository and domain access', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'buildlore-cli-invalid-text-'));
    temporaryRoots.push(cwd);
    let compilerCalls = 0;
    let retrievalCalls = 0;
    const runtime: CliRuntime = {
      cwd,
      projectCompiler: {
        execute: () => {
          compilerCalls += 1;
          return Promise.reject(new Error('Compiler must not be called.'));
        },
        status: () => Promise.reject(new Error('Compiler status must not be called.')),
      },
      retrieval: {
        context: () => {
          retrievalCalls += 1;
          return Promise.reject(new Error('Context must not be called.'));
        },
        search: () => {
          retrievalCalls += 1;
          return Promise.reject(new Error('Search must not be called.'));
        },
      },
    };

    for (const args of [
      ['search', '--project', 'alpha', '--query', '...', '--json'],
      ['query', '--project', 'alpha', '--question', '   ', '--json'],
      ['context', '--project', 'alpha', '--prompt', 'line\nsecret', '--json'],
    ]) {
      const result = await capture(args, runtime);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        errors: [{ code: 'CLI_ARGUMENT_INVALID' }],
        ok: false,
        projectId: null,
      });
    }
    expect(compilerCalls).toBe(0);
    expect(retrievalCalls).toBe(0);
  });

  it('routes the complete durable hierarchy lifecycle without launching an agent', async () => {
    const cwd = await createConfiguredRepository();
    const runId = `run-${'a'.repeat(64)}`;
    const calls: Readonly<{ readonly args: readonly unknown[]; readonly operation: string }>[] = [];
    const hierarchyWorkflow = new Proxy({}, {
      get: (_target, property) => (...args: readonly unknown[]) => {
        calls.push(Object.freeze({ args, operation: String(property) }));
        return Promise.resolve(Object.freeze({ operation: String(property) }));
      },
    }) as unknown as NonNullable<CliRuntime['hierarchyWorkflow']>;
    const runtime: CliRuntime = { cwd, hierarchyWorkflow };
    const commands = [
      ['compile', 'hierarchy', 'start', '--project', 'alpha', '--purpose', 'purpose.json'],
      ['compile', 'hierarchy', 'status', '--project', 'alpha', '--run', runId],
      [
        'compile', 'hierarchy', 'submit', '--project', 'alpha', '--run', runId,
        '--input', 'proposal.json', '--expect-exchange', digest('1'),
      ],
      [
        'compile', 'hierarchy', 'resubmit', '--project', 'alpha', '--run', runId,
        '--page', `page-${'b'.repeat(64)}`, '--input', 'proposal-retry.json',
        '--expect-exchange', digest('5'),
      ],
      [
        'compile', 'hierarchy', 'child-review', '--project', 'alpha', '--run', runId,
        '--input', 'child-review.json', '--expect-review', digest('2'),
      ],
      ['compile', 'hierarchy', 'review', '--project', 'alpha', '--run', runId],
      [
        'compile', 'hierarchy', 'finalize', '--project', 'alpha', '--run', runId,
        '--input', 'final-review.json', '--expect-review', digest('3'),
      ],
      [
        'compile', 'hierarchy', 'approve', '--project', 'alpha', '--run', runId,
        '--expect-ledger', digest('4'), '--confirm-approval',
      ],
    ] as const;

    for (const args of commands) {
      const result = await capture([...args, '--json'], runtime);
      expect(result.exitCode).toBe(0);
    }
    expect(calls).toEqual([
      { args: ['alpha', 'purpose.json'], operation: 'start' },
      { args: ['alpha', runId], operation: 'status' },
      { args: ['alpha', runId, 'proposal.json', digest('1')], operation: 'submit' },
      {
        args: ['alpha', runId, `page-${'b'.repeat(64)}`, 'proposal-retry.json', digest('5')],
        operation: 'resubmit',
      },
      { args: ['alpha', runId, 'child-review.json', digest('2')], operation: 'childReview' },
      { args: ['alpha', runId], operation: 'review' },
      { args: ['alpha', runId, 'final-review.json', digest('3')], operation: 'finalize' },
      { args: ['alpha', runId, digest('4'), true], operation: 'approve' },
    ]);
  });

  it('prefers active hierarchy list and raw page reads over the legacy Wiki surface', async () => {
    const cwd = await createConfiguredRepository();
    const pageId = `page-${'a'.repeat(64)}`;
    const calls: string[] = [];
    const localWiki = {
      listPages: (input: Readonly<{ readonly projectId: string }>) => {
        calls.push(`active-list:${input.projectId}`);
        return Promise.resolve({ projectId: input.projectId, surface: 'active-list' });
      },
      pageCitations: (input: Readonly<{ readonly pageId: string; readonly projectId: string }>) => {
        calls.push(`active-citations:${input.projectId}:${input.pageId}`);
        return Promise.resolve({ pageId: input.pageId, surface: 'active-citations' });
      },
      readPage: (input: Readonly<{ readonly pageId: string; readonly projectId: string }>) => {
        calls.push(`active-read:${input.projectId}:${input.pageId}`);
        return Promise.resolve({ pageId: input.pageId, surface: 'active-read' });
      },
    } as unknown as LocalWikiOperatorPort;
    const wikiRead = {
      citations: () => Promise.reject(new Error('legacy citations must not run')),
      list: () => Promise.reject(new Error('legacy list must not run')),
      read: () => Promise.reject(new Error('legacy read must not run')),
    } as WikiReadPort;
    const runtime: CliRuntime = { cwd, localWiki, wikiRead };

    const listed = await capture(['wiki', 'list', '--project', 'alpha', '--json'], runtime);
    const read = await capture([
      'wiki', 'read', '--project', 'alpha', '--page', pageId, '--json',
    ], runtime);
    const citations = await capture([
      'wiki', 'citations', '--project', 'alpha', '--page', pageId, '--json',
    ], runtime);

    for (const result of [listed, read, citations]) expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      'active-list:alpha',
      `active-read:alpha:${pageId}`,
      `active-citations:alpha:${pageId}`,
    ]);
  });

  it('routes graph search and explicit semantic index operations through the local Wiki operator', async () => {
    const cwd = await createConfiguredRepository();
    const calls: unknown[] = [];
    const localWiki = {
      indexStatus(projectId: string) {
        calls.push({ operation: 'status', projectId });
        return Promise.resolve({
          schemaVersion: LOCAL_WIKI_INDEX_STATUS_SCHEMA_VERSION,
          projectId,
          projection: { projectId, state: 'none' },
          reasonCode: 'approved-wiki-projection-unavailable',
          recoveryAction: ['compile', 'activate', '--project', projectId],
          semanticUsable: false,
          semanticIndex: { projectId, state: 'none' },
        });
      },
      rebuildIndex(input: Readonly<{ readonly full?: boolean; readonly projectId: string }>) {
        calls.push({ input, operation: 'rebuild' });
        return Promise.resolve({
          schemaVersion: LOCAL_WIKI_INDEX_REBUILD_SCHEMA_VERSION,
          projectId: input.projectId,
          requestedMode: input.full === true ? 'full' : 'incremental',
          result: { outcome: 'activated' },
        });
      },
      search(request: Readonly<{
        readonly mode?: 'graph' | 'hybrid' | 'lexical' | 'semantic';
        readonly projectId: string;
        readonly query: string;
      }>) {
        calls.push({ operation: 'search', request });
        if (request.mode === 'semantic') {
          return Promise.reject(new LocalWikiRetrievalError('LOCAL_WIKI_SEMANTIC_UNAVAILABLE', {
            reasonCode: 'semantic-index-unavailable',
            recoveryAction: ['index', 'rebuild', '--project', request.projectId],
          }));
        }
        return Promise.resolve({
          schemaVersion: RETRIEVAL_RESULT_V2_SCHEMA_VERSION,
          projectId: request.projectId,
          requestedMode: request.mode ?? 'hybrid',
          effectiveMode: 'lexical-graph',
          effectiveChannels: ['lexical', 'graph'],
          fallback: null,
          fusionPolicy: null,
          hits: [],
          identity: {
            embeddingIdentityDigest: null,
            indexGenerationId: null,
            indexManifestDigest: null,
          },
          providerUsed: 'none',
          egress: 'none',
        });
      },
    } as unknown as LocalWikiOperatorPort;
    const runtime: CliRuntime = {
      cwd,
      hierarchyActivation: {
        activate(input) {
          calls.push({ input, operation: 'activate' });
          return Promise.resolve({
            schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_RESULT_SCHEMA_VERSION,
            corpusDigest: digest('1'),
            egress: 'none',
            generationDigest: digest('2'),
            materialization: {
              fileCount: 2,
              generationDigest: digest('2'),
              materializationDigest: digest('5'),
              pageCount: 1,
              projectId: input.projectId,
              schemaVersion: 'buildlore.hierarchical-markdown-materialization-status.v2',
              state: 'ready',
            },
            pageCount: 1,
            projectId: input.projectId,
            projectionDigest: digest('3'),
            providerUsed: 'none',
          });
        },
      },
      localWiki,
    };

    const activated = await capture([
      'compile', 'activate', '--project', 'alpha', '--input',
      '.buildlore/approved-wiki.json', '--confirm-approval', digest('4'), '--json',
    ], runtime);
    expect(activated.exitCode).toBe(0);
    expect(JSON.parse(activated.stdout)).toMatchObject({
      command: 'compile.activate',
      data: { egress: 'none', pageCount: 1, providerUsed: 'none' },
      ok: true,
    });
    const rematerialized = await capture([
      'compile', 'activate', '--project', 'alpha', '--rematerialize', '--json',
    ], runtime);
    expect(rematerialized.exitCode).toBe(0);
    expect(calls).toContainEqual({
      input: { projectId: 'alpha', rematerialize: true },
      operation: 'activate',
    });

    const status = await capture(['index', 'status', '--project', 'alpha', '--json'], runtime);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      command: 'index.status',
      data: { projection: { state: 'none' }, semanticIndex: { state: 'none' } },
      ok: true,
    });
    const rebuild = await capture([
      'index', 'rebuild', '--project', 'alpha', '--full', '--json',
    ], runtime);
    expect(rebuild.exitCode).toBe(0);
    expect(JSON.parse(rebuild.stdout)).toMatchObject({
      command: 'index.rebuild',
      data: { requestedMode: 'full', result: { outcome: 'activated' } },
      ok: true,
    });
    const searched = await capture([
      'search', '--project', 'alpha', '--query', 'related design', '--mode', 'graph',
      '--intent', 'current', '--json',
    ], runtime);
    expect(searched.exitCode).toBe(0);
    expect(JSON.parse(searched.stdout)).toMatchObject({
      command: 'search',
      data: { effectiveChannels: ['lexical', 'graph'], requestedMode: 'graph' },
      ok: true,
    });
    const semantic = await capture([
      'search', '--project', 'alpha', '--query', 'related design', '--mode', 'semantic', '--json',
    ], runtime);
    expect(semantic.exitCode).toBe(4);
    expect(JSON.parse(semantic.stderr)).toMatchObject({
      command: 'search',
      errors: [{
        code: 'LOCAL_WIKI_SEMANTIC_UNAVAILABLE',
        reasonCode: 'semantic-index-unavailable',
        recoveryCommand: ['index', 'rebuild', '--project', 'alpha'],
      }],
      ok: false,
    });
    expect(calls).toEqual([
      {
        input: {
          confirmationDigest: digest('4'),
          inputFile: '.buildlore/approved-wiki.json',
          projectId: 'alpha',
        },
        operation: 'activate',
      },
      {
        input: { projectId: 'alpha', rematerialize: true },
        operation: 'activate',
      },
      { operation: 'status', projectId: 'alpha' },
      { input: { full: true, projectId: 'alpha' }, operation: 'rebuild' },
      {
        operation: 'search',
        request: { intent: 'current', mode: 'graph', projectId: 'alpha', query: 'related design' },
      },
      {
        operation: 'search',
        request: { mode: 'semantic', projectId: 'alpha', query: 'related design' },
      },
    ]);
  });

  it('binds explicit publish and pin commands and presents canonical outcomes with stable exits', async () => {
    const cwd = await createConfiguredRepository();
    const planInputs: KnowledgePublishPlanInput[] = [];
    const commitInputs: KnowledgePublishCommitInput[] = [];
    const pushInputs: KnowledgePublishPushInput[] = [];
    const pinPlans: ParentKnowledgePinInput[] = [];
    const pinCommits: Array<Readonly<{
      digest: PublicationDigest;
      input: ParentKnowledgePinInput;
    }>> = [];
    let nextPlan = publicationPlan();
    let pinPlanState: 'ineligible' | 'no-op' | 'planned' = 'planned';
    const runtime: CliRuntime = {
      cwd,
      parentPin: {
        plan: (input) => {
          pinPlans.push(input);
          return Promise.resolve({
            schemaVersion: PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION,
            intent: 'iteration-close',
            iterationId: input.iterationId,
            path: 'knowledge',
            parentRepositoryIdentityDigest: digest('1'),
            knowledgeRepositoryIdentityDigest: digest('2'),
            parentBaseRevision: oid('c'),
            codeRevision: oid('c'),
            oldKnowledgeGitlink: pinPlanState === 'no-op' ? input.knowledgeRevision : oid('e'),
            newKnowledgeGitlink: input.knowledgeRevision,
            projectId: 'alpha',
            sourceRevision: oid('b'),
            lineageDigest: digest('3'),
            targetRemoteReachability: true,
            noOp: pinPlanState === 'no-op',
            eligible: pinPlanState !== 'ineligible',
            blockReasons: pinPlanState === 'ineligible' ? ['PARENT_DIRTY'] : [],
            planDigest: digest('8'),
          });
        },
        commit: (input, expectedPlanDigest) => {
          pinCommits.push({ digest: expectedPlanDigest, input });
          return Promise.resolve({
            schemaVersion: PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION,
            intent: 'iteration-close',
            iterationId: input.iterationId,
            path: 'knowledge',
            projectId: 'alpha',
            sourceRevision: oid('b'),
            parentBaseRevision: oid('c'),
            codeRevision: oid('c'),
            oldKnowledgeGitlink: input.knowledgeRevision,
            newKnowledgeGitlink: input.knowledgeRevision,
            targetRemoteReachability: true,
            planDigest: expectedPlanDigest,
            state: 'no-op',
            applied: false,
            noOp: true,
            partial: false,
            resultingParentCommitSha: null,
            recoveryCommand: ['knowledge', 'status'],
          });
        },
      },
      publication: {
        plan: (input) => {
          planInputs.push(input);
          return Promise.resolve(nextPlan);
        },
        commit: (input) => {
          commitInputs.push(input);
          return Promise.resolve({
            schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
            state: 'committed',
            projectId: input.projectId,
            baseRevision: oid('a'),
            foreignCounts: { staged: 0, unstaged: 0, untracked: 0 },
            knowledgeRevision: oid('d'),
            localCommitPreserved: true,
            partial: false,
            pinRequired: true,
            recoveryCommand: ['publish', 'push', '--project', input.projectId],
            remoteRevision: null,
            stagedPaths: ['projects/alpha/sources/entry.md'],
            treeRevision: oid('e'),
            warnings: [],
          });
        },
        push: (input) => {
          pushInputs.push(input);
          return Promise.resolve({
            schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
            state: 'push-failed',
            projectId: input.projectId,
            baseRevision: oid('a'),
            errorCode: 'PUBLISH_PUSH_FAILED',
            foreignCounts: { staged: 0, unstaged: 0, untracked: 0 },
            knowledgeRevision: input.knowledgeRevision,
            localCommitPreserved: true,
            partial: true,
            pinRequired: true,
            recoveryCommand: ['publish', 'push', '--project', input.projectId],
            remoteRevision: oid('a'),
            stagedPaths: ['projects/alpha/sources/entry.md'],
            treeRevision: oid('e'),
            warnings: [],
          });
        },
      },
      publicationLineage: {
        resolve: () => Promise.resolve({
          codeRevision: oid('c'),
          embeddingCompatibilityDigest: digest('8'),
          modelCompatibilityDigest: digest('9'),
          profileDigest: digest('a'),
          promptDigest: digest('b'),
        }),
      },
    };
    const planArgs = [
      'publish', 'plan', '--project', 'alpha', '--source-revision', oid('b'),
      '--include-policy-track', '--registration',
    ];
    const humanPlan = await capture(planArgs, runtime);
    const jsonPlan = await capture([...planArgs, '--json'], runtime);
    expect(humanPlan).toMatchObject({ exitCode: 0, stderr: '' });
    expect(humanPlan.stdout).toContain('outcome: planned\n');
    expect(JSON.parse(jsonPlan.stdout)).toMatchObject({
      command: 'publish.plan',
      data: { eligible: true, planDigest: digest('7') },
      ok: true,
    });
    expect(planInputs).toEqual([expect.objectContaining({
      includePolicyTrack: true,
      projectId: 'alpha',
      registration: true,
      sourceRevision: oid('b'),
    }), expect.objectContaining({ projectId: 'alpha' })]);

    nextPlan = publicationPlan(false);
    const ineligible = await capture(planArgs, runtime);
    expect(ineligible.exitCode).toBe(3);
    expect(ineligible.stderr).toContain('outcome: ineligible\n');
    nextPlan = {
      ...publicationPlan(false),
      blockReasons: ['DIRTY_INDEX'],
    };
    const dirty = await capture(planArgs, runtime);
    expect(dirty.exitCode).toBe(6);
    expect(dirty.stderr).toContain('error PUBLISH_INELIGIBLE');

    const committed = await capture([
      'publish', 'commit', '--project', 'alpha', '--source-revision', oid('b'),
      '--expect-plan', digest('7'), '--json',
    ], runtime);
    expect(JSON.parse(committed.stdout)).toMatchObject({
      data: { state: 'committed' },
      knowledgeRevision: oid('d'),
      ok: true,
    });
    expect(commitInputs).toEqual([expect.objectContaining({ expectedPlanDigest: digest('7') })]);

    const pushFailed = await capture([
      'publish', 'push', '--project', 'alpha', '--knowledge-revision', oid('d'), '--json',
    ], runtime);
    expect(pushFailed.exitCode).toBe(6);
    expect(JSON.parse(pushFailed.stderr)).toMatchObject({
      data: { localCommitPreserved: true, partial: true, state: 'push-failed' },
      errors: [{ code: 'PUBLISH_PUSH_FAILED' }],
      ok: false,
    });
    expect(pushInputs).toEqual([{ knowledgeRevision: oid('d'), projectId: 'alpha' }]);

    const pinPlan = await capture([
      'knowledge', 'pin', 'plan', '--knowledge-revision', oid('d'),
      '--iteration', 'v11-iteration', '--intent', 'iteration-close',
    ], runtime);
    expect(pinPlan.stdout).toContain('outcome: planned\n');
    pinPlanState = 'no-op';
    const pinNoOpPlan = await capture([
      'knowledge', 'pin', 'plan', '--knowledge-revision', oid('d'),
      '--iteration', 'v11-iteration', '--intent', 'iteration-close',
    ], runtime);
    expect(pinNoOpPlan.stdout).toContain('outcome: no-op\n');
    pinPlanState = 'ineligible';
    const pinIneligible = await capture([
      'knowledge', 'pin', 'plan', '--knowledge-revision', oid('d'),
      '--iteration', 'v11-iteration', '--intent', 'iteration-close', '--json',
    ], runtime);
    expect(pinIneligible.exitCode).toBe(6);
    expect(JSON.parse(pinIneligible.stderr)).toMatchObject({
      data: { eligible: false },
      errors: [{ code: 'PARENT_PIN_INELIGIBLE' }],
    });
    const pinNoOp = await capture([
      'knowledge', 'pin', 'commit', '--knowledge-revision', oid('d'),
      '--iteration', 'v11-iteration', '--intent', 'iteration-close',
      '--expect-plan', digest('8'), '--json',
    ], runtime);
    expect(JSON.parse(pinNoOp.stdout)).toMatchObject({ data: { state: 'no-op' }, ok: true });
    expect(pinPlans).toEqual([{
      intent: 'iteration-close',
      iterationId: 'v11-iteration',
      knowledgeRevision: oid('d'),
    }, {
      intent: 'iteration-close',
      iterationId: 'v11-iteration',
      knowledgeRevision: oid('d'),
    }, {
      intent: 'iteration-close',
      iterationId: 'v11-iteration',
      knowledgeRevision: oid('d'),
    }]);
    expect(pinCommits).toEqual([{
      digest: digest('8'),
      input: {
        intent: 'iteration-close',
        iterationId: 'v11-iteration',
        knowledgeRevision: oid('d'),
      },
    }]);
  });

  it('[V12-V-03] allows publish push only for the expected post-commit gitlink mismatch', async () => {
    const cwd = await createConfiguredRepository();
    const knowledge = join(cwd, 'knowledge');
    await configureIdentity(knowledge);
    await writeFile(join(knowledge, 'README.md'), '# Published knowledge\n', 'utf8');
    await git(knowledge, ['add', 'README.md']);
    await git(knowledge, ['commit', '-m', 'publication commit']);
    const revision = await git(knowledge, ['rev-parse', 'HEAD']);
    const treeRevision = await git(knowledge, ['rev-parse', 'HEAD^{tree}']);
    const pushInputs: KnowledgePublishPushInput[] = [];
    const runtime: CliRuntime = {
      cwd,
      publication: {
        plan: () => Promise.reject(new Error('plan must not run')),
        commit: () => Promise.reject(new Error('commit must not run')),
        push: (input) => {
          pushInputs.push(input);
          return Promise.resolve({
            schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
            state: 'pushed',
            projectId: input.projectId,
            baseRevision: oid('a'),
            foreignCounts: { staged: 0, unstaged: 0, untracked: 0 },
            knowledgeRevision: input.knowledgeRevision,
            localCommitPreserved: true,
            partial: false,
            pinRequired: true,
            recoveryCommand: ['knowledge', 'status'],
            remoteRevision: input.knowledgeRevision,
            stagedPaths: ['projects/alpha/sources/entry.md'],
            treeRevision,
            warnings: [],
          });
        },
      },
    };

    const allowed = await capture([
      'publish', 'push', '--project', 'alpha', '--knowledge-revision', revision, '--json',
    ], runtime);
    expect(allowed.exitCode).toBe(0);
    expect(pushInputs).toEqual([{ knowledgeRevision: revision, projectId: 'alpha' }]);

    const rejected = await capture([
      'publish', 'push', '--project', 'alpha', '--knowledge-revision', oid('f'), '--json',
    ], runtime);
    expect(rejected.exitCode).toBe(6);
    expect(JSON.parse(rejected.stderr)).toMatchObject({
      errors: [{ code: 'SUBMODULE_MISMATCH' }],
      ok: false,
    });
    expect(pushInputs).toHaveLength(1);
  });

  it('routes provider-free Wiki read and export commands through project-scoped ports', async () => {
    const cwd = await createConfiguredRepository();
    const calls: string[] = [];
    const wikiRead: WikiReadPort = {
      citations: (input) => {
        calls.push(`citations:${input.projectId}:${input.pageRef}`);
        return Promise.resolve({
          citations: [],
          pageRef: 'concepts/local-search',
          projectId: input.projectId,
          schemaVersion: 'buildlore.wiki-citations.v1',
        });
      },
      list: (input) => {
        calls.push(`list:${input.projectId}:${String(input.limit)}`);
        return Promise.resolve({
          pages: [],
          projectId: input.projectId,
          schemaVersion: 'buildlore.wiki-list.v1',
          total: 0,
        });
      },
      read: (input) => {
        calls.push(`read:${input.projectId}:${input.pageRef}`);
        return Promise.resolve({
          body: 'Verified page body.',
          pageRef: 'concepts/local-search',
          projectId: input.projectId,
          schemaVersion: 'buildlore.wiki-page.v1',
          sourceCount: 1,
          sourceRefs: [`markdown--${'a'.repeat(64)}.md`],
          summary: 'Verified summary.',
          title: 'Local Search',
          verified: true,
        });
      },
    };
    const wikiExport: WikiExportPort = {
      export: (input) => {
        calls.push(`export:${input.projectId}:${input.format}`);
        return Promise.resolve({
          digest: `sha256:${'b'.repeat(64)}`,
          fileCount: 1,
          format: input.format,
          pageCount: 1,
          projectId: input.projectId,
          schemaVersion: 'buildlore.wiki-export.v1',
        });
      },
    };
    const runtime: CliRuntime = { cwd, wikiExport, wikiRead };

    const listed = await capture(
      ['wiki', 'list', '--project', 'alpha', '--limit', '25', '--json'],
      runtime,
    );
    const read = await capture(
      ['wiki', 'read', '--project', 'alpha', '--page', 'concepts/local-search', '--json'],
      runtime,
    );
    const citations = await capture(
      ['wiki', 'citations', '--project', 'alpha', '--page', 'concepts/local-search', '--json'],
      runtime,
    );
    const exported = await capture([
      'export', '--project', 'alpha', '--format', 'json', '--output', 'exports/alpha', '--json',
    ], runtime);

    for (const result of [listed, read, citations, exported]) expect(result.exitCode).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      command: 'wiki.read',
      data: { body: 'Verified page body.', pageRef: 'concepts/local-search' },
      projectId: 'alpha',
    });
    expect(JSON.parse(exported.stdout)).toMatchObject({
      command: 'export',
      data: { format: 'json', pageCount: 1 },
      projectId: 'alpha',
    });
    expect(calls).toEqual([
      'list:alpha:25',
      'read:alpha:concepts/local-search',
      'citations:alpha:concepts/local-search',
      'export:alpha:json',
    ]);
  });

  it('routes model-free Wiki curate as a project-scoped read-only operation', async () => {
    const cwd = await createConfiguredRepository();
    const calls: string[] = [];
    const localWiki: LocalWikiOperatorPort = {
      curate: (input) => {
        calls.push(`curate:${input.projectId}`);
        return Promise.resolve({
          authorityCheckDigest: digest('a'),
          candidateCount: 0,
          corpusDigest: digest('b'),
          egress: 'none',
          generationDigest: digest('c'),
          modelUsed: 'none',
          mutationApplied: false,
          projectId: input.projectId,
          projectionDigest: digest('d'),
          providerUsed: 'none',
          readOnly: true,
          resultDigest: digest('e'),
          sanitizerPolicyDigest: digest('f'),
          schemaVersion: 'buildlore.model-free-wiki-curate-result.v1',
          suggestionCount: 0,
          suggestions: [],
          truncated: false,
        });
      },
      indexStatus: () => Promise.reject(new Error('index status must not run')),
      listPages: () => Promise.reject(new Error('list must not run')),
      pageCitations: () => Promise.reject(new Error('citations must not run')),
      readPage: () => Promise.reject(new Error('read must not run')),
      rebuildIndex: () => Promise.reject(new Error('rebuild must not run')),
      search: () => Promise.reject(new Error('search must not run')),
    };

    const result = await capture(
      ['wiki', 'curate', '--project', 'alpha', '--json'],
      { cwd, localWiki },
    );
    const human = await capture(
      ['wiki', 'curate', '--project', 'alpha'],
      { cwd, localWiki },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'wiki.curate',
      data: {
        egress: 'none',
        mutationApplied: false,
        projectId: 'alpha',
        providerUsed: 'none',
        readOnly: true,
      },
      projectId: 'alpha',
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('wiki.curate: ok');
    expect(human.stdout).toContain('"mutationApplied": false');
    expect(calls).toEqual(['curate:alpha', 'curate:alpha']);

    const rejected = await capture(
      ['wiki', 'curate', '--project', 'alpha', '--json'],
      {
        cwd,
        localWiki: Object.freeze({
          ...localWiki,
          curate: () => Promise.reject(
            new LocalWikiRetrievalError('LOCAL_WIKI_PROJECTION_INVALID'),
          ),
        }),
      },
    );
    expect(rejected.exitCode).toBe(3);
    expect(JSON.parse(rejected.stderr)).toMatchObject({
      command: 'wiki.curate',
      errors: [{ code: 'LOCAL_WIKI_PROJECTION_INVALID' }],
      ok: false,
      projectId: 'alpha',
    });
  });

  it('routes path-free model operations without project or knowledge state', async () => {
    const calls: string[] = [];
    const runtime: CliRuntime = {
      cwd: '/private/hub',
      localModels: {
        bind: (input) => {
          calls.push(`bind:${input.profileId}:${input.directory === undefined ? 'default' : 'set'}`);
          return Promise.resolve({
            outcome: 'created',
            profileId: input.profileId,
            state: 'unavailable',
          });
        },
        inspect: (profileId) => {
          calls.push(`inspect:${profileId}`);
          return Promise.resolve({
            activeIdentity: null,
            profileId,
            reasonCode: 'binding-stale',
            recoveryAction: ['model', 'verify', '--profile', profileId],
            state: 'unavailable',
          });
        },
        verify: (profileId) => {
          calls.push(`verify:${profileId}`);
          return Promise.resolve({
            activeIdentity: null,
            profileId,
            reasonCode: 'artifact-missing',
            recoveryAction: ['model', 'verify', '--profile', profileId],
            state: 'unavailable',
          });
        },
      },
    };
    const bound = await capture([
      'model', 'bind', '--profile', 'multilingual-e5-small',
      '--directory', '/private/user/model', '--json',
    ], runtime);
    const inspected = await capture([
      'model', 'inspect', '--profile', 'multilingual-e5-small', '--json',
    ], runtime);
    const verified = await capture([
      'model', 'verify', '--profile', 'multilingual-e5-small', '--json',
    ], runtime);
    expect([bound.exitCode, inspected.exitCode, verified.exitCode]).toEqual([0, 0, 0]);
    expect(`${bound.stdout}${inspected.stdout}${verified.stdout}`).not.toContain('/private');
    expect(calls).toEqual([
      'bind:multilingual-e5-small:set',
      'inspect:multilingual-e5-small',
      'verify:multilingual-e5-small',
    ]);
  });
});
