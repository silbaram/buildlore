import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { validateProjectId } from '../../knowledge/validation.js';
import {
  neutralSourceRetrievalMeaning,
  parseSourceRetrievalMeaning,
  validatePortableSourceRef,
  validateSourceRetrievalSupersessionGraph,
  type SourceRetrievalMeaningOrigin,
} from '../../projector/source-contracts.js';
import { HierarchyContractError } from './errors.js';
import {
  COMPILATION_PURPOSE_SCHEMA_VERSION,
  CORPUS_SNAPSHOT_SCHEMA_VERSION,
  DOCUMENT_INTERPRETATION_SCHEMA_VERSION,
  HIERARCHICAL_COMPILATION_POLICY_SCHEMA_VERSION,
  LEGACY_CORPUS_SNAPSHOT_SCHEMA_VERSION,
  TEXT_UNIT_SCHEMA_VERSION,
  type CompilationPurposeV1,
  type CorpusSnapshotSourceV1,
  type CorpusSnapshotV1,
  type DocumentAuthority,
  type DocumentInterpretationV1,
  type DocumentLifecycle,
  type DocumentRelationKind,
  type DocumentRelationV1,
  type HierarchicalCompilationLimitsV1,
  type HierarchicalCompilationPolicyV1,
  type HierarchySha256Digest,
  type SynthesisEligibility,
  type TextUnitKind,
  type TextUnitRangeV1,
  type TextUnitV1,
} from './types.js';

export const HIERARCHICAL_COMPILATION_LIMITS: HierarchicalCompilationLimitsV1 =
  Object.freeze({
    maxClusterMembers: 256,
    maxEvidenceBytes: 262144,
    maxEvidenceSourcesPerPage: 8,
    maxEvidenceUnits: 64,
    maxEvidenceUnitsPerSource: 8,
    maxPartitionTasks: 256,
    maxPlanBytes: 33554432,
    maxRelationCandidatesPerTask: 32,
    maxSourceBytes: 524288,
    maxSources: 4096,
    maxTasks: 8192,
  });

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GENERATED_SOURCE_ID_PATTERN = /^source-[a-f0-9]{64}$/u;
const GENERATED_UNIT_ID_PATTERN = /^unit-[a-f0-9]{64}$/u;
const PORTABLE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const OUTPUT_LANGUAGE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const MAX_PURPOSE_ITEMS = 64;
const MAX_PURPOSE_TEXT = 1_000;
const MAX_INTERPRETATION_ITEMS = 64;

type UnknownRecord = Readonly<Record<string, unknown>>;

function invalid(projectId: string): never {
  throw new HierarchyContractError(projectId);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, projectId: string): UnknownRecord {
  return isRecord(value) ? value : invalid(projectId);
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  projectId: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) invalid(projectId);
}

function hasUnsafeCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return /\p{Cf}/u.test(value);
}

function unicodeScalarLength(value: string): number {
  return [...value].length;
}

function text(
  value: unknown,
  projectId: string,
  options: {
    readonly max: number;
    readonly pattern?: RegExp;
  },
): string {
  if (typeof value !== 'string') invalid(projectId);
  const scalarLength = unicodeScalarLength(value);
  if (
    scalarLength < 1 ||
    scalarLength > options.max ||
    value !== value.normalize('NFC') ||
    value.includes('\r') ||
    hasUnsafeCharacter(value) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) invalid(projectId);
  return value;
}

function project(value: unknown, fallbackProjectId: string): string {
  if (typeof value !== 'string') return invalid(fallbackProjectId);
  try {
    return validateProjectId(value);
  } catch {
    return invalid(fallbackProjectId);
  }
}

function expectedProject(value: unknown, expectedProjectId: string): string {
  const parsed = project(value, expectedProjectId);
  return parsed === expectedProjectId ? parsed : invalid(expectedProjectId);
}

function digest(value: unknown, projectId: string): HierarchySha256Digest {
  return text(value, projectId, { max: 71, pattern: DIGEST_PATTERN }) as
    HierarchySha256Digest;
}

function safeInteger(
  value: unknown,
  projectId: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) invalid(projectId);
  return value;
}

function assertArrayBounds(
  value: unknown,
  projectId: string,
  minimum: number,
  maximum: number,
): void {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalid(projectId);
  }
}

