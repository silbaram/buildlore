import { createHash } from 'node:crypto';
import { arch, cpus, platform } from 'node:os';
import { performance } from 'node:perf_hooks';

import type { SearchCorpusPage } from '../../compiler/corpus.js';
import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import {
  buildLexicalIndex,
  fuseReciprocalRanks,
  RETRIEVAL_STRATEGY,
  roundSix,
  tokenizeLexical,
} from '../strategy.js';
import {
  parseFrozenRetrievalCorpus,
  parseRecordedMorphologyCandidate,
  parseRecordedSemanticFixture,
  parseRetrievalEvaluationReport,
} from './codec.js';
import { RetrievalEvaluationError } from './errors.js';
import { calculateMetrics, type EvaluationRankings } from './metrics.js';
import {
  RETRIEVAL_EVALUATION_SCHEMA_VERSION,
  type FrozenRetrievalCorpusV1,
  type RetrievalEvaluationPort,
  type RetrievalEvaluationReport,
  type RetrievalMetricResult,
} from './types.js';

export interface RetrievalEvaluationRuntime {
  readonly architecture?: string;
  readonly clock?: () => number;
  readonly cpuModelClass?: `sha256:${string}`;
  readonly logicalCpuCount?: number;
  readonly nodeVersion?: string;
  readonly operatingSystem?: string;
  readonly sampleCount?: number;
  readonly timerKind?: 'injected' | 'performance-now';
  readonly warmupCount?: number;
}

function pages(corpus: FrozenRetrievalCorpusV1): readonly SearchCorpusPage[] {
  return corpus.documents.map((document) => ({
    body: document.body,
    freshness: 'fresh',
    pageId: document.pageId,
    sourceRefs: document.sourceRefs,
    summary: document.summary,
    title: document.title,
  }));
}

function lexicalRankings(corpus: FrozenRetrievalCorpusV1): {
  readonly indexBytes: number;
  readonly rankings: EvaluationRankings;
} {
  const index = buildLexicalIndex(pages(corpus));
  return {
    indexBytes: index.indexBytes,
    rankings: new Map(corpus.queries.map((query) => [
      query.queryId,
      index.search(query.text).map((entry) => entry.page.pageId),
    ])),
  };
}

function v8Evaluation(corpus: FrozenRetrievalCorpusV1): {
  readonly indexBytes: number;
  readonly rankings: EvaluationRankings;
} {
  const corpusPages = pages(corpus);
  const rankings = new Map(corpus.queries.map((query) => {
    const queryWords = new Set(tokenizeLexical(query.text));
    const ranked = corpusPages.map((page) => {
      const documentWords = new Set(tokenizeLexical(`${page.title} ${page.summary} ${page.body}`));
      const matches = [...queryWords].filter((word) => documentWords.has(word)).length;
      return { pageId: page.pageId, score: matches / queryWords.size };
    }).filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score ||
        (left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0));
    return [query.queryId, ranked.map((entry) => entry.pageId)] as const;
  }));
  const postings = new Map<string, Set<string>>();
  for (const page of corpusPages) {
    for (const word of new Set(tokenizeLexical(`${page.title} ${page.summary} ${page.body}`))) {
      const pageIds = postings.get(word) ?? new Set<string>();
      pageIds.add(page.pageId);
      postings.set(word, pageIds);
    }
  }
  const canonical = [...postings]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([feature, pageIds]) => ({
      feature,
      pageIds: [...pageIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    }));
  return {
    indexBytes: Buffer.byteLength(serializeCanonicalJson(canonical), 'utf8'),
    rankings,
  };
}

function recordedRankings(
  rankings: readonly { readonly pageIds: readonly string[]; readonly queryId: string }[],
): EvaluationRankings {
  return new Map(rankings.map((ranking) => [ranking.queryId, ranking.pageIds]));
}

