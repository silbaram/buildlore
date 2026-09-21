import { boundedJson, compare, digest, hash, invalid, keys, project, record, text,
  ProjectKnowledgeError } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeEvidenceV1, KnowledgeGenerationV1, KnowledgePageClaimV1,
  KnowledgePageRole, KnowledgeRecordV1, KnowledgeSnapshotV1 } from '../../knowledge/project-knowledge/types.js';

export const KNOWLEDGE_CHANGE_IMPACT_REQUEST_VERSION = 'buildlore.knowledge-change-impact-request.v1';
export const KNOWLEDGE_CHANGE_IMPACT_VERSION = 'buildlore.knowledge-change-impact.v1';
export const KNOWLEDGE_CHANGE_IMPACT_BUDGET_VERSION = 'buildlore.knowledge-change-impact-budget.v1';
export const KNOWLEDGE_CHANGE_IMPACT_POLICY_VERSION = 'conservative-change-impact-v1';
const MAXIMUM_BYTES = 1_048_576;

export interface KnowledgeChangeImpactRequest {
  readonly schemaVersion: typeof KNOWLEDGE_CHANGE_IMPACT_REQUEST_VERSION;
  readonly operation: 'change-impact';
  readonly projectId: string;
  readonly expectExchangeDigest: KnowledgeDigest;
  readonly expectSnapshotDigest: KnowledgeDigest;
  readonly expectBaselineGenerationDigest: KnowledgeDigest;
  readonly expectBaselineSnapshotDigest: KnowledgeDigest;
  readonly cursor: string | null;
  readonly limit: number;
  readonly maxBytes: number;
}

export interface KnowledgeChangeImpactBudget {
  readonly schemaVersion: typeof KNOWLEDGE_CHANGE_IMPACT_BUDGET_VERSION;
  readonly reason: 'response-metadata-too-large';
  readonly byteBudget: number;
  readonly minimumRequiredBytes: number;
  readonly maximumBytes: number;
  readonly retryable: boolean;
}

/** Recovery metadata never includes input values or source identities. */
export class KnowledgeChangeImpactBudgetError extends Error {
  readonly code = 'KNOWLEDGE_CHANGE_IMPACT_BUDGET_EXCEEDED';
  readonly details: KnowledgeChangeImpactBudget;

  constructor(byteBudget: number, minimumRequiredBytes: number) {
    super('Change-impact response metadata exceeds the requested byte budget.');
    this.name = 'KnowledgeChangeImpactBudgetError';
    this.details = Object.freeze({ schemaVersion: KNOWLEDGE_CHANGE_IMPACT_BUDGET_VERSION,
      reason: 'response-metadata-too-large', byteBudget, minimumRequiredBytes,
      maximumBytes: MAXIMUM_BYTES, retryable: minimumRequiredBytes <= MAXIMUM_BYTES });
  }
}

export type KnowledgeChangeDimension = 'source-id' | 'source-ref' | 'source-content-digest'
  | 'sanitized-content-digest' | 'repository-revision' | 'source-revision' | 'code-revision'
  | 'format' | 'locator' | 'origin' | 'excerpt-digest';
export type KnowledgeChangeMatchBasis = 'exact-evidence-id' | 'origin-json-pointer'
  | 'source-json-pointer' | 'source-line-locator' | 'none';
export type KnowledgeChangeDisposition = 'exact-current' | 'revision-metadata-changed'
  | 'same-excerpt-source-changed' | 'content-changed' | 'source-unselected'
  | 'aligned-evidence-unavailable' | 'ambiguous-current-candidates';
