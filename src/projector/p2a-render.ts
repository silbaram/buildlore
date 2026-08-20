interface P2aSpec {
  readonly implementation: Readonly<Record<string, unknown>>;
  readonly product: Readonly<Record<string, unknown>>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const PRODUCT_SECTIONS = [
  ['problem', '문제'],
  ['target_users', '대상 사용자'],
  ['goals', '목표'],
  ['must_preserve', '유지 조건'],
  ['non_goals', '제외 범위'],
  ['core_flows', '핵심 흐름'],
  ['screens_or_interfaces', '화면 및 인터페이스'],
  ['data_model_draft', '데이터 모델'],
  ['external_integrations', '외부 연동'],
  ['success_criteria', '성공 기준'],
  ['constraints', '제약'],
] as const;

const IMPLEMENTATION_SECTIONS = [
  ['architecture', '아키텍처'],
  ['interfaces', '인터페이스'],
  ['data_flow', '데이터 흐름'],
  ['dependencies', '의존성'],
  ['edge_cases', '엣지 케이스'],
  ['verification', '검증'],
] as const;

function printable(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(printable).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${key}: ${printable(item)}`)
      .join('; ');
  }
  return '';
}

function section(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => `- ${printable(item).replaceAll('\n', '\n  ')}`).join('\n');
  }
  return printable(value);
}

function renderSections(
  title: string,
  record: Readonly<Record<string, unknown>>,
  fields: readonly (readonly [string, string])[],
): string {
  const blocks = [`# ${title}`];
  for (const [key, heading] of fields) {
    blocks.push(`## ${heading}`, section(record[key]));
  }
  return blocks.join('\n\n');
}

export function renderP2aProduct(spec: P2aSpec, iterationId: string): string {
  return renderSections(`제품 명세 — ${iterationId}`, spec.product, PRODUCT_SECTIONS);
}

export function renderP2aImplementation(spec: P2aSpec, iterationId: string): string {
  return renderSections(
    `구현 계획 — ${iterationId}`,
    spec.implementation,
    IMPLEMENTATION_SECTIONS,
  );
}

export function renderP2aIntake(
  intake: Readonly<Record<string, unknown>>,
  iterationId: string,
): string {
  return renderSections(`승인된 인테이크 — ${iterationId}`, intake, [
    ['idea', '아이디어'],
    ['summary', '요약'],
    ['known_facts', '확인된 사실'],
    ['assumptions', '가정'],
    ['clarifying_questions', '확인 질문과 답변'],
    ['needs_user_decision', '남은 사용자 결정'],
  ]);
}

export function renderP2aArchive(
  iteration: Readonly<Record<string, unknown>>,
  closed: Readonly<Record<string, unknown>>,
): string {
  return renderSections(`보관된 반복 — ${String(iteration.iteration_id)}`, {
    closed_at: closed.closed_at,
    idea: iteration.idea,
    status: closed.status,
    task_status_counts: closed.task_status_counts,
  }, [
    ['idea', '아이디어'],
    ['status', '상태'],
    ['closed_at', '종료 시각'],
    ['task_status_counts', '작업 상태'],
  ]);
}
