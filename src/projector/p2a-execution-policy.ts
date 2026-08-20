import type {
  ExecutionAttempt,
  ExecutionExcludeReason,
  ExecutionIncludeReason,
} from './execution-types.js';
import { canonicalExecutionJson } from './p2a-execution-codecs.js';

const EXCLUDED_CHANGE_ROOTS = [
  '.plan2agent',
  'dist',
  'node_modules',
  'plans',
] as const;

export interface ExecutionPolicyResult {
  readonly excluded: readonly Readonly<{
    attempt: ExecutionAttempt;
    reasonCode: ExecutionExcludeReason;
  }>[];
  readonly included: readonly ExecutionAttempt[];
  readonly reasonCode?: ExecutionIncludeReason;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareExecutionAttempts(
  left: ExecutionAttempt,
  right: ExecutionAttempt,
): number {
  const started = compareText(left.startedAt, right.startedAt);
  if (started !== 0) return started;
  const finished = compareText(left.finishedAt ?? '', right.finishedAt ?? '');
  if (finished !== 0) return finished;
  return compareText(left.runId, right.runId);
}

export function filterDurableExecutionChanges(paths: readonly string[]): readonly string[] {
  return paths.filter((path) =>
    !EXCLUDED_CHANGE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)));
}

function durableChanges(attempt: ExecutionAttempt): readonly string[] {
  return filterDurableExecutionChanges(attempt.changedFiles);
}

function reusableVerification(attempt: ExecutionAttempt): boolean {
  return attempt.verification.some((item) =>
    (item.source === 'command' || item.source === 'config') &&
    ((item.status === 'passed' && item.exitCode === 0) ||
      (item.status === 'failed' && item.exitCode !== null && item.exitCode !== 0)));
}

function meaningfulFinished(attempt: ExecutionAttempt): boolean {
  return durableChanges(attempt).length > 0 || reusableVerification(attempt);
}

function evidenceFingerprint(attempt: ExecutionAttempt): string {
  return canonicalExecutionJson({
    changedFiles: [...attempt.changedFiles].sort(compareText),
    fixSummaries: attempt.fixSummaries,
    guardChecks: attempt.guardChecks,
    guardNotes: attempt.guardNotes,
    verification: attempt.verification.map((item) => ({
      command: item.command,
      exitCode: item.exitCode,
      source: item.source,
      status: item.status,
      type: item.type,
    })),
  });
}

export function applyExecutionInclusionPolicy(
  attempts: readonly ExecutionAttempt[],
): ExecutionPolicyResult {
  const sorted = [...attempts].sort(compareExecutionAttempts);
  const excluded: Array<{
    attempt: ExecutionAttempt;
    reasonCode: ExecutionExcludeReason;
  }> = [];
  const terminal: ExecutionAttempt[] = [];
  let priorFinishedFingerprint: string | null = null;
  let failureSinceFinished = false;

  for (const attempt of sorted) {
    if (attempt.status === 'started') {
      excluded.push({ attempt, reasonCode: 'started' });
      continue;
    }
    if (attempt.status === 'failed' || attempt.status === 'blocked') {
      terminal.push(attempt);
      failureSinceFinished = true;
      continue;
    }
    const fingerprint = evidenceFingerprint(attempt);
    if (!failureSinceFinished && priorFinishedFingerprint === fingerprint) {
      excluded.push({ attempt, reasonCode: 'duplicate_success' });
      continue;
    }
    terminal.push(attempt);
    priorFinishedFingerprint = fingerprint;
    failureSinceFinished = false;
  }

  const failures = terminal.filter((attempt) =>
    attempt.status === 'failed' || attempt.status === 'blocked');
  if (failures.length > 0) {
    const lastFailure = failures.at(-1);
    const recovery = lastFailure === undefined
      ? undefined
      : terminal.findLast((attempt) =>
        attempt.status === 'finished' && compareExecutionAttempts(attempt, lastFailure) > 0);
    const included = recovery === undefined ? failures : [...failures, recovery];
    for (const attempt of terminal) {
      if (!included.includes(attempt) && attempt.status === 'finished') {
        excluded.push({
          attempt,
          reasonCode: meaningfulFinished(attempt) ? 'duplicate_success' : 'low_signal',
        });
      }
    }
    return {
      excluded: excluded.sort((left, right) => compareExecutionAttempts(left.attempt, right.attempt)),
      included: included.sort(compareExecutionAttempts),
      reasonCode: recovery === undefined ? 'failed_or_blocked' : 'retry_succeeded',
    };
  }

  const meaningful = terminal.filter(meaningfulFinished);
  for (const attempt of terminal) {
    if (!meaningful.includes(attempt)) excluded.push({ attempt, reasonCode: 'low_signal' });
  }
  if (meaningful.length === 0) {
    return {
      excluded: excluded.sort((left, right) => compareExecutionAttempts(left.attempt, right.attempt)),
      included: [],
    };
  }
  return {
    excluded: excluded.sort((left, right) => compareExecutionAttempts(left.attempt, right.attempt)),
    included: meaningful.sort(compareExecutionAttempts),
    reasonCode: meaningful.some((attempt) => durableChanges(attempt).length > 0)
      ? 'significant_change'
      : 'reusable_verification',
  };
}