function uniqueTextArray(
  value: unknown,
  projectId: string,
  options: {
    readonly maxItems: number;
    readonly maxText: number;
    readonly pattern?: RegExp;
    readonly requireNonEmpty?: boolean;
    readonly sorted?: boolean;
  },
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > options.maxItems ||
    (options.requireNonEmpty === true && value.length === 0)
  ) invalid(projectId);
  const result = value.map((item) => text(item, projectId, {
    max: options.maxText,
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
  }));
  if (new Set(result).size !== result.length) invalid(projectId);
  if (
    options.sorted === true &&
    result.some((item, index) => index > 0 && (result[index - 1] as string) >= item)
  ) invalid(projectId);
  return Object.freeze(result);
}

export function hierarchySha256(value: string | Uint8Array): HierarchySha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function digestHierarchyValue(value: unknown): HierarchySha256Digest {
  return hierarchySha256(serializeCanonicalJson(value));
}

const policyWithoutDigest = Object.freeze({
  schemaVersion: HIERARCHICAL_COMPILATION_POLICY_SCHEMA_VERSION,
  limits: HIERARCHICAL_COMPILATION_LIMITS,
});

export const HIERARCHICAL_COMPILATION_POLICY: HierarchicalCompilationPolicyV1 =
  Object.freeze({
    ...policyWithoutDigest,
    policyDigest: digestHierarchyValue(policyWithoutDigest),
  });

export function parseHierarchicalCompilationPolicy(
  value: unknown,
): HierarchicalCompilationPolicyV1 {
  const policy = record(value, 'unknown');
  exactKeys(policy, ['limits', 'policyDigest', 'schemaVersion'], 'unknown');
  if (
    policy.schemaVersion !== HIERARCHICAL_COMPILATION_POLICY_SCHEMA_VERSION ||
    !isRecord(policy.limits)
  ) invalid('unknown');
  exactKeys(policy.limits, [
    'maxClusterMembers',
    'maxEvidenceBytes',
    'maxEvidenceSourcesPerPage',
    'maxEvidenceUnits',
    'maxEvidenceUnitsPerSource',
    'maxPartitionTasks',
    'maxPlanBytes',
    'maxRelationCandidatesPerTask',
    'maxSourceBytes',
    'maxSources',
    'maxTasks',
  ], 'unknown');
  for (const [key, expected] of Object.entries(HIERARCHICAL_COMPILATION_LIMITS)) {
    if (policy.limits[key] !== expected) invalid('unknown');
  }
  if (digest(policy.policyDigest, 'unknown') !== HIERARCHICAL_COMPILATION_POLICY.policyDigest) {
    invalid('unknown');
  }
  return HIERARCHICAL_COMPILATION_POLICY;
}

type CompilationPurposeInput = Omit<CompilationPurposeV1, 'purposeDigest' | 'schemaVersion'>;

function purposeWithoutDigest(purpose: Omit<CompilationPurposeV1, 'purposeDigest'>):
Readonly<Record<string, unknown>> {
  return {
    schemaVersion: purpose.schemaVersion,
    projectId: purpose.projectId,
    audience: purpose.audience,
    goals: purpose.goals,
    keyQuestions: purpose.keyQuestions,
    scopeHints: purpose.scopeHints,
    excludedTopics: purpose.excludedTopics,
    outputLanguage: purpose.outputLanguage,
    requestedPageRoles: purpose.requestedPageRoles,
    ...(purpose.wikiTitle === undefined ? {} : { wikiTitle: purpose.wikiTitle }),
  };
}

export function createCompilationPurpose(input: CompilationPurposeInput): CompilationPurposeV1 {
  const candidate = {
    schemaVersion: COMPILATION_PURPOSE_SCHEMA_VERSION,
    projectId: input.projectId,
    audience: input.audience,
    goals: input.goals,
    keyQuestions: input.keyQuestions,
    scopeHints: input.scopeHints,
    excludedTopics: input.excludedTopics,
    outputLanguage: input.outputLanguage,
    requestedPageRoles: input.requestedPageRoles,
    ...(input.wikiTitle === undefined ? {} : { wikiTitle: input.wikiTitle }),
  } as const;
  return parseCompilationPurpose({
    ...candidate,
    purposeDigest: digestHierarchyValue(purposeWithoutDigest(candidate)),
  }, input.projectId);
}