function hybridRankings(
  corpus: FrozenRetrievalCorpusV1,
  lexical: EvaluationRankings,
  semantic: EvaluationRankings,
): EvaluationRankings {
  return new Map(corpus.queries.map((query) => [
    query.queryId,
    fuseReciprocalRanks(
      lexical.get(query.queryId) ?? [],
      semantic.get(query.queryId) ?? [],
    ).map((entry) => entry.pageId),
  ]));
}

function metricKey(metric: RetrievalMetricResult): string {
  return `${metric.mode}:${metric.category}`;
}

function comparisonPassed(
  corpus: FrozenRetrievalCorpusV1,
  selected: EvaluationRankings,
  baseline: EvaluationRankings,
  selectedHybrid: EvaluationRankings,
  baselineHybrid: EvaluationRankings,
): boolean {
  const evidenceToPage = new Map(corpus.documents.map((document) => [
    document.evidenceId,
    document.pageId,
  ]));
  const relevant = new Map<string, Set<string>>();
  for (const judgement of corpus.judgements) {
    const pages = relevant.get(judgement.queryId) ?? new Set<string>();
    const pageId = evidenceToPage.get(judgement.evidenceId);
    if (pageId !== undefined) pages.add(pageId);
    relevant.set(judgement.queryId, pages);
  }
  const hit = (rankings: EvaluationRankings, queryId: string): boolean => {
    const expected = relevant.get(queryId) ?? new Set<string>();
    return (rankings.get(queryId) ?? []).slice(0, 5).some((pageId) => expected.has(pageId));
  };
  const spacing = corpus.queries.filter((query) =>
    query.category === 'korean-spacing-morphology');
  const improved = spacing.some((query) => !hit(baseline, query.queryId) &&
    hit(selected, query.queryId));
  const preserved = spacing.every((query) => !hit(baseline, query.queryId) ||
    hit(selected, query.queryId));
  const codeComplete = corpus.queries.filter((query) => query.category === 'code-symbol-korean')
    .every((query) => hit(selected, query.queryId));
  const currentHybridMetrics = calculateMetrics(corpus, selectedHybrid, 'hybrid');
  const baselineHybridMetrics = new Map(calculateMetrics(corpus, baselineHybrid, 'hybrid')
    .map((metric) => [metric.category, metric]));
  const hybridPreserved = currentHybridMetrics.every((metric) => {
    const previous = baselineHybridMetrics.get(metric.category);
    return previous !== undefined && metric.recallAt5 >= previous.recallAt5 &&
      metric.mrr >= previous.mrr;
  });
  return improved && preserved && codeComplete && hybridPreserved;
}

function regression(
  current: Omit<RetrievalEvaluationReport, 'overallPassed' | 'regression'>,
  baseline: RetrievalEvaluationReport | undefined,
): RetrievalEvaluationReport['regression'] {
  if (baseline === undefined) return { compatible: true, passed: true, reasonCodes: [] };
  if (JSON.stringify(current.inputHashes) !== JSON.stringify(baseline.inputHashes) ||
      current.selectedStrategy.strategyDigest !== baseline.selectedStrategy.strategyDigest ||
      current.semanticFixtureId !== baseline.semanticFixtureId ||
      JSON.stringify(current.morphologyFixtureIdentity) !==
        JSON.stringify(baseline.morphologyFixtureIdentity) ||
      current.embeddingFixtureIdentity.compatibilityDigest !==
        baseline.embeddingFixtureIdentity.compatibilityDigest) {
    return {
      compatible: false,
      passed: false,
      reasonCodes: ['evaluation-identity-incompatible'],
    };
  }
  const prior = new Map(baseline.metrics.map((metric) => [metricKey(metric), metric]));
  const dropped = current.metrics.some((metric) => {
    const previous = prior.get(metricKey(metric));
    return previous === undefined || metric.recallAt5 < previous.recallAt5 || metric.mrr < previous.mrr;
  });
  return dropped
    ? { compatible: true, passed: false, reasonCodes: ['quality-regression'] }
    : { compatible: true, passed: true, reasonCodes: [] };
}

