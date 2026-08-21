import { posix } from 'node:path';

import {
  SANITIZATION_REPORT_SCHEMA_VERSION,
  SANITIZER_RULES_VERSION,
  type SanitizationReport,
  type SecurityRuleSummary,
} from '../sanitizer/index.js';
import type {
  ExecutionKnowledgeProjectorPort,
  ExecutionProjectionApplyResult,
  ExecutionProjectionPlan,
  ExecutionProjectionPlanEntry,
} from './execution-types.js';
import { EXECUTION_INCLUSION_POLICY_VERSION, EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION } from './execution-types.js';
import { createP2aExecutionKnowledgeProjector } from './p2a-execution-projector.js';
import { createP2aPlanningProjector } from './p2a-planning-projector.js';
import {
  PROJECTION_PLAN_SCHEMA_VERSION,
  type PlanningProjectorPort,
  type ProjectionApplyResult,
  type ProjectionPlan,
  type ProjectionPlanEntry,
} from './planning-types.js';

export const PROJECT_SYNC_SCHEMA_VERSION = 'buildlore.project-sync.v1' as const;

export type ProjectSyncFailurePhase =
  | 'execution-apply'
  | 'execution-plan'
  | 'planning-apply'
  | 'planning-plan';

export type ProjectSyncErrorCode =
  | 'SYNC_APPLY_FAILED'
  | 'SYNC_PLAN_BLOCKED'
  | 'SYNC_PLAN_FAILED'
  | 'SYNC_TARGET_COLLISION';

export type ProjectSyncRecoveryAction = 'inspect-plan' | 'retry-sync';

export interface ProjectSyncInput {
  readonly artifactRoot: string;
  readonly dryRun: boolean;
  readonly knowledgeRoot: string;
  readonly projectId: string;
}

export interface ProjectSyncDecisionCounts {
  readonly blocked: number;
  readonly error: number;
  readonly exclude: number;
  readonly include: number;
  readonly quarantine: number;
}

export interface ProjectSyncPlanEntrySummary {
  readonly decision: 'blocked' | 'error' | 'exclude' | 'include' | 'quarantine';
  readonly reasonCode: string;
  readonly security?: SanitizationReport;
  readonly sourceKind: 'execution' | 'planning';
  readonly sourceRef: string | null;
  readonly sourceRevision: `sha256:${string}` | null;
  readonly target: string | null;
  readonly writeStatus: 'create' | 'unchanged' | 'update' | null;
}

export interface ProjectSyncPlanSummary {
  readonly counts: ProjectSyncDecisionCounts;
  readonly entries: readonly ProjectSyncPlanEntrySummary[];
  readonly planFingerprint: `sha256:${string}`;
}

export interface ProjectSyncWriteSummary {
  readonly sourceKind: 'execution' | 'planning';
  readonly sourceRevision: `sha256:${string}`;
  readonly target: string;
  readonly writeStatus: 'create' | 'unchanged' | 'update';
}

export interface ProjectSyncSummary {
  readonly appliedCount: number;
  readonly dryRun: boolean;
  readonly execution: ProjectSyncPlanSummary;
  readonly partial: false;
  readonly planning: ProjectSyncPlanSummary;
  readonly projectId: string;
  readonly remainingCount: number;
  readonly schemaVersion: typeof PROJECT_SYNC_SCHEMA_VERSION;
  readonly writes: readonly ProjectSyncWriteSummary[];
}

export interface ProjectSyncPort {
  sync(input: ProjectSyncInput): Promise<ProjectSyncSummary>;
}

export interface CreateProjectSyncServiceOptions {
  readonly executionProjector?: ExecutionKnowledgeProjectorPort;
  readonly planningProjector?: PlanningProjectorPort;
}

export class ProjectSyncError extends Error {
  readonly code: ProjectSyncErrorCode;
  readonly completedTargets: readonly string[];
  readonly failedPhase: ProjectSyncFailurePhase;
  readonly partial: boolean;
  readonly recoveryAction: ProjectSyncRecoveryAction;

