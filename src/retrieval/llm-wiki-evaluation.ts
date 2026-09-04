import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import type {
  SourceDocumentAuthority,
  SourceDocumentLifecycle,
  SourceEvidenceKind,
} from '../projector/source-contracts.js';
import type { EmbeddingProviderPort } from './embedding/types.js';
import {
  createApprovedWikiLegacyRetrieval,
  SEMANTIC_CONTENT_POLICY_DIGEST,
  type ApprovedWikiMeaningSignalV1,
  type ApprovedWikiRetrievalCorpusV1,
  type HierarchicalRetrievalLocatorV1,
} from './hierarchical.js';
import { RETRIEVAL_FUSION_POLICY_V1, RETRIEVAL_RANKING_POLICY_V2 } from './hybrid.js';
import {
  RETRIEVAL_RESULT_V3_SCHEMA_VERSION,
  type LocalWikiRetrievalEffectiveIntent,
  type LocalWikiRetrievalMode,
  type LocalWikiRetrievalPortV3,
} from './hybrid-types.js';
import { roundSix } from './strategy.js';

export const LLM_WIKI_RETRIEVAL_EVALUATION_SCHEMA_VERSION =
  'buildlore.llm-wiki-retrieval-eval.v3' as const;

export interface LlmWikiQualityCaseV3 {
  readonly expectedAuthorities: readonly SourceDocumentAuthority[];
  readonly expectedEvidenceKinds: readonly SourceEvidenceKind[];
  readonly expectedLifecycles: readonly SourceDocumentLifecycle[];
  readonly expectedPageLabels: readonly string[];
  readonly intent: LocalWikiRetrievalEffectiveIntent;
  readonly queryId: string;
  readonly text: string;
  readonly topK: 5;
}

export interface LlmWikiQualityHitV3 {
  readonly authority: SourceDocumentAuthority;
  readonly contextUtf8Bytes: number;
  readonly evidenceKind: SourceEvidenceKind;
  readonly expectedPageLabelMatched: boolean;
  readonly iterationGroup: string | null;
  readonly lifecycle: SourceDocumentLifecycle;
  readonly pageId: string;
  readonly providerTokenCount: number;
  readonly topicGroup: string | null;
}

export interface LlmWikiQualityObservationV3 {
  readonly hits: readonly LlmWikiQualityHitV3[];
  readonly queryId: string;
}

export interface LlmWikiQualityEvaluationInputV3 {
  readonly baseline: readonly LlmWikiQualityObservationV3[];
  readonly baselineIdentity: LlmWikiQualityBaselineIdentityV3;
  readonly candidate: readonly LlmWikiQualityObservationV3[];
  readonly candidateIdentity: LlmWikiQualityCandidateIdentityV3;
  readonly corpusDigest: `sha256:${string}`;
  readonly providerIdentityDigest: `sha256:${string}`;
  readonly rankingPolicyDigest: `sha256:${string}`;
  readonly semanticContentPolicyDigest: `sha256:${string}`;
  readonly mode: LocalWikiRetrievalMode;
}

export interface LlmWikiQualityEvaluationRunInputV3 {
  readonly candidate: LocalWikiRetrievalPortV3;
  readonly corpus: ApprovedWikiRetrievalCorpusV1;
  readonly mode?: LocalWikiRetrievalMode;
  readonly projectId: string;
  readonly provider: EmbeddingProviderPort;
}

export interface LlmWikiQualityMetricsV3 {
  readonly contextUtf8Bytes: number;
  readonly duplicateHitRatio: number;
  readonly mrr: number;
  readonly providerTokenCount: number;
  readonly recallAt5: number;
}

export interface LlmWikiQualityQueryResultV3 {
  readonly baseline: LlmWikiQualityMetricsV3;
  readonly candidate: LlmWikiQualityMetricsV3;
  readonly intent: LocalWikiRetrievalEffectiveIntent;
  readonly passed: boolean;
  readonly queryId: string;
}

