import { validatePortableSourceRef } from '../../projector/source-contracts.js';
import {
  createDocumentInterpretation,
  digestHierarchyValue,
} from './contracts.js';
import { HierarchyContractError } from './errors.js';
import {
  DOCUMENT_INTERPRETATION_RULE_SCHEMA_VERSION,
  type DocumentAuthority,
  type DocumentInterpretationRuleV1,
  type DocumentInterpretationV1,
  type DocumentLifecycle,
  type DocumentMeaningFieldsV1,
  type DocumentRelationV1,
  type InterpretDocumentInputV1,
  type SynthesisEligibility,
} from './types.js';

const PORTABLE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const SOURCE_ID_PATTERN = /^source-[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LIFECYCLES = new Set<DocumentLifecycle>([
  'current', 'deprecated', 'draft', 'superseded', 'unknown',
]);
const AUTHORITIES = new Set<DocumentAuthority>([
  'canonical', 'historical', 'supporting', 'unknown',
]);
const ELIGIBILITIES = new Set<SynthesisEligibility>(['eligible', 'excluded', 'review']);

type UnknownRecord = Readonly<Record<string, unknown>>;

function invalid(projectId = 'unknown'): never {
  throw new HierarchyContractError(projectId);
}

function record(value: unknown, projectId: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(projectId);
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  projectId: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) invalid(projectId);
}

function portableIdentifier(value: unknown, projectId: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !PORTABLE_IDENTIFIER_PATTERN.test(value)
  ) invalid(projectId);
  return value;
}

function sourceRefMatcher(value: unknown, projectId: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    value !== value.normalize('NFC') ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\r') ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) invalid(projectId);
  return value;
}