  constructor(
    code: ProjectSyncErrorCode,
    options: {
      readonly cause?: unknown;
      readonly completedTargets?: readonly string[];
      readonly failedPhase: ProjectSyncFailurePhase;
      readonly partial: boolean;
      readonly recoveryAction: ProjectSyncRecoveryAction;
    },
  ) {
    super('Project synchronization failed safely.',
      options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProjectSyncError';
    this.code = code;
    this.completedTargets = Object.freeze(
      [...new Set(options.completedTargets ?? [])]
        .filter((target) => TARGET_PATTERN.test(target))
        .sort(),
    );
    this.failedPhase = options.failedPhase;
    this.partial = options.partial;
    this.recoveryAction = options.recoveryAction;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      completedTargets: this.completedTargets,
      failedPhase: this.failedPhase,
      partial: this.partial,
      recoveryAction: this.recoveryAction,
    };
  }
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RULE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const TARGET_PATTERN = /^(?:execution|planning)--[a-f0-9]{64}\.md$/u;
const PLANNING_DECISIONS = new Set(['blocked', 'error', 'exclude', 'include', 'quarantine']);
const EXECUTION_DECISIONS = new Set(['blocked', 'exclude', 'include', 'quarantine']);
const WRITE_STATUSES = new Set(['create', 'unchanged', 'update']);

function fail(
  code: ProjectSyncErrorCode,
  failedPhase: ProjectSyncFailurePhase,
  options: {
    readonly cause?: unknown;
    readonly completedTargets?: readonly string[];
    readonly partial?: boolean;
    readonly recoveryAction?: ProjectSyncRecoveryAction;
  } = {},
): never {
  throw new ProjectSyncError(code, {
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    ...(options.completedTargets === undefined
      ? {}
      : { completedTargets: options.completedTargets }),
    failedPhase,
    partial: options.partial ?? false,
    recoveryAction: options.recoveryAction ?? 'inspect-plan',
  });
}

function isSafeRelativeRef(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes('\\') &&
    !value.includes('\0') && !value.startsWith('/') &&
    /^[A-Za-z0-9._/-]+$/u.test(value) && posix.normalize(value) === value &&
    value !== '..' && !value.startsWith('../');
}

function safePlanningSourceRef(entry: ProjectionPlanEntry): string | null {
  return isSafeRelativeRef(entry.sourceArtifact) ? entry.sourceArtifact : null;
}

function safeExecutionSourceRef(entry: ExecutionProjectionPlanEntry): string | null {
  if (entry.taskStableId !== undefined && /^[a-f0-9]{64}$/u.test(entry.taskStableId)) {
    return entry.taskStableId;
  }
  const taskId = entry.lineage?.taskId;
  return taskId !== undefined && taskId.length <= 64 && ID_PATTERN.test(taskId) ? taskId : null;
}

function safeRuleSummary(value: SecurityRuleSummary): SecurityRuleSummary | null {
  if (
    !['block', 'quarantine', 'redact'].includes(value.action) ||
    !Number.isSafeInteger(value.count) || value.count < 0 ||
    !Number.isSafeInteger(value.overriddenCount) || value.overriddenCount < 0 ||
    value.overriddenCount > value.count || !RULE_ID_PATTERN.test(value.ruleId)
  ) {
    return null;
  }
  return Object.freeze({
    action: value.action,
    count: value.count,
    overriddenCount: value.overriddenCount,
    ruleId: value.ruleId,
  });
}

function safeSecurityReport(
  report: SanitizationReport | undefined,
  projectId: string,
  failedPhase: ProjectSyncFailurePhase,
): SanitizationReport | undefined {
  if (report === undefined) return undefined;
  const summaries = report.summaries.map(safeRuleSummary);
  if (
    report.schemaVersion !== SANITIZATION_REPORT_SCHEMA_VERSION ||
    report.rulesVersion !== SANITIZER_RULES_VERSION || report.projectId !== projectId ||
    !['internal', 'public', 'restricted'].includes(report.classification) ||
    !['blocked', 'include', 'quarantine'].includes(report.decision) ||
    typeof report.findingsOverflow !== 'boolean' ||
    !DIGEST_PATTERN.test(report.inputDigest) || !DIGEST_PATTERN.test(report.policyDigest) ||
    (report.outputDigest !== undefined && !DIGEST_PATTERN.test(report.outputDigest)) ||
    !/^[a-f0-9]{64}$/u.test(report.sourceIdentitySha256) ||
    summaries.some((summary) => summary === null)
  ) {
    return fail('SYNC_PLAN_FAILED', failedPhase);
  }
  return Object.freeze({
    classification: report.classification,
    decision: report.decision,
    findingsOverflow: report.findingsOverflow,
    inputDigest: report.inputDigest,
    ...(report.outputDigest === undefined ? {} : { outputDigest: report.outputDigest }),
    policyDigest: report.policyDigest,
    projectId: report.projectId,
    rulesVersion: report.rulesVersion,
    schemaVersion: report.schemaVersion,
    sourceIdentitySha256: report.sourceIdentitySha256,
    summaries: Object.freeze(
      summaries
        .filter((summary): summary is SecurityRuleSummary => summary !== null)
        .sort((left, right) => left.ruleId.localeCompare(right.ruleId, 'en')),
    ),
  });
}

function normalizedCounts(
  entries: readonly Readonly<{ readonly decision: string }>[],
): ProjectSyncDecisionCounts {
  const counts = { blocked: 0, error: 0, exclude: 0, include: 0, quarantine: 0 };
  for (const entry of entries) {
    if (entry.decision in counts) {
      counts[entry.decision as keyof typeof counts] += 1;
    }
  }
  return Object.freeze(counts);
}

function assertCounts(
  actual: Readonly<Record<string, number>>,
  expected: ProjectSyncDecisionCounts,
  failedPhase: ProjectSyncFailurePhase,
): void {
  for (const key of ['blocked', 'error', 'exclude', 'include', 'quarantine'] as const) {
    const value = actual[key] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0 || value !== expected[key]) {
      fail('SYNC_PLAN_FAILED', failedPhase);
    }
  }
}

