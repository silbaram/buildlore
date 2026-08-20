import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decodeP2aRun,
  decodeP2aRunIndex,
  decodeP2aTaskGraph,
  resolveTaskLineage,
  taskContractSha256,
} from '../src/projector/p2a-execution-codecs.js';

const TASK = {
  acceptanceCriteria: ['Projects retries safely.'],
  dependencies: [],
  description: 'Project verified runs.',
  id: 'task-001',
  sourceSpecRefs: ['product.goals'],
  status: 'done',
  suggestedAgentPrompt: 'Implement the projector.',
  targetArea: 'projector',
  title: 'Execution projection',
  workKind: 'non_ui',
} as const;

const TASK_CONTRACT = 'bfa1620ef5bee70df9da6ac375fcfb31484c3bf03cc4d42752a7db130568a3e7';

function run(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const executionEnvelope = {
    acceptance: ['Execution source is deterministic.'],
    executionAuthority: {
      mayChoose: ['internal structure'],
      mustReturnToGate: ['scope change'],
    },
    mustPreserve: ['project isolation'],
    nonGoals: ['raw trace persistence'],
    objective: 'Project execution knowledge.',
    scope: ['p2a.run.v2'],
    sourceGateRefs: [{
      path: '../gate-b-spec/spec.json',
      sha256: 'a'.repeat(64),
    }],
    verification: ['npm test'],
  };
  return {
    agentTool: 'codex',
    changedFiles: ['src/projector/execution-types.ts'],
    executionEnvelope,
    executionEnvelopeSha256: createHash('sha256')
      .update(JSON.stringify(executionEnvelope))
      .digest('hex'),
    finishedAt: '2026-08-20T01:01:00.000Z',
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
    iterationId: 'v5-execution-knowledge-projector',
    notes: [],
    projectId: 'buildlore',
    runId: 'run-2026-08-20T01-00-00-000Z-task-001',
    schema_version: 'p2a.run.v2',
    sourceLayout: 'iteration',
    sourceSpecRef: '../gate-b-spec/spec.json',
    startedAt: '2026-08-20T01:00:00.000Z',
    status: 'finished',
    taskContractSha256: TASK_CONTRACT,
    taskGraphRef: '/private/stale/task-graph.json',
    taskId: 'task-001',
    taskTitle: 'Untrusted run title',
    updatedAt: '2026-08-20T01:01:00.000Z',
    verification: [{
      command: 'npm test',
      durationMs: 1_000,
      exitCode: 0,
      finishedAt: '2026-08-20T01:00:40.000Z',
      source: 'command',
      startedAt: '2026-08-20T01:00:39.000Z',
      status: 'passed',
      stderrTail: 'RAW-STDERR-MUST-NOT-SURVIVE',
      stdoutTail: 'RAW-STDOUT-MUST-NOT-SURVIVE',
      type: 'test',
    }],
    workspacePath: '/private/workspace',
    workspaceRef: '/private/workspace',
    ...overrides,
  };
}

function runIndex(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    projectId: 'buildlore',
    runs: [{
      agentTool: 'codex',
      finishedAt: '2026-08-20T01:01:00.000Z',
      iterationId: 'v5-execution-knowledge-projector',
      runId: 'run-2026-08-20T01-00-00-000Z-task-001',
      runRef: 'v5-execution-knowledge-projector/run-2026-08-20T01-00-00-000Z-task-001.json',
      startedAt: '2026-08-20T01:00:00.000Z',
      status: 'finished',
      taskGraphRef: '/private/stale/task-graph.json',
      taskId: 'task-001',
      workspaceRef: '/private/workspace',
    }],
    schema_version: 'p2a.run_index.v1',
    tasks: [{
      latestRunId: 'run-2026-08-20T01-00-00-000Z-task-001',
      runIds: ['run-2026-08-20T01-00-00-000Z-task-001'],
      taskId: 'task-001',
    }],
    ...overrides,
  };
}

