import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { inspectPreparedSource } from '../../sanitizer/approval.js';
import type { DataClassification } from '../../sanitizer/index.js';
import {
  validatePortableSourceRef,
  validateSourceOriginRange,
} from '../../projector/source-contracts.js';
import {
  HIERARCHICAL_COMPILATION_LIMITS,
  digestHierarchyValue,
  hierarchySha256,
  parseCorpusSnapshot,
} from './contracts.js';
import { HierarchyContractError } from './errors.js';
import { hierarchyTokens } from './tokens.js';
import {
  CURRENT_SESSION_GENERATION_REQUEST_SCHEMA_VERSION,
  EVIDENCE_PACK_SCHEMA_VERSION,
  EXTERNAL_GENERATION_AUTHORIZATION_SCHEMA_VERSION,
  HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION,
  WIKI_LINK_RECONCILIATION_SCHEMA_VERSION,
  type ApprovedChildSummaryV1,
  type CompilePartitionV2,
  type CorpusSnapshotV1,
  type CurrentSessionGenerationRequestV1,
  type EvidenceConflictV1,
  type EvidenceGapV1,
  type EvidencePackV1,
  type EvidenceUnitV1,
  type ExternalGenerationAuthorizationV1,
  type HierarchicalProposalClaimV1,
  type HierarchicalProposalSectionV1,
  type HierarchicalWikiProposalV1,
  type HierarchySha256Digest,
  type PageBlueprintV1,
  type SanitizedEvidenceSourceV1,
  type WikiLinkReconciliationV1,
  type WikiOutlineV1,
} from './types.js';

const SOURCE_ID_PATTERN = /^source-[a-f0-9]{64}$/u;
const UNIT_ID_PATTERN = /^unit-[a-f0-9]{64}$/u;
const PAGE_ID_PATTERN = /^page-[a-f0-9]{64}$/u;
const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PORTABLE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const CITATION_ID_PATTERN = /^citation-[a-f0-9]{64}$/u;
const CLAIM_ID_PATTERN = /^claim-[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_PROPOSAL_BYTES = 524288;
const ISSUED_EVIDENCE_PACKS = new WeakSet<object>();
const EVIDENCE_PACK_CLASSIFICATIONS = new WeakMap<
  object,
  ReadonlySet<DataClassification>
>();
const CURRENT_SESSION_INSTRUCTION_CODES = Object.freeze([
  'cite-each-paragraph',
  'ground-claims-25pct',
  'optional-sections-allowed',
  'preserve-evidence-bytes',
  'render-citation-markers',
  'render-wikilinks',
  'submit-candidate-only',
  'summary-from-claims',
  'title-may-paraphrase',
  'use-required-sections',
  'use-required-wikilinks',
  'write-in-output-language',
]);

function invalid(projectId: string): never {
  throw new HierarchyContractError(projectId);
}

function safeText(
  value: unknown,
  maximum: number,
  projectId: string,
  allowNewlines = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.normalize('NFC') ||
    value.includes('\r') ||
    (!allowNewlines && value.includes('\n'))
  ) invalid(projectId);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && (code !== 10 || !allowNewlines)) ||
        (code >= 127 && code <= 159)) invalid(projectId);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(projectId);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid(projectId);
    }
  }
  if (/\p{Cf}/u.test(value)) invalid(projectId);
  return value;
}