function planningSummary(plan: ProjectionPlan, projectId: string): ProjectSyncPlanSummary {
  const failedPhase = 'planning-plan';
  if (
    plan.schemaVersion !== PROJECTION_PLAN_SCHEMA_VERSION || plan.projectId !== projectId ||
    !DIGEST_PATTERN.test(plan.planFingerprint) ||
    plan.entries.some((entry) => !PLANNING_DECISIONS.has(entry.decision))
  ) {
    return fail('SYNC_PLAN_FAILED', failedPhase);
  }
  const counts = normalizedCounts(plan.entries);
  assertCounts(plan.counts, counts, failedPhase);
  return summarizePlan(
    plan.planFingerprint,
    counts,
    plan.entries.map((entry) => {
      const security = safeSecurityReport(entry.security, projectId, failedPhase);
      return {
        decision: entry.decision,
        reasonCode: entry.reasonCode,
        ...(security === undefined ? {} : { security }),
        sourceKind: 'planning' as const,
        sourceRef: safePlanningSourceRef(entry),
        sourceRevision: entry.sourceRevision ?? null,
        target: entry.target ?? null,
        writeStatus: entry.writeStatus ?? null,
      };
    }),
    failedPhase,
  );
}

function executionSummary(
  plan: ExecutionProjectionPlan,
  projectId: string,
): ProjectSyncPlanSummary {
  const failedPhase = 'execution-plan';
  if (
    plan.schemaVersion !== EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION ||
    plan.policyVersion !== EXECUTION_INCLUSION_POLICY_VERSION || plan.projectId !== projectId ||
    !DIGEST_PATTERN.test(plan.planFingerprint) ||
    plan.entries.some((entry) => !EXECUTION_DECISIONS.has(entry.decision))
  ) {
    return fail('SYNC_PLAN_FAILED', failedPhase);
  }
  const counts = normalizedCounts(plan.entries);
  assertCounts(plan.counts, counts, failedPhase);
  return summarizePlan(
    plan.planFingerprint,
    counts,
    plan.entries.map((entry) => {
      const security = safeSecurityReport(entry.security, projectId, failedPhase);
      return {
        decision: entry.decision,
        reasonCode: entry.reasonCode,
        ...(security === undefined ? {} : { security }),
        sourceKind: 'execution' as const,
        sourceRef: safeExecutionSourceRef(entry),
        sourceRevision: entry.sourceRevision ?? null,
        target: entry.target ?? null,
        writeStatus: entry.writeStatus ?? null,
      };
    }),
    failedPhase,
  );
}

