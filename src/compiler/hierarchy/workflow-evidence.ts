import {
  HIERARCHICAL_COMPILATION_LIMITS,
  createTextUnit,
  hierarchySha256,
} from './contracts.js';
import {
  HierarchyContractError,
  HierarchicalWorkflowEvidenceInsufficientError,
} from './errors.js';
import { hierarchyTokens } from './tokens.js';
import type {
  CorpusSnapshotV1,
  PageBlueprintV1,
  TextUnitKind,
  TextUnitRangeV1,
  TextUnitV1,
} from './types.js';

const MAXIMUM_UNIT_UTF8_BYTES = 16_384;
const MAXIMUM_UNITS_PER_SOURCE = 64;
const MAXIMUM_CODE_BLOCK_LINES = 24;

const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'can', 'does', 'for',
  'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'what', 'when', 'where', 'which', 'who', 'why', 'with',
  '대한', '무엇', '어떤', '어떻게',
]);
const GENERIC_BLUEPRINT_TOKENS = new Set([
  'additional', 'evidence', 'group', 'overview', 'reference', 'role', 'root', 'topic',
]);

export interface SanitizedHierarchyEvidenceSourceV1 {
  readonly body: string;
  readonly sourceId: string;
  readonly sourceKind: 'code' | 'markdown' | 'planning' | 'text';
  readonly sourceRef: string;
  readonly sourceRevision: `sha256:${string}`;
}

interface SourceBlock {
  readonly endLine: number;
  readonly kind: TextUnitKind;
  readonly startLine: number;
}

interface BoundedBlock extends SourceBlock {
  readonly content: string;
  readonly endColumn: number;
  readonly startColumn: number;
}

interface HeadingBlock extends BoundedBlock {
  readonly level: number;
}

interface RankedUnit {
  readonly evidenceRelevance: number;
  readonly primaryRelevance: number;
  readonly relevance: number;
  readonly richness: number;
  readonly unit: TextUnitV1;
}

interface QueryProfile {
  readonly primary: ReadonlySet<string>;
  readonly weights: ReadonlyMap<string, number>;
}

function invalid(projectId: string): never {
  throw new HierarchyContractError(projectId);
}

function scalarLength(value: string): number {
  return [...value].length;
}

function fenceStart(line: string): Readonly<{
  readonly character: '`' | '~';
  readonly length: number;
}> | null {
  const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
  if (marker === undefined) return null;
  return Object.freeze({
    character: marker[0] as '`' | '~',
    length: marker.length,
  });
}

function closesFence(
  line: string,
  fence: Readonly<{ readonly character: '`' | '~'; readonly length: number }>,
): boolean {
  const marker = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
  return marker !== undefined && marker[0] === fence.character && marker.length >= fence.length;
}

function markdownLineKind(line: string): TextUnitKind {
  if (/^\s*(?:[-+*]|\d+[.)])\s+/u.test(line)) return 'list';
  if (/^\s*\|.*\|\s*$/u.test(line)) return 'table';
  return 'paragraph';
}

function codeBlocks(lines: readonly string[]): readonly SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && (lines[index]?.trim() ?? '') === '') index += 1;
    if (index >= lines.length) break;
    const start = index;
    let lineCount = 0;
    while (index < lines.length && (lines[index]?.trim() ?? '') !== '' &&
        lineCount < MAXIMUM_CODE_BLOCK_LINES) {
      if (lineCount > 0 && isTopLevelDeclaration(lines[index] ?? '')) break;
      index += 1;
      lineCount += 1;
    }
    blocks.push(Object.freeze({
      endLine: index,
      kind: 'fenced-code',
      startLine: start + 1,
    }));
  }
  return Object.freeze(blocks);
}

function isTopLevelDeclaration(line: string): boolean {
  if (/^\s/u.test(line)) return false;
  return /^(?:(?:export|declare|public|private|protected|static|final|abstract|async)\s+)*(?:class|const|def|enum|fn|func|function|impl|interface|let|module|namespace|package|record|struct|trait|type|var)\b/u
    .test(line);
}

function markdownBlocks(lines: readonly string[]): readonly SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    if (current === undefined) break;
    if (current.trim() === '') {
      index += 1;
      continue;
    }
    if (/^ {0,3}#{1,6}(?:\s+|$)/u.test(current)) {
      index += 1;
      continue;
    }
    const openedFence = fenceStart(current);
    if (openedFence !== null) {
      const start = index;
      index += 1;
      while (index < lines.length) {
        const line = lines[index];
        if (line === undefined) break;
        index += 1;
        if (closesFence(line, openedFence)) break;
      }
      blocks.push(Object.freeze({
        endLine: index,
        kind: 'fenced-code',
        startLine: start + 1,
      }));
      continue;
    }
    const kind = markdownLineKind(current);
    const start = index;
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined || line.trim() === '' || fenceStart(line) !== null ||
          /^ {0,3}#{1,6}(?:\s+|$)/u.test(line) || markdownLineKind(line) !== kind) break;
      index += 1;
    }
    blocks.push(Object.freeze({ endLine: index, kind, startLine: start + 1 }));
  }
  return Object.freeze(blocks);
}

