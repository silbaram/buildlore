import type { SearchCorpusPage } from '../compiler/corpus.js';

export interface LexicalRankedPage {
  readonly lexicalRank: number;
  readonly page: SearchCorpusPage;
  readonly score: number;
}

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

function tokens(value: string): readonly string[] {
  return [...value.normalize('NFC').toLowerCase().matchAll(TOKEN_PATTERN)]
    .map((match) => match[0]);
}

export function queryTokens(query: string): readonly string[] {
  return [...new Set(tokens(query))];
}

export function roundSix(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function rankLexical(
  pages: readonly SearchCorpusPage[],
  uniqueQueryTokens: readonly string[],
): readonly LexicalRankedPage[] {
  const ranked = pages.map((page) => {
    const searchable = new Set(tokens(`${page.title}\n${page.summary}\n${page.body}`));
    const matches = uniqueQueryTokens.filter((token) => searchable.has(token)).length;
    return { page, score: roundSix(matches / uniqueQueryTokens.length) };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.page.pageId.localeCompare(right.page.pageId));
  return ranked.map((item, index) => ({ ...item, lexicalRank: index + 1 }));
}
