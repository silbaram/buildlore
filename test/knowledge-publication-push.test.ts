import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { GitMachineAdapter, type GitMachinePort } from '../src/knowledge/git-machine.js';
import { createKnowledgePublicationPushService } from '../src/knowledge/publication-push.js';
import { createKnowledgePublicationService } from '../src/knowledge/publication-service.js';
import { verifyCanonicalManifestRegistration } from '../src/knowledge/publication-validation.js';
import type {
  KnowledgePublishCommittedResult,
  KnowledgePublishPlanInput,
  PublicationBlobPolicyPort,
  PublicationDigest,
} from '../src/knowledge/publication-types.js';
import { KNOWLEDGE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from '../src/knowledge/types.js';
import { parseJsonStrict } from '../src/knowledge/strict-json.js';
import { parseKnowledgeManifest } from '../src/knowledge/validation.js';

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
          reject(new Error('Git fixture command failed.'));
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

interface PushFixture {
  readonly baseline: string;
  readonly committed: KnowledgePublishCommittedResult;
  readonly remote: string;
  readonly root: string;
}

function planInput(): KnowledgePublishPlanInput {
  return {
    codeRevision: 'b'.repeat(40),
    embeddingCompatibilityDigest: digest('e'),
    includePolicyTrack: false,
    modelCompatibilityDigest: digest('d'),
    profileDigest: digest('a'),
    projectId: 'alpha',
    promptDigest: digest('c'),
    registration: false,
    sourceRevision: 'a'.repeat(40),
  };
}

async function createPushFixture(content = '# changed alpha\n'): Promise<PushFixture> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-push-work-'));
  const remote = await mkdtemp(join(tmpdir(), 'buildlore-push-remote-'));
  roots.push(root, remote);
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
  const baseline = await git(root, ['rev-parse', 'HEAD']);
  await git(remote, ['init', '--bare', '--initial-branch=main']);
  await git(remote, ['config', 'user.name', 'BuildLore Remote Test']);
  await git(remote, ['config', 'user.email', 'remote@example.invalid']);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '--set-upstream', 'origin', 'main']);

  await writeFile(join(root, 'projects', 'alpha', 'sources', 'entry.md'), content, 'utf8');
  const service = createKnowledgePublicationService(root, { blobPolicy: allowPolicy });
  const plan = await service.plan(planInput());
  const result = await service.commit({ ...planInput(), expectedPlanDigest: plan.planDigest });
  if (result.state !== 'committed') throw new Error('Fixture publication commit failed.');
  return { baseline, committed: result, remote, root };
}

async function peerCommit(remote: string, parent: string, message: string): Promise<string> {
  const tree = await git(remote, ['rev-parse', `${parent}^{tree}`]);
  return git(remote, ['commit-tree', tree, '-p', parent, '-m', message]);
}

async function optionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function wrapGit(
  overrides: Partial<GitMachinePort>,
): GitMachinePort {
  const real = new GitMachineAdapter();
  return {
    addExact: overrides.addExact ?? real.addExact.bind(real),
    cachedDiff: overrides.cachedDiff ?? real.cachedDiff.bind(real),
    commitTree: overrides.commitTree ?? real.commitTree.bind(real),
    fetchObjectNoRefUpdate: overrides.fetchObjectNoRefUpdate ??
      real.fetchObjectNoRefUpdate.bind(real),
    isAncestor: overrides.isAncestor ?? real.isAncestor.bind(real),
    lsRemoteExact: overrides.lsRemoteExact ?? real.lsRemoteExact.bind(real),
    pushExactNonForce: overrides.pushExactNonForce ?? real.pushExactNonForce.bind(real),
    status: overrides.status ?? real.status.bind(real),
    updateRefCompareAndSwap: overrides.updateRefCompareAndSwap ??
      real.updateRefCompareAndSwap.bind(real),
    writeTree: overrides.writeTree ?? real.writeTree.bind(real),
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
});