function measurePerformance(
  corpus: FrozenRetrievalCorpusV1,
  indexBytes: number,
  runtime: RetrievalEvaluationRuntime,
  baseline: RetrievalEvaluationReport['performance'] | undefined,
): RetrievalEvaluationReport['performance'] {
  const clock = runtime.clock ?? (() => performance.now());
  const warmupCount = runtime.warmupCount ?? 2;
  const sampleCount = runtime.sampleCount ?? 5;
  if (!Number.isSafeInteger(warmupCount) || warmupCount < 0 || warmupCount > 100 ||
      !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 100 ||
      (runtime.logicalCpuCount !== undefined && (!Number.isSafeInteger(runtime.logicalCpuCount) ||
        runtime.logicalCpuCount < 1 || runtime.logicalCpuCount > 65_536))) {
    throw new RetrievalEvaluationError('RETRIEVAL_EVAL_FIXTURE_INVALID');
  }
  const query = corpus.queries[0]?.text ?? 'retrieval';
  const corpusPages = pages(corpus);
  for (let index = 0; index < warmupCount; index += 1) buildLexicalIndex(corpusPages).search(query);
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const started = clock();
    buildLexicalIndex(corpusPages).search(query);
    const finished = clock();
    const duration = finished - started;
    if (Number.isFinite(duration) && duration >= 0) samples.push(roundSix(duration));
  }
  samples.sort((left, right) => left - right);
  const cpuInfo = cpus();
  const cpuModelClass = runtime.cpuModelClass ?? `sha256:${createHash('sha256')
    .update(cpuInfo[0]?.model ?? 'unknown-cpu').digest('hex')}`;
  const identity = {
    architecture: runtime.architecture ?? arch(),
    cpuModelClass,
    logicalCpuCount: runtime.logicalCpuCount ?? Math.max(1, cpuInfo.length),
    nodeVersion: runtime.nodeVersion ?? process.version,
    operatingSystem: runtime.operatingSystem ?? platform(),
    sampleCount,
    timerKind: runtime.timerKind ?? (runtime.clock === undefined ? 'performance-now' : 'injected'),
    warmupCount,
  } as const;
  const reasonCodes: string[] = [];
  if (samples.length !== sampleCount) reasonCodes.push('timing-samples-invalid');
  if (baseline !== undefined) {
    const baselineIdentity = {
      architecture: baseline.architecture,
      cpuModelClass: baseline.cpuModelClass,
      logicalCpuCount: baseline.logicalCpuCount,
      nodeVersion: baseline.nodeVersion,
      operatingSystem: baseline.operatingSystem,
      sampleCount: baseline.sampleCount,
      timerKind: baseline.timerKind,
      warmupCount: baseline.warmupCount,
    };
    if (JSON.stringify(identity) !== JSON.stringify(baselineIdentity)) {
      reasonCodes.push('runner-identity-incompatible');
    }
    if (baseline.latencyMilliseconds === null) reasonCodes.push('baseline-timing-unavailable');
  }
  return {
    ...identity,
    comparable: reasonCodes.length === 0,
    indexBytes,
    latencyMilliseconds: samples.length === sampleCount
      ? {
          maximum: samples[samples.length - 1] ?? 0,
          median: samples[Math.floor(samples.length / 2)] ?? 0,
          minimum: samples[0] ?? 0,
        }
      : null,
    reasonCodes,
  };
}

