import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompilerRequest } from '../src/compiler/index.js';
import { runCli, type CliIo, type CliRuntime } from '../src/cli/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { GitMachineAdapter, type GitMachinePort } from '../src/knowledge/git-machine.js';
import { resolveGitCommonDirectory } from '../src/knowledge/git.js';
import {
  parseParentKnowledgePinPlan,
  parseParentKnowledgePinResult,
  renderParentKnowledgePinPlan,
  renderParentKnowledgePinResult,
} from '../src/knowledge/parent-pin-codec.js';
import { createParentKnowledgePinService } from '../src/knowledge/parent-pin-service.js';
import type { ParentKnowledgePinInput } from '../src/knowledge/parent-pin-types.js';
import {
  createKnowledgePublicationServiceForTesting as createKnowledgePublicationService,
} from '../src/knowledge/publication-service.js';
import type {
  PublicationBlobPolicyPort,
  PublicationDigest,
} from '../src/knowledge/publication-types.js';
import {
  RepositoryWriterLeaseManager,
  type RepositoryWriterLease,
  type RepositoryWriterOperation,
  type RepositoryWriterLeasePort,
} from '../src/knowledge/repository-writer-lease.js';
import { KNOWLEDGE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from '../src/knowledge/types.js';
import { PROJECT_SYNC_SCHEMA_VERSION } from '../src/projector/index.js';

const roots: string[] = [];
const digest = (character: string): PublicationDigest => `sha256:${character.repeat(64)}`;
const allowPolicy: PublicationBlobPolicyPort = {
  validate: vi.fn(() => Promise.resolve(true)),
};

function git(cwd: string, args: readonly string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error('Git parent pin fixture command failed.'));
          return;
        }
        resolve(stdout.trim());
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

async function writeKnowledgeProject(root: string): Promise<void> {
  const workspace = join(root, 'projects', 'alpha');
  await Promise.all([
    mkdir(join(workspace, 'sources'), { recursive: true }),
    mkdir(join(workspace, 'wiki'), { recursive: true }),
    mkdir(join(workspace, '.llmwiki'), { recursive: true }),
  ]);
  await writeFile(join(workspace, 'project.json'), serializeCanonicalJson({
    profileVersion: 'llmwiki.default.v1',
    projectId: 'alpha',
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sourceRepository: '../alpha',
  }), 'utf8');
  await writeFile(join(workspace, 'log.md'), '# Alpha\n', 'utf8');
  await writeFile(join(workspace, 'sources', 'entry.md'), '# initial source\n', 'utf8');
  await writeFile(join(workspace, 'wiki', '.gitkeep'), '', 'utf8');
  await writeFile(join(workspace, '.llmwiki', '.gitkeep'), '', 'utf8');
  await writeFile(join(root, '.gitignore'), 'projects/*/.llmwiki/embeddings.json\n', 'utf8');
  await writeFile(join(root, 'manifest.json'), serializeCanonicalJson({
    projects: [{
      displayName: 'Alpha',
      path: 'projects/alpha',
      projectId: 'alpha',
      sourceRepository: '../alpha',
    }],
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
  }), 'utf8');
}

async function optionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

interface ParentPinFixture {
  readonly input: ParentKnowledgePinInput;
  readonly knowledgeRoot: string;
  readonly knowledgeRevision: string;
  readonly parentBaseRevision: string;
  readonly parentRemoteRoot: string;
  readonly parentRoot: string;
  readonly preparationTrace: Readonly<{
    readonly compileCalls: number;
    readonly presentation: string;
    readonly syncCalls: number;
  }>;
  readonly publicationTrace: Readonly<{
    readonly afterCommitRemote: string;
    readonly afterPlanSnapshot: string;
    readonly afterPushParentSnapshot: string;
    readonly afterPushRemote: string;
    readonly beforePlanSnapshot: string;
    readonly beforePushParentSnapshot: string;
    readonly commitArtifact: string;
    readonly commitLog: string;
    readonly commitResult: string;
    readonly errorResult: string;
    readonly leaseMetadata: string;
    readonly planArtifact: string;
    readonly stagedBlobSnapshot: string;
    readonly stagedSnapshot: string;
  }>;
  readonly remoteRoot: string;
  readonly securitySentinels: readonly string[];
}

