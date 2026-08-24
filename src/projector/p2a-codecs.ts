import { ProjectionError } from './errors.js';
import { normalizeRfc3339Instant } from './timestamp.js';

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
  'gate_b_promotion_bindings',
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
const ASSUMPTION_FIELDS = new Set([
  'confirmation_needed', 'id', 'risk', 'statement',
]);
const CLARIFYING_QUESTION_FIELDS = new Set([
  'answer', 'blocks', 'id', 'question', 'status', 'why_it_matters',
]);
const EVIDENCE_FIELDS = new Set(['source_id', 'title', 'url', 'used_for']);
const GATE_B_PROMOTION_BINDING_FIELDS = [
  'promoted_at', 'source_spec_ref', 'source_spec_sha256',
] as const;
const ITERATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SPEC_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const COMPATIBILITY_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const CREDENTIAL_FIELD_PATTERN =
  /(?:^|[-_.])(?:api[-_.]?key|auth|authorization|basic|bearer|cookies?|credentials?|jwt|keys?|pass(?:word|wd)?|private[-_.]?key|secrets?|sessions?|ssh|tokens?)(?:$|[-_.])/iu;

export interface P2aCodecCompatibilityFinding {
  readonly fieldName?: string;
}

export interface P2aGateBPromotionBinding {
  readonly promotedAt: string;
  readonly sourceSpecRef: string;
  readonly sourceSpecSha256: string;
}

export class P2aDocumentCompatibilityError extends ProjectionError {
  constructor() {
    super('PROJECTION_ARTIFACT_INVALID', 'A planning document is incompatible.');
    this.name = 'P2aDocumentCompatibilityError';
  }
}

function fail(message: string): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', message);
}

function failDocument(): never {
  throw new P2aDocumentCompatibilityError();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSafeP2aCompatibilityFieldName(value: string): boolean {
  if (!COMPATIBILITY_FIELD_PATTERN.test(value)) return false;
  const segmented = value.replace(/([a-z0-9])([A-Z])/gu, '$1-$2');
  return !CREDENTIAL_FIELD_PATTERN.test(segmented);
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

function compatibilityFindings(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): readonly P2aCodecCompatibilityFinding[] {
  return Object.keys(record)
    .filter((key) => !allowed.has(key))
    .sort(compareText)
    .map((key) => isSafeP2aCompatibilityFieldName(key)
      ? Object.freeze({ fieldName: key })
      : Object.freeze({}));
}

function knownView(
  record: Readonly<Record<string, unknown>>,
  fields: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => fields.has(key)),
  );
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
  if (!isP2aRecord(value)) return false;
  return typeof value.id === 'string' && /^A-[0-9]+$/u.test(value.id) &&
    typeof value.statement === 'string' && value.statement.length > 0 &&
    (value.risk === 'low' || value.risk === 'medium' || value.risk === 'high') &&
    typeof value.confirmation_needed === 'boolean';
}

function validClarifyingQuestion(value: unknown): boolean {
  if (!isP2aRecord(value)) return false;
  return typeof value.id === 'string' && /^CQ-[0-9]+$/u.test(value.id) &&
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
    typeof value.source_id === 'string' && /^(?:WEB|USER|LOCAL)-[0-9]+$/u.test(value.source_id) &&
    typeof value.title === 'string' && value.title.length > 0 &&
    typeof value.url === 'string' &&
    typeof value.used_for === 'string' && value.used_for.length > 0;
}

function requireView(
  value: unknown,
  expectedFields: readonly string[],
  stringFields: readonly string[] = [],
): {
  readonly findings: readonly P2aCodecCompatibilityFinding[];
  readonly view: Record<string, unknown>;
} {
  if (!isP2aRecord(value)) return failDocument();
  const record = value;
  if (
    expectedFields.some((field) =>
      stringFields.includes(field)
        ? typeof record[field] !== 'string'
        : !isStringArray(record[field]))
  ) return failDocument();
  return {
    findings: compatibilityFindings(record, new Set(expectedFields)),
    view: Object.fromEntries(expectedFields.map((field) => [field, record[field]])),
  };
}

export function validateP2aSpec(
  record: Record<string, unknown>,
  projectId: string,
): {
  readonly findings: readonly P2aCodecCompatibilityFinding[];
  readonly implementation: Record<string, unknown>;
  readonly product: Record<string, unknown>;
} {
  requireAllowedKeys(record, SPEC_FIELDS);
  if (
    record.schema_version !== 'p2a.spec.v1' || record.project_id !== projectId ||
    record.approval !== 'approved' || typeof record.source_intake !== 'string' ||
    typeof record.source_intake_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.source_intake_sha256) ||
    !Array.isArray(record.clarifying_question_disposition) ||
    !Array.isArray(record.evidence) || !Array.isArray(record.open_decisions) ||
    !isP2aRecord(record.implementation) || !isP2aRecord(record.product) ||
    record.open_decisions.length > 0
  ) return fail('A P2A specification is not eligible.');
  const implementation = requireView(record.implementation, IMPLEMENTATION_FIELDS);
  const product = requireView(record.product, PRODUCT_FIELDS, ['problem']);
  return {
    findings: Object.freeze([...implementation.findings, ...product.findings]),
    implementation: implementation.view,
    product: product.view,
  };
}