function portableIdentifier(value: unknown, projectId: string): string {
  const parsed = safeText(value, 64, projectId);
  if (!PORTABLE_IDENTIFIER_PATTERN.test(parsed)) invalid(projectId);
  return parsed;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function validCitationLocation(
  sourceRef: unknown,
  range: unknown,
): boolean {
  try {
    validatePortableSourceRef(sourceRef);
    validateSourceOriginRange(range);
    return true;
  } catch {
    return false;
  }
}

function extractUnitContent(
  content: string,
  unit: CorpusSnapshotV1['textUnits'][number],
  projectId: string,
): string {
  const lines = content.split('\n');
  const selected = lines.slice(unit.range.startLine - 1, unit.range.endLine);
  if (selected.length !== unit.range.endLine - unit.range.startLine + 1) invalid(projectId);
  const first = selected[0];
  const last = selected[selected.length - 1];
  if (first === undefined || last === undefined) invalid(projectId);
  const startScalars = [...first];
  const endScalars = [...last];
  if (
    unit.range.startColumn > startScalars.length ||
    unit.range.endColumn > endScalars.length
  ) invalid(projectId);
  if (selected.length === 1) {
    return startScalars.slice(unit.range.startColumn - 1, unit.range.endColumn).join('');
  }
  selected[0] = startScalars.slice(unit.range.startColumn - 1).join('');
  selected[selected.length - 1] = endScalars.slice(0, unit.range.endColumn).join('');
  return selected.join('\n');
}

function packWithoutDigest(pack: Omit<EvidencePackV1, 'packDigest'>):
Readonly<Record<string, unknown>> {
  return {
    schemaVersion: pack.schemaVersion,
    projectId: pack.projectId,
    pageId: pack.pageId,
    blueprintDigest: pack.blueprintDigest,
    snapshotDigest: pack.snapshotDigest,
    sanitizerPolicyDigest: pack.sanitizerPolicyDigest,
    units: pack.units,
    conflicts: pack.conflicts,
    gaps: pack.gaps,
    evidenceBytes: pack.evidenceBytes,
  };
}

function assertCanonicalEvidencePack(
  pack: EvidencePackV1,
  blueprint: PageBlueprintV1,
  projectId: string,
): void {
  const unitIds = new Set<string>();
  const citationIds = new Set<string>();
  if (
    pack.schemaVersion !== EVIDENCE_PACK_SCHEMA_VERSION ||
    pack.projectId !== projectId ||
    pack.pageId !== blueprint.pageId ||
    pack.blueprintDigest !== blueprint.blueprintDigest ||
    pack.snapshotDigest !== blueprint.evidenceScope.snapshotDigest ||
    !DIGEST_PATTERN.test(pack.sanitizerPolicyDigest) ||
    pack.units.length < 1 ||
    pack.units.length > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits
  ) invalid(projectId);
  for (const unit of pack.units) {
    const citationBasis = Object.freeze({
      ...(unit.citation.jsonPointer === undefined
        ? {}
        : { jsonPointer: unit.citation.jsonPointer }),
      sourceId: unit.citation.sourceId,
      sourceRevision: unit.citation.sourceRevision,
      sourceRef: unit.citation.sourceRef,
      range: unit.citation.range,
      quoteDigest: unit.citation.quoteDigest,
    });
    if (
      !UNIT_ID_PATTERN.test(unit.unitId) ||
      unitIds.has(unit.unitId) ||
      !blueprint.evidenceScope.sourceIds.includes(unit.sourceId) ||
      !blueprint.evidenceScope.allowedUnitKinds.includes(unit.kind) ||
      unit.sourceId !== unit.citation.sourceId ||
      !DIGEST_PATTERN.test(unit.citation.sourceRevision) ||
      unit.contentDigest !== hierarchySha256(unit.content) ||
      unit.contentDigest !== unit.citation.quoteDigest ||
      !validCitationLocation(unit.citation.sourceRef, unit.citation.range) ||
      unit.citation.citationId !==
        `citation-${digestHierarchyValue(citationBasis).slice('sha256:'.length)}` ||
      citationIds.has(unit.citation.citationId)
    ) invalid(projectId);
    safeText(unit.content, HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceBytes, projectId, true);
    unitIds.add(unit.unitId);
    citationIds.add(unit.citation.citationId);
  }
  if (pack.conflicts.length > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits ||
      pack.gaps.length > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits) invalid(projectId);
  for (let index = 0; index < pack.conflicts.length; index += 1) {
    const conflict = pack.conflicts[index];
    if (conflict === undefined) invalid(projectId);
    const unitIdsValue = [...conflict.unitIds];
    const basis = Object.freeze({
      kind: portableIdentifier(conflict.kind, projectId),
      unitIds: unitIdsValue,
      status: 'unresolved' as const,
    });
    if (
      conflict.status !== 'unresolved' ||
      unitIdsValue.length < 2 ||
      !sameStrings(unitIdsValue, [...unitIdsValue].sort()) ||
      new Set(unitIdsValue).size !== unitIdsValue.length ||
      unitIdsValue.some((unitId) => !unitIds.has(unitId)) ||
      conflict.conflictId !==
        `conflict-${digestHierarchyValue(basis).slice('sha256:'.length)}` ||
      (index > 0 && (pack.conflicts[index - 1]?.conflictId ?? '') >= conflict.conflictId)
    ) invalid(projectId);
  }
  for (let index = 0; index < pack.gaps.length; index += 1) {
    const gap = pack.gaps[index];
    if (gap === undefined) invalid(projectId);
    const basis = Object.freeze({
      keyQuestion: safeText(gap.keyQuestion, 1_000, projectId),
      reasonCode: portableIdentifier(gap.reasonCode, projectId),
    });
    if (
      !blueprint.keyQuestions.includes(gap.keyQuestion) ||
      gap.gapId !== `gap-${digestHierarchyValue(basis).slice('sha256:'.length)}` ||
      (index > 0 && (pack.gaps[index - 1]?.gapId ?? '') >= gap.gapId)
    ) invalid(projectId);
  }
  const evidenceBytes = pack.units.reduce((sum, unit) =>
    sum + Buffer.byteLength(unit.content, 'utf8'), 0);
  if (
    pack.evidenceBytes !== evidenceBytes ||
    evidenceBytes > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceBytes ||
    pack.packDigest !== digestHierarchyValue(packWithoutDigest(pack)) ||
    Buffer.byteLength(serializeCanonicalJson(pack), 'utf8') >
      HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceBytes
  ) invalid(projectId);
}

export interface EvidenceConflictInputV1 {
  readonly kind: string;
  readonly unitIds: readonly string[];
}

export interface EvidenceGapInputV1 {
  readonly keyQuestion: string;
  readonly reasonCode: string;
}

export interface CreateEvidencePackInputV1 {
  readonly blueprint: PageBlueprintV1;
  readonly snapshot: CorpusSnapshotV1;
  readonly sources: readonly SanitizedEvidenceSourceV1[];
  readonly selectedUnitIds: readonly string[];
  readonly conflicts: readonly EvidenceConflictInputV1[];
  readonly gaps: readonly EvidenceGapInputV1[];
}

/** @internal Current-session handoff accepts only same-process sanitizer-backed packs. */
export function isSameProcessSanitizedEvidencePack(pack: EvidencePackV1): boolean {
  return ISSUED_EVIDENCE_PACKS.has(pack);
}

/** @internal Returns a defensive copy of the opaque sanitizer classification proof. */
export function classificationsForExternalGeneration(
  pack: EvidencePackV1,
): ReadonlySet<DataClassification> | null {
  const classifications = EVIDENCE_PACK_CLASSIFICATIONS.get(pack);
  return classifications === undefined ? null : new Set(classifications);
}

function freezeJsonSnapshot(value: unknown, projectId: string): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeJsonSnapshot(item, projectId)));
  }
  if (typeof value === 'object' && value !== null) {
    const snapshot: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      snapshot[key] = freezeJsonSnapshot(item, projectId);
    }
    return Object.freeze(snapshot);
  }
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return value;
  return invalid(projectId);
}

/** @internal Deep immutable copy with same-process sanitizer proof rebound to the copy. */
export function snapshotSanitizedEvidencePack(
  pack: EvidencePackV1,
  expectedProjectId: string,
): EvidencePackV1 {
  const classifications = EVIDENCE_PACK_CLASSIFICATIONS.get(pack);
  if (
    !ISSUED_EVIDENCE_PACKS.has(pack) ||
    classifications === undefined ||
    classifications.size < 1 ||
    pack.projectId !== expectedProjectId
  ) invalid(expectedProjectId);
  let decoded: unknown;
  try {
    decoded = JSON.parse(serializeCanonicalJson(pack)) as unknown;
  } catch {
    return invalid(expectedProjectId);
  }
  const snapshot = freezeJsonSnapshot(decoded, expectedProjectId) as EvidencePackV1;
  if (serializeCanonicalJson(snapshot) !== serializeCanonicalJson(pack)) {
    invalid(expectedProjectId);
  }
  ISSUED_EVIDENCE_PACKS.add(snapshot);
  EVIDENCE_PACK_CLASSIFICATIONS.set(snapshot, new Set(classifications));
  return snapshot;
}

