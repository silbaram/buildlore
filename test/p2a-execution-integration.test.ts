import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectCompiler } from '../src/compiler/index.js';
import { addProject } from '../src/knowledge/index.js';
import type {
  ExecutionAttempt,
  ExecutionCandidate,
  P2aExecutionSelection,
} from '../src/projector/execution-types.js';
import { createP2aExecutionKnowledgeProjector } from '../src/projector/index.js';
import { startFakeOpenAiServer, type FakeOpenAiServer } from './fixtures/fake-openai.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const temporaryRoots: string[] = [];
const servers: FakeOpenAiServer[] = [];

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      hash.update(relativePath);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else {
        hash.update(await readFile(path));
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

function executionSelection(root: string): P2aExecutionSelection {
  const revision = `sha256:${digest('execution-integration-v1')}` as const;
  const lineage = {
    graphRef: 'iterations/v1-execution/gate-c-task-graph/task-graph.json',
    graphRevision: `sha256:${digest('task-graph-v1')}` as const,
    graphVersion: 'v1-execution',
    iterationId: 'v1-execution',
    sourceSpecRef: 'iterations/v1-execution/gate-b-spec/spec.json',
    sourceSpecRevision: `sha256:${digest('spec-v1')}` as const,
    taskContractSha256: digest('task-contract-v1'),
    taskId: 'task-001',
    taskTitle: 'Project execution knowledge',
  };
  const sourceUri = [
    'buildlore+p2a:',
    encodeURIComponent('https://example.test/alpha.git'),
    'alpha',
    lineage.iterationId,
    'execution-task',
    encodeURIComponent(lineage.graphRef),
    lineage.taskId,
    lineage.taskContractSha256,
  ].join('/');
  const attempt: ExecutionAttempt = {
    changedFiles: ['src/projector/p2a-execution-projector.ts'],
    finishedAt: '2026-08-20T01:03:00.000Z',
    fixSummaries: ['Projected verified execution knowledge.'],
    guardChecks: ['Keep project workspaces isolated.'],
    guardNotes: [],
    localizationFiles: [],
    localizationFindings: [],
    reproductionSteps: [],
    runId: 'run-2026-08-20T01-02-00-000Z-task-001',
    runRef: 'v1-execution/run-2026-08-20T01-02-00-000Z-task-001.json',
    runRevision: `sha256:${digest('run-v1')}`,
    sourceGateRefs: [],
    startedAt: '2026-08-20T01:02:00.000Z',
    status: 'finished',
    verification: [{
      command: 'npm test',
      exitCode: 0,
      finishedAt: '2026-08-20T01:03:00.000Z',
      source: 'command',
      startedAt: '2026-08-20T01:02:30.000Z',
      status: 'passed',
      type: 'test',
    }],
  };
  const candidate: ExecutionCandidate = {
    attempts: [attempt],
    body: [
      '# Task Identity',
      '',
      'ALPHA-MARKER execution knowledge belongs only to project alpha.',
      '',
      '# Verification',
      '',
      'The projector and compiler integration tests passed.',
    ].join('\n'),
    ingestedAt: '2026-08-20T01:03:00.000Z',
    lineage,
    reasonCode: 'reusable_verification',
    sourceRevision: revision,
    sourceUri,
    target: `execution--${digest(sourceUri)}.md`,
    taskStableId: digest(sourceUri),
    title: 'Project execution knowledge',
  };
  return {
    artifactRoot: root,
    bindings: [],
    candidates: [candidate],
    entries: [{
      attempts: [{
        runId: attempt.runId,
        runRef: attempt.runRef,
        runRevision: attempt.runRevision,
        status: attempt.status,
      }],
      decision: 'include',
      lineage,
      reasonCode: candidate.reasonCode,
      sourceRevision: revision,
      sourceUri,
      target: candidate.target,
      taskStableId: candidate.taskStableId,
    }],
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('P2A execution projector compiler integration', () => {
  it('compiles a projected execution source once without changing another project', async () => {
    const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-execution-integration-'));
    temporaryRoots.push(knowledgeRoot);
    await addProject(knowledgeRoot, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    await addProject(knowledgeRoot, {
      displayName: 'Beta',
      projectId: 'beta',
      sourceRepository: 'https://example.test/beta.git',
    });
    const selection = executionSelection(join(knowledgeRoot, 'artifacts'));
    const projector = createP2aExecutionKnowledgeProjector({
      artifactReader: {
        read() {
          return Promise.resolve(selection);
        },
        verify() {
          return Promise.resolve();
        },
      },
    });
    const input = {
      artifactRoot: selection.artifactRoot,
      knowledgeRoot,
      projectId: 'alpha',
    };

    const firstPlan = await projector.plan(input);
    await expect(projector.apply(firstPlan)).resolves.toMatchObject({
      projectId: 'alpha',
      writes: [{ writeStatus: 'create' }],
    });
    await writeSecurityPolicy(knowledgeRoot, 'alpha');
    const compiler = createProjectCompiler({ knowledgeRoot });
    await expect(compiler.status('alpha')).resolves.toMatchObject({
      pendingChangesCount: 1,
      stateStatus: 'missing',
    });

    const secondPlan = await projector.plan(input);
    expect(secondPlan.entries).toContainEqual(expect.objectContaining({ writeStatus: 'unchanged' }));
    await expect(projector.apply(secondPlan)).resolves.toMatchObject({
      writes: [{ writeStatus: 'unchanged' }],
    });

    const betaBefore = await treeDigest(join(knowledgeRoot, 'projects', 'beta'));
    const provider = await startFakeOpenAiServer();
    servers.push(provider);
    const previous = { ...process.env };
    try {
      process.env.LLMWIKI_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'fixture-execution-key';
      process.env.OPENAI_BASE_URL = provider.baseUrl;
      process.env.OPENAI_EMBEDDINGS_BASE_URL = provider.baseUrl;
      process.env.LLMWIKI_MODEL = 'fixture-model';
      process.env.LLMWIKI_EMBEDDING_MODEL = 'fixture-embedding-model';

      await expect(compiler.execute({ capability: 'compile', projectId: 'alpha' }))
        .resolves.toMatchObject({ outcome: 'succeeded', projectId: 'alpha' });
      await expect(readFile(
        join(knowledgeRoot, 'projects', 'alpha', 'wiki', 'concepts', 'shared-topic.md'),
        'utf8',
      )).resolves.toContain('Shared Topic');
      await expect(readFile(
        join(knowledgeRoot, 'projects', 'alpha', '.llmwiki', 'state.json'),
        'utf8',
      )).resolves.toContain('execution--');
      expect(provider.chatBodies.some((body) => body.includes('ALPHA-MARKER'))).toBe(true);
      const providerCalls = provider.chatCalls + provider.embeddingCalls;
      await expect(compiler.execute({ capability: 'compile', projectId: 'alpha' }))
        .resolves.toMatchObject({ data: { compiled: 0 }, outcome: 'unchanged' });
      expect(provider.chatCalls + provider.embeddingCalls).toBe(providerCalls);
    } finally {
      process.env = previous;
    }
    await expect(compiler.status('alpha')).resolves.toMatchObject({ pendingChangesCount: 0 });
    await expect(treeDigest(join(knowledgeRoot, 'projects', 'beta'))).resolves.toBe(betaBefore);
  });
});
