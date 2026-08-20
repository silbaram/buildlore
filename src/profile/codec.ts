import { parseDocument } from 'yaml';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { ProfileOperationError } from './errors.js';
import {
  BUILDLORE_PROFILE_ID,
  BUILDLORE_PROFILE_SCHEMA_VERSION,
  BUILDLORE_PROFILE_VERSION,
  type BuildLoreLifecycleProfileV1,
  type OutputLanguage,
} from './types.js';

export const MAX_LIFECYCLE_PROFILE_BYTES = 256 * 1024;

function invalid(): never {
  throw new ProfileOperationError('PROFILE_SOURCE_INVALID');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOutputLanguage(value: unknown): OutputLanguage {
  if (value !== 'en' && value !== 'ko') return invalid();
  return value;
}

export function createBuildLoreLifecycleProfile(
  outputLanguage: OutputLanguage,
): BuildLoreLifecycleProfileV1 {
  return {
    schemaVersion: BUILDLORE_PROFILE_SCHEMA_VERSION,
    profileId: BUILDLORE_PROFILE_ID,
    profileVersion: BUILDLORE_PROFILE_VERSION,
    outputLanguage,
    entities: [
      { id: 'decision', upstreamType: 'decisions', directory: 'wiki/decisions' },
      { id: 'failure', upstreamType: 'failures', directory: 'wiki/failures' },
      { id: 'verification', upstreamType: 'verifications', directory: 'wiki/verifications' },
    ],
    relations: [
      {
        id: 'supersedes',
        from: ['decisions'],
        to: ['decisions'],
        direction: 'directed',
        cardinality: { from: '0..n', to: '0..n' },
      },
      {
        id: 'verified-by',
        from: ['decisions', 'failures'],
        to: ['verifications'],
        direction: 'directed',
        cardinality: { from: '0..n', to: '0..n' },
      },
    ],
    lifecycles: [
      {
        entity: 'decisions',
        field: 'status',
        initial: 'active',
        terminal: ['archived'],
        transitions: {
          active: ['superseded', 'archived'],
          superseded: ['archived'],
          archived: [],
        },
      },
      {
        entity: 'failures',
        field: 'status',
        initial: 'open',
        terminal: ['archived'],
        transitions: { open: ['resolved'], resolved: ['archived'], archived: [] },
      },
      {
        entity: 'verifications',
        field: 'status',
        initial: 'recorded',
        terminal: ['archived'],
        transitions: {
          recorded: ['passed', 'failed'],
          passed: ['archived'],
          failed: ['archived'],
          archived: [],
        },
      },
    ],
    reviewPolicy: {
      hold: [
        'low-confidence',
        'contradicted',
        'schema-violating',
        'provenance-violating',
      ],
      lowConfidenceThreshold: 0.5,
      treatMissingConfidenceAs: 'low',
    },
    freshnessPolicy: {
      stale: 'retain-warn-recompile',
      orphaned: 'retain-review-exclude-active',
      archived: 'retain-history-exclude-active',
    },
    exclusions: {
      entities: ['project', 'feature', 'task', 'run', 'artifact'],
      relations: ['implements', 'failed-by', 'produced', 'belongs-to'],
      workflows: ['generic-workflow', 'workflow-actions', 'artifacts', 'connectors'],
    },
  };
}

export function renderLifecycleProfile(profile: BuildLoreLifecycleProfileV1): string {
  return serializeCanonicalJson(profile);
}

export function parseLifecycleProfile(raw: string): BuildLoreLifecycleProfileV1 {
  if (raw.length === 0 || Buffer.byteLength(raw, 'utf8') > MAX_LIFECYCLE_PROFILE_BYTES) {
    return invalid();
  }
  const parsed = parseDocument(raw, {
    logLevel: 'silent',
    schema: 'json',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  if (parsed.errors.length > 0 || parsed.warnings.length > 0) return invalid();
  let decoded: unknown;
  try {
    decoded = parsed.toJS({ maxAliasCount: 0 });
  } catch {
    return invalid();
  }
  if (!isRecord(decoded)) return invalid();
  const expected = createBuildLoreLifecycleProfile(parseOutputLanguage(decoded.outputLanguage));
  if (JSON.stringify(decoded) !== JSON.stringify(expected) || raw !== renderLifecycleProfile(expected)) {
    return invalid();
  }
  return expected;
}
