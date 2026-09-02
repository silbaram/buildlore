import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import {
  HIERARCHICAL_COMPILATION_LIMITS,
  digestHierarchyValue,
  parseCompilationPurpose,
  parseCorpusSnapshot,
  parseDocumentInterpretation,
} from './contracts.js';
import { HierarchyContractError } from './errors.js';
import { parseSparseRelationGraph } from './planning.js';
import {
  PAGE_BLUEPRINT_SCHEMA_VERSION,
  WIKI_OUTLINE_REVIEW_SCHEMA_VERSION,
  WIKI_OUTLINE_DIFF_SCHEMA_VERSION,
  WIKI_OUTLINE_SCHEMA_VERSION,
  type BlueprintEvidenceScopeV1,
  type CompilationPurposeV1,
  type CorpusSnapshotV1,
  type DocumentInterpretationV1,
  type HierarchySha256Digest,
  type PageBlueprintV1,
  type SparseRelationGraphV1,
  type TextUnitKind,
  type WikiOutlineDiffV1,
  type WikiOutlineReviewDecision,
  type WikiOutlineReviewV1,
  type WikiOutlineV1,
} from './types.js';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PAGE_ID_PATTERN = /^page-[a-f0-9]{64}$/u;
const SOURCE_ID_PATTERN = /^source-[a-f0-9]{64}$/u;
const PORTABLE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const ALL_UNIT_KINDS: readonly TextUnitKind[] = Object.freeze([
  'document', 'fenced-code', 'heading', 'list', 'paragraph', 'table',
]);
const MAX_LEAF_BLUEPRINTS = 72;
const MAX_LEAVES_PER_GROUP = 12;
const MAX_OUTLINE_BLUEPRINTS = 97;

type UnknownRecord = Readonly<Record<string, unknown>>;

function invalid(projectId: string): never {
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

function digest(value: unknown, projectId: string): HierarchySha256Digest {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) invalid(projectId);
  return value as HierarchySha256Digest;
}

function identifier(value: unknown, pattern: RegExp, projectId: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(projectId);
  return value;
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

function safeText(value: unknown, maximum: number, projectId: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.normalize('NFC') ||
    value.includes('\r') ||
    hasUnsafeCharacter(value)
  ) invalid(projectId);
  return value;
}

function uniqueSortedIdentifiers(
  value: unknown,
  pattern: RegExp,
  maximum: number,
  projectId: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(projectId);
  const result = value.map((item) => identifier(item, pattern, projectId));
  if (new Set(result).size !== result.length ||
      result.some((item, index) => index > 0 && (result[index - 1] as string) >= item)) {
    invalid(projectId);
  }
  return Object.freeze(result);
}

function pageId(
  projectId: string,
  purposeDigest: HierarchySha256Digest,
  stableKey: string,
): string {
  return `page-${digestHierarchyValue({ projectId, purposeDigest, stableKey })
    .slice('sha256:'.length)}`;
}

function blueprintWithoutDigest(
  blueprint: Omit<PageBlueprintV1, 'blueprintDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: blueprint.schemaVersion,
    projectId: blueprint.projectId,
    pageId: blueprint.pageId,
    stableKey: blueprint.stableKey,
    role: blueprint.role,
    title: blueprint.title,
    parentPageId: blueprint.parentPageId,
    childPageIds: blueprint.childPageIds,
    relatedPageIds: blueprint.relatedPageIds,
    keyQuestions: blueprint.keyQuestions,
    requiredSections: blueprint.requiredSections,
    evidenceScope: blueprint.evidenceScope,
    minimumDistinctSources: blueprint.minimumDistinctSources,
    generationOrder: blueprint.generationOrder,
  };
}

type BlueprintInputV1 = Omit<
  PageBlueprintV1,
  'blueprintDigest' | 'schemaVersion'
>;

function createBlueprint(input: BlueprintInputV1): PageBlueprintV1 {
  const candidate = Object.freeze({
    schemaVersion: PAGE_BLUEPRINT_SCHEMA_VERSION,
    ...input,
  });
  return Object.freeze({
    ...candidate,
    blueprintDigest: digestHierarchyValue(blueprintWithoutDigest(candidate)),
  });
}