export interface LlmWikiQualityBaselineIdentityV3 {
  readonly identityDigest: `sha256:${string}`;
  readonly mode: 'graph';
  readonly retrievalVersion: 'approved-wiki-legacy-raw-v1';
}

export interface LlmWikiQualityCandidateIdentityV3 {
  readonly embeddingIdentityDigest: `sha256:${string}` | null;
  readonly identityDigest: `sha256:${string}`;
  readonly indexGenerationId: string | null;
  readonly indexManifestDigest: `sha256:${string}` | null;
  readonly mode: LocalWikiRetrievalMode;
}

export interface LlmWikiQualityEvaluationV3 {
  readonly aggregate: Readonly<{
    readonly baseline: LlmWikiQualityMetricsV3;
    readonly candidate: LlmWikiQualityMetricsV3;
  }>;
  readonly baselineIdentity: LlmWikiQualityBaselineIdentityV3;
  readonly candidateIdentity: LlmWikiQualityCandidateIdentityV3;
  readonly corpusDigest: `sha256:${string}`;
  readonly evaluationPolicyDigest: `sha256:${string}`;
  readonly mode: LocalWikiRetrievalMode;
  readonly overallPassed: boolean;
  readonly providerIdentityDigest: `sha256:${string}`;
  readonly queryCount: 8;
  readonly queryResults: readonly LlmWikiQualityQueryResultV3[];
  readonly rankingPolicyDigest: `sha256:${string}`;
  readonly schemaVersion: typeof LLM_WIKI_RETRIEVAL_EVALUATION_SCHEMA_VERSION;
  readonly semanticContentPolicyDigest: `sha256:${string}`;
}

export const LLM_WIKI_QUALITY_CASES_V3: readonly LlmWikiQualityCaseV3[] = Object.freeze([
  Object.freeze({
    expectedAuthorities: Object.freeze(['canonical', 'supporting'] as const),
    expectedEvidenceKinds: Object.freeze(['overview', 'architecture'] as const),
    expectedLifecycles: Object.freeze(['current'] as const),
    expectedPageLabels: Object.freeze(['overview', 'architecture']),
    intent: 'current' as const,
    queryId: 'project-structure',
    text: '프로젝트 구성',
    topK: 5 as const,
  }),
  Object.freeze({
    expectedAuthorities: Object.freeze(['canonical', 'supporting'] as const),
    expectedEvidenceKinds: Object.freeze(['overview'] as const),
    expectedLifecycles: Object.freeze(['current'] as const),
    expectedPageLabels: Object.freeze(['overview']),
    intent: 'current' as const,
    queryId: 'what-is-buildlore',
    text: 'BuildLore는 무엇인가',
    topK: 5 as const,
  }),
  Object.freeze({
    expectedAuthorities: Object.freeze(['canonical', 'supporting'] as const),
    expectedEvidenceKinds: Object.freeze(['architecture', 'implementation', 'verification'] as const),
    expectedLifecycles: Object.freeze(['current'] as const),
    expectedPageLabels: Object.freeze(['wiki', 'activation']),
    intent: 'current' as const,
    queryId: 'wiki-activation',
    text: 'Wiki 생성과 activation 과정',
    topK: 5 as const,
  }),
  Object.freeze({
    expectedAuthorities: Object.freeze(['canonical', 'supporting'] as const),
    expectedEvidenceKinds: Object.freeze(['implementation', 'verification'] as const),
    expectedLifecycles: Object.freeze(['current'] as const),
    expectedPageLabels: Object.freeze(['sanitizer', 'security']),
    intent: 'current' as const,
    queryId: 'secret-sanitizer',
    text: '비밀정보 sanitizer 동작 방식',
    topK: 5 as const,
  }),
  Object.freeze({
    expectedAuthorities: Object.freeze(['canonical', 'supporting'] as const),
    expectedEvidenceKinds: Object.freeze(['implementation', 'verification'] as const),
    expectedLifecycles: Object.freeze(['current'] as const),
    expectedPageLabels: Object.freeze(['semantic', 'retrieval']),
    intent: 'current' as const,
    queryId: 'semantic-index',
    text: 'semantic index 생성과 검색 방법',
    topK: 5 as const,
  }),
  Object.freeze({
    expectedAuthorities: Object.freeze(['canonical', 'supporting'] as const),
    expectedEvidenceKinds: Object.freeze(['implementation', 'overview'] as const),
    expectedLifecycles: Object.freeze(['current'] as const),
    expectedPageLabels: Object.freeze(['source']),
    intent: 'current' as const,
    queryId: 'supported-sources',
    text: '현재 지원되는 source 종류',
    topK: 5 as const,
  }),
  Object.freeze({
    expectedAuthorities: Object.freeze(['canonical', 'supporting'] as const),
    expectedEvidenceKinds: Object.freeze(['failure', 'verification'] as const),
    expectedLifecycles: Object.freeze(['current'] as const),
    expectedPageLabels: Object.freeze(['recovery', 'verification']),
    intent: 'current' as const,
    queryId: 'failure-recovery',
    text: '실패 후 복구와 검증 기록',
    topK: 5 as const,
  }),
  Object.freeze({
    expectedAuthorities: Object.freeze(['historical'] as const),
    expectedEvidenceKinds: Object.freeze(['decision', 'execution', 'planning'] as const),
    expectedLifecycles: Object.freeze(['deprecated', 'superseded'] as const),
    expectedPageLabels: Object.freeze(['gate', 'iteration']),
    intent: 'historical' as const,
    queryId: 'historical-gate',
    text: '특정 iteration 또는 Gate의 과거 결정',
    topK: 5 as const,
  }),
]);

