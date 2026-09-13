import { boundedJson, choice, compare, digest, identifier, invalid, keys, portablePath, project, sha256, record, text } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeEvidenceV1, KnowledgeSnapshotV1 } from '../../knowledge/project-knowledge/types.js';
import type { KnowledgeAuthoringQuestion } from './authoring-questions.js';
import { createKnowledgeEvidenceCoverage } from './citation-support.js';
import { DEVELOPMENT_HANDOFF_INSPECTION_GUIDE } from './development-handoff.js';
import type { DevelopmentMemoryInspectionV1 } from './development-memory-inspection.js';

export const KNOWLEDGE_INSPECTION_REQUEST_VERSION = 'buildlore.knowledge-authoring-inspection-request.v1';
const MAX_INSPECTION_BYTES = 1_048_576;

export interface KnowledgeAuthoringInspectionBudget {
  readonly schemaVersion: 'buildlore.knowledge-authoring-inspection-budget.v1';
  readonly reason: 'response-metadata-too-large';
  readonly byteBudget: number;
  readonly minimumRequiredBytes: number;
  readonly maximumBytes: number;
  readonly retryable: boolean;
}

/** Bounded recovery data only; never reflects source, question or query content. */
export class KnowledgeAuthoringInspectionBudgetError extends Error {
  readonly code = 'KNOWLEDGE_INSPECTION_BUDGET_EXCEEDED';
  readonly details: KnowledgeAuthoringInspectionBudget;

  constructor(byteBudget: number, minimumRequiredBytes: number) {
    super('Inspection response metadata exceeds the requested byte budget.');
    this.name = 'KnowledgeAuthoringInspectionBudgetError';
    this.details = Object.freeze({ schemaVersion: 'buildlore.knowledge-authoring-inspection-budget.v1',
      reason: 'response-metadata-too-large', byteBudget, minimumRequiredBytes,
      maximumBytes: MAX_INSPECTION_BYTES, retryable: minimumRequiredBytes <= MAX_INSPECTION_BYTES });
  }
}

export interface KnowledgeAuthoringInspectionRequest {
  readonly schemaVersion: typeof KNOWLEDGE_INSPECTION_REQUEST_VERSION;
  readonly projectId: string;
  readonly questionId: string;
  readonly operation: 'sources' | 'find' | 'read' | 'coverage';
  readonly sourceRef: string | null;
  readonly contains: string | null;
  readonly cursor: string | null;
  readonly limit: number;
  readonly maxBytes: number;
}

export interface KnowledgeAuthoringSourceSummary {
  readonly sourceId: string;
  readonly sourceRef: string;
  readonly sourceContentDigest: KnowledgeDigest;
  readonly sanitizedContentDigest: KnowledgeDigest;
  readonly repositoryRevision: string | null;
  readonly sourceRevision: string | null;
  readonly codeRevision: string | null;
  readonly format: 'markdown' | 'json';
  readonly evidenceCount: number;
}

export interface KnowledgeAuthoringInspection {
  readonly schemaVersion: 'buildlore.knowledge-authoring-inspection.v1';
  readonly projectId: string;
  readonly exchangeDigest: KnowledgeDigest;
  readonly snapshotDigest: KnowledgeDigest;
  readonly question: KnowledgeAuthoringQuestion;
  readonly operation: KnowledgeAuthoringInspectionRequest['operation'];
  readonly sourceRef: string | null;
  readonly contains: string | null;
  readonly entries: readonly KnowledgeAuthoringInspectionEntry[];
  readonly total: number;
  readonly cursor: string | null;
  readonly status: 'ready' | 'empty' | 'item-too-large';
  readonly minimumRequiredBytes: number | null;
  readonly byteBudget: number;
  readonly instructions: readonly string[];
  readonly egress: 'none';
  readonly processSpawned: false;
  readonly resultDigest: KnowledgeDigest;
  readonly requirementSelection?: 'selected' | 'unassessed';
  readonly developmentMemoryInspection?: DevelopmentMemoryInspectionV1;
}

export interface KnowledgeAuthoringRequirementSummary {
  readonly requirementId: string;
  readonly status: 'available' | 'heading-only' | 'source-not-selected' | 'detail-unavailable';
  readonly evidenceIds: readonly KnowledgeDigest[];
  readonly semanticReviewRequired: true;
}

type KnowledgeAuthoringInspectionEntry = KnowledgeAuthoringSourceSummary | KnowledgeEvidenceV1 | KnowledgeAuthoringRequirementSummary;

function integer(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}