function evidenceScope(
  snapshot: CorpusSnapshotV1,
  graph: SparseRelationGraphV1,
  sourceIdsValue: readonly string[],
): BlueprintEvidenceScopeV1 {
  const sourceIds = Object.freeze([...sourceIdsValue].sort());
  return Object.freeze({
    snapshotDigest: snapshot.snapshotDigest,
    taskSetDigest: graph.taskSetDigest,
    relationSetDigest: graph.relationSetDigest,
    allowedUnitKinds: ALL_UNIT_KINDS,
    sourceIds,
  });
}

interface LeafSeed {
  readonly stableKey: string;
  readonly role: string;
  readonly title: string;
  readonly keyQuestions: readonly string[];
  readonly requiredSections: readonly string[];
  readonly sourceIds: readonly string[];
}

function coalesceTopicSeeds(
  seeds: readonly LeafSeed[],
  maximum: number,
  projectId: string,
): readonly LeafSeed[] {
  if (maximum < 1) invalid(projectId);
  if (seeds.length <= maximum) return Object.freeze([...seeds]);
  return Object.freeze(Array.from({ length: maximum }, (_, index): LeafSeed => {
    const start = Math.floor(index * seeds.length / maximum);
    const end = Math.floor((index + 1) * seeds.length / maximum);
    const members = seeds.slice(start, end);
    const first = members[0];
    if (first === undefined || members.length < 1) invalid(projectId);
    const roles = [...new Set(members.map((seed) => seed.role))].sort();
    const sourceIds = [...new Set(members.flatMap((seed) => [...seed.sourceIds]))].sort();
    const memberKeys = members.map((seed) => seed.stableKey);
    return Object.freeze({
      stableKey: `topic.cluster.${digestHierarchyValue(memberKeys).slice('sha256:'.length)}`,
      role: roles.length === 1 ? roles[0] as string : 'topic',
      title: members.length === 1
        ? first.title
        : `${first.title} and ${String(members.length - 1)} related topics`,
      keyQuestions: first.keyQuestions,
      requiredSections: first.requiredSections,
      sourceIds: Object.freeze(sourceIds),
    });
  }));
}

function parseInterpretationSet(
  values: readonly DocumentInterpretationV1[],
  snapshot: CorpusSnapshotV1,
  projectId: string,
): readonly DocumentInterpretationV1[] {
  if (!Array.isArray(values) || values.length !== snapshot.sources.length) invalid(projectId);
  const parsed = values.map((value) => parseDocumentInterpretation(value, projectId))
    .sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0);
  const sourceById = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
  if (new Set(parsed.map((item) => item.sourceId)).size !== parsed.length ||
      parsed.some((item) => {
        const source = sourceById.get(item.sourceId);
        return source === undefined || source.sourceRevision !== item.sourceRevision ||
          item.relations.some((relation) =>
            relation.sourceId === item.sourceId || !sourceById.has(relation.sourceId));
      })) invalid(projectId);
  return Object.freeze(parsed);
}

function interpretationSetDigest(
  interpretations: readonly DocumentInterpretationV1[],
): HierarchySha256Digest {
  return digestHierarchyValue(interpretations.map((item) => item.interpretationDigest));
}