const EVALUATION_POLICY_BASIS = Object.freeze({
  duplicateDefinition: 'after-first-same-page-topic-or-iteration',
  fixedCases: LLM_WIKI_QUALITY_CASES_V3,
  thresholds: Object.freeze({
    candidateDuplicateHitRatio: 'strictly-less-than-baseline',
    currentAggregateContextUtf8Bytes: 'strictly-less-than-baseline',
    currentAggregateMrr: 'strictly-greater-than-baseline',
    currentAggregateProviderTokenCount: 'strictly-less-than-baseline',
    perQueryRecallAt5: 'greater-than-zero-and-not-less-than-baseline',
  }),
  version: LLM_WIKI_RETRIEVAL_EVALUATION_SCHEMA_VERSION,
});

export const LLM_WIKI_RETRIEVAL_EVALUATION_POLICY_DIGEST =
  `sha256:${createHash('sha256').update(serializeCanonicalJson(
    EVALUATION_POLICY_BASIS,
  )).digest('hex')}` as const;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk-[a-f0-9]{64}$/u;
const GENERATION_ID = /^generation-[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;

function invalid(): never {
  throw new Error('LLM_WIKI_RETRIEVAL_EVAL_INVALID');
}

function evaluationDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

function validCanonicalIds(values: readonly string[]): boolean {
  return values.length >= 1 && values.length <= 100 &&
    values.every((value) => SAFE_ID.test(value)) &&
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || (values[index - 1] as string) < value);
}

function hasExpectedLabel(searchable: string, label: string): boolean {
  const escaped = label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u').test(searchable);
}

function relevant(hit: LlmWikiQualityHitV3, qualityCase: LlmWikiQualityCaseV3): boolean {
  return hit.expectedPageLabelMatched &&
    qualityCase.expectedEvidenceKinds.includes(hit.evidenceKind) &&
    qualityCase.expectedAuthorities.includes(hit.authority) &&
    qualityCase.expectedLifecycles.includes(hit.lifecycle);
}

