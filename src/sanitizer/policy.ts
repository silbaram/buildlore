import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { validateProjectId } from '../knowledge/validation.js';
import { showProject } from '../knowledge/workspace.js';
import { SecurityOperationError } from './errors.js';
import { securityRule } from './rules.js';
import {
  SECURITY_POLICY_SCHEMA_VERSION,
  type DataClassification,
  type SecurityClassificationRule,
  type SecurityEgressCapability,
  type SecurityEgressRule,
  type SecurityOverride,
  type SecurityOverrideReason,
  type SecurityPolicy,
  type SecuritySourceKind,
} from './types.js';

const MAX_POLICY_BYTES = 256 * 1024;
const MAX_CLASSIFICATION_RULES = 128;
const MAX_EGRESS_RULES = 32;
const MAX_OVERRIDES = 256;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RULE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const SOURCE_KINDS = new Set<SecuritySourceKind>([
  'compiler-cache',
  'execution',
  'markdown',
  'planning',
  'profile',
  'provider-request',
  'wiki',
]);
const EGRESS_CAPABILITIES = new Set<SecurityEgressCapability>([
  'compile',
  'context',
  'eval-full',
  'query',
  'search',
]);
const CLASSIFICATIONS = new Set<DataClassification>(['internal', 'public', 'restricted']);
const OVERRIDE_REASONS = new Set<SecurityOverrideReason>([
  'documented-placeholder',
  'false-positive-fixture',
  'non-secret-identifier',
]);

export interface LoadedSecurityPolicy {
  readonly digest: `sha256:${string}`;
  readonly policy: SecurityPolicy;
  readonly workspace: string;
}

function fail(projectId: string): never {
  throw new SecurityOperationError('SECURITY_POLICY_INVALID', { projectId });
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseClassification(value: unknown, projectId: string): DataClassification {
  if (typeof value !== 'string' || !CLASSIFICATIONS.has(value as DataClassification)) {
    return fail(projectId);
  }
  return value as DataClassification;
}

function parseSourceKind(value: unknown, projectId: string): SecuritySourceKind {
  if (typeof value !== 'string' || !SOURCE_KINDS.has(value as SecuritySourceKind)) {
    return fail(projectId);
  }
  return value as SecuritySourceKind;
}

function parseClassificationRule(value: unknown, projectId: string): SecurityClassificationRule {
  if (!isRecord(value) || !exactKeys(value, ['classification', 'sourceKind'], ['sourceIdentitySha256'])) {
    return fail(projectId);
  }
  const identity = value.sourceIdentitySha256;
  if (identity !== undefined && (typeof identity !== 'string' || !SHA256_PATTERN.test(identity))) {
    return fail(projectId);
  }
  return {
    classification: parseClassification(value.classification, projectId),
    ...(identity === undefined ? {} : { sourceIdentitySha256: identity }),
    sourceKind: parseSourceKind(value.sourceKind, projectId),
  };
}

function parseEgressRule(value: unknown, projectId: string): SecurityEgressRule {
  if (!isRecord(value) || !exactKeys(value, ['allowedClassifications', 'capability']) ||
      !Array.isArray(value.allowedClassifications) || value.allowedClassifications.length > 2 ||
      typeof value.capability !== 'string' ||
      !EGRESS_CAPABILITIES.has(value.capability as SecurityEgressCapability)) {
    return fail(projectId);
  }
  const allowed = value.allowedClassifications.map((item) => parseClassification(item, projectId));
  if (allowed.includes('restricted') || new Set(allowed).size !== allowed.length) return fail(projectId);
  return {
    allowedClassifications: [...allowed].sort() as Array<'internal' | 'public'>,
    capability: value.capability as SecurityEgressCapability,
  };
}

function validAuditRef(value: string): boolean {
  let hasControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) {
      hasControlCharacter = true;
      break;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        hasControlCharacter = true;
        break;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      hasControlCharacter = true;
      break;
    }
  }
  const credentialLike = /(?:\b(?:Bearer|Basic)[ \t]+|\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,255}\b|\bnpm_[A-Za-z0-9]{20,255}\b|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,255}\b|\bAIza[A-Za-z0-9_-]{32,64}\b|\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|COOKIE|PASSWORD|SECRET)[ \t]*=)/iu.test(value);
  if (value.length < 1 || value.length > 256 || hasControlCharacter || credentialLike ||
      isAbsolute(value) || win32.isAbsolute(value) ||
      /(?:^|[\\/])(?:home|Users)(?:[\\/]|$)/u.test(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.username === '' && parsed.password === '' && parsed.search === '' &&
      parsed.hash === '' && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
  } catch {
    return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value) &&
      !value.includes('://') && !value.includes('@') &&
      !value.includes('?') && !value.includes('#');
  }
}