function markdownHeadings(lines: readonly string[]): readonly HeadingBlock[] {
  const headings: HeadingBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const match = /^( {0,3}#{1,6}[ \t]+)(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(line);
    const prefix = match?.[1];
    const rawLabel = match?.[2];
    if (prefix === undefined || rawLabel === undefined || rawLabel.length === 0) continue;
    const level = /#{1,6}/u.exec(prefix)?.[0].length;
    if (level === undefined) continue;
    const content = [...rawLabel].slice(0, 1_000).join('');
    const startColumn = scalarLength(prefix) + 1;
    headings.push(Object.freeze({
      content,
      endColumn: startColumn + scalarLength(content) - 1,
      endLine: index + 1,
      kind: 'heading',
      level,
      startColumn,
      startLine: index + 1,
    }));
  }
  return Object.freeze(headings);
}

function documentTitle(sourceRef: string): string {
  const filename = sourceRef.split('/').at(-1) ?? sourceRef;
  const withoutExtension = filename.replace(/\.[^.]+$/u, '');
  const normalized = withoutExtension.replace(/[-_]+/gu, ' ').trim().normalize('NFC');
  const title = [...(normalized.length > 0 ? normalized : filename)].slice(0, 1_000).join('');
  return title.length > 0 ? title : 'Document';
}

function virtualDocumentBlock(sourceRef: string): BoundedBlock {
  return Object.freeze({
    content: documentTitle(sourceRef),
    endColumn: 1,
    endLine: 1,
    kind: 'document',
    startColumn: 1,
    startLine: 1,
  });
}

function boundedPrefix(value: string): string {
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > MAXIMUM_UNIT_UTF8_BYTES) break;
    result += character;
  }
  return result;
}

function boundBlock(lines: readonly string[], block: SourceBlock): BoundedBlock | null {
  const selected: string[] = [];
  for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    if (line === undefined) break;
    const candidate = [...selected, line].join('\n');
    if (Buffer.byteLength(candidate, 'utf8') <= MAXIMUM_UNIT_UTF8_BYTES) {
      selected.push(line);
      continue;
    }
    if (selected.length === 0) {
      const prefix = boundedPrefix(line);
      if (prefix.length === 0) return null;
      selected.push(prefix);
    }
    break;
  }
  while (selected.at(-1)?.length === 0) selected.pop();
  const content = selected.join('\n');
  const last = selected.at(-1);
  if (content.length === 0 || last === undefined || last.length === 0) return null;
  return Object.freeze({
    content,
    endColumn: scalarLength(last),
    endLine: block.startLine + selected.length - 1,
    kind: block.kind,
    startColumn: 1,
    startLine: block.startLine,
  });
}

function contentTokens(value: string): readonly string[] {
  return Object.freeze(hierarchyTokens(value)
    .filter((token) => scalarLength(token) > 1 && !QUERY_STOP_WORDS.has(token)));
}

function isSubstantive(block: BoundedBlock): boolean {
  const tokens = contentTokens(block.content);
  const minimumTokens = block.kind === 'fenced-code' ? 2 : 3;
  return tokens.length >= minimumTokens && Buffer.byteLength(block.content, 'utf8') >= 24;
}

function representativeBlocks<T extends BoundedBlock>(
  blocks: readonly T[],
  maximum: number,
): readonly T[] {
  if (blocks.length <= maximum) return Object.freeze([...blocks]);
  if (maximum === 1) {
    const first = blocks[0];
    return first === undefined ? Object.freeze([]) : Object.freeze([first]);
  }
  const selected = new Map<number, T>();
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.floor(index * (blocks.length - 1) / (maximum - 1));
    const block = blocks[sourceIndex];
    if (block !== undefined) selected.set(sourceIndex, block);
  }
  return Object.freeze([...selected.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]));
}

