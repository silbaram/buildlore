import { describe, expect, it } from 'vitest';

import type { SearchCorpusPage } from '../src/compiler/corpus.js';
import {
  buildLexicalIndex,
  fuseReciprocalRanks,
  hangulNgrams,
  RETRIEVAL_STRATEGY,
  tokenizeLexical,
} from '../src/retrieval/index.js';

function page(pageId: string, body: string): SearchCorpusPage {
  return {
    body,
    freshness: 'fresh',
    pageId,
    sourceRefs: [`repo@v1:docs/${pageId.replace('/', '-')}.md`],
    summary: '검색 요약',
    title: pageId,
  };
}

describe('versioned Unicode and Hangul retrieval strategy', () => {
  it('[V9-V-01][V10-V-14] pins NFC Unicode word tokenization and strategy identity', () => {
    expect(tokenizeLexical('Cafe\u0301 USEState42 인증 인증')).toEqual([
      'café', 'usestate42', '인증', '인증',
    ]);
    expect(RETRIEVAL_STRATEGY).toEqual({
      caseFold: 'unicode-lowercase',
      indexSchemaVersion: 1,
      ngramSizes: [2, 3],
      normalization: 'NFC',
      scoringVersion: 1,
      strategyDigest: 'sha256:2a24df974ac503506ab9ecfd89bbd088e66a59cf4fef92228f1d6c474d90834c',
      tokenizerId: 'buildlore-unicode-hangul-ngram',
      tokenizerVersion: 1,
    });
  });

  it('[V9-V-02] applies Hangul GB6-GB8 clusters at every approved boundary', () => {
    expect(hangulNgrams('한글검색')).toEqual({
      bigrams: ['검색', '글검', '한글'],
      trigrams: ['글검색', '한글검'],
    });
    expect(hangulNgrams('한글')).toEqual(hangulNgrams('한글'));
    expect(hangulNgrams('한국 api 검색')).toEqual({
      bigrams: ['검색', '한국'],
      trigrams: [],
    });
    expect(hangulNgrams('한')).toEqual({ bigrams: [], trigrams: [] });
    expect(hangulNgrams('한글')).toEqual({ bigrams: ['한글'], trigrams: [] });
    expect(hangulNgrams('한글검')).toEqual({
      bigrams: ['글검', '한글'],
      trigrams: ['한글검'],
    });
    expect(hangulNgrams('한-글')).toEqual({ bigrams: [], trigrams: [] });
    expect(hangulNgrams('한')).toEqual({ bigrams: [], trigrams: [] });
  });

  it('[V9-V-03][V9-V-11] proves scoring, renormalization, rounding, and value-free evidence', () => {
    const index = buildLexicalIndex([
      page('guides/compact', '인증오류복구'),
      page('guides/spaced', '인증 오류 복구'),
      page('guides/other', '배포 절차'),
    ]);
    const result = index.search('인증오류복구');

    expect(result.map((entry) => [entry.page.pageId, entry.score])).toEqual([
      ['guides/compact', 1],
      ['guides/spaced', 0.18],
    ]);
    expect(result[1]?.scoreComponents).toEqual({
      hangulBigramCoverage: 0.6,
      hangulTrigramCoverage: 0,
      weightedScore: 0.18,
      wordCoverage: 0,
    });
    expect(result[1]?.matchedEvidence).toContainEqual({
      count: 3,
      field: 'body',
      matchKind: 'hangul-bigram',
    });
    expect(JSON.stringify(result[1]?.matchedEvidence)).not.toMatch(/인증|오류|복구/u);

    expect(buildLexicalIndex([page('guides/one', '한')]).search('한')[0]?.score).toBe(1);
    expect(buildLexicalIndex([page('guides/two', '인증')]).search('인증')[0]?.score).toBe(1);
    expect(buildLexicalIndex([page('guides/word', 'cache')]).search('cache')[0])
      .toMatchObject({
        score: 1,
        scoreComponents: { weightedScore: 1, wordCoverage: 1 },
      });
    const morphology = buildLexicalIndex([page('guides/deploy', '배포')]).search('배포하기')[0];
    expect(morphology).toMatchObject({
      scoreComponents: {
        hangulBigramCoverage: 0.333333,
        hangulTrigramCoverage: 0,
        wordCoverage: 0,
      },
    });
    expect(morphology?.score).toBe(0.1);
    expect(buildLexicalIndex([page('guides/none', '관측')]).search('배포')).toEqual([]);
  });

  it('[V9-V-04][V9-V-10][V10-V-08][V10-V-14] keeps ranking deterministic across environment and input order', () => {
    const pages = [page('guides/zeta', '검색 전략'), page('guides/alpha', '검색 전략')];
    const first = buildLexicalIndex(pages);
    const priorTimezone = process.env.TZ;
    const priorLocale = process.env.LC_ALL;
    let second: ReturnType<typeof buildLexicalIndex>;
    try {
      process.env.TZ = 'Pacific/Honolulu';
      process.env.LC_ALL = 'C';
      second = buildLexicalIndex([...pages].reverse());
    } finally {
      if (priorTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = priorTimezone;
      if (priorLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = priorLocale;
    }
    expect(first.corpusDigest).toBe(second.corpusDigest);
    expect(first.indexBytes).toBe(second.indexBytes);
    expect(first.search('검색').map((entry) => entry.page.pageId)).toEqual([
      'guides/alpha', 'guides/zeta',
    ]);
    expect(fuseReciprocalRanks(
      ['guides/alpha', 'guides/zeta'],
      ['guides/zeta', 'guides/other'],
    )).toEqual([
      {
        combinedScore: 0.75,
        lexicalContribution: 0.25,
        lexicalRank: 2,
        pageId: 'guides/zeta',
        semanticContribution: 0.5,
        semanticRank: 1,
      },
      {
        combinedScore: 0.5,
        lexicalContribution: 0.5,
        lexicalRank: 1,
        pageId: 'guides/alpha',
        semanticContribution: 0,
      },
      {
        combinedScore: 0.25,
        lexicalContribution: 0,
        pageId: 'guides/other',
        semanticContribution: 0.25,
        semanticRank: 2,
      },
    ]);

    expect(fuseReciprocalRanks(
      ['guides/alpha', 'guides/alpha', 'guides/zeta', 'guides/alpha'],
      [],
    )).toEqual([
      {
        combinedScore: 0.5,
        lexicalContribution: 0.5,
        lexicalRank: 1,
        pageId: 'guides/alpha',
        semanticContribution: 0,
      },
      {
        combinedScore: 0.25,
        lexicalContribution: 0.25,
        lexicalRank: 2,
        pageId: 'guides/zeta',
        semanticContribution: 0,
      },
    ]);
  });

  it('[V10-V-07][V10-V-12] rejects unsafe corpus before indexing without value echo', () => {
    const invalidPages = [
      { ...page('guides/safe', '검색'), pageId: '../escape' },
      { ...page('guides/safe', '검색'), sourceRefs: ['repo@v1:../../private'] },
      { ...page('guides/safe', '검색'), title: 'unsafe\u0000title' },
      { ...page('guides/safe', '검색'), freshness: 'stale' },
    ];
    for (const invalid of invalidPages) {
      expect(() => buildLexicalIndex([invalid as SearchCorpusPage])).toThrowError(
        'RETRIEVAL_INDEX_CONTRACT_VIOLATION',
      );
      try {
        buildLexicalIndex([invalid as SearchCorpusPage]);
      } catch (error) {
        expect(String(error)).not.toMatch(/escape|private|unsafe/u);
      }
    }
  });
});