function parseOverride(value: unknown, projectId: string): SecurityOverride {
  if (!isRecord(value) || !exactKeys(
    value,
    ['reasonCode', 'ruleId', 'sourceIdentitySha256', 'sourceRevisionOrContentSha256'],
    ['auditRef'],
  ) || typeof value.reasonCode !== 'string' ||
      !OVERRIDE_REASONS.has(value.reasonCode as SecurityOverrideReason) ||
      typeof value.ruleId !== 'string' || !RULE_ID_PATTERN.test(value.ruleId) ||
      securityRule(value.ruleId)?.overridable !== true ||
      typeof value.sourceIdentitySha256 !== 'string' ||
      !SHA256_PATTERN.test(value.sourceIdentitySha256) ||
      typeof value.sourceRevisionOrContentSha256 !== 'string' ||
      !PREFIXED_SHA256_PATTERN.test(value.sourceRevisionOrContentSha256) ||
      (value.auditRef !== undefined &&
        (typeof value.auditRef !== 'string' || !validAuditRef(value.auditRef)))) {
    return fail(projectId);
  }
  return {
    ...(value.auditRef === undefined ? {} : { auditRef: value.auditRef }),
    reasonCode: value.reasonCode as SecurityOverrideReason,
    ruleId: value.ruleId,
    sourceIdentitySha256: value.sourceIdentitySha256,
    sourceRevisionOrContentSha256: value.sourceRevisionOrContentSha256 as `sha256:${string}`,
  };
}

export function defaultSecurityPolicy(projectId: string): SecurityPolicy {
  return Object.freeze({
    schemaVersion: SECURITY_POLICY_SCHEMA_VERSION,
    projectId: validateProjectId(projectId),
    defaultClassification: 'restricted' as const,
    classificationRules: Object.freeze([]),
    egressRules: Object.freeze([]),
    overrides: Object.freeze([]),
  });
}

export function parseSecurityPolicy(value: unknown, expectedProjectId: string): SecurityPolicy {
  const projectId = validateProjectId(expectedProjectId);
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion',
    'projectId',
    'defaultClassification',
    'classificationRules',
    'egressRules',
    'overrides',
  ]) || value.schemaVersion !== SECURITY_POLICY_SCHEMA_VERSION || value.projectId !== projectId ||
      !Array.isArray(value.classificationRules) ||
      value.classificationRules.length > MAX_CLASSIFICATION_RULES ||
      !Array.isArray(value.egressRules) || value.egressRules.length > MAX_EGRESS_RULES ||
      !Array.isArray(value.overrides) || value.overrides.length > MAX_OVERRIDES) {
    return fail(projectId);
  }
  const classificationRules = value.classificationRules.map((item) =>
    parseClassificationRule(item, projectId)).sort((left, right) => compareText(
      `${left.sourceKind}:${left.sourceIdentitySha256 ?? '*'}`,
      `${right.sourceKind}:${right.sourceIdentitySha256 ?? '*'}`,
    ));
  const egressRules = value.egressRules.map((item) => parseEgressRule(item, projectId))
    .sort((left, right) => compareText(left.capability, right.capability));
  const overrides = value.overrides.map((item) => parseOverride(item, projectId))
    .sort((left, right) => compareText(
      `${left.sourceIdentitySha256}:${left.sourceRevisionOrContentSha256}:${left.ruleId}`,
      `${right.sourceIdentitySha256}:${right.sourceRevisionOrContentSha256}:${right.ruleId}`,
    ));
  const classificationKeys = classificationRules.map((rule) =>
    `${rule.sourceKind}:${rule.sourceIdentitySha256 ?? '*'}`);
  const egressKeys = egressRules.map((rule) => rule.capability);
  const overrideKeys = overrides.map((override) =>
    `${override.sourceIdentitySha256}:${override.sourceRevisionOrContentSha256}:${override.ruleId}`);
  if (new Set(classificationKeys).size !== classificationKeys.length ||
      new Set(egressKeys).size !== egressKeys.length ||
      new Set(overrideKeys).size !== overrideKeys.length) {
    return fail(projectId);
  }
  return Object.freeze({
    schemaVersion: SECURITY_POLICY_SCHEMA_VERSION,
    projectId,
    defaultClassification: parseClassification(value.defaultClassification, projectId),
    classificationRules: Object.freeze(classificationRules.map((rule) => Object.freeze(rule))),
    egressRules: Object.freeze(egressRules.map((rule) => Object.freeze({
      ...rule,
      allowedClassifications: Object.freeze([...rule.allowedClassifications]),
    }))),
    overrides: Object.freeze(overrides.map((override) => Object.freeze(override))),
  });
}

