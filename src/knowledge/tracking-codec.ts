import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from './atomic-file.js';
import { decodeUtf8Strict, parseJsonStrict } from './strict-json.js';
import { LLM_WIKI_COMPILER_OUTPUT_INVENTORY } from './tracking-inventory.js';
import { KNOWLEDGE_TRACKING_POLICY } from './tracking-policy.js';
import {
  COMPILER_OUTPUT_INVENTORY_SCHEMA_VERSION,
  KNOWLEDGE_TRACKING_POLICY_SCHEMA_VERSION,
  LLM_WIKI_COMPILER_COMMIT,
  LLM_WIKI_COMPILER_INTEGRITY,
  LLM_WIKI_COMPILER_PACKAGE,
  LLM_WIKI_COMPILER_VERSION,
  TrackingContractError,
  type CompilerInventoryEntry,
  type CompilerOutputInventoryV1,
  type KnowledgeTrackingPolicyV1,
  type Sha256Digest,
  type TrackingClassification,
  type TrackingDisposition,
  type TrackingEntry,
  type TrackingMergeRisk,
  type TrackingPortability,
  type TrackingProducer,
  type TrackingRegenerationSafety,
  type TrackingReproducibility,
  type TrackingSecretOrAuthorityRisk,
} from './tracking-types.js';

export const MAX_TRACKING_POLICY_BYTES = 256 * 1024;
export const MAX_COMPILER_INVENTORY_BYTES = 256 * 1024;

function invalidPolicy(): never {
  throw new TrackingContractError('TRACKING_POLICY_INVALID');
}

function invalidInventory(): never {
  throw new TrackingContractError('TRACKING_INVENTORY_INVALID');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function safeBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    !containsControl(value);
}

function parseClassification(value: unknown): TrackingClassification {
  switch (value) {
    case 'always-ignore':
    case 'always-track':
    case 'policy-track':
      return value;
    default:
      return invalidPolicy();
  }
}

function parseDisposition(value: unknown): TrackingDisposition {
  switch (value) {
    case 'exclude':
    case 'include':
      return value;
    default:
      return invalidPolicy();
  }
}

function parseProducer(value: unknown): TrackingProducer {
  switch (value) {
    case 'buildlore':
    case 'llm-wiki-compiler@1.1.0':
    case 'shared':
      return value;
    default:
      return invalidPolicy();
  }
}

function parsePortability(value: unknown): TrackingPortability {
  switch (value) {
    case 'machine-local':
    case 'portable':
      return value;
    default:
      return invalidPolicy();
  }
}

function parseReproducibility(value: unknown): TrackingReproducibility {
  switch (value) {
    case 'authoritative':
    case 'derived':
    case 'ephemeral':
    case 'incremental':
    case 'regenerable':
      return value;
    default:
      return invalidPolicy();
  }
}

function parseRisk(value: unknown): TrackingSecretOrAuthorityRisk {
  switch (value) {
    case 'authority':
    case 'credential':
    case 'local-state':
    case 'none':
      return value;
    default:
      return invalidPolicy();
  }
}

function parseMergeRisk(value: unknown): TrackingMergeRisk {
  switch (value) {
    case 'low':
    case 'review-required':
    case 'unsafe':
      return value;
    default:
      return invalidPolicy();
  }
}

function parseRegenerationSafety(value: unknown): TrackingRegenerationSafety {
  switch (value) {
    case 'from-tracked-state':
    case 'must-not-publish':
    case 'not-regenerable':
    case 'safe-to-regenerate':
      return value;
    default:
      return invalidPolicy();
  }
}

function validPattern(pattern: string): boolean {
  if (!/^[A-Za-z0-9._*~/-]+$/u.test(pattern) || pattern.startsWith('/') ||
      pattern.includes('//')) return false;
  return pattern.split('/').every((segment) => segment !== '' && segment !== '.' &&
    segment !== '..' && (!segment.includes('**') || segment === '**'));
}

