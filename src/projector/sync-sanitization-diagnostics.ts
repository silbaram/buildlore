import { isAbsolute, posix, win32 } from 'node:path';

import {
  SANITIZATION_REPORT_SCHEMA_VERSION,
  SANITIZER_RULES_VERSION,
  SECURITY_RULES,
  type SanitizationReport,
  type SecurityFindingAction,
  type SecuritySourceKind,
} from '../sanitizer/index.js';
import type {
  ProjectSyncSanitizationDiagnostics,
  ProjectSyncSanitizationRuleSummary,
  ProjectSyncSanitizationSource,
  ProjectSyncRedactionWarning,
} from './sync.js';

export const MAX_SYNC_SANITIZATION_DIAGNOSTIC_SOURCES = 32;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const CREDENTIAL_PATH_PATTERN =
  /(?:^|[/_.-])(?:api[-_]?key|authorization|bearer|credentials?|password|private[-_]?key|refresh[-_]?token|secrets?|tokens?|access[-_]?token)(?:$|[/_.-])/iu;
const SOURCE_KINDS = new Set<SecuritySourceKind>([
  'compiler-cache',
  'execution',
  'markdown',
  'planning',
  'profile',
  'provider-request',
  'wiki',
]);
const RULE_ACTION_BY_ID = new Map<string, SecurityFindingAction>(
  SECURITY_RULES.map((rule) => [rule.ruleId, rule.action]),
);

export interface SyncSanitizationDiagnosticInput {
  readonly reports: readonly SanitizationReport[];
  readonly sourceIdentitySha256: string;
  readonly sourceKind: SecuritySourceKind;
  readonly sourceRef: string | null;
}

interface AggregateInput {
  readonly findingsOverflow: boolean;
  readonly sourceIdentitySha256: string;
  readonly sourceKind: SecuritySourceKind;
  readonly sourceRef: string | null;
  readonly summaries: readonly unknown[];
}

interface MutableSourceAggregate {
  findingsOverflow: boolean;
  readonly sourceIdentitySha256: string;
  readonly sourceKind: SecuritySourceKind;
  sourceRef: string | null;
  readonly overflowedSummaryKeys: Set<string>;
  readonly summaries: Map<string, ProjectSyncSanitizationRuleSummary>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code === undefined || code <= 31 || (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff) || /\p{Cf}/u.test(character)
    ) {
      return true;
    }
  }
  return false;
}

function safeSourceRef(value: string | null): string | null {
  if (value === null) return null;
  const segments = value.split('/');
  return value.length > 0 && value.length <= 512 && value === value.normalize('NFC') &&
    !isAbsolute(value) && !win32.isAbsolute(value) && !/^[A-Za-z]:/u.test(value) &&
    !value.includes('\\') && !value.endsWith('/') && posix.normalize(value) === value &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    !hasUnsafeCharacter(value) && !CREDENTIAL_PATH_PATTERN.test(value)
    ? value
    : null;
}

function safeSummary(value: unknown): ProjectSyncSanitizationRuleSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const summary = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(summary).some((key) =>
      key !== 'action' && key !== 'count' && key !== 'overriddenCount' && key !== 'ruleId') ||
    typeof summary.action !== 'string' ||
    typeof summary.count !== 'number' || !Number.isSafeInteger(summary.count) || summary.count <= 0 ||
    typeof summary.overriddenCount !== 'number' || !Number.isSafeInteger(summary.overriddenCount) ||
    summary.overriddenCount < 0 || summary.overriddenCount > summary.count ||
    typeof summary.ruleId !== 'string' ||
    RULE_ACTION_BY_ID.get(summary.ruleId) !== summary.action
  ) return null;
  return Object.freeze({
    action: summary.action,
    count: summary.count,
    overriddenCount: summary.overriddenCount,
    ruleId: summary.ruleId,
  });
}