function representativeMarkdownBlocks(
  blocks: readonly BoundedBlock[],
  topicHeadings: readonly HeadingBlock[],
  maximum: number,
): readonly BoundedBlock[] {
  if (maximum < 1) return Object.freeze([]);
  if (blocks.length <= maximum) return Object.freeze([...blocks]);
  const selected = new Map<number, BoundedBlock>();
  const blockIndex = new Map(blocks.map((block, index) => [block, index]));
  const add = (block: BoundedBlock | undefined): void => {
    if (block === undefined || selected.size >= maximum) return;
    const index = blockIndex.get(block);
    if (index !== undefined) selected.set(index, block);
  };
  for (let offset = 0; offset < 2; offset += 1) {
    for (let index = 0; index < topicHeadings.length; index += 1) {
      const heading = topicHeadings[index];
      const next = topicHeadings[index + 1];
      add(blocks.filter((block) =>
        heading !== undefined && block.startLine > heading.startLine &&
        (next === undefined || block.startLine < next.startLine))[offset]);
    }
  }
  for (const block of blocks) {
    if (block.kind === 'list' || block.kind === 'table') add(block);
  }
  for (const block of representativeBlocks(blocks, maximum)) add(block);
  for (const block of blocks) add(block);
  return Object.freeze([...selected.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]));
}

/** Creates bounded, exact-range units only from already-sanitized source bodies. */
export function createSubstantiveHierarchyTextUnits(
  sourceValues: readonly SanitizedHierarchyEvidenceSourceV1[],
  projectId: string,
): readonly TextUnitV1[] {
  if (sourceValues.length < 1 ||
      sourceValues.length > HIERARCHICAL_COMPILATION_LIMITS.maxSources ||
      new Set(sourceValues.map((source) => source.sourceId)).size !== sourceValues.length) {
    return invalid(projectId);
  }
  const maximumPerSource = Math.max(1, Math.min(
    MAXIMUM_UNITS_PER_SOURCE,
    Math.floor(HIERARCHICAL_COMPILATION_LIMITS.maxTasks / sourceValues.length),
  ));
  const result: TextUnitV1[] = [];
  for (const source of sourceValues) {
    if (source.body.includes('\r')) invalid(projectId);
    const lines = source.body.split('\n');
    const blocks = source.sourceKind === 'code' ? codeBlocks(lines) : markdownBlocks(lines);
    const availableSubstantive = blocks.map((block) => boundBlock(lines, block))
      .filter((block): block is BoundedBlock => block !== null && isSubstantive(block));
    if (availableSubstantive.length < 1) invalid(projectId);
    const headings = source.sourceKind === 'code' ? Object.freeze([]) : markdownHeadings(lines);
    const documentHeading = headings.find((heading) => heading.level === 1);
    const document = documentHeading === undefined
      ? virtualDocumentBlock(source.sourceRef)
      : Object.freeze({ ...documentHeading, kind: 'document' as const });
    const topicHeadings = headings.filter((heading) => heading.level === 2);
    const maximumHeadingUnits = Math.max(0, Math.floor((maximumPerSource - 1) / 3));
    const retainedTopicHeadings = representativeBlocks(
      topicHeadings,
      Math.min(topicHeadings.length, maximumHeadingUnits),
    );
    const maximumBodyUnits = Math.max(
      1,
      maximumPerSource - 1 - retainedTopicHeadings.length,
    );
    const substantive = source.sourceKind === 'code'
      ? representativeBlocks(availableSubstantive, maximumBodyUnits)
      : representativeMarkdownBlocks(availableSubstantive, topicHeadings, maximumBodyUnits);
    const selectedBlocks = [document, ...retainedTopicHeadings, ...substantive]
      .sort((left, right) => left.startLine - right.startLine ||
        left.startColumn - right.startColumn)
      .slice(0, maximumPerSource);
    for (let ordinal = 0; ordinal < selectedBlocks.length; ordinal += 1) {
      const block = selectedBlocks[ordinal];
      if (block === undefined) invalid(projectId);
      result.push(createTextUnit({
        contentDigest: hierarchySha256(block.content),
        kind: block.kind,
        ordinal,
        projectId,
        range: Object.freeze({
          endColumn: block.endColumn,
          endLine: block.endLine,
          startColumn: block.startColumn,
          startLine: block.startLine,
        }),
        sourceId: source.sourceId,
        sourceRef: source.sourceRef,
        sourceRevision: source.sourceRevision,
        ...((block.kind === 'heading' || block.kind === 'document')
          ? { topicLabel: block.content }
          : {}),
      }));
    }
  }
  if (result.length > HIERARCHICAL_COMPILATION_LIMITS.maxTasks) invalid(projectId);
  return Object.freeze(result);
}

