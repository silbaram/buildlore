import { createHash } from 'node:crypto';

import type {
  CanonicalTaskLineage,
  ExecutionQuarantineReason,
  ExecutionRunStatus,
  ExecutionVerificationSummary,
  ObservedP2aRun,
  P2aRunIndex,
  P2aRunIndexEntry,
} from './execution-types.js';
import { normalizeRfc3339Instant } from './timestamp.js';

const MAX_INDEX_RUNS = 10_000;
const MAX_TASKS = 10_000;
const MAX_CHANGED_FILES = 512;
const MAX_VERIFICATION = 256;
const MAX_TEXT_ITEMS = 128;
const MAX_PATH_LENGTH = 1_024;
const MAX_COMMAND_LENGTH = 2_048;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_TASK_TITLE_LENGTH = 480;
const MAX_TRACE_TAIL_LENGTH = 16 * 1_024;
const RUN_ID_PATTERN = /^run-[A-Za-z0-9._-]+$/u;
const TASK_ID_PATTERN = /^task-[0-9]+$/u;
const ITERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const RUN_FIELDS = new Set([
  'acceptanceReview', 'acceptanceReviewEvidenceSha256', 'agentTool', 'changedFiles',
  'executionEnvelope', 'executionEnvelopeSha256', 'failure', 'finishedAt', 'fixSummary',
  'guard', 'interruptions', 'isolation', 'iterationId', 'localization', 'milestones',
  'mode', 'monitorGate', 'monitorVerdictEvidenceSha256', 'notes', 'projectId',
  'reproduction', 'runId', 'runKind', 'schema_version', 'selectionRationale',
  'sourceLayout', 'sourceSpecRef', 'startedAt', 'status', 'taskContractSha256',
  'taskGraphRef', 'taskId', 'taskTitle', 'telemetryProtocol', 'updatedAt', 'usage',
  'verification', 'visualFeedback', 'visualReview', 'visualReviewEvidenceSha256',
  'workspacePath', 'workspaceRef', 'workspaceRevisionSha256',
]);

const RUN_REQUIRED_FIELDS = [
  'agentTool', 'changedFiles', 'executionEnvelope', 'executionEnvelopeSha256', 'finishedAt',
  'isolation', 'iterationId', 'notes', 'projectId', 'runId', 'schema_version',
  'sourceLayout', 'sourceSpecRef', 'startedAt', 'status', 'taskContractSha256',
  'taskGraphRef', 'taskId', 'taskTitle', 'updatedAt', 'verification', 'workspacePath',
  'workspaceRef',
] as const;

const INDEX_ENTRY_FIELDS = new Set([
  'agentTool', 'finishedAt', 'iterationId', 'runId', 'runRef', 'startedAt', 'status',
  'taskGraphRef', 'taskId', 'workspaceRef',
]);
const INDEX_TASK_FIELDS = new Set(['latestRunId', 'runIds', 'taskId']);
const VERIFICATION_FIELDS = new Set([
  'command', 'durationMs', 'exitCode', 'failureHint', 'failureReason', 'finishedAt',
  'milestoneId', 'normalizedCommand', 'originalCommand', 'source', 'startedAt', 'status',
  'stderrTail', 'stdoutTail', 'type',
]);
const VERIFICATION_REQUIRED_FIELDS = [
  'command', 'durationMs', 'exitCode', 'finishedAt', 'source', 'startedAt', 'status',
  'stderrTail', 'stdoutTail', 'type',
] as const;

export type DecodeResult<T> =
  | Readonly<{ ok: false; reasonCode: ExecutionQuarantineReason }>
  | Readonly<{ ok: true; value: T }>;

interface DecodedTaskGraph {
  readonly projectId: string;
  readonly sourceSpec: string;
  readonly tasks: readonly Record<string, unknown>[];
  readonly version: string;
}

