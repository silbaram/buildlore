import type { SearchCorpusPage } from '../compiler/corpus.js';
import {
  buildLexicalIndex,
  tokenizeLexical,
  type LexicalRankedPage,
} from './strategy.js';

export { roundSix, type LexicalRankedPage } from './strategy.js';

export function queryTokens(query: string): readonly string[] {
  return [...new Set(tokenizeLexical(query))];
}

export function rankLexical(
  pages: readonly SearchCorpusPage[],
  _uniqueQueryTokens: readonly string[],
  query?: string,
): readonly LexicalRankedPage[] {
  return buildLexicalIndex(pages).search(query ?? _uniqueQueryTokens.join(' '));
}