/** @internal Reissues a document-order prefix while retaining sanitizer lineage. */
export function truncateSanitizedEvidencePack(
  pack: EvidencePackV1,
  blueprint: PageBlueprintV1,
  retainedUnitCount: number,
  expectedProjectId: string,
): EvidencePackV1 {
  const classifications = EVIDENCE_PACK_CLASSIFICATIONS.get(pack);
  if (
    !ISSUED_EVIDENCE_PACKS.has(pack) ||
    classifications === undefined ||
    classifications.size < 1 ||
    !Number.isSafeInteger(retainedUnitCount) ||
    retainedUnitCount < 1 ||
    retainedUnitCount > pack.units.length
  ) invalid(expectedProjectId);
  assertCanonicalEvidencePack(pack, blueprint, expectedProjectId);
  if (retainedUnitCount === pack.units.length) return pack;
  const units = Object.freeze(pack.units.slice(0, retainedUnitCount));
  const retainedUnitIds = new Set(units.map((unit) => unit.unitId));
  if (pack.conflicts.some((conflict) =>
    conflict.unitIds.some((unitId) => !retainedUnitIds.has(unitId)))) {
    invalid(expectedProjectId);
  }
  const evidenceBytes = units.reduce((sum, unit) =>
    sum + Buffer.byteLength(unit.content, 'utf8'), 0);
  const candidate = Object.freeze({
    schemaVersion: pack.schemaVersion,
    projectId: pack.projectId,
    pageId: pack.pageId,
    blueprintDigest: pack.blueprintDigest,
    snapshotDigest: pack.snapshotDigest,
    sanitizerPolicyDigest: pack.sanitizerPolicyDigest,
    units,
    conflicts: pack.conflicts,
    gaps: pack.gaps,
    evidenceBytes,
  });
  const truncated = Object.freeze({
    ...candidate,
    packDigest: digestHierarchyValue(packWithoutDigest(candidate)),
  });
  assertCanonicalEvidencePack(truncated, blueprint, expectedProjectId);
  ISSUED_EVIDENCE_PACKS.add(truncated);
  EVIDENCE_PACK_CLASSIFICATIONS.set(truncated, new Set(classifications));
  return truncated;
}

export function createEvidencePack(
  input: CreateEvidencePackInputV1,
  expectedProjectId: string,
): EvidencePackV1 {
  const snapshot = parseCorpusSnapshot(input.snapshot, expectedProjectId);
  const blueprint = input.blueprint;
  if (
    blueprint.projectId !== expectedProjectId ||
    blueprint.evidenceScope.snapshotDigest !== snapshot.snapshotDigest ||
    input.selectedUnitIds.length < 1 ||
    input.selectedUnitIds.length > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits ||
    input.conflicts.length > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits ||
    input.gaps.length > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits ||
    new Set(input.selectedUnitIds).size !== input.selectedUnitIds.length
  ) invalid(expectedProjectId);
  const selectedIds = new Set(input.selectedUnitIds.map((item) => {
    if (!UNIT_ID_PATTERN.test(item)) invalid(expectedProjectId);
    return item;
  }));
  const sourceById = new Map<string, Readonly<{
    readonly classification: DataClassification;
    readonly content: string;
    readonly source: SanitizedEvidenceSourceV1;
  }>>();
  const snapshotSourceById = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
  for (const source of input.sources) {
    if (sourceById.has(source.sourceId) || !SOURCE_ID_PATTERN.test(source.sourceId)) {
      invalid(expectedProjectId);
    }
    const snapshotSource = snapshotSourceById.get(source.sourceId);
    const prepared = inspectPreparedSource(source.preparedSource);
    if (
      snapshotSource === undefined ||
      prepared === null ||
      source.sourceRevision !== snapshotSource.sourceRevision ||
      source.sourceRef !== snapshotSource.sourceRef ||
      prepared.projectId !== expectedProjectId ||
      prepared.policyDigest !== snapshot.sanitizerPolicyDigest ||
      prepared.source !== source.sourceRef ||
      !['code', 'json', 'markdown', 'planning', 'text'].includes(prepared.sourceKind) ||
      prepared.untrustedData ||
      prepared.sourceRevisionOrContentSha256 !== source.sourceRevision ||
      prepared.approvedBodyDigest !== snapshotSource.sanitizedContentDigest ||
      hierarchySha256(prepared.approvedBody) !== snapshotSource.sanitizedContentDigest ||
      Buffer.byteLength(prepared.approvedBody, 'utf8') >
        HIERARCHICAL_COMPILATION_LIMITS.maxSourceBytes
    ) invalid(expectedProjectId);
    sourceById.set(source.sourceId, Object.freeze({
      classification: prepared.classification,
      content: prepared.approvedBody,
      source,
    }));
  }
  const selectedUnits = snapshot.textUnits.filter((unit) => selectedIds.has(unit.unitId));
  if (selectedUnits.length !== selectedIds.size) invalid(expectedProjectId);
  const units = Object.freeze(selectedUnits.map((unit): EvidenceUnitV1 => {
    if (
      !blueprint.evidenceScope.sourceIds.includes(unit.sourceId) ||
      !blueprint.evidenceScope.allowedUnitKinds.includes(unit.kind)
    ) invalid(expectedProjectId);
    const source = sourceById.get(unit.sourceId);
    if (source === undefined) invalid(expectedProjectId);
    const content = extractUnitContent(source.content, unit, expectedProjectId);
    if (hierarchySha256(content) !== unit.contentDigest) invalid(expectedProjectId);
    const citationBasis = Object.freeze({
      ...(unit.jsonPointer === undefined ? {} : { jsonPointer: unit.jsonPointer }),
      sourceId: unit.sourceId,
      sourceRevision: unit.sourceRevision,
      sourceRef: unit.origin?.sourceRef ?? unit.sourceRef,
      range: unit.origin?.range ?? unit.range,
      quoteDigest: unit.contentDigest,
    });
    const citation = Object.freeze({
      citationId: `citation-${digestHierarchyValue(citationBasis).slice('sha256:'.length)}`,
      ...citationBasis,
    });
    return Object.freeze({
      unitId: unit.unitId,
      sourceId: unit.sourceId,
      kind: unit.kind,
      range: unit.range,
      content,
      contentDigest: unit.contentDigest,
      citation,
    });
  }));
  const unitIds = new Set(units.map((unit) => unit.unitId));
  const conflicts = Object.freeze(input.conflicts.map((item): EvidenceConflictV1 => {
    const kind = portableIdentifier(item.kind, expectedProjectId);
    const conflictUnitIds = Object.freeze([...item.unitIds].sort());
    if (
      conflictUnitIds.length < 2 ||
      new Set(conflictUnitIds).size !== conflictUnitIds.length ||
      conflictUnitIds.some((unitId) => !unitIds.has(unitId))
    ) invalid(expectedProjectId);
    const basis = Object.freeze({ kind, unitIds: conflictUnitIds, status: 'unresolved' as const });
    return Object.freeze({
      conflictId: `conflict-${digestHierarchyValue(basis).slice('sha256:'.length)}`,
      ...basis,
    });
  }).sort((left, right) => left.conflictId < right.conflictId ? -1 : 1));
  if (new Set(conflicts.map((item) => item.conflictId)).size !== conflicts.length) {
    invalid(expectedProjectId);
  }
  const gaps = Object.freeze(input.gaps.map((item): EvidenceGapV1 => {
    const keyQuestion = safeText(item.keyQuestion, 1_000, expectedProjectId);
    const reasonCode = portableIdentifier(item.reasonCode, expectedProjectId);
    if (!blueprint.keyQuestions.includes(keyQuestion)) invalid(expectedProjectId);
    const basis = Object.freeze({ keyQuestion, reasonCode });
    return Object.freeze({
      gapId: `gap-${digestHierarchyValue(basis).slice('sha256:'.length)}`,
      ...basis,
    });
  }).sort((left, right) => left.gapId < right.gapId ? -1 : 1));
  if (new Set(gaps.map((item) => item.gapId)).size !== gaps.length) invalid(expectedProjectId);
  const evidenceBytes = units.reduce((sum, unit) =>
    sum + Buffer.byteLength(unit.content, 'utf8'), 0);
  const candidate = Object.freeze({
    schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
    projectId: expectedProjectId,
    pageId: blueprint.pageId,
    blueprintDigest: blueprint.blueprintDigest,
    snapshotDigest: snapshot.snapshotDigest,
    sanitizerPolicyDigest: snapshot.sanitizerPolicyDigest,
    units,
    conflicts,
    gaps,
    evidenceBytes,
  });
  const pack = Object.freeze({
    ...candidate,
    packDigest: digestHierarchyValue(packWithoutDigest(candidate)),
  });
  if (
    evidenceBytes > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceBytes ||
    Buffer.byteLength(serializeCanonicalJson(pack), 'utf8') >
      HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceBytes
  ) invalid(expectedProjectId);
  ISSUED_EVIDENCE_PACKS.add(pack);
  const classifications = new Set<DataClassification>();
  for (const unit of units) {
    const source = sourceById.get(unit.sourceId);
    if (source === undefined) invalid(expectedProjectId);
    classifications.add(source.classification);
  }
  if (classifications.size < 1) invalid(expectedProjectId);
  EVIDENCE_PACK_CLASSIFICATIONS.set(pack, classifications);
  return pack;
}

