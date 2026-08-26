import type { CliIo } from './run-cli.js';
import {
  CLI_ENVELOPE_SCHEMA_VERSION,
  type CliEnvelopeV1,
  type CliOutputMode,
  type CliResult,
  type RenderedCliResult,
} from './types.js';

function normalizedEnvelope(result: CliResult): CliEnvelopeV1 {
  return {
    schemaVersion: CLI_ENVELOPE_SCHEMA_VERSION,
    command: result.command,
    ok: result.ok,
    projectId: result.projectId ?? null,
    workspacePath: result.workspacePath ?? null,
    knowledgeRevision: result.knowledgeRevision ?? null,
    data: result.data ?? null,
    partial: result.partial ?? false,
    warnings: Object.freeze([...(result.warnings ?? [])]),
    errors: Object.freeze([...(result.errors ?? [])]),
  };
}

function sortForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForDisplay);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, entry]) => [key, sortForDisplay(entry)]),
  );
}

function outcomeForDisplay(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  if ('state' in data && typeof data.state === 'string') return data.state;
  if ('eligible' in data && typeof data.eligible === 'boolean') {
    if ('noOp' in data && data.noOp === true) return 'no-op';
    return data.eligible ? 'planned' : 'ineligible';
  }
  return null;
}

function sessionPlanForDisplay(data: unknown): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const value = data as Readonly<Record<string, unknown>>;
  return Object.freeze({
    algorithmVersion: typeof value.algorithmVersion === 'string' ? value.algorithmVersion : null,
    allowedLinkTargetCount: Array.isArray(value.allowedLinkTargets)
      ? value.allowedLinkTargets.length
      : 0,
    contractDigest: typeof value.contractDigest === 'string' ? value.contractDigest : null,
    mergeCandidateCount: Array.isArray(value.mergeCandidates) ? value.mergeCandidates.length : 0,
    planDigest: typeof value.planDigest === 'string' ? value.planDigest : null,
    projectId: typeof value.projectId === 'string' ? value.projectId : null,
    schemaVersion: typeof value.schemaVersion === 'string' ? value.schemaVersion : null,
    sourceCount: Array.isArray(value.sources) ? value.sources.length : 0,
    taskCount: Array.isArray(value.tasks) ? value.tasks.length : 0,
  });
}

function renderHuman(result: CliResult): string {
  if (!result.ok) {
    const lines = [`${result.command}: failed`];
    const outcome = outcomeForDisplay(result.data);
    if (outcome !== null) lines.push(`outcome: ${outcome}`);
    for (const error of result.errors) {
      lines.push(`error ${error.code}: ${error.message}`);
      if (error.recoveryCommand !== undefined) {
        lines.push(`recovery: buildlore ${error.recoveryCommand.join(' ')}`);
      }
    }
    if (result.partial === true) lines.push('partial: yes');
    if (result.data !== undefined && result.data !== null) {
      lines.push('result:');
      lines.push(JSON.stringify(sortForDisplay(result.data), null, 2));
    }
    return `${lines.join('\n')}\n`;
  }
  const lines = [`${result.command}: ok`];
  const outcome = outcomeForDisplay(result.data);
  if (outcome !== null) lines.push(`outcome: ${outcome}`);
  if (result.projectId !== undefined && result.projectId !== null) {
    lines.push(`project: ${result.projectId}`);
  }
  if (result.workspacePath !== undefined && result.workspacePath !== null) {
    lines.push(`workspace: ${result.workspacePath}`);
  }
  if (result.knowledgeRevision !== undefined && result.knowledgeRevision !== null) {
    lines.push(`revision: ${result.knowledgeRevision}`);
  }
  if (result.partial === true) lines.push('partial: yes');
  for (const warning of result.warnings ?? []) {
    lines.push(`warning ${warning.code}: ${warning.message}`);
  }
  if (result.data !== null) {
    lines.push('result:');
    const displayData = result.command === 'compile.plan'
      ? sessionPlanForDisplay(result.data)
      : result.data;
    lines.push(JSON.stringify(sortForDisplay(displayData), null, 2));
  }
  return `${lines.join('\n')}\n`;
}

export function renderCliResult(result: CliResult, outputMode: CliOutputMode): RenderedCliResult {
  const message = outputMode === 'json'
    ? `${JSON.stringify(normalizedEnvelope(result))}\n`
    : renderHuman(result);
  return Object.freeze({
    exitCode: result.exitCode,
    message,
    stream: result.ok ? 'stdout' : 'stderr',
  });
}

export function writeRenderedCliResult(io: CliIo, result: RenderedCliResult): void {
  if (result.stream === 'stdout') {
    io.stdout(result.message);
  } else {
    io.stderr(result.message);
  }
}