async function runPreparationWorkflow(
  parentRoot: string,
  knowledgeRoot: string,
  securitySentinels: readonly string[],
): Promise<ParentPinFixture['preparationTrace']> {
  let compileCalls = 0;
  let syncCalls = 0;
  let presentation = '';
  const io: CliIo = {
    stderr: (message) => { presentation += message; },
    stdout: (message) => { presentation += message; },
  };
  const sourceRevision = digest('f');
  const emptyPlan = {
    counts: { blocked: 0, error: 0, exclude: 0, include: 0, quarantine: 0 },
    entries: [],
    planFingerprint: digest('1'),
  } as const;
  const runtime: CliRuntime = {
    cwd: parentRoot,
    projectCompiler: {
      execute: async (request: CompilerRequest) => {
        if (request.capability !== 'compile') throw new Error('Unexpected compiler capability.');
        compileCalls += 1;
        await mkdir(join(knowledgeRoot, 'projects', 'alpha', 'wiki', 'concepts'));
        await writeFile(
          join(knowledgeRoot, 'projects', 'alpha', 'wiki', 'concepts', 'iteration-close.md'),
          '# Compiled iteration-close page\n',
          'utf8',
        );
        return {
          capability: 'compile',
          data: {
            candidateCount: 0,
            candidates: [],
            compiled: 1,
            deleted: 0,
            pageIds: ['iteration-close'],
            skipped: 0,
          },
          ok: true,
          outcome: 'succeeded',
          projectId: request.projectId,
          warnings: [],
        };
      },
      status: () => Promise.resolve({
        pendingChanges: [],
        pendingChangesCount: 0,
        stateStatus: 'ok',
      }),
    },
    sync: {
      sync: async (input) => {
        syncCalls += 1;
        await writeFile(
          join(knowledgeRoot, 'projects', 'alpha', 'sources', 'entry.md'),
          '# synchronized iteration-close source\n',
          'utf8',
        );
        const planning = {
          counts: { ...emptyPlan.counts, include: 1 },
          entries: [{
            decision: 'include',
            reasonCode: 'accepted-fixture-source',
            sourceKind: 'planning',
            sourceRef: 'fixture/iteration-close',
            sourceRevision,
            target: 'projects/alpha/sources/entry.md',
            writeStatus: 'update',
          }],
          planFingerprint: digest('2'),
        } as const;
        return {
          appliedCount: 1,
          dryRun: input.dryRun,
          execution: emptyPlan,
          partial: false,
          planning,
          projectId: input.projectId,
          remainingCount: 0,
          schemaVersion: PROJECT_SYNC_SCHEMA_VERSION,
          warnings: [],
          writes: [{
            sourceKind: 'planning',
            sourceRevision,
            target: 'projects/alpha/sources/entry.md',
            writeStatus: 'update',
          }],
        };
      },
    },
  };
  const syncExit = await runCli(['sync', '--project', 'alpha'], io, runtime);
  const compileExit = await runCli(['compile', '--project', 'alpha', '--json'], io, runtime);
  if (syncExit !== 0 || compileExit !== 0) {
    throw new Error(
      `Provider-free preparation workflow failed: sync=${syncExit}/${syncCalls}, compile=${compileExit}/${compileCalls}.`,
    );
  }
  await writeFile(
    join(knowledgeRoot, 'projects', 'alpha', '.llmwiki', 'embeddings.json'),
    JSON.stringify(securitySentinels),
    'utf8',
  );
  return { compileCalls, presentation, syncCalls };
}

async function publicationSnapshot(
  knowledgeRoot: string,
  remoteRoot: string,
): Promise<string> {
  return JSON.stringify({
    head: await git(knowledgeRoot, ['rev-parse', 'HEAD']),
    index: await git(knowledgeRoot, ['ls-files', '--stage']),
    remote: await git(remoteRoot, ['rev-parse', 'refs/heads/main']),
    status: await git(knowledgeRoot, ['status', '--porcelain=v2', '--untracked-files=all']),
  });
}

async function parentSnapshot(parentRoot: string): Promise<string> {
  return JSON.stringify({
    gitlink: await git(parentRoot, ['ls-tree', 'HEAD', 'knowledge']),
    head: await git(parentRoot, ['rev-parse', 'HEAD']),
    index: await git(parentRoot, ['ls-files', '--stage']),
    status: await git(parentRoot, ['status', '--porcelain=v2', '--untracked-files=all']),
  });
}

