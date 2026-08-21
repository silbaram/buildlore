import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import type { SearchCorpusPage } from '../compiler/corpus.js';

export const RETRIEVAL_STRATEGY_SCHEMA_VERSION = 'buildlore.retrieval-strategy.v1' as const;

export interface RetrievalStrategyIdentity {
  readonly caseFold: 'unicode-lowercase';
  readonly indexSchemaVersion: 1;
  readonly ngramSizes: readonly [2, 3];
  readonly normalization: 'NFC';
  readonly scoringVersion: 1;
  readonly strategyDigest: `sha256:${string}`;
  readonly tokenizerId: 'buildlore-unicode-hangul-ngram';
  readonly tokenizerVersion: 1;
}

export interface LexicalScoreComponents {
  readonly hangulBigramCoverage?: number;
  readonly hangulTrigramCoverage?: number;
  readonly weightedScore: number;
  readonly wordCoverage: number;
}

export type RetrievalMatchField = 'body' | 'summary' | 'title';
export type RetrievalMatchKind = 'hangul-bigram' | 'hangul-trigram' | 'unicode-word';

export interface MatchedRetrievalEvidence {
  readonly count: number;
  readonly field: RetrievalMatchField;
  readonly matchKind: RetrievalMatchKind;
}

export interface LexicalRankedPage {
  readonly lexicalRank: number;
  readonly matchedEvidence: readonly MatchedRetrievalEvidence[];
  readonly page: SearchCorpusPage;
  readonly score: number;
  readonly scoreComponents: LexicalScoreComponents;
}

export interface LexicalIndex {
  readonly corpusDigest: `sha256:${string}`;
  readonly indexBytes: number;
  readonly strategy: RetrievalStrategyIdentity;
  search(query: string): readonly LexicalRankedPage[];
}

export interface ReciprocalRankFusionItem {
  readonly combinedScore: number;
  readonly lexicalContribution: number;
  readonly lexicalRank?: number;
  readonly pageId: string;
  readonly semanticContribution: number;
  readonly semanticRank?: number;
}

interface LexicalFeatureSet {
  readonly bigrams: ReadonlySet<string>;
  readonly trigrams: ReadonlySet<string>;
  readonly words: ReadonlySet<string>;
}

interface IndexedPage {
  readonly fields: Readonly<Record<RetrievalMatchField, LexicalFeatureSet>>;
  readonly page: SearchCorpusPage;
  readonly searchable: LexicalFeatureSet;
}

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const WEIGHTS = Object.freeze({ bigrams: 0.3, trigrams: 0.2, words: 0.5 });
const FIELD_ORDER: readonly RetrievalMatchField[] = ['title', 'summary', 'body'];
const MAX_CORPUS_PAGES = 4_096;
const MAX_CORPUS_CHARS = 32 * 1_048_576;
const MAX_PAGE_BODY_CHARS = 1_048_576;
const MAX_SOURCE_REFS = 100;
const SAFE_PAGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const STRATEGY_WITHOUT_DIGEST = Object.freeze({
  caseFold: 'unicode-lowercase',
  indexSchemaVersion: 1,
  ngramSizes: Object.freeze([2, 3] as const),
  normalization: 'NFC',
  scoringVersion: 1,
  tokenizerId: 'buildlore-unicode-hangul-ngram',
  tokenizerVersion: 1,
} as const);

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export const RETRIEVAL_STRATEGY: RetrievalStrategyIdentity = Object.freeze({
  ...STRATEGY_WITHOUT_DIGEST,
  strategyDigest: sha256(serializeCanonicalJson(STRATEGY_WITHOUT_DIGEST)),
});