function metrics(
  observation: LlmWikiQualityObservationV3,
  qualityCase: LlmWikiQualityCaseV3,
): LlmWikiQualityMetricsV3 {
  const hits = observation.hits.slice(0, qualityCase.topK);
  const matchedEvidence = new Set(hits.filter((hit) => relevant(hit, qualityCase))
    .map((hit) => hit.evidenceKind));
  const expectedEvidence = new Set(qualityCase.expectedEvidenceKinds);
  const first = hits.findIndex((hit) => relevant(hit, qualityCase));
  const pages = new Set<string>();
  const topics = new Set<string>();
  const iterations = new Set<string>();
  let duplicates = 0;
  for (const hit of hits) {
    const duplicate = pages.has(hit.pageId) ||
      (hit.topicGroup !== null && topics.has(hit.topicGroup)) ||
      (hit.iterationGroup !== null && iterations.has(hit.iterationGroup));
    if (duplicate) duplicates += 1;
    pages.add(hit.pageId);
    if (hit.topicGroup !== null) topics.add(hit.topicGroup);
    if (hit.iterationGroup !== null) iterations.add(hit.iterationGroup);
  }
  return Object.freeze({
    contextUtf8Bytes: hits.reduce((sum, hit) => sum + hit.contextUtf8Bytes, 0),
    duplicateHitRatio: roundSix(hits.length === 0 ? 0 : duplicates / hits.length),
    mrr: roundSix(first < 0 ? 0 : 1 / (first + 1)),
    providerTokenCount: hits.reduce((sum, hit) => sum + hit.providerTokenCount, 0),
    recallAt5: roundSix([...expectedEvidence].filter((kind) => matchedEvidence.has(kind)).length /
      expectedEvidence.size),
  });
}

function aggregate(values: readonly LlmWikiQualityMetricsV3[]): LlmWikiQualityMetricsV3 {
  const average = (select: (value: LlmWikiQualityMetricsV3) => number): number =>
    roundSix(values.reduce((sum, value) => sum + select(value), 0) / values.length);
  return Object.freeze({
    contextUtf8Bytes: values.reduce((sum, value) => sum + value.contextUtf8Bytes, 0),
    duplicateHitRatio: average((value) => value.duplicateHitRatio),
    mrr: average((value) => value.mrr),
    providerTokenCount: values.reduce((sum, value) => sum + value.providerTokenCount, 0),
    recallAt5: average((value) => value.recallAt5),
  });
}

function validateObservation(
  observations: readonly LlmWikiQualityObservationV3[],
): ReadonlyMap<string, LlmWikiQualityObservationV3> {
  if (observations.length !== LLM_WIKI_QUALITY_CASES_V3.length ||
      new Set(observations.map((observation) => observation.queryId)).size !== observations.length) {
    invalid();
  }
  const byId = new Map(observations.map((observation) => [observation.queryId, observation]));
  for (const qualityCase of LLM_WIKI_QUALITY_CASES_V3) {
    const observation = byId.get(qualityCase.queryId);
    if (observation === undefined || observation.hits.length > 20) invalid();
    for (const hit of observation.hits) {
      if (!SAFE_ID.test(hit.pageId) || !Number.isSafeInteger(hit.contextUtf8Bytes) ||
          hit.contextUtf8Bytes < 0 || !Number.isSafeInteger(hit.providerTokenCount) ||
          hit.providerTokenCount < 0 || typeof hit.expectedPageLabelMatched !== 'boolean' ||
          (hit.topicGroup !== null && !SAFE_ID.test(hit.topicGroup)) ||
          (hit.iterationGroup !== null && !SAFE_ID.test(hit.iterationGroup))) invalid();
    }
  }
  return byId;
}