export function parseCompilationPurpose(
  value: unknown,
  expectedProjectId: string,
): CompilationPurposeV1 {
  const projectId = project(expectedProjectId, 'unknown');
  const purpose = record(value, projectId);
  const purposeKeys = [
    'audience',
    'excludedTopics',
    'goals',
    'keyQuestions',
    'outputLanguage',
    'projectId',
    'purposeDigest',
    'requestedPageRoles',
    'schemaVersion',
    'scopeHints',
  ];
  const actualPurposeKeys = Object.keys(purpose).sort();
  const legacyPurposeKeys = [...purposeKeys].sort();
  const titledPurposeKeys = [...purposeKeys, 'wikiTitle'].sort();
  if (actualPurposeKeys.join('\0') !== legacyPurposeKeys.join('\0') &&
      actualPurposeKeys.join('\0') !== titledPurposeKeys.join('\0')) invalid(projectId);
  if (purpose.schemaVersion !== COMPILATION_PURPOSE_SCHEMA_VERSION) invalid(projectId);
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: COMPILATION_PURPOSE_SCHEMA_VERSION,
    projectId: expectedProject(purpose.projectId, projectId),
    audience: uniqueTextArray(purpose.audience, projectId, {
      maxItems: MAX_PURPOSE_ITEMS,
      maxText: MAX_PURPOSE_TEXT,
      requireNonEmpty: true,
    }),
    goals: uniqueTextArray(purpose.goals, projectId, {
      maxItems: MAX_PURPOSE_ITEMS,
      maxText: MAX_PURPOSE_TEXT,
      requireNonEmpty: true,
    }),
    keyQuestions: uniqueTextArray(purpose.keyQuestions, projectId, {
      maxItems: MAX_PURPOSE_ITEMS,
      maxText: MAX_PURPOSE_TEXT,
      requireNonEmpty: true,
    }),
    scopeHints: uniqueTextArray(purpose.scopeHints, projectId, {
      maxItems: MAX_PURPOSE_ITEMS,
      maxText: MAX_PURPOSE_TEXT,
    }),
    excludedTopics: uniqueTextArray(purpose.excludedTopics, projectId, {
      maxItems: MAX_PURPOSE_ITEMS,
      maxText: MAX_PURPOSE_TEXT,
    }),
    outputLanguage: text(purpose.outputLanguage, projectId, {
      max: 35,
      pattern: OUTPUT_LANGUAGE_PATTERN,
    }),
    requestedPageRoles: uniqueTextArray(purpose.requestedPageRoles, projectId, {
      maxItems: 32,
      maxText: 64,
      pattern: PORTABLE_IDENTIFIER_PATTERN,
      requireNonEmpty: true,
    }),
    ...(purpose.wikiTitle === undefined ? {} : {
      wikiTitle: text(purpose.wikiTitle, projectId, { max: MAX_PURPOSE_TEXT }),
    }),
  });
  if (Buffer.byteLength(serializeCanonicalJson(parsedWithoutDigest), 'utf8') >
      HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceBytes) invalid(projectId);
  const purposeDigest = digest(purpose.purposeDigest, projectId);
  if (purposeDigest !== digestHierarchyValue(purposeWithoutDigest(parsedWithoutDigest))) {
    invalid(projectId);
  }
  return Object.freeze({ ...parsedWithoutDigest, purposeDigest });
}

const TEXT_UNIT_KINDS = new Set<TextUnitKind>([
  'document',
  'fenced-code',
  'heading',
  'list',
  'paragraph',
  'table',
]);

function parseTextUnitRange(value: unknown, projectId: string): TextUnitRangeV1 {
  const range = record(value, projectId);
  exactKeys(range, ['endColumn', 'endLine', 'startColumn', 'startLine'], projectId);
  const parsed = Object.freeze({
    endColumn: safeInteger(range.endColumn, projectId, 1, Number.MAX_SAFE_INTEGER),
    endLine: safeInteger(range.endLine, projectId, 1, Number.MAX_SAFE_INTEGER),
    startColumn: safeInteger(range.startColumn, projectId, 1, Number.MAX_SAFE_INTEGER),
    startLine: safeInteger(range.startLine, projectId, 1, Number.MAX_SAFE_INTEGER),
  });
  if (
    parsed.endLine < parsed.startLine ||
    (parsed.endLine === parsed.startLine && parsed.endColumn < parsed.startColumn)
  ) invalid(projectId);
  return parsed;
}