function requestWithoutDigest(
  request: Omit<CurrentSessionGenerationRequestV1, 'requestDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: request.schemaVersion,
    projectId: request.projectId,
    pageId: request.pageId,
    blueprintDigest: request.blueprintDigest,
    evidencePackDigest: request.evidencePackDigest,
    generationOrder: request.generationOrder,
    generationAttempt: request.generationAttempt,
    instructionCodes: request.instructionCodes,
    requiredSections: request.requiredSections,
    requiredLinkPageIds: request.requiredLinkPageIds,
    approvedChildSummaries: request.approvedChildSummaries,
    executionMode: request.executionMode,
    egress: request.egress,
    providerUsed: request.providerUsed,
    processSpawned: request.processSpawned,
  };
}

function approvedChildReviewDigest(summary: ApprovedChildSummaryV1): HierarchySha256Digest {
  return digestHierarchyValue({
    pageId: summary.pageId,
    proposalDigest: summary.proposalDigest,
    decision: 'accepted',
  });
}

function assertCanonicalApprovedChildSummary(
  summary: ApprovedChildSummaryV1,
  projectId: string,
): void {
  if (
    !PAGE_ID_PATTERN.test(summary.pageId) ||
    !DIGEST_PATTERN.test(summary.proposalDigest) ||
    summary.synthesisApproved !== true ||
    summary.reviewDigest !== approvedChildReviewDigest(summary) ||
    !sameStrings(summary.citationIds, [...summary.citationIds].sort()) ||
    summary.citationIds.some((item) => !CITATION_ID_PATTERN.test(item)) ||
    new Set(summary.citationIds).size !== summary.citationIds.length
  ) invalid(projectId);
  safeText(summary.summary, 4_096, projectId, true);
}

function requiredLinkPageIds(blueprint: PageBlueprintV1): readonly string[] {
  return Object.freeze([...new Set([
    ...(blueprint.parentPageId === null ? [] : [blueprint.parentPageId]),
    ...blueprint.childPageIds,
    ...blueprint.relatedPageIds,
  ])].sort());
}