function decodeTrackingEntry(value: unknown): TrackingEntry {
  if (!isRecord(value) || !exactKeys(value, [
    'classification',
    'defaultDisposition',
    'id',
    'mergeRisk',
    'pattern',
    'portability',
    'producer',
    'rationale',
    'regenerationSafety',
    'reproducibility',
    'secretOrAuthorityRisk',
  ])) return invalidPolicy();
  if (!safeBoundedText(value.id, 64) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) ||
      !safeBoundedText(value.pattern, 160) || !validPattern(value.pattern) ||
      !safeBoundedText(value.rationale, 160)) return invalidPolicy();
  const classification = parseClassification(value.classification);
  const defaultDisposition = parseDisposition(value.defaultDisposition);
  if ((classification === 'always-track') !== (defaultDisposition === 'include')) {
    return invalidPolicy();
  }
  return {
    classification,
    defaultDisposition,
    id: value.id,
    mergeRisk: parseMergeRisk(value.mergeRisk),
    pattern: value.pattern,
    portability: parsePortability(value.portability),
    producer: parseProducer(value.producer),
    rationale: value.rationale,
    regenerationSafety: parseRegenerationSafety(value.regenerationSafety),
    reproducibility: parseReproducibility(value.reproducibility),
    secretOrAuthorityRisk: parseRisk(value.secretOrAuthorityRisk),
  };
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function parseDigest(value: unknown, invalid: () => never): Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) return invalid();
  return value as Sha256Digest;
}

function decodeSource(raw: string | Uint8Array, maximum: number, invalid: () => never): string {
  let source: string;
  try {
    source = typeof raw === 'string' ? raw : decodeUtf8Strict(raw);
  } catch {
    return invalid();
  }
  if (source.length === 0 || Buffer.byteLength(source, 'utf8') > maximum) return invalid();
  return source;
}

function assertEntryOrder(entries: readonly TrackingEntry[]): void {
  const rank: Readonly<Record<TrackingClassification, number>> = {
    'always-ignore': 0,
    'always-track': 1,
    'policy-track': 2,
  };
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous === undefined || current === undefined ||
        rank[previous.classification] > rank[current.classification] ||
        (previous.classification === current.classification && previous.id >= current.id)) {
      return invalidPolicy();
    }
  }
}

function inventoryClassificationRank(classification: TrackingClassification): number {
  switch (classification) {
    case 'always-ignore':
      return 0;
    case 'always-track':
      return 1;
    case 'policy-track':
      return 2;
  }
}

export function renderKnowledgeTrackingPolicy(
  policy: KnowledgeTrackingPolicyV1 = KNOWLEDGE_TRACKING_POLICY,
): string {
  return serializeCanonicalJson(policy);
}

export function parseKnowledgeTrackingPolicy(
  raw: string | Uint8Array,
): KnowledgeTrackingPolicyV1 {
  const source = decodeSource(raw, MAX_TRACKING_POLICY_BYTES, invalidPolicy);
  let value: unknown;
  try {
    value = parseJsonStrict(source);
  } catch {
    return invalidPolicy();
  }
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion',
    'upstreamPackage',
    'exactVersion',
    'packageIntegrity',
    'packageCommit',
    'inventoryDigest',
    'entries',
    'policyDigest',
  ]) || value.schemaVersion !== KNOWLEDGE_TRACKING_POLICY_SCHEMA_VERSION ||
      value.upstreamPackage !== LLM_WIKI_COMPILER_PACKAGE ||
      value.exactVersion !== LLM_WIKI_COMPILER_VERSION ||
      value.packageIntegrity !== LLM_WIKI_COMPILER_INTEGRITY ||
      value.packageCommit !== LLM_WIKI_COMPILER_COMMIT || !Array.isArray(value.entries) ||
      value.entries.length === 0 || value.entries.length > 64) return invalidPolicy();
  const inventoryDigest = parseDigest(value.inventoryDigest, invalidPolicy);
  if (inventoryDigest !== LLM_WIKI_COMPILER_OUTPUT_INVENTORY.inventoryDigest) {
    return invalidPolicy();
  }
  const decodedEntries = value.entries.map(decodeTrackingEntry);
  assertEntryOrder(decodedEntries);
  if (new Set(decodedEntries.map(({ id }) => id)).size !== decodedEntries.length ||
      new Set(decodedEntries.map(({ pattern }) => pattern)).size !== decodedEntries.length) {
    return invalidPolicy();
  }
  const base: Omit<KnowledgeTrackingPolicyV1, 'policyDigest'> = {
    schemaVersion: KNOWLEDGE_TRACKING_POLICY_SCHEMA_VERSION,
    upstreamPackage: LLM_WIKI_COMPILER_PACKAGE,
    exactVersion: LLM_WIKI_COMPILER_VERSION,
    packageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
    packageCommit: LLM_WIKI_COMPILER_COMMIT,
    inventoryDigest,
    entries: decodedEntries,
  };
  const policyDigest = parseDigest(value.policyDigest, invalidPolicy);
  if (policyDigest !== sha256(serializeCanonicalJson(base))) return invalidPolicy();
  const decoded: KnowledgeTrackingPolicyV1 = { ...base, policyDigest };
  if (source !== renderKnowledgeTrackingPolicy(decoded)) return invalidPolicy();
  return Object.freeze({
    ...decoded,
    entries: Object.freeze(decodedEntries.map((entry) => Object.freeze(entry))),
  });
}