export function roundSix(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function fuseReciprocalRanks(
  lexicalPageIds: readonly string[],
  semanticPageIds: readonly string[],
): readonly ReciprocalRankFusionItem[] {
  const firstRanks = (pageIds: readonly string[]): ReadonlyMap<string, number> => {
    const ranks = new Map<string, number>();
    for (const pageId of pageIds) {
      if (!ranks.has(pageId)) ranks.set(pageId, ranks.size + 1);
    }
    return ranks;
  };
  const lexicalRanks = firstRanks(lexicalPageIds);
  const semanticRanks = firstRanks(semanticPageIds);
  const pageIds = new Set([...lexicalRanks.keys(), ...semanticRanks.keys()]);
  return [...pageIds].map((pageId) => {
    const lexicalRank = lexicalRanks.get(pageId);
    const semanticRank = semanticRanks.get(pageId);
    const lexicalContribution = roundSix(lexicalRank === undefined ? 0 : 0.5 / lexicalRank);
    const semanticContribution = roundSix(semanticRank === undefined ? 0 : 0.5 / semanticRank);
    return {
      combinedScore: roundSix(lexicalContribution + semanticContribution),
      lexicalContribution,
      ...(lexicalRank === undefined ? {} : { lexicalRank }),
      pageId,
      semanticContribution,
      ...(semanticRank === undefined ? {} : { semanticRank }),
    };
  }).sort((left, right) => right.combinedScore - left.combinedScore ||
    compareText(left.pageId, right.pageId));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function tokenizeLexical(value: string): readonly string[] {
  return [...value.normalize('NFC').toLowerCase().matchAll(TOKEN_PATTERN)]
    .map((match) => match[0]);
}

type HangulClass = 'L' | 'LV' | 'LVT' | 'T' | 'V';

function hangulClass(codePoint: number): HangulClass | null {
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) ||
      (codePoint >= 0xa960 && codePoint <= 0xa97c)) return 'L';
  if ((codePoint >= 0x1160 && codePoint <= 0x11a7) ||
      (codePoint >= 0xd7b0 && codePoint <= 0xd7c6)) return 'V';
  if ((codePoint >= 0x11a8 && codePoint <= 0x11ff) ||
      (codePoint >= 0xd7cb && codePoint <= 0xd7fb)) return 'T';
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) {
    return (codePoint - 0xac00) % 28 === 0 ? 'LV' : 'LVT';
  }
  return null;
}

function joinsHangul(previous: HangulClass, next: HangulClass): boolean {
  return (previous === 'L' && (next === 'L' || next === 'V' || next === 'LV' || next === 'LVT')) ||
    ((previous === 'LV' || previous === 'V') && (next === 'V' || next === 'T')) ||
    ((previous === 'LVT' || previous === 'T') && next === 'T');
}

function hangulRuns(word: string): readonly (readonly string[])[] {
  const runs: string[][] = [];
  let run: string[] = [];
  let cluster = '';
  let previous: HangulClass | null = null;
  const closeCluster = (): void => {
    if (cluster !== '') run.push(cluster);
    cluster = '';
    previous = null;
  };
  const closeRun = (): void => {
    closeCluster();
    if (run.length > 0) runs.push(run);
    run = [];
  };
  for (const value of word.normalize('NFC')) {
    const codePoint = value.codePointAt(0);
    const current = codePoint === undefined ? null : hangulClass(codePoint);
    if (current === null) {
      closeRun();
      continue;
    }
    if (previous !== null && !joinsHangul(previous, current)) closeCluster();
    cluster += value;
    previous = current;
  }
  closeRun();
  return runs;
}

export function hangulNgrams(word: string): {
  readonly bigrams: readonly string[];
  readonly trigrams: readonly string[];
} {
  const bigrams = new Set<string>();
  const trigrams = new Set<string>();
  for (const run of hangulRuns(word)) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      bigrams.add(`${run[index]}${run[index + 1]}`);
    }
    for (let index = 0; index + 2 < run.length; index += 1) {
      trigrams.add(`${run[index]}${run[index + 1]}${run[index + 2]}`);
    }
  }
  return {
    bigrams: [...bigrams].sort(compareText),
    trigrams: [...trigrams].sort(compareText),
  };
}

