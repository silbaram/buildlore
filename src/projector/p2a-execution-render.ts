import type { CanonicalTaskLineage, ExecutionAttempt } from './execution-types.js';
import { compareExecutionAttempts } from './p2a-execution-policy.js';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function linesOrNone(lines: readonly string[]): readonly string[] {
  return lines.length > 0 ? lines : ['- none'];
}

export function renderP2aExecutionKnowledge(
  lineage: CanonicalTaskLineage,
  attempts: readonly ExecutionAttempt[],
): string {
  const sorted = [...attempts].sort(compareExecutionAttempts);
  const finalAttempt = sorted.at(-1);
  if (finalAttempt === undefined) throw new Error('Execution knowledge requires an attempt.');
  const changedFiles = uniqueSorted(sorted.flatMap((attempt) => attempt.changedFiles));
  const verification = sorted.flatMap((attempt) => attempt.verification.map((item) =>
    `- ${quoted(attempt.runId)}: ${quoted(item.type)} ${quoted(item.status)} ` +
    `exit=${item.exitCode === null ? 'null' : String(item.exitCode)} command=${quoted(item.command)}`));
  const failureSignals = sorted.flatMap((attempt) => [
    ...(attempt.failureClass === undefined
      ? []
      : [`- ${quoted(attempt.runId)} failureClass=${quoted(attempt.failureClass)}`]),
    ...attempt.reproductionSteps.map((item) =>
      `- ${quoted(attempt.runId)} reproduction=${quoted(item)}`),
    ...attempt.localizationFindings.map((item) =>
      `- ${quoted(attempt.runId)} finding=${quoted(item)}`),
    ...attempt.localizationFiles.map((item) =>
      `- ${quoted(attempt.runId)} file=${quoted(item)}`),
  ]);
  const resolution = sorted.flatMap((attempt) => [
    ...attempt.fixSummaries.map((item) =>
      `- ${quoted(attempt.runId)} fix=${quoted(item)}`),
    ...attempt.guardChecks.map((item) =>
      `- ${quoted(attempt.runId)} guard=${quoted(item)}`),
    ...attempt.guardNotes.map((item) =>
      `- ${quoted(attempt.runId)} guardNote=${quoted(item)}`),
  ]);
  const references = sorted.flatMap((attempt) => [
    `- run=${quoted(attempt.runRef)} sha256=${quoted(attempt.runRevision)}`,
  ]);
  const gateReferences = uniqueSorted(sorted.flatMap((attempt) =>
    attempt.sourceGateRefs.map((reference) =>
      `- gate=${quoted(reference.relativePath)} sha256=${quoted(reference.revision)}`)));

  return [
    '# Task Identity',
    '',
    `- iteration: ${quoted(lineage.iterationId)}`,
    `- task: ${quoted(lineage.taskId)}`,
    `- title: ${quoted(lineage.taskTitle)}`,
    `- taskContractSha256: ${quoted(lineage.taskContractSha256)}`,
    `- graph: ${quoted(lineage.graphRef)}`,
    `- graphRevision: ${quoted(lineage.graphRevision)}`,
    `- sourceSpec: ${quoted(lineage.sourceSpecRef)}`,
    `- sourceSpecRevision: ${quoted(lineage.sourceSpecRevision)}`,
    '',
    '# Attempt Timeline',
    '',
    ...sorted.map((attempt) =>
      `- ${quoted(attempt.runId)} status=${quoted(attempt.status)} ` +
      `startedAt=${quoted(attempt.startedAt)} finishedAt=${
        attempt.finishedAt === null ? 'null' : quoted(attempt.finishedAt)}`),
    '',
    '# Final Status',
    '',
    `- status: ${quoted(finalAttempt.status)}`,
    `- finishedAt: ${finalAttempt.finishedAt === null ? 'null' : quoted(finalAttempt.finishedAt)}`,
    '',
    '# Changed Files',
    '',
    ...linesOrNone(changedFiles.map((path) => `- ${quoted(path)}`)),
    '',
    '# Verification',
    '',
    ...linesOrNone(verification),
    '',
    '# Failure Signals and Localization',
    '',
    ...linesOrNone(failureSignals),
    '',
    '# Resolution and Prevention',
    '',
    ...linesOrNone(resolution),
    '',
    '# Source References',
    '',
    `- graph=${quoted(lineage.graphRef)} sha256=${quoted(lineage.graphRevision)}`,
    `- spec=${quoted(lineage.sourceSpecRef)} sha256=${quoted(lineage.sourceSpecRevision)}`,
    ...gateReferences,
    ...references,
    '',
  ].join('\n');
}