function decodeInventoryEntry(value: unknown): CompilerInventoryEntry {
  if (!isRecord(value) || !exactKeys(value, [
    'classification',
    'familyId',
    'operation',
    'policyEntryId',
    'projectRelativePath',
    'sourceEvidence',
  ]) || !safeBoundedText(value.familyId, 64) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.familyId) ||
      !safeBoundedText(value.operation, 96) || !safeBoundedText(value.policyEntryId, 64) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.policyEntryId) ||
      !safeBoundedText(value.projectRelativePath, 256) ||
      !validPattern(value.projectRelativePath) || value.projectRelativePath.includes('*') ||
      !safeBoundedText(value.sourceEvidence, 128) ||
      !/^src\/[a-z0-9./-]+\.ts$/u.test(value.sourceEvidence)) return invalidInventory();
  let classification: TrackingClassification;
  try {
    classification = parseClassification(value.classification);
  } catch {
    return invalidInventory();
  }
  return {
    classification,
    familyId: value.familyId,
    operation: value.operation,
    policyEntryId: value.policyEntryId,
    projectRelativePath: value.projectRelativePath,
    sourceEvidence: value.sourceEvidence,
  };
}

export function parseCompilerOutputInventory(
  raw: string | Uint8Array,
): CompilerOutputInventoryV1 {
  const source = decodeSource(raw, MAX_COMPILER_INVENTORY_BYTES, invalidInventory);
  let value: unknown;
  try {
    value = parseJsonStrict(source);
  } catch {
    return invalidInventory();
  }
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion',
    'upstreamPackage',
    'exactVersion',
    'packageIntegrity',
    'packageCommit',
    'entries',
    'inventoryDigest',
  ]) || value.schemaVersion !== COMPILER_OUTPUT_INVENTORY_SCHEMA_VERSION ||
      value.upstreamPackage !== LLM_WIKI_COMPILER_PACKAGE ||
      value.exactVersion !== LLM_WIKI_COMPILER_VERSION ||
      value.packageIntegrity !== LLM_WIKI_COMPILER_INTEGRITY ||
      value.packageCommit !== LLM_WIKI_COMPILER_COMMIT || !Array.isArray(value.entries) ||
      value.entries.length === 0 || value.entries.length > 64) return invalidInventory();
  const decodedEntries = value.entries.map(decodeInventoryEntry);
  for (let index = 1; index < decodedEntries.length; index += 1) {
    const previous = decodedEntries[index - 1];
    const current = decodedEntries[index];
    if (previous === undefined || current === undefined ||
        inventoryClassificationRank(previous.classification) >
          inventoryClassificationRank(current.classification) ||
        (previous.classification === current.classification && previous.familyId >= current.familyId)) {
      return invalidInventory();
    }
  }
  if (new Set(decodedEntries.map(({ familyId }) => familyId)).size !== decodedEntries.length) {
    return invalidInventory();
  }
  const base: Omit<CompilerOutputInventoryV1, 'inventoryDigest'> = {
    schemaVersion: COMPILER_OUTPUT_INVENTORY_SCHEMA_VERSION,
    upstreamPackage: LLM_WIKI_COMPILER_PACKAGE,
    exactVersion: LLM_WIKI_COMPILER_VERSION,
    packageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
    packageCommit: LLM_WIKI_COMPILER_COMMIT,
    entries: decodedEntries,
  };
  const inventoryDigest = parseDigest(value.inventoryDigest, invalidInventory);
  if (inventoryDigest !== sha256(serializeCanonicalJson(base))) return invalidInventory();
  const decoded: CompilerOutputInventoryV1 = { ...base, inventoryDigest };
  if (source !== serializeCanonicalJson(decoded)) return invalidInventory();
  return Object.freeze({
    ...decoded,
    entries: Object.freeze(decodedEntries.map((entry) => Object.freeze(entry))),
  });
}