function invalid<T>(reasonCode: ExecutionQuarantineReason): DecodeResult<T> {
  return { ok: false, reasonCode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isP2aExecutionRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasRequiredKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function boundedString(value: unknown, maximum = MAX_SUMMARY_LENGTH): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 8 || code === 11 || code === 12 ||
      (code >= 14 && code <= 31) || (code >= 127 && code <= 159)
    ) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function optionalBoundedString(value: unknown, maximum = MAX_SUMMARY_LENGTH): boolean {
  return value === undefined || value === null || value === '' || boundedString(value, maximum);
}

function boundedSingleLineString(value: unknown, maximum: number): value is string {
  return boundedString(value, maximum) && ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function validStatus(value: unknown): value is ExecutionRunStatus {
  return value === 'blocked' || value === 'failed' || value === 'finished' || value === 'started';
}

function normalizedInstant(value: unknown): string | null {
  return normalizeRfc3339Instant(value);
}

function validPortablePath(value: unknown): value is string {
  return boundedSingleLineString(value, MAX_PATH_LENGTH) && !value.includes('\\') &&
    !value.startsWith('/') && !/^[A-Za-z]:\//u.test(value) &&
    !value.split('/').some((segment) => segment === '.' || segment === '..');
}

function validRelativeReference(value: unknown): value is string {
  return boundedSingleLineString(value, MAX_PATH_LENGTH) && !value.includes('\\') &&
    !value.startsWith('/') && !/^[A-Za-z]:\//u.test(value);
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const result: string[] = [];
  for (const item of value) {
    if (!boundedString(item, maximumLength)) return null;
    result.push(item);
  }
  return result;
}

function strictObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, allowed) && hasRequiredKeys(value, required);
}

function decodeVerification(value: unknown): readonly ExecutionVerificationSummary[] | null {
  if (!Array.isArray(value) || value.length > MAX_VERIFICATION) return null;
  const result: ExecutionVerificationSummary[] = [];
  for (const item of value) {
    if (!strictObject(item, VERIFICATION_FIELDS, VERIFICATION_REQUIRED_FIELDS)) return null;
    const startedAt = item.startedAt === null ? null : normalizedInstant(item.startedAt);
    const finishedAt = item.finishedAt === null ? null : normalizedInstant(item.finishedAt);
    if (
      !boundedString(item.command, MAX_COMMAND_LENGTH) ||
      !['custom', 'lint', 'test', 'typecheck'].includes(String(item.type)) ||
      !['failed', 'not_run', 'passed', 'skipped', 'unavailable'].includes(String(item.status)) ||
      !['command', 'config', 'manual'].includes(String(item.source)) ||
      (item.exitCode !== null && !Number.isInteger(item.exitCode)) ||
      (item.durationMs !== null && (!Number.isInteger(item.durationMs) || Number(item.durationMs) < 0)) ||
      (item.startedAt !== null && startedAt === null) ||
      (item.finishedAt !== null && finishedAt === null) ||
      (startedAt !== null && finishedAt !== null &&
        Date.parse(finishedAt) < Date.parse(startedAt)) ||
      !optionalBoundedString(item.stdoutTail, MAX_TRACE_TAIL_LENGTH) ||
      !optionalBoundedString(item.stderrTail, MAX_TRACE_TAIL_LENGTH) ||
      !optionalBoundedString(item.failureReason, MAX_SUMMARY_LENGTH) ||
      !optionalBoundedString(item.failureHint, MAX_SUMMARY_LENGTH) ||
      !optionalBoundedString(item.originalCommand, MAX_COMMAND_LENGTH) ||
      !optionalBoundedString(item.normalizedCommand, MAX_COMMAND_LENGTH) ||
      !optionalBoundedString(item.milestoneId, 256)
    ) return null;
    if (
      (item.status === 'passed' && item.exitCode !== 0) ||
      (item.status === 'failed' && (item.exitCode === null || item.exitCode === 0))
    ) return null;
    result.push({
      command: item.command,
      exitCode: item.exitCode as number | null,
      finishedAt,
      source: item.source as ExecutionVerificationSummary['source'],
      startedAt,
      status: item.status as ExecutionVerificationSummary['status'],
      type: item.type as ExecutionVerificationSummary['type'],
    });
  }
  return result;
}

