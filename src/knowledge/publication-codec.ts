import { serializeCanonicalJson } from './atomic-file.js';
import { decodeUtf8Strict, parseJsonStrict } from './strict-json.js';
import {
  KNOWLEDGE_COMMIT_LINEAGE_SCHEMA_VERSION,
  KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION,
  KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
  PublicationError,
  type KnowledgeCommitLineageV1,
  type KnowledgePublishPlan,
  type KnowledgePublishResult,
} from './publication-types.js';

export const MAX_PUBLISH_ARTIFACT_BYTES = 2 * 1024 * 1024;

function invalid(): never {
  throw new PublicationError('PUBLISH_PLAN_DRIFT');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isDigest(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isOid(value: unknown): boolean {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function isProjectId(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function isRelativePath(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    value === value.normalize('NFC') && !value.startsWith('/') && !value.includes('\\') &&
    !value.includes('\0') && value.split('/').every((part) =>
      part.length > 0 && part !== '.' && part !== '..' && part !== '.git');
}

function isNullableCount(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 0 && value <= 1_000_000_000);
}

function validNumstat(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['added', 'deleted']) &&
    isNullableCount(value.added) && isNullableCount(value.deleted);
}

function validSelectedPath(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, [
    'classification',
    'contentSha256',
    'mode',
    'numstat',
    'reasonCode',
    'relativePath',
    'status',
  ]) && (value.classification === 'always-track' || value.classification === 'policy-track') &&
    (value.contentSha256 === null || isDigest(value.contentSha256)) &&
    (value.mode === null || value.mode === '100644') && validNumstat(value.numstat) &&
    value.reasonCode === 'selected' && isRelativePath(value.relativePath) &&
    (value.status === 'added' || value.status === 'deleted' || value.status === 'modified') &&
    ((value.status === 'deleted' && value.contentSha256 === null && value.mode === null) ||
      (value.status !== 'deleted' && isDigest(value.contentSha256) && value.mode === '100644'));
}

function validForeignEntry(value: unknown, kind: string): boolean {
  return isRecord(value) && exactKeys(value, ['kind', 'relativePath', 'status']) &&
    value.kind === kind && isRelativePath(value.relativePath) &&
    typeof value.status === 'string' && value.status.length >= 1 && value.status.length <= 4;
}

function validForeignBucket(value: unknown, kind: string): boolean {
  return isRecord(value) && exactKeys(value, ['count', 'entries', 'overflow']) &&
    typeof value.count === 'number' && Number.isSafeInteger(value.count) && value.count >= 0 &&
    value.count <= 1_000_000 && Array.isArray(value.entries) && value.entries.length <= 100 &&
    value.entries.every((entry) => validForeignEntry(entry, kind)) &&
    typeof value.overflow === 'boolean' && value.count >= value.entries.length &&
    value.overflow === (value.count > value.entries.length);
}

function validForeign(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['digest', 'staged', 'unstaged', 'untracked']) &&
    isDigest(value.digest) && validForeignBucket(value.staged, 'staged') &&
    validForeignBucket(value.unstaged, 'unstaged') && validForeignBucket(value.untracked, 'untracked');
}

const blockReasons = new Set([
  'DIRTY_INDEX',
  'EMPTY_SELECTION',
  'FOREIGN_STAGED_CHANGE',
  'MANIFEST_REGISTRATION_INVALID',
  'PATH_UNSAFE',
  'ROOT_CHANGE_NOT_ALLOWED',
  'TRACKING_POLICY_VIOLATION',
  'UNMERGED_CHANGE',
]);

function validRegistration(value: unknown, projectId: unknown): boolean {
  return value === null || (isRecord(value) && exactKeys(value, [
    'contentSha256',
    'registeredProjectId',
    'relativePath',
  ]) && isDigest(value.contentSha256) && value.registeredProjectId === projectId &&
    value.relativePath === 'manifest.json');
}

