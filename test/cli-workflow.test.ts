import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type CompilerOperationResult,
  type CompilerRequest,
  type ProjectCheckSummary,
  type ProjectCompilerPort,
} from '../src/compiler/index.js';
import { runCli, type CliIo, type CliRuntime } from '../src/cli/index.js';
import {
  PROJECT_SYNC_SCHEMA_VERSION,
  type ProjectSyncInput,
  type ProjectSyncSummary,
} from '../src/projector/index.js';
import type {
  ProjectContextRequest,
  ProjectContextResult,
  ProjectSearchRequest,
  ProjectSearchResult,
} from '../src/retrieval/index.js';

const temporaryRoots: string[] = [];
const PLAN_FINGERPRINT =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

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
    const added = await capture(
      [
        'project',
        'add',
        '--id',
        projectId,
        '--source-repo',
        `https://example.test/${projectId}.git`,
      ],
      bootstrapRuntime,
    );
    if (added.exitCode !== 0) throw new Error('Project fixture creation failed.');
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
    writes: [],
  };
}

function searchResult(request: ProjectSearchRequest): ProjectSearchResult {
  const requestedMode = request.mode ?? 'hybrid';
  return {
    effectiveMode: requestedMode === 'lexical' ? 'lexical' : 'lexical',
    excluded: { archived: 0, orphaned: 0, stale: 0, unverified: 0 },
    fallback: requestedMode === 'lexical'
      ? null
      : { fromMode: requestedMode, reasonCode: 'provider-unconfigured', toMode: 'lexical' },
    hits: [],
    partial: requestedMode !== 'lexical',
    projectId: request.projectId,
    requestedMode,
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
      artifactRoot: join(cwd, 'artifacts'),
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
        artifactRoot: join(cwd, 'artifacts'),
        dryRun: true,
        knowledgeRoot: join(cwd, 'knowledge'),
        projectId: 'alpha',
      },
      {
        artifactRoot: join(cwd, 'artifacts'),
        dryRun: false,
        knowledgeRoot: join(cwd, 'knowledge'),
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
});
