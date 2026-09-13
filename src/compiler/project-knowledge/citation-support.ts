import { parseKnowledgeSnapshot } from '../../knowledge/project-knowledge/evidence.js';
import { boundedJson, choice, digest, hash, identifier, invalid, keys, list, portablePath, record, text } from '../../knowledge/project-knowledge/guards.js';
import { parseJsonStrict } from '../../knowledge/strict-json.js';
import type { KnowledgeDigest, KnowledgeEvidenceV1, KnowledgeGenerationV1, KnowledgeRecordV1 } from '../../knowledge/project-knowledge/types.js';

export type KnowledgeEvidenceContentKind = 'heading' | 'json-value' | 'text';

/** Surface kind, not semantic support or proof of implementation. Original bytes are unchanged. */
export function knowledgeEvidenceContentKind(evidence: KnowledgeEvidenceV1): KnowledgeEvidenceContentKind {
  if (/^#{1,6}[ \t]+[^\r\n]*$/u.test(evidence.excerpt)) return 'heading';
  if (evidence.origin !== undefined || evidence.locator.kind === 'json-pointer') {
    try { parseJsonStrict(evidence.excerpt); return 'json-value'; } catch { /* Adapter summaries may be prose. */ }
  }
  return 'text';
}

export interface KnowledgeFactSupportV1 {
  readonly schemaVersion: 'buildlore.knowledge-fact-support.v1';
  readonly projectId: string;
  readonly generationDigest: KnowledgeDigest;
  readonly snapshotDigest: KnowledgeDigest;
  readonly selectionDigest: KnowledgeDigest;
  readonly baselineGenerationDigest: KnowledgeDigest | null;
  readonly fact: KnowledgeRecordV1;
  readonly presentEvidenceIds: readonly KnowledgeDigest[];
  readonly absentEvidenceIds: readonly KnowledgeDigest[];
  readonly supportDigest: KnowledgeDigest;
}

/** Call with a replay-verified generation; absence from this snapshot does not imply feature deletion. */
export function knowledgeFactSupport(generation: KnowledgeGenerationV1, factId: KnowledgeDigest): KnowledgeFactSupportV1 {
  const fact = generation.records.find(item => item.id === hash(factId));
  if (!fact) invalid();
  const current = new Set(generation.snapshot.evidence.map(item => item.evidenceId));
  const basis = { schemaVersion: 'buildlore.knowledge-fact-support.v1' as const, projectId: generation.projectId,
    generationDigest: generation.generationDigest, snapshotDigest: generation.snapshot.snapshotDigest,
    selectionDigest: generation.snapshot.selectionDigest, baselineGenerationDigest: generation.baselineGenerationDigest,
    fact, presentEvidenceIds: Object.freeze(fact.evidenceIds.filter(id => current.has(id))),
    absentEvidenceIds: Object.freeze(fact.evidenceIds.filter(id => !current.has(id))) };
  return Object.freeze({ ...basis, supportDigest: digest(basis) });
}

export interface KnowledgeEvidenceCoverageV1 {
  readonly schemaVersion: 'buildlore.knowledge-evidence-coverage.v1';
  readonly projectId: string;
  readonly snapshotDigest: KnowledgeDigest;
  readonly requirements: readonly Readonly<{ id: string; status: 'available' | 'heading-only' | 'unavailable'; evidenceIds: readonly KnowledgeDigest[] }>[];
  readonly complete: boolean;
  readonly coverageDigest: KnowledgeDigest;
}

/** Exact caller-declared requirements, never inferred from oracle text or producer-specific field names.
 * Pure codec, not a sanitizer. Missing requirements return only IDs, never echo arbitrary query paths.
 */
export function createKnowledgeEvidenceCoverage(snapshotValue: unknown, requirementsValue: unknown,
  projectId: string): KnowledgeEvidenceCoverageV1 {
  const snapshot = parseKnowledgeSnapshot(snapshotValue, projectId);
  const requirements = list(boundedJson(requirementsValue), 256).map(item => {
    const input = record(item);
    keys(input, ['id', 'sourceRef', 'jsonPointer', 'contentKind']);
    const id = identifier(input.id);
    const sourceRef = portablePath(input.sourceRef);
    const pointer = input.jsonPointer === null ? null : input.jsonPointer === '' ? '' : text(input.jsonPointer, 4096);
    if (pointer !== null && pointer !== '' && (!pointer.startsWith('/') || /~(?![01])/u.test(pointer))) invalid();
    const kind = choice(input.contentKind, ['any', 'json-value', 'text']);
    const matching = snapshot.evidence.filter(e => (e.origin?.sourceRef ?? e.sourceRef) === sourceRef &&
      (pointer === null || (e.origin?.jsonPointer ?? (e.locator.kind === 'json-pointer' ? e.locator.pointer : null)) === pointer));
    const selected = matching.filter(e => kind === 'any' || knowledgeEvidenceContentKind(e) === kind);
    const status = selected.length > 0 ? 'available' as const
      : matching.some(e => knowledgeEvidenceContentKind(e) === 'heading') ? 'heading-only' as const : 'unavailable' as const;
    return Object.freeze({ id, status, evidenceIds: Object.freeze(selected.map(e => e.evidenceId)) });
  });
  if (requirements.length === 0 || new Set(requirements.map(r => r.id)).size !== requirements.length) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-evidence-coverage.v1' as const, projectId,
    snapshotDigest: snapshot.snapshotDigest, requirements: Object.freeze(requirements), complete: requirements.every(r => r.status === 'available') };
  return Object.freeze({ ...basis, coverageDigest: digest(basis) });
}
