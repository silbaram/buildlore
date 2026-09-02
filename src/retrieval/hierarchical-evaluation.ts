import {
  createApprovedWikiRetrieval,
  type ApprovedWikiRetrievalCorpusV1,
  type HierarchicalRetrievalLocatorV1,
  type HierarchicalRetrievalMode,
} from './hierarchical.js';
import { roundSix } from './strategy.js';

export const HIERARCHICAL_RETRIEVAL_GOLD_SCHEMA_VERSION =
  'buildlore.hierarchical-retrieval-gold.v2' as const;
export const HIERARCHICAL_RETRIEVAL_EVALUATION_SCHEMA_VERSION =
  'buildlore.hierarchical-retrieval-eval.v2' as const;

export type HierarchicalRetrievalQuestionKind = 'global' | 'local' | 'multi-hop' | 'zero-result';
export type HierarchicalRetrievalQuestionLanguage = 'code' | 'en' | 'ko';

export interface HierarchicalRetrievalGoldLocatorV1 {
  readonly citationIds: readonly string[];
  readonly pageId: string;
  readonly relevance: 1 | 2 | 3;
  readonly sectionId: string;
  readonly sourceIds: readonly string[];
}

export interface HierarchicalRetrievalGoldQuestionV1 {
  readonly answerAssertions: readonly string[];
  readonly expected: readonly HierarchicalRetrievalGoldLocatorV1[];
  readonly kind: HierarchicalRetrievalQuestionKind;
  readonly language: HierarchicalRetrievalQuestionLanguage;
  readonly queryId: string;
  readonly text: string;
}

export interface HierarchicalRetrievalGoldV1 {
  readonly corpus: ApprovedWikiRetrievalCorpusV1;
  readonly fixtureId: string;
  readonly questions: readonly HierarchicalRetrievalGoldQuestionV1[];
  readonly schemaVersion: typeof HIERARCHICAL_RETRIEVAL_GOLD_SCHEMA_VERSION;
}

export interface HierarchicalRetrievalMetricV1 {
  readonly answerEvidenceCompleteness: number;
  readonly answerEvidenceCorrectness: number;
  readonly citationPrecision: number;
  readonly citationRecall: number;
  readonly channelPassed: boolean;
  readonly mrr: number;
  readonly nDcgAt10: number;
  readonly positiveQueryCount: number;
  readonly recallAt5: number;
  readonly requestedMode: HierarchicalRetrievalMode | 'all';
  readonly zeroResultPassed: number;
  readonly zeroResultQueryCount: number;
}

export interface HierarchicalRetrievalQueryEvaluationV1 {
  readonly expected: readonly HierarchicalRetrievalGoldLocatorV1[];
  readonly locators: readonly HierarchicalRetrievalLocatorV1[];
  readonly queryId: string;
  readonly requestedMode: HierarchicalRetrievalMode;
  readonly zeroResultPassed: boolean | null;
}

export interface HierarchicalRetrievalEvaluationV1 {
  readonly fixtureId: string;
  readonly inputCorpusDigest: string;
  readonly metrics: readonly HierarchicalRetrievalMetricV1[];
  readonly modeExecutionCount: number;
  readonly overallPassed: boolean;
  readonly queryCount: number;
  readonly queryResults: readonly HierarchicalRetrievalQueryEvaluationV1[];
  readonly schemaVersion: typeof HIERARCHICAL_RETRIEVAL_EVALUATION_SCHEMA_VERSION;
  readonly thresholds: {
    readonly minimumAnswerEvidenceCompleteness: 0.85;
    readonly minimumAnswerEvidenceCorrectness: 0.8;
    readonly minimumCitationPrecision: 0.8;
    readonly minimumCitationRecall: 0.8;
    readonly minimumMrr: 0.7;
    readonly minimumRecallAt5: 0.85;
  };
}