function evaluateLlmWikiRetrievalQualityV3(
  input: LlmWikiQualityEvaluationInputV3,
): LlmWikiQualityEvaluationV3 {
  if (![input.corpusDigest, input.providerIdentityDigest, input.rankingPolicyDigest,
    input.semanticContentPolicyDigest, input.baselineIdentity.identityDigest,
    input.candidateIdentity.identityDigest].every((value) => DIGEST.test(value)) ||
      input.rankingPolicyDigest !== RETRIEVAL_RANKING_POLICY_V2.policyDigest ||
      input.semanticContentPolicyDigest !== SEMANTIC_CONTENT_POLICY_DIGEST ||
      input.baselineIdentity.mode !== 'graph' ||
      input.baselineIdentity.retrievalVersion !== 'approved-wiki-legacy-raw-v1' ||
      input.candidateIdentity.mode !== input.mode) invalid();
  const baseline = validateObservation(input.baseline);
  const candidate = validateObservation(input.candidate);
  const queryResults = Object.freeze(LLM_WIKI_QUALITY_CASES_V3.map((qualityCase) => {
    const baselineMetrics = metrics(
      baseline.get(qualityCase.queryId) as LlmWikiQualityObservationV3,
      qualityCase,
    );
    const candidateObservation = candidate.get(qualityCase.queryId) as LlmWikiQualityObservationV3;
    const candidateMetrics = metrics(candidateObservation, qualityCase);
    const firstThree = candidateObservation.hits.slice(0, 3);
    const projectStructurePassed = qualityCase.queryId !== 'project-structure' ||
      (firstThree.some((hit) => hit.lifecycle === 'current' &&
        relevant(hit, qualityCase) &&
        (hit.authority === 'canonical' || hit.authority === 'supporting') &&
        (hit.evidenceKind === 'overview' || hit.evidenceKind === 'architecture')) &&
        firstThree.every((hit) => !hit.pageId.includes('gate-a-intake')));
    const sanitizerPassed = qualityCase.queryId !== 'secret-sanitizer' ||
      firstThree.some((hit) => hit.lifecycle === 'current' &&
        relevant(hit, qualityCase) &&
        (hit.evidenceKind === 'implementation' || hit.evidenceKind === 'verification'));
    const currentOrderPassed = qualityCase.intent !== 'current' ||
      !candidateObservation.hits.some((hit, index, hits) =>
        (hit.lifecycle === 'draft' || hit.lifecycle === 'superseded') && relevant(hit, qualityCase) &&
        hits.slice(index + 1).some((later) => later.lifecycle === 'current' &&
          relevant(later, qualityCase)));
    return Object.freeze({
      baseline: baselineMetrics,
      candidate: candidateMetrics,
      intent: qualityCase.intent,
      passed: candidateMetrics.recallAt5 > 0 &&
        candidateMetrics.recallAt5 >= baselineMetrics.recallAt5 &&
        (qualityCase.intent === 'historical' ||
          (candidateMetrics.contextUtf8Bytes <= baselineMetrics.contextUtf8Bytes &&
            candidateMetrics.providerTokenCount <= baselineMetrics.providerTokenCount)) &&
        projectStructurePassed && sanitizerPassed && currentOrderPassed,
      queryId: qualityCase.queryId,
    });
  }));
  const baselineAggregate = aggregate(queryResults.map((result) => result.baseline));
  const candidateAggregate = aggregate(queryResults.map((result) => result.candidate));
  const currentResults = queryResults.filter((result) => result.intent === 'current');
  const currentBaseline = aggregate(currentResults.map((result) => result.baseline));
  const currentCandidate = aggregate(currentResults.map((result) => result.candidate));
  const overallPassed = queryResults.every((result) => result.passed) &&
    currentCandidate.mrr > currentBaseline.mrr &&
    currentCandidate.contextUtf8Bytes < currentBaseline.contextUtf8Bytes &&
    currentCandidate.providerTokenCount < currentBaseline.providerTokenCount &&
    candidateAggregate.duplicateHitRatio < baselineAggregate.duplicateHitRatio;
  return Object.freeze({
    aggregate: Object.freeze({ baseline: baselineAggregate, candidate: candidateAggregate }),
    baselineIdentity: input.baselineIdentity,
    candidateIdentity: input.candidateIdentity,
    corpusDigest: input.corpusDigest,
    evaluationPolicyDigest: LLM_WIKI_RETRIEVAL_EVALUATION_POLICY_DIGEST,
    mode: input.mode,
    overallPassed,
    providerIdentityDigest: input.providerIdentityDigest,
    queryCount: 8,
    queryResults,
    rankingPolicyDigest: input.rankingPolicyDigest,
    schemaVersion: LLM_WIKI_RETRIEVAL_EVALUATION_SCHEMA_VERSION,
    semanticContentPolicyDigest: input.semanticContentPolicyDigest,
  });
}