function aggregate(
  inputs: readonly AggregateInput[],
  additionalOmittedSourceCount = 0,
): ProjectSyncSanitizationDiagnostics {
  const groups = new Map<string, MutableSourceAggregate>();
  for (const input of inputs) {
    if (!DIGEST_PATTERN.test(input.sourceIdentitySha256) || !SOURCE_KINDS.has(input.sourceKind)) continue;
    const key = `${input.sourceKind}:${input.sourceIdentitySha256}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        findingsOverflow: input.findingsOverflow,
        sourceIdentitySha256: input.sourceIdentitySha256,
        sourceKind: input.sourceKind,
        sourceRef: safeSourceRef(input.sourceRef),
        overflowedSummaryKeys: new Set(),
        summaries: new Map(),
      };
      groups.set(key, group);
    } else {
      group.findingsOverflow ||= input.findingsOverflow;
      const candidateRef = safeSourceRef(input.sourceRef);
      if (
        candidateRef !== null &&
        (group.sourceRef === null || compareText(candidateRef, group.sourceRef) < 0)
      ) group.sourceRef = candidateRef;
    }
    for (const rawSummary of input.summaries) {
      const summary = safeSummary(rawSummary);
      if (summary === null) {
        group.findingsOverflow = true;
        continue;
      }
      const summaryKey = `${summary.ruleId}:${summary.action}`;
      if (group.overflowedSummaryKeys.has(summaryKey)) continue;
      const current = group.summaries.get(summaryKey);
      if (current === undefined) {
        group.summaries.set(summaryKey, summary);
        continue;
      }
      const count = current.count + summary.count;
      const overriddenCount = current.overriddenCount + summary.overriddenCount;
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(overriddenCount)) {
        group.findingsOverflow = true;
        group.overflowedSummaryKeys.add(summaryKey);
        group.summaries.delete(summaryKey);
        continue;
      }
      group.summaries.set(summaryKey, Object.freeze({
        action: summary.action,
        count,
        overriddenCount,
        ruleId: summary.ruleId,
      }));
    }
  }
  const sources = [...groups.values()]
    .map((source): ProjectSyncSanitizationSource => Object.freeze({
      findingsOverflow: source.findingsOverflow,
      sourceIdentitySha256: source.sourceIdentitySha256,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      summaries: Object.freeze([...source.summaries.values()].sort((left, right) => {
        const byRule = compareText(left.ruleId, right.ruleId);
        return byRule === 0 ? compareText(left.action, right.action) : byRule;
      })),
    }))
    .sort((left, right) => {
      if (left.sourceRef === null && right.sourceRef !== null) return 1;
      if (left.sourceRef !== null && right.sourceRef === null) return -1;
      const byRef = compareText(
        left.sourceRef ?? left.sourceIdentitySha256,
        right.sourceRef ?? right.sourceIdentitySha256,
      );
      if (byRef !== 0) return byRef;
      const byKind = compareText(left.sourceKind, right.sourceKind);
      return byKind === 0
        ? compareText(left.sourceIdentitySha256, right.sourceIdentitySha256)
        : byKind;
    });
  const truncatedSourceCount = Math.max(
    0,
    sources.length - MAX_SYNC_SANITIZATION_DIAGNOSTIC_SOURCES,
  );
  const omittedSourceCount = additionalOmittedSourceCount + truncatedSourceCount;
  return Object.freeze({
    omittedSourceCount: Number.isSafeInteger(omittedSourceCount)
      ? omittedSourceCount
      : Number.MAX_SAFE_INTEGER,
    sources: Object.freeze(sources.slice(0, MAX_SYNC_SANITIZATION_DIAGNOSTIC_SOURCES)),
  });
}

export function buildProjectSyncSanitizationDiagnostics(
  inputs: readonly SyncSanitizationDiagnosticInput[],
): ProjectSyncSanitizationDiagnostics {
  return aggregate(inputs.map((input): AggregateInput => ({
    findingsOverflow: input.reports.some((report) => report.findingsOverflow === true),
    sourceIdentitySha256: input.sourceIdentitySha256,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    summaries: input.reports.flatMap((report) =>
      report.sourceIdentitySha256 === input.sourceIdentitySha256 ? report.summaries : []),
  })));
}

export function buildProjectSyncRedactionWarnings(
  inputs: readonly SyncSanitizationDiagnosticInput[],
): readonly ProjectSyncRedactionWarning[] | null {
  const aggregates = new Map<string, {
    occurrenceCount: number;
    readonly sources: Set<string>;
  }>();
  for (const input of inputs) {
    if (!DIGEST_PATTERN.test(input.sourceIdentitySha256) || !SOURCE_KINDS.has(input.sourceKind)) {
      return null;
    }
    const sourceKey = `${input.sourceKind}:${input.sourceIdentitySha256}`;
    for (const report of input.reports) {
      if (
        report.decision !== 'include' || report.findingsOverflow ||
        report.rulesVersion !== SANITIZER_RULES_VERSION ||
        report.schemaVersion !== SANITIZATION_REPORT_SCHEMA_VERSION ||
        report.sourceIdentitySha256 !== input.sourceIdentitySha256
      ) return null;
      for (const rawSummary of report.summaries) {
        const summary = safeSummary(rawSummary);
        if (summary === null) return null;
        if (summary.action !== 'redact') continue;
        const occurrenceCount = summary.count - summary.overriddenCount;
        if (occurrenceCount === 0) continue;
        let aggregate = aggregates.get(summary.ruleId);
        if (aggregate === undefined) {
          aggregate = { occurrenceCount: 0, sources: new Set() };
          aggregates.set(summary.ruleId, aggregate);
        }
        const nextCount = aggregate.occurrenceCount + occurrenceCount;
        if (!Number.isSafeInteger(nextCount) || nextCount <= 0) return null;
        aggregate.occurrenceCount = nextCount;
        aggregate.sources.add(sourceKey);
      }
    }
  }
  return Object.freeze([...aggregates.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([ruleId, aggregate]) => Object.freeze({
      code: 'sanitization-redaction-applied' as const,
      occurrenceCount: aggregate.occurrenceCount,
      ruleId,
      sourceCount: aggregate.sources.size,
    })));
}

export function normalizeProjectSyncSanitizationDiagnostics(
  value: unknown,
): ProjectSyncSanitizationDiagnostics | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const diagnostics = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(diagnostics).some((key) => key !== 'sources' && key !== 'omittedSourceCount') ||
    !Array.isArray(diagnostics.sources) ||
    typeof diagnostics.omittedSourceCount !== 'number' ||
    !Number.isSafeInteger(diagnostics.omittedSourceCount) || diagnostics.omittedSourceCount < 0
  ) return undefined;
  const inputs: AggregateInput[] = [];
  for (const valueSource of diagnostics.sources) {
    if (typeof valueSource !== 'object' || valueSource === null || Array.isArray(valueSource)) continue;
    const source = valueSource as Readonly<Record<string, unknown>>;
    if (
      Object.keys(source).some((key) => ![
        'findingsOverflow',
        'sourceIdentitySha256',
        'sourceKind',
        'sourceRef',
        'summaries',
      ].includes(key)) ||
      typeof source.findingsOverflow !== 'boolean' ||
      typeof source.sourceIdentitySha256 !== 'string' ||
      typeof source.sourceKind !== 'string' || !SOURCE_KINDS.has(source.sourceKind as SecuritySourceKind) ||
      (source.sourceRef !== null && typeof source.sourceRef !== 'string') ||
      !Array.isArray(source.summaries)
    ) continue;
    inputs.push({
      findingsOverflow: source.findingsOverflow,
      sourceIdentitySha256: source.sourceIdentitySha256,
      sourceKind: source.sourceKind as SecuritySourceKind,
      sourceRef: source.sourceRef,
      summaries: source.summaries,
    });
  }
  return aggregate(inputs, diagnostics.omittedSourceCount);
}
