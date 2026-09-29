import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArguments } from '../src/cli/parser.js';
import { runCli } from '../src/cli/run-cli.js';
import { connectProject } from '../src/connection/service.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import type { CompletionHandoff, CompletionHandoffInput, CompletionHandoffReceipt } from '../src/knowledge/completion-handoff.js';
import { git } from './helpers/connected-fixture.js';
import { createKnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';

const digest = `sha256:${'a'.repeat(64)}`;
const hash = (body: string): `sha256:${string}` => `sha256:${createHash('sha256').update(body).digest('hex')}`;

function completionInput(projectId = 'parcel'): CompletionHandoffInput {
  const baseline = JSON.stringify({ goal: 'Keep completion evidence available without work documents.' });
  const evidence = 'Verification passed: completed handoffs can be read independently.\n';
  return {
    schemaVersion: 'buildlore.completion-input.v1', projectId, workId: 'maintenance-one', workKind: 'maintenance',
    completedAt: '2026-09-25T03:00:00.000Z', repository: { id: `https://example.test/${projectId}.git`, codeRevision: 'b'.repeat(40), contentDigest: null },
    predecessor: null, affectedAreas: ['completion preservation'], supersedes: [],
    baseline: { format: 'test.baseline.v1', body: baseline, sourceDigest: hash(baseline) },
    knowledge: { summary: 'Completed evidence preservation.', decisions: ['Wiki adoption stays separate.'], lessons: [], remaining: ['Automatic cleanup is not implemented.'] },
    sources: [{ ref: '.plan2agent/evidence.txt', role: 'verification', mediaType: 'text/plain', body: evidence, sourceDigest: hash(evidence) }],
  };
}

async function cli(cwd: string, configDir: string, args: readonly string[]) {
  let stdout = '', stderr = '';
  const exitCode = await runCli([...args, '--json'], {
    stdout: value => { stdout += value; }, stderr: value => { stderr += value; },
  }, { cwd, configDir });
  const envelope = JSON.parse(stdout || stderr) as { ok: boolean; command: string; projectId: string | null; data: unknown; errors: readonly { code: string }[] };
  return { exitCode, stdout, stderr, envelope };
}

describe('completion handoff command parsing', () => {
  it('requires explicit project identity and grants commit only to import', () => {
    expect(parseCliArguments(['handoff', 'import', '--project', 'parcel', '--file', 'completion.json', '--commit', '--json']))
      .toMatchObject({ command: 'handoff.import', projectId: 'parcel', options: { '--commit': true } });
    expect(parseCliArguments(['handoff', 'read', '--project', 'parcel', '--id', digest]))
      .toMatchObject({ command: 'handoff.read' });
    expect(parseCliArguments(['handoff', 'list', '--project', 'parcel', '--work-id', 'maintenance-one', '--limit', '100']))
      .toMatchObject({ command: 'handoff.list' });
    expect(() => parseCliArguments(['handoff', 'list'], { connected: true })).toThrow();
    expect(() => parseCliArguments(['handoff', 'read', '--project', 'parcel', '--id', digest, '--commit'])).toThrow();
  });

  it.each(['a'.repeat(64), `sha256:${'A'.repeat(64)}`, '../other', 'sha256:123'])('rejects noncanonical handoff id %s', id => {
    expect(() => parseCliArguments(['handoff', 'verify', '--project', 'parcel', '--id', id])).toThrow();
  });

  it.each(['0', '101', '01', '-1', '1.5', '1e2'])('rejects invalid list limit %s', limit => {
    expect(() => parseCliArguments(['handoff', 'list', '--project', 'parcel', '--limit', limit])).toThrow();
  });
});

describe('completion handoff CLI preservation', () => {
  it('reads cloned preserved objects without original sources or empty compilation directories and never repairs the clone', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      const config = join(f.root, 'isolated-config');
      await git(f.knowledgeRoot, 'add', '.');
      await git(f.knowledgeRoot, 'commit', '-m', 'Registered fixture');
      const original = join(f.sourceRoot, 'completion.json');
      await writeFile(original, JSON.stringify(completionInput(f.projectId)));
      const imported = await cli(f.hubRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', original, '--commit']);
      expect(imported, imported.stderr).toMatchObject({ exitCode: 0 });
      const receipt = imported.envelope.data as CompletionHandoffReceipt;
      await rename(f.sourceRoot, join(f.root, 'source-unavailable'));
      const clone = join(f.root, 'knowledge-clone');
      await git(f.root, 'clone', '--no-hardlinks', f.knowledgeRoot, clone);
      await git(clone, 'remote', 'set-url', 'origin', join(f.root, 'knowledge.git'));
      const workspace = join(clone, 'projects', f.projectId);
      for (const directory of ['sources', 'wiki', '.llmwiki']) {
        await expect(readdir(join(workspace, directory))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const snapshot = async () => ({
        files: (await readdir(clone, { recursive: true })).filter(path => path !== '.git' && !path.startsWith('.git/')).sort(),
        head: await git(clone, 'rev-parse', 'HEAD'),
        index: await git(clone, 'ls-files', '--stage'),
        status: await git(clone, 'status', '--porcelain=v1', '--untracked-files=all'),
        bundle: await readFile(join(clone, receipt.relativePath), 'utf8'),
      });
      const before = await snapshot();
      expect(await cli(clone, config, ['handoff', 'read', '--project', f.projectId, '--id', receipt.handoffId]))
        .toMatchObject({ exitCode: 0, envelope: { data: { handoffId: receipt.handoffId, wikiStatus: 'pending', cleanupEligible: false } } });
      expect((await cli(clone, config, ['handoff', 'verify', '--project', f.projectId, '--id', receipt.handoffId])).envelope.data).toEqual(receipt);
      expect((await cli(clone, config, ['handoff', 'list', '--project', f.projectId])).envelope.data).toEqual([receipt]);
      // Existing project access remains strict rather than silently repairing compilation state.
      expect(await cli(clone, config, ['project', 'show', '--project', f.projectId]))
        .toMatchObject({ exitCode: 3, envelope: { errors: [{ code: 'MANIFEST_INVALID' }] } });
      expect(await snapshot()).toEqual(before);

      const descriptorPath = join(workspace, 'project.json');
      const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>;
      await writeFile(descriptorPath, JSON.stringify({ ...descriptor, projectId: 'other' }));
      expect(await cli(clone, config, ['handoff', 'read', '--project', f.projectId, '--id', receipt.handoffId]))
        .toMatchObject({ exitCode: 3, envelope: { errors: [{ code: 'MANIFEST_INVALID' }] } });
      expect((await cli(clone, config, ['handoff', 'read', '--project', 'other', '--id', receipt.handoffId])).exitCode).not.toBe(0);
      await writeFile(descriptorPath, JSON.stringify(descriptor));
      const detached = join(f.root, 'detached-project');
      await rename(workspace, detached);
      await symlink(detached, workspace);
      expect(await cli(clone, config, ['handoff', 'list', '--project', f.projectId]))
        .toMatchObject({ exitCode: 3, envelope: { errors: [{ code: 'PATH_OUTSIDE_KNOWLEDGE' }] } });
    } finally { await f.cleanup(); }
  });

  it('reads and retries committed handoffs in a legacy hub before its parent pin is updated', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json');
    try {
      const config = join(f.root, 'isolated-config');
      await git(f.knowledgeRoot, 'add', '.');
      await git(f.knowledgeRoot, 'commit', '-m', 'Registered fixture');
      await git(f.hubRoot, 'add', 'knowledge');
      await git(f.hubRoot, 'commit', '-m', 'Pin registered fixture');
      const pinned = await git(f.hubRoot, 'rev-parse', ':knowledge');
      const original = join(f.sourceRoot, 'completion.json');
      await writeFile(original, JSON.stringify(completionInput(f.projectId)));
      const imported = await cli(f.hubRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', original, '--commit']);
      expect(imported, imported.stderr).toMatchObject({ exitCode: 0, envelope: { data: { storage: 'committed' } } });
      const receipt = imported.envelope.data as CompletionHandoffReceipt;
      expect(await git(f.hubRoot, 'rev-parse', ':knowledge')).toBe(pinned);
      expect(await git(f.knowledgeRoot, 'rev-parse', 'HEAD')).not.toBe(pinned);
      expect(await cli(f.hubRoot, config, ['handoff', 'read', '--project', f.projectId, '--id', receipt.handoffId]))
        .toMatchObject({ exitCode: 0, envelope: { data: { handoffId: receipt.handoffId } } });
      expect((await cli(f.hubRoot, config, ['handoff', 'verify', '--project', f.projectId, '--id', receipt.handoffId])).envelope.data).toEqual(receipt);
      expect((await cli(f.hubRoot, config, ['handoff', 'list', '--project', f.projectId])).envelope.data).toEqual([receipt]);
      expect((await cli(f.hubRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', original, '--commit'])).envelope.data).toEqual(receipt);
      expect(await git(f.hubRoot, 'rev-parse', ':knowledge')).toBe(pinned);
      await git(f.knowledgeRoot, 'checkout', '--orphan', 'diverged');
      await git(f.knowledgeRoot, 'commit', '-m', 'Unrelated knowledge history');
      expect(await cli(f.hubRoot, config, ['handoff', 'read', '--project', f.projectId, '--id', receipt.handoffId]))
        .toMatchObject({ exitCode: 6, envelope: { errors: [{ code: 'SUBMODULE_MISMATCH' }] } });
    } finally { await f.cleanup(); }
  });

  it.each([false, true])('preserves and reads pending evidence without original documents (direct workspace: %s)', async directWorkspace => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace });
    try {
      const config = join(f.root, 'isolated-config');
      await mkdir(join(f.sourceRoot, '.plan2agent'));
      const lifecycle = join(f.sourceRoot, '.plan2agent/current.json');
      await writeFile(lifecycle, '{"development":"done","closeout":"waiting"}\n');
      const input = completionInput(f.projectId);
      const evidence = join(f.sourceRoot, '.plan2agent/evidence.txt');
      await writeFile(evidence, input.sources[0]?.body ?? '');
      const original = join(f.sourceRoot, 'completion.json');
      await writeFile(original, JSON.stringify(input));
      const knowledgeHead = await git(f.knowledgeRoot, 'rev-parse', 'HEAD');
      const codeHead = await git(f.sourceRoot, 'rev-parse', 'HEAD');
      const imported = await cli(f.hubRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', original]);
      expect(imported, imported.stderr).toMatchObject({ exitCode: 0, envelope: { command: 'handoff.import', projectId: f.projectId,
        data: { storage: 'stored', commit: null, wikiStatus: 'pending', cleanupEligible: false } } });
      const receipt = imported.envelope.data as CompletionHandoffReceipt;
      expect(receipt.handoffId).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect((await cli(f.hubRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', original])).envelope.data).toEqual(receipt);
      // These are only isolated fixture documents, not real user work artifacts.
      await unlink(original);
      await unlink(evidence);
      const storedBytes = await readFile(join(f.knowledgeRoot, receipt.relativePath), 'utf8');
      const read = await cli(f.hubRoot, config, ['handoff', 'read', '--project', f.projectId, '--id', receipt.handoffId]);
      expect(read, read.stderr).toMatchObject({ exitCode: 0, envelope: { data: { wikiStatus: 'pending', cleanupEligible: false,
        knowledge: input.knowledge, baseline: input.baseline, sources: input.sources } } });
      expect((await cli(f.hubRoot, config, ['handoff', 'verify', '--project', f.projectId, '--id', receipt.handoffId])).envelope.data).toEqual(receipt);
      expect((await cli(f.hubRoot, config, ['handoff', 'list', '--project', f.projectId, '--work-id', input.workId, '--limit', '1'])).envelope.data).toEqual([receipt]);
      expect((await cli(f.hubRoot, config, ['handoff', 'list', '--project', f.projectId, '--work-id', 'another-work'])).envelope.data).toEqual([]);
      expect(await readFile(join(f.knowledgeRoot, receipt.relativePath), 'utf8')).toBe(storedBytes);
      expect(await git(f.knowledgeRoot, 'rev-parse', 'HEAD')).toBe(knowledgeHead);
      expect(await git(f.sourceRoot, 'rev-parse', 'HEAD')).toBe(codeHead);
      expect(await readFile(lifecycle, 'utf8')).toBe('{"development":"done","closeout":"waiting"}\n');
      expect(await createKnowledgeWikiReader(f.knowledgeRoot).readMemory(f.projectId)).toBeNull();
    } finally { await f.cleanup(); }
  });

  it.each([false, true])('resolves connected sources and rejects cross-project or malformed connections (direct workspace: %s)', async directWorkspace => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace });
    try {
      const config = join(f.root, 'isolated-config');
      await connectProject(f.sourceRoot, { ...(directWorkspace ? { workspace: f.hubRoot } : { hub: f.hubRoot }),
        projectId: f.projectId, sourceRepository: `https://example.test/${f.projectId}.git` }, { configDir: config });
      await writeFile(join(f.sourceRoot, 'completion.json'), JSON.stringify(completionInput(f.projectId)));
      const imported = await cli(f.sourceRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', 'completion.json']);
      expect(imported, imported.stderr).toMatchObject({ exitCode: 0 });
      const receipt = imported.envelope.data as CompletionHandoffReceipt;
      expect(await cli(f.sourceRoot, config, ['handoff', 'read', '--project', f.projectId, '--id', receipt.handoffId])).toMatchObject({ exitCode: 0 });
      const wrong = await cli(f.sourceRoot, config, ['handoff', 'read', '--project', 'other', '--id', receipt.handoffId]);
      expect(wrong).toMatchObject({ exitCode: 3, envelope: { errors: [{ code: 'PROJECT_MISMATCH' }] } });
      await writeFile(join(f.sourceRoot, '.buildlore/connection.json'), '{invalid');
      const malformed = await cli(f.sourceRoot, config, ['handoff', 'list', '--project', f.projectId]);
      expect(malformed).toMatchObject({ exitCode: 3, envelope: { errors: [{ code: 'CONNECTION_INVALID' }] } });
    } finally { await f.cleanup(); }
  });

  it('uses explicit commit only for the bundle, preserving unrelated staged changes', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      const config = join(f.root, 'isolated-config');
      await git(f.knowledgeRoot, 'add', '.');
      await git(f.knowledgeRoot, 'commit', '-m', 'Registered fixture');
      await writeFile(join(f.knowledgeRoot, 'unrelated.txt'), 'User staged work.\n');
      await git(f.knowledgeRoot, 'add', 'unrelated.txt');
      const before = await git(f.knowledgeRoot, 'diff', '--cached', '--', 'unrelated.txt');
      const original = join(f.sourceRoot, 'completion.json');
      await writeFile(original, JSON.stringify(completionInput(f.projectId)));
      const imported = await cli(f.hubRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', original, '--commit']);
      expect(imported, imported.stderr).toMatchObject({ exitCode: 0, envelope: { data: { storage: 'committed', wikiStatus: 'pending', cleanupEligible: false } } });
      const receipt = imported.envelope.data as CompletionHandoffReceipt;
      expect(receipt.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(await git(f.knowledgeRoot, 'show', '--pretty=format:', '--name-only', 'HEAD')).toBe(receipt.relativePath);
      expect(await git(f.knowledgeRoot, 'diff', '--cached', '--', 'unrelated.txt')).toBe(before);
      expect((await cli(f.hubRoot, config, ['handoff', 'verify', '--project', f.projectId, '--id', receipt.handoffId])).envelope.data).toEqual(receipt);
      expect(await createKnowledgeWikiReader(f.knowledgeRoot).readMemory(f.projectId)).toBeNull();
    } finally { await f.cleanup(); }
  });

  it('rejects tampered content and wrong-project input without altering lifecycle state', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      const config = join(f.root, 'isolated-config');
      const original = join(f.sourceRoot, 'completion.json');
      await mkdir(join(f.sourceRoot, '.plan2agent'));
      const lifecycle = join(f.sourceRoot, '.plan2agent/current.json');
      await writeFile(lifecycle, '{"status":"done"}\n');
      await writeFile(original, JSON.stringify(completionInput('other')));
      expect((await cli(f.hubRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', original])).exitCode).toBe(3);
      await expect(readdir(join(f.knowledgeRoot, 'projects', f.projectId, 'handoffs'))).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(original, JSON.stringify(completionInput(f.projectId)));
      const imported = await cli(f.hubRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', original]);
      expect(imported, imported.stderr).toMatchObject({ exitCode: 0 });
      const receipt = imported.envelope.data as CompletionHandoffReceipt;
      const path = join(f.knowledgeRoot, receipt.relativePath);
      const stored = JSON.parse(await readFile(path, 'utf8')) as CompletionHandoff;
      await writeFile(path, JSON.stringify({ ...stored, knowledge: { ...stored.knowledge, summary: 'Tampered content.' } }));
      for (const operation of ['read', 'verify']) {
        const result = await cli(f.hubRoot, config, ['handoff', operation, '--project', f.projectId, '--id', receipt.handoffId]);
        expect(result).toMatchObject({ exitCode: 3, envelope: { errors: [{ code: 'COMPLETION_HANDOFF_CORRUPT' }] } });
        expect(result.stderr).not.toContain('Tampered content.');
      }
      expect(await readFile(lifecycle, 'utf8')).toBe('{"status":"done"}\n');
    } finally { await f.cleanup(); }
  });

  it('bounds strict JSON input and rejects symlink files or parents without exposing input', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
    try {
      const config = join(f.root, 'isolated-config');
      const valid = join(f.sourceRoot, 'completion.json');
      await writeFile(valid, JSON.stringify(completionInput(f.projectId)));
      const fileLink = join(f.root, 'linked.json'), directoryLink = join(f.root, 'linked-source');
      await symlink(valid, fileLink);
      await symlink(f.sourceRoot, directoryLink);
      const oversized = join(f.sourceRoot, 'oversized.json'), malformed = join(f.sourceRoot, 'malformed.json');
      await writeFile(oversized, `{"private":"${'x'.repeat(1024 * 1024)}"}`);
      await writeFile(malformed, '{"private":"do-not-echo-private-value","private":2}');
      for (const path of [fileLink, join(directoryLink, 'completion.json'), oversized, malformed, f.sourceRoot, join(f.root, 'missing.json')]) {
        const result = await cli(f.hubRoot, config, ['handoff', 'import', '--project', f.projectId, '--file', path]);
        expect(result).toMatchObject({ exitCode: 3, envelope: { errors: [{ code: 'COMPLETION_HANDOFF_INPUT_INVALID' }] } });
        expect(result.stderr).not.toContain('do-not-echo-private-value');
        expect(result.stderr).not.toContain(path);
      }
      await expect(readdir(join(f.knowledgeRoot, 'projects', f.projectId, 'handoffs'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.cleanup(); }
  });
});
