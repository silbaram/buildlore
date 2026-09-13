/** Offline calibration only. Runtime retrieval consumes an immutable policy, never these samples. */
export interface SemanticRelevanceObservation {
  readonly scriptClass: 'same-script' | 'cross-script';
  readonly label: 'required-positive' | 'unrelated';
  readonly score: number;
}

export class SemanticRelevanceCalibrationError extends Error {
  readonly code = 'SEMANTIC_RELEVANCE_CALIBRATION_INVALID';
  constructor(readonly reason: 'invalid-score' | 'missing-class' | 'no-interval') {
    super('Semantic relevance calibration cannot produce a valid policy.');
    this.name = 'SemanticRelevanceCalibrationError';
  }
}

export interface SemanticRelevanceCalibrationClass {
  readonly positiveMinimum: number;
  readonly negativeMaximum: number;
  readonly minimumCosine: number;
  readonly positivePairs: number;
  readonly negativePairs: number;
}

/** The rule is fixed before scoring. Holdout observations must never be supplied here. */
export function calibrateSemanticRelevance(observations: readonly SemanticRelevanceObservation[]):
Readonly<Record<'same-script' | 'cross-script', SemanticRelevanceCalibrationClass>> {
  if (observations.some(row => !Number.isFinite(row.score) || row.score < -1 || row.score > 1 ||
      !['same-script', 'cross-script'].includes(row.scriptClass) || !['required-positive', 'unrelated'].includes(row.label))) {
    throw new SemanticRelevanceCalibrationError('invalid-score');
  }
  const calibrate = (scriptClass: SemanticRelevanceObservation['scriptClass']): SemanticRelevanceCalibrationClass => {
    const rows = observations.filter(row => row.scriptClass === scriptClass);
    const positive = rows.filter(row => row.label === 'required-positive').map(row => row.score);
    const negative = rows.filter(row => row.label === 'unrelated').map(row => row.score);
    if (!positive.length || !negative.length) throw new SemanticRelevanceCalibrationError('missing-class');
    const positiveMinimum = positive.reduce((a, b) => Math.min(a, b));
    const negativeMaximum = negative.reduce((a, b) => Math.max(a, b));
    const minimumCosine = Number(((positiveMinimum + negativeMaximum) / 2).toFixed(12));
    if (!(negativeMaximum < minimumCosine && minimumCosine <= positiveMinimum)) {
      throw new SemanticRelevanceCalibrationError('no-interval');
    }
    return Object.freeze({ positiveMinimum, negativeMaximum, minimumCosine,
      positivePairs: positive.length, negativePairs: negative.length });
  };
  return Object.freeze({ 'same-script': calibrate('same-script'), 'cross-script': calibrate('cross-script') });
}
