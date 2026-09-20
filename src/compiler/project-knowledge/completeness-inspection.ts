import { choice, digest, hash, invalid, keys, project, record, text } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeEvidenceV1, KnowledgeRecordV1, KnowledgeSourceV1 } from '../../knowledge/project-knowledge/types.js';
import { KnowledgeAuthoringInspectionBudgetError } from './authoring-inspection.js';
import { completenessBinding, completenessJson, type KnowledgeCompletenessExchange } from './completeness.js';

const MAX_BYTES = 1_048_576;
export const COMPLETENESS_MATERIAL_REQUEST = 'buildlore.knowledge-completeness-material-request.v1';
export type CompletenessMaterialCollection = 'sources' | 'evidence' | 'baseline-records' | 'baseline-evidence';
export interface KnowledgeCompletenessMaterialRequest {
  readonly schemaVersion: typeof COMPLETENESS_MATERIAL_REQUEST;
  readonly projectId: string;
  readonly collection: CompletenessMaterialCollection;
  readonly cursor: string | null;
  readonly limit: number;
  readonly maxBytes: number;
}
export interface KnowledgeCompletenessMaterialInspection {
  readonly schemaVersion: 'buildlore.knowledge-completeness-material.v1';
  readonly projectId: string;
  readonly exchangeDigest: KnowledgeDigest;
  readonly collection: CompletenessMaterialCollection;
  readonly entries: readonly (KnowledgeSourceV1 | KnowledgeEvidenceV1 | KnowledgeRecordV1)[];
  readonly total: number;
  readonly cursor: string | null;
  readonly status: 'ready' | 'empty' | 'item-too-large';
  readonly minimumRequiredBytes: number | null;
  readonly byteBudget: number;
  readonly resultDigest: KnowledgeDigest;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
export function parseKnowledgeCompletenessMaterialRequest(value: unknown, projectId: string): KnowledgeCompletenessMaterialRequest {
  const input = completenessJson(value);
  keys(input, ['schemaVersion', 'projectId', 'collection', ...['cursor', 'limit', 'maxBytes'].filter(k => Object.hasOwn(input, k))]);
  if (input.schemaVersion !== COMPLETENESS_MATERIAL_REQUEST) invalid();
  const cursor = input.cursor === undefined || input.cursor === null ? null : text(input.cursor, 96);
  if (cursor !== null && !/^material-(?:0|[1-9][0-9]{0,4})-[0-9a-f]{64}$/u.test(cursor)) invalid();
  return Object.freeze({ schemaVersion: COMPLETENESS_MATERIAL_REQUEST, projectId: project(input.projectId, projectId),
    collection: choice(input.collection, ['sources', 'evidence', 'baseline-records', 'baseline-evidence']), cursor,
    limit: integer(input.limit, 10, 1, 50), maxBytes: integer(input.maxBytes, 65_536, 8192, MAX_BYTES) });
}

/** A projection, not a replacement exchange. Its digest still identifies the full frozen inputs. */
export function knowledgeCompletenessExchangeView(exchange: KnowledgeCompletenessExchange): Readonly<Record<string, unknown>> {
  const { sources, evidence, ...snapshot } = exchange.baseExchange.snapshot;
  const { previousRecords, previousEvidence, snapshot: omitted, ...base } = exchange.baseExchange;
  void omitted;
  return Object.freeze({ schemaVersion: exchange.policyVersion === 'completeness-v2'
    ? 'buildlore.knowledge-completeness-exchange-view.v2' : 'buildlore.knowledge-completeness-exchange-view.v1', ...completenessBinding(exchange),
    authoringQuestions: exchange.authoringQuestions, policyVersion: exchange.policyVersion,
    roleBoundary: exchange.roleBoundary, instructions: exchange.instructions,
    baseExchange: Object.freeze({ ...base, snapshot, materialCounts: Object.freeze({ sources: sources.length,
      evidence: evidence.length, 'baseline-records': previousRecords.length, 'baseline-evidence': previousEvidence.length }) }),
    inspection: Object.freeze({ schemaVersion: COMPLETENESS_MATERIAL_REQUEST, maximumBytes: MAX_BYTES,
      instructions: 'Use snapshot-bound inspect for sources, evidence, baseline-records and baseline-evidence. Follow every returned cursor; omitted arrays are not empty or inspected. Question-specific sources/find/read/coverage inspection remains available.' }) });
}

/** Called only through a prepared, sanitizer-bound session. Never clips or skips an item. */
export function inspectKnowledgeCompletenessMaterial(exchange: KnowledgeCompletenessExchange,
  request: KnowledgeCompletenessMaterialRequest): KnowledgeCompletenessMaterialInspection {
  if (request.projectId !== exchange.projectId) invalid();
  const collections = { sources: exchange.baseExchange.snapshot.sources, evidence: exchange.baseExchange.snapshot.evidence,
    'baseline-records': exchange.baseExchange.previousRecords, 'baseline-evidence': exchange.baseExchange.previousEvidence };
  const entries = collections[request.collection];
  const cursorFor = (offset: number): string => `material-${String(offset)}-${digest({ exchangeDigest: exchange.exchangeDigest,
    collection: request.collection, offset }).slice(7)}`;
  const start = request.cursor === null ? 0 : Number(request.cursor.split('-')[1]);
  if (start > entries.length || request.cursor !== null && request.cursor !== cursorFor(start)) invalid();
  const build = (selected: KnowledgeCompletenessMaterialInspection['entries'], end: number,
    status: KnowledgeCompletenessMaterialInspection['status'], minimumRequiredBytes: number | null = null): KnowledgeCompletenessMaterialInspection => {
    const basis = { schemaVersion: 'buildlore.knowledge-completeness-material.v1' as const, projectId: exchange.projectId,
      exchangeDigest: exchange.exchangeDigest, collection: request.collection, entries: Object.freeze([...selected]),
      total: entries.length, cursor: end < entries.length ? cursorFor(end) : null, status, minimumRequiredBytes, byteBudget: request.maxBytes };
    return Object.freeze({ ...basis, resultDigest: digest(basis) });
  };
  const minimumBudget = (result: KnowledgeCompletenessMaterialInspection): number => {
    let size = Buffer.byteLength(JSON.stringify(result));
    for (;;) {
      const measured = Buffer.byteLength(JSON.stringify({ ...result, byteBudget: size }));
      if (measured <= size) return size;
      size = measured;
    }
  };
  let result = build([], start, 'empty');
  for (let offset = start; offset < Math.min(start + request.limit, entries.length); offset += 1) {
    const entry = entries[offset] ?? invalid(), candidate = build([...result.entries, entry], offset + 1, 'ready');
    if (Buffer.byteLength(JSON.stringify(candidate)) > request.maxBytes) {
      if (result.entries.length === 0) result = build([], start, 'item-too-large', minimumBudget(candidate));
      break;
    }
    result = candidate;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > request.maxBytes) {
    throw new KnowledgeAuthoringInspectionBudgetError(request.maxBytes, minimumBudget(result));
  }
  return result;
}

/** Decode validated cursor metadata before security screening, without treating its identity as prose. */
export function completenessMaterialScreeningValue(request: KnowledgeCompletenessMaterialRequest): unknown {
  const cursor = request.cursor?.split('-');
  return { ...request, cursor: cursor === undefined ? null : { offset: Number(cursor[1]), digest: hash(`sha256:${cursor[2] ?? invalid()}`) } };
}

export function isCompletenessMaterialRequest(value: unknown): boolean {
  return record(value).schemaVersion === COMPLETENESS_MATERIAL_REQUEST;
}
