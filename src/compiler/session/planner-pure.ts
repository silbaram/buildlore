import { compareSessionText, digestSessionValue, sessionSha256 } from './canonical.js';
import { SESSION_COMPILE_LIMITS } from './contracts.js';
import { SessionCompileError } from './errors.js';
import {
  transitionSessionMarkdownFence,
  type SessionMarkdownFence,
} from './markdown-fence.js';
import {
  SESSION_COMPILE_ALGORITHM_VERSION,
  type SessionCitationAnchor,
  type SessionMergeCandidate,
  type SessionPlannedSource,
  type SessionPlanTask,
  type SessionRequestedPageKind,
} from './types.js';
import type {
  SourceJsonOriginMappingV1,
  SourceRangeMappingV1,
} from '../../projector/source-contracts.js';

interface SectionDraft {
  readonly endLine: number;
  readonly headingKey: string;
  readonly sourceId: string;
  readonly startLine: number;
  readonly taskId: string;
  readonly tokens: readonly string[];
}

const MAX_HEADING_CODE_POINTS = 256;
const MAX_HEADING_TOKENS = 256;
const MAX_HEADING_TOKEN_CODE_POINTS = 256;

export function createSessionCitationAnchors(input: {
  readonly originMappings?: readonly SourceRangeMappingV1[];
  readonly jsonOrigins?: readonly SourceJsonOriginMappingV1[];
  readonly originalBody: string;
  readonly sanitizedBody: string;
  readonly sourceId: string;
  readonly sourceRef: string;
}): readonly SessionCitationAnchor[] {
  const originalLines = input.originalBody.replace(/\r\n?/gu, '\n').split('\n');
  const sanitizedLines = input.sanitizedBody.split('\n');
  const anchors: SessionCitationAnchor[] = [];
  for (let index = 0; index < sanitizedLines.length; index += 1) {
    const quote = sanitizedLines[index];
    const canonicalLine = index + 1;
    const mapping = input.originMappings?.find((candidate) =>
      canonicalLine >= candidate.canonical.startLine &&
      canonicalLine <= candidate.canonical.endLine);
    const jsonOrigin = input.jsonOrigins?.find((candidate) =>
      canonicalLine >= candidate.canonical.startLine &&
      canonicalLine <= candidate.canonical.endLine);
    const originalLine = jsonOrigin?.origin.range.startLine ?? (mapping === undefined
      ? canonicalLine
      : mapping.origin.startLine + canonicalLine - mapping.canonical.startLine);
    const originalFile = jsonOrigin?.origin.sourceRef ?? input.sourceRef;
    const originalRange = jsonOrigin?.origin.range;
    if (
      quote === undefined ||
      quote.trim().length === 0 ||
      quote.length > SESSION_COMPILE_LIMITS.maxQuoteCodeUnits ||
      (jsonOrigin === undefined && originalLines[originalLine - 1] !== quote)
    ) continue;
    const quoteDigest = sessionSha256(quote);
    anchors.push(Object.freeze({
      anchorId: 'anchor-' + digestSessionValue({
        ...(jsonOrigin === undefined ? {} : { canonicalLine }),
        ...(jsonOrigin === undefined ? {} : { jsonPointer: jsonOrigin.origin.jsonPointer }),
        originalFile,
        originalLine,
        ...(originalRange === undefined ? {} : { originalRange }),
        quoteDigest,
        sourceId: input.sourceId,
      }).slice('sha256:'.length),
      ...(jsonOrigin === undefined ? {} : { canonicalLine }),
      ...(jsonOrigin === undefined ? {} : { jsonPointer: jsonOrigin.origin.jsonPointer }),
      originalFile,
      originalLine,
      ...(originalRange === undefined ? {} : { originalRange }),
      quote,
      quoteDigest,
      sourceId: input.sourceId,
    }));
  }
  return Object.freeze(anchors);
}

function normalizedTokens(value: string, projectId: string): readonly string[] {
  const tokens = value.normalize('NFC').toLowerCase().normalize('NFC')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(tokens)].sort(compareSessionText);
  if (unique.length > MAX_HEADING_TOKENS ||
      unique.some((token) => [...token].length > MAX_HEADING_TOKEN_CODE_POINTS)) {
    throw new SessionCompileError('SESSION_PLAN_DENIED', projectId);
  }
  return Object.freeze(unique);
}

function headingKey(value: string, projectId: string): string {
  const key = normalizedTokens(value, projectId).join('-') || 'document';
  if ([...key].length > MAX_HEADING_CODE_POINTS) {
    throw new SessionCompileError('SESSION_PLAN_DENIED', projectId);
  }
  return key;
}