function decodeEvidenceObject(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, readonly string[]>> | null {
  if (value === undefined) return {};
  const allowed = new Set(fields);
  if (!strictObject(value, allowed, fields)) return null;
  const result: Record<string, readonly string[]> = {};
  for (const field of fields) {
    const items = stringArray(value[field], MAX_TEXT_ITEMS, MAX_SUMMARY_LENGTH);
    if (items === null) return null;
    result[field] = items;
  }
  return result;
}

function validExecutionEnvelope(value: unknown): value is Record<string, unknown> {
  const fields = new Set([
    'acceptance', 'executionAuthority', 'mustPreserve', 'nonGoals', 'objective', 'scope',
    'sourceGateRefs', 'verification', 'visualContract',
  ]);
  if (!strictObject(value, fields, [
    'acceptance', 'executionAuthority', 'mustPreserve', 'nonGoals', 'objective', 'scope',
    'sourceGateRefs', 'verification',
  ]) || !boundedString(value.objective, 100_000)) return false;
  for (const key of ['acceptance', 'mustPreserve', 'nonGoals', 'scope', 'verification']) {
    if (stringArray(value[key], 1_000, 10_000) === null) return false;
  }
  if (!isRecord(value.executionAuthority) ||
    Object.keys(value.executionAuthority).sort().join(',') !== 'mayChoose,mustReturnToGate' ||
    stringArray(value.executionAuthority.mayChoose, MAX_TEXT_ITEMS, MAX_SUMMARY_LENGTH) === null ||
    stringArray(value.executionAuthority.mustReturnToGate, MAX_TEXT_ITEMS, MAX_SUMMARY_LENGTH) === null) {
    return false;
  }
  if (!Array.isArray(value.sourceGateRefs) || value.sourceGateRefs.length < 1 ||
    value.sourceGateRefs.length > MAX_TEXT_ITEMS) return false;
  return value.sourceGateRefs.every((item) => isRecord(item) &&
    Object.keys(item).sort().join(',') === 'path,sha256' &&
    validRelativeReference(item.path) && typeof item.sha256 === 'string' &&
    SHA256_PATTERN.test(item.sha256));
}

function sourceGateRefs(value: unknown): readonly Readonly<{ path: string; sha256: string }>[] {
  if (!isRecord(value) || !Array.isArray(value.sourceGateRefs)) return [];
  return value.sourceGateRefs.map((item) => {
    const record = item as Readonly<Record<string, unknown>>;
    return { path: String(record.path), sha256: String(record.sha256) };
  });
}

export function decodeP2aRun(
  value: unknown,
  expectedProjectId: string,
): DecodeResult<ObservedP2aRun> {
  if (!strictObject(value, RUN_FIELDS, RUN_REQUIRED_FIELDS)) {
    return invalid('unsupported_schema');
  }
  if (value.schema_version !== 'p2a.run.v2') return invalid('unsupported_schema');
  if (value.projectId !== expectedProjectId) return invalid('project_mismatch');
  if (
    !RUN_ID_PATTERN.test(String(value.runId)) ||
    !TASK_ID_PATTERN.test(String(value.taskId)) ||
    !boundedString(value.taskTitle, MAX_SUMMARY_LENGTH) ||
    typeof value.iterationId !== 'string' || !ITERATION_ID_PATTERN.test(value.iterationId) ||
    typeof value.taskContractSha256 !== 'string' ||
    !SHA256_PATTERN.test(value.taskContractSha256)
  ) return invalid('unsupported_schema');
  if (value.sourceLayout !== 'iteration' && value.sourceLayout !== 'graph') {
    return invalid('unsupported_layout');
  }
  if (!validStatus(value.status)) return invalid('malformed_status');
  const startedAt = normalizedInstant(value.startedAt);
  const updatedAt = normalizedInstant(value.updatedAt);
  const finishedAt = value.finishedAt === null ? null : normalizedInstant(value.finishedAt);
  if (
    startedAt === null || updatedAt === null ||
    (value.finishedAt !== null && finishedAt === null) ||
    (value.status !== 'started' && finishedAt === null) ||
    (value.status === 'started' && finishedAt !== null) ||
    (finishedAt !== null && Date.parse(finishedAt) < Date.parse(startedAt)) ||
    (finishedAt !== null && Date.parse(updatedAt) < Date.parse(finishedAt)) ||
    Date.parse(updatedAt) < Date.parse(startedAt)
  ) return invalid('timestamp_invalid');
  const changedFiles = stringArray(value.changedFiles, MAX_CHANGED_FILES, MAX_PATH_LENGTH);
  if (changedFiles === null || changedFiles.some((path) => !validPortablePath(path))) {
    return invalid('path_unsafe');
  }
  const verification = decodeVerification(value.verification);
  if (verification === null) return invalid('malformed_status');
  if (verification.some((item) =>
    (item.startedAt !== null && Date.parse(item.startedAt) < Date.parse(startedAt)) ||
    (item.finishedAt !== null && Date.parse(item.finishedAt) > Date.parse(updatedAt)))) {
    return invalid('timestamp_invalid');
  }
  if (!validRelativeReference(value.sourceSpecRef)) return invalid('path_unsafe');
  if (!validExecutionEnvelope(value.executionEnvelope) ||
    typeof value.executionEnvelopeSha256 !== 'string' ||
    !SHA256_PATTERN.test(value.executionEnvelopeSha256) ||
    createHash('sha256').update(JSON.stringify(value.executionEnvelope)).digest('hex') !==
      value.executionEnvelopeSha256) return invalid('unsupported_schema');

  const reproduction = decodeEvidenceObject(value.reproduction, ['commands', 'notes', 'steps']);
  const localization = decodeEvidenceObject(value.localization, ['files', 'findings']);
  const fixSummary = decodeEvidenceObject(value.fixSummary, ['files', 'summaries']);
  const guard = decodeEvidenceObject(value.guard, ['checks', 'notes']);
  if (reproduction === null || localization === null || fixSummary === null || guard === null) {
    return invalid('unsupported_schema');
  }
  if (
    (localization.files ?? []).some((path) => !validPortablePath(path)) ||
    (fixSummary.files ?? []).some((path) => !validPortablePath(path))
  ) return invalid('path_unsafe');
  if (value.status === 'failed' || value.status === 'blocked') {
    if (!isRecord(value.failure) || !hasOnlyKeys(value.failure, new Set([
      'class', 'needsUserDecision', 'retryable', 'source',
    ])) || !hasRequiredKeys(value.failure, [
      'class', 'needsUserDecision', 'retryable', 'source',
    ]) || !['environment_failure', 'implementation_incomplete', 'missing_dependency',
      'other', 'scope_violation', 'test_flake', 'verification_failed'].includes(
      String(value.failure.class),
    ) || !['after_fix', 'no', 'yes'].includes(String(value.failure.retryable)) ||
      typeof value.failure.needsUserDecision !== 'boolean' ||
      !['implementer', 'monitor', 'owner'].includes(String(value.failure.source)) ||
      value.reproduction === undefined || value.localization === undefined || value.guard === undefined
    ) return invalid('malformed_status');
  } else if (value.failure !== undefined) {
    return invalid('malformed_status');
  }

  return {
    ok: true,
    value: {
      changedFiles,
      ...(isRecord(value.failure) ? { failureClass: String(value.failure.class) } : {}),
      finishedAt,
      fixSummaries: fixSummary.summaries ?? [],
      guardChecks: guard.checks ?? [],
      guardNotes: guard.notes ?? [],
      iterationId: value.iterationId,
      localizationFiles: localization.files ?? [],
      localizationFindings: localization.findings ?? [],
      projectId: expectedProjectId,
      reproductionSteps: reproduction.steps ?? [],
      runId: String(value.runId),
      sourceGateRefs: sourceGateRefs(value.executionEnvelope),
      sourceLayout: value.sourceLayout,
      sourceSpecRef: value.sourceSpecRef,
      startedAt,
      status: value.status,
      taskContractSha256: value.taskContractSha256,
      taskId: String(value.taskId),
      taskTitle: value.taskTitle,
      updatedAt,
      verification,
    },
  };
}

export function decodeP2aRunIndex(
  value: unknown,
  expectedProjectId: string,
): DecodeResult<P2aRunIndex> {
  if (!strictObject(value, new Set(['projectId', 'runs', 'schema_version', 'tasks']), [
    'projectId', 'runs', 'schema_version', 'tasks',
  ]) || value.schema_version !== 'p2a.run_index.v1') return invalid('unsupported_schema');
  if (value.projectId !== expectedProjectId) return invalid('project_mismatch');
  if (!Array.isArray(value.runs) || value.runs.length > MAX_INDEX_RUNS ||
    !Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) {
    return invalid('run_reference_invalid');
  }
  const seen = new Set<string>();
  const runs: P2aRunIndexEntry[] = [];
  for (const item of value.runs) {
    if (!strictObject(item, INDEX_ENTRY_FIELDS, [...INDEX_ENTRY_FIELDS])) {
      return invalid('run_reference_invalid');
    }
    const startedAt = normalizedInstant(item.startedAt);
    const finishedAt = item.finishedAt === null ? null : normalizedInstant(item.finishedAt);
    if (
      !RUN_ID_PATTERN.test(String(item.runId)) || !TASK_ID_PATTERN.test(String(item.taskId)) ||
      typeof item.iterationId !== 'string' || !ITERATION_ID_PATTERN.test(item.iterationId) ||
      !validStatus(item.status) || startedAt === null ||
      (item.finishedAt !== null && finishedAt === null) ||
      !validPortablePath(item.runRef) || seen.has(String(item.runId))
    ) return invalid('run_reference_invalid');
    const expectedRefs = new Set([
      `${String(item.runId)}.json`,
      `${item.iterationId}/${String(item.runId)}.json`,
    ]);
    if (!expectedRefs.has(item.runRef)) return invalid('run_reference_invalid');
    seen.add(String(item.runId));
    runs.push({
      finishedAt,
      iterationId: item.iterationId,
      runId: String(item.runId),
      runRef: item.runRef,
      startedAt,
      status: item.status,
      taskId: String(item.taskId),
    });
  }
  for (const task of value.tasks) {
    if (!strictObject(task, INDEX_TASK_FIELDS, [...INDEX_TASK_FIELDS]) ||
      !TASK_ID_PATTERN.test(String(task.taskId)) || !Array.isArray(task.runIds) ||
      task.runIds.some((runId) => typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) ||
      (task.latestRunId !== null &&
        (typeof task.latestRunId !== 'string' || !RUN_ID_PATTERN.test(task.latestRunId)))) {
      return invalid('run_reference_invalid');
    }
  }
  return { ok: true, value: { projectId: expectedProjectId, runs } };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function taskContractSha256(task: Readonly<Record<string, unknown>>): string {
  const contract: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(task)) {
    if (key !== 'status' && key !== 'blockReason' && key !== 'blockNote') contract[key] = value;
  }
  return createHash('sha256').update(canonicalJson({
    schema_version: 'p2a.task_contract.v1',
    task: contract,
  })).digest('hex');
}

export function decodeP2aTaskGraph(
  value: unknown,
  expectedProjectId: string,
): DecodeResult<DecodedTaskGraph> {
  if (!strictObject(value, new Set([
    'execution', 'projectId', 'schema_version', 'sourceSpec', 'tasks', 'version',
  ]), ['projectId', 'schema_version', 'sourceSpec', 'tasks', 'version']) ||
    value.schema_version !== 'p2a.task_graph.v1') return invalid('lineage_missing');
  if (value.projectId !== expectedProjectId) return invalid('project_mismatch');
  if (!boundedString(value.version, 256) || !validRelativeReference(value.sourceSpec) ||
    !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > MAX_TASKS ||
    value.tasks.some((task) => !isRecord(task) ||
      !TASK_ID_PATTERN.test(String(task.id)) ||
      !boundedSingleLineString(task.title, MAX_TASK_TITLE_LENGTH))) {
    return invalid('lineage_missing');
  }
  const taskIds = value.tasks.map((task) => String((task as Record<string, unknown>).id));
  if (new Set(taskIds).size !== taskIds.length) return invalid('lineage_mismatch');
  return {
    ok: true,
    value: {
      projectId: expectedProjectId,
      sourceSpec: value.sourceSpec,
      tasks: value.tasks as readonly Record<string, unknown>[],
      version: value.version,
    },
  };
}

export function resolveTaskLineage(
  graph: DecodedTaskGraph,
  graphRef: string,
  graphRevision: `sha256:${string}`,
  sourceSpecRef: string,
  sourceSpecRevision: `sha256:${string}`,
  run: ObservedP2aRun,
): DecodeResult<CanonicalTaskLineage> {
  const task = graph.tasks.find((item) => item.id === run.taskId);
  if (task === undefined) return invalid('lineage_missing');
  const contract = taskContractSha256(task);
  if (contract !== run.taskContractSha256) return invalid('lineage_mismatch');
  return {
    ok: true,
    value: {
      graphRef,
      graphRevision,
      graphVersion: graph.version,
      iterationId: run.iterationId,
      sourceSpecRef,
      sourceSpecRevision,
      taskContractSha256: contract,
      taskId: run.taskId,
      taskTitle: String(task.title),
    },
  };
}

export function canonicalExecutionJson(value: unknown): string {
  return canonicalJson(value);
}
