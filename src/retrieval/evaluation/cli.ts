import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  parseFrozenRetrievalCorpus,
  parseRecordedMorphologyCandidate,
  parseRecordedSemanticFixture,
  parseRetrievalEvaluationReport,
  readBoundedJson,
} from './codec.js';
import { RetrievalEvaluationError } from './errors.js';
import { renderRetrievalEvaluationHuman, renderRetrievalEvaluationJson } from './render.js';
import { createRetrievalEvaluation } from './runner.js';

function contained(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function main(args: readonly string[]): Promise<number> {
  const humanCount = args.filter((arg) => arg === '--human').length;
  const baselineIndexes = args.map((arg, index) => arg === '--baseline' ? index : -1)
    .filter((index) => index >= 0);
  if (humanCount > 1 || baselineIndexes.length > 1 || args.some((arg, index) =>
    arg !== '--human' && arg !== '--baseline' && baselineIndexes[0] !== index - 1)) {
    throw new RetrievalEvaluationError('RETRIEVAL_EVAL_FIXTURE_INVALID');
  }
  const root = resolve(process.cwd());
  const fixtureRoot = resolve(root, 'test', 'fixtures', 'retrieval', 'v1');
  if (!contained(root, fixtureRoot)) {
    throw new RetrievalEvaluationError('RETRIEVAL_EVAL_FIXTURE_INVALID');
  }
  const corpus = parseFrozenRetrievalCorpus(
    await readBoundedJson(join(fixtureRoot, 'corpus.json'), { confinementRoot: root }),
  );
  const semantic = parseRecordedSemanticFixture(
    await readBoundedJson(join(fixtureRoot, 'semantic.json'), { confinementRoot: root }),
    corpus,
  );
  const morphology = parseRecordedMorphologyCandidate(
    await readBoundedJson(join(fixtureRoot, 'morphology.json'), { confinementRoot: root }),
    corpus,
  );
  const baselineValue = baselineIndexes[0] === undefined
    ? undefined
    : args[baselineIndexes[0] + 1];
  if (baselineIndexes[0] !== undefined && baselineValue === undefined) {
    throw new RetrievalEvaluationError('RETRIEVAL_EVAL_FIXTURE_INVALID');
  }
  const baselinePath = baselineValue === undefined
    ? join(fixtureRoot, 'baseline.json')
    : resolve(root, baselineValue);
  if (!contained(root, baselinePath)) {
    throw new RetrievalEvaluationError('RETRIEVAL_EVAL_FIXTURE_INVALID');
  }
  const baseline = parseRetrievalEvaluationReport(await readBoundedJson(baselinePath, {
    confinementRoot: root,
  }));
  const report = createRetrievalEvaluation().evaluate({
    baseline,
    corpus,
    morphology,
    semantic,
  });
  process.stdout.write(args.includes('--human')
    ? renderRetrievalEvaluationHuman(report)
    : renderRetrievalEvaluationJson(report));
  return report.overallPassed ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const normalized = error instanceof RetrievalEvaluationError
    ? error
    : new RetrievalEvaluationError('RETRIEVAL_EVAL_FIXTURE_INVALID');
  process.stderr.write(`${JSON.stringify({
    code: normalized.code,
    ok: false,
    recoveryAction: normalized.recoveryAction,
  })}\n`);
  process.exitCode = 2;
}