export interface KnowledgeChangeEvidenceIdentity extends Omit<KnowledgeEvidenceV1, 'excerpt' | 'origin' | 'repositoryRevision'> {
  readonly repositoryRevision: string | null;
  readonly origin: NonNullable<KnowledgeEvidenceV1['origin']> | null;
  readonly format: 'markdown' | 'json';
}
export interface KnowledgeChangeEvidenceLink {
  readonly baseline: KnowledgeChangeEvidenceIdentity;
  readonly sourceSelection: 'selected' | 'unselected';
  readonly disposition: KnowledgeChangeDisposition;
  readonly matchBasis: KnowledgeChangeMatchBasis;
  /** Union of observed differences against candidates; empty when none can be compared. */
  readonly changedDimensions: readonly KnowledgeChangeDimension[];
  readonly candidateCount: number;
  readonly candidates: readonly KnowledgeChangeEvidenceIdentity[];
}
export interface KnowledgeChangeClaimLocation {
  readonly pageRole: KnowledgePageRole;
  readonly sectionIndex: number;
  readonly claimIndex: number;
  readonly claimId: string;
  readonly presentation: KnowledgePageClaimV1['presentation'];
}
export interface KnowledgeChangeFactImpact {
  readonly factId: KnowledgeDigest;
  readonly recordDigest: KnowledgeDigest;
  readonly classification: KnowledgeRecordV1['classification'];
  readonly lifecycle: 'current';
  readonly reviewStatus: KnowledgeRecordV1['reviewStatus'];
  readonly supersededBy: readonly KnowledgeDigest[];
  readonly impactExtent: 'partial-evidence' | 'all-evidence';
  readonly conservativeCurrentnessEffect: 'stale-without-reviewed-reproposal';
  readonly evidence: readonly KnowledgeChangeEvidenceLink[];
  readonly baselineClaimLocations: readonly KnowledgeChangeClaimLocation[];
}
export interface KnowledgeChangeImpactSummary {
  readonly baselineRecords: number;
  readonly currentRecords: number;
  readonly affectedFacts: number;
  readonly retainedCurrentFacts: number;
  readonly excludedHistorical: number;
  readonly excludedSuperseded: number;
  readonly excludedStale: number;
  /** Links on the baseline current records considered by this comparison, including siblings. */
  readonly baselineEvidenceLinks: number;
  readonly nonExactEvidenceLinks: number;
}
type SnapshotIdentity = Pick<KnowledgeSnapshotV1, 'snapshotDigest' | 'selectionDigest' | 'sanitizerPolicyDigest' | 'sanitizerRulesVersion'>;
export interface KnowledgeChangeImpactV1 {
  readonly schemaVersion: typeof KNOWLEDGE_CHANGE_IMPACT_VERSION;
  readonly operation: 'change-impact';
  readonly projectId: string;
  readonly exchangeDigest: KnowledgeDigest;
  readonly currentSnapshot: SnapshotIdentity;
  readonly baseline: SnapshotIdentity & Readonly<{ generationDigest: KnowledgeDigest }>;
  readonly comparisonPolicyVersion: typeof KNOWLEDGE_CHANGE_IMPACT_POLICY_VERSION;
  readonly summary: KnowledgeChangeImpactSummary;
  readonly impacts: readonly KnowledgeChangeFactImpact[];
  readonly total: number;
  readonly cursor: string | null;
  readonly status: 'ready' | 'empty' | 'item-too-large';
  readonly minimumRequiredBytes: number | null;
  readonly byteBudget: number;
  readonly maximumBytes: number;
  readonly retryable: boolean;
  readonly instructions: readonly string[];
  readonly boundary: Readonly<{ selectedSnapshotOnly: true; checkoutWideVerification: false;
    semanticReviewPerformed: false; knowledgeMutation: 'none'; approvalEffect: 'none'; egress: 'none'; processSpawned: false }>;
  readonly resultDigest: KnowledgeDigest;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}

export function parseKnowledgeChangeImpactRequest(value: unknown, projectId: string): KnowledgeChangeImpactRequest {
  const input = record(boundedJson(value));
  keys(input, ['schemaVersion', 'operation', 'projectId', 'expectExchangeDigest', 'expectSnapshotDigest',
    'expectBaselineGenerationDigest', 'expectBaselineSnapshotDigest',
    ...['cursor', 'limit', 'maxBytes'].filter(key => Object.hasOwn(input, key))]);
  if (input.schemaVersion !== KNOWLEDGE_CHANGE_IMPACT_REQUEST_VERSION || input.operation !== 'change-impact') invalid();
  const cursor = input.cursor === undefined || input.cursor === null ? null : text(input.cursor, 100);
  if (cursor !== null && (!/^change-impact-(?:0|[1-9][0-9]{0,15})-[0-9a-f]{64}$/u.test(cursor) ||
    !Number.isSafeInteger(Number(cursor.split('-')[2])))) invalid();
  return Object.freeze({ schemaVersion: KNOWLEDGE_CHANGE_IMPACT_REQUEST_VERSION, operation: 'change-impact',
    projectId: project(input.projectId, projectId), expectExchangeDigest: hash(input.expectExchangeDigest),
    expectSnapshotDigest: hash(input.expectSnapshotDigest), expectBaselineGenerationDigest: hash(input.expectBaselineGenerationDigest),
    expectBaselineSnapshotDigest: hash(input.expectBaselineSnapshotDigest), cursor,
    limit: integer(input.limit, 10, 1, 50), maxBytes: integer(input.maxBytes, 65_536, 8192, MAXIMUM_BYTES) });
}

