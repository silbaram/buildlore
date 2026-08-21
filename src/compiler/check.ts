import type {
  CompilerOperationResult,
  CompilerWarning,
  EvalSummary,
  NormalizedLintSummary,
  ProjectCompilerPort,
  StatusSummary,
} from './types.js';

export type ProjectCheckGateCode =
  | 'eval-threshold-violations'
  | 'lint-errors'
  | 'orphaned-pages'
  | 'pending-candidates'
  | 'pending-changes'
  | 'pending-reviews'
  | 'stale-pages'
  | 'state-unhealthy';

export type ProjectCheckErrorCode = 'CHECK_COMPONENT_FAILED' | 'CHECK_SNAPSHOT_CHANGED';
export type ProjectCheckComponent = 'eval-fast' | 'lint' | 'status-after' | 'status-before';

export interface ProjectCheckSummary {
  readonly evalFast: EvalSummary;
  readonly gateCodes: readonly ProjectCheckGateCode[];
  readonly lint: NormalizedLintSummary;
  readonly passed: boolean;
  readonly projectId: string;
  readonly status: StatusSummary;
  readonly warnings: readonly CompilerWarning[];
}

export interface ProjectCheckPort {
  check(projectId: string): Promise<ProjectCheckSummary>;
}

export class ProjectCheckError extends Error {
  readonly code: ProjectCheckErrorCode;
  readonly completedComponents: readonly ProjectCheckComponent[];
  readonly partial: boolean;
  readonly projectId: string;
  readonly recoveryAction: 'retry';
  readonly retryable: boolean;

  constructor(
    code: ProjectCheckErrorCode,
    projectId: string,
    completedComponents: readonly ProjectCheckComponent[],
  ) {
    super(code === 'CHECK_SNAPSHOT_CHANGED'
      ? 'Project changed during quality check.'
      : 'Project quality check could not complete.');
    this.name = 'ProjectCheckError';
    this.code = code;
    this.completedComponents = Object.freeze([...completedComponents]);
    this.partial = completedComponents.length > 0;
    this.projectId = projectId;
    this.recoveryAction = 'retry';
    this.retryable = true;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      completedComponents: this.completedComponents,
      message: this.message,
      partial: this.partial,
      projectId: this.projectId,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
    };
  }
}

const GATE_ORDER: readonly ProjectCheckGateCode[] = [
  'pending-changes',
  'state-unhealthy',
  'pending-candidates',
  'pending-reviews',
  'stale-pages',
  'orphaned-pages',
  'lint-errors',
  'eval-threshold-violations',
];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusData(result: CompilerOperationResult): StatusSummary | null {
  if (result.capability !== 'status' || !isRecord(result.data)) return null;
  const data = result.data;
  return Array.isArray(data.pendingChanges) && Array.isArray(data.stalePages) &&
    Array.isArray(data.orphanedPages) && typeof data.pendingChangesCount === 'number' &&
    typeof data.stateStatus === 'string' && typeof data.pendingCandidates === 'number' &&
    typeof data.staleCount === 'number' && typeof data.orphanedCount === 'number'
    ? result.data as StatusSummary
    : null;
}

function lintData(result: CompilerOperationResult): NormalizedLintSummary | null {
  if (result.capability !== 'lint' || !isRecord(result.data)) return null;
  return typeof result.data.errors === 'number' && Array.isArray(result.data.findings)
    ? result.data as NormalizedLintSummary
    : null;
}

function evalFastData(result: CompilerOperationResult): EvalSummary | null {
  if (result.capability !== 'eval-fast' || !isRecord(result.data)) return null;
  return result.data.suite === 'fast' && typeof result.data.pendingReviews === 'number' &&
    typeof result.data.thresholdViolationCount === 'number' &&
    typeof result.data.embeddingsAvailable === 'boolean'
    ? result.data as EvalSummary
    : null;
}

function snapshot(status: StatusSummary, warnings: readonly CompilerWarning[]): string {
  return JSON.stringify({
    status,
    warnings: warnings.map((warning) => warning.code).sort(),
  });
}

function qualityGates(
  status: StatusSummary,
  lint: NormalizedLintSummary,
  evaluation: EvalSummary,
): readonly ProjectCheckGateCode[] {
  const present = new Set<ProjectCheckGateCode>();
  if (status.pendingChangesCount > 0) present.add('pending-changes');
  if (status.stateStatus !== 'ok') present.add('state-unhealthy');
  if (status.pendingCandidates > 0) present.add('pending-candidates');
  if (evaluation.pendingReviews > 0) present.add('pending-reviews');
  if (status.staleCount > 0) present.add('stale-pages');
  if (status.orphanedCount > 0) present.add('orphaned-pages');
  if (lint.errors > 0) present.add('lint-errors');
  if (evaluation.thresholdViolationCount > 0) present.add('eval-threshold-violations');
  return GATE_ORDER.filter((code) => present.has(code));
}

function aggregateWarnings(...groups: ReadonlyArray<readonly CompilerWarning[]>): readonly CompilerWarning[] {
  return [...new Set(groups.flatMap((warnings) => warnings.map((warning) => warning.code)))]
    .sort()
    .map((code) => ({ code }));
}

export function createProjectCheck(compiler: ProjectCompilerPort): ProjectCheckPort {
  return {
    async check(projectId) {
      const completed: ProjectCheckComponent[] = [];
      const execute = async (
        component: ProjectCheckComponent,
        capability: 'eval-fast' | 'lint' | 'status',
      ): Promise<CompilerOperationResult> => {
        try {
          const result = await compiler.execute({ capability, projectId });
          completed.push(component);
          return result;
        } catch {
          throw new ProjectCheckError('CHECK_COMPONENT_FAILED', projectId, completed);
        }
      };

      const beforeResult = await execute('status-before', 'status');
      const before = statusData(beforeResult);
      if (before === null) {
        throw new ProjectCheckError('CHECK_COMPONENT_FAILED', projectId, completed);
      }
      const lintResult = await execute('lint', 'lint');
      const lint = lintData(lintResult);
      if (lint === null) {
        throw new ProjectCheckError('CHECK_COMPONENT_FAILED', projectId, completed);
      }
      const evalResult = await execute('eval-fast', 'eval-fast');
      const evaluation = evalFastData(evalResult);
      if (evaluation === null) {
        throw new ProjectCheckError('CHECK_COMPONENT_FAILED', projectId, completed);
      }
      const afterResult = await execute('status-after', 'status');
      const after = statusData(afterResult);
      if (after === null) {
        throw new ProjectCheckError('CHECK_COMPONENT_FAILED', projectId, completed);
      }
      if (snapshot(before, beforeResult.warnings) !== snapshot(after, afterResult.warnings)) {
        throw new ProjectCheckError('CHECK_SNAPSHOT_CHANGED', projectId, completed);
      }

      const gateCodes = qualityGates(after, lint, evaluation);
      return {
        evalFast: evaluation,
        gateCodes,
        lint,
        passed: gateCodes.length === 0,
        projectId,
        status: after,
        warnings: aggregateWarnings(
          beforeResult.warnings,
          lintResult.warnings,
          evalResult.warnings,
          afterResult.warnings,
        ),
      };
    },
  };
}
