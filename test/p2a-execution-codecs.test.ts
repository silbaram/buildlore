import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decodeP2aCurrentDevelopmentContract,
  decodeP2aRun,
  decodeP2aRunIndex,
  decodeP2aTaskGraph,
  resolveTaskLineage,
  taskContractSha256,
} from '../src/projector/p2a-execution-codecs.js';

function currentDevelopmentContract(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    acceptance: [],
    architecture: [],
    authority: {
      externalWrites: false,
      mayChoose: [],
      mustReturnToGate: [],
      workspace: 'project_root',
    },
    bindings: {
      activeSpec: { ref: 'iterations/v1/gate-b-spec/spec.json', sha256: 'a'.repeat(64) },
      constitution: { ref: '.plan2agent/constitution.json', sha256: 'b'.repeat(64) },
      taskGraph: {
        ref: 'iterations/v1/gate-c-task-graph/task-graph.json',
        tasks: [{ sha256: 'c'.repeat(64), taskId: 'task-001' }],
      },
    },
    iterationConstraints: { architecture: [], dependencies: [], interfaces: [] },
    iterationId: 'v1',
    mustPreserve: [],
    nonGoals: [],
    objective: 'Keep the current development contract bounded.',
    prohibitions: [],
    projectId: 'buildlore',
    schema_version: 'p2a.current_development_contract.v1',
    scope: [],
    stack: [],
    style: {},
    technologyEvidence: [],
    verification: [],
    ...overrides,
  };
}

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
    taskGraphRef: 'iterations/v5-execution-knowledge-projector/gate-c-task-graph/task-graph.json',
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
      taskGraphRef: 'iterations/v5-execution-knowledge-projector/gate-c-task-graph/task-graph.json',
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
  it('accepts only an exact project-bound current development contract', () => {
    expect(decodeP2aCurrentDevelopmentContract(
      currentDevelopmentContract(),
      'buildlore',
    )).toMatchObject({ ok: true });
    expect(decodeP2aCurrentDevelopmentContract(
      currentDevelopmentContract({ projectId: 'other' }),
      'buildlore',
    )).toMatchObject({ ok: false, reasonCode: 'unsupported_schema' });
    expect(decodeP2aCurrentDevelopmentContract({
      ...currentDevelopmentContract(),
      unexpected: true,
    }, 'buildlore')).toMatchObject({ ok: false, reasonCode: 'unsupported_schema' });
    expect(decodeP2aCurrentDevelopmentContract({
      ...currentDevelopmentContract(),
      bindings: {
        ...(currentDevelopmentContract().bindings as Record<string, unknown>),
        activeSpec: { ref: '../escape.json', sha256: 'a'.repeat(64), unexpected: true },
      },
    }, 'buildlore')).toMatchObject({ ok: false, reasonCode: 'unsupported_schema' });
  });

  it('matches the Plan2Agent immutable task-contract algorithm', () => {
    expect(taskContractSha256(TASK)).toBe(TASK_CONTRACT);
    expect(taskContractSha256({ ...TASK, status: 'todo' })).toBe(TASK_CONTRACT);
    expect(taskContractSha256({ ...TASK, status: 'blocked', blockReason: 'other' }))
      .toBe(TASK_CONTRACT);
    expect(taskContractSha256({ ...TASK, intent: 'Mutable execution intent.' }))
      .toBe(TASK_CONTRACT);
  });

  it('decodes p2a.run.v2 into a bounded model without raw trace output', () => {
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
      workspaceRef: '/private/workspace',
    });
    expect(JSON.stringify(result.value)).not.toContain('RAW-STD');
    expect(result.value).not.toHaveProperty('workspacePath');
    expect(JSON.stringify(result.value)).not.toContain('reproduction-script');
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
    expect(decodeP2aRun(run({ sourceLayout: 'server' }), 'buildlore'))
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

  it('decodes the current maintenance layout without an execution envelope', () => {
    const maintenance = run({
      executionEnvelope: undefined,
      executionEnvelopeSha256: undefined,
      iterationId: 'maintenance',
      sourceLayout: 'maintenance',
      sourceSpecRef: '../../../current-spec.json',
      taskGraphRef: 'iterations/maintenance/gate-c-task-graph/task-graph.json',
    });
    delete maintenance.executionEnvelope;
    delete maintenance.executionEnvelopeSha256;
    const decoded = decodeP2aRun(maintenance, 'buildlore');
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('maintenance run should decode');
    expect(decoded.value.sourceLayout).toBe('maintenance');
  });

  it('rejects unknown run kinds and ambiguous embedded/reference envelopes', () => {
    expect(decodeP2aRun(run({ runKind: 'final_unknown' }), 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'unsupported_schema' });
    expect(decodeP2aRun(run({
      executionEnvelopeRef: { sha256: run().executionEnvelopeSha256 },
    }), 'buildlore')).toEqual({ ok: false, reasonCode: 'unsupported_schema' });
  });

  it('binds passed final verification evidence to the declared revisions', () => {
    const value = run({
      productRevisionSha256: 'b'.repeat(64),
      runKind: 'final_verification',
      verificationScope: 'full',
      workspaceRevisionSha256: 'd'.repeat(64),
    });
    value.verification = (value.verification as Array<Record<string, unknown>>).map((entry) => ({
      ...entry,
      productRevisionSha256: 'c'.repeat(64),
      workspaceRevisionSha256: 'd'.repeat(64),
    }));
    expect(decodeP2aRun(value, 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'lineage_mismatch' });
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

  it('retains a task grouping only when it accounts for every indexed run', () => {
    const result = decodeP2aRunIndex(runIndex(), 'buildlore');
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) throw new Error('index should decode');
    expect(result.value.runs).toHaveLength(1);
    expect(result.value.tasks).toEqual([{
      latestRunId: 'run-2026-08-20T01-00-00-000Z-task-001',
      runIds: ['run-2026-08-20T01-00-00-000Z-task-001'],
      taskId: 'task-001',
    }]);
  });

  it('accepts current retrospective counters and known run kinds in the run index', () => {
    const value = runIndex({
      retrospective: {
        iterations: [{
          interruptionCounts: {
            gate_return_invalid: 0,
            gate_return_valid: 0,
            implementation_decision: 0,
            user_correction: 1,
          },
          iterationId: 'maintenance',
          reasonCounts: { completed_maintenance: 1, superseded: 0 },
          runCount: 1,
          scope: 'pruned_run_history',
          statusCounts: { blocked: 0, failed: 0, finished: 1 },
          verificationCount: 4,
          verificationDuration: { maxMs: 10, sampleCount: 4, totalMs: 20 },
          verificationStatusCounts: {
            failed: 0, not_run: 0, passed: 4, skipped: 0, unavailable: 0,
          },
        }],
      },
    });
    const entries = value.runs as Array<Record<string, unknown>>;
    entries[0] = { ...entries[0], runKind: 'final_verification' };
    expect(decodeP2aRunIndex(value, 'buildlore')).toEqual(expect.objectContaining({ ok: true }));
    entries[0] = { ...entries[0], runKind: 'final_unknown' };
    expect(decodeP2aRunIndex(value, 'buildlore'))
      .toEqual({ ok: false, reasonCode: 'run_reference_invalid' });
  });

  it('rejects task groupings that reference an unindexed or mismatched run', () => {
    expect(decodeP2aRunIndex(runIndex({
      tasks: [{
        latestRunId: 'run-2026-08-20T01-00-00-000Z-task-001',
        runIds: [
          'run-2026-08-18T00-00-00-000Z-task-001',
          'run-2026-08-20T01-00-00-000Z-task-001',
        ],
        taskId: 'task-001',
      }],
    }), 'buildlore')).toEqual({ ok: false, reasonCode: 'run_reference_invalid' });
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