const DIMENSIONS: readonly KnowledgeChangeDimension[] = Object.freeze(['source-id', 'source-ref', 'source-content-digest',
  'sanitized-content-digest', 'repository-revision', 'source-revision', 'code-revision', 'format', 'locator', 'origin', 'excerpt-digest']);
const INSTRUCTIONS = Object.freeze([
  'Compare only this selected sanitized snapshot with the verified baseline. Missing selected evidence does not prove deletion, renaming or feature absence.',
  'Only baseline current facts with non-exact evidence are listed. Every evidence sibling is retained; any non-exact sibling makes the fact stale under conservative reconciliation unless it is re-proposed and independently reviewed.',
  'Candidates share an explicit structural locator or origin. Neither an exact excerpt nor revision metadata proves semantic support, current implementation or successful test execution. Ambiguous and unavailable evidence require investigation.',
  'Locations refer to the baseline Wiki. Inspect the actual current evidence, propose supported facts and explicit scoped supersessions or conflicts, then use the existing independent review and explicit approval workflow.',
  'No fact state or approval changes here. A normal Wiki memory still describes its last approved snapshot until an updated generation is approved. Scope and unknown revision limits remain applicable.',
  'Pagination preserves whole facts and all candidates. For item-too-large retry the same cursor with minimumRequiredBytes when retryable; no oversized fact is silently skipped. Budgets count compact report JSON including resultDigest, excluding the CLI envelope and formatting.',
]);

function identity(evidence: KnowledgeEvidenceV1): KnowledgeChangeEvidenceIdentity {
  const { excerpt, origin, repositoryRevision, ...rest } = evidence;
  void excerpt;
  // Snapshot validation guarantees each source format and its generated locator kind agree.
  return Object.freeze({ ...rest, repositoryRevision: repositoryRevision ?? null, origin: origin ?? null,
    format: evidence.locator.kind === 'json-pointer' ? 'json' : 'markdown' });
}

function differences(a: KnowledgeChangeEvidenceIdentity, b: KnowledgeChangeEvidenceIdentity): readonly KnowledgeChangeDimension[] {
  const comparisons: Readonly<Record<KnowledgeChangeDimension, boolean>> = {
    'source-id': a.sourceId !== b.sourceId, 'source-ref': a.sourceRef !== b.sourceRef,
    'source-content-digest': a.sourceContentDigest !== b.sourceContentDigest,
    'sanitized-content-digest': a.sanitizedContentDigest !== b.sanitizedContentDigest,
    'repository-revision': a.repositoryRevision !== b.repositoryRevision,
    'source-revision': a.sourceRevision !== b.sourceRevision || a.sourceRevisionUnavailableReason !== b.sourceRevisionUnavailableReason,
    'code-revision': a.codeRevision !== b.codeRevision || a.codeRevisionUnavailableReason !== b.codeRevisionUnavailableReason,
    format: a.format !== b.format, locator: digest(a.locator) !== digest(b.locator),
    origin: digest(a.origin) !== digest(b.origin), 'excerpt-digest': a.excerptDigest !== b.excerptDigest,
  };
  return Object.freeze(DIMENSIONS.filter(key => comparisons[key]));
}

type StructuralStage = Exclude<KnowledgeChangeMatchBasis, 'exact-evidence-id' | 'none'>;
function structuralKeys(e: KnowledgeEvidenceV1): readonly (readonly [StructuralStage, string])[] {
  return [
    ...(e.origin?.jsonPointer === undefined ? [] : [['origin-json-pointer', JSON.stringify([e.origin.sourceRef, e.origin.jsonPointer])] as const]),
    e.locator.kind === 'json-pointer' ? ['source-json-pointer', JSON.stringify([e.sourceRef, e.locator.pointer])] as const
      : ['source-line-locator', JSON.stringify(e.origin !== undefined && e.origin.jsonPointer === undefined
        ? [e.origin.sourceRef, e.origin.range.startLine, e.origin.range.endLine]
        : [e.sourceRef, e.locator.start, e.locator.end])] as const,
  ];
}