describe('KnowledgePublicationPushService', () => {
  it('pushes only an exact fast-forward commit and treats remote equality as idempotent', async () => {
    const fixture = await createPushFixture();
    const beforeHead = await git(fixture.root, ['rev-parse', 'HEAD']);
    const beforeIndex = await git(fixture.root, ['ls-files', '--stage']);
    const beforeStatus = await git(fixture.root, ['status', '--porcelain=v2', '--untracked-files=all']);
    const beforeFetchHead = await optionalFile(join(fixture.root, '.git', 'FETCH_HEAD'));
    const service = createKnowledgePublicationService(fixture.root, { blobPolicy: allowPolicy });
    const input = { projectId: 'alpha', knowledgeRevision: fixture.committed.knowledgeRevision };

    const result = await service.push(input);
    await expect(git(fixture.remote, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(fixture.committed.knowledgeRevision);
    await expect(git(fixture.root, ['rev-parse', 'refs/remotes/origin/main']))
      .resolves.toBe(fixture.committed.knowledgeRevision);
    expect(result).toMatchObject({
      state: 'pushed',
      knowledgeRevision: fixture.committed.knowledgeRevision,
      remoteRevision: fixture.committed.knowledgeRevision,
      localCommitPreserved: true,
      partial: false,
    });
    await expect(git(fixture.root, ['rev-parse', 'HEAD'])).resolves.toBe(beforeHead);
    await expect(git(fixture.root, ['ls-files', '--stage'])).resolves.toBe(beforeIndex);
    await expect(git(fixture.root, ['status', '--porcelain=v2', '--untracked-files=all']))
      .resolves.toBe(beforeStatus);
    await expect(optionalFile(join(fixture.root, '.git', 'FETCH_HEAD')))
      .resolves.toEqual(beforeFetchHead);
    const equal = await service.push(input);
    expect(equal).toMatchObject({ state: 'pushed', warnings: ['REMOTE_ALREADY_EQUAL'] });
    expect(JSON.stringify(equal)).not.toContain(fixture.remote);
  });

  it('blocks a missing configured branch without creating it', async () => {
    const fixture = await createPushFixture();
    await git(fixture.remote, ['update-ref', '-d', 'refs/heads/main']);
    const service = createKnowledgePublicationService(fixture.root, { blobPolicy: allowPolicy });

    const result = await service.push({
      knowledgeRevision: fixture.committed.knowledgeRevision,
      projectId: 'alpha',
    });

    expect(result).toMatchObject({ state: 'blocked', errorCode: 'PUBLISH_REMOTE_MISSING' });
    await expect(git(fixture.remote, ['show-ref', '--verify', 'refs/heads/main'])).rejects.toThrow();
  });

  it('allows the configured tracking ref to advance from a stale OID to the target', async () => {
    const fixture = await createPushFixture();
    const stale = await git(fixture.root, [
      'commit-tree',
      await git(fixture.root, ['rev-parse', `${fixture.baseline}^{tree}`]),
      '-p',
      fixture.baseline,
      '-m',
      'stale local tracking ref',
    ]);
    await git(fixture.root, [
      'update-ref',
      'refs/remotes/origin/main',
      stale,
      fixture.baseline,
    ]);
    const result = await createKnowledgePublicationService(
      fixture.root,
      { blobPolicy: allowPolicy },
    ).push({ knowledgeRevision: fixture.committed.knowledgeRevision, projectId: 'alpha' });
    expect(result).toMatchObject({ state: 'pushed' });
    await expect(git(fixture.root, ['rev-parse', 'refs/remotes/origin/main']))
      .resolves.toBe(fixture.committed.knowledgeRevision);
  });

  it('re-proves a canonical single-project registration manifest delta before push', async () => {
    const fixture = await createPushFixture();
    await writeProject(fixture.root, 'gamma');
    const manifest = parseKnowledgeManifest(parseJsonStrict(
      await readFile(join(fixture.root, 'manifest.json'), 'utf8'),
    ));
    await writeFile(join(fixture.root, 'manifest.json'), serializeCanonicalJson({
      projects: [...manifest.projects, {
        displayName: 'Gamma',
        path: 'projects/gamma',
        projectId: 'gamma',
        sourceRepository: '../gamma',
      }],
      schemaVersion: manifest.schemaVersion,
    }), 'utf8');
    const registrationInput = { ...planInput(), projectId: 'gamma', registration: true };
    const service = createKnowledgePublicationService(fixture.root, { blobPolicy: allowPolicy });
    const plan = await service.plan(registrationInput);
    const commit = await service.commit({ ...registrationInput, expectedPlanDigest: plan.planDigest });
    expect(commit.state).toBe('committed');
    if (commit.state !== 'committed') throw new Error('Registration fixture commit failed.');

    const result = await service.push({
      knowledgeRevision: commit.knowledgeRevision,
      projectId: 'gamma',
    });
    expect(result).toMatchObject({ state: 'pushed', remoteRevision: commit.knowledgeRevision });
    await expect(git(fixture.remote, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(commit.knowledgeRevision);
  });

  it('rejects a forged registration delta that also changes another project entry', () => {
    const before = Buffer.from(serializeCanonicalJson({
      projects: [
        { displayName: 'Alpha', path: 'projects/alpha', projectId: 'alpha', sourceRepository: '../alpha' },
        { displayName: 'Beta', path: 'projects/beta', projectId: 'beta', sourceRepository: '../beta' },
      ],
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    }), 'utf8');
    const forged = Buffer.from(serializeCanonicalJson({
      projects: [
        { displayName: 'Alpha', path: 'projects/alpha', projectId: 'alpha', sourceRepository: '../alpha' },
        { displayName: 'Changed Beta', path: 'projects/beta', projectId: 'beta', sourceRepository: '../beta' },
        { displayName: 'Gamma', path: 'projects/gamma', projectId: 'gamma', sourceRepository: '../gamma' },
      ],
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    }), 'utf8');
    expect(verifyCanonicalManifestRegistration(before, forged, 'gamma')).toBeNull();
  });

  it('blocks remote-ahead and diverged histories before push', async () => {
    const ahead = await createPushFixture();
    await git(ahead.root, [
      'push',
      'origin',
      `${ahead.committed.knowledgeRevision}:refs/heads/main`,
    ]);
    const remoteChild = await peerCommit(
      ahead.remote,
      ahead.committed.knowledgeRevision,
      'remote ahead',
    );
    await git(ahead.remote, ['update-ref', 'refs/heads/main', remoteChild]);
    const aheadFetchHead = await optionalFile(join(ahead.root, '.git', 'FETCH_HEAD'));
    const aheadTracking = await git(ahead.root, ['rev-parse', 'refs/remotes/origin/main']);
    const aheadResult = await createKnowledgePublicationService(ahead.root, { blobPolicy: allowPolicy })
      .push({ knowledgeRevision: ahead.committed.knowledgeRevision, projectId: 'alpha' });
    expect(aheadResult).toMatchObject({ state: 'blocked', errorCode: 'PUBLISH_REMOTE_AHEAD' });
    await expect(git(ahead.remote, ['rev-parse', 'refs/heads/main'])).resolves.toBe(remoteChild);
    await expect(optionalFile(join(ahead.root, '.git', 'FETCH_HEAD'))).resolves.toEqual(aheadFetchHead);
    await expect(git(ahead.root, ['rev-parse', 'refs/remotes/origin/main']))
      .resolves.toBe(aheadTracking);

    const diverged = await createPushFixture();
    const remoteSibling = await peerCommit(diverged.remote, diverged.baseline, 'remote diverged');
    await git(diverged.remote, ['update-ref', 'refs/heads/main', remoteSibling]);
    const divergedFetchHead = await optionalFile(join(diverged.root, '.git', 'FETCH_HEAD'));
    const divergedTracking = await git(diverged.root, ['rev-parse', 'refs/remotes/origin/main']);
    const divergedResult = await createKnowledgePublicationService(
      diverged.root,
      { blobPolicy: allowPolicy },
    ).push({ knowledgeRevision: diverged.committed.knowledgeRevision, projectId: 'alpha' });
    expect(divergedResult).toMatchObject({
      state: 'blocked',
      errorCode: 'PUBLISH_REMOTE_DIVERGED',
    });
    await expect(git(diverged.remote, ['rev-parse', 'refs/heads/main'])).resolves.toBe(remoteSibling);
    await expect(optionalFile(join(diverged.root, '.git', 'FETCH_HEAD')))
      .resolves.toEqual(divergedFetchHead);
    await expect(git(diverged.root, ['rev-parse', 'refs/remotes/origin/main']))
      .resolves.toBe(divergedTracking);
  });

  it('detects a remote preflight race before invoking a branch-changing push', async () => {
    const fixture = await createPushFixture();
    let racedRevision = '';
    const service = createKnowledgePublicationService(fixture.root, {
      blobPolicy: allowPolicy,
      hooks: {
        beforePush: async () => {
          racedRevision = await peerCommit(fixture.remote, fixture.baseline, 'remote race');
          await git(fixture.remote, ['update-ref', 'refs/heads/main', racedRevision]);
        },
      },
    });

    const result = await service.push({
      knowledgeRevision: fixture.committed.knowledgeRevision,
      projectId: 'alpha',
    });

    expect(result).toMatchObject({ state: 'blocked', errorCode: 'PUBLISH_REMOTE_RACE' });
    await expect(git(fixture.remote, ['rev-parse', 'refs/heads/main'])).resolves.toBe(racedRevision);
  });

  it('returns a recoverable push-failed result after receive rejection', async () => {
    const fixture = await createPushFixture();
    const hook = join(fixture.remote, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(hook, 0o700);
    const beforeHead = await git(fixture.root, ['rev-parse', 'HEAD']);
    const beforeIndex = await git(fixture.root, ['ls-files', '--stage']);
    const beforeStatus = await git(fixture.root, ['status', '--porcelain=v2', '--untracked-files=all']);
    const beforeFetchHead = await optionalFile(join(fixture.root, '.git', 'FETCH_HEAD'));
    const beforeTracking = await git(fixture.root, ['rev-parse', 'refs/remotes/origin/main']);
    const service = createKnowledgePublicationService(fixture.root, { blobPolicy: allowPolicy });

    const result = await service.push({
      knowledgeRevision: fixture.committed.knowledgeRevision,
      projectId: 'alpha',
    });

    expect(result).toMatchObject({
      state: 'push-failed',
      errorCode: 'PUBLISH_PUSH_FAILED',
      localCommitPreserved: true,
      partial: true,
      remoteRevision: fixture.baseline,
    });
    await expect(git(fixture.remote, ['rev-parse', 'refs/heads/main'])).resolves.toBe(fixture.baseline);
    await expect(git(fixture.root, ['rev-parse', 'HEAD'])).resolves.toBe(beforeHead);
    await expect(git(fixture.root, ['ls-files', '--stage'])).resolves.toBe(beforeIndex);
    await expect(git(fixture.root, ['status', '--porcelain=v2', '--untracked-files=all']))
      .resolves.toBe(beforeStatus);
    await expect(optionalFile(join(fixture.root, '.git', 'FETCH_HEAD')))
      .resolves.toEqual(beforeFetchHead);
    await expect(git(fixture.root, ['rev-parse', 'refs/remotes/origin/main']))
      .resolves.toBe(beforeTracking);
  });

  it('re-runs production sanitizer policy on committed blobs before remote inspection', async () => {
    const fixture = await createPushFixture('api_key = sk-test-value-that-must-never-publish\n');
    const service = createKnowledgePublicationPushService(fixture.root);

    const result = await service.push({
      knowledgeRevision: fixture.committed.knowledgeRevision,
      projectId: 'alpha',
    });

    expect(result).toMatchObject({ state: 'blocked', errorCode: 'PUBLISH_COMMIT_INVALID' });
    await expect(git(fixture.remote, ['rev-parse', 'refs/heads/main'])).resolves.toBe(fixture.baseline);
    expect(JSON.stringify(result)).not.toContain('sk-test-value');
    await expect(optionalFile(join(fixture.root, '.git', 'FETCH_HEAD'))).resolves.toBeNull();
  });

  it('rejects extra or non-string public input fields before Git publication', async () => {
    const fixture = await createPushFixture();
    const service = createKnowledgePublicationService(fixture.root, { blobPolicy: allowPolicy });
    await expect(service.push({
      knowledgeRevision: fixture.committed.knowledgeRevision,
      projectId: 'alpha',
      // @ts-expect-error Runtime exact-key rejection is part of the public boundary.
      workspacePath: fixture.root,
    })).rejects.toMatchObject({ code: 'PUBLISH_COMMIT_INVALID' });
    await expect(service.push({
      knowledgeRevision: fixture.committed.knowledgeRevision,
      // @ts-expect-error Runtime type rejection is part of the public boundary.
      projectId: 42,
    })).rejects.toMatchObject({ code: 'PUBLISH_COMMIT_INVALID' });
    await expect(git(fixture.remote, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(fixture.baseline);
  });

  it('rejects non-HEAD, wrong-project, and merge commits before contacting an unreadable remote', async () => {
    const fixture = await createPushFixture();
    await git(fixture.root, ['config', 'remote.origin.url', join(fixture.root, 'unreadable-remote')]);
    await git(fixture.root, ['commit', '--allow-empty', '-m', 'foreign head']);
    const service = createKnowledgePublicationService(fixture.root, { blobPolicy: allowPolicy });
    const nonHead = await service.push({
      knowledgeRevision: fixture.committed.knowledgeRevision,
      projectId: 'alpha',
    });
    expect(nonHead).toMatchObject({ state: 'blocked', errorCode: 'PUBLISH_COMMIT_INVALID' });

    await git(fixture.root, [
      'update-ref',
      'refs/heads/main',
      fixture.committed.knowledgeRevision,
      await git(fixture.root, ['rev-parse', 'HEAD']),
    ]);
    const wrongProject = await service.push({
      knowledgeRevision: fixture.committed.knowledgeRevision,
      projectId: 'beta',
    });
    expect(wrongProject).toMatchObject({ state: 'blocked', errorCode: 'PUBLISH_COMMIT_INVALID' });

    const tree = await git(fixture.root, ['rev-parse', `${fixture.committed.knowledgeRevision}^{tree}`]);
    const merge = await git(fixture.root, [
      'commit-tree',
      tree,
      '-p',
      fixture.committed.knowledgeRevision,
      '-p',
      fixture.baseline,
      '-m',
      'forged merge',
    ]);
    await git(fixture.root, [
      'update-ref',
      'refs/heads/main',
      merge,
      fixture.committed.knowledgeRevision,
    ]);
    const mergeResult = await service.push({ knowledgeRevision: merge, projectId: 'alpha' });
    expect(mergeResult).toMatchObject({ state: 'blocked', errorCode: 'PUBLISH_COMMIT_INVALID' });
  });

  it('normalizes unreadable and missing configured upstream state without leaking locators', async () => {
    const unreadable = await createPushFixture();
    const sentinel = join(unreadable.root, 'private-remote-sentinel');
    await git(unreadable.root, ['config', 'remote.origin.url', sentinel]);
    const unreadableResult = await createKnowledgePublicationService(
      unreadable.root,
      { blobPolicy: allowPolicy },
    ).push({ knowledgeRevision: unreadable.committed.knowledgeRevision, projectId: 'alpha' });
    expect(unreadableResult).toMatchObject({
      state: 'blocked',
      errorCode: 'PUBLISH_REMOTE_UNREADABLE',
    });
    expect(JSON.stringify(unreadableResult)).not.toContain(sentinel);

    const unconfigured = await createPushFixture();
    await git(unconfigured.root, ['config', '--unset', 'branch.main.remote']);
    const unconfiguredResult = await createKnowledgePublicationService(
      unconfigured.root,
      { blobPolicy: allowPolicy },
    ).push({ knowledgeRevision: unconfigured.committed.knowledgeRevision, projectId: 'alpha' });
    expect(unconfiguredResult).toMatchObject({
      state: 'blocked',
      errorCode: 'PUBLISH_REMOTE_UNREADABLE',
    });
  });

  it('blocks reference drift injected after object-only fetch', async () => {
    const fixture = await createPushFixture();
    const remoteSibling = await peerCommit(fixture.remote, fixture.baseline, 'remote drift object');
    await git(fixture.remote, ['update-ref', 'refs/heads/main', remoteSibling]);
    const real = new GitMachineAdapter();
    const gitMachine = wrapGit({
      fetchObjectNoRefUpdate: async (root, remote, oid) => {
        await real.fetchObjectNoRefUpdate(root, remote, oid);
        await writeFile(join(root, '.git', 'FETCH_HEAD'), 'unexpected-reference-drift\n', 'utf8');
      },
    });
    const result = await createKnowledgePublicationService(fixture.root, {
      blobPolicy: allowPolicy,
      gitMachine,
    }).push({ knowledgeRevision: fixture.committed.knowledgeRevision, projectId: 'alpha' });
    expect(result).toMatchObject({ state: 'blocked', errorCode: 'PUBLISH_REFERENCE_DRIFT' });
    await expect(git(fixture.remote, ['rev-parse', 'refs/heads/main'])).resolves.toBe(remoteSibling);
  });

  it('normalizes a non-Git push failure only after proving local preservation', async () => {
    const fixture = await createPushFixture();
    const gitMachine = wrapGit({
      pushExactNonForce: async () => {
        await writeFile(
          join(fixture.root, 'projects', 'alpha', 'sources', 'entry.md'),
          '# drift after failed push\n',
          'utf8',
        );
        throw new Error('unsafe nested failure must not escape');
      },
    });
    const result = await createKnowledgePublicationService(fixture.root, {
      blobPolicy: allowPolicy,
      gitMachine,
    }).push({ knowledgeRevision: fixture.committed.knowledgeRevision, projectId: 'alpha' });
    expect(result).toMatchObject({
      state: 'blocked',
      errorCode: 'PUBLISH_REPOSITORY_DRIFT',
      localCommitPreserved: false,
      partial: true,
    });
    expect(JSON.stringify(result)).not.toContain('unsafe nested failure');
    await expect(git(fixture.remote, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(fixture.baseline);
  });

  it('normalizes a transport-style failure after preflight as push-failed', async () => {
    const fixture = await createPushFixture();
    const gitMachine = wrapGit({
      pushExactNonForce: () => Promise.reject(new Error('transport sentinel must stay private')),
    });
    const result = await createKnowledgePublicationService(fixture.root, {
      blobPolicy: allowPolicy,
      gitMachine,
    }).push({ knowledgeRevision: fixture.committed.knowledgeRevision, projectId: 'alpha' });
    expect(result).toMatchObject({
      state: 'push-failed',
      errorCode: 'PUBLISH_PUSH_FAILED',
      localCommitPreserved: true,
      partial: true,
      remoteRevision: fixture.baseline,
    });
    expect(JSON.stringify(result)).not.toContain('transport sentinel');
    await expect(git(fixture.remote, ['rev-parse', 'refs/heads/main']))
      .resolves.toBe(fixture.baseline);
  });
});
