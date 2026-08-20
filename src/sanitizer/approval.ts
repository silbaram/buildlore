import type { SanitizationApproval } from './types.js';

export interface SanitizationApprovalBinding {
  readonly approvedBody: string;
  readonly approvedBodyDigest: `sha256:${string}`;
  readonly inputBodyDigest: `sha256:${string}`;
  readonly projectId: string;
  readonly source: string;
}

interface RegisteredApproval extends SanitizationApprovalBinding {
  consumed: boolean;
}

const approvals = new WeakMap<object, RegisteredApproval>();

/** Minting boundary for explicitly selected sanitizer implementations. */
export function issueSanitizationApproval(
  binding: SanitizationApprovalBinding,
): SanitizationApproval {
  const approval = Object.freeze({ ok: true as const, opaque: true as const });
  approvals.set(approval, { ...binding, consumed: false });
  return approval;
}

/** Returns the bound values exactly once; forged or reused handles return null. */
export function consumeSanitizationApproval(
  approval: SanitizationApproval,
): SanitizationApprovalBinding | null {
  const binding = approvals.get(approval);
  if (binding === undefined || binding.consumed) return null;
  binding.consumed = true;
  return {
    approvedBody: binding.approvedBody,
    approvedBodyDigest: binding.approvedBodyDigest,
    inputBodyDigest: binding.inputBodyDigest,
    projectId: binding.projectId,
    source: binding.source,
  };
}
