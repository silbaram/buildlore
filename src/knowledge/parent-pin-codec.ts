import { serializeCanonicalJson } from './atomic-file.js';
import {
  PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION,
  PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION,
  ParentKnowledgePinError,
  type ParentKnowledgePinPlan,
  type ParentKnowledgePinResult,
} from './parent-pin-types.js';
import { decodeUtf8Strict, parseJsonStrict } from './strict-json.js';

export const MAX_PARENT_PIN_ARTIFACT_BYTES = 128 * 1024;

const blockReasons = new Set([
  'KNOWLEDGE_DIRTY',
  'KNOWLEDGE_HEAD_MISMATCH',
  'KNOWLEDGE_LINEAGE_INVALID',
  'KNOWLEDGE_REMOTE_MISSING',
  'KNOWLEDGE_REMOTE_UNREADABLE',
  'KNOWLEDGE_REMOTE_UNREACHABLE',
  'PARENT_CODE_MISMATCH',
  'PARENT_DIRTY',
]);

const failureCodes = new Set([
  'PARENT_PIN_INELIGIBLE',
  'PARENT_PIN_PARTIAL',
  'PARENT_PIN_PLAN_DRIFT',
  'PARENT_PIN_POSTVERIFY_FAILED',
  'PARENT_PIN_REPOSITORY_BUSY',
  'PARENT_PIN_TRANSACTION_FAILED',
]);