const MINIMUM_QUESTION_COUNT = 15;
const MINIMUM_ANSWER_EVIDENCE_COMPLETENESS = 0.85;
const MINIMUM_ANSWER_EVIDENCE_CORRECTNESS = 0.8;
const MINIMUM_CITATION_PRECISION = 0.8;
const MINIMUM_CITATION_RECALL = 0.8;
const SAFE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

function invalid(): never {
  throw new Error('HIERARCHICAL_RETRIEVAL_EVAL_INVALID');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function locatorKey(locator: Pick<HierarchicalRetrievalLocatorV1, 'pageId' | 'sectionId'>): string {
  return `${locator.pageId}\u0000${locator.sectionId}`;
}

function validateFixture(fixture: HierarchicalRetrievalGoldV1): void {
  if (fixture.schemaVersion !== HIERARCHICAL_RETRIEVAL_GOLD_SCHEMA_VERSION ||
      !SAFE_ID.test(fixture.fixtureId) || fixture.questions.length < MINIMUM_QUESTION_COUNT ||
      fixture.questions.length > 500 || new Set(fixture.questions.map((question) =>
        question.queryId)).size !== fixture.questions.length ||
      new Set(fixture.questions.map((question) => question.language)).size !== 3 ||
      !fixture.questions.some((question) => question.kind === 'local') ||
      !fixture.questions.some((question) => question.kind === 'global') ||
      !fixture.questions.some((question) => question.kind === 'multi-hop') ||
      !fixture.questions.some((question) => question.kind === 'zero-result')) invalid();
  const pages = new Map(fixture.corpus.pages.map((page) => [page.pageId, page]));
  for (const question of fixture.questions) {
    if (!SAFE_ID.test(question.queryId) || question.text.length < 1 ||
        question.text.length > 8_192 ||
        !['code', 'en', 'ko'].includes(question.language) ||
        !['global', 'local', 'multi-hop', 'zero-result'].includes(question.kind) ||
        (question.kind === 'zero-result') !== (question.expected.length === 0) ||
        (question.expected.length === 0) !== (question.answerAssertions.length === 0) ||
        question.answerAssertions.length > 20 ||
        new Set(question.answerAssertions).size !== question.answerAssertions.length ||
        question.answerAssertions.some((assertion) => assertion.length < 1 ||
          assertion.length > 512 || assertion !== assertion.normalize('NFC'))) invalid();
    const expectedKeys = new Set<string>();
    for (const expected of question.expected) {
      const page = pages.get(expected.pageId);
      const section = page?.sections.find((item) => item.sectionId === expected.sectionId);
      const key = locatorKey(expected);
      if (page === undefined || section === undefined || expectedKeys.has(key) ||
          ![1, 2, 3].includes(expected.relevance) || expected.citationIds.length < 1 ||
          expected.sourceIds.length < 1 || expected.citationIds.some((citationId) =>
            !section.citationLocators.some((item) => item.citationId === citationId)) ||
          expected.sourceIds.some((sourceId) => !section.citationLocators.some((item) =>
            item.sourceId === sourceId))) invalid();
      expectedKeys.add(key);
    }
    const expectedBodies = question.expected.map((expected) => pages.get(expected.pageId)
      ?.sections.find((section) => section.sectionId === expected.sectionId)?.body
      .normalize('NFKC').toLocaleLowerCase('und') ?? '');
    if (question.answerAssertions.some((assertion) => !expectedBodies.some((body) =>
      body.includes(assertion.normalize('NFKC').toLocaleLowerCase('und'))))) invalid();
  }
}

function idealDcg(expected: readonly HierarchicalRetrievalGoldLocatorV1[]): number {
  return [...expected].sort((left, right) => right.relevance - left.relevance)
    .slice(0, 10).reduce((sum, item, index) =>
      sum + (2 ** item.relevance - 1) / Math.log2(index + 2), 0);
}

function metric(
  questions: readonly HierarchicalRetrievalGoldQuestionV1[],
  results: ReadonlyMap<string, readonly HierarchicalRetrievalLocatorV1[]>,
  corpus: ApprovedWikiRetrievalCorpusV1,
  requestedMode: HierarchicalRetrievalMode | 'all',
): HierarchicalRetrievalMetricV1 {
  const modes: readonly HierarchicalRetrievalMode[] = requestedMode === 'all'
    ? ['graph', 'lexical']
    : [requestedMode];
  const selected = questions.flatMap((question) => modes.map((mode) =>
    Object.freeze({ mode, question })));
  const positive = selected.filter(({ question }) => question.expected.length > 0);
  const zero = selected.filter(({ question }) => question.expected.length === 0);
  const recalls: number[] = [];
  const reciprocalRanks: number[] = [];
  const nDcgs: number[] = [];
  const citationPrecisions: number[] = [];
  const citationRecalls: number[] = [];
  const answerEvidenceCorrectness: number[] = [];
  const answerEvidenceCompleteness: number[] = [];
  const sectionBodyByKey = new Map(corpus.pages.flatMap((page) => page.sections.map((section) =>
    [locatorKey({ pageId: page.pageId, sectionId: section.sectionId }), section.body] as const)));
  for (const selectedQuestion of positive) {
    const { mode, question } = selectedQuestion;
    const expectedByKey = new Map(question.expected.map((item) => [locatorKey(item), item]));
    const ranked = results.get(`${question.queryId}\u0000${mode}`) ?? [];
    const topFive = ranked.slice(0, 5);
    const matched = new Set(topFive.map(locatorKey).filter((key) => expectedByKey.has(key)));
    recalls.push(matched.size / expectedByKey.size);
    const first = ranked.findIndex((item) => expectedByKey.has(locatorKey(item)));
    reciprocalRanks.push(first < 0 ? 0 : 1 / (first + 1));
    const dcg = ranked.slice(0, 10).reduce((sum, item, index) => {
      const relevance = expectedByKey.get(locatorKey(item))?.relevance ?? 0;
      return sum + (2 ** relevance - 1) / Math.log2(index + 2);
    }, 0);
    const ideal = idealDcg(question.expected);
    nDcgs.push(ideal === 0 ? 0 : dcg / ideal);
    const maximumRelevance = Math.max(...question.expected.map((item) => item.relevance));
    const expectedCitations = new Set(question.expected.filter((item) =>
      item.relevance === maximumRelevance).flatMap((item) => item.citationIds));
    const returnedCitations = new Set(ranked[0]?.citationIds ?? []);
    const citationMatches = [...returnedCitations].filter((id) => expectedCitations.has(id)).length;
    const citationPrecision = returnedCitations.size === 0 ? 0 :
      citationMatches / returnedCitations.size;
    citationPrecisions.push(citationPrecision);
    citationRecalls.push(citationMatches / expectedCitations.size);
    const normalizedAssertions = question.answerAssertions.map((assertion) =>
      assertion.normalize('NFKC').toLocaleLowerCase('und'));
    const assertionMatches = topFive.flatMap((locator) => {
      const key = locatorKey(locator);
      const body = (sectionBodyByKey.get(key) ?? '').normalize('NFKC').toLocaleLowerCase('und');
      return normalizedAssertions.filter((assertion) => body.includes(assertion)).map((assertion) =>
        Object.freeze({ assertion, expected: expectedByKey.has(key) }));
    });
    const matchedAssertions = new Set(assertionMatches.map((match) => match.assertion));
    answerEvidenceCompleteness.push(matchedAssertions.size / normalizedAssertions.length);
    answerEvidenceCorrectness.push(assertionMatches.length === 0 ? 0 :
      assertionMatches.filter((match) => match.expected).length / assertionMatches.length);
  }
  const average = (values: readonly number[]): number => roundSix(values.length === 0 ? 0 :
    values.reduce((sum, value) => sum + value, 0) / values.length);
  const recallAt5 = average(recalls);
  const mrr = average(reciprocalRanks);
  const zeroResultPassed = zero.filter(({ mode, question }) =>
    (results.get(`${question.queryId}\u0000${mode}`) ?? []).length === 0).length;
  return Object.freeze({
    answerEvidenceCompleteness: average(answerEvidenceCompleteness),
    answerEvidenceCorrectness: average(answerEvidenceCorrectness),
    citationPrecision: average(citationPrecisions),
    citationRecall: average(citationRecalls),
    channelPassed: recallAt5 >= 0.85 && mrr >= 0.7 && zeroResultPassed === zero.length,
    mrr,
    nDcgAt10: average(nDcgs),
    positiveQueryCount: positive.length,
    recallAt5,
    requestedMode,
    zeroResultPassed,
    zeroResultQueryCount: zero.length,
  });
}

export function evaluateHierarchicalRetrievalGold(
  fixture: HierarchicalRetrievalGoldV1,
): HierarchicalRetrievalEvaluationV1 {
  validateFixture(fixture);
  const retrieval = createApprovedWikiRetrieval(fixture.corpus, fixture.corpus.projectId);
  const queryResults = Object.freeze([...fixture.questions].sort((left, right) =>
    compareText(left.queryId, right.queryId)).flatMap((question) =>
    (['graph', 'lexical'] as const).map((mode) => {
      const result = retrieval.search({
        mode,
        projectId: fixture.corpus.projectId,
        query: question.text,
      });
      return Object.freeze({
        expected: question.expected,
        locators: Object.freeze(result.hits.map((hit) => hit.locator)),
        queryId: question.queryId,
        requestedMode: mode,
        zeroResultPassed: question.expected.length === 0 ? result.hits.length === 0 : null,
      });
    })));
  const resultMap = new Map(queryResults.map((result) =>
    [`${result.queryId}\u0000${result.requestedMode}`, result.locators]));
  const metrics = Object.freeze([
    metric(fixture.questions, resultMap, fixture.corpus, 'lexical'),
    metric(fixture.questions, resultMap, fixture.corpus, 'graph'),
    metric(fixture.questions, resultMap, fixture.corpus, 'all'),
  ]);
  const lexical = metrics.find((item) => item.requestedMode === 'lexical');
  const graph = metrics.find((item) => item.requestedMode === 'graph');
  const overall = metrics.find((item) => item.requestedMode === 'all');
  const overallPassed = lexical?.channelPassed === true && graph?.channelPassed === true &&
    overall !== undefined && overall.recallAt5 >= 0.85 &&
    overall.mrr >= 0.7 && overall.citationPrecision >= MINIMUM_CITATION_PRECISION &&
    overall.citationRecall >= MINIMUM_CITATION_RECALL &&
    overall.answerEvidenceCorrectness >= MINIMUM_ANSWER_EVIDENCE_CORRECTNESS &&
    overall.answerEvidenceCompleteness >= MINIMUM_ANSWER_EVIDENCE_COMPLETENESS &&
    overall.zeroResultPassed === overall.zeroResultQueryCount;
  return Object.freeze({
    fixtureId: fixture.fixtureId,
    inputCorpusDigest: fixture.corpus.corpusDigest,
    metrics,
    modeExecutionCount: queryResults.length,
    overallPassed,
    queryCount: fixture.questions.length,
    queryResults,
    schemaVersion: HIERARCHICAL_RETRIEVAL_EVALUATION_SCHEMA_VERSION,
    thresholds: Object.freeze({
      minimumAnswerEvidenceCompleteness: MINIMUM_ANSWER_EVIDENCE_COMPLETENESS,
      minimumAnswerEvidenceCorrectness: MINIMUM_ANSWER_EVIDENCE_CORRECTNESS,
      minimumCitationPrecision: MINIMUM_CITATION_PRECISION,
      minimumCitationRecall: MINIMUM_CITATION_RECALL,
      minimumMrr: 0.7 as const,
      minimumRecallAt5: 0.85 as const,
    }),
  });
}
