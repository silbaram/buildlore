export type KnowledgeErrorCode =
  | 'COMPILER_STATUS_UNSAFE'
  | 'GIT_ACCESS_DENIED'
  | 'GIT_NOT_AVAILABLE'
  | 'KNOWLEDGE_NOT_CONFIGURED'
  | 'MANIFEST_INVALID'
  | 'PATH_OUTSIDE_KNOWLEDGE'
  | 'PROJECT_EXISTS'
  | 'PROJECT_NOT_FOUND'
  | 'REGISTRY_BUSY'
  | 'REGISTRY_WRITE_FAILED'
  | 'SUBMODULE_CONFLICT'
  | 'SUBMODULE_MISMATCH'
  | 'SUBMODULE_UNINITIALIZED'
  | 'WORKSPACE_NOT_EMPTY';

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode;
  readonly recoveryCommand?: readonly string[];

  constructor(
    code: KnowledgeErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly recoveryCommand?: readonly string[] } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KnowledgeError';
    this.code = code;
    if (options.recoveryCommand !== undefined) {
      this.recoveryCommand = options.recoveryCommand;
    }
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
