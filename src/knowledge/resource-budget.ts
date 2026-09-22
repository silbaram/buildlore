/** Content-free diagnostics: no source names, excerpts, digests or caller messages. */
const STAGES = ['legacy-session-sources', 'legacy-session-plan', 'wiki-sources', 'knowledge-input',
  'knowledge-snapshot', 'knowledge-generation', 'wiki-state', 'wiki-run'] as const;
const RESOURCES = ['utf8-bytes', 'sources', 'evidence', 'json-nodes', 'json-depth'] as const;
export interface ResourceBudgetDiagnostic {
  readonly schemaVersion: 'buildlore.resource-budget.v1';
  readonly stage: typeof STAGES[number];
  readonly resource: typeof RESOURCES[number];
  /** Observed usage at rejection, not an estimate of unread input. */
  readonly observed: number;
  readonly maximum: number;
  readonly recoveryAction: 'review-resource-budget-without-dropping-required-content';
}
export function resourceBudget(stage: ResourceBudgetDiagnostic['stage'], resource: ResourceBudgetDiagnostic['resource'],
  observed: number, maximum: number): ResourceBudgetDiagnostic {
  if (!STAGES.includes(stage) || !RESOURCES.includes(resource) || !Number.isSafeInteger(observed) ||
      !Number.isSafeInteger(maximum) || observed < 0 || maximum < 0) throw new Error('Invalid resource budget.');
  return Object.freeze({ schemaVersion: 'buildlore.resource-budget.v1', stage, resource, observed, maximum,
    recoveryAction: 'review-resource-budget-without-dropping-required-content' });
}
/** Copy only validated scalar fields; never evaluate caller getters or spread arbitrary details. */
export function normalizeResourceBudget(value: unknown): ResourceBudgetDiagnostic | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  const scalar = (name: string): unknown => fields[name] && 'value' in fields[name] ? fields[name].value as unknown : undefined;
  const stage = scalar('stage'), resource = scalar('resource'), observed = scalar('observed'), maximum = scalar('maximum');
  if (typeof stage !== 'string' || !STAGES.some(item => item === stage) ||
      typeof resource !== 'string' || !RESOURCES.some(item => item === resource) ||
      typeof observed !== 'number' || typeof maximum !== 'number' ||
      !Number.isSafeInteger(observed) || !Number.isSafeInteger(maximum) || observed < 0 || maximum < 0) return undefined;
  return resourceBudget(stage as ResourceBudgetDiagnostic['stage'], resource as ResourceBudgetDiagnostic['resource'], observed, maximum);
}
export class ResourceBudgetError extends Error {
  readonly code = 'RESOURCE_BUDGET_EXCEEDED';
  readonly diagnostic: ResourceBudgetDiagnostic;
  constructor(stage: ResourceBudgetDiagnostic['stage'], resource: ResourceBudgetDiagnostic['resource'], observed: number, maximum: number) {
    super('Input exceeds the bounded resource limit.');
    this.name = 'ResourceBudgetError';
    this.diagnostic = resourceBudget(stage, resource, observed, maximum);
  }
}
export function enforceResourceBudget(stage: ResourceBudgetDiagnostic['stage'], resource: ResourceBudgetDiagnostic['resource'],
  observed: number, maximum: number): void {
  if (observed > maximum) throw new ResourceBudgetError(stage, resource, observed, maximum);
}
