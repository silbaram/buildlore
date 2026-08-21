import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import type { RetrievalEvaluationReport } from './types.js';

export function renderRetrievalEvaluationJson(report: RetrievalEvaluationReport): string {
  return serializeCanonicalJson(report);
}

export function renderRetrievalEvaluationHuman(report: RetrievalEvaluationReport): string {
  const lines = [
    `retrieval evaluation: ${report.overallPassed ? 'passed' : 'failed'}`,
    `strategy: ${report.selectedStrategy.tokenizerId}@${report.selectedStrategy.tokenizerVersion}`,
  ];
  for (const metric of report.metrics) {
    if (metric.mode === 'hybrid' ||
        (metric.mode === 'lexical' && [
          'code-symbol-korean', 'korean-exact', 'korean-spacing-morphology',
        ].includes(metric.category)) ||
        (metric.mode === 'semantic' && [
          'korean-synonym', 'korean-to-english',
        ].includes(metric.category))) {
      lines.push(`${metric.mode}/${metric.category}: Recall@5=${metric.recallAt5.toFixed(6)} ` +
        `MRR=${metric.mrr.toFixed(6)} ${metric.passed ? 'pass' : 'fail'}`);
    }
  }
  lines.push(`candidate comparison: ${report.candidateComparisonPassed ? 'pass' : 'fail'}`);
  for (const candidate of report.candidates) {
    lines.push(
      `candidate ${candidate.candidateId}: ${candidate.decision}; ` +
      `dependency=${candidate.dependencyImpact}; license=${candidate.licenseId}; ` +
      `index-bytes=${candidate.indexBytes ?? candidate.indexBytesUnavailableReason ?? 'unavailable'}`,
    );
  }
  lines.push(
    `regression: ${report.regression.passed ? 'pass' : 'fail'}; ` +
    `compatible=${report.regression.compatible}; ` +
    `reasons=${report.regression.reasonCodes.join(',') || 'none'}`,
  );
  lines.push(
    `performance: ${report.performance.comparable ? 'comparable' : 'not-comparable'}; ` +
    `reasons=${report.performance.reasonCodes.join(',') || 'none'}`,
  );
  lines.push(`index bytes: ${report.performance.indexBytes}`);
  return `${lines.join('\n')}\n`;
}