function textUnitWithoutId(unit: Omit<TextUnitV1, 'unitId'>): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: unit.schemaVersion,
    projectId: unit.projectId,
    sourceId: unit.sourceId,
    sourceRevision: unit.sourceRevision,
    sourceRef: unit.sourceRef,
    kind: unit.kind,
    ordinal: unit.ordinal,
    range: unit.range,
    contentDigest: unit.contentDigest,
    topicLabel: unit.topicLabel,
  };
}

type TextUnitInput = Omit<TextUnitV1, 'schemaVersion' | 'topicLabel' | 'unitId'> & {
  readonly topicLabel?: string | null;
};

export function createTextUnit(input: TextUnitInput): TextUnitV1 {
  const canonicalRange = parseTextUnitRange(input.range, input.projectId);
  const topicLabel = input.topicLabel === undefined || input.topicLabel === null
    ? null
    : text(input.topicLabel, input.projectId, { max: 1_000 });
  if (topicLabel !== null && input.contentDigest !== hierarchySha256(topicLabel)) {
    invalid(input.projectId);
  }
  const candidate = {
    schemaVersion: TEXT_UNIT_SCHEMA_VERSION,
    projectId: input.projectId,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    sourceRef: input.sourceRef,
    kind: input.kind,
    ordinal: input.ordinal,
    range: canonicalRange,
    contentDigest: input.contentDigest,
    topicLabel,
  } as const;
  return parseTextUnit({
    ...candidate,
    unitId: `unit-${digestHierarchyValue(textUnitWithoutId(candidate)).slice('sha256:'.length)}`,
  }, input.projectId);
}

export function parseTextUnit(value: unknown, expectedProjectId: string): TextUnitV1 {
  const projectId = project(expectedProjectId, 'unknown');
  const unit = record(value, projectId);
  exactKeys(unit, [
    'contentDigest',
    'kind',
    'ordinal',
    'projectId',
    'range',
    'schemaVersion',
    'sourceId',
    'sourceRef',
    'sourceRevision',
    'topicLabel',
    'unitId',
  ], projectId);
  if (
    unit.schemaVersion !== TEXT_UNIT_SCHEMA_VERSION ||
    typeof unit.kind !== 'string' ||
    !TEXT_UNIT_KINDS.has(unit.kind as TextUnitKind)
  ) invalid(projectId);
  let sourceRef: string;
  try {
    sourceRef = validatePortableSourceRef(unit.sourceRef);
  } catch {
    return invalid(projectId);
  }
  const parsedWithoutId = Object.freeze({
    schemaVersion: TEXT_UNIT_SCHEMA_VERSION,
    projectId: expectedProject(unit.projectId, projectId),
    sourceId: text(unit.sourceId, projectId, {
      max: 71,
      pattern: GENERATED_SOURCE_ID_PATTERN,
    }),
    sourceRevision: digest(unit.sourceRevision, projectId),
    sourceRef,
    kind: unit.kind as TextUnitKind,
    ordinal: safeInteger(unit.ordinal, projectId, 0,
      HIERARCHICAL_COMPILATION_LIMITS.maxTasks - 1),
    range: parseTextUnitRange(unit.range, projectId),
    contentDigest: digest(unit.contentDigest, projectId),
    topicLabel: unit.topicLabel === null
      ? null
      : text(unit.topicLabel, projectId, { max: 1_000 }),
  });
  if (
    parsedWithoutId.topicLabel !== null &&
    parsedWithoutId.contentDigest !== hierarchySha256(parsedWithoutId.topicLabel)
  ) invalid(projectId);
  const unitId = text(unit.unitId, projectId, { max: 69, pattern: GENERATED_UNIT_ID_PATTERN });
  const expectedUnitId = `unit-${digestHierarchyValue(textUnitWithoutId(parsedWithoutId))
    .slice('sha256:'.length)}`;
  if (unitId !== expectedUnitId) invalid(projectId);
  return Object.freeze({ ...parsedWithoutId, unitId });
}

