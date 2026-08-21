import { roundSix } from '../strategy.js';
import type {
  FrozenRetrievalCorpusV1,
  RetrievalCategory,
  RetrievalMetricResult,
} from './types.js';

export type EvaluationRankings = ReadonlyMap<string, readonly string[]>;

const CATEGORY_ORDER: readonly RetrievalCategory[] = [
  'korean-exact',
  'korean-spacing-morphology',
  'korean-synonym',
  'korean-to-english',
  'code-symbol-korean',
];

export function retrievalMetricThresholds(
  category: RetrievalCategory,
  mode: RetrievalMetricResult['mode'],
): RetrievalMetricResult['thresholds'] {
  if (category === 'korean-exact' && mode === 'lexical') {
    return { minimumMrr: 0.75, minimumRecallAt5: 0.9 };
  }
  if (category === 'korean-synonym' && mode === 'semantic') {
    return { minimumMrr: null, minimumRecallAt5: 0.8 };
  }
  if (category === 'korean-to-english' && mode === 'semantic') {
    return { minimumMrr: null, minimumRecallAt5: 0.7 };
  }
  return { minimumMrr: null, minimumRecallAt5: null };
}

export function calculateMetrics(
  corpus: FrozenRetrievalCorpusV1,
  rankings: EvaluationRankings,
  mode: RetrievalMetricResult['mode'],
): readonly RetrievalMetricResult[] {
  const relevance = new Map<string, Set<string>>();
  const evidenceToPage = new Map(corpus.documents.map((document) => [
    document.evidenceId,
    document.pageId,
  ]));
  for (const judgement of corpus.judgements) {
    const relevant = relevance.get(judgement.queryId) ?? new Set<string>();
    const pageId = evidenceToPage.get(judgement.evidenceId);
    if (pageId !== undefined) relevant.add(pageId);
    relevance.set(judgement.queryId, relevant);
  }
  return CATEGORY_ORDER.map((category) => {
    const queries = corpus.queries.filter((query) => query.category === category);
    const recalls: number[] = [];
    const reciprocals: number[] = [];
    for (const query of queries) {
      const relevant = relevance.get(query.queryId) ?? new Set<string>();
      const ranked = rankings.get(query.queryId) ?? [];
      const topFive = ranked.slice(0, 5);
      const matched = topFive.filter((pageId) => relevant.has(pageId)).length;
      recalls.push(relevant.size === 0 ? 0 : matched / relevant.size);
      const first = ranked.findIndex((pageId) => relevant.has(pageId));
      reciprocals.push(first < 0 ? 0 : 1 / (first + 1));
    }
    const recallAt5 = roundSix(recalls.reduce((sum, value) => sum + value, 0) / queries.length);
    const mrr = roundSix(reciprocals.reduce((sum, value) => sum + value, 0) / queries.length);
    const required = retrievalMetricThresholds(category, mode);
    return Object.freeze({
      category,
      metricVersion: 1 as const,
      mode,
      mrr,
      passed: (required.minimumRecallAt5 === null || recallAt5 >= required.minimumRecallAt5) &&
        (required.minimumMrr === null || mrr >= required.minimumMrr),
      queryCount: queries.length,
      recallAt5,
      thresholds: required,
    });
  });
}
