import type { SecurityFindingAction } from './types.js';

export const MAX_SANITIZER_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_SECURITY_FINDINGS = 512;

export interface SecurityRuleDescriptor {
  readonly action: SecurityFindingAction;
  readonly overridable: boolean;
  readonly priority: number;
  readonly ruleId: string;
}

const RULE_DESCRIPTORS = [
  { action: 'redact', overridable: false, priority: 10, ruleId: 'path.workspace' },
  { action: 'redact', overridable: false, priority: 20, ruleId: 'path.home' },
  { action: 'redact', overridable: false, priority: 25, ruleId: 'path.absolute' },
  { action: 'redact', overridable: false, priority: 30, ruleId: 'credential.url' },
  { action: 'redact', overridable: false, priority: 40, ruleId: 'credential.bearer' },
  { action: 'redact', overridable: false, priority: 41, ruleId: 'credential.basic' },
  { action: 'redact', overridable: false, priority: 42, ruleId: 'credential.cookie' },
  { action: 'redact', overridable: false, priority: 43, ruleId: 'credential.environment' },
  { action: 'redact', overridable: false, priority: 50, ruleId: 'credential.jwt' },
  { action: 'redact', overridable: false, priority: 51, ruleId: 'credential.provider.aws' },
  { action: 'redact', overridable: false, priority: 52, ruleId: 'credential.provider.github' },
  { action: 'redact', overridable: false, priority: 53, ruleId: 'credential.provider.npm' },
  { action: 'redact', overridable: false, priority: 54, ruleId: 'credential.provider.openai' },
  { action: 'redact', overridable: false, priority: 55, ruleId: 'credential.provider.anthropic' },
  { action: 'redact', overridable: false, priority: 56, ruleId: 'credential.provider.google' },
  { action: 'block', overridable: false, priority: 60, ruleId: 'private-key.pem' },
  { action: 'block', overridable: true, priority: 70, ruleId: 'entropy.candidate' },
  { action: 'quarantine', overridable: true, priority: 80, ruleId: 'prompt-injection.override-instructions' },
  { action: 'quarantine', overridable: true, priority: 81, ruleId: 'prompt-injection.secret-exfiltration' },
  { action: 'quarantine', overridable: true, priority: 82, ruleId: 'prompt-injection.role-instruction' },
  { action: 'quarantine', overridable: true, priority: 83, ruleId: 'prompt-injection.tool-action' },
  { action: 'block', overridable: false, priority: 90, ruleId: 'input.finding-overflow' },
  { action: 'block', overridable: false, priority: 91, ruleId: 'input.nul' },
  { action: 'block', overridable: false, priority: 92, ruleId: 'input.oversized' },
  { action: 'block', overridable: false, priority: 93, ruleId: 'input.redaction-overlap' },
  { action: 'block', overridable: false, priority: 94, ruleId: 'input.invalid-binding' },
  { action: 'block', overridable: false, priority: 95, ruleId: 'input.invalid-character' },
  { action: 'block', overridable: false, priority: 96, ruleId: 'input.redaction-incomplete' },
] satisfies readonly SecurityRuleDescriptor[];

export const SECURITY_RULES: readonly SecurityRuleDescriptor[] = Object.freeze(
  RULE_DESCRIPTORS.map((rule) => Object.freeze(rule)),
);

const RULES_BY_ID = new Map(SECURITY_RULES.map((rule) => [rule.ruleId, rule]));

export function securityRule(ruleId: string): SecurityRuleDescriptor | undefined {
  return RULES_BY_ID.get(ruleId);
}
