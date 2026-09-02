export type WikiOperationErrorCode =
  | 'WIKI_BACKEND_UNAVAILABLE'
  | 'WIKI_CITATION_INVALID'
  | 'WIKI_CONTRACT_INVALID'
  | 'WIKI_CURSOR_INVALID'
  | 'WIKI_EXPORT_DESTINATION_INVALID'
  | 'WIKI_EXPORT_FAILED'
  | 'WIKI_PAGE_NOT_FOUND'
  | 'WIKI_PAGE_REF_INVALID'
  | 'WIKI_SECURITY_DENIED'
  | 'WIKI_SNAPSHOT_CHANGED';

export class WikiOperationError extends Error {
  readonly code: WikiOperationErrorCode;
  readonly partial: boolean;
  readonly projectId: string;
  readonly recoveryAction: 'check' | 'inspect' | 'retry';
  readonly retryable: boolean;
  readonly sideEffectsPossible: boolean;

  constructor(
    code: WikiOperationErrorCode,
    projectId: string,
    options: { readonly sideEffectsPossible?: boolean } = {},
  ) {
    super(options.sideEffectsPossible === true
      ? 'The Wiki export may require inspection after an incomplete cleanup.'
      : code === 'WIKI_PAGE_NOT_FOUND'
        ? 'The verified Wiki page was not found.'
        : code === 'WIKI_SNAPSHOT_CHANGED'
          ? 'The Wiki changed while it was read.'
          : code === 'WIKI_EXPORT_DESTINATION_INVALID'
            ? 'The Wiki export destination is invalid.'
            : 'The Wiki operation was rejected safely.');
    this.name = 'WikiOperationError';
    this.code = code;
    this.sideEffectsPossible = options.sideEffectsPossible === true;
    this.partial = this.sideEffectsPossible;
    this.projectId = projectId;
    this.recoveryAction = this.sideEffectsPossible
      ? 'inspect'
      : code === 'WIKI_SNAPSHOT_CHANGED' ? 'retry' : 'check';
    this.retryable = code === 'WIKI_SNAPSHOT_CHANGED';
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      partial: this.partial,
      projectId: this.projectId,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
      sideEffectsPossible: this.sideEffectsPossible,
    });
  }
}
