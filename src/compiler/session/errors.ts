export type SessionCompileErrorCode =
  | 'SESSION_ADMISSION_FAILED'
  | 'SESSION_CANDIDATE_ALREADY_APPROVED'
  | 'SESSION_CANDIDATE_APPROVAL_FAILED'
  | 'SESSION_CANDIDATE_BUSY'
  | 'SESSION_CANDIDATE_DUPLICATE'
  | 'SESSION_CANDIDATE_NOT_FOUND'
  | 'SESSION_CANDIDATE_PROFILE_MISMATCH'
  | 'SESSION_CANDIDATE_PROJECT_MISMATCH'
  | 'SESSION_CANDIDATE_RECOVERY_REQUIRED'
  | 'SESSION_CANDIDATE_STALE'
  | 'SESSION_CANDIDATE_STORE_INVALID'
  | 'SESSION_CITATION_INVALID'
  | 'SESSION_CONTRACT_INVALID'
  | 'SESSION_LINK_INVALID'
  | 'SESSION_OUTPUT_UNSAFE'
  | 'SESSION_PLAN_DENIED'
  | 'SESSION_PLAN_STALE';

export class SessionCompileError extends Error {
  readonly code: SessionCompileErrorCode;
  readonly projectId: string;
  readonly recoveryAction: 'check-config' | 'review' | 'retry' | 'status' | 'sync';
  readonly retryable: boolean;
  readonly sideEffectsPossible: boolean;
  readonly candidateRefs: readonly string[];

  constructor(
    code: SessionCompileErrorCode,
    projectId: string,
    options: {
      readonly candidateRefs?: readonly string[];
      readonly recoveryAction?: 'check-config' | 'review' | 'retry' | 'status' | 'sync';
      readonly retryable?: boolean;
      readonly sideEffectsPossible?: boolean;
    } = {},
  ) {
    super(code === 'SESSION_PLAN_STALE' || code === 'SESSION_CANDIDATE_STALE'
      ? 'Session compile plan is stale.'
      : code === 'SESSION_CANDIDATE_NOT_FOUND'
        ? 'Session review candidate was not found.'
        : code === 'SESSION_CANDIDATE_ALREADY_APPROVED'
          ? 'Session review candidate is already approved.'
          : code === 'SESSION_CANDIDATE_APPROVAL_FAILED'
            ? 'Session review candidate could not be approved safely.'
          : code === 'SESSION_CANDIDATE_BUSY'
            ? 'Session review candidate is being approved.'
      : code === 'SESSION_ADMISSION_FAILED'
        ? 'Session output could not be staged safely.'
        : 'Session review state or input was rejected safely.');
    this.name = 'SessionCompileError';
    this.code = code;
    this.projectId = projectId;
    this.recoveryAction = options.recoveryAction ??
      (code === 'SESSION_ADMISSION_FAILED' ? 'status' : 'check-config');
    this.retryable = options.retryable ??
      (code === 'SESSION_CANDIDATE_BUSY' || code === 'SESSION_CANDIDATE_APPROVAL_FAILED');
    this.sideEffectsPossible = options.sideEffectsPossible ?? false;
    this.candidateRefs = Object.freeze([...(options.candidateRefs ?? [])].sort());
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      candidateRefs: this.candidateRefs,
      code: this.code,
      message: this.message,
      projectId: this.projectId,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
      sideEffectsPossible: this.sideEffectsPossible,
    });
  }
}