function sectionDrafts(
  source: SessionPlannedSource,
  projectId: string,
  maximumDrafts: number,
): readonly SectionDraft[] {
  const lines = source.sanitizedBody.split('\n');
  const starts: Array<{ readonly heading: string; readonly line: number }> = [];
  const addStart = (start: { readonly heading: string; readonly line: number }): void => {
    if (starts.length >= maximumDrafts) {
      throw new SessionCompileError('SESSION_PLAN_DENIED', projectId);
    }
    starts.push(start);
  };
  let fence: SessionMarkdownFence | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const transition = transitionSessionMarkdownFence(line, fence);
    const wasInsideFence = fence !== null;
    fence = transition.fence;
    if (wasInsideFence || transition.isFenceLine) continue;
    const heading = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(line)?.[1]?.trim();
    if (heading !== undefined && heading.length > 0) {
      addStart({ heading, line: index + 1 });
    }
  }
  if (starts.length === 0 || (starts[0]?.line ?? 1) > 1) {
    if (starts.length >= maximumDrafts) {
      throw new SessionCompileError('SESSION_PLAN_DENIED', projectId);
    }
    starts.unshift({ heading: source.title, line: 1 });
  }
  return Object.freeze(starts.map((start, index) => {
    const endLine = Math.max(start.line, (starts[index + 1]?.line ?? lines.length + 1) - 1);
    const key = headingKey(start.heading, projectId);
    const tokens = normalizedTokens(start.heading, projectId);
    return Object.freeze({
      endLine,
      headingKey: key,
      sourceId: source.sourceId,
      startLine: start.line,
      taskId: 'task-' + digestSessionValue({
        endLine,
        headingKey: key,
        sourceId: source.sourceId,
        startLine: start.line,
      }).slice('sha256:'.length),
      tokens,
    });
  }));
}

function mergeCandidates(
  drafts: readonly SectionDraft[],
  projectId: string,
): readonly SessionMergeCandidate[] {
  const orderedDrafts = [...drafts].sort((left, right) =>
    compareSessionText(left.taskId, right.taskId));
  const draftByTaskId = new Map(orderedDrafts.map((draft) => [draft.taskId, draft]));
  const mutableTaskIdsByToken = new Map<string, string[]>();
  for (const draft of orderedDrafts) {
    for (const token of draft.tokens) {
      const taskIds = mutableTaskIdsByToken.get(token) ?? [];
      taskIds.push(draft.taskId);
      mutableTaskIdsByToken.set(token, taskIds);
    }
  }
  const tokenBuckets = new Map([...mutableTaskIdsByToken].map(([token, taskIds]) => {
    taskIds.sort(compareSessionText);
    return [token, Object.freeze({
      positions: new Map(taskIds.map((taskId, index) => [taskId, index])),
      taskIds: Object.freeze(taskIds),
    })] as const;
  }));

  const boundedPairs = new Map<string, SessionMergeCandidate>();
  const halfWindow = Math.max(1,
    Math.floor(SESSION_COMPILE_LIMITS.maxRelationCandidatesPerTask / 2));
  for (const left of orderedDrafts) {
    const neighborTaskIds = new Set<string>();
    for (const token of left.tokens) {
      const bucket = tokenBuckets.get(token);
      if (bucket === undefined) continue;
      const { taskIds } = bucket;
      const ownIndex = bucket.positions.get(left.taskId) ?? -1;
      if (ownIndex < 0 || taskIds.length < 2) continue;
      const radius = Math.min(halfWindow, taskIds.length - 1);
      for (let distance = 1; distance <= radius; distance += 1) {
        const after = taskIds[(ownIndex + distance) % taskIds.length];
        const before = taskIds[(ownIndex - distance + taskIds.length) % taskIds.length];
        if (after !== undefined) neighborTaskIds.add(after);
        if (before !== undefined) neighborTaskIds.add(before);
      }
    }
    const ranked = [...neighborTaskIds].flatMap((rightTaskId): readonly SessionMergeCandidate[] => {
      const right = draftByTaskId.get(rightTaskId);
      if (right === undefined || left.sourceId === right.sourceId ||
          left.tokens.length === 0 || right.tokens.length === 0) return [];
      const rightTokens = new Set(right.tokens);
      const sharedTokens = Object.freeze(left.tokens.filter((token) => rightTokens.has(token)));
      const union = new Set([...left.tokens, ...right.tokens]).size;
      const scoreBasisPoints = union === 0 ? 0 : Math.floor(sharedTokens.length * 10_000 / union);
      if (left.headingKey !== right.headingKey &&
          (sharedTokens.length < 2 || scoreBasisPoints < 5_000)) return [];
      const memberSourceIds = [left.sourceId, right.sourceId].sort(compareSessionText);
      const memberTaskIds = [left.taskId, right.taskId].sort(compareSessionText);
      const orderingKey = String(10_000 - scoreBasisPoints).padStart(5, '0') + ':' +
        memberTaskIds.join(':');
      return [Object.freeze({
        candidateId: 'merge-' + digestSessionValue({
          algorithmVersion: SESSION_COMPILE_ALGORITHM_VERSION,
          memberTaskIds,
          scoreBasisPoints,
          sharedTokens,
        }).slice('sha256:'.length),
        deterministicEvidence: Object.freeze({ scoreBasisPoints, sharedTokens }),
        memberSourceIds: Object.freeze(memberSourceIds),
        memberTaskIds: Object.freeze(memberTaskIds),
        orderingKey,
      })];
    }).sort((left, right) => compareSessionText(left.orderingKey, right.orderingKey))
      .slice(0, SESSION_COMPILE_LIMITS.maxRelationCandidatesPerTask);
    for (const candidate of ranked) boundedPairs.set(candidate.candidateId, candidate);
  }

  const degreeByTaskId = new Map<string, number>();
  const selected: SessionMergeCandidate[] = [];
  for (const candidate of [...boundedPairs.values()].sort((left, right) =>
    compareSessionText(left.orderingKey, right.orderingKey))) {
    const [leftTaskId, rightTaskId] = candidate.memberTaskIds;
    if (leftTaskId === undefined || rightTaskId === undefined) continue;
    if ((degreeByTaskId.get(leftTaskId) ?? 0) >=
        SESSION_COMPILE_LIMITS.maxRelationCandidatesPerTask ||
        (degreeByTaskId.get(rightTaskId) ?? 0) >=
        SESSION_COMPILE_LIMITS.maxRelationCandidatesPerTask) continue;
    if (selected.length >= SESSION_COMPILE_LIMITS.maxMergeCandidates) {
      throw new SessionCompileError('SESSION_PLAN_DENIED', projectId);
    }
    selected.push(candidate);
    degreeByTaskId.set(leftTaskId, (degreeByTaskId.get(leftTaskId) ?? 0) + 1);
    degreeByTaskId.set(rightTaskId, (degreeByTaskId.get(rightTaskId) ?? 0) + 1);
  }
  return Object.freeze(selected);
}

