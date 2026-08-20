export type SanitizationDenialCode = 'policy-denied' | 'secret-suspected';

export interface SanitizationRequest {
  readonly body: string;
  readonly bodyDigest: `sha256:${string}`;
  readonly projectId: string;
  readonly source: string;
}

/** Opaque handle; its binding is held in an in-memory one-use registry. */
export interface SanitizationApproval {
  readonly ok: true;
  readonly opaque: true;
}

export interface SanitizationDenial {
  readonly code: SanitizationDenialCode;
  readonly ok: false;
}

export type SanitizationResult = SanitizationApproval | SanitizationDenial;

export interface SourceSanitizerPort {
  sanitize(request: SanitizationRequest): Promise<SanitizationResult>;
}
