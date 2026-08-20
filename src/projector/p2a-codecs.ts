import { ProjectionError } from './errors.js';

const PRODUCT_FIELDS = [
  'constraints',
  'core_flows',
  'data_model_draft',
  'external_integrations',
  'goals',
  'must_preserve',
  'non_goals',
  'problem',
  'screens_or_interfaces',
  'success_criteria',
  'target_users',
] as const;
const IMPLEMENTATION_FIELDS = [
  'architecture',
  'data_flow',
  'dependencies',
  'edge_cases',
  'interfaces',
  'verification',
] as const;
const SPEC_FIELDS = new Set([
  'approval', 'approval_audit', 'clarifying_question_disposition', 'evidence',
  'implementation', 'open_decisions', 'product', 'project_id',
  'reference_reconnaissance', 'schema_version', 'source_intake',
  'source_intake_sha256', 'visual_experience',
]);
const INTAKE_FIELDS = new Set([
  'approval_audit', 'assumptions', 'baseline_context', 'clarifying_questions',
  'evidence', 'idea', 'interview', 'known_facts', 'needs_user_decision',
  'schema_version', 'status', 'summary',
]);
const CURRENT_SPEC_FIELDS = new Set([
  'active_iteration', 'closed_iterations', 'composed_at', 'composed_from',
  'composition_conflicts', 'effective_implementation', 'effective_product',
  'effective_spec_ref', 'gate_b_approval_audits', 'gate_b_promoted_at',
  'last_closed_iteration', 'note', 'open_decisions', 'pending_iteration',
  'project_id', 'schema_version', 'skipped_iterations', 'source_specs',
  'superseded_refs',
]);
const ITERATION_FIELDS = new Set([
  'approved_spec_artifacts', 'baseline', 'close', 'closed_at', 'draft_artifacts',
  'drafted_at', 'expected_artifacts', 'idea', 'iteration_id', 'memory_freshness',
  'opened_at', 'optional_artifacts', 'planning_memory', 'project_id', 'promoted_at',
  'schema_version', 'status',
]);
const CLOSED_ITERATION_FIELDS = new Set([
  'artifact_hashes', 'closed_at', 'effective_spec_ref', 'iteration_id', 'spec_ref',
  'status', 'task_count', 'task_graph_ref', 'task_status_counts',
]);

function fail(message: string): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isP2aRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asP2aRecord(value: unknown): Record<string, unknown> {
  if (!isP2aRecord(value)) return fail('A planning artifact is invalid.');
  return value;
}

export function requireP2aString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length < 1) {
    return fail('A planning artifact is invalid.');
  }
  return value;
}

function requireAllowedKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    fail('A planning artifact contains unsupported fields.');
  }
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validAssumption(value: unknown): boolean {
  if (!isP2aRecord(value) || !hasExactKeys(value, [
    'confirmation_needed', 'id', 'risk', 'statement',
  ])) return false;
  return typeof value.id === 'string' && /^A-[0-9]+$/u.test(value.id) &&
    typeof value.statement === 'string' && value.statement.length > 0 &&
    (value.risk === 'low' || value.risk === 'medium' || value.risk === 'high') &&
    typeof value.confirmation_needed === 'boolean';
}

function validClarifyingQuestion(value: unknown): boolean {
  if (!isP2aRecord(value)) return false;
  const allowed = new Set(['answer', 'blocks', 'id', 'question', 'status', 'why_it_matters']);
  return Object.keys(value).every((key) => allowed.has(key)) &&
    typeof value.id === 'string' && /^CQ-[0-9]+$/u.test(value.id) &&
    typeof value.question === 'string' && value.question.length > 0 &&
    typeof value.why_it_matters === 'string' && value.why_it_matters.length > 0 &&
    isStringArray(value.blocks) &&
    (value.status === undefined ||
      value.status === 'open' || value.status === 'answered' ||
      value.status === 'assumed' || value.status === 'not_applicable') &&
    (value.answer === undefined || typeof value.answer === 'string');
}

function validDecisionOption(value: unknown): boolean {
  return isP2aRecord(value) &&
    hasExactKeys(value, ['description', 'id', 'label']) &&
    ['description', 'id', 'label'].every((key) =>
      typeof value[key] === 'string' && value[key].length > 0);
}

function validSupersededField(value: unknown): boolean {
  return isP2aRecord(value) &&
    hasExactKeys(value, ['baseline_value', 'field_ref']) &&
    typeof value.field_ref === 'string' &&
    /^spec\.(?:product|implementation)\.[a-z_]+$/u.test(value.field_ref) &&
    typeof value.baseline_value === 'string' && value.baseline_value.length > 0;
}

