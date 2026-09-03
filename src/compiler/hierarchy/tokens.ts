const KOREAN_SUFFIXES = Object.freeze([
  '에서', '으로', '까지', '부터', '처럼', '보다', '에게', '한테',
  '이다', '였다', '했다', '한다', '된다',
  '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만',
] as const);

function scalarLength(value: string): number {
  return [...value].length;
}

function englishTokenVariants(token: string): readonly string[] {
  if (!/^[a-z]+$/u.test(token) || token.length < 5) return Object.freeze([token]);
  const variants = new Set([token]);
  if (token.endsWith('ies') && token.length > 5) variants.add(`${token.slice(0, -3)}y`);
  if (token.endsWith('s') && !token.endsWith('ss')) variants.add(token.slice(0, -1));
  if (token.endsWith('al') && token.length > 6) variants.add(token.slice(0, -2));
  if (token.endsWith('ing') && token.length > 7) variants.add(token.slice(0, -3));
  if (token.endsWith('ed') && token.length > 6) variants.add(token.slice(0, -2));
  return Object.freeze([...variants]);
}

function koreanTokenVariants(token: string): readonly string[] {
  if (!/^\p{Script=Hangul}+$/u.test(token)) return Object.freeze([token]);
  for (const suffix of KOREAN_SUFFIXES) {
    if (!token.endsWith(suffix)) continue;
    const stem = token.slice(0, -suffix.length);
    if (scalarLength(stem) >= 2) return Object.freeze([token, stem]);
  }
  return Object.freeze([token]);
}

/** Deterministic surface tokens before search/grounding variants are expanded. */
export function hierarchySurfaceTokens(value: string): readonly string[] {
  const separated = value.normalize('NFC')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([\p{Script=Latin}\p{N}])([\p{Script=Hangul}\p{Script=Han}])/gu, '$1 $2')
    .replace(/([\p{Script=Hangul}\p{Script=Han}])([\p{Script=Latin}\p{N}])/gu, '$1 $2')
    .toLowerCase();
  return Object.freeze(separated.match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Deterministic, dependency-free token variants shared by selection and quality gates. */
export function hierarchyTokens(value: string): readonly string[] {
  return Object.freeze(hierarchySurfaceTokens(value).flatMap((token) =>
    /^[a-z]+$/u.test(token) ? englishTokenVariants(token) : koreanTokenVariants(token)));
}

export function normalizedHierarchyTokenText(value: string): string {
  return hierarchyTokens(value).join(' ');
}
