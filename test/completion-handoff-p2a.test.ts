import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { connectProject } from '../src/connection/service.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { preserveCompletionHandoff, type CompletionHandoff, type CompletionHandoffReceipt } from '../src/knowledge/completion-handoff.js';
import { createKnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';

const exec = promisify(execFile);
const checkout = process.env.P2A_CHECKOUT;

// Opt in with an actual P2A checkout; no mock adapter and no live project state.
it.skipIf(!checkout)('captures through the real P2A CLI and preserves through the built BuildLore CLI, including clone-only reads', async () => {
  const p2a = join(resolve(checkout ?? '.'), 'scripts/p2a.mjs');
  const buildlore = join(process.cwd(), 'dist/cli/bin.js');
  const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true, projectId: 'webhook-api-service' });
  try {
    const configDir = join(f.root, 'isolated-config');
    const env = { ...process.env, BUILDLORE_CONFIG_DIR: configDir };
    const command = async (cwd: string, executable: string, args: readonly string[]) =>
      (await exec(executable, [...args], { cwd, env, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })).stdout;
    const runP2a = (args: readonly string[]) => command(f.sourceRoot, process.execPath, [p2a, ...args]);
    const jsonP2a = async <T>(args: readonly string[]): Promise<T> => {
      const parsed = JSON.parse(await runP2a([...args, '--json'])) as T | { ok: boolean; data: T };
      if (args[0] === 'buildlore') {
        const envelope = parsed as { ok: boolean; data: T };
        expect(envelope.ok).toBe(true);
        return envelope.data;
      }
      return parsed as T;
    };
    const git = (args: readonly string[]) => command(f.knowledgeRoot, 'git', args);
    await connectProject(f.sourceRoot, { workspace: f.knowledgeRoot, projectId: f.projectId,
      sourceRepository: `https://example.test/${f.projectId}.git` }, { configDir });
    const artifacts = join(f.sourceRoot, '.plan2agent/artifacts', f.projectId);
    await mkdir(join(f.sourceRoot, '.plan2agent/artifacts'), { recursive: true });
    await cp(join(resolve(checkout ?? '.'), 'fixtures/_e2e/webhook-api-service'), artifacts, { recursive: true });
    await writeFile(join(f.sourceRoot, '.plan2agent/project.config.json'), JSON.stringify({
      projectId: f.projectId, runTracking: { persistence: 'persistent' },
      devExecution: { reviewPasses: { acceptance: 'off' } },
      buildlore: { command: process.execPath, commandArgs: [buildlore] },
    }));
    await runP2a(['iteration', 'init', '--artifacts', artifacts, '--iteration-id', 'v1-mvp']);
    const graphPath = join(artifacts, 'iterations/v1-mvp/gate-c-task-graph/task-graph.json');
    const graph = JSON.parse(await readFile(graphPath, 'utf8')) as { tasks: { id: string; status: string }[] };
    for (const task of graph.tasks) task.status = 'done';
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
    await runP2a(['execute', 'verify-final', '--artifacts', artifacts, '--task', graph.tasks[0]!.id, '--run-id', 'run-handoff-final', '--agent-tool', 'manual']);
    await runP2a(['runs', 'verify', '--artifacts', artifacts, '--run-id', 'run-handoff-final', '--test-command', 'node -e "console.log(123)"']);
    await runP2a(['execute', 'finish', '--artifacts', artifacts, '--run-id', 'run-handoff-final']);
    await runP2a(['iteration', 'close', '--artifacts', artifacts]);
    const lifecycle = await readFile(join(artifacts, 'current-spec.json'), 'utf8');
    const captured = await jsonP2a<{ bundlePath: string; sanitized: boolean; cleanupEligible: boolean }>([
      'knowledge', 'capture', '--artifacts', artifacts, '--iteration', 'v1-mvp',
    ]);
    expect(captured).toMatchObject({ sanitized: false, cleanupEligible: false });
    await git(['add', '.']);
    await git(['commit', '-m', 'Isolated registered knowledge fixture']);
    await writeFile(join(f.knowledgeRoot, 'user-staged.txt'), 'Unrelated staged data.\n');
    await git(['add', 'user-staged.txt']);
    const stagedBefore = await git(['diff', '--cached', '--', 'user-staged.txt']);
    const capturedInput = JSON.parse(await readFile(join(f.sourceRoot, captured.bundlePath), 'utf8')) as unknown;
    await preserveCompletionHandoff({ knowledgeRoot: f.knowledgeRoot, projectId: f.projectId, input: capturedInput });
    const receipt = await jsonP2a<CompletionHandoffReceipt>([
      'buildlore', 'handoff', 'import', '--file', captured.bundlePath, '--commit',
    ]);
    expect(receipt).toMatchObject({ projectId: f.projectId, workId: 'v1-mvp', storage: 'committed', wikiStatus: 'pending', cleanupEligible: false });
    expect(await git(['show', '--pretty=format:', '--name-only', 'HEAD'])).toBe(`${receipt.relativePath}\n`);
    expect(await git(['diff', '--cached', '--', 'user-staged.txt'])).toBe(stagedBefore);
    expect(await readFile(join(artifacts, 'current-spec.json'), 'utf8')).toBe(lifecycle);
    const stored = await jsonP2a<CompletionHandoff>(['buildlore', 'handoff', 'read', '--id', receipt.handoffId]);
    expect(stored.baseline.format).toBe('p2a.current_development_contract.v1');
    expect(stored.sources.some(source => source.role === 'verification')).toBe(true);
    expect(await createKnowledgeWikiReader(f.knowledgeRoot).readMemory(f.projectId)).toBeNull();
    // Remove only the isolated fixture source from its declared location, reversibly.
    await rename(f.sourceRoot, join(f.root, 'source-unavailable'));
    const clone = join(f.root, 'knowledge-clone');
    await command(f.root, 'git', ['clone', '--no-hardlinks', f.knowledgeRoot, clone]);
    // Local cloning transfers the unpushed object, but the portable workspace
    // must retain its declared repository identity, not the cache checkout URL.
    await command(clone, 'git', ['remote', 'set-url', 'origin', join(f.root, 'knowledge.git')]);
    const fromClone = async <T>(action: string): Promise<T> => {
      const envelope = JSON.parse(await command(clone, process.execPath, [buildlore, 'handoff', action,
        '--project', f.projectId, '--id', receipt.handoffId, '--json'])) as { ok: boolean; data: T };
      expect(envelope.ok).toBe(true);
      return envelope.data;
    };
    expect(await fromClone<CompletionHandoff>('read')).toEqual(stored);
    expect(await fromClone<CompletionHandoffReceipt>('verify')).toEqual(receipt);
  } finally { await f.cleanup(); }
}, 60_000);