function representativeMeaning(
  signals: readonly ApprovedWikiMeaningSignalV1[],
): Readonly<{
  readonly authority: SourceDocumentAuthority;
  readonly evidenceKind: SourceEvidenceKind;
  readonly iterationGroup: string | null;
  readonly lifecycle: SourceDocumentLifecycle;
  readonly topicGroup: string | null;
}> {
  const unique = <T>(values: readonly T[]): T | undefined => {
    const distinct = [...new Set(values)];
    return distinct.length === 1 ? distinct[0] : undefined;
  };
  return Object.freeze({
    authority: unique(signals.map((signal) => signal.authority)) ?? 'unknown',
    evidenceKind: unique(signals.map((signal) => signal.evidenceKind)) ?? 'other',
    iterationGroup: unique(signals.map((signal) => signal.iterationGroup)) ?? null,
    lifecycle: unique(signals.map((signal) => signal.lifecycle)) ?? 'unknown',
    topicGroup: unique(signals.map((signal) => signal.topicGroup)) ?? null,
  });
}

async function observeLocators(
  input: LlmWikiQualityEvaluationRunInputV3,
  qualityCase: LlmWikiQualityCaseV3,
  locators: readonly HierarchicalRetrievalLocatorV1[],
  contextKind: 'raw' | 'semantic',
  identity: { value: `sha256:${string}` | null },
): Promise<LlmWikiQualityObservationV3> {
  const pages = new Map(input.corpus.pages.map((page) => [page.pageId, page]));
  const selected = locators.map((locator) => {
    if (locator.projectId !== input.projectId) invalid();
    const page = pages.get(locator.pageId);
    const section = page?.sections.find((candidate) =>
      candidate.sectionId === locator.sectionId);
    if (page === undefined || section === undefined ||
        locator.citationIds.some((citationId) => !section.citationLocators.some((candidate) =>
          candidate.citationId === citationId)) ||
        locator.sourceIds.some((sourceId) => !section.citationLocators.some((candidate) =>
          candidate.sourceId === sourceId))) invalid();
    const context = contextKind === 'semantic'
      ? section.semanticText ?? section.body
      : section.body;
    const meaning = representativeMeaning(section.meaningSignals ?? page.meaningSignals ?? []);
    const searchable = [
      page.pageId,
      page.title,
      page.summary,
      context,
      meaning.topicGroup ?? '',
      meaning.iterationGroup ?? '',
    ].join('\n').normalize('NFC').toLowerCase();
    return Object.freeze({
      context,
      expectedPageLabelMatched: qualityCase.expectedPageLabels.some((label) =>
        hasExpectedLabel(searchable, label)),
      meaning,
      pageId: page.pageId,
    });
  });
  if (selected.length === 0) {
    return Object.freeze({ hits: Object.freeze([]), queryId: qualityCase.queryId });
  }
  const tokenResult = await input.provider.countDocumentTokens(
    Object.freeze(selected.map((item) => item.context)),
  );
  if (tokenResult.egress !== 'none' || tokenResult.providerUsed !== 'local-in-process' ||
      tokenResult.maximumTokens !== 512 || tokenResult.tokenCounts.length !== selected.length ||
      tokenResult.tokenCounts.some((count) => !Number.isSafeInteger(count) || count < 1) ||
      (identity.value !== null && identity.value !== tokenResult.identity.identityDigest)) invalid();
  identity.value = tokenResult.identity.identityDigest;
  return Object.freeze({
    hits: Object.freeze(selected.map((item, index) => Object.freeze({
      authority: item.meaning.authority,
      contextUtf8Bytes: Buffer.byteLength(item.context, 'utf8'),
      evidenceKind: item.meaning.evidenceKind,
      expectedPageLabelMatched: item.expectedPageLabelMatched,
      iterationGroup: item.meaning.iterationGroup,
      lifecycle: item.meaning.lifecycle,
      pageId: item.pageId,
      providerTokenCount: tokenResult.tokenCounts[index] ?? invalid(),
      topicGroup: item.meaning.topicGroup,
    }))),
    queryId: qualityCase.queryId,
  });
}