function leafSeeds(
  purpose: CompilationPurposeV1,
  snapshot: CorpusSnapshotV1,
  interpretations: readonly DocumentInterpretationV1[],
  projectId: string,
): readonly LeafSeed[] {
  const interpretationBySource = new Map(interpretations.map((item) => [item.sourceId, item]));
  const synthesisSourceIds = interpretations
    .filter((item) => item.synthesisEligibility !== 'excluded')
    .map((item) => item.sourceId).sort();
  if (synthesisSourceIds.length === 0) invalid(projectId);
  const labelsByKey = new Map<string, { labels: string[]; sourceIds: Set<string> }>();
  for (const unit of snapshot.textUnits) {
    if ((unit.kind !== 'heading' && unit.kind !== 'document') || unit.topicLabel === null ||
        interpretationBySource.get(unit.sourceId)?.synthesisEligibility === 'excluded') continue;
    const key = unit.topicLabel.toLowerCase();
    const entry = labelsByKey.get(key) ?? { labels: [], sourceIds: new Set<string>() };
    entry.labels.push(unit.topicLabel);
    entry.sourceIds.add(unit.sourceId);
    labelsByKey.set(key, entry);
  }
  const topicSeeds = [...labelsByKey.entries()].map(([topicKey, entry]): LeafSeed => {
    const sourceIds = [...entry.sourceIds].sort();
    const roles = [...new Set(sourceIds.map((sourceId) => interpretationBySource.get(sourceId)?.role)
      .filter((role): role is string => role !== undefined && role !== 'unknown'))].sort();
    return Object.freeze({
      stableKey: `topic.${digestHierarchyValue({ topicKey }).slice('sha256:'.length)}`,
      role: roles.length === 1 ? roles[0] as string : 'topic',
      title: [...entry.labels].sort()[0] as string,
      keyQuestions: Object.freeze([...purpose.keyQuestions]),
      requiredSections: Object.freeze(['evidence', 'related-topics', 'summary']),
      sourceIds: Object.freeze(sourceIds),
    });
  }).sort((left, right) => left.stableKey < right.stableKey ? -1 : 1);
  const representedRoles = new Set(topicSeeds.map((seed) => seed.role));
  const roleSeeds = purpose.requestedPageRoles.filter((role) =>
    role !== 'overview' && !representedRoles.has(role)).flatMap((role): readonly LeafSeed[] => {
    const matchingSourceIds = interpretations.filter((item) =>
      item.role === role && item.synthesisEligibility !== 'excluded').map((item) => item.sourceId).sort();
    if (matchingSourceIds.length === 0 && topicSeeds.length > 0) return [];
    return [Object.freeze({
      stableKey: `role.${role}`,
      role,
      title: role,
      keyQuestions: Object.freeze([...purpose.keyQuestions]),
      requiredSections: Object.freeze(['evidence', 'key-questions', 'summary']),
      sourceIds: Object.freeze(matchingSourceIds.length > 0 ? matchingSourceIds : synthesisSourceIds),
    })];
  });
  const coveredSourceIds = new Set([...topicSeeds, ...roleSeeds]
    .flatMap((seed) => [...seed.sourceIds]));
  const uncoveredSourceIds = synthesisSourceIds.filter((sourceId) => !coveredSourceIds.has(sourceId));
  const additionalSeeds: readonly LeafSeed[] = uncoveredSourceIds.length > 0 &&
      topicSeeds.length + roleSeeds.length > 0
    ? [Object.freeze({
        stableKey: 'topic.additional-evidence',
        role: 'reference',
        title: (purpose.scopeHints[0] ?? purpose.goals[0]) as string,
        keyQuestions: Object.freeze([...purpose.keyQuestions]),
        requiredSections: Object.freeze(['evidence', 'related-topics', 'summary']),
        sourceIds: Object.freeze(uncoveredSourceIds),
      })]
    : [];
  const fallbackSeeds = topicSeeds.length === 0 && roleSeeds.length === 0
    ? purpose.keyQuestions.map((question, index): LeafSeed => Object.freeze({
        stableKey: `topic.q-${String(index).padStart(3, '0')}`,
        role: 'topic',
        title: question,
        keyQuestions: Object.freeze([question]),
        requiredSections: Object.freeze(['evidence', 'related-topics', 'summary']),
        sourceIds: Object.freeze(synthesisSourceIds),
      }))
    : [];
  const reservedSeedCount = roleSeeds.length + additionalSeeds.length + fallbackSeeds.length;
  const boundedTopicSeeds = coalesceTopicSeeds(
    topicSeeds,
    MAX_LEAF_BLUEPRINTS - reservedSeedCount,
    projectId,
  );
  const seeds = [...boundedTopicSeeds, ...roleSeeds, ...additionalSeeds, ...fallbackSeeds];
  if (seeds.length === 0 || seeds.length > MAX_LEAF_BLUEPRINTS) invalid(projectId);
  return Object.freeze(seeds);
}