export function parseKnowledgeAuthoringInspectionRequest(value: unknown, projectId: string): KnowledgeAuthoringInspectionRequest {
  const input = record(boundedJson(value));
  keys(input, ['schemaVersion', 'projectId', 'questionId', 'operation',
    ...['sourceRef', 'contains', 'cursor', 'limit', 'maxBytes'].filter(key => Object.hasOwn(input, key))]);
  if (input.schemaVersion !== KNOWLEDGE_INSPECTION_REQUEST_VERSION) invalid();
  const operation = choice(input.operation, ['sources', 'find', 'read', 'coverage']);
  const sourceRef = input.sourceRef === undefined || input.sourceRef === null ? null : portablePath(input.sourceRef);
  const contains = input.contains === undefined || input.contains === null ? null : text(input.contains, 256);
  const cursor = input.cursor === undefined || input.cursor === null ? null : text(input.cursor, 96);
  if ((operation === 'sources' && sourceRef !== null) || (operation === 'find' && contains === null) ||
      (operation === 'read' && (sourceRef === null || contains !== null)) ||
      (operation === 'coverage' && (sourceRef !== null || contains !== null))) invalid();
  if (cursor !== null && !/^inspection-(?:0|[1-9][0-9]{0,4})-[0-9a-f]{64}$/u.test(cursor)) invalid();
  return Object.freeze({ schemaVersion: KNOWLEDGE_INSPECTION_REQUEST_VERSION, projectId: project(input.projectId, projectId),
    questionId: identifier(input.questionId), operation, sourceRef, contains, cursor,
    limit: integer(input.limit, 10, 50), maxBytes: integer(input.maxBytes, 65_536, MAX_INSPECTION_BYTES, 8192) });
}

function minimumBudget(result: KnowledgeAuthoringInspection): number {
  // A retry can add digits to byteBudget; the digest changes but keeps its fixed length.
  let minimum = Buffer.byteLength(JSON.stringify(result));
  let measured = Buffer.byteLength(JSON.stringify({ ...result, byteBudget: minimum }));
  while (measured > minimum) {
    minimum = measured;
    measured = Buffer.byteLength(JSON.stringify({ ...result, byteBudget: minimum }));
  }
  return minimum;
}

/** Keep the existing byte budget when exposing the reviewed profile's full content links. */
export function withDevelopmentMemoryInspection(result: KnowledgeAuthoringInspection,
  inspection: DevelopmentMemoryInspectionV1 | null): KnowledgeAuthoringInspection {
  if (inspection === null || result.operation !== 'coverage') return result;
  const { resultDigest: previousDigest, ...original } = result;
  void previousDigest;
  const basis = { ...original, developmentMemoryInspection: inspection };
  const exposed = Object.freeze({ ...basis, resultDigest: digest(basis) });
  if (Buffer.byteLength(JSON.stringify(exposed)) > exposed.byteBudget) {
    throw new KnowledgeAuthoringInspectionBudgetError(exposed.byteBudget, minimumBudget(exposed));
  }
  return exposed;
}

const INSTRUCTIONS = Object.freeze([
  'Read-only inspection of selected, sanitized snapshot sources. No checkout-wide discovery, execution or semantic ranking is performed. Empty matches do not prove feature absence.',
  'Start with the question and documented intent. Use sources to locate files; find is a case-sensitive literal match in evidence (or in paths for sources), not a call-graph proof. Read the file and follow relevant named callees/callers using further find/read requests.',
  'Compare implementation, configuration, error handling and related tests with the documents. Explain responsibilities and end-to-end behavior, document/code differences and unknowns; do not merely list functions.',
  'Locators address sanitized projected source lines, not necessarily original code-file lines. Preserve sourceContentDigest, sanitizedContentDigest, evidenceId and any explicit origin. repositoryRevision alone does not prove working-tree content or test execution.',
  'Cite inspected evidence through proposal facts and map the resulting claims in questionAnswers. Code inspection is not execution; test definitions are not passing results. A design rationale absent from documents/history remains unknown, not inferred fact.',
  'Sources may contain redacted gaps or excluded evidence. Do not reconstruct hidden content. An independent reviewer must assess answer completeness and both sides of document/code disagreements before finalization.',
  ...DEVELOPMENT_HANDOFF_INSPECTION_GUIDE,
]);