function assertCanonicalGenerationRequest(
  request: CurrentSessionGenerationRequestV1,
  blueprint: PageBlueprintV1,
  evidencePack: EvidencePackV1,
  projectId: string,
): void {
  const childById = new Map(request.approvedChildSummaries.map((summary) =>
    [summary.pageId, summary]));
  request.approvedChildSummaries.forEach((summary) =>
    assertCanonicalApprovedChildSummary(summary, projectId));
  if (
    request.schemaVersion !== CURRENT_SESSION_GENERATION_REQUEST_SCHEMA_VERSION ||
    request.projectId !== projectId ||
    blueprint.projectId !== projectId ||
    request.pageId !== blueprint.pageId ||
    request.blueprintDigest !== blueprint.blueprintDigest ||
    request.evidencePackDigest !== evidencePack.packDigest ||
    request.generationOrder !== blueprint.generationOrder ||
    !Number.isSafeInteger(request.generationAttempt) || request.generationAttempt < 0 ||
    request.generationAttempt > 3 ||
    !sameStrings(request.instructionCodes, CURRENT_SESSION_INSTRUCTION_CODES) ||
    !sameStrings(request.requiredSections, blueprint.requiredSections) ||
    !sameStrings(request.requiredLinkPageIds, requiredLinkPageIds(blueprint)) ||
    childById.size !== request.approvedChildSummaries.length ||
    !sameStrings([...childById.keys()].sort(), [...blueprint.childPageIds].sort()) ||
    request.executionMode !== 'current-session' ||
    request.egress !== 'none' ||
    request.providerUsed !== null ||
    request.processSpawned !== false ||
    request.requestDigest !== digestHierarchyValue(requestWithoutDigest(request))
  ) invalid(projectId);
}

export function createCurrentSessionGenerationRequest(
  blueprint: PageBlueprintV1,
  evidencePack: EvidencePackV1,
  approvedChildSummariesValue: readonly ApprovedChildSummaryV1[],
  expectedProjectId: string,
  generationAttempt = 0,
): CurrentSessionGenerationRequestV1 {
  assertCanonicalEvidencePack(evidencePack, blueprint, expectedProjectId);
  if (
    blueprint.projectId !== expectedProjectId ||
    evidencePack.projectId !== expectedProjectId ||
    evidencePack.pageId !== blueprint.pageId ||
    evidencePack.blueprintDigest !== blueprint.blueprintDigest ||
    !Number.isSafeInteger(generationAttempt) || generationAttempt < 0 || generationAttempt > 3
  ) invalid(expectedProjectId);
  const childById = new Map(approvedChildSummariesValue.map((summary) =>
    [summary.pageId, summary]));
  if (
    childById.size !== approvedChildSummariesValue.length ||
    !sameStrings([...childById.keys()].sort(), [...blueprint.childPageIds].sort())
  ) invalid(expectedProjectId);
  const approvedChildSummaries = Object.freeze([...approvedChildSummariesValue]
    .sort((left, right) => left.pageId < right.pageId ? -1 : 1)
    .map((summary) => {
      assertCanonicalApprovedChildSummary(summary, expectedProjectId);
      return Object.freeze({
        ...summary,
        summary: safeText(summary.summary, 4_096, expectedProjectId, true),
        citationIds: Object.freeze([...summary.citationIds].sort()),
      });
    }));
  if (new Set(approvedChildSummaries.flatMap((summary) => [...summary.citationIds])).size >
      HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits) invalid(expectedProjectId);
  const requiredLinks = requiredLinkPageIds(blueprint);
  const requiredSections = Object.freeze([...blueprint.requiredSections]);
  const candidate = Object.freeze({
    schemaVersion: CURRENT_SESSION_GENERATION_REQUEST_SCHEMA_VERSION,
    projectId: expectedProjectId,
    pageId: blueprint.pageId,
    blueprintDigest: blueprint.blueprintDigest,
    evidencePackDigest: evidencePack.packDigest,
    generationOrder: blueprint.generationOrder,
    generationAttempt,
    instructionCodes: Object.freeze([...CURRENT_SESSION_INSTRUCTION_CODES]),
    requiredSections,
    requiredLinkPageIds: requiredLinks,
    approvedChildSummaries,
    executionMode: 'current-session' as const,
    egress: 'none' as const,
    providerUsed: null,
    processSpawned: false as const,
  });
  const request = Object.freeze({
    ...candidate,
    requestDigest: digestHierarchyValue(requestWithoutDigest(candidate)),
  });
  assertCanonicalGenerationRequest(request, blueprint, evidencePack, expectedProjectId);
  return request;
}

interface RenderedBodyMarkers {
  readonly citationIds: readonly string[];
  readonly linkPageIds: readonly string[];
}

function renderedBodyMarkers(body: string): RenderedBodyMarkers {
  const citationIds = new Set<string>();
  const linkPageIds = new Set<string>();
  let fence: Readonly<{ readonly character: '`' | '~'; readonly length: number }> | null = null;
  for (const line of body.split('\n')) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fenceMatch !== undefined) {
      const character = fenceMatch[0] as '`' | '~';
      if (fence === null) {
        fence = Object.freeze({ character, length: fenceMatch.length });
      } else if (fence.character === character && fenceMatch.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    for (const match of line.matchAll(/(?<!\\)\[\^(citation-[a-f0-9]{64})\]/gu)) {
      const citationId = match[1];
      if (citationId !== undefined) citationIds.add(citationId);
    }
    for (const match of line.matchAll(/(?<!\\)\[\[(page-[a-f0-9]{64})\]\]/gu)) {
      const pageIdentifier = match[1];
      if (pageIdentifier !== undefined) linkPageIds.add(pageIdentifier);
    }
  }
  return Object.freeze({
    citationIds: Object.freeze([...citationIds].sort()),
    linkPageIds: Object.freeze([...linkPageIds].sort()),
  });
}

export interface HierarchicalProposalClaimInputV1 {
  readonly text: string;
  readonly evidenceUnitIds: readonly string[];
  readonly citationIds: readonly string[];
}

export interface HierarchicalProposalInputV1 {
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly HierarchicalProposalSectionV1[];
  readonly claims: readonly HierarchicalProposalClaimInputV1[];
  readonly wikilinks: readonly string[];
}

function proposalWithoutDigest(
  proposal: Omit<HierarchicalWikiProposalV1, 'proposalDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: proposal.schemaVersion,
    projectId: proposal.projectId,
    pageId: proposal.pageId,
    blueprintDigest: proposal.blueprintDigest,
    evidencePackDigest: proposal.evidencePackDigest,
    requestDigest: proposal.requestDigest,
    title: proposal.title,
    summary: proposal.summary,
    sections: proposal.sections,
    claims: proposal.claims,
    wikilinks: proposal.wikilinks,
    citationIds: proposal.citationIds,
    lifecycle: proposal.lifecycle,
  };
}

