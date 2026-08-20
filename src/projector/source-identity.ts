import { posix } from 'node:path';

export interface P2aSourceIdentityInput {
  readonly artifactPath?: string;
  readonly documentKind?:
    | 'archived-iteration'
    | 'implementation-plan'
    | 'intake'
    | 'product-spec';
  readonly iterationId?: string;
  readonly projectId: string;
  readonly repository: string;
  readonly source: string;
  readonly sourceKind: 'execution' | 'planning';
  readonly taskContractSha256?: string;
  readonly taskId?: string;
}

function decodeCanonicalSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return encodeURIComponent(decoded) === segment ? decoded : null;
  } catch {
    return null;
  }
}

function portablePath(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.startsWith('/') &&
    !value.includes('\\') && posix.normalize(value) === value &&
    !value.split('/').includes('..');
}

function portableIdentifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

function canonicalPlanningArtifact(
  iterationId: string,
  documentKind: NonNullable<P2aSourceIdentityInput['documentKind']>,
): string {
  switch (documentKind) {
    case 'archived-iteration':
      return `iterations/${iterationId}/iteration.json`;
    case 'intake':
      return `iterations/${iterationId}/gate-a-intake/intake.json`;
    case 'implementation-plan':
    case 'product-spec':
      return `iterations/${iterationId}/gate-b-spec/spec.json`;
  }
}

export function validateP2aSourceIdentity(input: P2aSourceIdentityInput): string | null {
  const segments = input.source.split('/');
  if (segments[0] !== 'buildlore+p2a:') return null;
  const decoded = segments.slice(1).map((segment, index) =>
    input.sourceKind === 'execution' && index === 6 ? segment : decodeCanonicalSegment(segment));
  if (decoded.some((value) => value === null)) return null;
  const values = decoded as string[];
  if (values[0] !== input.repository || values[1] !== input.projectId ||
      values[2] === undefined || !portableIdentifier(values[2]) ||
      (input.iterationId !== undefined && values[2] !== input.iterationId)) return null;
  if (input.sourceKind === 'planning') {
    if (values.length !== 5 || values[3] === undefined || !new Set([
      'archived-iteration',
      'implementation-plan',
      'intake',
      'product-spec',
    ]).has(values[3]) ||
        (input.documentKind !== undefined && values[3] !== input.documentKind) ||
        values[4] === undefined || !portablePath(values[4]) ||
        (input.artifactPath !== undefined && values[4] !== input.artifactPath)) return null;
    const documentKind = values[3] as NonNullable<P2aSourceIdentityInput['documentKind']>;
    if (values[4] !== canonicalPlanningArtifact(values[2], documentKind)) return null;
  } else if (values.length !== 7 || values[3] !== 'execution-task' ||
      values[4] === undefined || !portablePath(values[4]) ||
      values[5] === undefined || !/^task-[0-9]+$/u.test(values[5]) ||
      values[6] === undefined || !/^[a-f0-9]{64}$/u.test(values[6]) ||
      values[4] !== `iterations/${values[2]}/gate-c-task-graph/task-graph.json` ||
      (input.artifactPath !== undefined && values[4] !== input.artifactPath) ||
      (input.taskId !== undefined && values[5] !== input.taskId) ||
      (input.taskContractSha256 !== undefined && values[6] !== input.taskContractSha256)) return null;
  return values.join('\n');
}