/** Internal pure projection. Only the session service exposes it after sanitizer and drift checks. */
export function inspectKnowledgeAuthoringSources(snapshot: KnowledgeSnapshotV1, exchangeDigest: KnowledgeDigest,
  questions: readonly KnowledgeAuthoringQuestion[], request: KnowledgeAuthoringInspectionRequest): KnowledgeAuthoringInspection {
  if (request.projectId !== snapshot.projectId) invalid();
  const question = questions.find(item => item.id === request.questionId) ?? invalid();
  if (request.sourceRef !== null && !snapshot.sources.some(source => source.sourceRef === request.sourceRef)) invalid();
  const counts = new Map<string, number>();
  for (const evidence of snapshot.evidence) counts.set(evidence.sourceId, (counts.get(evidence.sourceId) ?? 0) + 1);
  const requirements = (): readonly KnowledgeAuthoringRequirementSummary[] => {
    if (question.contentProfile !== undefined && question.requirements.length === 0) return [];
    const coverage = createKnowledgeEvidenceCoverage(snapshot, question.requirements, snapshot.projectId);
    return coverage.requirements.map((item, index) => {
      const requirement = question.requirements[index] ?? invalid();
      const selected = snapshot.sources.some(source => source.sourceRef === requirement.sourceRef ||
        source.origins?.some(origin => origin.sourceRef === requirement.sourceRef));
      return { requirementId: item.id, status: item.status !== 'unavailable' ? item.status
        : selected ? 'detail-unavailable' : 'source-not-selected', evidenceIds: item.evidenceIds, semanticReviewRequired: true };
    });
  };
  const entries: readonly KnowledgeAuthoringInspectionEntry[] = request.operation === 'coverage' ? requirements() : request.operation === 'sources'
    ? snapshot.sources.filter(source => request.contains === null || source.sourceRef.includes(request.contains))
      .sort((a, b) => compare(a.sourceRef, b.sourceRef)).map(source => ({ sourceId: source.sourceId, sourceRef: source.sourceRef,
        sourceContentDigest: source.sourceContentDigest, sanitizedContentDigest: sha256(source.content),
        repositoryRevision: source.repositoryRevision ?? null, sourceRevision: source.sourceRevision,
        codeRevision: source.codeRevision, format: source.format, evidenceCount: counts.get(source.sourceId) ?? 0 }))
    : snapshot.evidence.filter(evidence => (request.sourceRef === null || evidence.sourceRef === request.sourceRef) &&
      (request.contains === null || evidence.excerpt.includes(request.contains)))
      .sort((a, b) => compare(a.sourceRef, b.sourceRef) ||
        (a.locator.kind === 'lines' && b.locator.kind === 'lines' ? a.locator.start - b.locator.start : compare(a.evidenceId, b.evidenceId)));
  const cursorFor = (offset: number): string => `inspection-${String(offset)}-${digest({ exchangeDigest,
    snapshotDigest: snapshot.snapshotDigest, questionId: question.id, operation: request.operation,
    sourceRef: request.sourceRef, contains: request.contains, offset }).slice(7)}`;
  const start = request.cursor === null ? 0 : Number(request.cursor.split('-')[1]);
  if (start > entries.length || (request.cursor !== null && request.cursor !== cursorFor(start))) invalid();
  const build = (selected: readonly KnowledgeAuthoringInspectionEntry[], end: number,
    status: KnowledgeAuthoringInspection['status'], minimumRequiredBytes: number | null = null): KnowledgeAuthoringInspection => {
    const basis = { schemaVersion: 'buildlore.knowledge-authoring-inspection.v1' as const, projectId: snapshot.projectId,
      exchangeDigest, snapshotDigest: snapshot.snapshotDigest, question, operation: request.operation,
      sourceRef: request.sourceRef, contains: request.contains, entries: Object.freeze([...selected]), total: entries.length,
      cursor: end < entries.length ? cursorFor(end) : null, status, minimumRequiredBytes,
      byteBudget: request.maxBytes, instructions: INSTRUCTIONS, egress: 'none' as const, processSpawned: false as const };
    const profiled = question.contentProfile === undefined ? basis : { ...basis,
      requirementSelection: question.requirements.length === 0 ? 'unassessed' as const : 'selected' as const };
    return Object.freeze({ ...profiled, resultDigest: digest(profiled) });
  };
  let result = build([], start, 'empty');
  for (let end = start; end < Math.min(start + request.limit, entries.length); end += 1) {
    const entry = entries[end] ?? invalid();
    const candidate = build([...result.entries, entry], end + 1, 'ready');
    const bytes = Buffer.byteLength(JSON.stringify(candidate));
    if (bytes > request.maxBytes) {
      if (result.entries.length === 0) {
        result = build([], start, 'item-too-large', minimumBudget(candidate));
      }
      break;
    }
    result = candidate;
  }
  // No clipped evidence or silently skipped items; a larger item can be retried with more bytes.
  if (Buffer.byteLength(JSON.stringify(result)) > request.maxBytes) {
    const first = entries[start];
    const smallest = first === undefined ? build([], start, 'empty') : build([first], start + 1, 'ready');
    throw new KnowledgeAuthoringInspectionBudgetError(request.maxBytes, minimumBudget(smallest));
  }
  return result;
}
