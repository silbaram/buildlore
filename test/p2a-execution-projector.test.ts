import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addProject } from '../src/knowledge/index.js';
import type {
  ExecutionAttempt,
  ExecutionCandidate,
  P2aExecutionSelection,
} from '../src/projector/execution-types.js';
import { createP2aExecutionKnowledgeProjector } from '../src/projector/index.js';
import { taskContractSha256 } from '../src/projector/p2a-execution-codecs.js';
import { applyExecutionInclusionPolicy } from '../src/projector/p2a-execution-policy.js';
import type { ProjectSourceWriter } from '../src/projector/project-source-writer.js';
import {
  issueSanitizationApproval,
  type SourceSanitizerPort,
} from '../src/sanitizer/index.js';

const temporaryRoots: string[] = [];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function envelope(specHash: string): Record<string, unknown> {
  return {
    acceptance: ['Execution source is deterministic.'],
    executionAuthority: {
      mayChoose: ['internal structure'],
      mustReturnToGate: ['scope change'],
    },
    mustPreserve: ['project isolation'],
    nonGoals: ['raw trace persistence'],
    objective: 'Project retry knowledge.',
    scope: ['p2a.run.v2'],
    sourceGateRefs: [{ path: '../gate-b-spec/spec.json', sha256: specHash }],
    verification: ['npm test'],
  };
}

function task(iterationId: string): Record<string, unknown> {
  return {
    acceptanceCriteria: ['Execution source is deterministic.'],
    dependencies: [],
    description: `Project verified runs for ${iterationId}.`,
    id: 'task-001',
    sourceSpecRefs: ['product.goals'],
    status: 'done',
    suggestedAgentPrompt: 'Implement the projector.',
    targetArea: 'projector',
    title: `Execution projection ${iterationId}`,
    workKind: 'non_ui',
  };
}

function archivedClose(
  iterationId: string,
  graphRef: string,
  specRef: string,
  graph: string,
  spec: string,
): Record<string, unknown> {
  return {
    artifact_hashes: {
      [graphRef]: { present: true, sha256: digest(graph) },
      [specRef]: { present: true, sha256: digest(spec) },
    },
    closed_at: '2026-08-20T01:04:00.000Z',
    effective_spec_ref: 'current-spec.json',
    iteration_id: iterationId,
    spec_ref: specRef,
    status: 'archived',
    task_count: 1,
    task_graph_ref: graphRef,
    task_status_counts: { blocked: 0, done: 1, in_progress: 0, todo: 0 },
  };
}

function verification(): readonly Record<string, unknown>[] {
  return [{
    command: 'npm test',
    durationMs: 1_000,
    exitCode: 0,
    finishedAt: '2026-08-20T01:02:31.000Z',
    source: 'command',
    startedAt: '2026-08-20T01:02:30.000Z',
    status: 'passed',
    stderrTail: 'RAW-STDERR-SENTINEL',
    stdoutTail: 'RAW-STDOUT-SENTINEL',
    type: 'test',
  }];
}

function run(
  iterationId: string,
  id: string,
  status: 'failed' | 'finished',
  taskContract: string,
  specHash: string,
): Record<string, unknown> {
  const executionEnvelope = envelope(specHash);
  const failed = status === 'failed';
  return {
    agentTool: 'codex',
    changedFiles: failed ? [] : ['src/projector/p2a-execution-projector.ts'],
    executionEnvelope,
    executionEnvelopeSha256: digest(JSON.stringify(executionEnvelope)),
    ...(failed ? {
      failure: {
        class: 'verification_failed',
        needsUserDecision: false,
        retryable: 'after_fix',
        source: 'owner',
      },
      guard: { checks: ['Run codec regression tests.'], notes: [] },
      localization: {
        files: ['src/projector/p2a-execution-codecs.ts'],
        findings: ['The contract hash did not match.'],
      },
      reproduction: {
        commands: ['npm test'],
        notes: ['RAW-NOTE-MUST-NOT-SURVIVE'],
        steps: ['Execute the codec fixture.'],
      },
    } : {
      fixSummary: {
        files: ['src/projector/p2a-execution-codecs.ts'],
        summaries: ['Validated the canonical task contract.'],
      },
    }),
    finishedAt: failed
      ? '2026-08-20T01:01:00.000Z'
      : '2026-08-20T01:03:00.000Z',
    isolation: {
      baseRef: null,
      branch: null,
      createCommand: null,
      createExitCode: null,
      createOutputTail: null,
      created: false,
      mode: 'none',
      worktree: null,
    },
    iterationId,
    notes: [],
    projectId: 'alpha',
    runId: id,
    schema_version: 'p2a.run.v2',
    sourceLayout: failed ? 'graph' : 'iteration',
    sourceSpecRef: '../gate-b-spec/spec.json',
    startedAt: failed
      ? '2026-08-20T01:00:00.000Z'
      : '2026-08-20T01:02:00.000Z',
    status,
    taskContractSha256: taskContract,
    taskGraphRef: '/private/legacy/task-graph.json',
    taskId: 'task-001',
    taskTitle: 'Untrusted run title',
    updatedAt: failed
      ? '2026-08-20T01:01:00.000Z'
      : '2026-08-20T01:03:00.000Z',
    verification: failed ? [] : verification(),
    workspacePath: '/private/workspace',
    workspaceRef: '/private/workspace',
  };
}

