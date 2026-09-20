import { securityRule } from './rules.js';
import type { SecurityRuleSummary } from './types.js';

export function isWarningSummary(summary: SecurityRuleSummary): boolean {
  return summary.action === 'warn' && securityRule(summary.ruleId)?.action === 'warn' &&
    Number.isSafeInteger(summary.count) && summary.count > 0 &&
    Number.isSafeInteger(summary.overriddenCount) && summary.overriddenCount >= 0 &&
    summary.overriddenCount <= summary.count;
}

export function hasOnlyWarningSummaries(summaries: readonly SecurityRuleSummary[]): boolean {
  return summaries.every(isWarningSummary);
}

export function hasUntrustedInstructions(summaries: readonly SecurityRuleSummary[]): boolean {
  return summaries.some((summary) => summary.count > 0 &&
    (summary.action === 'quarantine' || summary.ruleId.startsWith('prompt-injection.')));
}
