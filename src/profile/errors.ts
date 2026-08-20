export type ProfileOperationErrorCode =
  | 'PROFILE_APPLY_FAILED'
  | 'PROFILE_BINDING_INVALID'
  | 'PROFILE_DRIFT'
  | 'PROFILE_LANGUAGE_CONFLICT'
  | 'PROFILE_MIGRATION_REQUIRED'
  | 'PROFILE_SOURCE_INVALID'
  | 'PROFILE_UNSAFE'
  | 'PROFILE_UPSTREAM_INVALID';

export class ProfileOperationError extends Error {
  readonly code: ProfileOperationErrorCode;
  readonly migrationRequired: boolean;
  readonly projectId: string;
  readonly recompileRequired: boolean;
  readonly recoveryAction: 'check-profile' | 'create-profile-plan' | 'retry';
  readonly retryable: boolean;

  constructor(
    code: ProfileOperationErrorCode,
    options: {
      readonly migrationRequired?: boolean;
      readonly projectId?: string;
      readonly recompileRequired?: boolean;
      readonly recoveryAction?: 'check-profile' | 'create-profile-plan' | 'retry';
      readonly retryable?: boolean;
    } = {},
  ) {
    super('Lifecycle profile operation failed safely.');
    this.name = 'ProfileOperationError';
    this.code = code;
    this.migrationRequired = options.migrationRequired ?? false;
    this.projectId = options.projectId ?? 'unknown';
    this.recompileRequired = options.recompileRequired ?? false;
    this.recoveryAction = options.recoveryAction ?? 'check-profile';
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      message: this.message,
      migrationRequired: this.migrationRequired,
      projectId: this.projectId,
      recompileRequired: this.recompileRequired,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
    };
  }
}