interface Fixture {
  readonly artifactRoot: string;
  readonly failedRunPath: string;
  readonly indexPath: string;
  readonly knowledgeRoot: string;
  readonly sources: string;
}

async function fixture(
  sourceRepository = 'https://example.test/alpha.git',
  duplicateTask = false,
): Promise<Fixture> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-execution-projector-'));
  temporaryRoots.push(root);
  const artifactRoot = join(root, 'artifacts');
  const knowledgeRoot = join(root, 'knowledge');
  const iterationId = 'v1-execution';
  const iterationRoot = join(artifactRoot, 'iterations', iterationId);
  const graphRef = `iterations/${iterationId}/gate-c-task-graph/task-graph.json`;
  const specRef = `iterations/${iterationId}/gate-b-spec/spec.json`;
  const runRoot = join(artifactRoot, 'runs', iterationId);
  await Promise.all([
    mkdir(join(iterationRoot, 'gate-b-spec'), { recursive: true }),
    mkdir(join(iterationRoot, 'gate-c-task-graph'), { recursive: true }),
    mkdir(runRoot, { recursive: true }),
    mkdir(knowledgeRoot),
  ]);
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository,
  });
  const spec = json({ approval: 'approved', project_id: 'alpha' });
  const specHash = digest(spec);
  const taskValue = task(iterationId);
  const taskContract = taskContractSha256(taskValue);
  const graph = json({
    projectId: 'alpha',
    schema_version: 'p2a.task_graph.v1',
    sourceSpec: '../gate-b-spec/spec.json',
    tasks: duplicateTask ? [taskValue, { ...taskValue }] : [taskValue],
    version: iterationId,
  });
  const close = archivedClose(iterationId, graphRef, specRef, graph, spec);
  const failedId = 'run-2026-08-20T01-00-00-000Z-task-001';
  const finishedId = 'run-2026-08-20T01-02-00-000Z-task-001';
  const failed = json(run(iterationId, failedId, 'failed', taskContract, 'f'.repeat(64)));
  const finished = json(run(iterationId, finishedId, 'finished', taskContract, specHash));
  const summaries = [
    {
      agentTool: 'codex',
      finishedAt: '2026-08-20T01:01:00.000Z',
      iterationId,
      runId: failedId,
      runRef: `${iterationId}/${failedId}.json`,
      startedAt: '2026-08-20T01:00:00.000Z',
      status: 'failed',
      taskGraphRef: '/private/legacy/task-graph.json',
      taskId: 'task-001',
      workspaceRef: '/private/workspace',
    },
    {
      agentTool: 'codex',
      finishedAt: '2026-08-20T01:03:00.000Z',
      iterationId,
      runId: finishedId,
      runRef: `${iterationId}/${finishedId}.json`,
      startedAt: '2026-08-20T01:02:00.000Z',
      status: 'finished',
      taskGraphRef: '/private/legacy/task-graph.json',
      taskId: 'task-001',
      workspaceRef: '/private/workspace',
    },
  ];
  const indexPath = join(artifactRoot, 'runs', 'run-index.json');
  const failedRunPath = join(runRoot, `${failedId}.json`);
  await Promise.all([
    writeFile(join(artifactRoot, 'current-spec.json'), json({
      active_iteration: null,
      closed_iterations: [close],
      project_id: 'alpha',
      schema_version: 'p2a.current_spec.v1',
    }), 'utf8'),
    writeFile(join(iterationRoot, 'iteration.json'), json({
      iteration_id: iterationId,
      project_id: 'alpha',
      schema_version: 'p2a.iteration_metadata.v1',
      status: 'archived',
      close,
    }), 'utf8'),
    writeFile(join(artifactRoot, ...graphRef.split('/')), graph, 'utf8'),
    writeFile(join(artifactRoot, ...specRef.split('/')), spec, 'utf8'),
    writeFile(failedRunPath, failed, 'utf8'),
    writeFile(join(runRoot, `${finishedId}.json`), finished, 'utf8'),
    writeFile(indexPath, json({
      projectId: 'alpha',
      runs: summaries,
      schema_version: 'p2a.run_index.v1',
      tasks: [{ latestRunId: finishedId, runIds: [failedId, finishedId], taskId: 'task-001' }],
    }), 'utf8'),
  ]);
  return {
    artifactRoot,
    failedRunPath,
    indexPath,
    knowledgeRoot,
    sources: join(knowledgeRoot, 'projects', 'alpha', 'sources'),
  };
}

