import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { listCompletionHandoffs, preserveCompletionHandoff, readCompletionHandoff, verifyCompletionHandoff, type CompletionHandoffInput } from '../src/knowledge/completion-handoff.js';
import { addProject } from '../src/knowledge/workspace.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function digest(body: string): `sha256:${string}` { return `sha256:${createHash('sha256').update(body).digest('hex')}`; }
function input(workId = 'iteration-1'): CompletionHandoffInput {
  const baseline = '{"goal":"Preserve project knowledge"}';
  const body = 'All selected checks passed on the stated revision.\n';
  return {
    schemaVersion: 'buildlore.completion-input.v1', projectId: 'demo', workId, workKind: 'iteration', completedAt: '2026-09-25T00:00:00.000Z',
    repository: { id: 'demo', codeRevision: null, contentDigest: null }, predecessor: null, affectedAreas: ['knowledge'], supersedes: [],
    baseline: { format: 'p2a.current_development_contract.v1', body: baseline, sourceDigest: digest(baseline) },
    knowledge: { summary: 'Completion preserved independently of Wiki acceptance.', decisions: ['Keep original verification evidence.'], lessons: [], remaining: ['Archive resolver remains unimplemented.'] },
    sources: [{ ref: '.plan2agent/artifacts/iteration-1/verification.md', role: 'verification', mediaType: 'text/markdown', body, sourceDigest: digest(body) }],
  };
}
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-completion-test-'));
  roots.push(root);
  await exec('git', ['init', '--initial-branch=main'], { cwd: root });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '--allow-empty', '-m', 'Fixture'], { cwd: root });
  await addProject(root, { projectId: 'demo', displayName: 'Demo', sourceRepository: 'https://example.invalid/demo.git' });
  return root;
}
async function git(root: string, args: string[]): Promise<string> { return (await exec('git', args, { cwd: root })).stdout; }