function assertCanonicalProposal(
  proposal: HierarchicalWikiProposalV1,
  projectId: string,
): void {
  if (
    proposal.schemaVersion !== HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION ||
    proposal.projectId !== projectId ||
    !PAGE_ID_PATTERN.test(proposal.pageId) ||
    !DIGEST_PATTERN.test(proposal.blueprintDigest) ||
    !DIGEST_PATTERN.test(proposal.evidencePackDigest) ||
    !DIGEST_PATTERN.test(proposal.requestDigest) ||
    proposal.lifecycle !== 'candidate' ||
    proposal.proposalDigest !== digestHierarchyValue(proposalWithoutDigest(proposal)) ||
    proposal.sections.length < 1 ||
    proposal.sections.length > 32 ||
    new Set(proposal.sections.map((section) => section.sectionId)).size !==
      proposal.sections.length ||
    !sameStrings(proposal.wikilinks, [...proposal.wikilinks].sort()) ||
    !sameStrings(proposal.citationIds, [...proposal.citationIds].sort()) ||
    proposal.wikilinks.some((item) => !PAGE_ID_PATTERN.test(item)) ||
    proposal.citationIds.some((item) => !CITATION_ID_PATTERN.test(item)) ||
    new Set(proposal.wikilinks).size !== proposal.wikilinks.length ||
    new Set(proposal.citationIds).size !== proposal.citationIds.length
  ) invalid(projectId);
  safeText(proposal.title, 1_000, projectId);
  safeText(proposal.summary, 4_096, projectId, true);
  for (const section of proposal.sections) {
    portableIdentifier(section.sectionId, projectId);
    if (section.title !== undefined) safeText(section.title, 1_000, projectId);
    safeText(section.body, MAX_PROPOSAL_BYTES, projectId, true);
  }
  for (const claim of proposal.claims) {
    const basis = Object.freeze({
      text: safeText(claim.text, 4_096, projectId, true),
      evidenceUnitIds: claim.evidenceUnitIds,
      citationIds: claim.citationIds,
    });
    if (
      claim.claimId !== `claim-${digestHierarchyValue(basis).slice('sha256:'.length)}` ||
      !sameStrings(claim.evidenceUnitIds, [...claim.evidenceUnitIds].sort()) ||
      !sameStrings(claim.citationIds, [...claim.citationIds].sort()) ||
      claim.evidenceUnitIds.some((item) => !UNIT_ID_PATTERN.test(item)) ||
      claim.citationIds.some((item) => !CITATION_ID_PATTERN.test(item))
    ) invalid(projectId);
  }
  if (Buffer.byteLength(serializeCanonicalJson(proposal), 'utf8') > MAX_PROPOSAL_BYTES) {
    invalid(projectId);
  }
}

function tokenWeight(token: string): number {
  return /\p{N}/u.test(token) || [...token].length >= 8 ? 2 : 1;
}

function summarySupportingCitationIds(
  proposal: HierarchicalWikiProposalV1,
): readonly string[] {
  const summaryTokens = [...new Set(hierarchyTokens(proposal.summary))];
  const requiredWeight = Math.ceil(summaryTokens.reduce((sum, token) =>
    sum + tokenWeight(token), 0) / 2);
  const covered = new Set<string>();
  const remaining = new Map(proposal.claims.map((claim) => [claim.claimId, claim]));
  const selected: HierarchicalProposalClaimV1[] = [];
  let coveredWeight = 0;
  while (coveredWeight < requiredWeight && remaining.size > 0) {
    const ranked = [...remaining.values()].map((claim) => {
      const claimTokens = new Set(hierarchyTokens(claim.text));
      const gain = summaryTokens.filter((token) =>
        !covered.has(token) && claimTokens.has(token))
        .reduce((sum, token) => sum + tokenWeight(token), 0);
      return Object.freeze({ claim, gain });
    }).sort((left, right) =>
      right.gain - left.gain || left.claim.claimId.localeCompare(right.claim.claimId));
    const next = ranked[0];
    if (next === undefined || next.gain === 0) break;
    remaining.delete(next.claim.claimId);
    selected.push(next.claim);
    const claimTokens = new Set(hierarchyTokens(next.claim.text));
    for (const token of summaryTokens) {
      if (!covered.has(token) && claimTokens.has(token)) {
        covered.add(token);
        coveredWeight += tokenWeight(token);
      }
    }
  }
  if (selected.length === 0 || coveredWeight < requiredWeight) {
    return proposal.citationIds;
  }
  return Object.freeze([...new Set(selected.flatMap((claim) => claim.citationIds))].sort());
}

/** Returns the smallest deterministic claim citation set that grounds half of the summary. */
export function citationIdsForProposalSummary(
  proposal: HierarchicalWikiProposalV1,
  expectedProjectId: string,
): readonly string[] {
  assertCanonicalProposal(proposal, expectedProjectId);
  const citationIds = summarySupportingCitationIds(proposal);
  if (citationIds.length < 1 ||
      citationIds.some((citationId) => !proposal.citationIds.includes(citationId))) {
    invalid(expectedProjectId);
  }
  return citationIds;
}