const sanitizer: SourceSanitizerPort = {
  sanitize(request) {
    return Promise.resolve(issueSanitizationApproval({
      approvedBody: request.body,
      approvedBodyDigest: `sha256:${digest(request.body)}`,
      inputBodyDigest: request.bodyDigest,
      projectId: request.projectId,
      source: request.source,
    }));
  },
};

function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    changedFiles: [],
    finishedAt: '2026-08-20T01:01:00.000Z',
    fixSummaries: [],
    guardChecks: [],
    guardNotes: [],
    localizationFiles: [],
    localizationFindings: [],
    reproductionSteps: [],
    runId: 'run-1',
    runRef: 'v1/run-1.json',
    runRevision: `sha256:${'a'.repeat(64)}`,
    sourceGateRefs: [],
    startedAt: '2026-08-20T01:00:00.000Z',
    status: 'finished',
    verification: [],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('P2A execution projector', () => {
  it('applies stable inclusion reasons without using input order', () => {
    const failed = attempt({
      failureClass: 'verification_failed',
      runId: 'run-a',
      runRef: 'v1/run-a.json',
      status: 'failed',
    });
    const recovered = attempt({
      finishedAt: '2026-08-20T01:03:00.000Z',
      runId: 'run-b',
      runRef: 'v1/run-b.json',
      startedAt: '2026-08-20T01:02:00.000Z',
    });
    expect(applyExecutionInclusionPolicy([recovered, failed])).toMatchObject({
      included: [failed, recovered],
      reasonCode: 'retry_succeeded',
    });
    expect(applyExecutionInclusionPolicy([attempt({
      failureClass: 'implementation_incomplete',
      status: 'blocked',
    })])).toMatchObject({ reasonCode: 'failed_or_blocked' });
    expect(applyExecutionInclusionPolicy([attempt({ status: 'started', finishedAt: null })]))
      .toMatchObject({ excluded: [expect.objectContaining({ reasonCode: 'started' })] });
    expect(applyExecutionInclusionPolicy([attempt()]))
      .toMatchObject({ excluded: [expect.objectContaining({ reasonCode: 'low_signal' })] });
    expect(applyExecutionInclusionPolicy([attempt({
      fixSummaries: ['A summary without a durable change or verification.'],
    })])).toMatchObject({ excluded: [expect.objectContaining({ reasonCode: 'low_signal' })] });
    expect(applyExecutionInclusionPolicy([attempt({
      changedFiles: [
        'plans', 'plans/local-only.md', '.plan2agent', '.plan2agent/run.json',
        'dist', 'dist/index.js', 'node_modules', 'node_modules/package/index.js',
      ],
    })])).toMatchObject({ excluded: [expect.objectContaining({ reasonCode: 'low_signal' })] });
    expect(applyExecutionInclusionPolicy([attempt({ changedFiles: ['src/index.ts'] })]))
      .toMatchObject({ reasonCode: 'significant_change' });
    expect(applyExecutionInclusionPolicy([attempt({ verification: [{
      command: 'npm test',
      exitCode: 0,
      finishedAt: null,
      source: 'command',
      startedAt: null,
      status: 'passed',
      type: 'test',
    }] })])).toMatchObject({ reasonCode: 'reusable_verification' });
    const firstSuccess = attempt({ changedFiles: ['src/index.ts'], runId: 'run-a' });
    const duplicateSuccess = attempt({
      changedFiles: ['src/index.ts'],
      finishedAt: '2026-08-20T01:03:00.000Z',
      runId: 'run-b',
      startedAt: '2026-08-20T01:02:00.000Z',
    });
    expect(applyExecutionInclusionPolicy([duplicateSuccess, firstSuccess])).toMatchObject({
      excluded: [expect.objectContaining({ reasonCode: 'duplicate_success' })],
      included: [firstSuccess],
      reasonCode: 'significant_change',
    });
  });

  it('plans and applies one deterministic retry-chain source without raw traces', async () => {
    const item = await fixture();
    const failedRunBefore = await readFile(item.failedRunPath, 'utf8');
    const projector = createP2aExecutionKnowledgeProjector();
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.counts).toEqual({ exclude: 0, include: 1, quarantine: 0 });
    const included = plan.entries.find((entry) => entry.decision === 'include');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.counts)).toBe(true);
    expect(Object.isFrozen(plan.entries)).toBe(true);
    expect(Object.isFrozen(included)).toBe(true);
    expect(Object.isFrozen(included?.attempts)).toBe(true);
    expect(Object.isFrozen(included?.attempts[0])).toBe(true);
    expect(Object.isFrozen(included?.lineage)).toBe(true);
    expect(included).toMatchObject({
      attempts: [
        expect.objectContaining({ status: 'failed' }),
        expect.objectContaining({ status: 'finished' }),
      ],
      reasonCode: 'retry_succeeded',
      writeStatus: 'create',
    });
    expect(included?.target).toMatch(/^execution--[a-f0-9]{64}\.md$/u);
    expect(await readdir(item.sources)).toEqual([]);

    const applied = await projector.apply(plan, sanitizer);
    expect(applied.writes).toEqual([
      expect.objectContaining({ target: included?.target, writeStatus: 'create' }),
    ]);
    if (included?.target === undefined) throw new Error('execution target missing');
    const markdown = await readFile(join(item.sources, included.target), 'utf8');
    const headings = [
      '# Task Identity', '# Attempt Timeline', '# Final Status', '# Changed Files',
      '# Verification', '# Failure Signals and Localization',
      '# Resolution and Prevention', '# Source References',
    ];
    expect(headings.every((heading) => markdown.indexOf(heading) >= 0)).toBe(true);
    expect(headings.every((heading, index) =>
      index === 0 || markdown.indexOf(heading) > markdown.indexOf(headings[index - 1] ?? '')))
      .toBe(true);
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown).not.toContain('RAW-STD');
    expect(markdown).not.toContain('RAW-NOTE');
    expect(markdown).not.toContain('/private/');
    expect(markdown).toContain(
      'spec="iterations/v1-execution/gate-b-spec/spec.json" sha256="sha256:',
    );
    expect(markdown).toContain(
      'gate="iterations/v1-execution/gate-b-spec/spec.json" sha256="sha256:ffffffff',
    );
    expect(markdown).toContain(`sha256="sha256:${digest(failedRunBefore)}"`);
    await expect(readFile(item.failedRunPath, 'utf8')).resolves.toBe(failedRunBefore);
  });

  it('keeps identity, attempt order and source revision stable when index order changes', async () => {
    const item = await fixture();
    const projector = createP2aExecutionKnowledgeProjector();
    const first = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    const firstIncluded = first.entries.find((entry) => entry.decision === 'include');
    if (firstIncluded?.target === undefined) throw new Error('execution target missing');
    await projector.apply(first, sanitizer);
    const firstMarkdown = await readFile(join(item.sources, firstIncluded.target), 'utf8');
    const index = JSON.parse(await readFile(item.indexPath, 'utf8')) as Record<string, unknown>;
    if (!Array.isArray(index.runs)) throw new Error('fixture index runs missing');
    index.runs.reverse();
    await writeFile(item.indexPath, json(index), 'utf8');
    const second = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    const pick = (plan: typeof first): unknown => plan.entries.find(
      (entry) => entry.decision === 'include',
    );
    expect(pick(second)).toMatchObject({
      attempts: (pick(first) as Readonly<{ attempts: unknown }>).attempts,
      sourceRevision: (pick(first) as Readonly<{ sourceRevision: unknown }>).sourceRevision,
      sourceUri: (pick(first) as Readonly<{ sourceUri: unknown }>).sourceUri,
      target: (pick(first) as Readonly<{ target: unknown }>).target,
      writeStatus: 'unchanged',
    });
    await projector.apply(second, sanitizer);
    await expect(readFile(join(item.sources, firstIncluded.target), 'utf8')).resolves.toBe(
      firstMarkdown,
    );
  });

  it('keeps same-id tasks in other iterations separate even when index tasks merge them', async () => {
    const item = await fixture();
    const currentPath = join(item.artifactRoot, 'current-spec.json');
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>;
    const index = JSON.parse(await readFile(item.indexPath, 'utf8')) as Record<string, unknown>;
    if (!Array.isArray(current.closed_iterations) || !Array.isArray(index.runs)) {
      throw new Error('fixture lineage metadata missing');
    }
    const allRunIds = index.runs.map((value) =>
      (value as Readonly<Record<string, unknown>>).runId as string);
    for (const [position, iterationId] of [
      'v2-knowledge-workspace',
      'v3-compiler-adapter',
      'v4-source-document-projector',
    ].entries()) {
      const iterationRoot = join(item.artifactRoot, 'iterations', iterationId);
      const graphRef = `iterations/${iterationId}/gate-c-task-graph/task-graph.json`;
      const specRef = `iterations/${iterationId}/gate-b-spec/spec.json`;
      const runId = `run-2026-08-20T02-0${position}-00-000Z-task-001`;
      await Promise.all([
        mkdir(join(iterationRoot, 'gate-b-spec'), { recursive: true }),
        mkdir(join(iterationRoot, 'gate-c-task-graph'), { recursive: true }),
        mkdir(join(item.artifactRoot, 'runs', iterationId), { recursive: true }),
      ]);
      const spec = json({ approval: 'approved', iteration_id: iterationId, project_id: 'alpha' });
      const taskValue = task(iterationId);
      const taskContract = taskContractSha256(taskValue);
      const graph = json({
        projectId: 'alpha',
        schema_version: 'p2a.task_graph.v1',
        sourceSpec: '../gate-b-spec/spec.json',
        tasks: [taskValue],
        version: iterationId,
      });
      const close = archivedClose(iterationId, graphRef, specRef, graph, spec);
      await Promise.all([
        writeFile(join(iterationRoot, 'gate-b-spec', 'spec.json'), spec, 'utf8'),
        writeFile(join(iterationRoot, 'gate-c-task-graph', 'task-graph.json'), graph, 'utf8'),
        writeFile(join(iterationRoot, 'iteration.json'), json({
          iteration_id: iterationId,
          project_id: 'alpha',
          schema_version: 'p2a.iteration_metadata.v1',
          status: 'archived',
          close,
        }), 'utf8'),
        writeFile(
          join(item.artifactRoot, 'runs', iterationId, `${runId}.json`),
          json(run(iterationId, runId, 'finished', taskContract, digest(spec))),
          'utf8',
        ),
      ]);
      current.closed_iterations.push(close);
      index.runs.push({
        agentTool: 'codex',
        finishedAt: '2026-08-20T01:03:00.000Z',
        iterationId,
        runId,
        runRef: `${iterationId}/${runId}.json`,
        startedAt: '2026-08-20T01:02:00.000Z',
        status: 'finished',
        taskGraphRef: '/private/legacy/task-graph.json',
        taskId: 'task-001',
        workspaceRef: '/private/workspace',
      });
      allRunIds.push(runId);
    }
    index.tasks = [{ latestRunId: allRunIds.at(-1), runIds: allRunIds, taskId: 'task-001' }];
    await Promise.all([
      writeFile(currentPath, json(current), 'utf8'),
      writeFile(item.indexPath, json(index), 'utf8'),
    ]);

    const plan = await createP2aExecutionKnowledgeProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    const included = plan.entries.filter((entry) => entry.decision === 'include');
    expect(plan.counts).toEqual({ exclude: 0, include: 4, quarantine: 0 });
    expect(included.map((entry) => entry.lineage?.iterationId)).toEqual([
      'v1-execution',
      'v2-knowledge-workspace',
      'v3-compiler-adapter',
      'v4-source-document-projector',
    ]);
    expect(included[0]).toMatchObject({ reasonCode: 'retry_succeeded' });
    expect(new Set(included.map((entry) => entry.target))).toHaveProperty('size', 4);
  });

  it('blocks every write before sanitization when any run is quarantined', async () => {
    const item = await fixture();
    const failed = JSON.parse(await readFile(item.failedRunPath, 'utf8')) as Record<string, unknown>;
    failed.schema_version = 'p2a.run.v1';
    await writeFile(item.failedRunPath, json(failed), 'utf8');
    let sanitizerCalls = 0;
    const projector = createP2aExecutionKnowledgeProjector();
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.counts.quarantine).toBe(1);
    await expect(projector.apply(plan, {
      sanitize(request) {
        sanitizerCalls += 1;
        return sanitizer.sanitize(request);
      },
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
    expect(sanitizerCalls).toBe(0);
    expect(await readdir(item.sources)).toEqual([]);
  });

  it('quarantines a run artifact that is not valid UTF-8 JSON', async () => {
    const item = await fixture();
    await writeFile(item.failedRunPath, Buffer.from([0xff, 0xfe, 0xfd]));
    const plan = await createP2aExecutionKnowledgeProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.counts).toEqual({ exclude: 0, include: 1, quarantine: 1 });
    expect(plan.entries).toContainEqual(expect.objectContaining({
      decision: 'quarantine',
      reasonCode: 'unsupported_schema',
    }));
  });

  it('reports an index-to-run identity mismatch without merging the run', async () => {
    const item = await fixture();
    const index = JSON.parse(await readFile(item.indexPath, 'utf8')) as Record<string, unknown>;
    if (!Array.isArray(index.runs)) throw new Error('fixture index runs missing');
    const first = index.runs[0] as Record<string, unknown>;
    first.status = 'blocked';
    await writeFile(item.indexPath, json(index), 'utf8');
    const plan = await createP2aExecutionKnowledgeProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.entries).toContainEqual(expect.objectContaining({
      decision: 'quarantine',
      reasonCode: 'run_hash_mismatch',
    }));
  });

  it('quarantines an unindexed canonical run and detects inventory drift', async () => {
    const extraRunName = 'run-custom-unindexed.json';
    const reportFixture = await fixture();
    await writeFile(
      join(
        reportFixture.artifactRoot,
        'runs',
        'v1-execution',
        'run-custom.monitor-verdict.json',
      ),
      json({ schema_version: 'p2a.monitor_verdict.v1' }),
      'utf8',
    );
    await writeFile(
      join(reportFixture.artifactRoot, 'runs', 'v1-execution', extraRunName),
      json({ schema_version: 'p2a.run.v2' }),
      'utf8',
    );
    const report = await createP2aExecutionKnowledgeProjector().plan({
      artifactRoot: reportFixture.artifactRoot,
      knowledgeRoot: reportFixture.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(report.counts).toEqual({ exclude: 0, include: 1, quarantine: 1 });
    expect(report.entries).toContainEqual(expect.objectContaining({
      decision: 'quarantine',
      reasonCode: 'run_reference_invalid',
    }));

    const driftFixture = await fixture();
    const projector = createP2aExecutionKnowledgeProjector();
    const plan = await projector.plan({
      artifactRoot: driftFixture.artifactRoot,
      knowledgeRoot: driftFixture.knowledgeRoot,
      projectId: 'alpha',
    });
    await writeFile(
      join(driftFixture.artifactRoot, 'runs', 'v1-execution', extraRunName),
      json({ schema_version: 'p2a.run.v2' }),
      'utf8',
    );
    let sanitizerCalls = 0;
    await expect(projector.apply(plan, {
      sanitize(request) {
        sanitizerCalls += 1;
        return sanitizer.sanitize(request);
      },
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_CHANGED' });
    expect(sanitizerCalls).toBe(0);
  });

  it('quarantines archived lineage when iteration close metadata diverges', async () => {
    const item = await fixture();
    const iterationPath = join(
      item.artifactRoot,
      'iterations',
      'v1-execution',
      'iteration.json',
    );
    const iteration = JSON.parse(await readFile(iterationPath, 'utf8')) as Record<string, unknown>;
    const close = iteration.close as Record<string, unknown>;
    close.closed_at = '2026-08-20T01:05:00.000Z';
    await writeFile(iterationPath, json(iteration), 'utf8');

    const plan = await createP2aExecutionKnowledgeProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.counts).toEqual({ exclude: 0, include: 0, quarantine: 2 });
    expect(plan.entries.every((entry) => entry.reasonCode === 'lineage_missing')).toBe(true);
  });

  it('preserves a task-graph ambiguity reason in the projection report', async () => {
    const item = await fixture('https://example.test/alpha.git', true);
    const plan = await createP2aExecutionKnowledgeProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.counts).toEqual({ exclude: 0, include: 0, quarantine: 2 });
    expect(plan.entries.every((entry) => entry.reasonCode === 'lineage_mismatch')).toBe(true);
  });

  it('quarantines a derived source URI that cannot fit the SourceDocument contract', async () => {
    const item = await fixture('가'.repeat(1_000));
    const plan = await createP2aExecutionKnowledgeProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.counts).toEqual({ exclude: 0, include: 0, quarantine: 1 });
    expect(plan.entries).toContainEqual(expect.objectContaining({
      decision: 'quarantine',
      reasonCode: 'path_unsafe',
    }));
  });

  it('detects artifact drift before sanitization or persistence', async () => {
    const item = await fixture();
    const projector = createP2aExecutionKnowledgeProjector();
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    const failed = await readFile(item.failedRunPath, 'utf8');
    await writeFile(item.failedRunPath, failed.replace(
      'Execute the codec fixture.',
      'Execute the changed codec fixture.',
    ), 'utf8');
    let sanitizerCalls = 0;
    await expect(projector.apply(plan, {
      sanitize(request) {
        sanitizerCalls += 1;
        return sanitizer.sanitize(request);
      },
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_CHANGED' });
    expect(sanitizerCalls).toBe(0);
    expect(await readdir(item.sources)).toEqual([]);
  });

  it('maps a deleted bound artifact to drift before sanitization', async () => {
    const item = await fixture();
    const projector = createP2aExecutionKnowledgeProjector();
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    await rm(item.failedRunPath);
    let sanitizerCalls = 0;
    await expect(projector.apply(plan, {
      sanitize(request) {
        sanitizerCalls += 1;
        return sanitizer.sanitize(request);
      },
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_CHANGED' });
    expect(sanitizerCalls).toBe(0);
  });

  it('detects project descriptor and sources-directory replacement before sanitization', async () => {
    const descriptorFixture = await fixture();
    const descriptorProjector = createP2aExecutionKnowledgeProjector();
    const descriptorPlan = await descriptorProjector.plan({
      artifactRoot: descriptorFixture.artifactRoot,
      knowledgeRoot: descriptorFixture.knowledgeRoot,
      projectId: 'alpha',
    });
    await writeFile(
      join(descriptorFixture.knowledgeRoot, 'projects', 'alpha', 'project.json'),
      json({ schemaVersion: 'invalid' }),
      'utf8',
    );
    let sanitizerCalls = 0;
    await expect(descriptorProjector.apply(descriptorPlan, {
      sanitize(request) {
        sanitizerCalls += 1;
        return sanitizer.sanitize(request);
      },
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_CHANGED' });

    const sourcesFixture = await fixture();
    const sourcesProjector = createP2aExecutionKnowledgeProjector();
    const sourcesPlan = await sourcesProjector.plan({
      artifactRoot: sourcesFixture.artifactRoot,
      knowledgeRoot: sourcesFixture.knowledgeRoot,
      projectId: 'alpha',
    });
    await rm(sourcesFixture.sources, { recursive: true });
    await mkdir(sourcesFixture.sources);
    await expect(sourcesProjector.apply(sourcesPlan, {
      sanitize(request) {
        sanitizerCalls += 1;
        return sanitizer.sanitize(request);
      },
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_CHANGED' });
    expect(sanitizerCalls).toBe(0);
  });

  it('rejects an inconsistent injected selection before opening a writer', async () => {
    const item = await fixture();
    const lineage = {
      graphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      graphRevision: `sha256:${'a'.repeat(64)}` as const,
      graphVersion: 'v1',
      iterationId: 'v1',
      sourceSpecRef: 'iterations/v1/gate-b-spec/spec.json',
      sourceSpecRevision: `sha256:${'c'.repeat(64)}` as const,
      taskContractSha256: 'b'.repeat(64),
      taskId: 'task-001',
      taskTitle: 'Task',
    };
    const sourceUri = 'buildlore+p2a:/alpha/v1/task-001';
    const source = attempt({ changedFiles: ['src/index.ts'] });
    const candidate: ExecutionCandidate = {
      attempts: [source],
      body: 'safe body',
      ingestedAt: '2026-08-20T01:01:00.000Z',
      lineage,
      reasonCode: 'significant_change',
      sourceRevision: `sha256:${'d'.repeat(64)}`,
      sourceUri,
      target: `execution--${digest(sourceUri)}.md`,
      taskStableId: digest(sourceUri),
      title: 'Task execution knowledge',
    };
    const selection: P2aExecutionSelection = {
      artifactRoot: item.artifactRoot,
      bindings: [],
      candidates: [candidate],
      entries: [{
        attempts: [{
          runId: source.runId,
          runRef: source.runRef,
          runRevision: source.runRevision,
          status: source.status,
        }],
        decision: 'include',
        lineage,
        reasonCode: candidate.reasonCode,
        sourceRevision: candidate.sourceRevision,
        sourceUri,
        target: `execution--${'0'.repeat(64)}.md`,
        taskStableId: candidate.taskStableId,
      }],
    };
    let writerFactoryCalls = 0;
    const projector = createP2aExecutionKnowledgeProjector({
      artifactReader: {
        read() {
          return Promise.resolve(selection);
        },
        verify() {
          return Promise.resolve();
        },
      },
      sourceWriter: {
        create() {
          writerFactoryCalls += 1;
          throw new Error('writer must not open');
        },
      },
    });
    await expect(projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
    expect(writerFactoryCalls).toBe(0);
  });

  it('collects every sanitizer approval before the first write', async () => {
    const item = await fixture();
    const lineage = {
      graphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      graphRevision: `sha256:${'a'.repeat(64)}` as const,
      graphVersion: 'v1',
      iterationId: 'v1',
      sourceSpecRef: 'iterations/v1/gate-b-spec/spec.json',
      sourceSpecRevision: `sha256:${'c'.repeat(64)}` as const,
      taskContractSha256: 'b'.repeat(64),
      taskId: 'task-001',
      taskTitle: 'Task',
    };
    const candidate = (suffix: string): ExecutionCandidate => ({
      attempts: [attempt({
        changedFiles: [`src/${suffix}.ts`],
        runId: `run-${suffix}`,
        runRef: `v1/run-${suffix}.json`,
      })],
      body: `body ${suffix}`,
      ingestedAt: '2026-08-20T01:01:00.000Z',
      lineage,
      reasonCode: 'significant_change',
      sourceRevision: `sha256:${suffix.padEnd(64, 'a')}`,
      sourceUri: `buildlore+p2a:/alpha/v1/${suffix}`,
      target: `execution--${digest(`buildlore+p2a:/alpha/v1/${suffix}`)}.md`,
      taskStableId: digest(`buildlore+p2a:/alpha/v1/${suffix}`),
      title: `Task ${suffix}`,
    });
    const candidates = [candidate('c'), candidate('d')];
    const selection: P2aExecutionSelection = {
      artifactRoot: item.artifactRoot,
      bindings: [],
      candidates,
      entries: candidates.map((source) => ({
        attempts: source.attempts.map((item) => ({
          runId: item.runId,
          runRef: item.runRef,
          runRevision: item.runRevision,
          status: item.status,
        })),
        decision: 'include',
        lineage,
        reasonCode: 'significant_change',
        sourceRevision: source.sourceRevision,
        sourceUri: source.sourceUri,
        target: source.target,
        taskStableId: source.taskStableId,
      })),
    };
    let writes = 0;
    const writer: ProjectSourceWriter = {
      assertUnchanged() {
        return Promise.resolve();
      },
      inspect() {
        return Promise.resolve({ contentDigest: null, writeStatus: 'create' });
      },
      write() {
        writes += 1;
        return Promise.resolve('create');
      },
    };
    const projector = createP2aExecutionKnowledgeProjector({
      artifactReader: {
        read() {
          return Promise.resolve(selection);
        },
        verify() {
          return Promise.resolve();
        },
      },
      sourceWriter: {
        create() {
          return Promise.resolve(writer);
        },
      },
    });
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    let approvals = 0;
    await expect(projector.apply(plan, {
      sanitize(request) {
        approvals += 1;
        return approvals === 1
          ? sanitizer.sanitize(request)
          : Promise.resolve({ code: 'secret-suspected' as const, ok: false as const });
      },
    })).rejects.toMatchObject({ code: 'PROJECTION_SANITIZATION_FAILED' });
    expect(approvals).toBe(2);
    expect(writes).toBe(0);
  });
});