function validateCandidateMode(
  mode: LocalWikiRetrievalMode,
  result: Awaited<ReturnType<LocalWikiRetrievalPortV3['search']>>,
): void {
  const expected = mode === 'graph'
    ? Object.freeze({ channels: ['lexical', 'graph'], effectiveMode: 'lexical-graph', semantic: false })
    : mode === 'hybrid'
      ? Object.freeze({
          channels: ['lexical', 'graph', 'semantic'], effectiveMode: 'hybrid', semantic: true,
        })
      : mode === 'lexical'
        ? Object.freeze({ channels: ['lexical'], effectiveMode: 'lexical', semantic: false })
        : Object.freeze({ channels: ['semantic'], effectiveMode: 'semantic', semantic: true });
  const identity = result.identity;
  const hasSemanticIdentity = identity.embeddingIdentityDigest !== null &&
    identity.indexGenerationId !== null && identity.indexManifestDigest !== null &&
    DIGEST.test(identity.embeddingIdentityDigest) && DIGEST.test(identity.indexManifestDigest) &&
    GENERATION_ID.test(identity.indexGenerationId);
  const hasNoSemanticIdentity = identity.embeddingIdentityDigest === null &&
    identity.indexGenerationId === null && identity.indexManifestDigest === null;
  const expectsFusion = mode === 'graph' || mode === 'hybrid';
  if (result.effectiveMode !== expected.effectiveMode || result.fallback !== null ||
      serializeCanonicalJson(result.effectiveChannels) !==
        serializeCanonicalJson(expected.channels) || result.egress !== 'none' ||
      result.providerUsed !== (expected.semantic ? 'local-in-process' : 'none') ||
      (expected.semantic ? !hasSemanticIdentity : !hasNoSemanticIdentity) ||
      (expectsFusion
        ? serializeCanonicalJson(result.fusionPolicy) !==
          serializeCanonicalJson(RETRIEVAL_FUSION_POLICY_V1)
        : result.fusionPolicy !== null)) invalid();
  for (const [index, hit] of result.hits.entries()) {
    if (!CHUNK_ID.test(hit.chunkId) || hit.rank !== index + 1 ||
        !Number.isFinite(hit.baseScore) || !Number.isFinite(hit.finalScore) ||
        !Number.isFinite(hit.score) || hit.locator.projectId !== result.projectId ||
        !SAFE_ID.test(hit.locator.pageId) || !SAFE_ID.test(hit.locator.sectionId) ||
        !validCanonicalIds(hit.locator.citationIds) ||
        !validCanonicalIds(hit.locator.sourceIds) ||
        hit.channels.length < 1 || hit.channels.some((channel) =>
          !Number.isFinite(channel.contribution) || !Number.isFinite(channel.score) ||
          !Number.isSafeInteger(channel.rank) || channel.rank < 1)) invalid();
  }
}

