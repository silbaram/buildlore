import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { GitMachineAdapter } from '../src/knowledge/git-machine.js';
import { createKnowledgePublicationService } from '../src/knowledge/publication-service.js';
import type {
  KnowledgePublishPlanInput,
  PublicationBlobPolicyPort,
  PublicationDigest,
  PublicationFaultHooks,
} from '../src/knowledge/publication-types.js';
import { KNOWLEDGE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from '../src/knowledge/types.js';
import { parseJsonStrict } from '../src/knowledge/strict-json.js';
import { parseKnowledgeManifest } from '../src/knowledge/validation.js';

const roots: string[] = [];
const digest = (character: string): PublicationDigest => `sha256:${character.repeat(64)}`;
const allowPolicy: PublicationBlobPolicyPort = {
  validate: vi.fn(() => Promise.resolve(true)),
};

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === undefined) throw new Error('Deferred promise is unavailable.');
      resolvePromise();
    },
  };
}

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
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error('Git fixture command failed.', { cause: new Error(stderr) }));
          return;
        }
        resolve(stdout.trim());
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

async function writeProject(root: string, projectId: string): Promise<void> {
  const workspace = join(root, 'projects', projectId);
  await Promise.all([
    mkdir(join(workspace, 'sources'), { recursive: true }),
    mkdir(join(workspace, 'wiki'), { recursive: true }),
    mkdir(join(workspace, '.llmwiki'), { recursive: true }),
  ]);
  await writeFile(join(workspace, 'project.json'), serializeCanonicalJson({
    profileVersion: 'llmwiki.default.v1',
    projectId,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sourceRepository: `../${projectId}`,
  }), 'utf8');
  await writeFile(join(workspace, 'log.md'), `# ${projectId}\n`, 'utf8');
  await writeFile(join(workspace, 'sources', 'entry.md'), `# ${projectId} source\n`, 'utf8');
}

async function createKnowledgeRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-publication-'));
  roots.push(root);
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'BuildLore Test']);
  await git(root, ['config', 'user.email', 'buildlore@example.invalid']);
  await Promise.all([writeProject(root, 'alpha'), writeProject(root, 'beta')]);
  await writeFile(join(root, 'manifest.json'), serializeCanonicalJson({
    projects: [
      { displayName: 'Alpha', path: 'projects/alpha', projectId: 'alpha', sourceRepository: '../alpha' },
      { displayName: 'Beta', path: 'projects/beta', projectId: 'beta', sourceRepository: '../beta' },
    ],
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
  }), 'utf8');
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', 'baseline']);
  return root;
}