export function submitCurrentSessionProposal(
  blueprint: PageBlueprintV1,
  request: CurrentSessionGenerationRequestV1,
  evidencePack: EvidencePackV1,
  input: HierarchicalProposalInputV1,
  expectedProjectId: string,
): HierarchicalWikiProposalV1 {
  assertCanonicalEvidencePack(evidencePack, blueprint, expectedProjectId);
  assertCanonicalGenerationRequest(request, blueprint, evidencePack, expectedProjectId);
  if (
    request.projectId !== expectedProjectId ||
    request.executionMode !== 'current-session' ||
    request.egress !== 'none' ||
    request.providerUsed !== null ||
    request.processSpawned !== false ||
    evidencePack.projectId !== expectedProjectId ||
    request.evidencePackDigest !== evidencePack.packDigest ||
    request.requestDigest !== digestHierarchyValue(requestWithoutDigest(request))
  ) invalid(expectedProjectId);
  if (input.claims.length < 1 || input.claims.length > 512 || input.sections.length < 1 ||
      input.sections.length > request.requiredSections.length + 8) {
    invalid(expectedProjectId);
  }
  const sectionById = new Map(input.sections.map((section) => [section.sectionId, section]));
  if (
    sectionById.size !== input.sections.length ||
    request.requiredSections.some((sectionId) => !sectionById.has(sectionId))
  ) invalid(expectedProjectId);
  const optionalSections = input.sections.filter((section) =>
    !request.requiredSections.includes(section.sectionId));
  if (optionalSections.length > 8) invalid(expectedProjectId);
  const orderedSections = [
    ...request.requiredSections.map((sectionId) => sectionById.get(sectionId)),
    ...optionalSections,
  ];
  const sections = Object.freeze(orderedSections.map((section) => {
    if (section === undefined) invalid(expectedProjectId);
    const sectionId = portableIdentifier(section.sectionId, expectedProjectId);
    return Object.freeze({
      sectionId,
      ...(section.title === undefined
        ? {}
        : { title: safeText(section.title, 1_000, expectedProjectId) }),
      body: safeText(section.body, MAX_PROPOSAL_BYTES, expectedProjectId, true),
    });
  }));
  const combinedBody = sections.map((section) => section.body).join('\n');
  const markersBySection = new Map(sections.map((section) =>
    [section.sectionId, renderedBodyMarkers(section.body)]));
  const unitById = new Map(evidencePack.units.map((unit) => [unit.unitId, unit]));
  const citationById = new Map(evidencePack.units.map((unit) =>
    [unit.citation.citationId, unit.citation]));
  const citationUnitIdById = new Map(evidencePack.units.map((unit) =>
    [unit.citation.citationId, unit.unitId]));
  const claims = Object.freeze(input.claims.map((claim): HierarchicalProposalClaimV1 => {
    const text = safeText(claim.text, 4_096, expectedProjectId, true);
    const evidenceUnitIds = Object.freeze([...claim.evidenceUnitIds].sort());
    const citationIds = Object.freeze([...claim.citationIds].sort());
    if (
      evidenceUnitIds.length < 1 ||
      citationIds.length < 1 ||
      new Set(evidenceUnitIds).size !== evidenceUnitIds.length ||
      new Set(citationIds).size !== citationIds.length ||
      evidenceUnitIds.some((item) => !unitById.has(item)) ||
      citationIds.some((item) => !citationById.has(item)) ||
      citationIds.some((item) => {
        const unitId = citationUnitIdById.get(item);
        return unitId === undefined || !evidenceUnitIds.includes(unitId);
      }) ||
      !combinedBody.includes(text) ||
      !sections.some((section) => section.body.includes(text) && citationIds.every((citationId) =>
        markersBySection.get(section.sectionId)?.citationIds.includes(citationId) === true))
    ) invalid(expectedProjectId);
    const basis = Object.freeze({ text, evidenceUnitIds, citationIds });
    return Object.freeze({
      claimId: `claim-${digestHierarchyValue(basis).slice('sha256:'.length)}`,
      ...basis,
    });
  }).sort((left, right) => left.claimId < right.claimId ? -1 : 1));
  if (
    claims.length < 1 ||
    new Set(claims.map((claim) => claim.claimId)).size !== claims.length ||
    claims.some((claim) => !CLAIM_ID_PATTERN.test(claim.claimId))
  ) invalid(expectedProjectId);
  const childCitationIds = request.approvedChildSummaries.flatMap((summary) =>
    [...summary.citationIds]);
  const citationIds = Object.freeze([...new Set([
    ...claims.flatMap((claim) => claim.citationIds),
    ...childCitationIds,
  ])].sort());
  if (
    citationIds.length > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits ||
    request.approvedChildSummaries.some((summary) => !sections.some((section) =>
      section.body.includes(summary.summary) && summary.citationIds.every((citationId) =>
        markersBySection.get(section.sectionId)?.citationIds.includes(citationId) === true)))
  ) invalid(expectedProjectId);
  const wikilinks = Object.freeze([...input.wikilinks].sort());
  const renderedMarkers = renderedBodyMarkers(combinedBody);
  if (
    new Set(wikilinks).size !== wikilinks.length ||
    wikilinks.some((item) => !PAGE_ID_PATTERN.test(item)) ||
    !sameStrings(wikilinks, request.requiredLinkPageIds) ||
    !sameStrings(renderedMarkers.citationIds, citationIds) ||
    !sameStrings(renderedMarkers.linkPageIds, wikilinks)
  ) invalid(expectedProjectId);
  const candidate = Object.freeze({
    schemaVersion: HIERARCHICAL_WIKI_PROPOSAL_SCHEMA_VERSION,
    projectId: expectedProjectId,
    pageId: request.pageId,
    blueprintDigest: request.blueprintDigest,
    evidencePackDigest: evidencePack.packDigest,
    requestDigest: request.requestDigest,
    title: safeText(input.title, 1_000, expectedProjectId),
    summary: safeText(input.summary, 4_096, expectedProjectId, true),
    sections,
    claims,
    wikilinks,
    citationIds,
    lifecycle: 'candidate' as const,
  });
  const proposal = Object.freeze({
    ...candidate,
    proposalDigest: digestHierarchyValue(proposalWithoutDigest(candidate)),
  });
  if (Buffer.byteLength(serializeCanonicalJson(proposal), 'utf8') > MAX_PROPOSAL_BYTES) {
    invalid(expectedProjectId);
  }
  assertCanonicalProposal(proposal, expectedProjectId);
  return proposal;
}

export interface ChildSynthesisReviewV1 {
  readonly pageId: string;
  readonly proposalDigest: HierarchySha256Digest;
  readonly reviewDigest: HierarchySha256Digest;
  readonly decision: 'accepted' | 'rejected';
}

