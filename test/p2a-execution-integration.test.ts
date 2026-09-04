import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectCompiler, createProjectSessionCompiler } from '../src/compiler/index.js';
import { addProject } from '../src/knowledge/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  SourceCheckoutHandle,
  sourceRepositoryDigestFor,
} from '../src/knowledge/local-project-registry.js';
import type {
  ExecutionAttempt,
  ExecutionCandidate,
  P2aExecutionSelection,
} from '../src/projector/execution-types.js';
import {
  createBuiltInSourceAdapterRegistry,
  createP2aExecutionKnowledgeProjector,
  createProjectSyncService,
  createSourceManagement,
  createSourceCollectionAdapter,
  initializeSingleProjectQuickstart,
  parseSourceDocument,
  p2aRunJsonKnowledgeAdapter,
} from '../src/projector/index.js';
import {
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
  SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
} from '../src/projector/source-manifest.js';
import { taskContractSha256 } from '../src/projector/p2a-execution-codecs.js';
import { createProfileBindingV2 } from '../src/profile/index.js';
import { startFakeOpenAiServer, type FakeOpenAiServer } from './fixtures/fake-openai.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const temporaryRoots: string[] = [];
const servers: FakeOpenAiServer[] = [];
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd, env: { ...process.env, LC_ALL: 'C' } });
}

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
  it('projects current P2A runs through the optional JSON reference adapter', async () => {
    const sourceRoot = await mkdtemp(join(process.cwd(), '.test-tmp-p2a-run-json-'));
    temporaryRoots.push(sourceRoot);
    await mkdir(join(sourceRoot, '.buildlore'));
    await mkdir(join(sourceRoot, 'artifacts/runs/v25-json'), { recursive: true });
    await mkdir(join(sourceRoot, 'artifacts/iterations/v25-json/gate-b-spec'), { recursive: true });
    await mkdir(join(sourceRoot, 'artifacts/iterations/v25-json/gate-c-task-graph'), {
      recursive: true,
    });
    const graphTask = {
      id: 'task-001',
      status: 'todo',
      title: 'Generic JSON projection',
    };
    const taskContract = taskContractSha256(graphTask);
    const spec = {
      approval: 'approved',
      clarifying_question_disposition: [],
      evidence: [],
      implementation: {
        architecture: [], data_flow: [], dependencies: [], edge_cases: [], interfaces: [],
        verification: [],
      },
      open_decisions: [],
      product: {
        constraints: [], core_flows: [], data_model_draft: [], external_integrations: [],
        goals: [], must_preserve: [], non_goals: [], problem: 'Project verified JSON runs.',
        screens_or_interfaces: [], success_criteria: [], target_users: [],
      },
      project_id: 'alpha',
      schema_version: 'p2a.spec.v1',
      source_intake: '../gate-a-intake/intake.json',
      source_intake_sha256: '1'.repeat(64),
    };
    const specBytes = JSON.stringify(spec);
    await writeFile(
      join(sourceRoot, 'artifacts/iterations/v25-json/gate-b-spec/spec.json'),
      specBytes,
    );
    await writeFile(
      join(sourceRoot, 'artifacts/iterations/v25-json/gate-c-task-graph/task-graph.json'),
      JSON.stringify({
        projectId: 'alpha',
        schema_version: 'p2a.task_graph.v1',
        sourceSpec: '../gate-b-spec/spec.json',
        tasks: [graphTask],
        version: 'v25-json',
      }),
    );
    const executionEnvelope = {
      acceptance: ['Verified.'],
      executionAuthority: { mayChoose: [], mustReturnToGate: [] },
      mustPreserve: ['Isolation.'],
      nonGoals: [],
      objective: 'Project JSON runs.',
      scope: ['p2a.run.v2'],
      sourceGateRefs: [{ path: '../gate-b-spec/spec.json', sha256: digest(specBytes) }],
      verification: ['npm test'],
    };
    const run = (overrides: Readonly<Record<string, unknown>> = {}) => ({
      agentTool: 'codex',
      changedFiles: ['src/projector/json-source-adapter.ts'],
      executionEnvelope,
      executionEnvelopeSha256: digest(JSON.stringify(executionEnvelope)),
      finishedAt: '2026-09-04T01:01:00.000Z',
      fixSummary: { files: [], summaries: ['Added generic JSON projection.'] },
      isolation: {
        baseRef: null, branch: null, createCommand: null, createExitCode: null,
        createOutputTail: null, created: false, mode: 'none', worktree: null,
      },
      iterationId: 'v25-json',
      notes: [],
      productRevisionSha256: 'b'.repeat(64),
      projectId: 'alpha',
      runId: 'run-2026-09-04T01-00-00-000Z-task-001',
      schema_version: 'p2a.run.v2',
      sourceLayout: 'iteration',
      sourceSpecRef: '../gate-b-spec/spec.json',
      startedAt: '2026-09-04T01:00:00.000Z',
      status: 'finished',
      taskContractSha256: taskContract,
      taskGraphRef: 'iterations/v25-json/gate-c-task-graph/task-graph.json',
      taskId: 'task-001',
      taskTitle: 'Generic JSON projection',
      updatedAt: '2026-09-04T01:01:00.000Z',
      verification: [{
        command: 'npm test', durationMs: 1, exitCode: 0,
        finishedAt: '2026-09-04T01:00:40.000Z', source: 'command',
        startedAt: '2026-09-04T01:00:39.000Z', status: 'passed',
        stderrTail: 'RAW-STDERR-MUST-NOT-SURVIVE',
        stdoutTail: 'RAW-STDOUT-MUST-NOT-SURVIVE', type: 'test',
      }],
      workspacePath: '/private/workspace',
      workspaceRef: '/private/workspace',
      workspaceRevisionSha256: 'd'.repeat(64),
      ...overrides,
    });
    const failedRunId = 'run-2026-09-04T00-58-00-000Z-task-001';
    const normalRunId = 'run-2026-09-04T01-00-00-000Z-task-001';
    const finalRunId = 'run-2026-09-04T01-02-00-000Z-task-001';
    await writeFile(join(sourceRoot, `artifacts/runs/v25-json/${failedRunId}.json`), JSON.stringify(run({
      changedFiles: [],
      failure: {
        class: 'verification_failed',
        needsUserDecision: false,
        retryable: 'after_fix',
        source: 'implementer',
      },
      finishedAt: '2026-09-04T00:59:00.000Z',
      fixSummary: { files: [], summaries: [] },
      guard: { checks: ['Keep the fixed JSON projection covered.'], notes: [] },
      localization: { files: [], findings: ['JSON projection verification failed.'] },
      reproduction: { commands: ['npm test'], notes: [], steps: ['Run the JSON tests.'] },
      runId: failedRunId,
      startedAt: '2026-09-04T00:58:00.000Z',
      status: 'failed',
      updatedAt: '2026-09-04T00:59:00.000Z',
      verification: [{
        command: 'npm test', durationMs: 1, exitCode: 1,
        finishedAt: '2026-09-04T00:58:40.000Z', source: 'command',
        startedAt: '2026-09-04T00:58:39.000Z', status: 'failed',
        stderrTail: 'RAW-FAILURE-MUST-NOT-SURVIVE', stdoutTail: '', type: 'test',
      }],
    })));
    await writeFile(join(sourceRoot, `artifacts/runs/v25-json/${normalRunId}.json`), JSON.stringify(run()));
    await writeFile(join(sourceRoot, `artifacts/runs/v25-json/${finalRunId}.json`), JSON.stringify(run({
      changedFiles: [],
      fixSummary: { files: [], summaries: [] },
      runId: finalRunId,
      runKind: 'final_verification',
      startedAt: '2026-09-04T01:02:00.000Z',
      updatedAt: '2026-09-04T01:03:00.000Z',
      finishedAt: '2026-09-04T01:03:00.000Z',
      verification: [
        {
          command: 'npm test', durationMs: 1, exitCode: 0,
          finishedAt: '2026-09-04T01:02:40.000Z', source: 'command',
          startedAt: '2026-09-04T01:02:39.000Z', status: 'passed',
          stderrTail: '', stdoutTail: '', type: 'test',
        },
        {
          command: 'npm run lint', durationMs: 1, exitCode: 0,
          finishedAt: '2026-09-04T01:02:50.000Z', source: 'command',
          startedAt: '2026-09-04T01:02:49.000Z', status: 'passed',
          stderrTail: '', stdoutTail: '', type: 'lint',
        },
      ],
    })));
    const runIndex = {
      projectId: 'alpha',
      runs: [
        {
          agentTool: 'codex',
          finishedAt: '2026-09-04T00:59:00.000Z',
          iterationId: 'v25-json',
          runId: failedRunId,
          runRef: `v25-json/${failedRunId}.json`,
          startedAt: '2026-09-04T00:58:00.000Z',
          status: 'failed',
          taskGraphRef: 'iterations/v25-json/gate-c-task-graph/task-graph.json',
          taskId: 'task-001',
          workspaceRef: '/private/workspace',
        },
        {
          agentTool: 'codex',
          finishedAt: '2026-09-04T01:01:00.000Z',
          iterationId: 'v25-json',
          runId: normalRunId,
          runRef: `v25-json/${normalRunId}.json`,
          startedAt: '2026-09-04T01:00:00.000Z',
          status: 'finished',
          taskGraphRef: 'iterations/v25-json/gate-c-task-graph/task-graph.json',
          taskId: 'task-001',
          workspaceRef: '/private/workspace',
        },
        {
          agentTool: 'codex',
          finishedAt: '2026-09-04T01:03:00.000Z',
          iterationId: 'v25-json',
          runId: finalRunId,
          runKind: 'final_verification',
          runRef: `v25-json/${finalRunId}.json`,
          startedAt: '2026-09-04T01:02:00.000Z',
          status: 'finished',
          taskGraphRef: 'iterations/v25-json/gate-c-task-graph/task-graph.json',
          taskId: 'task-001',
          workspaceRef: '/private/workspace',
        },
      ],
      schema_version: 'p2a.run_index.v1',
      tasks: [{
        latestRunId: finalRunId,
        runIds: [failedRunId, normalRunId, finalRunId],
        taskId: 'task-001',
      }],
    };
    await writeFile(join(sourceRoot, 'artifacts/runs/run-index.json'), JSON.stringify(runIndex));
    const registered = p2aRunJsonKnowledgeAdapter();
    const registry = createBuiltInSourceAdapterRegistry({ registrations: [registered] });
    await writeFile(join(sourceRoot, '.buildlore/sources.json'), serializeCanonicalJson({
      projectId: 'alpha',
      schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
      sourceRepository: 'https://example.test/alpha.git',
      sources: [{
        adapterId: registered.registration.adapterId,
        adapterVersion: 1,
        id: 'artifacts',
        kind: 'json',
        path: 'artifacts',
        pathType: 'directory',
        recursive: true,
      }],
    }));
    const checkout = new SourceCheckoutHandle(
      'alpha',
      sourceRepositoryDigestFor('https://example.test/alpha.git'),
      sourceRoot,
    );
    const loadedManifest = await readSourceCollectionManifest(checkout, 'alpha', {
      sourceAdapterRegistry: registry,
    });
    const inventory = await selectDeclaredSourceFiles(checkout, loadedManifest, {
      sourceAdapterRegistry: registry,
    });
    const result = await createSourceCollectionAdapter({
      jsonKnowledgeAdapters: [registered], sourceAdapterRegistry: registry,
    }).collect({
      checkout,
      ingestedAt: '2026-09-04T01:03:00.000Z',
      inventory,
      loadedManifest,
      sourceAdapterRegistry: registry,
    });
    expect(result.candidates).toHaveLength(1);
    const body = result.candidates[0]?.body ?? '';
    expect(body).toContain('Changed: src/projector/json-source-adapter.ts');
    expect(body).toContain('Resolution: Added generic JSON projection.');
    expect(body).toContain('Failure: verification_failed');
    expect(body).toContain('Failure evidence: Run the JSON tests.');
    expect(body.match(/npm test/gu)).toHaveLength(2);
    expect(body).toContain('npm run lint');
    expect(body).not.toContain('RAW-STDOUT-MUST-NOT-SURVIVE');
    expect(body).not.toContain('/private/workspace');

    await writeFile(join(sourceRoot, 'artifacts/runs/run-index.json'), JSON.stringify({
      ...runIndex,
      runs: runIndex.runs.map((entry, index) => index === 1
        ? { ...entry, status: 'failed' }
        : entry),
    }));
    const driftedInventory = await selectDeclaredSourceFiles(checkout, loadedManifest, {
      sourceAdapterRegistry: registry,
    });
    const drifted = await createSourceCollectionAdapter({
      jsonKnowledgeAdapters: [registered], sourceAdapterRegistry: registry,
    }).collect({
      checkout,
      ingestedAt: '2026-09-04T01:03:00.000Z',
      inventory: driftedInventory,
      loadedManifest,
      sourceAdapterRegistry: registry,
    });
    expect(drifted.candidates).toHaveLength(0);
    expect(drifted.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decision: 'quarantine',
        reasonCode: 'p2a_lineage_invalid',
      }),
    ]));
    await writeFile(join(sourceRoot, 'artifacts/runs/run-index.json'), JSON.stringify(runIndex));

    await writeFile(
      join(sourceRoot, 'artifacts/iterations/v25-json/gate-b-spec/spec.json'),
      JSON.stringify({
        ...spec,
        product: { ...spec.product, goals: ['Unapproved changed goal.'] },
      }),
    );
    const specDriftInventory = await selectDeclaredSourceFiles(checkout, loadedManifest, {
      sourceAdapterRegistry: registry,
    });
    const specDrift = await createSourceCollectionAdapter({
      jsonKnowledgeAdapters: [registered], sourceAdapterRegistry: registry,
    }).collect({
      checkout,
      ingestedAt: '2026-09-04T01:03:00.000Z',
      inventory: specDriftInventory,
      loadedManifest,
      sourceAdapterRegistry: registry,
    });
    expect(specDrift.candidates).toHaveLength(0);
    expect(specDrift.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'quarantine', reasonCode: 'p2a_lineage_invalid' }),
    ]));

    await writeFile(
      join(sourceRoot, 'artifacts/iterations/v25-json/gate-b-spec/spec.json'),
      JSON.stringify({
        approval: 'approved',
        project_id: 'alpha',
        schema_version: 'p2a.spec.v1',
      }),
    );
    const malformedSpecInventory = await selectDeclaredSourceFiles(checkout, loadedManifest, {
      sourceAdapterRegistry: registry,
    });
    const malformedSpec = await createSourceCollectionAdapter({
      jsonKnowledgeAdapters: [registered], sourceAdapterRegistry: registry,
    }).collect({
      checkout,
      ingestedAt: '2026-09-04T01:03:00.000Z',
      inventory: malformedSpecInventory,
      loadedManifest,
      sourceAdapterRegistry: registry,
    });
    expect(malformedSpec.candidates).toHaveLength(0);
    expect(malformedSpec.entries).toContainEqual(expect.objectContaining({
      decision: 'quarantine',
      reasonCode: 'adapter_schema_unsupported',
      sourceRef: 'artifacts/iterations/v25-json/gate-b-spec/spec.json',
    }));
    await writeFile(
      join(sourceRoot, 'artifacts/iterations/v25-json/gate-b-spec/spec.json'),
      specBytes,
    );

    await writeFile(join(sourceRoot, 'artifacts/runs/unknown.json'), JSON.stringify({
      schema_version: 'p2a.run.v99',
    }));
    const unsupportedInventory = await selectDeclaredSourceFiles(checkout, loadedManifest, {
      sourceAdapterRegistry: registry,
    });
    const unsupported = await createSourceCollectionAdapter({
      jsonKnowledgeAdapters: [registered], sourceAdapterRegistry: registry,
    }).collect({
      checkout,
      ingestedAt: '2026-09-04T01:03:00.000Z',
      inventory: unsupportedInventory,
      loadedManifest,
      sourceAdapterRegistry: registry,
    });
    expect(unsupported.entries).toContainEqual(expect.objectContaining({
      decision: 'quarantine',
      reasonCode: 'adapter_schema_unsupported',
      sourceRef: 'artifacts/runs/unknown.json',
    }));

    await rm(join(sourceRoot, 'artifacts/runs/unknown.json'));
    const customManifest = await readFile(join(sourceRoot, '.buildlore/sources.json'), 'utf8');
    await rm(join(sourceRoot, '.buildlore/sources.json'));
    await git(sourceRoot, ['init', '--initial-branch=main']);
    await git(sourceRoot, ['config', 'user.name', 'BuildLore Test']);
    await git(sourceRoot, ['config', 'user.email', 'buildlore@example.invalid']);
    await git(sourceRoot, ['add', '.']);
    await git(sourceRoot, ['commit', '-m', 'seed P2A artifacts']);

    const hubFixtureRoot = await mkdtemp(join(tmpdir(), 'buildlore-p2a-run-hub-'));
    temporaryRoots.push(hubFixtureRoot);
    const knowledgeOrigin = join(hubFixtureRoot, 'knowledge.git');
    const knowledgeSeed = join(hubFixtureRoot, 'knowledge-seed');
    const hubRoot = join(hubFixtureRoot, 'hub');
    await git(hubFixtureRoot, ['init', '--bare', '--initial-branch=main', knowledgeOrigin]);
    await git(hubFixtureRoot, [
      '-c', 'protocol.file.allow=always', 'clone', knowledgeOrigin, knowledgeSeed,
    ]);
    await git(knowledgeSeed, ['config', 'user.name', 'BuildLore Test']);
    await git(knowledgeSeed, ['config', 'user.email', 'buildlore@example.invalid']);
    await writeFile(join(knowledgeSeed, 'README.md'), '# Knowledge\n');
    await git(knowledgeSeed, ['add', 'README.md']);
    await git(knowledgeSeed, ['commit', '-m', 'seed knowledge']);
    await git(knowledgeSeed, ['push', 'origin', 'main']);
    await mkdir(hubRoot);
    await initializeSingleProjectQuickstart(hubRoot, {
      branch: 'main',
      knowledgeRepository: '../knowledge.git',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot,
    });
    await writeFile(join(sourceRoot, '.buildlore/sources.json'), customManifest);
    await git(sourceRoot, ['add', '.buildlore/sources.json']);
    await git(sourceRoot, ['commit', '-m', 'bind P2A artifact source']);
    await writeFile(
      join(hubRoot, 'knowledge/projects/alpha/profile-binding.json'),
      serializeCanonicalJson(createProfileBindingV2('general', 'en', [registered])),
    );
    await writeSecurityPolicy(join(hubRoot, 'knowledge'), 'alpha');

    const synchronized = await createProjectSyncService({
      jsonKnowledgeAdapters: [registered],
    }).sync({ dryRun: false, hubRoot, projectId: 'alpha' });
    expect(synchronized.writes).toEqual([
      expect.objectContaining({ sourceKind: 'json', writeStatus: 'create' }),
    ]);
    const sourceDirectory = join(hubRoot, 'knowledge/projects/alpha/sources');
    const generatedFilename = (await readdir(sourceDirectory)).find((name) =>
      name.startsWith('json--'));
    expect(generatedFilename).toBeDefined();
    const generated = parseSourceDocument(await readFile(
      join(sourceDirectory, generatedFilename!),
      'utf8',
    ));
    expect(generated.body).toContain('Changed: src/projector/json-source-adapter.ts');
    expect(JSON.stringify(generated)).not.toContain('RAW-STD');
    expect(JSON.stringify(generated)).not.toContain('/private/workspace');

    const management = createSourceManagement({
      hubRoot,
      jsonKnowledgeAdapters: [registered],
    });
    await expect(management.diff('alpha')).resolves.toMatchObject({
      records: [expect.objectContaining({ status: 'unchanged' })],
    });
    const compilePlan = await createProjectSessionCompiler({
      hubRoot,
      jsonKnowledgeAdapters: [registered],
      knowledgeRoot: join(hubRoot, 'knowledge'),
    }).plan({ projectId: 'alpha' });
    expect(compilePlan.sources).toHaveLength(1);
    expect(compilePlan.sources[0]?.sanitizedBody)
      .toContain('Changed: src/projector/json-source-adapter.ts');

    await writeFile(join(sourceRoot, 'artifacts/runs/run-index.json'), JSON.stringify({
      ...runIndex,
      runs: runIndex.runs.map((entry, index) => index === 1
        ? { ...entry, status: 'failed' }
        : entry),
    }));
    await git(sourceRoot, ['add', '.']);
    await git(sourceRoot, ['commit', '-m', 'add quarantined P2A lineage fixture']);
    const quarantinedDiff = await management.diff('alpha');
    expect(quarantinedDiff.records.some((record) =>
      record.reasonCode === 'SOURCE_ADAPTER_BLOCKED' && record.status === 'blocked')).toBe(true);
    await expect(createProjectSessionCompiler({
      hubRoot,
      jsonKnowledgeAdapters: [registered],
      knowledgeRoot: join(hubRoot, 'knowledge'),
    }).plan({ projectId: 'alpha' })).rejects.toMatchObject({
      code: 'SESSION_PLAN_DENIED',
    });
    await writeFile(join(sourceRoot, 'artifacts/runs/run-index.json'), JSON.stringify(runIndex));
    await git(sourceRoot, ['add', '.']);
    await git(sourceRoot, ['commit', '-m', 'restore P2A lineage fixture']);

    const generatedBeforeSecret = await readFile(
      join(sourceDirectory, generatedFilename!),
      'utf8',
    );
    const secret = `AKIA${'A1B2C3D4E5F6G7H8'}`;
    await writeFile(
      join(sourceRoot, `artifacts/runs/v25-json/${normalRunId}.json`),
      JSON.stringify(run({
        verification: [{
          command: 'npm test',
          durationMs: 1,
          exitCode: 0,
          finishedAt: '2026-09-04T01:00:40.000Z',
          source: 'command',
          startedAt: '2026-09-04T01:00:39.000Z',
          status: 'passed',
          stderrTail: '',
          stdoutTail: secret,
          type: 'test',
        }],
      })),
    );
    await git(sourceRoot, ['add', '.']);
    await git(sourceRoot, ['commit', '-m', 'add unsafe trace fixture']);
    await expect(createProjectSyncService({
      jsonKnowledgeAdapters: [registered],
    }).sync({ dryRun: false, hubRoot, projectId: 'alpha' })).rejects.toMatchObject({
      code: 'SYNC_SANITIZATION_FAILED',
      completedTargets: [],
      partial: false,
    });
    await expect(readFile(join(sourceDirectory, generatedFilename!), 'utf8'))
      .resolves.toBe(generatedBeforeSecret);
  });

  it('resolves a completed maintenance run through current-spec to its approved spec', async () => {
    const sourceRoot = await mkdtemp(join(process.cwd(), '.test-tmp-p2a-maintenance-json-'));
    temporaryRoots.push(sourceRoot);
    await mkdir(join(sourceRoot, '.buildlore'));
    await mkdir(join(sourceRoot, 'artifacts/runs/maintenance'), { recursive: true });
    await mkdir(join(sourceRoot, 'artifacts/iterations/maintenance/gate-c-task-graph'), {
      recursive: true,
    });
    await mkdir(join(sourceRoot, 'artifacts/iterations/v25-json/gate-b-spec'), { recursive: true });
    const graphTask = {
      acceptanceCriteria: ['Maintenance evidence is projected.'],
      dependencies: [],
      description: 'Keep current P2A maintenance artifacts compatible.',
      id: 'task-006',
      intent: 'Mutable maintenance execution intent.',
      sourceSpecRefs: ['review:critical'],
      status: 'done',
      suggestedAgentPrompt: 'Apply the maintenance fix.',
      targetArea: 'projector',
      title: 'P2A maintenance compatibility',
    };
    const spec = {
      approval: 'approved',
      clarifying_question_disposition: [],
      evidence: [],
      implementation: {
        architecture: [], data_flow: [], dependencies: [], edge_cases: [], interfaces: [],
        verification: [],
      },
      open_decisions: [],
      product: {
        constraints: [], core_flows: [], data_model_draft: [], external_integrations: [],
        goals: [], must_preserve: [], non_goals: [], problem: 'Maintain P2A compatibility.',
        screens_or_interfaces: [], success_criteria: [], target_users: [],
      },
      project_id: 'alpha',
      schema_version: 'p2a.spec.v1',
      source_intake: '../gate-a-intake/intake.json',
      source_intake_sha256: '1'.repeat(64),
    };
    const runId = 'run-2026-09-04T06-32-02-191Z-task-006';
    await Promise.all([
      writeFile(
        join(sourceRoot, 'artifacts/iterations/v25-json/gate-b-spec/spec.json'),
        JSON.stringify(spec),
      ),
      writeFile(join(sourceRoot, 'artifacts/current-spec.json'), JSON.stringify({
        active_iteration: 'v25-json',
        closed_iterations: [],
        effective_spec_ref: 'iterations/v25-json/gate-b-spec/spec.json',
        open_decisions: [],
        project_id: 'alpha',
        schema_version: 'p2a.current_spec.v1',
      })),
      writeFile(
        join(sourceRoot, 'artifacts/iterations/maintenance/gate-c-task-graph/task-graph.json'),
        JSON.stringify({
          projectId: 'alpha',
          schema_version: 'p2a.task_graph.v1',
          sourceSpec: '../../../current-spec.json',
          tasks: [graphTask],
          version: 'maintenance',
        }),
      ),
      writeFile(join(sourceRoot, `artifacts/runs/maintenance/${runId}.json`), JSON.stringify({
        agentTool: 'codex',
        changedFiles: ['src/projector/p2a-execution-codecs.ts'],
        finishedAt: '2026-09-04T06:40:00.000Z',
        fixSummary: {
          files: ['src/projector/p2a-execution-codecs.ts'],
          summaries: ['Aligned the immutable task contract.'],
        },
        isolation: {
          baseRef: null, branch: null, createCommand: null, createExitCode: null,
          createOutputTail: null, created: false, mode: 'none', worktree: null,
        },
        iterationId: 'maintenance',
        notes: [],
        projectId: 'alpha',
        runId,
        schema_version: 'p2a.run.v2',
        sourceLayout: 'maintenance',
        sourceSpecRef: '../../../current-spec.json',
        startedAt: '2026-09-04T06:32:02.191Z',
        status: 'finished',
        taskContractSha256: taskContractSha256(graphTask),
        taskGraphRef: 'iterations/maintenance/gate-c-task-graph/task-graph.json',
        taskId: 'task-006',
        taskTitle: 'P2A maintenance compatibility',
        updatedAt: '2026-09-04T06:40:00.000Z',
        verification: [],
        workspacePath: '/private/workspace',
        workspaceRef: '/private/workspace',
      })),
      writeFile(join(sourceRoot, 'artifacts/runs/run-index.json'), JSON.stringify({
        projectId: 'alpha',
        runs: [{
          agentTool: 'codex',
          finishedAt: '2026-09-04T06:40:00.000Z',
          iterationId: 'maintenance',
          runId,
          runRef: `maintenance/${runId}.json`,
          startedAt: '2026-09-04T06:32:02.191Z',
          status: 'finished',
          taskGraphRef: 'iterations/maintenance/gate-c-task-graph/task-graph.json',
          taskId: 'task-006',
          workspaceRef: '/private/workspace',
        }],
        schema_version: 'p2a.run_index.v1',
        tasks: [{ latestRunId: runId, runIds: [runId], taskId: 'task-006' }],
      })),
    ]);
    const registered = p2aRunJsonKnowledgeAdapter();
    const registry = createBuiltInSourceAdapterRegistry({ registrations: [registered] });
    await writeFile(join(sourceRoot, '.buildlore/sources.json'), serializeCanonicalJson({
      projectId: 'alpha',
      schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
      sourceRepository: 'https://example.test/alpha.git',
      sources: [{
        adapterId: registered.registration.adapterId,
        adapterVersion: 1,
        id: 'artifacts',
        kind: 'json',
        path: 'artifacts',
        pathType: 'directory',
        recursive: true,
      }],
    }));
    const checkout = new SourceCheckoutHandle(
      'alpha', sourceRepositoryDigestFor('https://example.test/alpha.git'), sourceRoot,
    );
    const loadedManifest = await readSourceCollectionManifest(checkout, 'alpha', {
      sourceAdapterRegistry: registry,
    });
    const inventory = await selectDeclaredSourceFiles(checkout, loadedManifest, {
      sourceAdapterRegistry: registry,
    });
    const result = await createSourceCollectionAdapter({
      jsonKnowledgeAdapters: [registered], sourceAdapterRegistry: registry,
    }).collect({
      checkout,
      ingestedAt: '2026-09-04T06:40:00.000Z',
      inventory,
      loadedManifest,
      sourceAdapterRegistry: registry,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.body).toContain('Aligned the immutable task contract.');
    expect(result.candidates[0]?.title).toBe('P2A maintenance compatibility');
    expect(result.entries.every((entry) => entry.decision === 'exclude')).toBe(true);
  });

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