function relatedLeafIds(
  seeds: readonly LeafSeed[],
  leafPageIds: readonly string[],
  graph: SparseRelationGraphV1,
  interpretations: readonly DocumentInterpretationV1[],
): ReadonlyMap<string, readonly string[]> {
  const relatedSources = new Set<string>();
  const taskById = new Map(graph.tasks.map((task) => [task.taskId, task]));
  for (const relation of graph.relations) {
    const left = taskById.get(relation.leftTaskId)?.sourceId;
    const right = taskById.get(relation.rightTaskId)?.sourceId;
    if (left !== undefined && right !== undefined && left !== right) {
      relatedSources.add(`${left}\u0000${right}`);
      relatedSources.add(`${right}\u0000${left}`);
    }
  }
  for (const interpretation of interpretations) {
    for (const relation of interpretation.relations) {
      relatedSources.add(`${interpretation.sourceId}\u0000${relation.sourceId}`);
      relatedSources.add(`${relation.sourceId}\u0000${interpretation.sourceId}`);
    }
  }
  const result = new Map<string, readonly string[]>();
  for (let leftIndex = 0; leftIndex < seeds.length; leftIndex += 1) {
    const left = seeds[leftIndex];
    const leftPageId = leafPageIds[leftIndex];
    if (left === undefined || leftPageId === undefined) continue;
    const related: string[] = [];
    for (let rightIndex = 0; rightIndex < seeds.length; rightIndex += 1) {
      if (leftIndex === rightIndex) continue;
      const right = seeds[rightIndex];
      const rightPageId = leafPageIds[rightIndex];
      if (right === undefined || rightPageId === undefined) continue;
      const sharesSource = left.sourceIds.some((sourceId) => right.sourceIds.includes(sourceId));
      const hasSourceRelation = left.sourceIds.some((leftSourceId) => right.sourceIds.some(
        (rightSourceId) => relatedSources.has(`${leftSourceId}\u0000${rightSourceId}`),
      ));
      if (sharesSource || hasSourceRelation) related.push(rightPageId);
    }
    result.set(leftPageId, Object.freeze(related.sort()));
  }
  return result;
}

function outlineWithoutDigest(
  outline: Omit<WikiOutlineV1, 'outlineDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: outline.schemaVersion,
    projectId: outline.projectId,
    snapshotDigest: outline.snapshotDigest,
    graphDigest: outline.graphDigest,
    interpretationSetDigest: outline.interpretationSetDigest,
    purposeDigest: outline.purposeDigest,
    policyDigest: outline.policyDigest,
    activationState: outline.activationState,
    rootPageId: outline.rootPageId,
    blueprints: outline.blueprints,
  };
}

