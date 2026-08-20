import type {
  DataClassification,
  PreparedSource,
  SecuritySourceKind,
} from './types.js';

export interface PreparedSourceBinding {
  readonly approvedBody: string;
  readonly approvedBodyDigest: `sha256:${string}`;
  readonly classification: DataClassification;
  readonly inputBodyDigest: `sha256:${string}`;
  readonly policyDigest: `sha256:${string}`;
  readonly projectId: string;
  readonly rulesVersion: string;
  readonly source: string;
  readonly sourceKind: SecuritySourceKind;
  readonly sourceRevisionOrContentSha256: `sha256:${string}`;
  readonly untrustedData: boolean;
}

interface RegisteredPreparedSource extends PreparedSourceBinding {
  consumed: boolean;
}

const preparedSources = new WeakMap<object, RegisteredPreparedSource>();

export function issuePreparedSource(binding: PreparedSourceBinding): PreparedSource {
  const prepared = Object.freeze({ opaque: true as const });
  preparedSources.set(prepared, { ...binding, consumed: false });
  return prepared;
}

export function consumePreparedSource(prepared: PreparedSource): PreparedSourceBinding | null {
  const binding = preparedSources.get(prepared);
  if (binding === undefined || binding.consumed) return null;
  binding.consumed = true;
  return {
    approvedBody: binding.approvedBody,
    approvedBodyDigest: binding.approvedBodyDigest,
    classification: binding.classification,
    inputBodyDigest: binding.inputBodyDigest,
    policyDigest: binding.policyDigest,
    projectId: binding.projectId,
    rulesVersion: binding.rulesVersion,
    source: binding.source,
    sourceKind: binding.sourceKind,
    sourceRevisionOrContentSha256: binding.sourceRevisionOrContentSha256,
    untrustedData: binding.untrustedData,
  };
}

/** Internal non-consuming inspection for deterministic target planning. */
export function inspectPreparedSource(prepared: PreparedSource): PreparedSourceBinding | null {
  const binding = preparedSources.get(prepared);
  if (binding === undefined || binding.consumed) return null;
  return {
    approvedBody: binding.approvedBody,
    approvedBodyDigest: binding.approvedBodyDigest,
    classification: binding.classification,
    inputBodyDigest: binding.inputBodyDigest,
    policyDigest: binding.policyDigest,
    projectId: binding.projectId,
    rulesVersion: binding.rulesVersion,
    source: binding.source,
    sourceKind: binding.sourceKind,
    sourceRevisionOrContentSha256: binding.sourceRevisionOrContentSha256,
    untrustedData: binding.untrustedData,
  };
}