function planInput(projectId = 'alpha'): KnowledgePublishPlanInput {
  return {
    codeRevision: 'b'.repeat(40),
    embeddingCompatibilityDigest: digest('e'),
    includePolicyTrack: false,
    modelCompatibilityDigest: digest('d'),
    profileDigest: digest('a'),
    projectId,
    promptDigest: digest('c'),
    registration: false,
    sourceRevision: 'a'.repeat(40),
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('KnowledgePublicationService plan', () => {
  it('rejects raw workspace, pathspec, wildcard-style, and unknown runtime inputs', async () => {
    const root = await createKnowledgeRepository();
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });
    const unsafeInputs = [
      { ...planInput(), workspacePath: root },
      { ...planInput(), pathspec: ['projects/alpha/**'] },
      { ...planInput(), all: true },
      { ...planInput(), projectId: '*' },
    ];
    for (const input of unsafeInputs) {
      await expect(service.plan(input)).rejects.toBeInstanceOf(Error);
    }
  });

  it('is deterministic and mutation-free while separating stable foreign changes', async () => {
    const root = await createKnowledgeRepository();
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# changed alpha\n', 'utf8');
    await writeFile(join(root, 'projects', 'beta', 'sources', 'entry.md'), '# changed beta\n', 'utf8');
    await writeFile(join(root, 'projects', 'beta', 'wiki', 'new.md'), '# beta untracked\n', 'utf8');
    const beforeHead = await git(root, ['rev-parse', 'HEAD']);
    const beforeIndex = await git(root, ['ls-files', '--stage']);
    const beforeStatus = await git(root, ['status', '--porcelain=v2', '--untracked-files=all']);
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });

    const first = await service.plan(planInput());
    const second = await service.plan(planInput());

    expect(second).toEqual(first);
    expect(first.eligible).toBe(true);
    expect(first.selectedPaths.map(({ relativePath }) => relativePath)).toEqual([
      'projects/alpha/sources/entry.md',
    ]);
    expect(first.foreignChanges).toMatchObject({
      staged: { count: 0 },
      unstaged: { count: 1 },
      untracked: { count: 1 },
    });
    expect(first.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await expect(git(root, ['rev-parse', 'HEAD'])).resolves.toBe(beforeHead);
    await expect(git(root, ['ls-files', '--stage'])).resolves.toBe(beforeIndex);
    await expect(git(root, ['status', '--porcelain=v2', '--untracked-files=all'])).resolves.toBe(beforeStatus);
  });

  it('blocks a foreign staged entry before publisher mutation', async () => {
    const root = await createKnowledgeRepository();
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# changed alpha\n', 'utf8');
    await writeFile(join(root, 'projects', 'beta', 'sources', 'entry.md'), '# staged beta\n', 'utf8');
    await git(root, ['add', '--', 'projects/beta/sources/entry.md']);
    const beforeHead = await git(root, ['rev-parse', 'HEAD']);
    const beforeIndex = await git(root, ['ls-files', '--stage']);
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });
    const plan = await service.plan(planInput());

    expect(plan.eligible).toBe(false);
    expect(plan.blockReasons).toEqual(expect.arrayContaining(['DIRTY_INDEX', 'FOREIGN_STAGED_CHANGE']));
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });
    expect(result).toMatchObject({
      errorCode: 'PUBLISH_DIRTY_INDEX',
      state: 'blocked',
      partial: false,
    });
    await expect(git(root, ['rev-parse', 'HEAD'])).resolves.toBe(beforeHead);
    await expect(git(root, ['ls-files', '--stage'])).resolves.toBe(beforeIndex);
  });

  it('accepts only one canonical same-project registration manifest delta', async () => {
    const root = await createKnowledgeRepository();
    await writeProject(root, 'gamma');
    const decoded = parseKnowledgeManifest(
      parseJsonStrict(await readFile(join(root, 'manifest.json'), 'utf8')),
    );
    const currentProjects = decoded.projects;
    const currentSchemaVersion = decoded.schemaVersion;
    await writeFile(join(root, 'manifest.json'), serializeCanonicalJson({
      projects: [...currentProjects, {
        displayName: 'Gamma',
        path: 'projects/gamma',
        projectId: 'gamma',
        sourceRepository: '../gamma',
      }],
      schemaVersion: currentSchemaVersion,
    }), 'utf8');
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });

    const ordinary = await service.plan({ ...planInput('gamma'), registration: false });
    expect(ordinary.eligible).toBe(false);
    expect(ordinary.blockReasons).toContain('ROOT_CHANGE_NOT_ALLOWED');
    const registration = await service.plan({ ...planInput('gamma'), registration: true });
    expect(registration.eligible).toBe(true);
    expect(registration.registrationManifest).toMatchObject({
      registeredProjectId: 'gamma',
      relativePath: 'manifest.json',
    });
    expect(registration.selectedPaths.map(({ relativePath }) => relativePath)).toContain('manifest.json');

    await writeFile(join(root, 'manifest.json'), serializeCanonicalJson({
      projects: [
        { ...currentProjects[0] },
        { ...currentProjects[1], displayName: 'Mutated Beta' },
        {
          displayName: 'Gamma',
          path: 'projects/gamma',
          projectId: 'gamma',
          sourceRepository: '../gamma',
        },
      ],
      schemaVersion: currentSchemaVersion,
    }), 'utf8');
    const mutated = await service.plan({ ...planInput('gamma'), registration: true });
    expect(mutated.eligible).toBe(false);
    expect(mutated.blockReasons).toContain('MANIFEST_REGISTRATION_INVALID');
  });

  it('rejects symlink leaves without leaking their target', async () => {
    const root = await createKnowledgeRepository();
    const sentinel = join(root, 'outside-sentinel.md');
    await writeFile(sentinel, 'outside\n', 'utf8');
    await symlink(sentinel, join(root, 'projects', 'alpha', 'wiki', 'unsafe.md'));
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });
    const plan = await service.plan(planInput());
    expect(plan.eligible).toBe(false);
    expect(plan.blockReasons).toContain('PATH_UNSAFE');
    expect(JSON.stringify(plan)).not.toContain(sentinel);
  });

  it('returns an explicit ineligible no-op plan for an empty selection', async () => {
    const root = await createKnowledgeRepository();
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });
    const plan = await service.plan(planInput());
    expect(plan).toMatchObject({
      blockReasons: ['EMPTY_SELECTION'],
      eligible: false,
      selectedPaths: [],
    });
    const before = await git(root, ['rev-parse', 'HEAD']);
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });
    expect(result).toMatchObject({ state: 'blocked', partial: false });
    await expect(git(root, ['rev-parse', 'HEAD'])).resolves.toBe(before);
  });
});