async function createFixture(): Promise<ParentPinFixture> {
  const container = await mkdtemp(join(tmpdir(), 'buildlore-parent-pin-'));
  roots.push(container);
  const seedRoot = join(container, 'knowledge-seed');
  const remoteRoot = join(container, 'knowledge-remote.git');
  const parentRoot = join(container, 'parent');
  const parentRemoteRoot = join(container, 'parent-remote.git');
  await Promise.all([
    mkdir(seedRoot),
    mkdir(remoteRoot),
    mkdir(parentRoot),
    mkdir(parentRemoteRoot),
  ]);

  await git(seedRoot, ['init', '--initial-branch=main']);
  await git(seedRoot, ['config', 'user.name', 'BuildLore Test']);
  await git(seedRoot, ['config', 'user.email', 'buildlore@example.invalid']);
  await writeKnowledgeProject(seedRoot);
  await git(seedRoot, ['add', '--all']);
  await git(seedRoot, ['commit', '-m', 'knowledge baseline']);
  await git(remoteRoot, ['init', '--bare', '--initial-branch=main']);
  await git(seedRoot, ['remote', 'add', 'origin', remoteRoot]);
  await git(seedRoot, ['push', '--set-upstream', 'origin', 'main']);

  await git(parentRoot, ['init', '--initial-branch=main']);
  await git(parentRoot, ['config', 'user.name', 'BuildLore Test']);
  await git(parentRoot, ['config', 'user.email', 'buildlore@example.invalid']);
  await writeFile(join(parentRoot, 'README.md'), '# Parent fixture\n', 'utf8');
  await git(parentRoot, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-b',
    'main',
    remoteRoot,
    'knowledge',
  ]);
  await git(parentRoot, [
    'config',
    '-f',
    '.gitmodules',
    'submodule.knowledge.url',
    '../knowledge-remote.git',
  ]);
  await git(parentRoot, ['add', '--all']);
  await git(parentRoot, ['commit', '-m', 'parent code baseline']);
  const parentBaseRevision = await git(parentRoot, ['rev-parse', 'HEAD']);
  await git(parentRemoteRoot, ['init', '--bare', '--initial-branch=main']);
  await git(parentRoot, ['remote', 'add', 'origin', parentRemoteRoot]);
  await git(parentRoot, ['push', '--set-upstream', 'origin', 'main']);

  const knowledgeRoot = join(parentRoot, 'knowledge');
  await git(knowledgeRoot, ['config', 'user.name', 'BuildLore Test']);
  await git(knowledgeRoot, ['config', 'user.email', 'buildlore@example.invalid']);
  await git(knowledgeRoot, ['checkout', 'main']);
  await git(knowledgeRoot, ['branch', '--set-upstream-to=origin/main', 'main']);
  const securitySentinels = [
    ['ghp_', 'A'.repeat(24)].join(''),
    ['private', 'endpoint', 'sentinel', 'example', 'invalid'].join('.'),
    parentRoot,
    ['source', 'body', 'sentinel', 'v11'].join('-'),
  ];
  const preparationTrace = await runPreparationWorkflow(
    parentRoot,
    knowledgeRoot,
    securitySentinels,
  );
  const publicationInput = {
    codeRevision: parentBaseRevision,
    embeddingCompatibilityDigest: digest('e'),
    includePolicyTrack: false,
    modelCompatibilityDigest: digest('d'),
    profileDigest: digest('a'),
    projectId: 'alpha',
    promptDigest: digest('c'),
    registration: false,
    sourceRevision: 'a'.repeat(40),
  };
  let leaseMetadata = '';
  let stagedBlobSnapshot = '';
  let stagedSnapshot = '';
  const knowledgeCommonDirectory = await resolveGitCommonDirectory(knowledgeRoot);
  const publisher = createKnowledgePublicationService(knowledgeRoot, {
    blobPolicy: allowPolicy,
    hooks: {
      afterAdd: async () => {
        leaseMetadata = await readFile(
          join(knowledgeCommonDirectory, 'buildlore.repository-writer.lock'),
          'utf8',
        );
        stagedSnapshot = await git(knowledgeRoot, [
          'diff',
          '--cached',
          '--binary',
          '--no-ext-diff',
        ]);
        stagedBlobSnapshot = (await Promise.all([
          git(knowledgeRoot, ['show', ':projects/alpha/sources/entry.md']),
          git(knowledgeRoot, ['show', ':projects/alpha/wiki/concepts/iteration-close.md']),
        ])).join('\0');
      },
    },
  });
  const beforePlanSnapshot = await publicationSnapshot(knowledgeRoot, remoteRoot);
  const publishPlan = await publisher.plan(publicationInput);
  const afterPlanSnapshot = await publicationSnapshot(knowledgeRoot, remoteRoot);
  const commit = await publisher.commit({
    ...publicationInput,
    expectedPlanDigest: publishPlan.planDigest,
  });
  if (commit.state !== 'committed') {
    const outcome = commit.state === 'blocked' || commit.state === 'push-failed'
      ? commit.errorCode
      : commit.state;
    throw new Error(
      `Knowledge fixture commit failed: ${outcome}/${publishPlan.blockReasons.join(',')}.`,
    );
  }
  const errorResult = JSON.stringify(await publisher.push({
    knowledgeRevision: '0'.repeat(40),
    projectId: 'alpha',
  }));
  const afterCommitRemote = await git(remoteRoot, ['rev-parse', 'refs/heads/main']);
  const beforePushParentSnapshot = await parentSnapshot(parentRoot);
  const pushed = await publisher.push({
    knowledgeRevision: commit.knowledgeRevision,
    projectId: 'alpha',
  });
  if (pushed.state !== 'pushed') {
    const outcome = pushed.state === 'blocked' || pushed.state === 'push-failed'
      ? pushed.errorCode
      : pushed.state;
    throw new Error(`Knowledge fixture push failed: ${outcome}.`);
  }
  const afterPushRemote = await git(remoteRoot, ['rev-parse', 'refs/heads/main']);
  const afterPushParentSnapshot = await parentSnapshot(parentRoot);
  return {
    input: {
      intent: 'iteration-close',
      iterationId: 'v11-knowledge-git-publish-concurrency',
      knowledgeRevision: commit.knowledgeRevision,
    },
    knowledgeRoot,
    knowledgeRevision: commit.knowledgeRevision,
    parentBaseRevision,
    parentRemoteRoot,
    parentRoot,
    preparationTrace,
    publicationTrace: {
      afterCommitRemote,
      afterPlanSnapshot,
      afterPushParentSnapshot,
      afterPushRemote,
      beforePlanSnapshot,
      beforePushParentSnapshot,
      commitArtifact: await git(knowledgeRoot, [
        'show',
        '-s',
        '--format=%H%x00%P%x00%T%x00%B',
        commit.knowledgeRevision,
      ]),
      commitLog: await git(knowledgeRoot, ['log', '-1', '--format=%B']),
      commitResult: JSON.stringify(commit),
      errorResult,
      leaseMetadata,
      planArtifact: JSON.stringify(publishPlan),
      stagedBlobSnapshot,
      stagedSnapshot,
    },
    remoteRoot,
    securitySentinels,
  };
}

