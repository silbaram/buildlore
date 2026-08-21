export type RetrievalEvaluationErrorCode =
  | 'RETRIEVAL_EVAL_FIXTURE_INVALID'
  | 'RETRIEVAL_EVAL_REGRESSION_INCOMPATIBLE'
  | 'RETRIEVAL_EVAL_THRESHOLD_FAILED';

export class RetrievalEvaluationError extends Error {
  readonly code: RetrievalEvaluationErrorCode;
  readonly recoveryAction: 'check-fixture' | 'review-regression';

  constructor(code: RetrievalEvaluationErrorCode) {
    super(code === 'RETRIEVAL_EVAL_FIXTURE_INVALID'
      ? 'Retrieval evaluation fixture is invalid.'
      : code === 'RETRIEVAL_EVAL_REGRESSION_INCOMPATIBLE'
        ? 'Retrieval evaluation baseline is incompatible.'
        : 'Retrieval evaluation quality gate failed.');
    this.name = 'RetrievalEvaluationError';
    this.code = code;
    this.recoveryAction = code === 'RETRIEVAL_EVAL_FIXTURE_INVALID'
      ? 'check-fixture'
      : 'review-regression';
  }
}
