import { describe, expect, it } from 'vitest';
import { calibrateSemanticRelevance, type SemanticRelevanceObservation } from '../src/retrieval/semantic-relevance-calibration.js';

const observations: readonly SemanticRelevanceObservation[] = [
  { scriptClass: 'same-script', label: 'required-positive', score: 0.84 },
  { scriptClass: 'same-script', label: 'required-positive', score: 0.91 },
  { scriptClass: 'same-script', label: 'unrelated', score: 0.80 },
  { scriptClass: 'cross-script', label: 'required-positive', score: 0.78 },
  { scriptClass: 'cross-script', label: 'unrelated', score: 0.73 },
];
describe('offline semantic policy calibration', () => {
  it('uses weakest required positive and strongest unrelated per script class', () => {
    expect(calibrateSemanticRelevance(observations)).toEqual({
      'same-script': { positiveMinimum: 0.84, negativeMaximum: 0.80, minimumCosine: 0.82, positivePairs: 2, negativePairs: 1 },
      'cross-script': { positiveMinimum: 0.78, negativeMaximum: 0.73, minimumCosine: 0.755, positivePairs: 1, negativePairs: 1 },
    });
    expect(calibrateSemanticRelevance([...observations].reverse())).toEqual(calibrateSemanticRelevance(observations));
  });
  it('refuses overlapping classes and rounded thresholds that fail the strict negative boundary', () => {
    for (const score of [0.84, 0.85]) expect(() => calibrateSemanticRelevance([...observations,
      { scriptClass: 'same-script', label: 'unrelated', score }])).toThrow();
    expect(() => calibrateSemanticRelevance(observations.map(row => row.scriptClass === 'same-script'
      ? { ...row, score: row.label === 'unrelated' ? 0.8 : 0.80000000000001 } : row))).toThrow();
  });
  it('refuses missing classes, non-finite and out-of-range scores', () => {
    expect(() => calibrateSemanticRelevance([])).toThrow();
    expect(() => calibrateSemanticRelevance(observations.filter(row => row.scriptClass === 'same-script'))).toThrow();
    for (const score of [NaN, Infinity, -Infinity, 1.01, -1.01]) expect(() => calibrateSemanticRelevance([
      ...observations, { scriptClass: 'same-script', label: 'unrelated', score },
    ])).toThrow();
  });
});
