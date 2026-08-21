import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { parseEmbeddingIdentity } from '../../compiler/embedding-identity.js';
import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { isNodeError } from '../../knowledge/errors.js';
import { decodeUtf8Strict, parseJsonStrict } from '../../knowledge/strict-json.js';
import { RetrievalEvaluationError } from './errors.js';
import { retrievalMetricThresholds } from './metrics.js';
import { RETRIEVAL_STRATEGY } from '../strategy.js';
import {
  RECORDED_MORPHOLOGY_SCHEMA_VERSION,
  RECORDED_SEMANTIC_SCHEMA_VERSION,
  RETRIEVAL_CORPUS_SCHEMA_VERSION,
  RETRIEVAL_EVALUATION_SCHEMA_VERSION,
  type FrozenRetrievalCorpusV1,
  type FrozenRetrievalDocument,
  type RecordedMorphologyCandidateV1,
  type RecordedQueryRanking,
  type RecordedSemanticFixtureV1,
  type RelevanceJudgement,
  type RetrievalCategory,
  type RetrievalEvaluationReport,
  type RetrievalMetricResult,
  type RetrievalQueryFixture,
} from './types.js';

const MAX_FIXTURE_BYTES = 1024 * 1024;
const MAX_TEXT_LENGTH = 8_192;
const SAFE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SAFE_LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/u;
const SAFE_PAGE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SAFE_RUNNER_TEXT = /^[A-Za-z0-9._+-]+$/u;
const SAFE_SOURCE_REF = /^[a-z0-9._-]+@[a-z0-9._-]+:[A-Za-z0-9._/-]+$/u;
const KNOWN_CREDENTIAL = /(?:\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,255}\b|\bgithub_pat_[A-Za-z0-9_]{20,255}\b|\bnpm_[A-Za-z0-9]{20,255}\b|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,255}\b|\bAIza[A-Za-z0-9_-]{32,64}\b|\bxox[baprs]-[A-Za-z0-9-]{10,255}\b)/u;
const CATEGORIES: readonly RetrievalCategory[] = [
  'code-symbol-korean',
  'korean-exact',
  'korean-spacing-morphology',
  'korean-synonym',
  'korean-to-english',
];