export function createWikiOutline(
  purposeValue: CompilationPurposeV1,
  snapshotValue: CorpusSnapshotV1,
  graphValue: SparseRelationGraphV1,
  interpretationValues: readonly DocumentInterpretationV1[],
  expectedProjectId: string,
): WikiOutlineV1 {
  const purpose = parseCompilationPurpose(purposeValue, expectedProjectId);
  const snapshot = parseCorpusSnapshot(snapshotValue, expectedProjectId);
  const graph = parseSparseRelationGraph(graphValue, expectedProjectId);
  const interpretations = parseInterpretationSet(
    interpretationValues,
    snapshot,
    expectedProjectId,
  );
  if (
    snapshot.purposeDigest !== purpose.purposeDigest ||
    graph.snapshotDigest !== snapshot.snapshotDigest ||
    graph.policyDigest !== snapshot.policyDigest
  ) invalid(expectedProjectId);
  const rootStableKey = 'root.overview';
  const rootPageId = pageId(expectedProjectId, purpose.purposeDigest, rootStableKey);
  const seeds = leafSeeds(purpose, snapshot, interpretations, expectedProjectId);
  const leafPageIds = seeds.map((seed) =>
    pageId(expectedProjectId, purpose.purposeDigest, seed.stableKey));
  const synthesisSourceIds = interpretations.filter((item) =>
    item.synthesisEligibility !== 'excluded').map((item) => item.sourceId).sort();
  const rootScope = evidenceScope(snapshot, graph, synthesisSourceIds);
  const relatedByPageId = relatedLeafIds(seeds, leafPageIds, graph, interpretations);
  const grouped = seeds.length > MAX_LEAVES_PER_GROUP;
  const groupSeeds = grouped
    ? Array.from({ length: Math.ceil(seeds.length / MAX_LEAVES_PER_GROUP) }, (_, index) => {
        const start = index * MAX_LEAVES_PER_GROUP;
        const members = seeds.slice(start, start + MAX_LEAVES_PER_GROUP);
        const childPageIds = leafPageIds.slice(start, start + MAX_LEAVES_PER_GROUP);
        const first = members[0];
        if (first === undefined || members.length < 1 || childPageIds.length !== members.length) {
          invalid(expectedProjectId);
        }
        const sourceIds = [...new Set(members.flatMap((seed) => [...seed.sourceIds]))].sort();
        const stableKey = `group.${digestHierarchyValue(members.map((seed) => seed.stableKey))
          .slice('sha256:'.length)}`;
        return Object.freeze({
          stableKey,
          pageId: pageId(expectedProjectId, purpose.purposeDigest, stableKey),
          title: `${first.title} topic group`,
          sourceIds: Object.freeze(sourceIds),
          childPageIds: Object.freeze([...childPageIds].sort()),
        });
      })
    : [];
  const groupPageIds = groupSeeds.map((group) => group.pageId);
  const leaves = seeds.map((seed, index) => {
    const currentPageId = leafPageIds[index];
    if (currentPageId === undefined) invalid(expectedProjectId);
    const group = grouped ? groupSeeds[Math.floor(index / MAX_LEAVES_PER_GROUP)] : undefined;
    if (grouped && group === undefined) invalid(expectedProjectId);
    const scope = evidenceScope(snapshot, graph, seed.sourceIds);
    return createBlueprint({
      projectId: expectedProjectId,
      pageId: currentPageId,
      stableKey: seed.stableKey,
      role: seed.role,
      title: seed.title,
      parentPageId: group?.pageId ?? rootPageId,
      childPageIds: Object.freeze([]),
      relatedPageIds: relatedByPageId.get(currentPageId) ?? Object.freeze([]),
      keyQuestions: seed.keyQuestions,
      requiredSections: seed.requiredSections,
      evidenceScope: scope,
      minimumDistinctSources: Math.min(2, scope.sourceIds.length),
      generationOrder: index,
    });
  });
  const groups = groupSeeds.map((group, index) => {
    const scope = evidenceScope(snapshot, graph, group.sourceIds);
    return createBlueprint({
      projectId: expectedProjectId,
      pageId: group.pageId,
      stableKey: group.stableKey,
      role: 'topic-group',
      title: group.title,
      parentPageId: rootPageId,
      childPageIds: group.childPageIds,
      relatedPageIds: Object.freeze([]),
      keyQuestions: purpose.keyQuestions,
      requiredSections: Object.freeze(['summary', 'topic-map']),
      evidenceScope: scope,
      minimumDistinctSources: Math.min(2, scope.sourceIds.length),
      generationOrder: leaves.length + index,
    });
  });
  const root = createBlueprint({
    projectId: expectedProjectId,
    pageId: rootPageId,
    stableKey: rootStableKey,
    role: 'overview',
    title: purpose.goals[0] as string,
    parentPageId: null,
    childPageIds: Object.freeze([...(grouped ? groupPageIds : leafPageIds)].sort()),
    relatedPageIds: Object.freeze([]),
    keyQuestions: purpose.keyQuestions,
    requiredSections: Object.freeze(['goals', 'summary', 'topic-map']),
    evidenceScope: rootScope,
    minimumDistinctSources: Math.min(2, rootScope.sourceIds.length),
    generationOrder: leaves.length + groups.length,
  });
  const candidate = Object.freeze({
    schemaVersion: WIKI_OUTLINE_SCHEMA_VERSION,
    projectId: expectedProjectId,
    snapshotDigest: snapshot.snapshotDigest,
    graphDigest: graph.graphDigest,
    interpretationSetDigest: interpretationSetDigest(interpretations),
    purposeDigest: purpose.purposeDigest,
    policyDigest: snapshot.policyDigest,
    activationState: 'candidate' as const,
    rootPageId,
    blueprints: Object.freeze([...leaves, ...groups, root]),
  });
  const outline = Object.freeze({
    ...candidate,
    outlineDigest: digestHierarchyValue(outlineWithoutDigest(candidate)),
  });
  if (Buffer.byteLength(serializeCanonicalJson(outline), 'utf8') >
      HIERARCHICAL_COMPILATION_LIMITS.maxPlanBytes) invalid(expectedProjectId);
  return parseWikiOutline(
    outline,
    purpose,
    snapshot,
    graph,
    interpretations,
    expectedProjectId,
  );
}

