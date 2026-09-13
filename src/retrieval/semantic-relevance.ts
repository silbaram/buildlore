/** Topical candidate admission for the pinned multilingual-e5-small profile, not
 * answerability or a probability of correctness. Calibration and bilingual probes
 * live in test/fixtures/semantic-relevance.json and the opt-in local-model test.
 * Cross-script matches have lower cosine scores; one global cutoff loses them.
 */
export const KNOWLEDGE_SEMANTIC_RELEVANCE_V1 = Object.freeze({
  schemaVersion: 'buildlore.semantic-relevance-policy.v1' as const,
  profile: 'multilingual-e5-small' as const,
  sameScriptMinimumCosine: 0.81,
  crossScriptMinimumCosine: 0.76,
  scope: 'topical-candidates-not-answerability' as const,
});

/** Offline midpoint calibration; holdout is evaluated only after this profile is frozen. */
export const KNOWLEDGE_SEMANTIC_RELEVANCE_V2 = Object.freeze({
  schemaVersion: 'buildlore.semantic-relevance-policy.v2' as const,
  calibrationVersion: 2 as const,
  profile: 'multilingual-e5-small' as const,
  sameScriptMinimumCosine: 0.820646121668,
  crossScriptMinimumCosine: 0.765124142709,
  calibrationDigest: 'sha256:eeff1a2f6d04fe30423f9d49de85c5e35a1903d2ba61661a8fee9a1a0ce27ac8' as const,
  scope: 'topical-candidates-not-answerability' as const,
});

const SCRIPTS = [
  /\p{Script=Hangul}/gu, /\p{Script=Han}/gu, /\p{Script=Hiragana}|\p{Script=Katakana}/gu,
  /\p{Script=Cyrillic}/gu, /\p{Script=Arabic}/gu, /\p{Script=Devanagari}/gu,
  /\p{Script=Greek}/gu, /\p{Script=Hebrew}/gu, /\p{Script=Thai}/gu,
] as const;

function proseScript(text: string): number | null {
  const letters = text.match(/\p{Letter}/gu)?.length ?? 0;
  if (letters === 0) return null;
  const counts = SCRIPTS.map(pattern => text.match(pattern)?.length ?? 0);
  const maximum = Math.max(...counts);
  // Technical prose frequently contains longer Latin identifiers than natural
  // language words. Recognize substantial non-Latin prose, not a lone symbol.
  if (maximum >= Math.min(4, letters) && maximum / letters >= 0.1) return counts.indexOf(maximum);
  return (text.match(/\p{Script=Latin}/gu)?.length ?? 0) / letters >= 0.5 ? -1 : null;
}

export function semanticScriptRelation(query: string, semanticText: string): 'same-script' | 'cross-script' {
  const queryScript = proseScript(query);
  const documentScript = proseScript(semanticText);
  return queryScript !== null && documentScript !== null && queryScript !== documentScript ? 'cross-script' : 'same-script';
}

export function semanticCandidateMinimumCosine(query: string, semanticText: string): number {
  return semanticScriptRelation(query, semanticText) === 'cross-script'
    ? KNOWLEDGE_SEMANTIC_RELEVANCE_V2.crossScriptMinimumCosine
    : KNOWLEDGE_SEMANTIC_RELEVANCE_V2.sameScriptMinimumCosine;
}
