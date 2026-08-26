export type SessionCompileErrorCode =
  | 'SESSION_ADMISSION_FAILED'
  | 'SESSION_CITATION_INVALID'
  | 'SESSION_CONTRACT_INVALID'
  | 'SESSION_LINK_INVALID'
  | 'SESSION_OUTPUT_UNSAFE'
  | 'SESSION_PLAN_DENIED'
  | 'SESSION_PLAN_STALE';

export class SessionCompileError extends Error {
  readonly code: SessionCompileErrorCode;
  readonly projectId: string;
  readonly recoveryAction: 'check-config' | 'review' | 'retry' | 'status';
  readonly retryable: boolean;
  readonly sideEffectsPossible: boolean;
  readonly candidateRefs: readonly string[];

  constructor(
    code: SessionCompileErrorCode,
    projectId: string,
    options: {
      readonly candidateRefs?: readonly string[];
      readonly recoveryAction?: 'check-config' | 'review' | 'retry' | 'status';
      readonly retryable?: boolean;
      readonly sideEffectsPossible?: boolean;
    } = {},
  ) {
    super(code === 'SESSION_PLAN_STALE'
      ? 'Session compile plan is stale.'
      : code === 'SESSION_ADMISSION_FAILED'
        ? 'Session output could not be staged safely.'
        : 'Session compile input was rejected safely.');
    this.name = 'SessionCompileError';
    this.code = code;
    this.projectId = projectId;
    this.recoveryAction = options.recoveryAction ??
      (code === 'SESSION_ADMISSION_FAILED' ? 'status' : 'check-config');
    this.retryable = options.retryable ?? false;
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