const DOCUMENT_LIFECYCLES = new Set<DocumentLifecycle>([
  'current', 'deprecated', 'draft', 'superseded', 'unknown',
]);
const DOCUMENT_AUTHORITIES = new Set<DocumentAuthority>([
  'canonical', 'historical', 'supporting', 'unknown',
]);
const SYNTHESIS_ELIGIBILITIES = new Set<SynthesisEligibility>([
  'eligible', 'excluded', 'review',
]);
const RELATION_KINDS = new Set<DocumentRelationKind>([
  'related', 'superseded-by', 'supersedes',
]);

function parseDocumentRelation(value: unknown, projectId: string): DocumentRelationV1 {
  const relation = record(value, projectId);
  exactKeys(relation, ['kind', 'sourceId'], projectId);
  if (
    typeof relation.kind !== 'string' ||
    !RELATION_KINDS.has(relation.kind as DocumentRelationKind)
  ) invalid(projectId);
  return Object.freeze({
    kind: relation.kind as DocumentRelationKind,
    sourceId: text(relation.sourceId, projectId, {
      max: 71,
      pattern: GENERATED_SOURCE_ID_PATTERN,
    }),
  });
}

function interpretationWithoutDigest(
  interpretation: Omit<DocumentInterpretationV1, 'interpretationDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: interpretation.schemaVersion,
    projectId: interpretation.projectId,
    sourceId: interpretation.sourceId,
    sourceRevision: interpretation.sourceRevision,
    role: interpretation.role,
    lifecycle: interpretation.lifecycle,
    authority: interpretation.authority,
    synthesisEligibility: interpretation.synthesisEligibility,
    basis: interpretation.basis,
    confidenceBasisPoints: interpretation.confidenceBasisPoints,
    reasonCodes: interpretation.reasonCodes,
    relations: interpretation.relations,
  };
}

type DocumentInterpretationInput = Omit<
  DocumentInterpretationV1,
  'interpretationDigest' | 'schemaVersion'
>;