function parseEvidenceScope(
  value: unknown,
  snapshot: CorpusSnapshotV1,
  graph: SparseRelationGraphV1,
  allowedSourceIds: ReadonlySet<string>,
  projectId: string,
): BlueprintEvidenceScopeV1 {
  const scope = record(value, projectId);
  exactKeys(scope, [
    'allowedUnitKinds', 'relationSetDigest', 'snapshotDigest', 'sourceIds',
    'taskSetDigest',
  ], projectId);
  if (!Array.isArray(scope.allowedUnitKinds)) invalid(projectId);
  const allowedUnitKinds = scope.allowedUnitKinds.map((item) => {
    if (typeof item !== 'string' || !ALL_UNIT_KINDS.includes(item as TextUnitKind)) {
      return invalid(projectId);
    }
    return item as TextUnitKind;
  });
  const sourceIds = uniqueSortedIdentifiers(
    scope.sourceIds,
    SOURCE_ID_PATTERN,
    HIERARCHICAL_COMPILATION_LIMITS.maxSources,
    projectId,
  );
  if (
    !sameStrings(allowedUnitKinds, ALL_UNIT_KINDS) ||
    sourceIds.length === 0 ||
    sourceIds.some((sourceId) => !allowedSourceIds.has(sourceId)) ||
    scope.snapshotDigest !== snapshot.snapshotDigest ||
    scope.taskSetDigest !== graph.taskSetDigest ||
    scope.relationSetDigest !== graph.relationSetDigest
  ) invalid(projectId);
  return Object.freeze({
    snapshotDigest: digest(scope.snapshotDigest, projectId),
    taskSetDigest: digest(scope.taskSetDigest, projectId),
    relationSetDigest: digest(scope.relationSetDigest, projectId),
    allowedUnitKinds: Object.freeze(allowedUnitKinds),
    sourceIds,
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function parseBlueprint(
  value: unknown,
  purpose: CompilationPurposeV1,
  snapshot: CorpusSnapshotV1,
  graph: SparseRelationGraphV1,
  allowedSourceIds: ReadonlySet<string>,
  projectId: string,
): PageBlueprintV1 {
  const blueprint = record(value, projectId);
  exactKeys(blueprint, [
    'blueprintDigest', 'childPageIds', 'evidenceScope', 'generationOrder',
    'keyQuestions', 'minimumDistinctSources', 'pageId', 'parentPageId', 'projectId',
    'relatedPageIds', 'requiredSections', 'role', 'schemaVersion', 'stableKey', 'title',
  ], projectId);
  const stableKey = identifier(blueprint.stableKey, PORTABLE_IDENTIFIER_PATTERN, projectId);
  const role = identifier(blueprint.role, PORTABLE_IDENTIFIER_PATTERN, projectId);
  const pageIdentifier = identifier(blueprint.pageId, PAGE_ID_PATTERN, projectId);
  if (!Array.isArray(blueprint.keyQuestions) || blueprint.keyQuestions.length > 64) {
    invalid(projectId);
  }
  const keyQuestions = Object.freeze(blueprint.keyQuestions.map((item) =>
    safeText(item, 1_000, projectId)));
  if (new Set(keyQuestions).size !== keyQuestions.length) invalid(projectId);
  const requiredSections = uniqueSortedIdentifiers(
    blueprint.requiredSections,
    PORTABLE_IDENTIFIER_PATTERN,
    32,
    projectId,
  );
  const childPageIds = uniqueSortedIdentifiers(
    blueprint.childPageIds,
    PAGE_ID_PATTERN,
    96,
    projectId,
  );
  const relatedPageIds = uniqueSortedIdentifiers(
    blueprint.relatedPageIds,
    PAGE_ID_PATTERN,
    96,
    projectId,
  );
  const parentPageId = blueprint.parentPageId === null
    ? null
    : identifier(blueprint.parentPageId, PAGE_ID_PATTERN, projectId);
  const minimumDistinctSources = blueprint.minimumDistinctSources;
  const generationOrder = blueprint.generationOrder;
  const parsedEvidenceScope = parseEvidenceScope(
    blueprint.evidenceScope,
    snapshot,
    graph,
    allowedSourceIds,
    projectId,
  );
  if (
    blueprint.schemaVersion !== PAGE_BLUEPRINT_SCHEMA_VERSION ||
    blueprint.projectId !== projectId ||
    pageIdentifier !== pageId(projectId, purpose.purposeDigest, stableKey) ||
    typeof minimumDistinctSources !== 'number' ||
    !Number.isSafeInteger(minimumDistinctSources) ||
    minimumDistinctSources < 1 ||
    minimumDistinctSources > parsedEvidenceScope.sourceIds.length ||
    typeof generationOrder !== 'number' ||
    !Number.isSafeInteger(generationOrder) ||
    generationOrder < 0 ||
    generationOrder >= MAX_OUTLINE_BLUEPRINTS
  ) invalid(projectId);
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: PAGE_BLUEPRINT_SCHEMA_VERSION,
    projectId,
    pageId: pageIdentifier,
    stableKey,
    role,
    title: safeText(blueprint.title, 1_000, projectId),
    parentPageId,
    childPageIds,
    relatedPageIds,
    keyQuestions,
    requiredSections,
    evidenceScope: parsedEvidenceScope,
    minimumDistinctSources,
    generationOrder,
  });
  const blueprintDigest = digest(blueprint.blueprintDigest, projectId);
  if (blueprintDigest !== digestHierarchyValue(blueprintWithoutDigest(parsedWithoutDigest))) {
    invalid(projectId);
  }
  return Object.freeze({ ...parsedWithoutDigest, blueprintDigest });
}

export function parseWikiOutline(
  value: unknown,
  purposeValue: CompilationPurposeV1,
  snapshotValue: CorpusSnapshotV1,
  graphValue: SparseRelationGraphV1,
  interpretationValues: readonly DocumentInterpretationV1[],
  expectedProjectId: string,
): WikiOutlineV1 {
  const purpose = parseCompilationPurpose(purposeValue, expectedProjectId);
  const snapshot = parseCorpusSnapshot(snapshotValue, expectedProjectId);
  const graph = parseSparseRelationGraph(graphValue, expectedProjectId);
  const interpretations = parseInterpretationSet(
    interpretationValues,
    snapshot,
    expectedProjectId,
  );
  const expectedInterpretationSetDigest = interpretationSetDigest(interpretations);
  const allowedSourceIds = new Set(interpretations.filter((item) =>
    item.synthesisEligibility !== 'excluded').map((item) => item.sourceId));
  const outline = record(value, expectedProjectId);
  exactKeys(outline, [
    'activationState', 'blueprints', 'graphDigest', 'interpretationSetDigest',
    'outlineDigest', 'policyDigest', 'projectId', 'purposeDigest', 'rootPageId',
    'schemaVersion', 'snapshotDigest',
  ], expectedProjectId);
  if (
    outline.schemaVersion !== WIKI_OUTLINE_SCHEMA_VERSION ||
    outline.projectId !== expectedProjectId ||
    outline.snapshotDigest !== snapshot.snapshotDigest ||
    outline.graphDigest !== graph.graphDigest ||
    outline.interpretationSetDigest !== expectedInterpretationSetDigest ||
    outline.purposeDigest !== purpose.purposeDigest ||
    outline.policyDigest !== snapshot.policyDigest ||
    outline.activationState !== 'candidate' ||
    !Array.isArray(outline.blueprints) ||
    outline.blueprints.length < 2 ||
    outline.blueprints.length > MAX_OUTLINE_BLUEPRINTS
  ) invalid(expectedProjectId);
  const blueprints = outline.blueprints.map((item) =>
    parseBlueprint(item, purpose, snapshot, graph, allowedSourceIds, expectedProjectId));
  if (
    new Set(blueprints.map((item) => item.pageId)).size !== blueprints.length ||
    new Set(blueprints.map((item) => item.stableKey)).size !== blueprints.length ||
    blueprints.some((item, index) => item.generationOrder !== index)
  ) invalid(expectedProjectId);
  const rootPageId = identifier(outline.rootPageId, PAGE_ID_PATTERN, expectedProjectId);
  const root = blueprints.find((item) => item.pageId === rootPageId);
  const leaves = blueprints.filter((item) => item.childPageIds.length === 0);
  const pageIds = new Set(blueprints.map((item) => item.pageId));
  const blueprintById = new Map(blueprints.map((item) => [item.pageId, item]));
  const expectedSourceIds = [...allowedSourceIds].sort();
  const coveredLeafSourceIds = [...new Set(leaves.flatMap((item) =>
    [...item.evidenceScope.sourceIds]))].sort();
  if (
    root === undefined ||
    root.role !== 'overview' ||
    root.parentPageId !== null ||
    root.generationOrder !== blueprints.length - 1 ||
    !sameStrings(root.evidenceScope.sourceIds, expectedSourceIds) ||
    !sameStrings(coveredLeafSourceIds, expectedSourceIds) ||
    blueprints.some((item) => item.pageId !== rootPageId && item.parentPageId === null) ||
    blueprints.some((item) => item.parentPageId !== null && !pageIds.has(item.parentPageId)) ||
    blueprints.some((item) => !sameStrings(
      item.childPageIds,
      blueprints.filter((candidate) => candidate.parentPageId === item.pageId)
        .map((candidate) => candidate.pageId).sort(),
    )) ||
    blueprints.some((item) => item.childPageIds.some((childPageId) => {
      const child = blueprintById.get(childPageId);
      return child === undefined || child.generationOrder >= item.generationOrder;
    })) ||
    blueprints.some((item) => item.relatedPageIds.some((related) =>
      related === item.pageId || !pageIds.has(related))) ||
    leaves.some((item) => item.relatedPageIds.some((related) =>
      !blueprints.find((candidate) => candidate.pageId === related)
        ?.relatedPageIds.includes(item.pageId)))
  ) invalid(expectedProjectId);
  const reachable = new Set<string>();
  const pending = [rootPageId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || reachable.has(current)) continue;
    reachable.add(current);
    const blueprint = blueprintById.get(current);
    if (blueprint === undefined) invalid(expectedProjectId);
    pending.push(...blueprint.childPageIds);
  }
  if (reachable.size !== blueprints.length) invalid(expectedProjectId);
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: WIKI_OUTLINE_SCHEMA_VERSION,
    projectId: expectedProjectId,
    snapshotDigest: snapshot.snapshotDigest,
    graphDigest: graph.graphDigest,
    interpretationSetDigest: expectedInterpretationSetDigest,
    purposeDigest: purpose.purposeDigest,
    policyDigest: snapshot.policyDigest,
    activationState: 'candidate' as const,
    rootPageId,
    blueprints: Object.freeze(blueprints),
  });
  const outlineDigest = digest(outline.outlineDigest, expectedProjectId);
  if (outlineDigest !== digestHierarchyValue(outlineWithoutDigest(parsedWithoutDigest))) {
    invalid(expectedProjectId);
  }
  return Object.freeze({ ...parsedWithoutDigest, outlineDigest });
}