function evidenceComparer(snapshot: KnowledgeSnapshotV1): (evidence: KnowledgeEvidenceV1) => KnowledgeChangeEvidenceLink {
  const exact = new Map(snapshot.evidence.map(e => [e.evidenceId, e]));
  const selection = new Set(snapshot.sources.flatMap(s => [s.sourceRef, ...(s.origins ?? []).map(o => o.sourceRef)]));
  const stages = new Map<StructuralStage, Map<string, KnowledgeEvidenceV1[]>>();
  for (const e of [...snapshot.evidence].sort((a, b) => compare(a.evidenceId, b.evidenceId))) {
    for (const [stage, key] of structuralKeys(e)) {
      const index = stages.get(stage) ?? new Map<string, KnowledgeEvidenceV1[]>();
      stages.set(stage, index);
      const candidates = index.get(key) ?? [];
      candidates.push(e); index.set(key, candidates);
    }
  }
  return e => {
    let matchBasis: KnowledgeChangeMatchBasis = 'none';
    let matches: readonly KnowledgeEvidenceV1[] = [];
    const current = exact.get(e.evidenceId);
    if (current !== undefined) { matches = [current]; matchBasis = 'exact-evidence-id'; }
    else for (const [stage, key] of structuralKeys(e)) {
      const found = stages.get(stage)?.get(key);
      if (found?.length) { matches = found; matchBasis = stage; break; }
    }
    const baseline = identity(e);
    const candidates = Object.freeze(matches.map(identity));
    const changed = new Set(candidates.flatMap(candidate => differences(baseline, candidate)));
    const changedDimensions = Object.freeze(DIMENSIONS.filter(dimension => changed.has(dimension)));
    const sourceSelection = selection.has(e.sourceRef) || (e.origin !== undefined && selection.has(e.origin.sourceRef))
      ? 'selected' as const : 'unselected' as const;
    const disposition: KnowledgeChangeDisposition = current !== undefined ? 'exact-current'
      : candidates.length === 0 ? sourceSelection === 'unselected' ? 'source-unselected' : 'aligned-evidence-unavailable'
      : candidates.length > 1 ? 'ambiguous-current-candidates'
      : changed.has('excerpt-digest') ? 'content-changed'
      : ['source-ref', 'source-content-digest', 'sanitized-content-digest', 'format', 'locator', 'origin']
        .some(dimension => changedDimensions.some(changed => changed === dimension)) ? 'same-excerpt-source-changed'
      : 'revision-metadata-changed';
    return Object.freeze({ baseline, sourceSelection, disposition, matchBasis, changedDimensions,
      candidateCount: candidates.length, candidates });
  };
}

function snapshotIdentity(snapshot: KnowledgeSnapshotV1): SnapshotIdentity {
  return Object.freeze({ snapshotDigest: snapshot.snapshotDigest, selectionDigest: snapshot.selectionDigest,
    sanitizerPolicyDigest: snapshot.sanitizerPolicyDigest, sanitizerRulesVersion: snapshot.sanitizerRulesVersion });
}

function minimumBudget(result: KnowledgeChangeImpactV1): number {
  let minimum = Math.max(8192, Buffer.byteLength(JSON.stringify(result)));
  let measured = Buffer.byteLength(JSON.stringify({ ...result, byteBudget: minimum }));
  while (measured > minimum) { minimum = measured; measured = Buffer.byteLength(JSON.stringify({ ...result, byteBudget: minimum })); }
  return minimum;
}

