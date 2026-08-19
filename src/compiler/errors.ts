export type CompilerOperationErrorCode =
  | 'COMPILER_BUSY'
  | 'COMPILER_CANCELLED'
  | 'COMPILER_CAPABILITY_UNSUPPORTED'
  | 'COMPILER_CONFIG_INVALID'
  | 'COMPILER_CONTRACT_VIOLATION'
  | 'COMPILER_EGRESS_DENIED'
  | 'COMPILER_FAILED'
  | 'COMPILER_PROVIDER_UNAVAILABLE'
  | 'COMPILER_PROVIDER_UNKNOWN'
  | 'COMPILER_TIMEOUT';

export type CompilerRecoveryAction = 'check-config' | 'retry' | 'status';

export class CompilerOperationError extends Error {
  readonly capability: string;
  readonly code: CompilerOperationErrorCode;
  readonly projectId: string;
  readonly recoveryAction: CompilerRecoveryAction;
  readonly retryable: boolean;
  readonly sideEffectsPossible: boolean;

  constructor(
    code: CompilerOperationErrorCode,
    message: string,
    options: {
      readonly capability: string;
      readonly projectId: string;
      readonly recoveryAction: CompilerRecoveryAction;
      readonly retryable: boolean;
      readonly sideEffectsPossible: boolean;
    },
  ) {
    super(message);
    this.name = 'CompilerOperationError';
    this.capability = options.capability;
    this.code = code;
    this.projectId = options.projectId;
    this.recoveryAction = options.recoveryAction;
    this.retryable = options.retryable;
    this.sideEffectsPossible = options.sideEffectsPossible;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      capability: this.capability,
      code: this.code,
      message: this.message,
      projectId: this.projectId,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
      sideEffectsPossible: this.sideEffectsPossible,
    };
  }
}
export type CompilerBackendFailureKind =
  | 'busy'
  | 'failed'
  | 'provider-unavailable'
  | 'provider-unknown'
  | 'timeout';

export class CompilerBackendError extends Error {
  readonly kind: CompilerBackendFailureKind;

  constructor(kind: CompilerBackendFailureKind) {
    super('Compiler backend failed safely.');
    this.name = 'CompilerBackendError';
    this.kind = kind;
  }
}