export function createDocumentInterpretation(
  input: DocumentInterpretationInput,
): DocumentInterpretationV1 {
  const projectId = project(input.projectId, 'unknown');
  assertArrayBounds(input.basis, projectId, 1, MAX_INTERPRETATION_ITEMS);
  assertArrayBounds(input.reasonCodes, projectId, 0, MAX_INTERPRETATION_ITEMS);
  assertArrayBounds(input.relations, projectId, 0, MAX_INTERPRETATION_ITEMS);
  const canonicalBasis = Object.freeze([...input.basis].sort());
  const canonicalReasonCodes = Object.freeze([...input.reasonCodes].sort());
  const canonicalRelations = Object.freeze(input.relations
    .map((relation) => parseDocumentRelation(relation, projectId))
    .sort((left, right) => {
      const leftKey = `${left.kind}:${left.sourceId}`;
      const rightKey = `${right.kind}:${right.sourceId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }));
  const candidate = {
    schemaVersion: DOCUMENT_INTERPRETATION_SCHEMA_VERSION,
    projectId: input.projectId,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    role: input.role,
    lifecycle: input.lifecycle,
    authority: input.authority,
    synthesisEligibility: input.synthesisEligibility,
    basis: canonicalBasis,
    confidenceBasisPoints: input.confidenceBasisPoints,
    reasonCodes: canonicalReasonCodes,
    relations: canonicalRelations,
  } as const;
  return parseDocumentInterpretation({
    ...candidate,
    interpretationDigest: digestHierarchyValue(interpretationWithoutDigest(candidate)),
  }, input.projectId);
}

export function parseDocumentInterpretation(
  value: unknown,
  expectedProjectId: string,
): DocumentInterpretationV1 {
  const projectId = project(expectedProjectId, 'unknown');
  const interpretation = record(value, projectId);
  exactKeys(interpretation, [
    'authority',
    'basis',
    'confidenceBasisPoints',
    'interpretationDigest',
    'lifecycle',
    'projectId',
    'reasonCodes',
    'relations',
    'role',
    'schemaVersion',
    'sourceId',
    'sourceRevision',
    'synthesisEligibility',
  ], projectId);
  if (
    interpretation.schemaVersion !== DOCUMENT_INTERPRETATION_SCHEMA_VERSION ||
    typeof interpretation.lifecycle !== 'string' ||
    !DOCUMENT_LIFECYCLES.has(interpretation.lifecycle as DocumentLifecycle) ||
    typeof interpretation.authority !== 'string' ||
    !DOCUMENT_AUTHORITIES.has(interpretation.authority as DocumentAuthority) ||
    typeof interpretation.synthesisEligibility !== 'string' ||
    !SYNTHESIS_ELIGIBILITIES.has(
      interpretation.synthesisEligibility as SynthesisEligibility,
    ) ||
    !Array.isArray(interpretation.relations) ||
    interpretation.relations.length > MAX_INTERPRETATION_ITEMS
  ) invalid(projectId);
  const relations = interpretation.relations.map((item) =>
    parseDocumentRelation(item, projectId));
  if (
    new Set(relations.map((item) => `${item.kind}:${item.sourceId}`)).size !== relations.length ||
    relations.some((item, index) => {
      const previous = relations[index - 1];
      return previous !== undefined &&
        `${previous.kind}:${previous.sourceId}` >= `${item.kind}:${item.sourceId}`;
    })
  ) invalid(projectId);
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: DOCUMENT_INTERPRETATION_SCHEMA_VERSION,
    projectId: expectedProject(interpretation.projectId, projectId),
    sourceId: text(interpretation.sourceId, projectId, {
      max: 71,
      pattern: GENERATED_SOURCE_ID_PATTERN,
    }),
    sourceRevision: digest(interpretation.sourceRevision, projectId),
    role: text(interpretation.role, projectId, {
      max: 64,
      pattern: PORTABLE_IDENTIFIER_PATTERN,
    }),
    lifecycle: interpretation.lifecycle as DocumentLifecycle,
    authority: interpretation.authority as DocumentAuthority,
    synthesisEligibility: interpretation.synthesisEligibility as SynthesisEligibility,
    basis: uniqueTextArray(interpretation.basis, projectId, {
      maxItems: MAX_INTERPRETATION_ITEMS,
      maxText: 64,
      pattern: PORTABLE_IDENTIFIER_PATTERN,
      requireNonEmpty: true,
      sorted: true,
    }),
    confidenceBasisPoints: safeInteger(
      interpretation.confidenceBasisPoints,
      projectId,
      0,
      10_000,
    ),
    reasonCodes: uniqueTextArray(interpretation.reasonCodes, projectId, {
      maxItems: MAX_INTERPRETATION_ITEMS,
      maxText: 64,
      pattern: PORTABLE_IDENTIFIER_PATTERN,
      sorted: true,
    }),
    relations: Object.freeze(relations),
  });
  const interpretationDigest = digest(interpretation.interpretationDigest, projectId);
  if (
    interpretationDigest !==
      digestHierarchyValue(interpretationWithoutDigest(parsedWithoutDigest))
  ) invalid(projectId);
  return Object.freeze({ ...parsedWithoutDigest, interpretationDigest });
}

function parseSnapshotSource(
  value: unknown,
  projectId: string,
  allowMeaning: boolean,
): CorpusSnapshotSourceV1 {
  const source = record(value, projectId);
  const baseKeys = [
    'sanitizedContentDigest',
    'sourceId',
    'sourceRef',
    'sourceRevision',
  ];
  const hasMeaning = Object.hasOwn(source, 'retrievalMeaning') ||
    Object.hasOwn(source, 'retrievalMeaningOrigin');
  if (hasMeaning && !allowMeaning) invalid(projectId);
  if (!hasMeaning && allowMeaning) invalid(projectId);
  exactKeys(source, hasMeaning
    ? [...baseKeys, 'retrievalMeaning', 'retrievalMeaningOrigin']
    : baseKeys, projectId);
  let sourceRef: string;
  try {
    sourceRef = validatePortableSourceRef(source.sourceRef);
  } catch {
    return invalid(projectId);
  }
  let retrievalMeaning: Readonly<{
    readonly meaning: ReturnType<typeof parseSourceRetrievalMeaning>;
    readonly origin: SourceRetrievalMeaningOrigin;
  }> | undefined;
  if (hasMeaning) {
    const origin = source.retrievalMeaningOrigin;
    if (origin !== 'adapter' && origin !== 'legacy-default' &&
        origin !== 'manifest' && origin !== 'profile') invalid(projectId);
    retrievalMeaning = Object.freeze({
      meaning: parseSourceRetrievalMeaning(source.retrievalMeaning),
      origin,
    });
  }
  return Object.freeze({
    ...(retrievalMeaning === undefined ? {} : {
      retrievalMeaning: retrievalMeaning.meaning,
      retrievalMeaningOrigin: retrievalMeaning.origin,
    }),
    sourceId: text(source.sourceId, projectId, {
      max: 71,
      pattern: GENERATED_SOURCE_ID_PATTERN,
    }),
    sourceRevision: digest(source.sourceRevision, projectId),
    sourceRef,
    sanitizedContentDigest: digest(source.sanitizedContentDigest, projectId),
  });
}

function snapshotWithoutDigest(
  snapshot: Omit<CorpusSnapshotV1, 'snapshotDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: snapshot.schemaVersion,
    projectId: snapshot.projectId,
    purposeDigest: snapshot.purposeDigest,
    interpretationRulesDigest: snapshot.interpretationRulesDigest,
    profileDigest: snapshot.profileDigest,
    compilerContractDigest: snapshot.compilerContractDigest,
    sanitizerPolicyDigest: snapshot.sanitizerPolicyDigest,
    sourceManifestDigest: snapshot.sourceManifestDigest,
    policyDigest: snapshot.policyDigest,
    sources: snapshot.sources,
    textUnits: snapshot.textUnits,
    corpusDigest: snapshot.corpusDigest,
  };
}

type CorpusSnapshotInput = Omit<
  CorpusSnapshotV1,
  'corpusDigest' | 'schemaVersion' | 'snapshotDigest'
>;

export function createCorpusSnapshot(input: CorpusSnapshotInput): CorpusSnapshotV1 {
  const projectId = project(input.projectId, 'unknown');
  if (
    !Array.isArray(input.sources) ||
    input.sources.length < 1 ||
    input.sources.length > HIERARCHICAL_COMPILATION_LIMITS.maxSources ||
    !Array.isArray(input.textUnits) ||
    input.textUnits.length < 1 ||
    input.textUnits.length > HIERARCHICAL_COMPILATION_LIMITS.maxTasks
  ) invalid(projectId);
  const sourceInputs: readonly CorpusSnapshotSourceV1[] = input.sources;
  const sources = Object.freeze(sourceInputs
    .map((source) => parseSnapshotSource(
      source.retrievalMeaning === undefined
        ? {
            ...source,
            retrievalMeaning: neutralSourceRetrievalMeaning(),
            retrievalMeaningOrigin: 'legacy-default',
          }
        : source,
      projectId,
      true,
    ))
    .sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0));
  const textUnits = Object.freeze(input.textUnits
    .map((unit) => parseTextUnit(unit, projectId))
    .sort((left, right) => {
      if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
      return left.ordinal - right.ordinal;
    }));
  const corpusDigest = digestHierarchyValue({
    sources,
    textUnits,
  });
  const candidate = {
    schemaVersion: CORPUS_SNAPSHOT_SCHEMA_VERSION,
    projectId,
    purposeDigest: input.purposeDigest,
    interpretationRulesDigest: input.interpretationRulesDigest,
    profileDigest: input.profileDigest,
    compilerContractDigest: input.compilerContractDigest,
    sanitizerPolicyDigest: input.sanitizerPolicyDigest,
    sourceManifestDigest: input.sourceManifestDigest,
    policyDigest: input.policyDigest,
    sources,
    textUnits,
    corpusDigest,
  } as const;
  return parseCorpusSnapshot({
    ...candidate,
    snapshotDigest: digestHierarchyValue(snapshotWithoutDigest(candidate)),
  }, projectId);
}

export function parseCorpusSnapshot(
  value: unknown,
  expectedProjectId: string,
): CorpusSnapshotV1 {
  const projectId = project(expectedProjectId, 'unknown');
  const snapshot = record(value, projectId);
  exactKeys(snapshot, [
    'compilerContractDigest',
    'corpusDigest',
    'interpretationRulesDigest',
    'policyDigest',
    'profileDigest',
    'projectId',
    'purposeDigest',
    'sanitizerPolicyDigest',
    'schemaVersion',
    'snapshotDigest',
    'sourceManifestDigest',
    'sources',
    'textUnits',
  ], projectId);
  const schemaVersion = snapshot.schemaVersion;
  if (
    schemaVersion !== CORPUS_SNAPSHOT_SCHEMA_VERSION &&
      schemaVersion !== LEGACY_CORPUS_SNAPSHOT_SCHEMA_VERSION ||
    !Array.isArray(snapshot.sources) ||
    snapshot.sources.length < 1 ||
    snapshot.sources.length > HIERARCHICAL_COMPILATION_LIMITS.maxSources ||
    !Array.isArray(snapshot.textUnits) ||
    snapshot.textUnits.length < 1 ||
    snapshot.textUnits.length > HIERARCHICAL_COMPILATION_LIMITS.maxTasks
  ) invalid(projectId);
  const sources = snapshot.sources.map((item) => parseSnapshotSource(
    item,
    projectId,
    schemaVersion === CORPUS_SNAPSHOT_SCHEMA_VERSION,
  ));
  if (
    new Set(sources.map((source) => source.sourceId)).size !== sources.length ||
    sources.some((source, index) =>
      index > 0 && (sources[index - 1]?.sourceId ?? '') >= source.sourceId)
  ) invalid(projectId);
  try {
    validateSourceRetrievalSupersessionGraph(sources.map((source) => Object.freeze({
      ...(source.retrievalMeaning === undefined
        ? {}
        : { retrievalMeaning: source.retrievalMeaning }),
      sourceRef: source.sourceRef,
    })));
  } catch {
    invalid(projectId);
  }
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const textUnits = snapshot.textUnits.map((item) => parseTextUnit(item, projectId));
  const ordinalBySource = new Map<string, number>();
  for (let index = 0; index < textUnits.length; index += 1) {
    const unit = textUnits[index];
    if (unit === undefined) invalid(projectId);
    const source = sourceById.get(unit.sourceId);
    const expectedOrdinal = ordinalBySource.get(unit.sourceId) ?? 0;
    if (
      source === undefined ||
      unit.sourceRevision !== source.sourceRevision ||
      unit.sourceRef !== source.sourceRef ||
      unit.ordinal !== expectedOrdinal
    ) invalid(projectId);
    ordinalBySource.set(unit.sourceId, expectedOrdinal + 1);
    const previous = textUnits[index - 1];
    if (
      previous !== undefined &&
      (previous.sourceId > unit.sourceId ||
        (previous.sourceId === unit.sourceId && previous.ordinal >= unit.ordinal))
    ) invalid(projectId);
  }
  if (sources.some((source) => (ordinalBySource.get(source.sourceId) ?? 0) === 0)) {
    invalid(projectId);
  }
  const parsedCorpusDigest = digest(snapshot.corpusDigest, projectId);
  const expectedCorpusDigest = digestHierarchyValue({ sources, textUnits });
  if (parsedCorpusDigest !== expectedCorpusDigest) invalid(projectId);
  const parsedWithoutSnapshotDigest = Object.freeze({
    schemaVersion,
    projectId: expectedProject(snapshot.projectId, projectId),
    purposeDigest: digest(snapshot.purposeDigest, projectId),
    interpretationRulesDigest: digest(snapshot.interpretationRulesDigest, projectId),
    profileDigest: digest(snapshot.profileDigest, projectId),
    compilerContractDigest: digest(snapshot.compilerContractDigest, projectId),
    sanitizerPolicyDigest: digest(snapshot.sanitizerPolicyDigest, projectId),
    sourceManifestDigest: digest(snapshot.sourceManifestDigest, projectId),
    policyDigest: digest(snapshot.policyDigest, projectId),
    sources: Object.freeze(sources),
    textUnits: Object.freeze(textUnits),
    corpusDigest: parsedCorpusDigest,
  });
  if (parsedWithoutSnapshotDigest.policyDigest !== HIERARCHICAL_COMPILATION_POLICY.policyDigest) {
    invalid(projectId);
  }
  const snapshotDigest = digest(snapshot.snapshotDigest, projectId);
  if (snapshotDigest !== digestHierarchyValue(snapshotWithoutDigest(parsedWithoutSnapshotDigest))) {
    invalid(projectId);
  }
  if (
    Buffer.byteLength(serializeCanonicalJson({
      ...parsedWithoutSnapshotDigest,
      snapshotDigest,
    }), 'utf8') > HIERARCHICAL_COMPILATION_LIMITS.maxPlanBytes
  ) invalid(projectId);
  return Object.freeze({ ...parsedWithoutSnapshotDigest, snapshotDigest });
}