function summarizePlan(
  planFingerprint: `sha256:${string}`,
  counts: ProjectSyncDecisionCounts,
  entries: readonly ProjectSyncPlanEntrySummary[],
  failedPhase: ProjectSyncFailurePhase,
): ProjectSyncPlanSummary {
  for (const entry of entries) {
    if (
      !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/u.test(entry.reasonCode) ||
      (entry.sourceRevision !== null && !DIGEST_PATTERN.test(entry.sourceRevision)) ||
      (entry.target !== null && !TARGET_PATTERN.test(entry.target)) ||
      (entry.writeStatus !== null && !WRITE_STATUSES.has(entry.writeStatus))
    ) {
      return fail('SYNC_PLAN_FAILED', failedPhase);
    }
  }
  return Object.freeze({
    counts,
    entries: Object.freeze(
      [...entries].sort((left, right) =>
        [left.sourceKind, left.sourceRef ?? '', left.target ?? '', left.reasonCode]
          .join('\0')
          .localeCompare(
            [right.sourceKind, right.sourceRef ?? '', right.target ?? '', right.reasonCode]
              .join('\0'),
            'en',
          )),
    ),
    planFingerprint,
  });
}

function blockingPhase(
  planning: ProjectSyncPlanSummary,
  execution: ProjectSyncPlanSummary,
): ProjectSyncFailurePhase | null {
  if (planning.counts.blocked + planning.counts.error + planning.counts.quarantine > 0) {
    return 'planning-plan';
  }
  if (execution.counts.blocked + execution.counts.error + execution.counts.quarantine > 0) {
    return 'execution-plan';
  }
  return null;
}

function assertNoTargetCollision(
  planning: ProjectSyncPlanSummary,
  execution: ProjectSyncPlanSummary,
): void {
  const planningTargets = new Set(
    planning.entries
      .filter((entry) => entry.decision === 'include' && entry.target !== null)
      .map((entry) => entry.target),
  );
  if (execution.entries.some((entry) =>
    entry.decision === 'include' && entry.target !== null && planningTargets.has(entry.target))) {
    fail('SYNC_TARGET_COLLISION', 'execution-plan');
  }
}

function plannedRemaining(
  planning: ProjectSyncPlanSummary,
  execution: ProjectSyncPlanSummary,
): number {
  return [...planning.entries, ...execution.entries].filter((entry) =>
    entry.decision === 'include' &&
    (entry.writeStatus === 'create' || entry.writeStatus === 'update')).length;
}

function writeSummaries(
  planning: ProjectionApplyResult,
  execution: ExecutionProjectionApplyResult,
): readonly ProjectSyncWriteSummary[] {
  const results: ProjectSyncWriteSummary[] = [
    ...planning.writes.map((write) => ({
      sourceKind: 'planning' as const,
      sourceRevision: write.sourceRevision,
      target: write.target,
      writeStatus: write.writeStatus,
    })),
    ...execution.writes.map((write) => ({
      sourceKind: 'execution' as const,
      sourceRevision: write.sourceRevision,
      target: write.target,
      writeStatus: write.writeStatus,
    })),
  ];
  if (results.some((write) =>
    !DIGEST_PATTERN.test(write.sourceRevision) || !TARGET_PATTERN.test(write.target) ||
    !WRITE_STATUSES.has(write.writeStatus))) {
    fail('SYNC_APPLY_FAILED', 'execution-apply', { partial: true, recoveryAction: 'retry-sync' });
  }
  return Object.freeze(results);
}