function invalid(): never {
  throw new ParentKnowledgePinError('PARENT_PIN_PLAN_DRIFT');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isOid(value: unknown): boolean {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function isDigest(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isIterationId(value: unknown): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 120 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function isProjectId(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function orderedUnique(values: readonly unknown[], allowed: ReadonlySet<string>): boolean {
  return values.every((value, index) =>
    typeof value === 'string' && allowed.has(value) &&
    (index === 0 || String(values[index - 1]) < value));
}

function validPlan(value: unknown): value is ParentKnowledgePinPlan {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion',
    'intent',
    'iterationId',
    'path',
    'parentRepositoryIdentityDigest',
    'knowledgeRepositoryIdentityDigest',
    'parentBaseRevision',
    'codeRevision',
    'oldKnowledgeGitlink',
    'newKnowledgeGitlink',
    'projectId',
    'sourceRevision',
    'lineageDigest',
    'targetRemoteReachability',
    'noOp',
    'eligible',
    'blockReasons',
    'planDigest',
  ])) return false;
  if (
    value.schemaVersion !== PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION ||
    value.intent !== 'iteration-close' ||
    !isIterationId(value.iterationId) ||
    value.path !== 'knowledge' ||
    !isDigest(value.parentRepositoryIdentityDigest) ||
    !isDigest(value.knowledgeRepositoryIdentityDigest) ||
    !isOid(value.parentBaseRevision) ||
    !isOid(value.codeRevision) ||
    !isOid(value.oldKnowledgeGitlink) ||
    !isOid(value.newKnowledgeGitlink) ||
    !(value.projectId === null || isProjectId(value.projectId)) ||
    !(value.sourceRevision === null || isOid(value.sourceRevision)) ||
    !(value.lineageDigest === null || isDigest(value.lineageDigest)) ||
    typeof value.targetRemoteReachability !== 'boolean' ||
    typeof value.noOp !== 'boolean' ||
    value.noOp !== (value.oldKnowledgeGitlink === value.newKnowledgeGitlink) ||
    typeof value.eligible !== 'boolean' ||
    !Array.isArray(value.blockReasons) ||
    value.blockReasons.length > blockReasons.size ||
    !orderedUnique(value.blockReasons, blockReasons) ||
    value.eligible !== (value.blockReasons.length === 0) ||
    (value.eligible && (
      value.projectId === null || value.sourceRevision === null || value.lineageDigest === null ||
      value.targetRemoteReachability !== true
    )) ||
    (value.eligible && !value.noOp && value.codeRevision !== value.parentBaseRevision) ||
    !isDigest(value.planDigest)
  ) return false;
  return true;
}

function validRecovery(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 12 &&
    value.every((part) => typeof part === 'string' && part.length >= 1 && part.length <= 128 &&
      !/[\r\n\0]/u.test(part));
}

function validResult(value: unknown): value is ParentKnowledgePinResult {
  if (!isRecord(value)) return false;
  const isBlocked = value.state === 'blocked';
  const keys = isBlocked ? [
    'schemaVersion', 'intent', 'iterationId', 'path', 'projectId', 'sourceRevision',
    'parentBaseRevision', 'codeRevision', 'oldKnowledgeGitlink', 'newKnowledgeGitlink',
    'targetRemoteReachability', 'planDigest', 'state', 'errorCode', 'applied', 'noOp',
    'partial', 'resultingParentCommitSha', 'recoveryCommand',
  ] : [
    'schemaVersion', 'intent', 'iterationId', 'path', 'projectId', 'sourceRevision',
    'parentBaseRevision', 'codeRevision', 'oldKnowledgeGitlink', 'newKnowledgeGitlink',
    'targetRemoteReachability', 'planDigest', 'state', 'applied', 'noOp', 'partial',
    'resultingParentCommitSha', 'recoveryCommand',
  ];
  if (
    !exactKeys(value, keys) ||
    value.schemaVersion !== PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION ||
    value.intent !== 'iteration-close' ||
    !isIterationId(value.iterationId) ||
    value.path !== 'knowledge' ||
    !(value.projectId === null || isProjectId(value.projectId)) ||
    !(value.sourceRevision === null || isOid(value.sourceRevision)) ||
    !isOid(value.parentBaseRevision) ||
    !isOid(value.codeRevision) ||
    !isOid(value.oldKnowledgeGitlink) ||
    !isOid(value.newKnowledgeGitlink) ||
    typeof value.targetRemoteReachability !== 'boolean' ||
    !isDigest(value.planDigest) ||
    typeof value.applied !== 'boolean' ||
    typeof value.noOp !== 'boolean' ||
    typeof value.partial !== 'boolean' ||
    !(value.resultingParentCommitSha === null || isOid(value.resultingParentCommitSha)) ||
    !validRecovery(value.recoveryCommand)
  ) return false;
  if (value.state === 'applied') {
    return value.applied === true && value.noOp === false && value.partial === false &&
      isOid(value.resultingParentCommitSha) &&
      value.codeRevision === value.parentBaseRevision &&
      value.oldKnowledgeGitlink !== value.newKnowledgeGitlink &&
      value.projectId !== null && value.sourceRevision !== null &&
      value.targetRemoteReachability === true;
  }
  if (value.state === 'no-op') {
    return value.applied === false && value.noOp === true && value.partial === false &&
      value.resultingParentCommitSha === null &&
      value.oldKnowledgeGitlink === value.newKnowledgeGitlink &&
      value.projectId !== null && value.sourceRevision !== null &&
      value.targetRemoteReachability === true;
  }
  if (value.state !== 'blocked' || typeof value.errorCode !== 'string' ||
      !failureCodes.has(value.errorCode) || value.applied !== false || value.noOp !== false) {
    return false;
  }
  if (value.errorCode === 'PARENT_PIN_PARTIAL') {
    return value.partial === true && value.resultingParentCommitSha === null;
  }
  if (value.errorCode === 'PARENT_PIN_POSTVERIFY_FAILED') {
    return value.partial === true && isOid(value.resultingParentCommitSha);
  }
  return value.partial === false && value.resultingParentCommitSha === null;
}

function decode(raw: string | Uint8Array): { readonly source: string; readonly value: unknown } {
  try {
    const source = typeof raw === 'string' ? raw : decodeUtf8Strict(raw);
    if (Buffer.byteLength(source, 'utf8') > MAX_PARENT_PIN_ARTIFACT_BYTES) return invalid();
    return { source, value: parseJsonStrict(source) };
  } catch {
    return invalid();
  }
}

export function renderParentKnowledgePinPlan(value: ParentKnowledgePinPlan): string {
  if (!validPlan(value)) return invalid();
  return serializeCanonicalJson(value);
}

export function parseParentKnowledgePinPlan(
  raw: string | Uint8Array,
): ParentKnowledgePinPlan {
  const { source, value } = decode(raw);
  if (!validPlan(value) || source !== serializeCanonicalJson(value)) return invalid();
  return value;
}

export function renderParentKnowledgePinResult(value: ParentKnowledgePinResult): string {
  if (!validResult(value)) return invalid();
  return serializeCanonicalJson(value);
}

export function parseParentKnowledgePinResult(
  raw: string | Uint8Array,
): ParentKnowledgePinResult {
  const { source, value } = decode(raw);
  if (!validResult(value) || source !== serializeCanonicalJson(value)) return invalid();
  return value;
}
