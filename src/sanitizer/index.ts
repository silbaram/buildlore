/**
 * Explicit fail-closed boundary. BuildLore intentionally supplies no permissive
 * implementation; production secret detection is owned by Issue #7.
 */
export { issueSanitizationApproval } from './approval.js';
export type { SanitizationApprovalBinding } from './approval.js';
export type {
  SanitizationApproval,
  SanitizationDenial,
  SanitizationDenialCode,
  SanitizationRequest,
  SanitizationResult,
  SourceSanitizerPort,
} from './types.js';