describe('KnowledgePublicationService commit transaction', () => {
  it('[V11-V-08][V11-P-08] returns a bounded busy loser while one publisher owns the common-dir lease', async () => {
    const root = await createKnowledgeRepository();
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# concurrent alpha\n', 'utf8');
    const entered = deferred();
    const release = deferred();
    const winningMachine = new GitMachineAdapter();
    const losingMachine = new GitMachineAdapter();
    const losingAdd = vi.spyOn(losingMachine, 'addExact');
    const winner = createKnowledgePublicationService(root, {
      blobPolicy: allowPolicy,
      gitMachine: winningMachine,
      hooks: {
        beforeAdd: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    const loser = createKnowledgePublicationService(root, {
      blobPolicy: allowPolicy,
      gitMachine: losingMachine,
    });
    const plan = await winner.plan(planInput());
    const winningCommit = winner.commit({
      ...planInput(),
      expectedPlanDigest: plan.planDigest,
    });
    await entered.promise;
    const losingResult = await loser.commit({
      ...planInput(),
      expectedPlanDigest: plan.planDigest,
    });
    expect(losingResult).toMatchObject({
      errorCode: 'PUBLISH_REPOSITORY_BUSY',
      partial: false,
      state: 'blocked',
    });
    expect(losingAdd).not.toHaveBeenCalled();
    release.resolve();
    await expect(winningCommit).resolves.toMatchObject({ state: 'committed' });
    await expect(git(root, ['rev-list', '--count', 'HEAD'])).resolves.toBe('2');
    await expect(git(root, ['diff', '--cached', '--name-only'])).resolves.toBe('');
  });

  it('blocks a selected-area nested repository/gitlink before add or ref update', async () => {
    const root = await createKnowledgeRepository();
    const nested = join(root, 'projects', 'alpha', 'wiki', 'nested');
    await mkdir(nested);
    await git(nested, ['init', '--initial-branch=main']);
    await git(nested, ['config', 'user.name', 'BuildLore Test']);
    await git(nested, ['config', 'user.email', 'buildlore@example.invalid']);
    await writeFile(join(nested, 'page.md'), '# nested\n', 'utf8');
    await git(nested, ['add', 'page.md']);
    await git(nested, ['commit', '-m', 'nested']);
    await git(root, ['add', '--', 'projects/alpha/wiki/nested']);
    const machine = new GitMachineAdapter();
    const add = vi.spyOn(machine, 'addExact');
    const updateRef = vi.spyOn(machine, 'updateRefCompareAndSwap');
    const service = createKnowledgePublicationService(root, {
      blobPolicy: allowPolicy,
      gitMachine: machine,
    });
    const plan = await service.plan(planInput());
    expect(plan.blockReasons).toEqual(expect.arrayContaining(['DIRTY_INDEX', 'PATH_UNSAFE']));
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });
    expect(result).toMatchObject({ state: 'blocked', partial: false });
    expect(add).not.toHaveBeenCalled();
    expect(updateRef).not.toHaveBeenCalled();
  });

  it.each([
    ['HEAD', async (root: string) => { await git(root, ['commit', '--allow-empty', '-m', 'race']); }],
    ['content', async (root: string) => {
      await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# drifted bytes\n', 'utf8');
    }],
    ['inode', async (root: string) => {
      const path = join(root, 'projects', 'alpha', 'sources', 'entry.md');
      const moved = join(root, 'projects', 'alpha', 'sources', 'prior.md');
      const bytes = await readFile(path);
      await rename(path, moved);
      await writeFile(path, bytes);
    }],
    ['parent symlink', async (root: string) => {
      const workspace = join(root, 'projects', 'alpha');
      await rename(join(workspace, 'sources'), join(workspace, 'sources-real'));
      await symlink('sources-real', join(workspace, 'sources'));
    }],
    ['mode', async (root: string) => {
      await chmod(join(root, 'projects', 'alpha', 'sources', 'entry.md'), 0o755);
    }],
  ] as const)('revalidates %s drift after beforeAdd and performs zero add calls', async (_name, mutate) => {
    const root = await createKnowledgeRepository();
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# planned bytes\n', 'utf8');
    const machine = new GitMachineAdapter();
    const add = vi.spyOn(machine, 'addExact');
    const service = createKnowledgePublicationService(root, {
      blobPolicy: allowPolicy,
      gitMachine: machine,
      hooks: { beforeAdd: async () => { await mutate(root); } },
    });
    const plan = await service.plan(planInput());
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });
    expect(result).toMatchObject({ state: 'blocked', partial: false });
    expect(add).not.toHaveBeenCalled();
  });

  it('creates one local plumbing commit without push or parent pin side effects', async () => {
    const root = await createKnowledgeRepository();
    const changed = '# committed alpha\n';
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), changed, 'utf8');
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });
    const plan = await service.plan(planInput());
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });

    expect(result).toMatchObject({
      state: 'committed',
      partial: false,
      pinRequired: true,
      stagedPaths: ['projects/alpha/sources/entry.md'],
    });
    expect(await git(root, ['status', '--porcelain'])).toBe('');
    expect(await git(root, ['rev-list', '--count', 'HEAD'])).toBe('2');
    const message = await git(root, ['log', '-1', '--format=%B']);
    expect(message).toContain('buildlore.knowledge-commit-lineage.v1');
    expect(message).not.toContain(changed.trim());
    expect(message).not.toContain(root);
    expect(await git(root, ['remote'])).toBe('');
  });

  it('preserves foreign unstaged and untracked bytes, index entries, and status across commit', async () => {
    const root = await createKnowledgeRepository();
    const betaTracked = join(root, 'projects', 'beta', 'sources', 'entry.md');
    const betaUntracked = join(root, 'projects', 'beta', 'wiki', 'pending.md');
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# alpha publish\n', 'utf8');
    await writeFile(betaTracked, '# beta private working copy\n', 'utf8');
    await writeFile(betaUntracked, '# beta pending\n', 'utf8');
    const beforeBytes = await Promise.all([readFile(betaTracked), readFile(betaUntracked)]);
    const beforeIndex = await git(root, ['ls-files', '--stage', '--', 'projects/beta']);
    const beforeStatus = await git(root, ['status', '--porcelain=v2', '--untracked-files=all', '--', 'projects/beta']);
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });
    const plan = await service.plan(planInput());
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });

    expect(result.state).toBe('committed');
    const afterBytes = await Promise.all([readFile(betaTracked), readFile(betaUntracked)]);
    expect(afterBytes).toEqual(beforeBytes);
    await expect(git(root, ['ls-files', '--stage', '--', 'projects/beta'])).resolves.toBe(beforeIndex);
    await expect(git(root, ['status', '--porcelain=v2', '--untracked-files=all', '--', 'projects/beta']))
      .resolves.toBe(beforeStatus);
  });

  it('detects filter byte drift after exact staging and preserves an explicit partial recovery state', async () => {
    const root = await createKnowledgeRepository();
    await writeFile(join(root, '.gitattributes'), 'projects/alpha/sources/*.md text eol=lf\n', 'utf8');
    await git(root, ['add', '.gitattributes']);
    await git(root, ['commit', '-m', 'attributes']);
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# alpha\r\nchanged\r\n', 'utf8');
    const beforeHead = await git(root, ['rev-parse', 'HEAD']);
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });
    const plan = await service.plan(planInput());
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });

    expect(result).toMatchObject({
      errorCode: 'PUBLISH_PATH_DRIFT',
      partial: true,
      state: 'blocked',
    });
    await expect(git(root, ['rev-parse', 'HEAD'])).resolves.toBe(beforeHead);
    expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('projects/alpha/sources/entry.md');
  });

  it.each(['100755', '120000', '160000'] as const)(
    'rejects an injected cached mode %s before tree or commit creation',
    async (unsafeMode) => {
      const root = await createKnowledgeRepository();
      await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# unsafe mode\n', 'utf8');
      const machine = new GitMachineAdapter();
      const readCached = machine.cachedDiff.bind(machine);
      let calls = 0;
      vi.spyOn(machine, 'cachedDiff').mockImplementation(async (repositoryRoot) => {
        const entries = await readCached(repositoryRoot);
        calls += 1;
        if (calls < 2) return entries;
        return entries.map((entry) => ({ ...entry, newMode: unsafeMode }));
      });
      const writeTree = vi.spyOn(machine, 'writeTree');
      const commitTree = vi.spyOn(machine, 'commitTree');
      const service = createKnowledgePublicationService(root, {
        blobPolicy: allowPolicy,
        gitMachine: machine,
      });
      const plan = await service.plan(planInput());
      const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });
      expect(result).toMatchObject({
        errorCode: 'PUBLISH_PATH_DRIFT',
        partial: true,
        state: 'blocked',
      });
      expect(writeTree).not.toHaveBeenCalled();
      expect(commitTree).not.toHaveBeenCalled();
    },
  );

  it('rejects an unexpected staged path injected after add without writing a commit', async () => {
    const root = await createKnowledgeRepository();
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# alpha changed\n', 'utf8');
    await writeFile(join(root, 'projects', 'beta', 'sources', 'entry.md'), '# beta changed\n', 'utf8');
    const beforeHead = await git(root, ['rev-parse', 'HEAD']);
    const service = createKnowledgePublicationService(root, {
      blobPolicy: allowPolicy,
      hooks: { afterAdd: async () => { await git(root, ['add', '--', 'projects/beta/sources/entry.md']); } },
    });
    const plan = await service.plan(planInput());
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });

    expect(result).toMatchObject({ state: 'blocked', errorCode: 'PUBLISH_PATH_DRIFT', partial: true });
    await expect(git(root, ['rev-parse', 'HEAD'])).resolves.toBe(beforeHead);
    expect((await git(root, ['diff', '--cached', '--name-only'])).split('\n').sort()).toEqual([
      'projects/alpha/sources/entry.md',
      'projects/beta/sources/entry.md',
    ]);
  });

  it('reports a dangling commit as partial when ref update is faulted and never resets user data', async () => {
    const root = await createKnowledgeRepository();
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# alpha changed\n', 'utf8');
    const beforeHead = await git(root, ['rev-parse', 'HEAD']);
    const service = createKnowledgePublicationService(root, {
      blobPolicy: allowPolicy,
      hooks: { beforeUpdateRef: () => { throw new Error('injected'); } },
    });
    const plan = await service.plan(planInput());
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });

    expect(result).toMatchObject({
      errorCode: 'PUBLISH_PARTIAL',
      localCommitPreserved: true,
      partial: true,
      state: 'blocked',
    });
    if (result.state !== 'blocked' || result.knowledgeRevision === null) throw new Error('missing recovery oid');
    await expect(git(root, ['cat-file', '-t', result.knowledgeRevision])).resolves.toBe('commit');
    await expect(git(root, ['rev-parse', 'HEAD'])).resolves.toBe(beforeHead);
    expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('projects/alpha/sources/entry.md');
    expect(result.recoveryCommand).toEqual(['knowledge', 'status']);
  });

  it('uses the production sanitizer to block a synthetic staged credential without reflecting it', async () => {
    const root = await createKnowledgeRepository();
    const syntheticCredential = `Bearer ${'synth-token-'.repeat(6)}`;
    await writeFile(
      join(root, 'projects', 'alpha', 'sources', 'entry.md'),
      `# sanitized boundary\nAuthorization: ${syntheticCredential}\n`,
      'utf8',
    );
    const service = createKnowledgePublicationService(root);
    const plan = await service.plan(planInput());
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });
    expect(result).toMatchObject({
      errorCode: 'PUBLISH_POLICY_BLOCKED',
      partial: true,
      state: 'blocked',
    });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(syntheticCredential);
    expect(rendered).not.toContain(root);
  });

  it.each([
    ['beforeAdd', { beforeAdd: () => { throw new Error('fault'); } }, false, false],
    ['afterAdd', { afterAdd: () => { throw new Error('fault'); } }, true, false],
    ['afterCachedValidation', { afterCachedValidation: () => { throw new Error('fault'); } }, true, false],
    ['afterSecretScan', { afterSecretScan: () => { throw new Error('fault'); } }, true, false],
    ['afterWriteTree', { afterWriteTree: () => { throw new Error('fault'); } }, true, false],
    ['afterCommitTree', { afterCommitTree: () => { throw new Error('fault'); } }, true, false],
    ['beforeUpdateRef', { beforeUpdateRef: () => { throw new Error('fault'); } }, true, false],
    ['beforePostVerify', { beforePostVerify: () => { throw new Error('fault'); } }, true, true],
  ] as ReadonlyArray<readonly [string, PublicationFaultHooks, boolean, boolean]>)(
    'records bounded recovery semantics for a %s phase fault',
    async (_phase, hooks, partial, refAdvanced) => {
    const root = await createKnowledgeRepository();
    await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), '# fault matrix\n', 'utf8');
    const before = await git(root, ['rev-parse', 'HEAD']);
    const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy, hooks });
    const plan = await service.plan(planInput());
    const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });
    expect(result).toMatchObject({ state: 'blocked', partial });
    const after = await git(root, ['rev-parse', 'HEAD']);
    expect(after === before).toBe(!refAdvanced);
    expect(await git(root, ['diff', '--cached', '--name-only'])).toBe(
      partial && !refAdvanced ? 'projects/alpha/sources/entry.md' : '',
    );
    expect(result.recoveryCommand).toEqual(partial ? ['knowledge', 'status'] : [
      'publish', 'plan', '--project', 'alpha',
    ]);
    },
  );
});

describe('GitMachineAdapter exact path boundary', () => {
  it('rejects NUL-framed paths before any index mutation', async () => {
    const root = await createKnowledgeRepository();
    const adapter = new GitMachineAdapter();
    await expect(adapter.addExact(root, ['projects/alpha/sources/entry.md\0manifest.json']))
      .rejects.toMatchObject({ code: 'GIT_OPERATION_FAILED' });
    await expect(adapter.cachedDiff(root)).resolves.toEqual([]);
  });
});