function validNeedDecision(value: unknown): boolean {
  if (!isP2aRecord(value)) return false;
  const allowed = new Set([
    'affected_fields', 'answer', 'blocks', 'current_resolution', 'default',
    'disposition', 'id', 'impact', 'options', 'question', 'status', 'supersedes',
  ]);
  const optionalStrings = ['answer', 'current_resolution', 'disposition'] as const;
  return Object.keys(value).every((key) => allowed.has(key)) &&
    typeof value.id === 'string' && /^ND-[0-9]+$/u.test(value.id) &&
    typeof value.question === 'string' && value.question.length > 0 &&
    Array.isArray(value.options) && value.options.length >= 2 &&
    value.options.every(validDecisionOption) &&
    typeof value.impact === 'string' && value.impact.length > 0 &&
    typeof value.default === 'string' && value.default.length > 0 &&
    (value.status === 'open' || value.status === 'answered' || value.status === 'deferred') &&
    (value.blocks === undefined || isStringArray(value.blocks)) &&
    (value.affected_fields === undefined ||
      (isStringArray(value.affected_fields) && value.affected_fields.every((field) =>
        /^spec\.(?:product|implementation)\.[a-z_]+$/u.test(field)))) &&
    optionalStrings.every((key) => value[key] === undefined ||
      (typeof value[key] === 'string' && value[key].length > 0)) &&
    (value.supersedes === undefined ||
      (Array.isArray(value.supersedes) && value.supersedes.length > 0 &&
        value.supersedes.every(validSupersededField)));
}

function validEvidence(value: unknown): boolean {
  return isP2aRecord(value) &&
    hasExactKeys(value, ['source_id', 'title', 'url', 'used_for']) &&
    typeof value.source_id === 'string' && /^(?:WEB|USER|LOCAL)-[0-9]+$/u.test(value.source_id) &&
    typeof value.title === 'string' && value.title.length > 0 &&
    typeof value.url === 'string' &&
    typeof value.used_for === 'string' && value.used_for.length > 0;
}

function requireView(
  value: unknown,
  expectedFields: readonly string[],
  stringFields: readonly string[] = [],
): Record<string, unknown> {
  const record = asP2aRecord(value);
  if (
    !hasExactKeys(record, expectedFields) ||
    expectedFields.some((field) =>
      stringFields.includes(field)
        ? typeof record[field] !== 'string'
        : !isStringArray(record[field]))
  ) return fail('A P2A specification view is invalid.');
  return record;
}

export function validateP2aSpec(
  record: Record<string, unknown>,
  projectId: string,
): { readonly implementation: Record<string, unknown>; readonly product: Record<string, unknown> } {
  requireAllowedKeys(record, SPEC_FIELDS);
  if (
    record.schema_version !== 'p2a.spec.v1' || record.project_id !== projectId ||
    record.approval !== 'approved' || typeof record.source_intake !== 'string' ||
    typeof record.source_intake_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.source_intake_sha256) ||
    !Array.isArray(record.clarifying_question_disposition) ||
    !Array.isArray(record.evidence) || !Array.isArray(record.open_decisions) ||
    record.open_decisions.length > 0
  ) return fail('A P2A specification is not eligible.');
  return {
    implementation: requireView(record.implementation, IMPLEMENTATION_FIELDS),
    product: requireView(record.product, PRODUCT_FIELDS, ['problem']),
  };
}

export function validateP2aIntake(record: Record<string, unknown>): void {
  requireAllowedKeys(record, INTAKE_FIELDS);
  if (
    record.schema_version !== 'p2a.intake.v1' ||
    typeof record.idea !== 'string' || record.idea.length < 1 ||
    typeof record.summary !== 'string' || record.summary.length < 1 ||
    !isStringArray(record.known_facts) ||
    !Array.isArray(record.assumptions) || !record.assumptions.every(validAssumption) ||
    !Array.isArray(record.clarifying_questions) ||
    !record.clarifying_questions.every(validClarifyingQuestion) ||
    !Array.isArray(record.needs_user_decision) ||
    !record.needs_user_decision.every(validNeedDecision) ||
    (record.status !== 'blocked_on_user' && record.status !== 'ready_for_spec') ||
    !Array.isArray(record.evidence) || !record.evidence.every(validEvidence)
  ) fail('A P2A intake schema is unsupported.');
}

export function validateP2aCurrentSpec(
  record: Record<string, unknown>,
  projectId: string,
): asserts record is Record<string, unknown> & { readonly closed_iterations: readonly unknown[] } {
  requireAllowedKeys(record, CURRENT_SPEC_FIELDS);
  if (
    record.schema_version !== 'p2a.current_spec.v1' ||
    record.project_id !== projectId ||
    !Array.isArray(record.closed_iterations)
  ) fail('The P2A current specification is invalid.');
}

export function validateP2aClosedIteration(record: Record<string, unknown>): void {
  requireAllowedKeys(record, CLOSED_ITERATION_FIELDS);
}

export function validateP2aIteration(
  record: Record<string, unknown>,
  projectId: string,
  iterationId: string,
): void {
  requireAllowedKeys(record, ITERATION_FIELDS);
  if (
    record.schema_version !== 'p2a.iteration_metadata.v1' ||
    record.project_id !== projectId || record.iteration_id !== iterationId ||
    (record.idea !== undefined &&
      (typeof record.idea !== 'string' || record.idea.length < 1))
  ) fail('P2A iteration metadata is invalid.');
}

export function validP2aTaskStatusCounts(value: unknown): boolean {
  if (!isP2aRecord(value) || !hasExactKeys(value, ['blocked', 'done', 'in_progress', 'todo'])) {
    return false;
  }
  return Object.values(value).every((count) =>
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0);
}
