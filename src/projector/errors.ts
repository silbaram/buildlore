export type SourceDocumentErrorCode =
  | 'SOURCE_BODY_INVALID'
  | 'SOURCE_DOCUMENT_INVALID'
  | 'SOURCE_DOCUMENT_TOO_LARGE'
  | 'SOURCE_FRONTMATTER_INVALID'
  | 'SOURCE_SCHEMA_UNSUPPORTED';

export type ProjectionErrorCode =
  | 'PROJECTION_APPROVAL_INVALID'
  | 'PROJECTION_ARTIFACT_CHANGED'
  | 'PROJECTION_ARTIFACT_INVALID'
  | 'PROJECTION_PATH_UNSAFE'
  | 'PROJECTION_PROJECT_MISMATCH'
  | 'PROJECTION_SANITIZATION_FAILED'
  | 'PROJECTION_SOURCE_COLLISION'
  | 'PROJECTION_TIMESTAMP_UNAVAILABLE'
  | 'PROJECTION_WRITE_FAILED';

export class SourceDocumentError extends Error {
  readonly code: SourceDocumentErrorCode;

  constructor(code: SourceDocumentErrorCode, message: string) {
    super(message);
    this.name = 'SourceDocumentError';
    this.code = code;
  }

  toJSON(): Readonly<{ code: SourceDocumentErrorCode; message: string }> {
    return { code: this.code, message: this.message };
  }
}

export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode, message: string) {
    super(message);
    this.name = 'ProjectionError';
    this.code = code;
  }

  toJSON(): Readonly<{ code: ProjectionErrorCode; message: string }> {
    return { code: this.code, message: this.message };
  }
}
