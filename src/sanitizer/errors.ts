export type SecurityOperationErrorCode =
  | 'SECURITY_BINDING_INVALID'
  | 'SECURITY_EGRESS_DENIED'
  | 'SECURITY_INPUT_CHANGED'
  | 'SECURITY_INPUT_UNSAFE'
  | 'SECURITY_POLICY_INVALID'
  | 'SECURITY_PROMPT_INJECTION'
  | 'SECURITY_SECRET_SUSPECTED';

export class SecurityOperationError extends Error {
  readonly code: SecurityOperationErrorCode;
  readonly projectId: string;
  readonly ruleIds: readonly string[];
  readonly sourceIdentitySha256?: string;

  constructor(
    code: SecurityOperationErrorCode,
    options: {
      readonly projectId: string;
      readonly ruleIds?: readonly string[];
      readonly sourceIdentitySha256?: string;
    },
  ) {
    super('Source security policy rejected the operation.');
    this.name = 'SecurityOperationError';
    this.code = code;
    this.projectId = options.projectId;
    this.ruleIds = Object.freeze([...(options.ruleIds ?? [])].sort());
    if (options.sourceIdentitySha256 !== undefined) {
      this.sourceIdentitySha256 = options.sourceIdentitySha256;
    }
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      projectId: this.projectId,
      ruleIds: this.ruleIds,
      ...(this.sourceIdentitySha256 === undefined
        ? {}
        : { sourceIdentitySha256: this.sourceIdentitySha256 }),
    };
  }
}