function featureSet(value: string): LexicalFeatureSet {
  const words = new Set(tokenizeLexical(value));
  const bigrams = new Set<string>();
  const trigrams = new Set<string>();
  for (const word of words) {
    const grams = hangulNgrams(word);
    for (const gram of grams.bigrams) bigrams.add(gram);
    for (const gram of grams.trigrams) trigrams.add(gram);
  }
  return { bigrams, trigrams, words };
}

function unionFeatureSets(values: readonly LexicalFeatureSet[]): LexicalFeatureSet {
  return {
    bigrams: new Set(values.flatMap((value) => [...value.bigrams])),
    trigrams: new Set(values.flatMap((value) => [...value.trigrams])),
    words: new Set(values.flatMap((value) => [...value.words])),
  };
}

function matchingCount(query: ReadonlySet<string>, document: ReadonlySet<string>): number {
  let count = 0;
  for (const value of query) if (document.has(value)) count += 1;
  return count;
}

function coverage(query: ReadonlySet<string>, document: ReadonlySet<string>): number | undefined {
  if (query.size === 0) return undefined;
  return roundSix(matchingCount(query, document) / query.size);
}

function scoreComponents(query: LexicalFeatureSet, page: LexicalFeatureSet): LexicalScoreComponents {
  const wordCoverage = coverage(query.words, page.words) ?? 0;
  const hangulBigramCoverage = coverage(query.bigrams, page.bigrams);
  const hangulTrigramCoverage = coverage(query.trigrams, page.trigrams);
  let numerator = WEIGHTS.words * wordCoverage;
  let denominator = WEIGHTS.words;
  if (hangulBigramCoverage !== undefined) {
    numerator += WEIGHTS.bigrams * hangulBigramCoverage;
    denominator += WEIGHTS.bigrams;
  }
  if (hangulTrigramCoverage !== undefined) {
    numerator += WEIGHTS.trigrams * hangulTrigramCoverage;
    denominator += WEIGHTS.trigrams;
  }
  return {
    ...(hangulBigramCoverage === undefined ? {} : { hangulBigramCoverage }),
    ...(hangulTrigramCoverage === undefined ? {} : { hangulTrigramCoverage }),
    weightedScore: roundSix(numerator / denominator),
    wordCoverage,
  };
}

function matchedEvidence(
  query: LexicalFeatureSet,
  fields: Readonly<Record<RetrievalMatchField, LexicalFeatureSet>>,
): readonly MatchedRetrievalEvidence[] {
  const result: MatchedRetrievalEvidence[] = [];
  const kinds = [
    ['unicode-word', 'words'],
    ['hangul-bigram', 'bigrams'],
    ['hangul-trigram', 'trigrams'],
  ] as const;
  for (const [matchKind, feature] of kinds) {
    for (const field of FIELD_ORDER) {
      const count = matchingCount(query[feature], fields[field][feature]);
      if (count > 0) result.push({ count, field, matchKind });
    }
  }
  return result;
}

function canonicalIndexBytes(pages: readonly IndexedPage[]): number {
  const postings = new Map<string, Set<string>>();
  for (const entry of pages) {
    for (const field of FIELD_ORDER) {
      for (const [kind, values] of [
        ['b', entry.fields[field].bigrams],
        ['t', entry.fields[field].trigrams],
        ['w', entry.fields[field].words],
      ] as const) {
        for (const value of values) {
          const key = `${field}:${kind}:${value}`;
          const ids = postings.get(key) ?? new Set<string>();
          ids.add(entry.page.pageId);
          postings.set(key, ids);
        }
      }
    }
  }
  const canonical = [...postings]
    .sort(([left], [right]) => compareText(left, right))
    .map(([feature, pageIds]) => ({ feature, pageIds: [...pageIds].sort(compareText) }));
  return Buffer.byteLength(serializeCanonicalJson(canonical), 'utf8');
}