export function extractHierarchyTextUnitContent(
  body: string,
  range: TextUnitRangeV1,
  projectId: string,
): string {
  const lines = body.split('\n');
  const selected = lines.slice(range.startLine - 1, range.endLine);
  const first = selected[0];
  const last = selected.at(-1);
  if (first === undefined || last === undefined ||
      selected.length !== range.endLine - range.startLine + 1) invalid(projectId);
  const firstScalars = [...first];
  const lastScalars = [...last];
  if (range.startColumn < 1 || range.startColumn > firstScalars.length ||
      range.endColumn < 1 || range.endColumn > lastScalars.length) invalid(projectId);
  if (selected.length === 1) {
    return firstScalars.slice(range.startColumn - 1, range.endColumn).join('');
  }
  selected[0] = firstScalars.slice(range.startColumn - 1).join('');
  selected[selected.length - 1] = lastScalars.slice(0, range.endColumn).join('');
  return selected.join('\n');
}

function addQueryTokens(weights: Map<string, number>, value: string, weight: number): void {
  for (const token of contentTokens(value)) {
    weights.set(token, Math.max(weights.get(token) ?? 0, weight));
  }
}

function queryProfile(blueprint: PageBlueprintV1): QueryProfile {
  const weights = new Map<string, number>();
  addQueryTokens(weights, blueprint.title, 12);
  addQueryTokens(weights, blueprint.role, 12);
  addQueryTokens(weights, blueprint.stableKey, 10);
  const primary = new Set([...weights.keys()].filter((token) =>
    !GENERIC_BLUEPRINT_TOKENS.has(token)));
  for (const section of blueprint.requiredSections) addQueryTokens(weights, section, 4);
  for (const question of blueprint.keyQuestions) {
    const before = new Set(weights.keys());
    addQueryTokens(weights, question, 3);
    if (primary.size === 0) {
      for (const token of weights.keys()) {
        if (!before.has(token) && !GENERIC_BLUEPRINT_TOKENS.has(token)) primary.add(token);
      }
    }
  }
  return Object.freeze({ primary, weights });
}

function compareRankedUnits(left: RankedUnit, right: RankedUnit): number {
  if (left.primaryRelevance !== right.primaryRelevance) {
    return right.primaryRelevance - left.primaryRelevance;
  }
  if (left.evidenceRelevance !== right.evidenceRelevance) {
    return right.evidenceRelevance - left.evidenceRelevance;
  }
  if (left.richness !== right.richness) return right.richness - left.richness;
  if (left.relevance !== right.relevance) return right.relevance - left.relevance;
  return left.unit.unitId < right.unit.unitId ? -1 : left.unit.unitId > right.unit.unitId ? 1 : 0;
}