function wrapGit(overrides: Partial<GitMachinePort>): GitMachinePort {
  const real = new GitMachineAdapter();
  return {
    addExact: overrides.addExact ?? real.addExact.bind(real),
    stageValidated: overrides.stageValidated ?? real.stageValidated.bind(real),
    isExactStageContent: overrides.isExactStageContent ?? real.isExactStageContent.bind(real),
    worktreeNumstat: overrides.worktreeNumstat ?? real.worktreeNumstat.bind(real),
    untrackedNumstat: overrides.untrackedNumstat ?? real.untrackedNumstat.bind(real),
    cachedDiff: overrides.cachedDiff ?? real.cachedDiff.bind(real),
    commitTree: overrides.commitTree ?? real.commitTree.bind(real),
    fetchObjectNoRefUpdate: overrides.fetchObjectNoRefUpdate ??
      real.fetchObjectNoRefUpdate.bind(real),
    isAncestor: overrides.isAncestor ?? real.isAncestor.bind(real),
    proveRemoteReachability: overrides.proveRemoteReachability ??
      real.proveRemoteReachability.bind(real),
    lsRemoteExact: overrides.lsRemoteExact ?? real.lsRemoteExact.bind(real),
    pushExactNonForce: overrides.pushExactNonForce ?? real.pushExactNonForce.bind(real),
    status: overrides.status ?? real.status.bind(real),
    updateRefCompareAndSwap: overrides.updateRefCompareAndSwap ??
      real.updateRefCompareAndSwap.bind(real),
    writeTree: overrides.writeTree ?? real.writeTree.bind(real),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
});