function invalid(): never {
  throw new RetrievalEvaluationError('RETRIEVAL_EVAL_FIXTURE_INVALID');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeText(value: unknown, maximum = MAX_TEXT_LENGTH): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum ||
      value !== value.normalize('NFC')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function containsProhibitedFixtureValue(value: string): boolean {
  return /(?:https?|file):\/\//iu.test(value) ||
    /(?:^|[\s"'(=])(?:\/(?:[^/\s]+\/)*[^/\s]+|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+)/u
      .test(value) || KNOWN_CREDENTIAL.test(value) ||
    /(?:authorization\s*:|bearer\s+|(?:api[-_]?key|password|secret|token)\s*[=:])/iu
      .test(value);
}

function safeSourceRef(value: unknown): value is string {
  if (!safeText(value, 512) || !SAFE_SOURCE_REF.test(value) || value.includes('..') ||
      containsProhibitedFixtureValue(value)) return false;
  const separator = value.indexOf(':');
  const path = value.slice(separator + 1);
  return path !== '' && !path.startsWith('/') && !path.startsWith('~') &&
    !path.includes('\\') && !path.split('/').some((part) =>
      part === '' || part === '.' || part === '..');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue).sort((left, right) => {
      const leftValue = JSON.stringify(left);
      const rightValue = JSON.stringify(right);
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

export function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(serializeCanonicalJson(canonicalValue(value))).digest('hex')}`;
}

function parseDocument(value: unknown): FrozenRetrievalDocument {
  if (!isRecord(value) || !exactKeys(value, [
    'body', 'evidenceId', 'language', 'pageId', 'sourceRefs', 'summary', 'title',
  ]) || !safeText(value.evidenceId, 128) || !SAFE_ID.test(value.evidenceId) ||
      !safeText(value.language, 32) || !SAFE_LANGUAGE.test(value.language) ||
      !safeText(value.pageId, 256) || !SAFE_PAGE_ID.test(value.pageId) ||
      !safeText(value.title) || !safeText(value.summary) || !safeText(value.body) ||
      containsProhibitedFixtureValue(value.title) ||
      containsProhibitedFixtureValue(value.summary) ||
      containsProhibitedFixtureValue(value.body) ||
      !Array.isArray(value.sourceRefs) || value.sourceRefs.length < 1 ||
      value.sourceRefs.length > 16 || value.sourceRefs.some((ref) =>
        !safeSourceRef(ref)) ||
      new Set(value.sourceRefs).size !== value.sourceRefs.length) invalid();
  return Object.freeze({
    body: value.body,
    evidenceId: value.evidenceId,
    language: value.language,
    pageId: value.pageId,
    sourceRefs: Object.freeze([...new Set(value.sourceRefs as string[])].sort()),
    summary: value.summary,
    title: value.title,
  });
}

function isCategory(value: unknown): value is RetrievalCategory {
  return typeof value === 'string' && CATEGORIES.includes(value as RetrievalCategory);
}

function parseQuery(value: unknown): RetrievalQueryFixture {
  if (!isRecord(value) || !exactKeys(value, [
    'category', 'language', 'queryId', 'requestedMode', 'text',
  ]) || !isCategory(value.category) || !safeText(value.language, 32) ||
      !SAFE_LANGUAGE.test(value.language) || !safeText(value.queryId, 128) ||
      !SAFE_ID.test(value.queryId) || !safeText(value.text) ||
      containsProhibitedFixtureValue(value.text) ||
      (value.requestedMode !== 'lexical' && value.requestedMode !== 'semantic' &&
        value.requestedMode !== 'hybrid')) invalid();
  return Object.freeze(value as unknown as RetrievalQueryFixture);
}

function parseJudgement(value: unknown): RelevanceJudgement {
  if (!isRecord(value) || !exactKeys(value, ['evidenceId', 'queryId', 'relevance']) ||
      !safeText(value.evidenceId, 128) || !SAFE_ID.test(value.evidenceId) ||
      !safeText(value.queryId, 128) || !SAFE_ID.test(value.queryId) ||
      (value.relevance !== 1 && value.relevance !== 2 && value.relevance !== 3)) invalid();
  return Object.freeze(value as unknown as RelevanceJudgement);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function parseFrozenRetrievalCorpus(value: unknown): FrozenRetrievalCorpusV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'corpusVersion', 'documents', 'hashes', 'judgements', 'queries', 'schemaVersion',
  ]) || value.schemaVersion !== RETRIEVAL_CORPUS_SCHEMA_VERSION ||
      !safeText(value.corpusVersion, 64) || !SAFE_ID.test(value.corpusVersion) ||
      !Array.isArray(value.documents) || value.documents.length < 1 || value.documents.length > 100 ||
      !Array.isArray(value.queries) || value.queries.length < 1 || value.queries.length > 500 ||
      !Array.isArray(value.judgements) || value.judgements.length < 1 ||
      value.judgements.length > 2_000 || !isRecord(value.hashes) ||
      !exactKeys(value.hashes, ['corpusSha256', 'judgementSha256', 'querySha256'])) invalid();
  const documents = value.documents.map(parseDocument).sort((left, right) =>
    left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0);
  const queries = value.queries.map(parseQuery).sort((left, right) =>
    left.queryId < right.queryId ? -1 : left.queryId > right.queryId ? 1 : 0);
  const judgements = value.judgements.map(parseJudgement).sort((left, right) => {
    const leftKey = `${left.queryId}\u0000${left.evidenceId}\u0000${left.relevance}`;
    const rightKey = `${right.queryId}\u0000${right.evidenceId}\u0000${right.relevance}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (!unique(documents.map((document) => document.evidenceId)) ||
      !unique(documents.map((document) => document.pageId)) ||
      !unique(queries.map((query) => query.queryId)) ||
      new Set(queries.map((query) => query.category)).size !== CATEGORIES.length) invalid();
  const evidenceIds = new Set(documents.map((document) => document.evidenceId));
  const queryIds = new Set(queries.map((query) => query.queryId));
  const pairs = new Set<string>();
  const queriesWithJudgement = new Set<string>();
  for (const judgement of judgements) {
    const pair = `${judgement.queryId}\u0000${judgement.evidenceId}`;
    if (!queryIds.has(judgement.queryId) || !evidenceIds.has(judgement.evidenceId) ||
        pairs.has(pair)) invalid();
    pairs.add(pair);
    queriesWithJudgement.add(judgement.queryId);
  }
  if (queries.some((query) => !queriesWithJudgement.has(query.queryId))) invalid();
  const hashes = value.hashes;
  if (hashes.corpusSha256 !== canonicalDigest(documents) ||
      hashes.querySha256 !== canonicalDigest(queries) ||
      hashes.judgementSha256 !== canonicalDigest(judgements)) invalid();
  return Object.freeze({
    corpusVersion: value.corpusVersion,
    documents: Object.freeze(documents),
    hashes: Object.freeze({
      corpusSha256: hashes.corpusSha256,
      judgementSha256: hashes.judgementSha256,
      querySha256: hashes.querySha256,
    }),
    judgements: Object.freeze(judgements),
    queries: Object.freeze(queries),
    schemaVersion: RETRIEVAL_CORPUS_SCHEMA_VERSION,
  });
}

function parseRanking(
  value: unknown,
  queryIds: ReadonlySet<string>,
  pageIds: ReadonlySet<string>,
): RecordedQueryRanking {
  if (!isRecord(value) || !exactKeys(value, ['pageIds', 'queryId']) ||
      !safeText(value.queryId, 128) || !queryIds.has(value.queryId) ||
      !Array.isArray(value.pageIds) || value.pageIds.length > 100 ||
      value.pageIds.some((pageId) => typeof pageId !== 'string' || !pageIds.has(pageId)) ||
      !unique(value.pageIds as string[])) invalid();
  return Object.freeze({ pageIds: Object.freeze([...(value.pageIds as string[])]), queryId: value.queryId });
}

function parseRankings(
  value: unknown,
  corpus: FrozenRetrievalCorpusV1,
): readonly RecordedQueryRanking[] {
  if (!Array.isArray(value) || value.length !== corpus.queries.length) invalid();
  const queryIds = new Set(corpus.queries.map((query) => query.queryId));
  const pageIds = new Set(corpus.documents.map((document) => document.pageId));
  const rankings = value.map((ranking) => parseRanking(ranking, queryIds, pageIds));
  if (!unique(rankings.map((ranking) => ranking.queryId))) invalid();
  return Object.freeze(rankings.sort((left, right) =>
    left.queryId < right.queryId ? -1 : left.queryId > right.queryId ? 1 : 0));
}

export function parseRecordedSemanticFixture(
  value: unknown,
  corpus: FrozenRetrievalCorpusV1,
): RecordedSemanticFixtureV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'embeddingIdentity', 'fixtureId', 'rankings', 'schemaVersion',
  ]) || value.schemaVersion !== RECORDED_SEMANTIC_SCHEMA_VERSION ||
      !safeText(value.fixtureId, 128) || !SAFE_ID.test(value.fixtureId)) invalid();
  const embeddingIdentity = parseEmbeddingIdentity(value.embeddingIdentity);
  if (embeddingIdentity === null) invalid();
  return Object.freeze({
    embeddingIdentity,
    fixtureId: value.fixtureId,
    rankings: parseRankings(value.rankings, corpus),
    schemaVersion: RECORDED_SEMANTIC_SCHEMA_VERSION,
  });
}