export function serializeSecurityPolicy(policy: SecurityPolicy): string {
  return serializeCanonicalJson(parseSecurityPolicy(policy, policy.projectId));
}

async function readPolicyFile(path: string, projectId: string): Promise<string | null> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    return fail(projectId);
  }
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_POLICY_BYTES) {
    return fail(projectId);
  }
  try {
    if (await realpath(path) !== path) return fail(projectId);
  } catch {
    return fail(projectId);
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== status.dev || actual.ino !== status.ino ||
        actual.size > MAX_POLICY_BYTES) return fail(projectId);
    const contents = await handle.readFile('utf8');
    if (await realpath(path) !== path) return fail(projectId);
    return contents;
  } catch {
    return fail(projectId);
  } finally {
    try {
      await handle?.close();
    } catch {
      fail(projectId);
    }
  }
}

async function workspaceIdentity(
  workspace: string,
  projectId: string,
): Promise<Readonly<{ dev: number; ino: number }>> {
  try {
    const status = await lstat(workspace);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(workspace) !== workspace) {
      return fail(projectId);
    }
    return { dev: status.dev, ino: status.ino };
  } catch {
    return fail(projectId);
  }
}

export async function readSecurityPolicy(
  knowledgeRoot: string,
  projectId: string,
): Promise<LoadedSecurityPolicy> {
  const canonicalProjectId = validateProjectId(projectId);
  await showProject(knowledgeRoot, canonicalProjectId);
  const workspace = await resolveProjectWorkspace(knowledgeRoot, canonicalProjectId, {
    mustExist: true,
  });
  const initialWorkspace = await workspaceIdentity(workspace, canonicalProjectId);
  const contents = await readPolicyFile(join(workspace, 'security-policy.json'), canonicalProjectId);
  const currentWorkspace = await workspaceIdentity(workspace, canonicalProjectId);
  if (currentWorkspace.dev !== initialWorkspace.dev || currentWorkspace.ino !== initialWorkspace.ino) {
    return fail(canonicalProjectId);
  }
  if (contents === null) {
    const policy = defaultSecurityPolicy(canonicalProjectId);
    return { digest: sha256(serializeSecurityPolicy(policy)), policy, workspace };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents) as unknown;
  } catch {
    return fail(canonicalProjectId);
  }
  const policy = parseSecurityPolicy(decoded, canonicalProjectId);
  const canonical = serializeSecurityPolicy(policy);
  if (contents !== canonical) return fail(canonicalProjectId);
  return { digest: sha256(canonical), policy, workspace };
}

export function classificationFor(
  policy: SecurityPolicy,
  sourceKind: SecuritySourceKind,
  sourceIdentitySha256: string,
): DataClassification {
  const exact = policy.classificationRules.find((rule) =>
    rule.sourceKind === sourceKind && rule.sourceIdentitySha256 === sourceIdentitySha256);
  if (exact !== undefined) return exact.classification;
  const byKind = policy.classificationRules.find((rule) =>
    rule.sourceKind === sourceKind && rule.sourceIdentitySha256 === undefined);
  return byKind?.classification ?? policy.defaultClassification;
}

export function permitsEgress(
  policy: SecurityPolicy,
  capability: SecurityEgressCapability,
  classifications: ReadonlySet<DataClassification>,
): boolean {
  if (classifications.has('restricted')) return false;
  const rule = policy.egressRules.find((candidate) => candidate.capability === capability);
  return rule !== undefined && [...classifications].every((item) =>
    item !== 'restricted' && rule.allowedClassifications.includes(item));
}
