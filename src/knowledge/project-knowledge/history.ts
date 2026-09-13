import { boundedJson, digest, hash, invalid, keys, project, record, text } from './guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from './types.js';
import { decodeUtf8Strict, parseJsonWithLocationsStrict } from '../strict-json.js';

export const MAX_KNOWLEDGE_GENERATION_BYTES = 16 * 1024 * 1024;
export const MAX_KNOWLEDGE_HISTORY_RECORD_BYTES = MAX_KNOWLEDGE_GENERATION_BYTES + 4096;
export const MAX_KNOWLEDGE_HISTORY_REFERENCE_BYTES = 4096;

export interface KnowledgeHistoryReferenceV1 {
  readonly schemaVersion: 'buildlore.knowledge-history-reference.v1';
  readonly projectId: string;
  readonly headGenerationDigest: KnowledgeDigest;
  readonly genesisGenerationDigest: KnowledgeDigest;
  /** Canonical positive decimal, not a JavaScript number or an admission quota. */
  readonly generationCount: string;
  readonly historyDigest: KnowledgeDigest;
}

export interface KnowledgeGenerationRecordV1 {
  readonly schemaVersion: 'buildlore.knowledge-generation-record.v1';
  readonly projectId: string;
  readonly generationDigest: KnowledgeDigest;
  readonly parentGenerationDigest: KnowledgeDigest | null;
  readonly generation: KnowledgeGenerationV1;
  readonly recordDigest: KnowledgeDigest;
}

/** A structurally bounded record is NOT yet semantically replayed or screened. */
export interface ParsedKnowledgeGenerationRecordV1 extends Omit<KnowledgeGenerationRecordV1, 'generation'> {
  readonly generation: Readonly<Record<string, unknown>>;
}

export function parseKnowledgeHistoryReference(value: unknown, expectedProjectId: string): KnowledgeHistoryReferenceV1 {
  const input = record(boundedJson(value));
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_KNOWLEDGE_HISTORY_REFERENCE_BYTES) invalid();
  keys(input, ['schemaVersion', 'projectId', 'headGenerationDigest', 'genesisGenerationDigest', 'generationCount', 'historyDigest']);
  if (input.schemaVersion !== 'buildlore.knowledge-history-reference.v1') invalid();
  const generationCount = text(input.generationCount, 128);
  if (!/^[1-9][0-9]{0,127}$/u.test(generationCount)) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-history-reference.v1' as const,
    projectId: project(input.projectId, expectedProjectId),
    headGenerationDigest: hash(input.headGenerationDigest),
    genesisGenerationDigest: hash(input.genesisGenerationDigest), generationCount };
  if (input.historyDigest !== digest(basis)) invalid();
  return Object.freeze({ ...basis, historyDigest: digest(basis) });
}

export function appendKnowledgeHistoryReference(previous: KnowledgeHistoryReferenceV1 | null,
  generationDigest: KnowledgeDigest, projectId: string): KnowledgeHistoryReferenceV1 {
  const baseline = previous === null ? null : parseKnowledgeHistoryReference(previous, projectId);
  const basis = { schemaVersion: 'buildlore.knowledge-history-reference.v1' as const, projectId,
    headGenerationDigest: hash(generationDigest),
    genesisGenerationDigest: baseline?.genesisGenerationDigest ?? hash(generationDigest),
    generationCount: ((baseline === null ? 0n : BigInt(baseline.generationCount)) + 1n).toString() };
  return parseKnowledgeHistoryReference({ ...basis, historyDigest: digest(basis) }, projectId);
}

export function createKnowledgeGenerationRecord(generation: KnowledgeGenerationV1): KnowledgeGenerationRecordV1 {
  // Validate the payload independently. The wrapper must not consume its depth,
  // node or 16 MiB budget, nor expand any of those existing payload limits.
  boundedJson(generation);
  const basis = { schemaVersion: 'buildlore.knowledge-generation-record.v1' as const,
    projectId: generation.projectId, generationDigest: generation.generationDigest,
    parentGenerationDigest: generation.baselineGenerationDigest, generation };
  const result = Object.freeze({ ...basis, recordDigest: digest(basis) });
  parseKnowledgeGenerationRecord(Buffer.from(JSON.stringify(result)), generation.projectId, generation.generationDigest);
  return result;
}

export function parseKnowledgeGenerationRecord(bytes: Uint8Array, expectedProjectId: string,
  expectedGenerationDigest: KnowledgeDigest): ParsedKnowledgeGenerationRecordV1 {
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_KNOWLEDGE_HISTORY_RECORD_BYTES) invalid();
  let value: unknown;
  try {
    value = parseJsonWithLocationsStrict(decodeUtf8Strict(bytes), {
      maxDepth: 25, maxNodes: 300_016, maxArrayItems: 8192,
      maxObjectMembers: 64, maxStringScalars: 262_144,
    }).value;
  } catch { return invalid(); }
  const input = record(value);
  keys(input, ['schemaVersion', 'projectId', 'generationDigest', 'parentGenerationDigest', 'generation', 'recordDigest']);
  if (input.schemaVersion !== 'buildlore.knowledge-generation-record.v1') invalid();
  const generation = record(boundedJson(input.generation));
  const generationDigest = hash(input.generationDigest);
  const parentGenerationDigest = input.parentGenerationDigest === null ? null : hash(input.parentGenerationDigest);
  if (generationDigest !== hash(expectedGenerationDigest) || generation.generationDigest !== generationDigest ||
      generation.projectId !== expectedProjectId || generation.baselineGenerationDigest !== parentGenerationDigest) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-generation-record.v1' as const,
    projectId: project(input.projectId, expectedProjectId), generationDigest, parentGenerationDigest, generation };
  if (input.recordDigest !== digest(basis)) invalid();
  return Object.freeze({ ...basis, recordDigest: hash(input.recordDigest) });
}
