import { createHash } from 'node:crypto';
import { isAbsolute, posix } from 'node:path';
import { TextDecoder } from 'node:util';

import { ProjectionError } from './errors.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const GATE_SCOPE_TYPES = new Set([
  'gate.what.approved',
  'gate.what.revoked',
  'scope.added',
  'scope.removed',
]);
const ACTIVE_SCOPE_TYPES = new Set([
  'gate.what.approved',
  'scope.added',
  'scope.removed',
]);
const ALLOWED_TYPES = new Set([
  ...GATE_SCOPE_TYPES,
  'constitution.changed',
  'gate.how.approved',
  'gate.how.revoked',
]);
const ALLOWED_KEYS = new Set([
  'at',
  'constitution_content_sha256',
  'constitution_sha256',
  'prev_seq',
  'prev_sha256',
  'previous_constitution_sha256',
  'quote',
  'scope_change',
  'scope_ref',
  'seq',
  'sha256',
  'type',
]);

interface ValidatedDecisionRecord extends Record<string, unknown> {
  readonly at: string;
  readonly quote: string;
  readonly seq: number;
  readonly type: string;
}

export interface P2aScopeDecision {
  readonly at: string;
  readonly scopeRef: string;
  readonly sha256: string;
  readonly type: string;
}

function fail(): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', 'The approval ledger is invalid.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digest(record: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function optionalHash(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && HASH_PATTERN.test(value));
}

function safeScopeReference(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !isAbsolute(value) &&
    !/^[A-Za-z]:\//u.test(value) &&
    !value.startsWith('/') &&
    !value.startsWith('../') &&
    posix.normalize(value) === value &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function scopeIdentity(reference: string): string {
  return reference.replace(/^iterations\/[^/]+\//u, '');
}

function validateBase(
  value: unknown,
  index: number,
  previousHash: string | null,
): ValidatedDecisionRecord {
  if (!isRecord(value) || Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) return fail();
  const type = value.type;
  if (
    value.seq !== index + 1 ||
    typeof value.seq !== 'number' ||
    !Number.isSafeInteger(value.seq) ||
    typeof value.at !== 'string' ||
    value.at.length === 0 ||
    !Number.isFinite(Date.parse(value.at)) ||
    typeof type !== 'string' ||
    !ALLOWED_TYPES.has(type) ||
    typeof value.quote !== 'string' ||
    value.quote.trim().length === 0 ||
    value.prev_sha256 !== previousHash ||
    !optionalHash(value.sha256) ||
    !optionalHash(value.constitution_sha256) ||
    !optionalHash(value.constitution_content_sha256) ||
    !optionalHash(value.previous_constitution_sha256) ||
    (value.scope_ref !== undefined && !safeScopeReference(value.scope_ref)) ||
    (value.scope_change !== undefined &&
      (typeof value.scope_change !== 'string' || value.scope_change.length === 0)) ||
    (value.prev_seq !== undefined &&
      (typeof value.prev_seq !== 'number' ||
        !Number.isSafeInteger(value.prev_seq) ||
        value.prev_seq < 1 ||
        value.prev_seq >= value.seq))
  ) return fail();
  if (
    ((type === 'gate.what.approved' || type === 'gate.what.revoked') &&
      (!safeScopeReference(value.scope_ref) ||
        typeof value.sha256 !== 'string' ||
        !HASH_PATTERN.test(value.sha256))) ||
    ((type === 'gate.how.approved' || type === 'gate.how.revoked') &&
      (typeof value.constitution_sha256 !== 'string' ||
        !HASH_PATTERN.test(value.constitution_sha256))) ||
    (type === 'constitution.changed' &&
      [
        value.constitution_sha256,
        value.constitution_content_sha256,
        value.previous_constitution_sha256,
      ].some((item) => typeof item !== 'string' || !HASH_PATTERN.test(item))) ||
    ((type === 'scope.added' || type === 'scope.removed') &&
      (!safeScopeReference(value.scope_ref) ||
        typeof value.sha256 !== 'string' ||
        !HASH_PATTERN.test(value.sha256) ||
        typeof value.scope_change !== 'string' ||
        value.scope_change.length === 0 ||
        value.prev_seq === undefined))
  ) return fail();
  return value as ValidatedDecisionRecord;
}

function latestScopeRecord(
  records: readonly ValidatedDecisionRecord[],
  scopeRef: string,
): ValidatedDecisionRecord | undefined {
  return records.filter((candidate) =>
    GATE_SCOPE_TYPES.has(candidate.type) && candidate.scope_ref === scopeRef).at(-1);
}

function validatePreviousReference(
  record: ValidatedDecisionRecord,
  records: readonly ValidatedDecisionRecord[],
): void {
  const previousSequence = record.prev_seq;
  if (previousSequence === undefined) return;
  if (typeof previousSequence !== 'number') return fail();
  const referenced = records[previousSequence - 1];
  if (referenced?.seq !== previousSequence) return fail();

  if (
    (record.type === 'gate.what.revoked' ||
      record.type === 'scope.added' ||
      record.type === 'scope.removed') &&
    (!ACTIVE_SCOPE_TYPES.has(referenced.type) ||
      referenced.scope_ref !== record.scope_ref ||
      latestScopeRecord(records, String(record.scope_ref))?.seq !== referenced.seq)
  ) return fail();

  if (record.type === 'gate.what.approved') {
    const reference = String(record.scope_ref);
    const latestForArtifact = records.filter((candidate) =>
      GATE_SCOPE_TYPES.has(candidate.type) &&
      typeof candidate.scope_ref === 'string' &&
      scopeIdentity(candidate.scope_ref) === scopeIdentity(reference)).at(-1);
    if (
      !ACTIVE_SCOPE_TYPES.has(referenced.type) ||
      typeof referenced.scope_ref !== 'string' ||
      scopeIdentity(referenced.scope_ref) !== scopeIdentity(reference) ||
      latestForArtifact?.seq !== referenced.seq
    ) return fail();
  }

  if (record.type === 'gate.how.revoked') {
    const latestGateHow = records.filter((candidate) =>
      candidate.type === 'gate.how.approved' || candidate.type === 'gate.how.revoked').at(-1);
    if (referenced.type !== 'gate.how.approved' || latestGateHow?.seq !== referenced.seq) {
      return fail();
    }
  }
}

export function parseP2aDecisionLedger(bytes: Buffer): readonly P2aScopeDecision[] {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const lines = text.replace(/\r\n?/gu, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length === 0) return fail();
    const records: ValidatedDecisionRecord[] = [];
    let previousHash: string | null = null;
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) return fail();
      const record = validateBase(JSON.parse(line) as unknown, index, previousHash);
      validatePreviousReference(record, records);
      records.push(record);
      previousHash = digest(record);
    }
    return records.flatMap((record): readonly P2aScopeDecision[] => {
      if (!GATE_SCOPE_TYPES.has(record.type)) return [];
      return [{
        at: record.at,
        scopeRef: String(record.scope_ref),
        sha256: String(record.sha256),
        type: record.type,
      }];
    });
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail();
  }
}

export function matchingP2aApproval(
  decisions: readonly P2aScopeDecision[],
  scope: string,
  sourceRevision: `sha256:${string}`,
): P2aScopeDecision | null {
  const expected = sourceRevision.slice('sha256:'.length);
  for (const decision of [...decisions].reverse()) {
    if (decision.scopeRef !== scope) continue;
    if (decision.type === 'gate.what.revoked') return null;
    if (ACTIVE_SCOPE_TYPES.has(decision.type)) {
      return decision.sha256 === expected ? decision : null;
    }
  }
  return null;
}