export function diffWikiOutlines(
  before: WikiOutlineV1,
  after: WikiOutlineV1,
  expectedProjectId: string,
): WikiOutlineDiffV1 {
  if (before.projectId !== expectedProjectId || after.projectId !== expectedProjectId) {
    invalid(expectedProjectId);
  }
  const beforeById = new Map(before.blueprints.map((item) => [item.pageId, item]));
  const afterById = new Map(after.blueprints.map((item) => [item.pageId, item]));
  const addedPageIds = Object.freeze([...afterById.keys()]
    .filter((item) => !beforeById.has(item)).sort());
  const removedPageIds = Object.freeze([...beforeById.keys()]
    .filter((item) => !afterById.has(item)).sort());
  const changedPageIds = Object.freeze([...beforeById.keys()]
    .filter((item) => {
      const next = afterById.get(item);
      return next !== undefined &&
        next.blueprintDigest !== beforeById.get(item)?.blueprintDigest;
    }).sort());
  const candidate = Object.freeze({
    schemaVersion: WIKI_OUTLINE_DIFF_SCHEMA_VERSION,
    projectId: expectedProjectId,
    beforeOutlineDigest: before.outlineDigest,
    afterOutlineDigest: after.outlineDigest,
    addedPageIds,
    removedPageIds,
    changedPageIds,
    identical: before.outlineDigest === after.outlineDigest,
  });
  return Object.freeze({
    ...candidate,
    diffDigest: digestHierarchyValue(candidate),
  });
}