/** Internal projection: only expose through a session that replayed and screened both inputs. */
export function inspectKnowledgeChangeImpact(snapshot: KnowledgeSnapshotV1, previous: KnowledgeGenerationV1 | null,
  exchangeDigest: KnowledgeDigest, request: KnowledgeChangeImpactRequest): KnowledgeChangeImpactV1 {
  if (previous === null) invalid();
  if (request.projectId !== snapshot.projectId || previous.projectId !== snapshot.projectId ||
    request.expectExchangeDigest !== exchangeDigest || request.expectSnapshotDigest !== snapshot.snapshotDigest ||
    request.expectBaselineGenerationDigest !== previous.generationDigest ||
    request.expectBaselineSnapshotDigest !== previous.snapshot.snapshotDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  const cursorFor = (offset: number): string => `change-impact-${String(offset)}-${digest({ projectId: snapshot.projectId,
    exchangeDigest, snapshotDigest: snapshot.snapshotDigest, baselineGenerationDigest: previous.generationDigest,
    baselineSnapshotDigest: previous.snapshot.snapshotDigest, comparisonPolicyVersion: KNOWLEDGE_CHANGE_IMPACT_POLICY_VERSION, offset }).slice(7)}`;
  const start = request.cursor === null ? 0 : Number(request.cursor.split('-')[2]);
  if (request.cursor !== null && request.cursor !== cursorFor(start)) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  const locations = new Map<KnowledgeDigest, KnowledgeChangeClaimLocation[]>();
  for (const page of [...previous.pages].sort((a, b) => compare(a.role, b.role))) {
    page.sections.forEach((section, sectionIndex) => section.claims.forEach((claim, claimIndex) => {
      for (const id of claim.factIds) {
        const entries = locations.get(id) ?? [];
        entries.push(Object.freeze({ pageRole: page.role, sectionIndex, claimIndex, claimId: claim.claimId, presentation: claim.presentation }));
        locations.set(id, entries);
      }
    }));
  }
  const classify = evidenceComparer(snapshot);
  const baselineEvidence = new Map(previous.evidence.map(e => [e.evidenceId, e]));
  const cache = new Map<KnowledgeDigest, KnowledgeChangeEvidenceLink>();
  const impacts: KnowledgeChangeFactImpact[] = [];
  const summary = { baselineRecords: previous.records.length, currentRecords: 0, affectedFacts: 0,
    retainedCurrentFacts: 0, excludedHistorical: 0, excludedSuperseded: 0, excludedStale: 0,
    baselineEvidenceLinks: 0, nonExactEvidenceLinks: 0 };
  for (const fact of [...previous.records].sort((a, b) => compare(a.id, b.id))) {
    switch (fact.lifecycle) {
      case 'historical': summary.excludedHistorical += 1; continue;
      case 'superseded': summary.excludedSuperseded += 1; continue;
      case 'stale': summary.excludedStale += 1; continue;
      case 'current': summary.currentRecords += 1; break;
    }
    const evidence = Object.freeze([...fact.evidenceIds].sort(compare).map(id => {
      const link = cache.get(id) ?? classify(baselineEvidence.get(id) ?? invalid());
      cache.set(id, link); return link;
    }));
    const nonExact = evidence.filter(e => e.disposition !== 'exact-current').length;
    summary.baselineEvidenceLinks += evidence.length; summary.nonExactEvidenceLinks += nonExact;
    if (nonExact === 0) { summary.retainedCurrentFacts += 1; continue; }
    summary.affectedFacts += 1;
    impacts.push(Object.freeze({ factId: fact.id, recordDigest: fact.recordDigest, classification: fact.classification,
      lifecycle: 'current', reviewStatus: fact.reviewStatus, supersededBy: fact.supersededBy,
      impactExtent: nonExact === evidence.length ? 'all-evidence' : 'partial-evidence',
      conservativeCurrentnessEffect: 'stale-without-reviewed-reproposal', evidence,
      baselineClaimLocations: Object.freeze(locations.get(fact.id) ?? []) }));
  }
  if (start > impacts.length) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  const build = (selected: readonly KnowledgeChangeFactImpact[], end: number,
    status: KnowledgeChangeImpactV1['status'], minimumRequiredBytes: number | null = null): KnowledgeChangeImpactV1 => {
    const basis: Omit<KnowledgeChangeImpactV1, 'resultDigest'> = { schemaVersion: KNOWLEDGE_CHANGE_IMPACT_VERSION, operation: 'change-impact',
      projectId: snapshot.projectId, exchangeDigest, currentSnapshot: snapshotIdentity(snapshot),
      baseline: Object.freeze({ generationDigest: previous.generationDigest, ...snapshotIdentity(previous.snapshot) }),
      comparisonPolicyVersion: KNOWLEDGE_CHANGE_IMPACT_POLICY_VERSION, summary: Object.freeze(summary),
      impacts: Object.freeze([...selected]), total: impacts.length, cursor: end < impacts.length ? cursorFor(end) : null,
      status, minimumRequiredBytes, byteBudget: request.maxBytes, maximumBytes: MAXIMUM_BYTES,
      retryable: minimumRequiredBytes !== null && minimumRequiredBytes <= MAXIMUM_BYTES, instructions: INSTRUCTIONS,
      boundary: Object.freeze({ selectedSnapshotOnly: true as const, checkoutWideVerification: false as const,
        semanticReviewPerformed: false as const, knowledgeMutation: 'none' as const, approvalEffect: 'none' as const,
        egress: 'none' as const, processSpawned: false as const }) };
    return Object.freeze({ ...basis, resultDigest: digest(basis) });
  };
  let result = build([], start, 'empty');
  for (let end = start; end < Math.min(start + request.limit, impacts.length); end += 1) {
    const candidate = build([...result.impacts, impacts[end] ?? invalid()], end + 1, 'ready');
    if (Buffer.byteLength(JSON.stringify(candidate)) > request.maxBytes) {
      if (result.impacts.length === 0) result = build([], start, 'item-too-large', minimumBudget(candidate));
      break;
    }
    result = candidate;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > request.maxBytes) {
    throw new KnowledgeChangeImpactBudgetError(request.maxBytes, minimumBudget(result));
  }
  return result;
}