/** Selects deterministic, relevant units while enforcing the blueprint's source diversity. */
export function selectRelevantHierarchyEvidenceUnitIds(
  blueprint: PageBlueprintV1,
  snapshot: CorpusSnapshotV1,
  sourceValues: readonly SanitizedHierarchyEvidenceSourceV1[],
  projectId: string,
): readonly string[] {
  if (blueprint.projectId !== projectId || snapshot.projectId !== projectId ||
      blueprint.evidenceScope.snapshotDigest !== snapshot.snapshotDigest ||
      blueprint.minimumDistinctSources > HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits) {
    return invalid(projectId);
  }
  const sourceById = new Map(sourceValues.map((source) => [source.sourceId, source]));
  if (sourceById.size !== sourceValues.length) invalid(projectId);
  const query = queryProfile(blueprint);
  if (query.weights.size === 0) invalid(projectId);
  const preferredUnitIds = blueprint.evidenceScope.preferredUnitIds ?? Object.freeze([]);
  const preferredOrder = new Map(preferredUnitIds.map((unitId, index) => [unitId, index]));
  if (preferredOrder.size !== preferredUnitIds.length) invalid(projectId);
  const bySource = new Map<string, RankedUnit[]>();
  for (const unit of snapshot.textUnits) {
    if (!blueprint.evidenceScope.sourceIds.includes(unit.sourceId) ||
        !blueprint.evidenceScope.allowedUnitKinds.includes(unit.kind) || unit.kind === 'document') {
      continue;
    }
    const source = sourceById.get(unit.sourceId);
    if (source === undefined || source.sourceRef !== unit.sourceRef ||
        source.sourceRevision !== unit.sourceRevision) invalid(projectId);
    const content = extractHierarchyTextUnitContent(source.body, unit.range, projectId);
    if (hierarchySha256(content) !== unit.contentDigest) invalid(projectId);
    const tokens = new Set(contentTokens(content));
    const heading = unit.kind === 'heading'
      ? unit
      : snapshot.textUnits.filter((candidate) =>
        candidate.sourceId === unit.sourceId && candidate.kind === 'heading' &&
        candidate.range.startLine < unit.range.startLine)
        .sort((left, right) => right.range.startLine - left.range.startLine)[0];
    const contextTokens = heading === undefined
      ? new Set<string>()
      : new Set(contentTokens(extractHierarchyTextUnitContent(source.body, heading.range, projectId)));
    const sourceTokens = new Set(contentTokens(source.sourceRef));
    let evidenceRelevance = 0;
    let primaryRelevance = 0;
    let relevance = 0;
    for (const [token, weight] of query.weights) {
      const contentMatch = tokens.has(token);
      const contextMatch = contextTokens.has(token);
      const sourceMatch = sourceTokens.has(token);
      if (contentMatch) relevance += weight;
      if (contextMatch) relevance += weight;
      if (contentMatch || contextMatch) evidenceRelevance += weight;
      // A path may help break ties, but it is metadata rather than page evidence.
      // In particular, an iteration directory named after a workflow must not make
      // an unrelated README sentence page-relevant by itself.
      if (sourceMatch) relevance += Math.max(1, Math.floor(weight / 4));
      if (query.primary.has(token)) {
        // The same role word in a heading and its body is one relevance signal,
        // not two independent pieces of evidence.
        if (contentMatch || contextMatch) primaryRelevance += weight;
      }
    }
    const values = bySource.get(unit.sourceId) ?? [];
    values.push(Object.freeze({
      evidenceRelevance,
      primaryRelevance,
      relevance,
      richness: tokens.size,
      unit,
    }));
    bySource.set(unit.sourceId, values);
  }
  const rankedSources = [...bySource.entries()].map(([sourceId, units]) => {
    units.sort(compareRankedUnits);
    return Object.freeze({
      bestPrimaryRelevance: units[0]?.primaryRelevance ?? 0,
      bestEvidenceRelevance: units[0]?.evidenceRelevance ?? 0,
      bestRelevance: units[0]?.relevance ?? 0,
      bestRichness: units[0]?.richness ?? 0,
      sourceId,
      units: Object.freeze(units),
    });
  });
  const aggregatePage = blueprint.role === 'overview' || blueprint.role === 'topic-group';
  const eligibleSources = rankedSources.filter((source) =>
    aggregatePage || source.bestPrimaryRelevance > 0 ||
      source.units.some((ranked) => preferredOrder.has(ranked.unit.unitId)))
    .sort((left, right) => {
      if (left.bestPrimaryRelevance !== right.bestPrimaryRelevance) {
        return right.bestPrimaryRelevance - left.bestPrimaryRelevance;
      }
      if (left.bestEvidenceRelevance !== right.bestEvidenceRelevance) {
        return right.bestEvidenceRelevance - left.bestEvidenceRelevance;
      }
      if (left.bestRichness !== right.bestRichness) return right.bestRichness - left.bestRichness;
      if (left.bestRelevance !== right.bestRelevance) {
        return right.bestRelevance - left.bestRelevance;
      }
      return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
    });
  const selected = new Set<string>();
  const selectedSources = new Set<string>();
  const sourceUnitCounts = new Map<string, number>();
  const trySelect = (unit: TextUnitV1): void => {
    if (selected.has(unit.unitId) ||
        selected.size >= HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits) return;
    const existingCount = sourceUnitCounts.get(unit.sourceId) ?? 0;
    if (existingCount >= HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnitsPerSource ||
        (!selectedSources.has(unit.sourceId) &&
          selectedSources.size >= HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceSourcesPerPage)) {
      return;
    }
    selected.add(unit.unitId);
    selectedSources.add(unit.sourceId);
    sourceUnitCounts.set(unit.sourceId, existingCount + 1);
  };
  const unitById = new Map(snapshot.textUnits.map((unit) => [unit.unitId, unit]));
  for (const unitId of preferredUnitIds) {
    const unit = unitById.get(unitId);
    if (unit === undefined || unit.kind === 'document' ||
        !blueprint.evidenceScope.sourceIds.includes(unit.sourceId) ||
        !blueprint.evidenceScope.allowedUnitKinds.includes(unit.kind)) invalid(projectId);
    trySelect(unit);
  }
  for (const source of eligibleSources) {
    for (const ranked of source.units) trySelect(ranked.unit);
  }
  if (selected.size === 0 || selectedSources.size < blueprint.minimumDistinctSources) {
    throw new HierarchicalWorkflowEvidenceInsufficientError(
      blueprint.pageId,
      blueprint.title,
      Object.freeze([...query.primary].sort()),
    );
  }
  return Object.freeze([...selected]);
}