export function parseRecordedMorphologyCandidate(
  value: unknown,
  corpus: FrozenRetrievalCorpusV1,
): RecordedMorphologyCandidateV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'candidateId', 'fixtureId', 'modelVersion', 'packageVersion', 'rankings', 'schemaVersion',
  ]) || value.schemaVersion !== RECORDED_MORPHOLOGY_SCHEMA_VERSION ||
      value.candidateId !== 'garu-ko' || !safeText(value.fixtureId, 128) ||
      !SAFE_ID.test(value.fixtureId) || !safeText(value.packageVersion, 64) ||
      !SAFE_ID.test(value.packageVersion) || !safeText(value.modelVersion, 64) ||
      !SAFE_ID.test(value.modelVersion)) invalid();
  return Object.freeze({
    candidateId: 'garu-ko',
    fixtureId: value.fixtureId,
    modelVersion: value.modelVersion,
    packageVersion: value.packageVersion,
    rankings: parseRankings(value.rankings, corpus),
    schemaVersion: RECORDED_MORPHOLOGY_SCHEMA_VERSION,
  });
}

export interface BoundedJsonReadOptions {
  readonly confinementRoot?: string;
}

function pathContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

export async function readBoundedJson(
  path: string,
  options: BoundedJsonReadOptions = {},
): Promise<unknown> {
  const resolvedPath = resolve(path);
  let expected: Awaited<ReturnType<typeof lstat>>;
  let canonicalPath: string;
  try {
    expected = await lstat(resolvedPath);
    canonicalPath = await realpath(resolvedPath);
    if (canonicalPath !== resolvedPath) invalid();
    if (options.confinementRoot !== undefined) {
      const resolvedRoot = resolve(options.confinementRoot);
      const [rootStatus, canonicalRoot] = await Promise.all([
        lstat(resolvedRoot),
        realpath(resolvedRoot),
      ]);
      if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() ||
          canonicalRoot !== resolvedRoot || !pathContained(canonicalRoot, canonicalPath)) invalid();
    }
  } catch (error) {
    if (error instanceof RetrievalEvaluationError) throw error;
    if (isNodeError(error)) invalid();
    throw error;
  }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > MAX_FIXTURE_BYTES) invalid();
  let handle;
  try {
    handle = await open(resolvedPath, 'r');
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
        actual.size > MAX_FIXTURE_BYTES) invalid();
    const raw = decodeUtf8Strict(await handle.readFile());
    if (await realpath(resolvedPath) !== canonicalPath) invalid();
    const value = parseJsonStrict(raw);
    if (raw !== serializeCanonicalJson(value)) invalid();
    return value;
  } catch (error) {
    if (error instanceof RetrievalEvaluationError) throw error;
    invalid();
  } finally {
    await handle?.close();
  }
}

function boundedUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function safeDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function parseMetric(value: unknown): RetrievalMetricResult {
  if (!isRecord(value) || !exactKeys(value, [
    'category', 'metricVersion', 'mode', 'mrr', 'passed', 'queryCount', 'recallAt5', 'thresholds',
  ]) || !isCategory(value.category) || value.metricVersion !== 1 ||
      (value.mode !== 'lexical' && value.mode !== 'semantic' && value.mode !== 'hybrid') ||
      !boundedUnit(value.mrr) || !boundedUnit(value.recallAt5) ||
      typeof value.passed !== 'boolean' || typeof value.queryCount !== 'number' ||
      !Number.isSafeInteger(value.queryCount) || value.queryCount < 1 || value.queryCount > 500 ||
      !isRecord(value.thresholds) || !exactKeys(value.thresholds, [
        'minimumMrr', 'minimumRecallAt5',
      ]) || (value.thresholds.minimumMrr !== null &&
        !boundedUnit(value.thresholds.minimumMrr)) ||
      (value.thresholds.minimumRecallAt5 !== null &&
        !boundedUnit(value.thresholds.minimumRecallAt5))) invalid();
  const expectedThresholds = retrievalMetricThresholds(value.category, value.mode);
  const expectedPassed = (expectedThresholds.minimumMrr === null ||
    value.mrr >= expectedThresholds.minimumMrr) &&
    (expectedThresholds.minimumRecallAt5 === null ||
      value.recallAt5 >= expectedThresholds.minimumRecallAt5);
  if (serializeCanonicalJson(value.thresholds) !== serializeCanonicalJson(expectedThresholds) ||
      value.passed !== expectedPassed) invalid();
  return Object.freeze({
    category: value.category,
    metricVersion: 1,
    mode: value.mode,
    mrr: value.mrr,
    passed: value.passed,
    queryCount: value.queryCount,
    recallAt5: value.recallAt5,
    thresholds: Object.freeze(expectedThresholds),
  });
}