describe('ParentKnowledgePinService', () => {
  it('rejects malformed public input and stale plan bindings before Git mutation', async () => {
    const fixture = await createFixture();
    const machine = new GitMachineAdapter();
    const add = vi.spyOn(machine, 'addExact');
    const status = vi.spyOn(machine, 'status');
    const service = createParentKnowledgePinService(fixture.parentRoot, {
      gitMachine: machine,
    });
    const invalidInputs: readonly unknown[] = [
      null,
      [],
      { ...fixture.input, unknown: true },
      { iterationId: fixture.input.iterationId, knowledgeRevision: fixture.knowledgeRevision },
      { ...fixture.input, intent: 'automatic' },
      { ...fixture.input, iterationId: 'x'.repeat(121) },
      { ...fixture.input, knowledgeRevision: 'a'.repeat(12) },
    ];
    for (const invalid of invalidInputs) {
      await expect(service.plan(invalid as ParentKnowledgePinInput)).rejects.toMatchObject({
        code: 'PARENT_PIN_PLAN_DRIFT',
        partial: false,
      });
    }
    expect(status).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();

    await expect(service.commit(
      fixture.input,
      'invalid' as PublicationDigest,
    )).rejects.toMatchObject({ code: 'PARENT_PIN_PLAN_DRIFT', partial: false });
    expect(status).not.toHaveBeenCalled();
    const plan = await service.plan(fixture.input);
    const staleDigest = digest(plan.planDigest === digest('f') ? 'e' : 'f');
    const result = await service.commit(fixture.input, staleDigest);
    expect(result).toMatchObject({
      state: 'blocked',
      errorCode: 'PARENT_PIN_PLAN_DRIFT',
      partial: false,
      resultingParentCommitSha: null,
    });
    expect(add).not.toHaveBeenCalled();
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD']))
      .resolves.toBe(fixture.parentBaseRevision);
  });

  it('keeps plan mutation-free and durably commits exactly one knowledge gitlink', async () => {
    const fixture = await createFixture();
    expect(fixture.preparationTrace).toMatchObject({ compileCalls: 1, syncCalls: 1 });
    expect(fixture.publicationTrace.afterPlanSnapshot)
      .toBe(fixture.publicationTrace.beforePlanSnapshot);
    expect(fixture.publicationTrace.afterCommitRemote)
      .not.toBe(fixture.knowledgeRevision);
    expect(fixture.publicationTrace.afterPushRemote).toBe(fixture.knowledgeRevision);
    expect(fixture.publicationTrace.afterPushParentSnapshot)
      .toBe(fixture.publicationTrace.beforePushParentSnapshot);
    const machine = new GitMachineAdapter();
    const push = vi.spyOn(machine, 'pushExactNonForce');
    const fetch = vi.spyOn(machine, 'fetchObjectNoRefUpdate');
    const service = createParentKnowledgePinService(fixture.parentRoot, {
      gitMachine: machine,
    });
    const before = {
      head: await git(fixture.parentRoot, ['rev-parse', 'HEAD']),
      index: await git(fixture.parentRoot, ['ls-files', '--stage']),
      knowledgeFetchHead: await optionalFile(join(
        await resolveGitCommonDirectory(fixture.knowledgeRoot),
        'FETCH_HEAD',
      )),
      knowledgeRemoteRefs: await git(fixture.knowledgeRoot, [
        'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes/',
      ]),
      parentFetchHead: await optionalFile(join(
        await resolveGitCommonDirectory(fixture.parentRoot),
        'FETCH_HEAD',
      )),
      parentRemoteAliases: await git(fixture.parentRoot, ['remote']),
      parentRemoteRefs: await git(fixture.parentRoot, [
        'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes/',
      ]),
      parentRemoteRevision: await git(fixture.parentRemoteRoot, [
        'rev-parse', 'refs/heads/main',
      ]),
      remote: await git(fixture.remoteRoot, ['rev-parse', 'refs/heads/main']),
      status: await git(fixture.parentRoot, ['status', '--porcelain=v2', '--untracked-files=all']),
    };

    const plan = await service.plan(fixture.input);
    expect(plan).toMatchObject({
      eligible: true,
      noOp: false,
      parentBaseRevision: fixture.parentBaseRevision,
      codeRevision: fixture.parentBaseRevision,
      newKnowledgeGitlink: fixture.knowledgeRevision,
      path: 'knowledge',
      projectId: 'alpha',
      targetRemoteReachability: true,
    });
    expect(plan.oldKnowledgeGitlink).toMatch(/^[a-f0-9]{40}$/u);
    expect(parseParentKnowledgePinPlan(renderParentKnowledgePinPlan(plan))).toEqual(plan);
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD'])).resolves.toBe(before.head);
    await expect(git(fixture.parentRoot, ['ls-files', '--stage'])).resolves.toBe(before.index);
    await expect(git(fixture.parentRoot, [
      'status', '--porcelain=v2', '--untracked-files=all',
    ])).resolves.toBe(before.status);
    await expect(git(fixture.remoteRoot, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(before.remote);
    await expect(optionalFile(join(
      await resolveGitCommonDirectory(fixture.parentRoot),
      'FETCH_HEAD',
    ))).resolves.toEqual(before.parentFetchHead);
    await expect(git(fixture.parentRoot, ['remote']))
      .resolves.toBe(before.parentRemoteAliases);
    await expect(git(fixture.parentRoot, [
      'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes/',
    ])).resolves.toBe(before.parentRemoteRefs);
    await expect(git(fixture.parentRemoteRoot, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(before.parentRemoteRevision);
    await expect(optionalFile(join(
      await resolveGitCommonDirectory(fixture.knowledgeRoot),
      'FETCH_HEAD',
    ))).resolves.toEqual(before.knowledgeFetchHead);
    await expect(git(fixture.knowledgeRoot, [
      'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes/',
    ])).resolves.toBe(before.knowledgeRemoteRefs);
    expect(fetch).not.toHaveBeenCalled();

    const result = await service.commit(fixture.input, plan.planDigest);
    expect(result).toMatchObject({
      state: 'applied',
      applied: true,
      noOp: false,
      partial: false,
      newKnowledgeGitlink: fixture.knowledgeRevision,
      parentBaseRevision: fixture.parentBaseRevision,
    });
    expect(result.resultingParentCommitSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(parseParentKnowledgePinResult(renderParentKnowledgePinResult(result))).toEqual(result);
    expect(push).not.toHaveBeenCalled();
    await expect(git(fixture.remoteRoot, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(before.remote);
    await expect(git(fixture.parentRoot, ['remote']))
      .resolves.toBe(before.parentRemoteAliases);
    await expect(git(fixture.parentRoot, [
      'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes/',
    ])).resolves.toBe(before.parentRemoteRefs);
    await expect(git(fixture.parentRemoteRoot, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(before.parentRemoteRevision);
    await expect(optionalFile(join(
      await resolveGitCommonDirectory(fixture.parentRoot),
      'FETCH_HEAD',
    ))).resolves.toEqual(before.parentFetchHead);
    await expect(git(fixture.parentRoot, ['status', '--porcelain'])).resolves.toBe('');
    await expect(git(fixture.parentRoot, [
      'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD',
    ])).resolves.toBe('knowledge');
    await expect(git(fixture.parentRoot, ['ls-tree', 'HEAD', '--', 'knowledge']))
      .resolves.toContain(`160000 commit ${fixture.knowledgeRevision}\tknowledge`);
    const commitMessage = await git(fixture.parentRoot, ['log', '-1', '--format=%B']);
    expect(commitMessage).toContain('buildlore.parent-knowledge-pin-commit.v1');
    expect(commitMessage).not.toContain('iteration-close source');
    expect(commitMessage).not.toContain(fixture.parentRoot);
    expect(commitMessage).not.toContain(fixture.remoteRoot);
    expect(commitMessage).not.toContain(fixture.parentRemoteRoot);
    const messageParts = commitMessage.split('\n\n');
    expect(messageParts).toHaveLength(2);
    const metadata: unknown = JSON.parse(messageParts[1] ?? '');
    expect(metadata).toEqual({
      schemaVersion: 'buildlore.parent-knowledge-pin-commit.v1',
      intent: 'iteration-close',
      iterationId: fixture.input.iterationId,
      path: 'knowledge',
      parentBaseRevision: plan.parentBaseRevision,
      codeRevision: plan.codeRevision,
      oldKnowledgeGitlink: plan.oldKnowledgeGitlink,
      newKnowledgeGitlink: plan.newKnowledgeGitlink,
      projectId: plan.projectId,
      sourceRevision: plan.sourceRevision,
      knowledgeLineageDigest: plan.lineageDigest,
      planDigest: plan.planDigest,
    });
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD']))
      .resolves.toBe(result.resultingParentCommitSha);
    expect(JSON.stringify(result)).not.toContain(fixture.parentRoot);
    expect(JSON.stringify(result)).not.toContain(fixture.remoteRoot);
  }, 15_000);

  it('[V12-V-06] proves remote descendant reachability without importing it locally', async () => {
    const fixture = await createFixture();
    await git(fixture.remoteRoot, ['config', 'user.name', 'BuildLore Remote Test']);
    await git(fixture.remoteRoot, ['config', 'user.email', 'remote@example.invalid']);
    const remoteTree = await git(fixture.remoteRoot, [
      'rev-parse', `${fixture.knowledgeRevision}^{tree}`,
    ]);
    const remoteDescendant = await git(fixture.remoteRoot, [
      'commit-tree', remoteTree, '-p', fixture.knowledgeRevision, '-m', 'remote descendant',
    ]);
    await git(fixture.remoteRoot, ['update-ref', 'refs/heads/main', remoteDescendant]);
    await expect(git(fixture.knowledgeRoot, ['cat-file', '-e', `${remoteDescendant}^{commit}`]))
      .rejects.toThrow();

    const beforeObjects = await git(fixture.knowledgeRoot, [
      'cat-file', '--batch-all-objects', '--batch-check=%(objectname)',
    ]);
    const beforeRefs = await git(fixture.knowledgeRoot, [
      'for-each-ref', '--format=%(refname)%00%(objectname)',
    ]);
    const beforeFetchHead = await optionalFile(join(
      await resolveGitCommonDirectory(fixture.knowledgeRoot),
      'FETCH_HEAD',
    ));

    const plan = await createParentKnowledgePinService(fixture.parentRoot).plan(fixture.input);
    expect(plan).toMatchObject({ eligible: true, targetRemoteReachability: true });
    await expect(git(fixture.knowledgeRoot, ['cat-file', '-e', `${remoteDescendant}^{commit}`]))
      .rejects.toThrow();
    await expect(git(fixture.knowledgeRoot, [
      'cat-file', '--batch-all-objects', '--batch-check=%(objectname)',
    ])).resolves.toBe(beforeObjects);
    await expect(git(fixture.knowledgeRoot, [
      'for-each-ref', '--format=%(refname)%00%(objectname)',
    ])).resolves.toBe(beforeRefs);
    await expect(optionalFile(join(
      await resolveGitCommonDirectory(fixture.knowledgeRoot),
      'FETCH_HEAD',
    ))).resolves.toEqual(beforeFetchHead);
  });

  it('[V11-V-15] keeps private byte sentinels out of every publication evidence surface', async () => {
    const fixture = await createFixture();
    const inventory = await readFile(
      new URL('./fixtures/tracking-policy/llm-wiki-compiler-1.1.0-inventory.json', import.meta.url),
      'utf8',
    );
    const evidence = {
      cliHumanAndJson: fixture.preparationTrace.presentation,
      commitArtifact: fixture.publicationTrace.commitArtifact,
      commitLog: fixture.publicationTrace.commitLog,
      commitResult: fixture.publicationTrace.commitResult,
      errorResult: fixture.publicationTrace.errorResult,
      inventory,
      leaseMetadata: fixture.publicationTrace.leaseMetadata,
      parentSnapshot: fixture.publicationTrace.afterPushParentSnapshot,
      planArtifact: fixture.publicationTrace.planArtifact,
      repositorySnapshot: fixture.publicationTrace.afterPlanSnapshot,
      stagedBlobSnapshot: fixture.publicationTrace.stagedBlobSnapshot,
      temporaryDiff: fixture.publicationTrace.stagedSnapshot,
    };
    const sentinels = fixture.securitySentinels;
    for (const [surface, bytes] of Object.entries(evidence)) {
      expect(bytes.length, `${surface} must be executable evidence`).toBeGreaterThan(0);
      for (const sentinel of sentinels) {
        expect(bytes, `${surface} reflected a private sentinel`).not.toContain(sentinel);
      }
    }
  });

  it('revalidates an idempotent no-op under canonical dual locks with zero Git mutation', async () => {
    const fixture = await createFixture();
    const firstService = createParentKnowledgePinService(fixture.parentRoot);
    const initialPlan = await firstService.plan(fixture.input);
    const initial = await firstService.commit(fixture.input, initialPlan.planDigest);
    expect(initial.state).toBe('applied');

    const machine = new GitMachineAdapter();
    const add = vi.spyOn(machine, 'addExact');
    const commitTree = vi.spyOn(machine, 'commitTree');
    const updateRef = vi.spyOn(machine, 'updateRefCompareAndSwap');
    const push = vi.spyOn(machine, 'pushExactNonForce');
    const realLease = new RepositoryWriterLeaseManager();
    const leaseOrder: string[] = [];
    const recordingLease: RepositoryWriterLeasePort = {
      withLease: async <T>(
        root: string,
        operation: RepositoryWriterOperation,
        action: (lease: RepositoryWriterLease) => Promise<T> | T,
      ): Promise<T> => {
        leaseOrder.push(await resolveGitCommonDirectory(root));
        return realLease.withLease(root, operation, action);
      },
    };
    const service = createParentKnowledgePinService(fixture.parentRoot, {
      gitMachine: machine,
      lease: recordingLease,
    });
    const plan = await service.plan(fixture.input);
    expect(plan).toMatchObject({
      eligible: true,
      noOp: true,
      oldKnowledgeGitlink: fixture.knowledgeRevision,
      newKnowledgeGitlink: fixture.knowledgeRevision,
      codeRevision: fixture.parentBaseRevision,
    });
    const beforeHead = await git(fixture.parentRoot, ['rev-parse', 'HEAD']);
    const result = await service.commit(fixture.input, plan.planDigest);
    expect(result).toMatchObject({ state: 'no-op', applied: false, noOp: true, partial: false });
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD'])).resolves.toBe(beforeHead);
    expect(leaseOrder).toHaveLength(2);
    expect(leaseOrder).toEqual([...leaseOrder].sort());
    expect(add).not.toHaveBeenCalled();
    expect(commitTree).not.toHaveBeenCalled();
    expect(updateRef).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    const otherIterationInput = {
      ...fixture.input,
      iterationId: 'v11-follow-up-close',
    };
    const otherPlan = await service.plan(otherIterationInput);
    expect(otherPlan).toMatchObject({ eligible: true, noOp: true });
    const otherResult = await service.commit(otherIterationInput, otherPlan.planDigest);
    expect(otherResult).toMatchObject({ state: 'no-op', applied: false, noOp: true });
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD'])).resolves.toBe(beforeHead);
    expect(add).not.toHaveBeenCalled();
    expect(commitTree).not.toHaveBeenCalled();
    expect(updateRef).not.toHaveBeenCalled();
  });

  it('accepts an already-pinned clean target without requiring a prior BuildLore pin message', async () => {
    const fixture = await createFixture();
    await git(fixture.parentRoot, ['add', '--', 'knowledge']);
    await git(fixture.parentRoot, ['commit', '-m', 'reviewed knowledge pin']);
    const alreadyPinnedHead = await git(fixture.parentRoot, ['rev-parse', 'HEAD']);
    const machine = new GitMachineAdapter();
    const add = vi.spyOn(machine, 'addExact');
    const commitTree = vi.spyOn(machine, 'commitTree');
    const service = createParentKnowledgePinService(fixture.parentRoot, {
      gitMachine: machine,
    });

    const plan = await service.plan(fixture.input);
    expect(plan).toMatchObject({
      eligible: true,
      noOp: true,
      parentBaseRevision: alreadyPinnedHead,
      codeRevision: fixture.parentBaseRevision,
      oldKnowledgeGitlink: fixture.knowledgeRevision,
      newKnowledgeGitlink: fixture.knowledgeRevision,
    });
    const result = await service.commit(fixture.input, plan.planDigest);
    expect(result).toMatchObject({ state: 'no-op', applied: false, noOp: true, partial: false });
    expect(add).not.toHaveBeenCalled();
    expect(commitTree).not.toHaveBeenCalled();
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD']))
      .resolves.toBe(alreadyPinnedHead);
  });

  it('fails closed for missing remote reachability and unrelated parent dirt before add', async () => {
    const missing = await createFixture();
    await git(missing.remoteRoot, ['update-ref', '-d', 'refs/heads/main']);
    const missingMachine = new GitMachineAdapter();
    const missingAdd = vi.spyOn(missingMachine, 'addExact');
    const missingService = createParentKnowledgePinService(missing.parentRoot, {
      gitMachine: missingMachine,
    });
    const missingPlan = await missingService.plan(missing.input);
    expect(missingPlan).toMatchObject({ eligible: false, targetRemoteReachability: false });
    expect(missingPlan.blockReasons).toContain('KNOWLEDGE_REMOTE_MISSING');
    expect(await missingService.commit(missing.input, missingPlan.planDigest))
      .toMatchObject({ state: 'blocked', errorCode: 'PARENT_PIN_INELIGIBLE', partial: false });
    expect(missingAdd).not.toHaveBeenCalled();

    const dirty = await createFixture();
    await writeFile(join(dirty.parentRoot, 'private.tmp'), 'unrelated bytes\n', 'utf8');
    const dirtyMachine = new GitMachineAdapter();
    const dirtyAdd = vi.spyOn(dirtyMachine, 'addExact');
    const dirtyService = createParentKnowledgePinService(dirty.parentRoot, {
      gitMachine: dirtyMachine,
    });
    const dirtyPlan = await dirtyService.plan(dirty.input);
    expect(dirtyPlan).toMatchObject({ eligible: false });
    expect(dirtyPlan.blockReasons).toContain('PARENT_DIRTY');
    expect(await dirtyService.commit(dirty.input, dirtyPlan.planDigest))
      .toMatchObject({ state: 'blocked', partial: false });
    expect(dirtyAdd).not.toHaveBeenCalled();
    await expect(readFile(join(dirty.parentRoot, 'private.tmp'), 'utf8'))
      .resolves.toBe('unrelated bytes\n');
  });

  it('revalidates parent drift immediately before add and leaves all existing bytes untouched', async () => {
    const fixture = await createFixture();
    const readmeBefore = await readFile(join(fixture.parentRoot, 'README.md'));
    const machine = new GitMachineAdapter();
    const add = vi.spyOn(machine, 'addExact');
    const service = createParentKnowledgePinService(fixture.parentRoot, {
      gitMachine: machine,
      hooks: {
        beforeAdd: async () => {
          await writeFile(join(fixture.parentRoot, 'raced.tmp'), 'raced\n', 'utf8');
        },
      },
    });
    const plan = await service.plan(fixture.input);
    const result = await service.commit(fixture.input, plan.planDigest);
    expect(result).toMatchObject({
      state: 'blocked',
      errorCode: 'PARENT_PIN_PLAN_DRIFT',
      partial: false,
    });
    expect(add).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.parentRoot, 'README.md'))).resolves.toEqual(readmeBefore);
    await expect(readFile(join(fixture.parentRoot, 'raced.tmp'), 'utf8')).resolves.toBe('raced\n');
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD']))
      .resolves.toBe(fixture.parentBaseRevision);
  });

  it('returns ownership-safe partial evidence after staging without resetting unrelated state', async () => {
    const fixture = await createFixture();
    const readmeIndexBefore = await git(fixture.parentRoot, [
      'ls-files', '--stage', '--', 'README.md',
    ]);
    const machine = new GitMachineAdapter();
    const push = vi.spyOn(machine, 'pushExactNonForce');
    const service = createParentKnowledgePinService(fixture.parentRoot, {
      gitMachine: machine,
      hooks: { afterAdd: () => { throw new Error('injected stage fault'); } },
    });
    const plan = await service.plan(fixture.input);
    const result = await service.commit(fixture.input, plan.planDigest);
    expect(result).toMatchObject({
      state: 'blocked',
      errorCode: 'PARENT_PIN_PARTIAL',
      partial: true,
      resultingParentCommitSha: null,
      recoveryCommand: ['knowledge', 'status'],
    });
    expect(push).not.toHaveBeenCalled();
    await expect(git(fixture.parentRoot, ['diff', '--cached', '--name-only']))
      .resolves.toBe('knowledge');
    await expect(git(fixture.parentRoot, ['ls-files', '--stage', '--', 'README.md']))
      .resolves.toBe(readmeIndexBefore);
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD']))
      .resolves.toBe(fixture.parentBaseRevision);
  });

  it('reports ref-updated post-verification failure without parent push or cleanup', async () => {
    const fixture = await createFixture();
    const machine = new GitMachineAdapter();
    const push = vi.spyOn(machine, 'pushExactNonForce');
    const service = createParentKnowledgePinService(fixture.parentRoot, {
      gitMachine: machine,
      hooks: { beforePostVerify: () => { throw new Error('injected postverify fault'); } },
    });
    const plan = await service.plan(fixture.input);
    const result = await service.commit(fixture.input, plan.planDigest);
    expect(result).toMatchObject({
      state: 'blocked',
      errorCode: 'PARENT_PIN_POSTVERIFY_FAILED',
      partial: true,
    });
    expect(result.resultingParentCommitSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(push).not.toHaveBeenCalled();
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD']))
      .resolves.toBe(result.resultingParentCommitSha);
    await expect(git(fixture.parentRoot, ['status', '--porcelain'])).resolves.toBe('');
  });

  it('fails a busy second repository lease without staging or waiting', async () => {
    const fixture = await createFixture();
    const manager = new RepositoryWriterLeaseManager();
    const machine = new GitMachineAdapter();
    const add = vi.spyOn(machine, 'addExact');
    const service = createParentKnowledgePinService(fixture.parentRoot, {
      gitMachine: machine,
      lease: manager,
    });
    const plan = await service.plan(fixture.input);
    const result = await manager.withLease(fixture.knowledgeRoot, 'push', async () =>
      service.commit(fixture.input, plan.planDigest));
    expect(result).toMatchObject({
      state: 'blocked',
      errorCode: 'PARENT_PIN_REPOSITORY_BUSY',
      partial: false,
    });
    expect(add).not.toHaveBeenCalled();
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD']))
      .resolves.toBe(fixture.parentBaseRevision);
  });

  it.each([
    ['write-tree', { writeTree: () => Promise.reject(new Error('write-tree fault')) }],
    ['commit-tree', { commitTree: () => Promise.reject(new Error('commit-tree fault')) }],
    ['update-ref', { updateRefCompareAndSwap: () => Promise.reject(new Error('ref fault')) }],
  ] as const)('preserves a single staged gitlink after %s failure', async (_phase, override) => {
    const fixture = await createFixture();
    const readmeBytesBefore = await readFile(join(fixture.parentRoot, 'README.md'));
    const readmeIndexBefore = await git(fixture.parentRoot, [
      'ls-files', '--stage', '--', 'README.md',
    ]);
    const parentRemoteBefore = await git(fixture.parentRemoteRoot, [
      'rev-parse', 'refs/heads/main',
    ]);
    const machine = wrapGit(override);
    const push = vi.spyOn(machine, 'pushExactNonForce');
    const service = createParentKnowledgePinService(fixture.parentRoot, {
      gitMachine: machine,
    });
    const plan = await service.plan(fixture.input);
    const result = await service.commit(fixture.input, plan.planDigest);
    expect(result).toMatchObject({
      state: 'blocked',
      errorCode: 'PARENT_PIN_PARTIAL',
      partial: true,
      resultingParentCommitSha: null,
    });
    expect(push).not.toHaveBeenCalled();
    await expect(git(fixture.parentRoot, ['diff', '--cached', '--name-only']))
      .resolves.toBe('knowledge');
    await expect(git(fixture.parentRoot, ['rev-parse', 'HEAD']))
      .resolves.toBe(fixture.parentBaseRevision);
    await expect(readFile(join(fixture.parentRoot, 'README.md')))
      .resolves.toEqual(readmeBytesBefore);
    await expect(git(fixture.parentRoot, ['ls-files', '--stage', '--', 'README.md']))
      .resolves.toBe(readmeIndexBefore);
    await expect(git(fixture.parentRemoteRoot, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(parentRemoteBefore);
  });
});
