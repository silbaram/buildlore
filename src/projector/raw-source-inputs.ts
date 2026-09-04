import { createHash } from 'node:crypto';

import { consumePreparedSource } from '../sanitizer/approval.js';
import type {
  ProjectSecurityService,
  SecurityRuleSummary,
  SecuritySourceKind,
} from '../sanitizer/types.js';

export const RAW_SOURCE_PATH_REDACTION_RULE_IDS = Object.freeze([
  'path.absolute',
  'path.home',
  'path.workspace',
] as const);

export interface RawSourceInputV1 {
  readonly allowedRedactionRuleIds: readonly string[];
  readonly body: string;
}

const RAW_SOURCE_INPUTS = new WeakMap<object, readonly RawSourceInputV1[]>();

function rawSourceInput(value: string | RawSourceInputV1): RawSourceInputV1 {
  if (typeof value === 'string') {
    return Object.freeze({ allowedRedactionRuleIds: Object.freeze([]), body: value });
  }
  const allowed = [...value.allowedRedactionRuleIds];
  if (typeof value.body !== 'string' || new Set(allowed).size !== allowed.length ||
      allowed.some((ruleId) => !RAW_SOURCE_PATH_REDACTION_RULE_IDS.includes(
        ruleId as (typeof RAW_SOURCE_PATH_REDACTION_RULE_IDS)[number],
      ))) {
    throw new Error('Raw source input policy is invalid.');
  }
  allowed.sort();
  return Object.freeze({ allowedRedactionRuleIds: Object.freeze(allowed), body: value.body });
}

export function bindRawSourceInputs<T extends object>(
  candidate: T,
  inputs: readonly (string | RawSourceInputV1)[],
): T {
  if (RAW_SOURCE_INPUTS.has(candidate)) {
    throw new Error('Raw source inputs are already bound.');
  }
  RAW_SOURCE_INPUTS.set(candidate, Object.freeze(inputs.map(rawSourceInput)));
  return candidate;
}

export function inspectRawSourceInputs(candidate: object): readonly RawSourceInputV1[] {
  return RAW_SOURCE_INPUTS.get(candidate) ?? Object.freeze([]);
}

export function rawSourceInputSanitizationIsSafe(
  input: RawSourceInputV1,
  approvedBody: string,
  summaries: readonly SecurityRuleSummary[],
): boolean {
  const allowed = new Set(input.allowedRedactionRuleIds);
  if (summaries.length === 0) return approvedBody === input.body;
  return summaries.every((summary) =>
    summary.action === 'redact' && summary.count > 0 && summary.overriddenCount === 0 &&
    allowed.has(summary.ruleId));
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Verifies every selected raw input bound to an adapter result, including inputs
 * that a custom adapter excluded or quarantined instead of projecting.
 */
export async function boundRawSourceInputsAreSafe(
  owner: object,
  input: Readonly<{
    policyDigest: `sha256:${string}`;
    projectId: string;
    security: ProjectSecurityService;
    source: string;
    sourceKind: SecuritySourceKind;
    sourceRevision: `sha256:${string}`;
  }>,
): Promise<boolean> {
  for (const rawInput of inspectRawSourceInputs(owner)) {
    const bodyDigest = sha256(rawInput.body);
    const result = await input.security.prepareSource({
      body: rawInput.body,
      bodyDigest,
      projectId: input.projectId,
      source: input.source,
      sourceKind: input.sourceKind,
      sourceRevisionOrContentSha256: input.sourceRevision,
    });
    if (!result.ok || result.report.decision !== 'include' || result.report.findingsOverflow ||
        result.report.inputDigest !== bodyDigest ||
        result.report.policyDigest !== input.policyDigest ||
        result.report.projectId !== input.projectId) return false;
    const prepared = consumePreparedSource(result.prepared);
    if (prepared === null || prepared.inputBodyDigest !== bodyDigest ||
        prepared.approvedBodyDigest !== result.report.outputDigest ||
        prepared.policyDigest !== input.policyDigest || prepared.projectId !== input.projectId ||
        prepared.source !== input.source || prepared.sourceKind !== input.sourceKind ||
        prepared.sourceRevisionOrContentSha256 !== input.sourceRevision ||
        sha256(prepared.approvedBody) !== prepared.approvedBodyDigest ||
        !rawSourceInputSanitizationIsSafe(
          rawInput,
          prepared.approvedBody,
          result.report.summaries,
        )) return false;
  }
  return true;
}