function parseMetrics(value: unknown, expectedModes: readonly RetrievalMetricResult['mode'][]):
readonly RetrievalMetricResult[] {
  if (!Array.isArray(value) || value.length !== CATEGORIES.length * expectedModes.length) invalid();
  const metrics = value.map(parseMetric);
  const coordinates = metrics.map((metric) => `${metric.mode}:${metric.category}`);
  const expected = expectedModes.flatMap((mode) => CATEGORIES.map((category) => `${mode}:${category}`));
  if (!unique(coordinates) || expected.some((coordinate) => !coordinates.includes(coordinate))) invalid();
  return Object.freeze(metrics);
}

function safeReasonCodes(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 32 && value.every((reason) =>
    safeText(reason, 128) && SAFE_ID.test(reason)) && unique(value as string[]);
}

export function parseRetrievalEvaluationReport(value: unknown): RetrievalEvaluationReport {
  if (!isRecord(value) || !exactKeys(value, [
    'candidateComparisonPassed', 'candidates', 'embeddingFixtureIdentity', 'inputHashes', 'metrics',
    'morphologyFixtureIdentity', 'overallPassed', 'performance', 'regression', 'schemaVersion',
    'selectedStrategy', 'semanticFixtureId',
  ]) || value.schemaVersion !== RETRIEVAL_EVALUATION_SCHEMA_VERSION ||
      typeof value.candidateComparisonPassed !== 'boolean' ||
      typeof value.overallPassed !== 'boolean' || !Array.isArray(value.candidates) ||
      value.candidates.length !== 3 ||
      !isRecord(value.inputHashes) || !exactKeys(value.inputHashes, [
        'corpusSha256', 'judgementSha256', 'querySha256',
      ]) || !safeDigest(value.inputHashes.corpusSha256) ||
      !safeDigest(value.inputHashes.judgementSha256) || !safeDigest(value.inputHashes.querySha256) ||
      serializeCanonicalJson(value.selectedStrategy) !== serializeCanonicalJson(RETRIEVAL_STRATEGY) ||
      !safeText(value.semanticFixtureId, 128) || !SAFE_ID.test(value.semanticFixtureId) ||
      !isRecord(value.morphologyFixtureIdentity) ||
      !exactKeys(value.morphologyFixtureIdentity, [
        'fixtureId', 'modelVersion', 'packageVersion',
      ]) || !safeText(value.morphologyFixtureIdentity.fixtureId, 128) ||
      !SAFE_ID.test(value.morphologyFixtureIdentity.fixtureId) ||
      !safeText(value.morphologyFixtureIdentity.modelVersion, 64) ||
      !SAFE_ID.test(value.morphologyFixtureIdentity.modelVersion) ||
      !safeText(value.morphologyFixtureIdentity.packageVersion, 64) ||
      !SAFE_ID.test(value.morphologyFixtureIdentity.packageVersion)) invalid();
  const embeddingFixtureIdentity = parseEmbeddingIdentity(value.embeddingFixtureIdentity);
  if (embeddingFixtureIdentity === null) invalid();
  const candidateIds: string[] = [];
  let selectedCount = 0;
  let selectedMetrics: readonly RetrievalMetricResult[] | undefined;
  let v8Metrics: readonly RetrievalMetricResult[] | undefined;
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !exactKeys(candidate, [
      'candidateId', 'dependencyImpact', 'decision', 'deterministicOffline', 'identity',
      'indexBytes', 'indexBytesUnavailableReason', 'licenseId', 'metrics', 'reasonCodes',
      'sourceEvidenceIds',
    ]) || !safeText(candidate.candidateId, 128) || !SAFE_ID.test(candidate.candidateId) ||
        !safeText(candidate.identity, 256) || containsProhibitedFixtureValue(candidate.identity) ||
        (candidate.decision !== 'selected' && candidate.decision !== 'rejected' &&
          candidate.decision !== 'recorded-only') ||
        (candidate.dependencyImpact !== 'none' &&
          candidate.dependencyImpact !== 'deferred-wasm-model') ||
        typeof candidate.deterministicOffline !== 'boolean' ||
        (candidate.licenseId !== 'BuildLore-internal' && candidate.licenseId !== 'MIT') ||
        (candidate.indexBytes !== null && (typeof candidate.indexBytes !== 'number' ||
          !Number.isSafeInteger(candidate.indexBytes) || candidate.indexBytes < 0)) ||
        (candidate.indexBytesUnavailableReason !== null &&
          (!safeText(candidate.indexBytesUnavailableReason, 128) ||
            !SAFE_ID.test(candidate.indexBytesUnavailableReason))) ||
        (candidate.indexBytes === null) !== (candidate.indexBytesUnavailableReason !== null) ||
        !safeReasonCodes(candidate.reasonCodes) || !Array.isArray(candidate.sourceEvidenceIds) ||
        candidate.sourceEvidenceIds.length < 1 || candidate.sourceEvidenceIds.length > 16 ||
        candidate.sourceEvidenceIds.some((sourceId) =>
          typeof sourceId !== 'string' || !/^(?:LOCAL|WEB)-[0-9]+$/u.test(sourceId)) ||
        !unique(candidate.sourceEvidenceIds as string[])) {
      invalid();
    }
    const quality = parseMetrics(candidate.metrics, ['lexical']);
    candidateIds.push(candidate.candidateId);
    if (candidate.candidateId === 'v8-unicode-word') v8Metrics = quality;
    if (candidate.decision === 'selected') {
      selectedCount += 1;
      selectedMetrics = quality;
      if (candidate.candidateId !== RETRIEVAL_STRATEGY.tokenizerId ||
          candidate.identity !== RETRIEVAL_STRATEGY.strategyDigest ||
          candidate.indexBytes === null || candidate.dependencyImpact !== 'none' ||
          candidate.licenseId !== 'BuildLore-internal' || !candidate.deterministicOffline ||
          quality.some((metric) => !metric.passed)) invalid();
    }
  }
  if (!unique(candidateIds) || selectedCount !== 1 || !candidateIds.includes('v8-unicode-word') ||
      !candidateIds.includes(RETRIEVAL_STRATEGY.tokenizerId) || !candidateIds.includes('garu-ko') ||
      selectedMetrics === undefined || v8Metrics === undefined) invalid();
  const metrics = parseMetrics(value.metrics, ['lexical', 'semantic', 'hybrid']);
  const lexicalMetrics = metrics.filter((metric) => metric.mode === 'lexical');
  if (serializeCanonicalJson(selectedMetrics) !== serializeCanonicalJson(lexicalMetrics)) invalid();
  const selectedSpacing = selectedMetrics.find((metric) =>
    metric.category === 'korean-spacing-morphology');
  const v8Spacing = v8Metrics.find((metric) => metric.category === 'korean-spacing-morphology');
  const selectedCode = selectedMetrics.find((metric) => metric.category === 'code-symbol-korean');
  const comparisonEvidencePassed = selectedSpacing !== undefined && v8Spacing !== undefined &&
    selectedCode !== undefined && selectedSpacing.recallAt5 >= v8Spacing.recallAt5 &&
    selectedSpacing.mrr >= v8Spacing.mrr &&
    (selectedSpacing.recallAt5 > v8Spacing.recallAt5 || selectedSpacing.mrr > v8Spacing.mrr) &&
    selectedCode.recallAt5 === 1 &&
    metrics.filter((metric) => metric.mode === 'hybrid').every((metric) => metric.passed);
  if (value.candidateComparisonPassed !== comparisonEvidencePassed) invalid();
  if (!isRecord(value.regression) || !exactKeys(value.regression, [
    'compatible', 'passed', 'reasonCodes',
  ]) || typeof value.regression.compatible !== 'boolean' ||
      typeof value.regression.passed !== 'boolean' ||
      !safeReasonCodes(value.regression.reasonCodes) ||
      (value.regression.passed && (!value.regression.compatible ||
        value.regression.reasonCodes.length > 0)) ||
      (!value.regression.passed && value.regression.reasonCodes.length === 0) ||
      !isRecord(value.performance) || !exactKeys(value.performance, [
        'architecture', 'comparable', 'cpuModelClass', 'indexBytes', 'latencyMilliseconds',
        'logicalCpuCount', 'nodeVersion', 'operatingSystem', 'reasonCodes', 'sampleCount',
        'timerKind', 'warmupCount',
      ]) || !safeText(value.performance.architecture, 64) ||
      !SAFE_RUNNER_TEXT.test(value.performance.architecture) ||
      containsProhibitedFixtureValue(value.performance.architecture) ||
      typeof value.performance.comparable !== 'boolean' ||
      !safeDigest(value.performance.cpuModelClass) ||
      typeof value.performance.indexBytes !== 'number' ||
      !Number.isSafeInteger(value.performance.indexBytes) || value.performance.indexBytes < 0 ||
      typeof value.performance.logicalCpuCount !== 'number' ||
      !Number.isSafeInteger(value.performance.logicalCpuCount) ||
      value.performance.logicalCpuCount < 1 || value.performance.logicalCpuCount > 65_536 ||
      !safeText(value.performance.nodeVersion, 64) ||
      !SAFE_RUNNER_TEXT.test(value.performance.nodeVersion) ||
      containsProhibitedFixtureValue(value.performance.nodeVersion) ||
      !safeText(value.performance.operatingSystem, 64) ||
      !SAFE_RUNNER_TEXT.test(value.performance.operatingSystem) ||
      containsProhibitedFixtureValue(value.performance.operatingSystem) ||
      !safeReasonCodes(value.performance.reasonCodes) ||
      typeof value.performance.sampleCount !== 'number' ||
      !Number.isSafeInteger(value.performance.sampleCount) || value.performance.sampleCount < 1 ||
      value.performance.sampleCount > 100 ||
      (value.performance.timerKind !== 'injected' &&
        value.performance.timerKind !== 'performance-now') ||
      typeof value.performance.warmupCount !== 'number' ||
      !Number.isSafeInteger(value.performance.warmupCount) || value.performance.warmupCount < 0 ||
      value.performance.warmupCount > 100 ||
      value.performance.comparable !== (value.performance.reasonCodes.length === 0)) invalid();
  const latency = value.performance.latencyMilliseconds;
  if (latency !== null && (!isRecord(latency) || !exactKeys(latency, [
    'maximum', 'median', 'minimum',
  ]) || [latency.maximum, latency.median, latency.minimum].some((item) =>
    typeof item !== 'number' || !Number.isFinite(item) || item < 0) ||
      (latency.minimum as number) > (latency.median as number) ||
      (latency.median as number) > (latency.maximum as number))) invalid();
  if (latency === null && !value.performance.reasonCodes.includes('timing-samples-invalid')) invalid();
  const expectedOverall = metrics.every((metric) => metric.passed) &&
    value.candidateComparisonPassed && value.regression.passed;
  if (value.overallPassed !== expectedOverall) invalid();
  return Object.freeze({
    ...value,
    embeddingFixtureIdentity,
    metrics,
    selectedStrategy: RETRIEVAL_STRATEGY,
  }) as unknown as RetrievalEvaluationReport;
}