export function createSessionTasksAndMerges(
  sources: readonly SessionPlannedSource[],
  profileMode: 'custom' | 'default',
  projectId = 'unknown',
): Readonly<{
  readonly mergeCandidates: readonly SessionMergeCandidate[];
  readonly tasks: readonly SessionPlanTask[];
}> {
  const drafts: SectionDraft[] = [];
  for (const source of sources) {
    drafts.push(...sectionDrafts(
      source,
      projectId,
      SESSION_COMPILE_LIMITS.maxTasks - drafts.length,
    ));
  }
  const merges = mergeCandidates(drafts, projectId);
  const mergeIdsByTask = new Map<string, string[]>();
  for (const merge of merges) {
    for (const taskId of merge.memberTaskIds) {
      const ids = mergeIdsByTask.get(taskId) ?? [];
      ids.push(merge.candidateId);
      mergeIdsByTask.set(taskId, ids);
    }
  }
  const requestedPageKinds: readonly SessionRequestedPageKind[] = profileMode === 'custom'
    ? Object.freeze(['decision', 'failure', 'verification'] as const)
    : Object.freeze(['concept', 'query'] as const);
  const tasks: SessionPlanTask[] = drafts.map((draft) => Object.freeze({
    allowedSourceIds: Object.freeze([draft.sourceId]),
    endLine: draft.endLine,
    headingKey: draft.headingKey,
    mergeCandidateIds: Object.freeze(
      [...(mergeIdsByTask.get(draft.taskId) ?? [])].sort(compareSessionText),
    ),
    outputBounds: Object.freeze({
      maxBytes: SESSION_COMPILE_LIMITS.maxPageBytes,
      maxCitations: SESSION_COMPILE_LIMITS.maxCitationsPerPage,
      maxLinks: SESSION_COMPILE_LIMITS.maxLinksPerPage,
    }),
    requestedPageKinds,
    sourceId: draft.sourceId,
    startLine: draft.startLine,
    taskId: draft.taskId,
  }));
  tasks.sort((left, right) => compareSessionText(left.taskId, right.taskId));
  return Object.freeze({ mergeCandidates: merges, tasks: Object.freeze(tasks) });
}