function parseRelations(
  value: unknown,
  projectId: string,
): readonly DocumentRelationV1[] {
  if (!Array.isArray(value) || value.length > 64) invalid(projectId);
  const relations = value.map((item) => {
    const relation = record(item, projectId);
    exactKeys(relation, ['kind', 'sourceId'], projectId);
    if (
      relation.kind !== 'related' &&
      relation.kind !== 'superseded-by' &&
      relation.kind !== 'supersedes'
    ) invalid(projectId);
    if (typeof relation.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(relation.sourceId)) {
      invalid(projectId);
    }
    return Object.freeze({
      kind: relation.kind,
      sourceId: relation.sourceId,
    });
  }).sort((left, right) => {
    const leftKey = `${left.kind}:${left.sourceId}`;
    const rightKey = `${right.kind}:${right.sourceId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (new Set(relations.map((item) => `${item.kind}:${item.sourceId}`)).size !==
      relations.length) invalid(projectId);
  return Object.freeze(relations);
}

function parseMeaning(value: unknown, projectId: string): DocumentMeaningFieldsV1 {
  const meaning = record(value, projectId);
  const allowed = [
    'authority', 'lifecycle', 'relations', 'role', 'synthesisEligibility',
  ];
  if (Object.keys(meaning).some((key) => !allowed.includes(key))) invalid(projectId);
  const role = meaning.role === undefined
    ? undefined
    : portableIdentifier(meaning.role, projectId);
  const lifecycle = meaning.lifecycle;
  if (lifecycle !== undefined &&
      (typeof lifecycle !== 'string' || !LIFECYCLES.has(lifecycle as DocumentLifecycle))) {
    invalid(projectId);
  }
  const authority = meaning.authority;
  if (authority !== undefined &&
      (typeof authority !== 'string' || !AUTHORITIES.has(authority as DocumentAuthority))) {
    invalid(projectId);
  }
  const synthesisEligibility = meaning.synthesisEligibility;
  if (synthesisEligibility !== undefined &&
      (typeof synthesisEligibility !== 'string' ||
        !ELIGIBILITIES.has(synthesisEligibility as SynthesisEligibility))) invalid(projectId);
  const relations = meaning.relations === undefined
    ? undefined
    : parseRelations(meaning.relations, projectId);
  const parsed: DocumentMeaningFieldsV1 = Object.freeze({
    ...(role === undefined ? {} : { role }),
    ...(lifecycle === undefined ? {} : { lifecycle: lifecycle as DocumentLifecycle }),
    ...(authority === undefined ? {} : { authority: authority as DocumentAuthority }),
    ...(synthesisEligibility === undefined
      ? {}
      : { synthesisEligibility: synthesisEligibility as SynthesisEligibility }),
    ...(relations === undefined ? {} : { relations }),
  });
  return parsed;
}

function ruleWithoutDigest(
  rule: Omit<DocumentInterpretationRuleV1, 'ruleDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: rule.schemaVersion,
    ruleId: rule.ruleId,
    priority: rule.priority,
    sourceRefPrefix: rule.sourceRefPrefix,
    sourceRefSuffix: rule.sourceRefSuffix,
    meaning: rule.meaning,
  };
}

export type DocumentInterpretationRuleInputV1 = Omit<
  DocumentInterpretationRuleV1,
  'ruleDigest' | 'schemaVersion'
>;

export function createDocumentInterpretationRule(
  input: DocumentInterpretationRuleInputV1,
): DocumentInterpretationRuleV1 {
  const candidate = Object.freeze({
    schemaVersion: DOCUMENT_INTERPRETATION_RULE_SCHEMA_VERSION,
    ruleId: portableIdentifier(input.ruleId, 'unknown'),
    priority: input.priority,
    sourceRefPrefix: sourceRefMatcher(input.sourceRefPrefix, 'unknown'),
    sourceRefSuffix: sourceRefMatcher(input.sourceRefSuffix, 'unknown'),
    meaning: parseMeaning(input.meaning, 'unknown'),
  });
  return parseDocumentInterpretationRule(Object.freeze({
    ...candidate,
    ruleDigest: digestHierarchyValue(ruleWithoutDigest(
      candidate as Omit<DocumentInterpretationRuleV1, 'ruleDigest'>,
    )),
  }));
}

export function parseDocumentInterpretationRule(
  value: unknown,
): DocumentInterpretationRuleV1 {
  const rule = record(value, 'unknown');
  exactKeys(rule, [
    'meaning', 'priority', 'ruleDigest', 'ruleId', 'schemaVersion',
    'sourceRefPrefix', 'sourceRefSuffix',
  ], 'unknown');
  const priority = rule.priority;
  if (
    rule.schemaVersion !== DOCUMENT_INTERPRETATION_RULE_SCHEMA_VERSION ||
    typeof priority !== 'number' ||
    !Number.isSafeInteger(priority) ||
    priority < 0 ||
    priority > 10_000
  ) invalid();
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: DOCUMENT_INTERPRETATION_RULE_SCHEMA_VERSION,
    ruleId: portableIdentifier(rule.ruleId, 'unknown'),
    priority,
    sourceRefPrefix: sourceRefMatcher(rule.sourceRefPrefix, 'unknown'),
    sourceRefSuffix: sourceRefMatcher(rule.sourceRefSuffix, 'unknown'),
    meaning: parseMeaning(rule.meaning, 'unknown'),
  });
  if (
    (parsedWithoutDigest.sourceRefPrefix === null &&
      parsedWithoutDigest.sourceRefSuffix === null) ||
    Object.keys(parsedWithoutDigest.meaning).length === 0 ||
    typeof rule.ruleDigest !== 'string' ||
    !DIGEST_PATTERN.test(rule.ruleDigest) ||
    rule.ruleDigest !== digestHierarchyValue(ruleWithoutDigest(parsedWithoutDigest))
  ) invalid();
  return Object.freeze({
    ...parsedWithoutDigest,
    ruleDigest: rule.ruleDigest,
  });
}

function matchesRule(rule: DocumentInterpretationRuleV1, sourceRef: string): boolean {
  return (rule.sourceRefPrefix === null || sourceRef.startsWith(rule.sourceRefPrefix)) &&
    (rule.sourceRefSuffix === null || sourceRef.endsWith(rule.sourceRefSuffix));
}

interface ResolvedField<T> {
  readonly value: T;
  readonly basisRuleIds: readonly string[];
  readonly conflict: boolean;
}

function resolveField<T>(
  explicitValue: T | undefined,
  rules: readonly DocumentInterpretationRuleV1[],
  select: (meaning: DocumentMeaningFieldsV1) => T | undefined,
  fallback: T,
): ResolvedField<T> {
  if (explicitValue !== undefined) {
    return { value: explicitValue, basisRuleIds: [], conflict: false };
  }
  const defining = rules.filter((rule) => select(rule.meaning) !== undefined);
  const highestPriority = defining[0]?.priority;
  if (highestPriority === undefined) {
    return { value: fallback, basisRuleIds: [], conflict: false };
  }
  const highest = defining.filter((rule) => rule.priority === highestPriority);
  const serializedValues = new Set(highest.map((rule) =>
    JSON.stringify(select(rule.meaning))));
  if (serializedValues.size !== 1) {
    return {
      value: fallback,
      basisRuleIds: highest.map((rule) => rule.ruleId),
      conflict: true,
    };
  }
  return {
    value: select(highest[0]?.meaning ?? {}) ?? fallback,
    basisRuleIds: highest.map((rule) => rule.ruleId),
    conflict: false,
  };
}

export function interpretDocumentFromRules(
  input: InterpretDocumentInputV1,
): DocumentInterpretationV1 {
  let sourceRef: string;
  try {
    sourceRef = validatePortableSourceRef(input.sourceRef);
  } catch {
    return invalid(input.projectId);
  }
  const explicit = parseMeaning(input.explicitMeaning, input.projectId);
  const rules = input.rules.map(parseDocumentInterpretationRule);
  if (new Set(rules.map((rule) => rule.ruleId)).size !== rules.length) {
    invalid(input.projectId);
  }
  const matching = rules.filter((rule) => matchesRule(rule, sourceRef))
    .sort((left, right) => right.priority - left.priority ||
      (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0));
  const role = resolveField(explicit.role, matching, (meaning) => meaning.role, 'unknown');
  const lifecycle = resolveField(
    explicit.lifecycle,
    matching,
    (meaning) => meaning.lifecycle,
    'unknown' as const,
  );
  const authority = resolveField(
    explicit.authority,
    matching,
    (meaning) => meaning.authority,
    'unknown' as const,
  );
  const eligibility = resolveField(
    explicit.synthesisEligibility,
    matching,
    (meaning) => meaning.synthesisEligibility,
    'review' as const,
  );
  const relations = resolveField(
    explicit.relations,
    matching,
    (meaning) => meaning.relations,
    Object.freeze([]) as readonly DocumentRelationV1[],
  );
  const resolutions = [role, lifecycle, authority, eligibility, relations];
  const resolvedEligibility = explicit.synthesisEligibility === undefined &&
    (resolutions.some((resolution) => resolution.conflict) ||
      role.value === 'unknown' ||
      lifecycle.value === 'unknown' ||
      authority.value === 'unknown')
    ? 'review' as const
    : eligibility.value;
  const explicitProvided = Object.keys(explicit).length > 0;
  const basis = new Set<string>();
  if (explicitProvided) basis.add('explicit-metadata');
  for (const ruleId of resolutions.flatMap((resolution) => resolution.basisRuleIds)) {
    basis.add(`rule.${ruleId}`);
  }
  if (basis.size === 0) basis.add('no-explicit-meaning');
  const reasonCodes = new Set<string>();
  if (role.value === 'unknown') reasonCodes.add('role-unknown');
  if (lifecycle.value === 'unknown') reasonCodes.add('lifecycle-unknown');
  if (authority.value === 'unknown') reasonCodes.add('authority-unknown');
  if (resolvedEligibility === 'review') reasonCodes.add('synthesis-review');
  if (resolutions.some((resolution) => resolution.conflict)) {
    reasonCodes.add('rule-conflict');
  }
  const confidenceBasisPoints = resolutions.some((resolution) => resolution.conflict)
    ? 0
    : explicitProvided
      ? 10_000
      : matching.length > 0
        ? 7500
        : 0;
  return createDocumentInterpretation({
    projectId: input.projectId,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    role: role.value,
    lifecycle: lifecycle.value,
    authority: authority.value,
    synthesisEligibility: resolvedEligibility,
    basis: Object.freeze([...basis].sort()),
    confidenceBasisPoints,
    reasonCodes: Object.freeze([...reasonCodes].sort()),
    relations: relations.value,
  });
}