function validatePlanningApply(
  result: ProjectionApplyResult,
  plan: ProjectionPlan,
  projectId: string,
): void {
  if (
    result.projectId !== projectId || result.planFingerprint !== plan.planFingerprint ||
    result.writes.some((write) =>
      !DIGEST_PATTERN.test(write.sourceRevision) ||
      !/^planning--[a-f0-9]{64}\.md$/u.test(write.target) ||
      !WRITE_STATUSES.has(write.writeStatus))
  ) {
    fail('SYNC_APPLY_FAILED', 'planning-apply', {
      partial: true,
      recoveryAction: 'retry-sync',
    });
  }
}

function validateExecutionApply(
  result: ExecutionProjectionApplyResult,
  plan: ExecutionProjectionPlan,
  projectId: string,
  completedTargets: readonly string[],
): void {
  if (
    result.projectId !== projectId || result.planFingerprint !== plan.planFingerprint ||
    result.writes.some((write) =>
      !DIGEST_PATTERN.test(write.sourceRevision) ||
      !/^execution--[a-f0-9]{64}\.md$/u.test(write.target) ||
      !WRITE_STATUSES.has(write.writeStatus) || !/^[a-f0-9]{64}$/u.test(write.taskStableId))
  ) {
    fail('SYNC_APPLY_FAILED', 'execution-apply', {
      completedTargets,
      partial: true,
      recoveryAction: 'retry-sync',
    });
  }
}

export function createProjectSyncService(
  options: CreateProjectSyncServiceOptions = {},
): ProjectSyncPort {
  const planningProjector = options.planningProjector ?? createP2aPlanningProjector();
  const executionProjector = options.executionProjector ??
    createP2aExecutionKnowledgeProjector();
  return {
    async sync(input): Promise<ProjectSyncSummary> {
      let planningPlan: ProjectionPlan;
      try {
        planningPlan = await planningProjector.plan(input);
      } catch (error) {
        return fail('SYNC_PLAN_FAILED', 'planning-plan', { cause: error });
      }
      const planning = planningSummary(planningPlan, input.projectId);

      let executionPlan: ExecutionProjectionPlan;
      try {
        executionPlan = await executionProjector.plan(input);
      } catch (error) {
        return fail('SYNC_PLAN_FAILED', 'execution-plan', { cause: error });
      }
      const execution = executionSummary(executionPlan, input.projectId);
      const blocked = blockingPhase(planning, execution);
      if (blocked !== null) fail('SYNC_PLAN_BLOCKED', blocked);
      assertNoTargetCollision(planning, execution);

      if (input.dryRun) {
        return Object.freeze({
          appliedCount: 0,
          dryRun: true,
          execution,
          partial: false,
          planning,
          projectId: input.projectId,
          remainingCount: plannedRemaining(planning, execution),
          schemaVersion: PROJECT_SYNC_SCHEMA_VERSION,
          writes: Object.freeze([]),
        });
      }

      let planningApply: ProjectionApplyResult;
      try {
        planningApply = await planningProjector.apply(planningPlan);
      } catch (error) {
        return fail('SYNC_APPLY_FAILED', 'planning-apply', {
          cause: error,
          partial: true,
          recoveryAction: 'retry-sync',
        });
      }
      validatePlanningApply(planningApply, planningPlan, input.projectId);
      const completedPlanningTargets = planningApply.writes.map((write) => write.target);
      let executionApply: ExecutionProjectionApplyResult;
      try {
        executionApply = await executionProjector.apply(executionPlan);
      } catch (error) {
        return fail('SYNC_APPLY_FAILED', 'execution-apply', {
          cause: error,
          completedTargets: completedPlanningTargets,
          partial: true,
          recoveryAction: 'retry-sync',
        });
      }
      validateExecutionApply(
        executionApply,
        executionPlan,
        input.projectId,
        completedPlanningTargets,
      );
      const writes = writeSummaries(planningApply, executionApply);
      return Object.freeze({
        appliedCount: writes.filter((write) => write.writeStatus !== 'unchanged').length,
        dryRun: false,
        execution,
        partial: false,
        planning,
        projectId: input.projectId,
        remainingCount: 0,
        schemaVersion: PROJECT_SYNC_SCHEMA_VERSION,
        writes,
      });
    },
  };
}