export function createRetrievalEvaluation(
  runtime: RetrievalEvaluationRuntime = {},
): RetrievalEvaluationPort {
  return {
    evaluate(input): RetrievalEvaluationReport {
      const corpus = parseFrozenRetrievalCorpus(input.corpus);
      const semanticFixture = parseRecordedSemanticFixture(input.semantic, corpus);
      const morphologyFixture = parseRecordedMorphologyCandidate(input.morphology, corpus);
      const baseline = input.baseline === undefined
        ? undefined
        : parseRetrievalEvaluationReport(input.baseline);
      const selected = lexicalRankings(corpus);
      const v8 = v8Evaluation(corpus);
      const semantic = recordedRankings(semanticFixture.rankings);
      const morphology = recordedRankings(morphologyFixture.rankings);
      const hybrid = hybridRankings(corpus, selected.rankings, semantic);
      const baselineHybrid = hybridRankings(corpus, v8.rankings, semantic);
      const selectedMetrics = calculateMetrics(corpus, selected.rankings, 'lexical');
      const v8Metrics = calculateMetrics(corpus, v8.rankings, 'lexical');
      const metrics = [
        ...selectedMetrics,
        ...calculateMetrics(corpus, semantic, 'semantic'),
        ...calculateMetrics(corpus, hybrid, 'hybrid'),
      ];
      const morphologyMetrics = calculateMetrics(corpus, morphology, 'lexical');
      const candidateComparisonPassed = comparisonPassed(
        corpus,
        selected.rankings,
        v8.rankings,
        hybrid,
        baselineHybrid,
      );
      const performance = measurePerformance(
        corpus,
        selected.indexBytes,
        runtime,
        baseline?.performance,
      );
      const draft = {
        candidateComparisonPassed,
        candidates: [
          {
            candidateId: 'v8-unicode-word',
            dependencyImpact: 'none' as const,
            decision: 'rejected' as const,
            deterministicOffline: true,
            identity: 'buildlore-v8-unicode-word-v1',
            indexBytes: v8.indexBytes,
            indexBytesUnavailableReason: null,
            licenseId: 'BuildLore-internal' as const,
            metrics: v8Metrics,
            reasonCodes: ['spacing-morphology-recall-lower'],
            sourceEvidenceIds: ['LOCAL-2'],
          },
          {
            candidateId: 'buildlore-unicode-hangul-ngram',
            dependencyImpact: 'none' as const,
            decision: 'selected' as const,
            deterministicOffline: true,
            identity: RETRIEVAL_STRATEGY.strategyDigest,
            indexBytes: selected.indexBytes,
            indexBytesUnavailableReason: null,
            licenseId: 'BuildLore-internal' as const,
            metrics: selectedMetrics,
            reasonCodes: ['deterministic', 'offline', 'no-new-dependency', 'quality-gates-passed'],
            sourceEvidenceIds: ['LOCAL-4', 'WEB-3'],
          },
          {
            candidateId: 'garu-ko',
            dependencyImpact: 'deferred-wasm-model' as const,
            decision: 'recorded-only' as const,
            deterministicOffline: true,
            identity: `${morphologyFixture.packageVersion}/${morphologyFixture.modelVersion}`,
            indexBytes: null,
            indexBytesUnavailableReason: 'recorded-ranking-has-no-index-artifact',
            licenseId: 'MIT' as const,
            metrics: morphologyMetrics,
            reasonCodes: ['runtime-dependency-deferred', 'recorded-candidate-only'],
            sourceEvidenceIds: ['WEB-5'],
          },
        ],
        embeddingFixtureIdentity: semanticFixture.embeddingIdentity,
        inputHashes: corpus.hashes,
        metrics,
        morphologyFixtureIdentity: {
          fixtureId: morphologyFixture.fixtureId,
          modelVersion: morphologyFixture.modelVersion,
          packageVersion: morphologyFixture.packageVersion,
        },
        performance,
        schemaVersion: RETRIEVAL_EVALUATION_SCHEMA_VERSION,
        semanticFixtureId: semanticFixture.fixtureId,
        selectedStrategy: RETRIEVAL_STRATEGY,
      };
      const checkedRegression = regression(draft, baseline);
      const report = {
        ...draft,
        overallPassed: metrics.every((metric) => metric.passed) && candidateComparisonPassed &&
          checkedRegression.passed,
        regression: checkedRegression,
      };
      return parseRetrievalEvaluationReport(report);
    },
  };
}
