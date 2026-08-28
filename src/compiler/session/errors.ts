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

export type SessionExportMismatchKind =
  | 'export-shape'
  | 'field-value'
  | 'page-cardinality'
  | 'page-shape'
  | 'project-binding'
  | 'schema-version';

export type SessionExportMismatchField =
  | 'body'
  | 'citations'
  | 'contentHash'
  | 'document'
  | 'frontmatter'
  | 'page'
  | 'pageCollection'
  | 'projectId'
  | 'schemaVersion'
  | 'sourceHashes'
  | 'sourceRefs'
  | 'summary'
  | 'title';

export interface SessionExportInspectionDiagnostic {
  readonly fields: readonly SessionExportMismatchField[];
  readonly mismatchKind: SessionExportMismatchKind;
}

const SESSION_EXPORT_MISMATCH_KINDS: readonly SessionExportMismatchKind[] = Object.freeze([
  'export-shape',
  'field-value',
  'page-cardinality',
  'page-shape',
  'project-binding',
  'schema-version',
]);

const SESSION_EXPORT_MISMATCH_FIELDS: readonly SessionExportMismatchField[] = Object.freeze([
  'body',
  'citations',
  'contentHash',
  'document',
  'frontmatter',
  'page',
  'pageCollection',
  'projectId',
  'schemaVersion',
  'sourceHashes',
  'sourceRefs',
  'summary',
  'title',
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeExportInspection(value: unknown): SessionExportInspectionDiagnostic | undefined {
  if (!isRecord(value) || !Array.isArray(value.fields)) return undefined;
  const mismatchKind = SESSION_EXPORT_MISMATCH_KINDS.find((item) =>
    item === value.mismatchKind);
  if (mismatchKind === undefined) return undefined;
  const fields: SessionExportMismatchField[] = [];
  for (const valueField of value.fields) {
    const field = SESSION_EXPORT_MISMATCH_FIELDS.find((item) => item === valueField);
    if (field === undefined) return undefined;
    if (!fields.includes(field)) fields.push(field);
  }
  if (fields.length === 0) return undefined;
  fields.sort();
  return Object.freeze({ fields: Object.freeze(fields), mismatchKind });
}

export class SessionCompileError extends Error {
  readonly code: SessionCompileErrorCode;
  readonly projectId: string;
  readonly recoveryAction: 'check-config' | 'review' | 'retry' | 'status' | 'sync';
  readonly retryable: boolean;
  readonly sideEffectsPossible: boolean;
  readonly candidateRefs: readonly string[];
  readonly exportInspection: SessionExportInspectionDiagnostic | undefined;

  constructor(
    code: SessionCompileErrorCode,
    projectId: string,
    options: {
      readonly candidateRefs?: readonly string[];
      readonly exportInspection?: SessionExportInspectionDiagnostic;
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
    this.exportInspection = normalizeExportInspection(options.exportInspection);
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      candidateRefs: this.candidateRefs,
      code: this.code,
      ...(this.exportInspection === undefined
        ? {}
        : { exportInspection: this.exportInspection }),
      message: this.message,
      projectId: this.projectId,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
      sideEffectsPossible: this.sideEffectsPossible,
    });
  }
}