function invalidCorpus(): never {
  throw new Error('RETRIEVAL_INDEX_CONTRACT_VIOLATION');
}

function safeText(value: unknown, maximum: number, allowWhitespace = false): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum ||
      value !== value.normalize('NFC')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && (!allowWhitespace || (code !== 9 && code !== 10))) ||
        (code >= 127 && code <= 159)) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function safeSourceRef(value: unknown): value is string {
  return safeText(value, 512) && !value.startsWith('/') && !value.startsWith('~') &&
    !value.includes('\\') && !/^[a-zA-Z]:/u.test(value) && !/^file:/iu.test(value) &&
    !/^https?:/iu.test(value) && !value.split('/').some((part) =>
      part === '' || part === '.' || part === '..');
}

function validatedPage(value: unknown): SearchCorpusPage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidCorpus();
  const page = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(page).sort();
  const expected = ['body', 'freshness', 'pageId', 'sourceRefs', 'summary', 'title'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      page.freshness !== 'fresh' || !safeText(page.pageId, 256) ||
      !SAFE_PAGE_ID.test(page.pageId) || !safeText(page.title, 512, true) ||
      !safeText(page.summary, 4_000, true) ||
      !safeText(page.body, MAX_PAGE_BODY_CHARS, true) || !Array.isArray(page.sourceRefs) ||
      page.sourceRefs.length < 1 || page.sourceRefs.length > MAX_SOURCE_REFS ||
      page.sourceRefs.some((reference) => !safeSourceRef(reference)) ||
      new Set(page.sourceRefs).size !== page.sourceRefs.length) invalidCorpus();
  return Object.freeze({
    body: page.body,
    freshness: 'fresh',
    pageId: page.pageId,
    sourceRefs: Object.freeze([...(page.sourceRefs as string[])].sort(compareText)),
    summary: page.summary,
    title: page.title,
  });
}

export function buildLexicalIndex(inputPages: readonly SearchCorpusPage[]): LexicalIndex {
  if (!Array.isArray(inputPages) || inputPages.length > MAX_CORPUS_PAGES) invalidCorpus();
  const seen = new Set<string>();
  const validated = inputPages.map((page) => validatedPage(page));
  const totalChars = validated.reduce((total, page) =>
    total + page.title.length + page.summary.length + page.body.length, 0);
  if (totalChars > MAX_CORPUS_CHARS) invalidCorpus();
  const pages = validated.sort((left, right) => compareText(left.pageId, right.pageId))
    .map((page): IndexedPage => {
      if (seen.has(page.pageId)) throw new Error('RETRIEVAL_INDEX_DUPLICATE_PAGE');
      seen.add(page.pageId);
      const fields = Object.freeze({
        body: featureSet(page.body),
        summary: featureSet(page.summary),
        title: featureSet(page.title),
      });
      return Object.freeze({ fields, page, searchable: unionFeatureSets(Object.values(fields)) });
    });
  const corpusDigest = sha256(serializeCanonicalJson(pages.map(({ page }) => ({
    body: page.body,
    pageId: page.pageId,
    sourceRefs: [...page.sourceRefs],
    summary: page.summary,
    title: page.title,
  }))));
  const indexBytes = canonicalIndexBytes(pages);
  return Object.freeze({
    corpusDigest,
    indexBytes,
    strategy: RETRIEVAL_STRATEGY,
    search(query: string): readonly LexicalRankedPage[] {
      const queryFeatures = featureSet(query);
      const ranked = pages.map((entry) => {
        const components = scoreComponents(queryFeatures, entry.searchable);
        return {
          matchedEvidence: matchedEvidence(queryFeatures, entry.fields),
          page: entry.page,
          score: components.weightedScore,
          scoreComponents: components,
        };
      }).filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score ||
          compareText(left.page.pageId, right.page.pageId));
      return ranked.map((entry, index) => Object.freeze({
        ...entry,
        lexicalRank: index + 1,
      }));
    },
  });
}