function reviewWithoutDigest(
  review: Omit<WikiOutlineReviewV1, 'reviewDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: review.schemaVersion,
    projectId: review.projectId,
    outlineDigest: review.outlineDigest,
    snapshotDigest: review.snapshotDigest,
    decision: review.decision,
    reasonCodes: review.reasonCodes,
    activationAuthorized: review.activationAuthorized,
  };
}

export function reviewWikiOutline(
  outline: WikiOutlineV1,
  decision: WikiOutlineReviewDecision,
  reasonCodesValue: readonly string[],
  expectedProjectId: string,
): WikiOutlineReviewV1 {
  if (
    outline.projectId !== expectedProjectId ||
    (decision !== 'approved' && decision !== 'rejected') ||
    reasonCodesValue.length < 1 ||
    reasonCodesValue.length > 32
  ) invalid(expectedProjectId);
  const reasonCodes = Object.freeze([...reasonCodesValue].sort().map((item) =>
    identifier(item, PORTABLE_IDENTIFIER_PATTERN, expectedProjectId)));
  if (new Set(reasonCodes).size !== reasonCodes.length) invalid(expectedProjectId);
  const candidate = Object.freeze({
    schemaVersion: WIKI_OUTLINE_REVIEW_SCHEMA_VERSION,
    projectId: expectedProjectId,
    outlineDigest: outline.outlineDigest,
    snapshotDigest: outline.snapshotDigest,
    decision,
    reasonCodes,
    activationAuthorized: false as const,
  });
  return Object.freeze({
    ...candidate,
    reviewDigest: digestHierarchyValue(reviewWithoutDigest(candidate)),
  });
}
