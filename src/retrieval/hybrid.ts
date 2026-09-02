import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import {
  LocalEmbeddingError,
  type EmbeddingProviderPort,
  type LocalEmbeddingRecoveryAction,
} from './embedding/index.js';
import {
  createApprovedWikiRetrieval,
  type ApprovedWikiRetrievalCorpusV1,
  type HierarchicalRetrievalHitV1,
  type HierarchicalRetrievalLocatorV1,
} from './hierarchical.js';
import {
  RETRIEVAL_FUSION_POLICY_SCHEMA_VERSION,
  RETRIEVAL_RESULT_V2_SCHEMA_VERSION,
  LocalWikiRetrievalError,
  type LocalWikiRetrievalChannel,
  type LocalWikiRetrievalChannelScoreV2,
  type LocalWikiRetrievalFallbackReason,
  type LocalWikiRetrievalHitV2,
  type LocalWikiRetrievalMode,
  type LocalWikiRetrievalPortV2,
  type LocalWikiRetrievalRecoveryAction,
  type LocalWikiRetrievalRequestV2,
  type RetrievalFusionPolicyV1,
  type RetrievalResultV2,
} from './hybrid-types.js';
import type { LexicalScoreComponents, MatchedRetrievalEvidence } from './strategy.js';
import {
  SEMANTIC_INDEX_LIMITS,
  SemanticIndexError,
  type SemanticIndexManifestV1,
  type SemanticIndexSearchHitV1,
  type VectorIndexPort,
} from './vector-index/index.js';

const MAXIMUM_QUERY_UTF8_BYTES = 4_096;
const CHANNEL_ORDER: readonly LocalWikiRetrievalChannel[] = ['lexical', 'graph', 'semantic'];

const FUSION_POLICY_BASIS = Object.freeze({
  schemaVersion: RETRIEVAL_FUSION_POLICY_SCHEMA_VERSION,
  algorithm: 'reciprocal-rank-fusion' as const,
  algorithmVersion: 1 as const,
  rankConstant: 60 as const,
  channelWeights: Object.freeze({ graph: 1 as const, lexical: 1 as const, semantic: 1 as const }),
  tieBreak: Object.freeze(['pageId', 'sectionId', 'chunkId'] as const),
});

export const RETRIEVAL_FUSION_POLICY_V1: RetrievalFusionPolicyV1 = Object.freeze({
  ...FUSION_POLICY_BASIS,
  policyDigest: `sha256:${createHash('sha256').update(
    serializeCanonicalJson(FUSION_POLICY_BASIS),
  ).digest('hex')}`,
});

export interface CreateApprovedWikiHybridRetrievalOptions {
  readonly corpus: ApprovedWikiRetrievalCorpusV1;
  readonly projectId: string;
  readonly provider: EmbeddingProviderPort;
  readonly sanitizerPolicyDigest: `sha256:${string}`;
  readonly vectorIndex: VectorIndexPort;
}

interface SemanticSearch {
  readonly hits: readonly SemanticIndexSearchHitV1[];
  readonly manifest: SemanticIndexManifestV1;
}

