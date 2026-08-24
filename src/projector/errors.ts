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

export type SourceSelectionErrorCode =
  | 'SOURCE_KIND_UNSUPPORTED'
  | 'SOURCE_MANIFEST_INVALID'
  | 'SOURCE_MANIFEST_REQUIRED'
  | 'SOURCE_MANIFEST_TOO_LARGE'
  | 'SOURCE_PROJECT_MISMATCH'
  | 'SOURCE_SELECTION_CHANGED'
  | 'SOURCE_SELECTION_KIND_MISMATCH'
  | 'SOURCE_SELECTION_LIMIT_EXCEEDED'
  | 'SOURCE_SELECTION_PATH_UNSAFE';

export type SourceSelectionField =
  | 'documentKind'
  | 'id'
  | 'manifest'
  | 'path'
  | 'pathType'
  | 'projectId'
  | 'recursive'
  | 'sourceRepository'
  | 'sources';

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

export class SourceSelectionError extends Error {
  readonly code: SourceSelectionErrorCode;
  readonly field: SourceSelectionField;

  constructor(
    code: SourceSelectionErrorCode,
    field: SourceSelectionField,
    message: string,
  ) {
    super(message);
    this.name = 'SourceSelectionError';
    this.code = code;
    this.field = field;
  }

  toJSON(): Readonly<{
    code: SourceSelectionErrorCode;
    field: SourceSelectionField;
    message: string;
  }> {
    return { code: this.code, field: this.field, message: this.message };
  }
}