export async function runLlmWikiRetrievalQualityV3(
  input: LlmWikiQualityEvaluationRunInputV3,
): Promise<LlmWikiQualityEvaluationV3> {
  if (input.projectId !== input.corpus.projectId) invalid();
  const mode = input.mode ?? 'hybrid';
  if (!['graph', 'hybrid', 'lexical', 'semantic'].includes(mode)) invalid();
  const baselinePort = createApprovedWikiLegacyRetrieval(input.corpus, input.projectId);
  const baseline: LlmWikiQualityObservationV3[] = [];
  const candidate: LlmWikiQualityObservationV3[] = [];
  const identity: { value: `sha256:${string}` | null } = { value: null };
  const candidateIdentityDigests = new Set<string>();
  const candidateSemanticIdentities = new Set<string>();
  let candidateRetrievalIdentity:
    Awaited<ReturnType<LocalWikiRetrievalPortV3['search']>>['identity'] | null = null;
  for (const qualityCase of LLM_WIKI_QUALITY_CASES_V3) {
    const baselineResult = baselinePort.search({
      mode: 'graph',
      projectId: input.projectId,
      query: qualityCase.text,
    });
    const candidateResult = await input.candidate.search({
      intent: qualityCase.intent,
      mode,
      projectId: input.projectId,
      query: qualityCase.text,
      topK: qualityCase.topK,
    });
    if (candidateResult.schemaVersion !== RETRIEVAL_RESULT_V3_SCHEMA_VERSION ||
        candidateResult.projectId !== input.projectId ||
        candidateResult.requestedMode !== mode ||
        candidateResult.requestedIntent !== qualityCase.intent ||
        candidateResult.effectiveIntent !== qualityCase.intent ||
        serializeCanonicalJson(candidateResult.rankingPolicy) !==
          serializeCanonicalJson(RETRIEVAL_RANKING_POLICY_V2) ||
        candidateResult.hits.length > qualityCase.topK) invalid();
    validateCandidateMode(mode, candidateResult);
    const serializedCandidateIdentity = serializeCanonicalJson(candidateResult.identity);
    if (candidateRetrievalIdentity === null) candidateRetrievalIdentity = candidateResult.identity;
    else if (serializeCanonicalJson(candidateRetrievalIdentity) !== serializedCandidateIdentity) invalid();
    if (candidateResult.identity.embeddingIdentityDigest !== null) {
      candidateIdentityDigests.add(candidateResult.identity.embeddingIdentityDigest);
      candidateSemanticIdentities.add(serializeCanonicalJson(candidateResult.identity));
    }
    baseline.push(await observeLocators(
      input,
      qualityCase,
      baselineResult.hits.slice(0, qualityCase.topK).map((hit) => hit.locator),
      'raw',
      identity,
    ));
    candidate.push(await observeLocators(
      input,
      qualityCase,
      candidateResult.hits.map((hit) => hit.locator),
      'semantic',
      identity,
    ));
  }
  const providerIdentityDigest = identity.value ?? input.provider.activeIdentity()?.identityDigest;
  if (providerIdentityDigest === null || providerIdentityDigest === undefined ||
      candidateRetrievalIdentity === null ||
      candidateIdentityDigests.size > 1 ||
      ((mode === 'hybrid' || mode === 'semantic') && candidateSemanticIdentities.size !== 1) ||
      ((mode === 'graph' || mode === 'lexical') && candidateSemanticIdentities.size !== 0) ||
      [...candidateIdentityDigests].some((digest) => digest !== providerIdentityDigest)) invalid();
  const baselineIdentityBasis = Object.freeze({
    corpusDigest: input.corpus.corpusDigest,
    mode: 'graph' as const,
    retrievalVersion: 'approved-wiki-legacy-raw-v1' as const,
  });
  const baselineIdentity = Object.freeze({
    identityDigest: evaluationDigest(baselineIdentityBasis),
    mode: baselineIdentityBasis.mode,
    retrievalVersion: baselineIdentityBasis.retrievalVersion,
  });
  const candidateIdentityBasis = Object.freeze({
    embeddingIdentityDigest: candidateRetrievalIdentity.embeddingIdentityDigest,
    indexGenerationId: candidateRetrievalIdentity.indexGenerationId,
    indexManifestDigest: candidateRetrievalIdentity.indexManifestDigest,
    mode,
  });
  const candidateIdentity = Object.freeze({
    ...candidateIdentityBasis,
    identityDigest: evaluationDigest(candidateIdentityBasis),
  });
  return evaluateLlmWikiRetrievalQualityV3(Object.freeze({
    baseline: Object.freeze(baseline),
    baselineIdentity,
    candidate: Object.freeze(candidate),
    candidateIdentity,
    corpusDigest: input.corpus.corpusDigest,
    mode,
    providerIdentityDigest,
    rankingPolicyDigest: RETRIEVAL_RANKING_POLICY_V2.policyDigest,
    semanticContentPolicyDigest: SEMANTIC_CONTENT_POLICY_DIGEST,
  }));
}