interface Candidate {
  chunkId: string;
  readonly channels: Map<LocalWikiRetrievalChannel, Readonly<{
    readonly rank: number;
    readonly score: number;
  }>>;
  lexical?: LexicalScoreComponents;
  locator: HierarchicalRetrievalLocatorV1;
  matchedEvidence: readonly MatchedRetrievalEvidence[];
  title: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsUnsafeScalar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function containsSensitiveQueryMaterial(value: string): boolean {
  const suspectedCredential = /(?:\b(?:Bearer|Basic)[ \t]+|\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,255}\b|\bnpm_[A-Za-z0-9]{20,255}\b|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,255}\b|\bAIza[A-Za-z0-9_-]{32,64}\b|\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|COOKIE|PASSWORD|SECRET)[ \t]*=)/iu;
  const privateAbsolutePath = /(?:^|[\s"'(])(?:\/(?:home|root|users|private|mnt\/[a-z])\/|[a-z]:[\\/]|\\\\(?:wsl(?:\.localhost)?|[^\\\s]+)\\)/iu;
  return suspectedCredential.test(value) || privateAbsolutePath.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roundTwelve(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function syntheticChunkId(locator: HierarchicalRetrievalLocatorV1): string {
  return `chunk-${createHash('sha256').update(serializeCanonicalJson({
    pageId: locator.pageId,
    projectId: locator.projectId,
    sectionId: locator.sectionId,
  })).digest('hex')}`;
}

function candidateKey(locator: HierarchicalRetrievalLocatorV1): string {
  return `${locator.pageId}\u0000${locator.sectionId}`;
}

function sortedChannels(
  channels: Candidate['channels'],
  fused: boolean,
): readonly LocalWikiRetrievalChannelScoreV2[] {
  return Object.freeze(CHANNEL_ORDER.flatMap((channel) => {
    const value = channels.get(channel);
    if (value === undefined) return [];
    return [Object.freeze({
      channel,
      contribution: fused
        ? roundTwelve(1 / (RETRIEVAL_FUSION_POLICY_V1.rankConstant + value.rank))
        : value.score,
      rank: value.rank,
      score: value.score,
    })];
  }));
}

function fromBaselineHit(hit: HierarchicalRetrievalHitV1): Candidate {
  return {
    channels: new Map(hit.channels.map((channel) => [channel.channel, {
      rank: channel.rank,
      score: channel.score,
    }])),
    chunkId: syntheticChunkId(hit.locator),
    ...(hit.scoreComponents.lexical === undefined
      ? {}
      : { lexical: hit.scoreComponents.lexical }),
    locator: hit.locator,
    matchedEvidence: hit.matchedEvidence,
    title: hit.title,
  };
}

function baselineCandidates(hits: readonly HierarchicalRetrievalHitV1[]): Map<string, Candidate> {
  return new Map(hits.map((hit) => [candidateKey(hit.locator), fromBaselineHit(hit)]));
}

function semanticLocator(
  projectId: string,
  hit: SemanticIndexSearchHitV1,
): HierarchicalRetrievalLocatorV1 {
  return Object.freeze({
    citationIds: Object.freeze([...new Set(hit.citationLocators.map((item) => item.citationId))]
      .sort(compareText)),
    pageId: hit.pageId,
    projectId,
    sectionId: hit.sectionId,
    sourceIds: Object.freeze([...new Set(hit.citationLocators.map((item) => item.sourceId))]
      .sort(compareText)),
  });
}

function addSemanticCandidates(
  candidates: Map<string, Candidate>,
  hits: readonly SemanticIndexSearchHitV1[],
  corpus: ApprovedWikiRetrievalCorpusV1,
): void {
  const titles = new Map(corpus.pages.map((page) => [page.pageId, page.title]));
  const sections: ReadonlyMap<string, Readonly<{
    readonly citations: readonly Readonly<{ readonly citationId: string; readonly sourceId: string }>[];
    readonly title: string;
  }>> = new Map(corpus.pages.flatMap((page) => page.sections.map((section) => [
    `${page.pageId}\u0000${section.sectionId}`,
    Object.freeze({
      citations: Object.freeze([...section.citationLocators].sort((left, right) =>
        compareText(left.citationId, right.citationId) ||
        compareText(left.sourceId, right.sourceId))),
      title: page.title,
    }),
  ] as const)));
  for (const [index, hit] of hits.entries()) {
    const expected = sections.get(`${hit.pageId}\u0000${hit.sectionId}`);
    const actualCitations = [...hit.citationLocators].sort((left, right) =>
      compareText(left.citationId, right.citationId) || compareText(left.sourceId, right.sourceId));
    if (expected === undefined || !Number.isFinite(hit.score) ||
        hit.score < -1.00001 || hit.score > 1.00001 ||
        actualCitations.some((actual) => !expected.citations.some((canonical) =>
          actual.citationId === canonical.citationId && actual.sourceId === canonical.sourceId))) {
      throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONTRACT_INVALID');
    }
    const locator = semanticLocator(corpus.projectId, Object.freeze({
      ...hit,
      citationLocators: expected.citations,
    }));
    const key = candidateKey(locator);
    const prior = candidates.get(key);
    const semantic = Object.freeze({
      rank: index + 1,
      score: roundTwelve(Math.max(-1, Math.min(1, hit.score))),
    });
    if (prior === undefined) {
      const title = titles.get(hit.pageId) ?? expected.title;
      if (title === undefined) {
        throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONTRACT_INVALID');
      }
      candidates.set(key, {
        channels: new Map([['semantic', semantic]]),
        chunkId: hit.chunkId,
        locator,
        matchedEvidence: Object.freeze([]),
        title,
      });
    } else if (!prior.channels.has('semantic')) {
      prior.channels.set('semantic', semantic);
      prior.chunkId = hit.chunkId;
      prior.locator = locator;
    }
  }
}

function rankCandidates(
  candidates: ReadonlyMap<string, Candidate>,
  topK: number,
  fused: boolean,
): readonly LocalWikiRetrievalHitV2[] {
  const ranked = [...candidates.values()].map((candidate) => {
    const channels = sortedChannels(candidate.channels, fused);
    const score = fused
      ? roundTwelve(channels.reduce((sum, channel) => sum + channel.contribution, 0))
      : channels[0]?.score ?? 0;
    return { candidate, channels, score };
  }).sort((left, right) => right.score - left.score ||
    compareText(left.candidate.locator.pageId, right.candidate.locator.pageId) ||
    compareText(left.candidate.locator.sectionId, right.candidate.locator.sectionId) ||
    compareText(left.candidate.chunkId, right.candidate.chunkId));
  return Object.freeze(ranked.slice(0, topK).map(({ candidate, channels, score }, index) =>
    Object.freeze({
      channels,
      chunkId: candidate.chunkId,
      locator: candidate.locator,
      matchedEvidence: candidate.matchedEvidence,
      rank: index + 1,
      score,
      scoreComponents: Object.freeze({
        combinedScore: score,
        ...(candidate.lexical === undefined ? {} : { lexical: candidate.lexical }),
      }),
      scoreKind: fused ? 'rrf-v1' as const : candidate.channels.has('semantic')
        ? 'exact-cosine' as const
        : 'lexical-score' as const,
      title: candidate.title,
    })));
}

function validateRequest(
  request: LocalWikiRetrievalRequestV2,
  expectedProjectId: string,
): Readonly<Required<LocalWikiRetrievalRequestV2>> {
  let value: unknown;
  try {
    value = { ...request };
  } catch {
    throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID');
  }
  if (!isRecord(value) || typeof value.projectId !== 'string' ||
      typeof value.query !== 'string' || Object.keys(value).some((key) =>
        !['mode', 'projectId', 'query', 'topK'].includes(key))) {
    throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID');
  }
  if (value.projectId !== expectedProjectId) {
    throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_PROJECT_MISMATCH');
  }
  const mode = value.mode ?? 'hybrid';
  const topK = value.topK ?? 10;
  const normalized = value.query.normalize('NFC');
  if (typeof mode !== 'string' ||
      !['graph', 'hybrid', 'lexical', 'semantic'].includes(mode) ||
      normalized.trim() === '' || normalized !== value.query ||
      Buffer.byteLength(normalized, 'utf8') > MAXIMUM_QUERY_UTF8_BYTES ||
      !/[\p{L}\p{N}]/u.test(normalized) || containsUnsafeScalar(normalized) ||
      containsSensitiveQueryMaterial(normalized) ||
      typeof topK !== 'number' ||
      !Number.isSafeInteger(topK) ||
      topK < 1 || topK > SEMANTIC_INDEX_LIMITS.maximumQueryResults) {
    throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID');
  }
  return Object.freeze({
    mode: mode as LocalWikiRetrievalMode,
    projectId: expectedProjectId,
    query: normalized,
    topK,
  });
}

function indexRecovery(
  projectId: string,
  full = false,
): LocalWikiRetrievalRecoveryAction {
  return full
    ? Object.freeze(['index', 'rebuild', '--full', '--project', projectId] as const)
    : Object.freeze(['index', 'rebuild', '--project', projectId] as const);
}

function mapProviderRecovery(value: LocalEmbeddingRecoveryAction | null):
LocalWikiRetrievalRecoveryAction {
  return value ?? Object.freeze(['model', 'verify', '--profile', 'multilingual-e5-small']);
}

function semanticUnavailable(
  reasonCode: LocalWikiRetrievalFallbackReason,
  recoveryAction: LocalWikiRetrievalRecoveryAction,
): LocalWikiRetrievalError {
  return new LocalWikiRetrievalError('LOCAL_WIKI_SEMANTIC_UNAVAILABLE', {
    reasonCode,
    recoveryAction,
  });
}

function mapIndexError(error: unknown, projectId: string): LocalWikiRetrievalError {
  if (error instanceof LocalWikiRetrievalError) return error;
  const reasonCode = error instanceof SemanticIndexError &&
    error.code === 'SEMANTIC_INDEX_UNAVAILABLE'
    ? 'semantic-index-unavailable'
    : 'semantic-index-incompatible';
  return semanticUnavailable(
    reasonCode,
    indexRecovery(projectId, reasonCode === 'semantic-index-incompatible'),
  );
}

function mapProviderError(error: unknown, provider: EmbeddingProviderPort): LocalWikiRetrievalError {
  if (error instanceof LocalEmbeddingError &&
      error.code === 'LOCAL_EMBEDDING_CONFIG_INVALID') {
    return new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID');
  }
  let state;
  try {
    state = provider.readiness();
  } catch {
    return semanticUnavailable('embedding-provider-unavailable', mapProviderRecovery(null));
  }
  const reasonCode = error instanceof LocalEmbeddingError &&
    error.code === 'LOCAL_EMBEDDING_INCOMPATIBLE'
    ? 'embedding-provider-incompatible'
    : 'embedding-provider-unavailable';
  const recovery = state.state === 'incompatible' || state.state === 'unavailable'
    ? state.recoveryAction
    : null;
  return semanticUnavailable(reasonCode, mapProviderRecovery(recovery));
}

function manifestCompatibility(
  manifest: SemanticIndexManifestV1,
  options: CreateApprovedWikiHybridRetrievalOptions,
): void {
  if (manifest.projectId !== options.projectId ||
      manifest.corpusDigest !== options.corpus.corpusDigest ||
      manifest.wikiGenerationDigest !== options.corpus.generationDigest ||
      manifest.sanitizerPolicyDigest !== options.sanitizerPolicyDigest) {
    throw semanticUnavailable('semantic-index-stale', indexRecovery(options.projectId, true));
  }
}

async function semanticSearch(
  options: CreateApprovedWikiHybridRetrievalOptions,
  query: string,
  topK: number,
): Promise<SemanticSearch> {
  let capabilities;
  try {
    capabilities = options.provider.inspectCapabilities();
  } catch (error) {
    throw mapProviderError(error, options.provider);
  }
  if (capabilities.adapterKind !== 'transformers-js' || capabilities.device !== 'cpu' ||
      capabilities.providerUsed !== 'local-in-process' || capabilities.egress !== 'none' ||
      capabilities.networkAllowed || capabilities.maximumBatchSize !== 32 ||
      capabilities.maximumQueryUtf8Bytes !== 4_096) {
    throw semanticUnavailable(
      'embedding-provider-incompatible',
      mapProviderRecovery(null),
    );
  }
  let before;
  try {
    before = await options.vectorIndex.openActive(options.projectId);
  } catch (error) {
    throw mapIndexError(error, options.projectId);
  }
  manifestCompatibility(before.manifest, options);
  let identityBefore;
  try {
    identityBefore = options.provider.activeIdentity();
  } catch (error) {
    throw mapProviderError(error, options.provider);
  }
  if (identityBefore !== null &&
      identityBefore.identityDigest !== before.manifest.embeddingIdentity.identityDigest) {
    throw semanticUnavailable('embedding-identity-mismatch', mapProviderRecovery(null));
  }
  let embedding;
  try {
    embedding = await options.provider.embedQuery(query);
  } catch (error) {
    throw mapProviderError(error, options.provider);
  }
  if (embedding.truncated.length !== 1 || embedding.truncated[0] !== false) {
    throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID');
  }
  if (embedding.providerUsed !== 'local-in-process' || embedding.egress !== 'none' ||
      embedding.vectors.length !== 1 ||
      embedding.identity.identityDigest !== before.manifest.embeddingIdentity.identityDigest) {
    throw semanticUnavailable('embedding-identity-mismatch', mapProviderRecovery(null));
  }
  const queryVector = embedding.vectors[0];
  if (queryVector === undefined) {
    throw semanticUnavailable('embedding-provider-incompatible', mapProviderRecovery(null));
  }
  let searched;
  let after;
  try {
    searched = await options.vectorIndex.searchExact(
      options.projectId,
      queryVector,
      topK,
    );
    after = await options.vectorIndex.openActive(options.projectId);
  } catch (error) {
    throw mapIndexError(error, options.projectId);
  }
  let activeIdentity;
  try {
    activeIdentity = options.provider.activeIdentity();
  } catch (error) {
    throw mapProviderError(error, options.provider);
  }
  if (searched.manifestDigest !== before.manifest.manifestDigest ||
      after.manifest.manifestDigest !== before.manifest.manifestDigest ||
      activeIdentity?.identityDigest !== before.manifest.embeddingIdentity.identityDigest) {
    throw semanticUnavailable('embedding-identity-mismatch', mapProviderRecovery(null));
  }
  return Object.freeze({ hits: searched.hits, manifest: before.manifest });
}

function fallbackResult(
  projectId: string,
  topK: number,
  baselineHits: readonly HierarchicalRetrievalHitV1[],
  reasonCode: LocalWikiRetrievalFallbackReason,
): RetrievalResultV2 {
  return Object.freeze({
    schemaVersion: RETRIEVAL_RESULT_V2_SCHEMA_VERSION,
    projectId,
    requestedMode: 'hybrid',
    effectiveMode: 'lexical-graph',
    effectiveChannels: Object.freeze(['lexical', 'graph'] as const),
    fallback: Object.freeze({
      excludedChannel: 'semantic',
      fromMode: 'hybrid',
      reasonCode,
      toMode: 'lexical-graph',
    }),
    fusionPolicy: RETRIEVAL_FUSION_POLICY_V1,
    hits: rankCandidates(baselineCandidates(baselineHits), topK, true),
    identity: Object.freeze({
      embeddingIdentityDigest: null,
      indexGenerationId: null,
      indexManifestDigest: null,
    }),
    providerUsed: 'none',
    egress: 'none',
  });
}

function baselineResult(
  projectId: string,
  mode: 'graph' | 'lexical',
  topK: number,
  baselineHits: readonly HierarchicalRetrievalHitV1[],
): RetrievalResultV2 {
  const fused = mode === 'graph';
  return Object.freeze({
    schemaVersion: RETRIEVAL_RESULT_V2_SCHEMA_VERSION,
    projectId,
    requestedMode: mode,
    effectiveMode: mode === 'graph' ? 'lexical-graph' : 'lexical',
    effectiveChannels: mode === 'graph'
      ? Object.freeze(['lexical', 'graph'] as const)
      : Object.freeze(['lexical'] as const),
    fallback: null,
    fusionPolicy: fused ? RETRIEVAL_FUSION_POLICY_V1 : null,
    hits: rankCandidates(baselineCandidates(baselineHits), topK, fused),
    identity: Object.freeze({
      embeddingIdentityDigest: null,
      indexGenerationId: null,
      indexManifestDigest: null,
    }),
    providerUsed: 'none',
    egress: 'none',
  });
}

function semanticResult(
  options: CreateApprovedWikiHybridRetrievalOptions,
  requestedMode: 'hybrid' | 'semantic',
  topK: number,
  semantic: SemanticSearch,
  baselineHits: readonly HierarchicalRetrievalHitV1[],
): RetrievalResultV2 {
  const candidates = requestedMode === 'hybrid'
    ? baselineCandidates(baselineHits)
    : new Map<string, Candidate>();
  addSemanticCandidates(candidates, semantic.hits, options.corpus);
  const fused = requestedMode === 'hybrid';
  return Object.freeze({
    schemaVersion: RETRIEVAL_RESULT_V2_SCHEMA_VERSION,
    projectId: options.projectId,
    requestedMode,
    effectiveMode: requestedMode,
    effectiveChannels: requestedMode === 'hybrid'
      ? Object.freeze(['lexical', 'graph', 'semantic'] as const)
      : Object.freeze(['semantic'] as const),
    fallback: null,
    fusionPolicy: fused ? RETRIEVAL_FUSION_POLICY_V1 : null,
    hits: rankCandidates(candidates, topK, fused),
    identity: Object.freeze({
      embeddingIdentityDigest: semantic.manifest.embeddingIdentity.identityDigest,
      indexGenerationId: semantic.manifest.generationId,
      indexManifestDigest: semantic.manifest.manifestDigest,
    }),
    providerUsed: 'local-in-process',
    egress: 'none',
  });
}

export function createApprovedWikiHybridRetrieval(
  options: CreateApprovedWikiHybridRetrievalOptions,
): LocalWikiRetrievalPortV2 {
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.sanitizerPolicyDigest)) {
    throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID');
  }
  const baseline = createApprovedWikiRetrieval(options.corpus, options.projectId);
  return Object.freeze({
    async search(input: LocalWikiRetrievalRequestV2): Promise<RetrievalResultV2> {
      const request = validateRequest(input, options.projectId);
      if (request.mode === 'lexical' || request.mode === 'graph') {
        const result = baseline.search({
          mode: request.mode,
          projectId: request.projectId,
          query: request.query,
        });
        return baselineResult(options.projectId, request.mode, request.topK, result.hits);
      }
      const graph = baseline.search({
        mode: 'graph',
        projectId: request.projectId,
        query: request.query,
      });
      try {
        const semantic = await semanticSearch(options, request.query, request.topK);
        return semanticResult(options, request.mode, request.topK, semantic, graph.hits);
      } catch (error) {
        if (!(error instanceof LocalWikiRetrievalError) ||
            error.code !== 'LOCAL_WIKI_SEMANTIC_UNAVAILABLE') throw error;
        if (request.mode === 'semantic') throw error;
        const reasonCode = error.reasonCode;
        if (reasonCode === null) {
          throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONTRACT_INVALID');
        }
        return fallbackResult(options.projectId, request.topK, graph.hits, reasonCode);
      }
    },
  });
}
