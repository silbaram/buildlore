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
