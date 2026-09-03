export type HierarchyContractErrorCode = 'HIERARCHY_CONTRACT_INVALID';

export class HierarchyContractError extends Error {
  readonly code: HierarchyContractErrorCode;
  readonly projectId: string;

  constructor(projectId: string) {
    super('Hierarchical corpus contract is invalid.');
    this.name = 'HierarchyContractError';
    this.code = 'HIERARCHY_CONTRACT_INVALID';
    this.projectId = projectId;
  }
}

export type HierarchicalWorkflowEvidenceInsufficientErrorCode =
  'HIERARCHICAL_WORKFLOW_EVIDENCE_INSUFFICIENT';

/** A value-free workflow failure containing only already-sanitized page metadata. */
export class HierarchicalWorkflowEvidenceInsufficientError extends Error {
  readonly code: HierarchicalWorkflowEvidenceInsufficientErrorCode;
  readonly pageId: string;
  readonly pageTitle: string;
  readonly primaryTokens: readonly string[];
  readonly retryable = false;

  constructor(
    pageId: string,
    pageTitle: string,
    primaryTokens: readonly string[],
  ) {
    super(
      `Hierarchical Wiki evidence is insufficient for page ${pageId} ` +
      `(${pageTitle}); primary tokens: ${primaryTokens.join(', ')}.`,
    );
    this.name = 'HierarchicalWorkflowEvidenceInsufficientError';
    this.code = 'HIERARCHICAL_WORKFLOW_EVIDENCE_INSUFFICIENT';
    this.pageId = pageId;
    this.pageTitle = pageTitle;
    this.primaryTokens = Object.freeze([...primaryTokens]);
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      pageId: this.pageId,
      pageTitle: this.pageTitle,
      primaryTokens: this.primaryTokens,
      retryable: false,
    });
  }
}