export function approveChildSummaryForSynthesis(
  proposal: HierarchicalWikiProposalV1,
  approval: ChildSynthesisReviewV1,
  expectedProjectId: string,
): ApprovedChildSummaryV1 {
  assertCanonicalProposal(proposal, expectedProjectId);
  if (
    proposal.projectId !== expectedProjectId ||
    proposal.lifecycle !== 'candidate' ||
    approval.pageId !== proposal.pageId ||
    approval.decision !== 'accepted' ||
    approval.proposalDigest !== proposal.proposalDigest ||
    approval.reviewDigest !== digestHierarchyValue({
      pageId: approval.pageId,
      proposalDigest: approval.proposalDigest,
      decision: approval.decision,
    })
  ) {
    invalid(expectedProjectId);
  }
  const summary = Object.freeze({
    pageId: proposal.pageId,
    proposalDigest: proposal.proposalDigest,
    reviewDigest: approval.reviewDigest,
    summary: proposal.summary,
    citationIds: citationIdsForProposalSummary(proposal, expectedProjectId),
    synthesisApproved: true,
  });
  assertCanonicalApprovedChildSummary(summary, expectedProjectId);
  return summary;
}

export function reconcileWikiProposalLinks(
  outline: WikiOutlineV1,
  proposals: readonly HierarchicalWikiProposalV1[],
  expectedProjectId: string,
): WikiLinkReconciliationV1 {
  if (outline.projectId !== expectedProjectId || proposals.length !== outline.blueprints.length) {
    invalid(expectedProjectId);
  }
  const proposalById = new Map(proposals.map((proposal) => [proposal.pageId, proposal]));
  if (proposalById.size !== proposals.length) invalid(expectedProjectId);
  const entries = Object.freeze(outline.blueprints.map((blueprint) => {
    const proposal = proposalById.get(blueprint.pageId);
    const requiredLinkPageIds = Object.freeze([...new Set([
      ...(blueprint.parentPageId === null ? [] : [blueprint.parentPageId]),
      ...blueprint.childPageIds,
      ...blueprint.relatedPageIds,
    ])].sort());
    if (
      proposal === undefined ||
      proposal.projectId !== expectedProjectId ||
      proposal.blueprintDigest !== blueprint.blueprintDigest ||
      !sameStrings(proposal.wikilinks, requiredLinkPageIds)
    ) invalid(expectedProjectId);
    assertCanonicalProposal(proposal, expectedProjectId);
    return Object.freeze({ pageId: blueprint.pageId, requiredLinkPageIds });
  }).sort((left, right) => left.pageId < right.pageId ? -1 : 1));
  const candidate = Object.freeze({
    schemaVersion: WIKI_LINK_RECONCILIATION_SCHEMA_VERSION,
    projectId: expectedProjectId,
    outlineDigest: outline.outlineDigest,
    entries,
    complete: true as const,
  });
  return Object.freeze({
    ...candidate,
    reconciliationDigest: digestHierarchyValue(candidate),
  });
}

export function createExternalGenerationAuthorization(
  input: Omit<
    ExternalGenerationAuthorizationV1,
    'adapterIncluded' | 'authorizationDigest' | 'decision' | 'egress' | 'schemaVersion'
  >,
): ExternalGenerationAuthorizationV1 {
  const projectId = input.projectId;
  if (!PROJECT_ID_PATTERN.test(projectId)) invalid(projectId);
  const candidate = Object.freeze({
    schemaVersion: EXTERNAL_GENERATION_AUTHORIZATION_SCHEMA_VERSION,
    projectId,
    destinationId: portableIdentifier(input.destinationId, projectId),
    providerIdentity: portableIdentifier(input.providerIdentity, projectId),
    sanitizedPayloadScopeDigest: input.sanitizedPayloadScopeDigest,
    decision: 'approved' as const,
    egress: 'sanitized-evidence-only' as const,
    adapterIncluded: false as const,
  });
  if (!/^sha256:[a-f0-9]{64}$/u.test(candidate.sanitizedPayloadScopeDigest)) invalid(projectId);
  return Object.freeze({
    ...candidate,
    authorizationDigest: digestHierarchyValue(candidate),
  });
}

/**
 * Verifies the closed, user-approved authority before any caller-provided external
 * generation port can be reached.
 */
export function parseExternalGenerationAuthorization(
  value: unknown,
  expectedProjectId: string,
): ExternalGenerationAuthorizationV1 {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !PROJECT_ID_PATTERN.test(expectedProjectId)
    ) invalid(expectedProjectId);
    const authorization = value as Readonly<Record<string, unknown>>;
    const expectedKeys = [
      'schemaVersion',
      'projectId',
      'destinationId',
      'providerIdentity',
      'sanitizedPayloadScopeDigest',
      'decision',
      'egress',
      'adapterIncluded',
      'authorizationDigest',
    ].sort();
    if (!sameStrings(Object.keys(authorization).sort(), expectedKeys)) {
      invalid(expectedProjectId);
    }
    if (
      authorization.schemaVersion !== EXTERNAL_GENERATION_AUTHORIZATION_SCHEMA_VERSION ||
      authorization.projectId !== expectedProjectId ||
      authorization.decision !== 'approved' ||
      authorization.egress !== 'sanitized-evidence-only' ||
      authorization.adapterIncluded !== false ||
      typeof authorization.destinationId !== 'string' ||
      portableIdentifier(authorization.destinationId, expectedProjectId) !==
        authorization.destinationId ||
      typeof authorization.providerIdentity !== 'string' ||
      portableIdentifier(authorization.providerIdentity, expectedProjectId) !==
        authorization.providerIdentity ||
      typeof authorization.sanitizedPayloadScopeDigest !== 'string' ||
      !DIGEST_PATTERN.test(authorization.sanitizedPayloadScopeDigest) ||
      typeof authorization.authorizationDigest !== 'string' ||
      !DIGEST_PATTERN.test(authorization.authorizationDigest)
    ) invalid(expectedProjectId);
    const unsigned = { ...authorization };
    delete unsigned.authorizationDigest;
    if (authorization.authorizationDigest !== digestHierarchyValue(unsigned)) {
      invalid(expectedProjectId);
    }
    return Object.freeze({ ...authorization }) as unknown as
      ExternalGenerationAuthorizationV1;
  } catch {
    return invalid(expectedProjectId);
  }
}

// CompilePartitionV2 remains a type-only dependency here to keep the evidence exchange
// compatible with continuation-owned task ordering without introducing execution effects.
export type EvidencePartitionReferenceV2 = Pick<
  CompilePartitionV2,
  'partitionDigest' | 'taskDispositions'
>;