function validPlan(value: unknown): value is KnowledgePublishPlan {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion',
    'projectId',
    'repositoryIdentityDigest',
    'baseRevision',
    'localUpstreamRevision',
    'sourceRevision',
    'codeRevision',
    'selectedPaths',
    'foreignChanges',
    'registrationManifest',
    'trackingPolicyDigest',
    'lineageDigest',
    'indexSnapshotDigest',
    'eligible',
    'blockReasons',
    'planDigest',
  ])) return false;
  const selectedValues = value.selectedPaths;
  const reasonValues = value.blockReasons;
  if (value.schemaVersion !== KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION ||
      !isProjectId(value.projectId) || !isDigest(value.repositoryIdentityDigest) ||
      !isOid(value.baseRevision) ||
      !(value.localUpstreamRevision === null || isOid(value.localUpstreamRevision)) ||
      !isOid(value.sourceRevision) || !isOid(value.codeRevision) ||
      !Array.isArray(selectedValues) || selectedValues.length > 100_000 ||
      !selectedValues.every(validSelectedPath) || !validForeign(value.foreignChanges) ||
      !validRegistration(value.registrationManifest, value.projectId) ||
      !isDigest(value.trackingPolicyDigest) || !isDigest(value.lineageDigest) ||
      !isDigest(value.indexSnapshotDigest) || !isDigest(value.planDigest) ||
      typeof value.eligible !== 'boolean' || !Array.isArray(reasonValues) ||
      !reasonValues.every((reason) => typeof reason === 'string' && blockReasons.has(reason)) ||
      value.eligible !== (reasonValues.length === 0)) return false;
  const paths = selectedValues.map((entry) =>
    isRecord(entry) && typeof entry.relativePath === 'string' ? entry.relativePath : '');
  return paths.every((path, index) => index === 0 || (paths[index - 1] ?? '') < path) &&
    new Set(reasonValues).size === reasonValues.length &&
    reasonValues.every((reason, index) => index === 0 ||
      String(reasonValues[index - 1]) < String(reason));
}

function validForeignCounts(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['staged', 'unstaged', 'untracked']) &&
    [value.staged, value.unstaged, value.untracked].every((count) =>
      typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000);
}

const failureCodes = new Set([
  'PUBLISH_DIRTY_INDEX',
  'PUBLISH_COMMIT_INVALID',
  'PUBLISH_INELIGIBLE',
  'PUBLISH_PARTIAL',
  'PUBLISH_PATH_DRIFT',
  'PUBLISH_PLAN_DRIFT',
  'PUBLISH_POLICY_BLOCKED',
  'PUBLISH_REPOSITORY_DRIFT',
  'PUBLISH_REMOTE_AHEAD',
  'PUBLISH_REMOTE_DIVERGED',
  'PUBLISH_REMOTE_MISSING',
  'PUBLISH_REMOTE_RACE',
  'PUBLISH_REMOTE_UNREADABLE',
  'PUBLISH_REFERENCE_DRIFT',
  'PUBLISH_REPOSITORY_BUSY',
  'PUBLISH_TRANSACTION_FAILED',
]);

function validResult(value: unknown): value is KnowledgePublishResult {
  if (!isRecord(value)) return false;
  const blocked = value.state === 'blocked';
  const pushFailed = value.state === 'push-failed';
  const keys = blocked || pushFailed ? [
    'schemaVersion', 'state', 'projectId', 'baseRevision', 'errorCode', 'foreignCounts',
    'knowledgeRevision', 'localCommitPreserved', 'partial', 'pinRequired', 'recoveryCommand',
    'remoteRevision', 'stagedPaths', 'treeRevision', 'warnings',
  ] : [
    'schemaVersion', 'state', 'projectId', 'baseRevision', 'foreignCounts',
    'knowledgeRevision', 'localCommitPreserved', 'partial', 'pinRequired', 'recoveryCommand',
    'remoteRevision', 'stagedPaths', 'treeRevision', 'warnings',
  ];
  if (!exactKeys(value, keys) || value.schemaVersion !== KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION ||
      (value.state !== 'blocked' && value.state !== 'committed' && value.state !== 'pushed' &&
        value.state !== 'push-failed') || !isProjectId(value.projectId) ||
      !isOid(value.baseRevision) || !validForeignCounts(value.foreignCounts) ||
      !(value.knowledgeRevision === null || isOid(value.knowledgeRevision)) ||
      typeof value.localCommitPreserved !== 'boolean' || typeof value.partial !== 'boolean' ||
      value.pinRequired !== true || !Array.isArray(value.recoveryCommand) ||
      !value.recoveryCommand.every((item) => typeof item === 'string' && item.length <= 128) ||
      !(value.remoteRevision === null || isOid(value.remoteRevision)) ||
      !Array.isArray(value.stagedPaths) || !value.stagedPaths.every(isRelativePath) ||
      !(value.treeRevision === null || isOid(value.treeRevision)) ||
      !Array.isArray(value.warnings) || !value.warnings.every((item) =>
        typeof item === 'string' && item.length <= 160)) return false;
  if (blocked) return typeof value.errorCode === 'string' && failureCodes.has(value.errorCode);
  if (pushFailed) {
    return value.errorCode === 'PUBLISH_PUSH_FAILED' && value.knowledgeRevision !== null &&
      value.treeRevision !== null && value.remoteRevision !== null &&
      value.localCommitPreserved === true && value.partial === true;
  }
  if (value.knowledgeRevision === null || value.treeRevision === null ||
      value.localCommitPreserved !== true || value.partial !== false) return false;
  return value.state === 'committed'
    ? value.remoteRevision === null
    : value.remoteRevision === value.knowledgeRevision;
}