describe('P2A execution codecs', () => {
  it('matches the Plan2Agent immutable task-contract algorithm', () => {
    expect(taskContractSha256(TASK)).toBe(TASK_CONTRACT);
    expect(taskContractSha256({ ...TASK, status: 'todo' })).toBe(TASK_CONTRACT);
    expect(taskContractSha256({ ...TASK, status: 'blocked', blockReason: 'other' }))
      .toBe(TASK_CONTRACT);
  });

  it('decodes p2a.run.v2 into a bounded safe model without raw trace paths', () => {
    const result = decodeP2aRun(run({
      changedFiles: ['src/projector/execution-types.ts', '문서/실행-기록.md'],
      reproduction: {
        commands: ['node /private/reproduction-script.mjs'],
        notes: [],
        steps: ['Run the safe fixture.'],
      },
    }), 'buildlore');
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) throw new Error('run should decode');
    expect(result.value).toMatchObject({
      projectId: 'buildlore',
      changedFiles: ['src/projector/execution-types.ts', '문서/실행-기록.md'],
      sourceLayout: 'iteration',
      taskContractSha256: TASK_CONTRACT,
      taskId: 'task-001',
      verification: [expect.objectContaining({ command: 'npm test', status: 'passed' })],
    });
    expect(JSON.stringify(result.value)).not.toContain('RAW-STD');
    expect(JSON.stringify(result.value)).not.toContain('/private/');
  });

  it.each([
    ['p2a.run.v1', 'unsupported_schema'],
    ['p2a.run.v3', 'unsupported_schema'],
  ] as const)('quarantines unsupported schema %s', (schema, reasonCode) => {
    expect(decodeP2aRun(run({ schema_version: schema }), 'buildlore')).toEqual({
      ok: false,
      reasonCode,
    });
  });

  it('quarantines unsupported layouts, invalid timestamps and project mismatches', () => {
    expect(decodeP2aRun(run({ sourceLayout: 'maintenance' }), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'unsupported_layout' });
    expect(decodeP2aRun(run({ status: 'done' }), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'malformed_status' });
    expect(decodeP2aRun(run({ finishedAt: 'not-a-time' }), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'timestamp_invalid' });
    expect(decodeP2aRun(run({ updatedAt: '2026-08-20T01:00:30.000Z' }), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'timestamp_invalid' });
    const outsideRun = run();
    const outsideVerification = outsideRun.verification as Array<Record<string, unknown>>;
    outsideVerification[0] = {
      ...outsideVerification[0],
      finishedAt: '2026-08-20T01:01:01.000Z',
    };
    expect(decodeP2aRun(outsideRun, 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'timestamp_invalid' });
    expect(decodeP2aRun(run({ projectId: 'other' }), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'project_mismatch' });
    expect(decodeP2aRun(run({ sourceSpecRef: '../gate-b-spec/spec.json\nprivate' }), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'path_unsafe' });
  });

  it('quarantines unsafe structured evidence paths', () => {
    expect(decodeP2aRun(run({
      localization: { files: ['/private/source.ts'], findings: ['Unsafe path evidence.'] },
    }), 'buildlore')).toEqual({ ok: false, reasonCode: 'path_unsafe' });
  });

  it('quarantines unsafe control characters and invalid Unicode in rendered evidence', () => {
    expect(decodeP2aRun(run({
      guard: { checks: ['unsafe\u0085evidence'], notes: [] },
    }), 'buildlore')).toEqual({ ok: false, reasonCode: 'unsupported_schema' });
    expect(decodeP2aRun(run({
      guard: { checks: ['invalid\ud800unicode'], notes: [] },
    }), 'buildlore')).toEqual({ ok: false, reasonCode: 'unsupported_schema' });
  });

  it('accepts a blocked run only with its structured failure evidence', () => {
    const blocked = decodeP2aRun(run({
      failure: {
        class: 'implementation_incomplete',
        needsUserDecision: false,
        retryable: 'after_fix',
        source: 'owner',
      },
      guard: { checks: ['Verify the correction.'], notes: [] },
      localization: { files: ['src/projector/index.ts'], findings: ['Work is incomplete.'] },
      reproduction: { commands: ['npm test'], notes: [], steps: ['Run the suite.'] },
      status: 'blocked',
    }), 'buildlore');
    expect(blocked).toEqual(expect.objectContaining({ ok: true }));
    if (!blocked.ok) throw new Error('blocked run should decode');
    expect(blocked.value).toMatchObject({
      failureClass: 'implementation_incomplete',
      status: 'blocked',
    });
  });

  it('uses index runs only and ignores cross-iteration task grouping semantics', () => {
    const index = runIndex({
      tasks: [{
        latestRunId: 'run-2026-08-20T01-00-00-000Z-task-001',
        runIds: [
          'run-2026-08-18T00-00-00-000Z-task-001',
          'run-2026-08-20T01-00-00-000Z-task-001',
        ],
        taskId: 'task-001',
      }],
    });
    const result = decodeP2aRunIndex(index, 'buildlore');
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) throw new Error('index should decode');
    expect(result.value.runs).toHaveLength(1);
    expect(result.value).not.toHaveProperty('tasks');
  });

  it('rejects unsafe or duplicate run references', () => {
    const unsafe = runIndex();
    const unsafeRuns = unsafe.runs as Array<Record<string, unknown>>;
    unsafeRuns[0] = { ...unsafeRuns[0], runRef: '../outside.json' };
    expect(decodeP2aRunIndex(unsafe, 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'run_reference_invalid' });

    const duplicate = runIndex();
    const duplicateRuns = duplicate.runs as Array<Record<string, unknown>>;
    duplicate.runs = [duplicateRuns[0], duplicateRuns[0]];
    expect(decodeP2aRunIndex(duplicate, 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'run_reference_invalid' });
  });

  it('resolves lineage only through the canonical graph task contract', () => {
    const decodedRun = decodeP2aRun(run(), 'buildlore');
    if (!decodedRun.ok) throw new Error('run should decode');
    const graph = decodeP2aTaskGraph({
      projectId: 'buildlore',
      schema_version: 'p2a.task_graph.v1',
      sourceSpec: '../gate-b-spec/spec.json',
      tasks: [TASK],
      version: 'v5-execution-knowledge-projector',
    }, 'buildlore');
    if (!graph.ok) throw new Error('graph should decode');
    expect(resolveTaskLineage(
      graph.value,
      'iterations/v5-execution-knowledge-projector/gate-c-task-graph/task-graph.json',
      `sha256:${'a'.repeat(64)}`,
      'iterations/v5-execution-knowledge-projector/gate-b-spec/spec.json',
      `sha256:${'c'.repeat(64)}`,
      decodedRun.value,
    )).toEqual({
      ok: true,
      value: {
        graphRef: 'iterations/v5-execution-knowledge-projector/gate-c-task-graph/task-graph.json',
        graphRevision: `sha256:${'a'.repeat(64)}`,
        graphVersion: 'v5-execution-knowledge-projector',
        iterationId: 'v5-execution-knowledge-projector',
        sourceSpecRef: 'iterations/v5-execution-knowledge-projector/gate-b-spec/spec.json',
        sourceSpecRevision: `sha256:${'c'.repeat(64)}`,
        taskContractSha256: TASK_CONTRACT,
        taskId: 'task-001',
        taskTitle: 'Execution projection',
      },
    });
    const changedRun = decodeP2aRun(run({ taskContractSha256: 'f'.repeat(64) }), 'buildlore');
    if (!changedRun.ok) throw new Error('changed run should decode');
    expect(resolveTaskLineage(
      graph.value,
      'iterations/v5-execution-knowledge-projector/gate-c-task-graph/task-graph.json',
      `sha256:${'a'.repeat(64)}`,
      'iterations/v5-execution-knowledge-projector/gate-b-spec/spec.json',
      `sha256:${'c'.repeat(64)}`,
      changedRun.value,
    )).toEqual({ ok: false, reasonCode: 'lineage_mismatch' });
  });

  it('rejects ambiguous task IDs and titles that cannot form SourceDocument metadata', () => {
    const graph = (tasks: readonly Record<string, unknown>[]): Record<string, unknown> => ({
      projectId: 'buildlore',
      schema_version: 'p2a.task_graph.v1',
      sourceSpec: '../gate-b-spec/spec.json',
      tasks,
      version: 'v5-execution-knowledge-projector',
    });
    expect(decodeP2aTaskGraph(graph([TASK, { ...TASK }]), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'lineage_mismatch' });
    expect(decodeP2aTaskGraph(graph([{ ...TASK, title: 'line one\nline two' }]), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'lineage_missing' });
    expect(decodeP2aTaskGraph(graph([{ ...TASK, title: 't'.repeat(481) }]), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'lineage_missing' });
    expect(decodeP2aTaskGraph({
      ...graph([TASK]),
      sourceSpec: '../gate-b-spec/spec.json\nprivate',
    }, 'buildlore')).toEqual({ ok: false, reasonCode: 'lineage_missing' });
  });
});