export function validateP2aIntake(
  record: Record<string, unknown>,
): {
  readonly findings: readonly P2aCodecCompatibilityFinding[];
  readonly intake: Record<string, unknown>;
} {
  requireAllowedKeys(record, INTAKE_FIELDS);
  if (
    record.schema_version !== 'p2a.intake.v1' ||
    (record.status !== 'blocked_on_user' && record.status !== 'ready_for_spec')
  ) fail('A P2A intake schema is unsupported.');
  if (
    typeof record.idea !== 'string' || record.idea.length < 1 ||
    typeof record.summary !== 'string' || record.summary.length < 1 ||
    !isStringArray(record.known_facts) ||
    !Array.isArray(record.assumptions) || !Array.isArray(record.clarifying_questions) ||
    !Array.isArray(record.needs_user_decision) ||
    !record.needs_user_decision.every(validNeedDecision) ||
    !Array.isArray(record.evidence)
  ) fail('A P2A intake schema is unsupported.');
  if (
    !record.assumptions.every(validAssumption) ||
    !record.clarifying_questions.every(validClarifyingQuestion) ||
    !record.evidence.every(validEvidence)
  ) failDocument();
  const nested = [
    ...record.assumptions.map((value) => [value, ASSUMPTION_FIELDS] as const),
    ...record.clarifying_questions.map((value) => [value, CLARIFYING_QUESTION_FIELDS] as const),
    ...record.evidence.map((value) => [value, EVIDENCE_FIELDS] as const),
  ];
  return {
    findings: Object.freeze(nested.flatMap(([value, allowed]) =>
      isP2aRecord(value) ? compatibilityFindings(value, allowed) : [])),
    intake: {
      idea: record.idea,
      summary: record.summary,
      known_facts: record.known_facts,
      assumptions: record.assumptions.map((value: unknown) => {
        if (!isP2aRecord(value)) return failDocument();
        return knownView(value, ASSUMPTION_FIELDS);
      }),
      clarifying_questions: record.clarifying_questions.map((value: unknown) => {
        if (!isP2aRecord(value)) return failDocument();
        return knownView(value, CLARIFYING_QUESTION_FIELDS);
      }),
      needs_user_decision: record.needs_user_decision,
    },
  };
}

export function validateP2aCurrentSpec(
  record: Record<string, unknown>,
  projectId: string,
): {
  readonly closedIterations: readonly unknown[];
  readonly gateBPromotionBindings: ReadonlyMap<string, P2aGateBPromotionBinding>;
} {
  requireAllowedKeys(record, CURRENT_SPEC_FIELDS);
  if (
    record.schema_version !== 'p2a.current_spec.v1' ||
    record.project_id !== projectId ||
    !Array.isArray(record.closed_iterations)
  ) fail('The P2A current specification is invalid.');
  const rawBindings = record.gate_b_promotion_bindings;
  if (rawBindings !== undefined && !isP2aRecord(rawBindings)) {
    return fail('The P2A current specification is invalid.');
  }
  const bindings = new Map<string, P2aGateBPromotionBinding>();
  for (const [iterationId, value] of Object.entries(rawBindings ?? {}).sort(([left], [right]) =>
    compareText(left, right))) {
    if (
      iterationId.length > 120 || !ITERATION_ID_PATTERN.test(iterationId) ||
      !isP2aRecord(value) || !hasExactKeys(value, GATE_B_PROMOTION_BINDING_FIELDS)
    ) return fail('A Gate B promotion binding is invalid.');
    const expectedRef = `iterations/${iterationId}/gate-b-spec/spec.json`;
    const promotedAt = normalizeRfc3339Instant(value.promoted_at);
    if (
      value.source_spec_ref !== expectedRef ||
      typeof value.source_spec_sha256 !== 'string' ||
      !SPEC_DIGEST_PATTERN.test(value.source_spec_sha256) ||
      promotedAt === null || promotedAt !== value.promoted_at
    ) return fail('A Gate B promotion binding is invalid.');
    bindings.set(iterationId, Object.freeze({
      promotedAt,
      sourceSpecRef: expectedRef,
      sourceSpecSha256: value.source_spec_sha256,
    }));
  }
  return {
    closedIterations: record.closed_iterations,
    gateBPromotionBindings: bindings,
  };
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