function validLineage(value: unknown): value is KnowledgeCommitLineageV1 {
  return isRecord(value) && exactKeys(value, [
    'schemaVersion',
    'projectId',
    'knowledgeParentRevision',
    'knowledgeTreeRevision',
    'sourceRevision',
    'codeRevision',
    'compilerPackage',
    'compilerPackageIntegrity',
    'compilerVersion',
    'embeddingCompatibilityDigest',
    'modelCompatibilityDigest',
    'planDigest',
    'profileDigest',
    'promptDigest',
    'selectedPathsDigest',
    'trackingPolicyDigest',
  ]) && value.schemaVersion === KNOWLEDGE_COMMIT_LINEAGE_SCHEMA_VERSION &&
    isProjectId(value.projectId) && isOid(value.knowledgeParentRevision) &&
    isOid(value.knowledgeTreeRevision) && isOid(value.sourceRevision) && isOid(value.codeRevision) &&
    value.compilerPackage === 'llm-wiki-compiler' && value.compilerVersion === '1.1.0' &&
    value.compilerPackageIntegrity ===
      'sha512-LJslVmSt8tng8n3t0tw1QEqZJKKD0ualJ/WupdZMCtCzmCNarkP999k6hiNIg5ezvE8B/JQ1C1bUi6eY88Q79A==' &&
    [value.embeddingCompatibilityDigest, value.modelCompatibilityDigest, value.planDigest,
      value.profileDigest, value.promptDigest, value.selectedPathsDigest,
      value.trackingPolicyDigest].every(isDigest);
}

function decode(raw: string | Uint8Array): { readonly source: string; readonly value: unknown } {
  let source: string;
  try {
    source = typeof raw === 'string' ? raw : decodeUtf8Strict(raw);
    if (Buffer.byteLength(source, 'utf8') > MAX_PUBLISH_ARTIFACT_BYTES) return invalid();
    return { source, value: parseJsonStrict(source) };
  } catch {
    return invalid();
  }
}

export function renderKnowledgePublishPlan(value: KnowledgePublishPlan): string {
  if (!validPlan(value)) return invalid();
  return serializeCanonicalJson(value);
}

export function parseKnowledgePublishPlan(raw: string | Uint8Array): KnowledgePublishPlan {
  const { source, value } = decode(raw);
  if (!validPlan(value) || source !== serializeCanonicalJson(value)) return invalid();
  return value;
}

export function renderKnowledgePublishResult(value: KnowledgePublishResult): string {
  if (!validResult(value)) return invalid();
  return serializeCanonicalJson(value);
}

export function parseKnowledgePublishResult(raw: string | Uint8Array): KnowledgePublishResult {
  const { source, value } = decode(raw);
  if (!validResult(value) || source !== serializeCanonicalJson(value)) return invalid();
  return value;
}

export function renderKnowledgeCommitLineageJson(value: KnowledgeCommitLineageV1): string {
  if (!validLineage(value)) return invalid();
  return serializeCanonicalJson(value);
}

export function parseKnowledgeCommitLineage(raw: string | Uint8Array): KnowledgeCommitLineageV1 {
  const { source, value } = decode(raw);
  if (!validLineage(value) || source !== serializeCanonicalJson(value)) return invalid();
  return value;
}
