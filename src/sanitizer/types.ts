export const SANITIZER_RULES_VERSION = 'buildlore.sanitizer-rules.v1' as const;
export const SANITIZATION_REPORT_SCHEMA_VERSION = 'buildlore.sanitization-report.v1' as const;
export const SECURITY_POLICY_SCHEMA_VERSION = 'buildlore.security-policy.v1' as const;

export type DataClassification = 'internal' | 'public' | 'restricted';
export type SecurityDecision = 'blocked' | 'include' | 'quarantine';
export type SecurityFindingAction = 'block' | 'quarantine' | 'redact';
export type SecurityOverrideReason =
  | 'documented-placeholder'
  | 'false-positive-fixture'
  | 'non-secret-identifier';
export type SecuritySourceKind =
  | 'compiler-cache'
  | 'execution'
  | 'markdown'
  | 'planning'
  | 'profile'
  | 'provider-request'
  | 'wiki';
export type SecurityEgressCapability =
  | 'compile'
  | 'context'
  | 'eval-full'
  | 'query'
  | 'search';

export interface SecurityClassificationRule {
  readonly classification: DataClassification;
  readonly sourceIdentitySha256?: string;
  readonly sourceKind: SecuritySourceKind;
}

export interface SecurityEgressRule {
  readonly allowedClassifications: readonly Exclude<DataClassification, 'restricted'>[];
  readonly capability: SecurityEgressCapability;
}

export interface SecurityOverride {
  readonly auditRef?: string;
  readonly reasonCode: SecurityOverrideReason;
  readonly ruleId: string;
  readonly sourceIdentitySha256: string;
  readonly sourceRevisionOrContentSha256: `sha256:${string}`;
}

export interface SecurityPolicy {
  readonly schemaVersion: typeof SECURITY_POLICY_SCHEMA_VERSION;
  readonly projectId: string;
  readonly defaultClassification: DataClassification;
  readonly classificationRules: readonly SecurityClassificationRule[];
  readonly egressRules: readonly SecurityEgressRule[];
  readonly overrides: readonly SecurityOverride[];
}

export interface SecurityRuleSummary {
  readonly action: SecurityFindingAction;
  readonly count: number;
  readonly overriddenCount: number;
  readonly ruleId: string;
}

export interface SanitizationReport {
  readonly schemaVersion: typeof SANITIZATION_REPORT_SCHEMA_VERSION;
  readonly classification: DataClassification;
  readonly decision: SecurityDecision;
  readonly findingsOverflow: boolean;
  readonly inputDigest: `sha256:${string}`;
  readonly outputDigest?: `sha256:${string}`;
  readonly policyDigest: `sha256:${string}`;
  readonly projectId: string;
  readonly rulesVersion: typeof SANITIZER_RULES_VERSION;
  readonly sourceIdentitySha256: string;
  readonly summaries: readonly SecurityRuleSummary[];
}

/** Opaque same-process handle. The approved body is never a public field. */
export interface PreparedSource {
  readonly opaque: true;
}

export interface SourceSecurityRequest {
  readonly body: string;
  readonly bodyDigest: `sha256:${string}`;
  readonly projectId: string;
  readonly source: string;
  readonly sourceKind: SecuritySourceKind;
  readonly sourceRevisionOrContentSha256: `sha256:${string}`;
}

export type SourceSecurityResult =
  | Readonly<{
      ok: false;
      report: SanitizationReport;
    }>
  | Readonly<{
      ok: true;
      prepared: PreparedSource;
      report: SanitizationReport;
    }>;

export interface ProjectSecurityService {
  prepareSource(request: SourceSecurityRequest): Promise<SourceSecurityResult>;
}

export interface CreateProjectSecurityServiceOptions {
  readonly homePath?: string;
  readonly knowledgeRoot: string;
}