describe('independent completion handoff preservation', () => {
  it('preserves pending knowledge idempotently, independent of original files and approved Wiki', async () => {
    const root = await fixture();
    const original = join(root, 'original.md');
    await writeFile(original, input().sources[0]?.body ?? '');
    const first = await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input() });
    expect(first).toMatchObject({ storage: 'stored', commit: null, wikiStatus: 'pending', cleanupEligible: false });
    expect(await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input() })).toEqual(first);
    await unlink(original);
    const bundle = await readCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', id: first.handoffId });
    expect(bundle.baseline.body).toBe(input().baseline.body);
    expect(bundle.sources[0]?.body).toBe(input().sources[0]?.body);
    expect(await listCompletionHandoffs({ knowledgeRoot: root, projectId: 'demo' })).toEqual([first]);
    expect(await readdir(join(root, 'projects/demo/handoffs/objects'))).toHaveLength(1);
    expect(await readdir(join(root, 'projects/demo/wiki'))).toEqual([]);
    const fresh = join(root, 'fresh');
    await mkdir(fresh);
    await cp(join(root, 'projects'), join(fresh, 'projects'), { recursive: true });
    expect(await readCompletionHandoff({ knowledgeRoot: fresh, projectId: 'demo', id: first.handoffId })).toEqual(bundle);
    // An ancestor Git repository cannot be mistaken for the fresh copy's durable store.
    expect(await verifyCompletionHandoff({ knowledgeRoot: fresh, projectId: 'demo', id: first.handoffId })).toMatchObject({ storage: 'stored' });
  });

  it('rejects credentials in every user-bearing field before any handoff persistence', async () => {
    const root = await fixture();
    const secret = ['ghp_', 'SyntheticCredentialValueForSecurityCase12345'].join('');
    const bad = { ...input(), knowledge: { ...input().knowledge, summary: `token=${secret}` } };
    await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: bad })).rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_SANITIZATION_FAILED' });
    await expect(lstat(join(root, 'projects/demo/handoffs'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: { ...input(), repository: { ...input().repository, id: `token=${secret}` } } })).rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_SANITIZATION_FAILED' });
  });

  it('stores sanitized body hashes separately from verified original hashes', async () => {
    const root = await fixture();
    const body = 'Evidence was generated under /home/alice/private/project.\n';
    const value = { ...input(), sources: [{ ...input().sources[0], body, sourceDigest: digest(body) }] };
    const saved = await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: value });
    const bundle = await readCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', id: saved.handoffId });
    expect(bundle.sources[0]?.body).not.toContain('/home/alice');
    expect(bundle.sources[0]?.sourceDigest).toBe(digest(body));
    expect(bundle.sources[0]?.bodyDigest).toBe(digest(bundle.sources[0]?.body ?? ''));
  });

  it('rejects bad digests, project mismatch, malformed JSON, oversize and unsafe references', async () => {
    const root = await fixture();
    const candidates = [
      { ...input(), projectId: 'other' },
      { ...input(), baseline: { ...input().baseline, sourceDigest: digest('wrong') } },
      { ...input(), baseline: { ...input().baseline, body: 'no-json', sourceDigest: digest('no-json') } },
      { ...input(), sources: [{ ...input().sources[0], ref: '../escape' }] },
      { ...input(), knowledge: { ...input().knowledge, summary: 'a'.repeat(1024 * 1024) } },
    ];
    for (const value of candidates) await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: value })).rejects.toThrow();
    await expect(lstat(join(root, 'projects/demo/handoffs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed stored bytes, wrong project and symlink files/directories', async () => {
    const root = await fixture();
    const saved = await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input() });
    const options = { knowledgeRoot: root, projectId: 'demo', id: saved.handoffId };
    const path = join(root, saved.relativePath);
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('Archive resolver', 'Tampered resolver'));
    await expect(readCompletionHandoff(options)).rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_CORRUPT' });
    await writeFile(path, original);
    await addProject(root, { projectId: 'other', displayName: 'Other', sourceRepository: 'https://example.invalid/other.git' });
    await expect(readCompletionHandoff({ ...options, projectId: 'other' })).rejects.toThrow();
    const outside = join(root, 'outside.json');
    await writeFile(outside, original);
    await unlink(path);
    await symlink(outside, path);
    await expect(readCompletionHandoff(options)).rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_UNSAFE_PATH' });
    await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input() })).rejects.toThrow();
    await symlink(join(root, 'projects/demo/handoffs'), join(root, 'projects/other/handoffs'));
    await expect(listCompletionHandoffs({ knowledgeRoot: root, projectId: 'other' })).rejects.toThrow();
  });

  it('commits only the sanitized handoff while preserving unrelated staged and unstaged changes', async () => {
    const root = await fixture();
    await writeFile(join(root, 'unrelated.txt'), 'staged\n');
    await git(root, ['add', '--', 'unrelated.txt']);
    await writeFile(join(root, 'unrelated.txt'), 'unstaged\n');
    const stagedBefore = await git(root, ['show', ':unrelated.txt']);
    const saved = await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input(), commit: true });
    expect(saved).toMatchObject({ storage: 'committed', cleanupEligible: false });
    expect(saved.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe(`${saved.relativePath}\n`);
    expect(await git(root, ['show', ':unrelated.txt'])).toBe(stagedBefore);
    expect(await readFile(join(root, 'unrelated.txt'), 'utf8')).toBe('unstaged\n');
    expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('unrelated.txt\n');
    expect(await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input(), commit: true })).toEqual(saved);
    expect(await verifyCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', id: saved.handoffId })).toEqual(saved);
  });

  it('keeps delayed predecessors as immutable history and never mutates a current baseline', async () => {
    const root = await fixture();
    const newer = await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: { ...input('iteration-2'), completedAt: '2026-09-26T00:00:00.000Z' } });
    const older = await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input() });
    expect(await listCompletionHandoffs({ knowledgeRoot: root, projectId: 'demo' })).toEqual([newer, older]);
    expect(await readdir(join(root, 'projects/demo/handoffs'))).toEqual(['objects']);
    expect(await listCompletionHandoffs({ knowledgeRoot: root, projectId: 'demo', workId: 'iteration-1' })).toEqual([older]);
  });

  it('preserves caller index and HEAD on index contention or failed ref update, then retries safely', async () => {
    for (const lock of ['index.lock', 'refs/heads/main.lock']) {
      const root = await fixture();
      await writeFile(join(root, 'unrelated.txt'), 'staged\n');
      await git(root, ['add', '--', 'unrelated.txt']);
      const indexBefore = await readFile(join(root, '.git/index'));
      const headBefore = await git(root, ['rev-parse', 'HEAD']);
      const lockPath = join(root, '.git', lock);
      await writeFile(lockPath, 'Synthetic competing Git writer.\n');
      await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input(), commit: true })).rejects.toThrow();
      expect(await readFile(join(root, '.git/index'))).toEqual(indexBefore);
      expect(await git(root, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(await readFile(lockPath, 'utf8')).toBe('Synthetic competing Git writer.\n');
      await unlink(lockPath);
      const saved = await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input(), commit: true });
      expect(saved.storage).toBe('committed');
      expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('unrelated.txt\n');
    }
  });

  it('rejects escaped credentials in JSON evidence without leaking or masking them into storage', async () => {
    const root = await fixture();
    const token = ['gh', 'p_', 'A1b2C3d4E5f6G7h8J9k0', 'LmNoPq'].join('');
    const encoded = [...token].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const body = `{"access":"${encoded}"}`;
    const value = { ...input(), sources: [{ ref: 'evidence.json', role: 'evidence', mediaType: 'application/json', body, sourceDigest: digest(body) }] };
    await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: value })).rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_SANITIZATION_FAILED' });
    await expect(lstat(join(root, 'projects/demo/handoffs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects credential assignments with Unicode-escaped JSON keys in baselines and sources', async () => {
    const root = await fixture();
    const body = '{"\\u0050ASSWORD":"demo-password"}';
    for (const value of [
      { ...input(), baseline: { ...input().baseline, body, sourceDigest: digest(body) } },
      { ...input(), sources: [{ ref: 'evidence.json', role: 'evidence', mediaType: 'application/json', body, sourceDigest: digest(body) }] },
    ]) {
      await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: value, commit: true }))
        .rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_SANITIZATION_FAILED' });
    }
    await expect(lstat(join(root, 'projects/demo/handoffs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sanitizes encoded nested JSON paths before encoding baseline and source bodies', async () => {
    const root = await fixture();
    const body = '{"cwd":"\\u002fhome\\u002falice\\u002fprivate\\u002fproject"}';
    for (const value of [
      { ...input(), baseline: { ...input().baseline, body, sourceDigest: digest(body) } },
      { ...input(), sources: [{ ref: 'evidence.json', role: 'evidence', mediaType: 'application/json', body, sourceDigest: digest(body) }] },
    ]) {
      const receipt = await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: value });
      const stored = await readCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', id: receipt.handoffId });
      const bodies = [stored.baseline.body, ...stored.sources.map((source) => source.body)].join('\n');
      expect(bodies).not.toContain('alice');
      expect(bodies).not.toContain('\\u002fhome');
      expect(bodies).toMatch(/<(?:HOME|ABSOLUTE_PATH)>/u);
    }
  });

  it('rejects duplicate JSON members so overwritten escaped credentials cannot bypass decoded scans', async () => {
    const root = await fixture();
    const token = ['gh', 'p_', 'A1b2C3d4E5f6G7h8J9k0', 'LmNoPq'].join('');
    const encoded = [...token].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const body = `{"access":"${encoded}","access":"none"}`;
    for (const value of [
      { ...input(), baseline: { ...input().baseline, body, sourceDigest: digest(body) } },
      { ...input(), sources: [{ ref: 'evidence.json', role: 'evidence', mediaType: 'application/json', body, sourceDigest: digest(body) }] },
    ]) await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: value })).rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_INPUT_INVALID' });
    await expect(lstat(join(root, 'projects/demo/handoffs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts exact P2A completion schema identifiers but rejects arbitrary schema-shaped secrets', async () => {
    const root = await fixture();
    for (const schema of ['p2a.decision_provenance_snapshot.v1', 'p2a.run_index_snapshot.v1']) {
      const body = JSON.stringify({ schema_version: schema });
      const value = { ...input(), baseline: { ...input().baseline, body, sourceDigest: digest(body) } };
      expect((await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: value })).storage).toBe('stored');
    }
    const body = JSON.stringify({ schema_version: ['p2a.', 'aB3dE5fG7hJ9kL2mN4pQ6rS8T0vX', '.v1'].join('') });
    await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: { ...input(), baseline: { ...input().baseline, body, sourceDigest: digest(body) } } })).rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_SANITIZATION_FAILED' });
    const mixed = ['p2a.run_index_snapshot.v1', 'aB3dE5fG7hJ9kL2mN4pQ6rS8T0vX'].join(' ');
    await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: { ...input(), knowledge: { ...input().knowledge, summary: mixed } } })).rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_SANITIZATION_FAILED' });
    const neighbors = JSON.stringify({ schema_version: 'p2a.run_index_snapshot.v1', note: 'aB3dE5fG7hJ9kL2mN4pQ6rS8T0vX' });
    await expect(preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: { ...input(), baseline: { ...input().baseline, body: neighbors, sourceDigest: digest(neighbors) } } })).rejects.toMatchObject({ code: 'COMPLETION_HANDOFF_SANITIZATION_FAILED' });
  });

  it('ignores an inherited Git index override and preserves the foreign index unchanged', async () => {
    const root = await fixture();
    const foreign = join(root, 'foreign-index');
    await writeFile(foreign, 'Synthetic outside index that must remain unchanged.\n');
    const previous = process.env.GIT_INDEX_FILE;
    try {
      process.env.GIT_INDEX_FILE = foreign;
      const saved = await preserveCompletionHandoff({ knowledgeRoot: root, projectId: 'demo', input: input(), commit: true });
      expect(saved.storage).toBe('committed');
      expect(await readFile(foreign, 'utf8')).toBe('Synthetic outside index that must remain unchanged.\n');
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
    }
  });
});
