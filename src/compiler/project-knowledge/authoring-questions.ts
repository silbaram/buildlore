import { boundedJson, choice, identifier, invalid, keys, list, portablePath, record, text } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgePageRole, KnowledgeProposalV1, KnowledgeSnapshotV1 } from '../../knowledge/project-knowledge/types.js';
import { inspectKnowledgeQuestionCoverage, inspectKnowledgeQuestionCoverageWithHistory, type KnowledgeQuestionCoverageV1 } from './question-coverage.js';
import type { VerifiedKnowledgeHistory } from '../../retrieval/project-knowledge-history-store.js';

export const DEVELOPMENT_MEMORY_AXES = Object.freeze(['purpose', 'architecture', 'decisions', 'current-state', 'failures-open-work'] as const);
export type DevelopmentMemoryAxis = typeof DEVELOPMENT_MEMORY_AXES[number];
export interface DevelopmentMemoryContentProfile {
  readonly id: 'development-memory-v1';
  readonly axis: DevelopmentMemoryAxis;
}
const MEMORY_ROLES: Readonly<Record<DevelopmentMemoryAxis, KnowledgePageRole>> = Object.freeze({
  purpose: 'overview', architecture: 'architecture', decisions: 'decisions', 'current-state': 'overview', 'failures-open-work': 'decisions',
});

export interface KnowledgeAuthoringQuestion {
  readonly id: string;
  readonly question: string;
  readonly role: KnowledgePageRole;
  readonly contentProfile?: DevelopmentMemoryContentProfile;
  readonly requirements: readonly Readonly<{
    id: string; sourceRef: string; jsonPointer: string | null; contentKind: 'any' | 'json-value' | 'text';
  }>[];
}

export type KnowledgeAuthoringRequirement = KnowledgeAuthoringQuestion['requirements'][number];

/** The caller must first parse the complete question set. */
export function isDevelopmentMemoryProfile(questions: readonly KnowledgeAuthoringQuestion[]): boolean {
  return questions.some(question => question.contentProfile !== undefined);
}

export interface KnowledgeQuestionAnswerMapping {
  readonly id: string;
  readonly claimIds: readonly string[];
}

/** Caller-owned project questions, fixed before authoring; never inferred from a producer name. */
export function parseKnowledgeAuthoringQuestions(value: unknown): readonly KnowledgeAuthoringQuestion[] {
  const questions = list(boundedJson(value), 64).map(item => {
    const q = record(item);
    keys(q, ['id', 'question', 'role', 'requirements', ...(Object.hasOwn(q, 'contentProfile') ? ['contentProfile'] : [])]);
    let contentProfile: DevelopmentMemoryContentProfile | undefined;
    if (Object.hasOwn(q, 'contentProfile')) {
      const profile = record(q.contentProfile);
      keys(profile, ['id', 'axis']);
      if (profile.id !== 'development-memory-v1') invalid();
      contentProfile = Object.freeze({ id: 'development-memory-v1', axis: choice(profile.axis, DEVELOPMENT_MEMORY_AXES) });
      if (q.role !== MEMORY_ROLES[contentProfile.axis]) invalid();
    }
    const requirements = list(q.requirements, 256).map(item => {
      const r = record(item);
      keys(r, ['id', 'sourceRef', 'jsonPointer', 'contentKind']);
      const pointer = r.jsonPointer === null ? null : r.jsonPointer === '' ? '' : text(r.jsonPointer, 4096);
      if (pointer !== null && pointer !== '' && (!pointer.startsWith('/') || /~(?![01])/u.test(pointer))) invalid();
      return Object.freeze({ id: identifier(r.id), sourceRef: portablePath(r.sourceRef), jsonPointer: pointer,
        contentKind: choice(r.contentKind, ['any', 'json-value', 'text']) });
    });
    if ((requirements.length === 0 && contentProfile === undefined) || new Set(requirements.map(r => r.id)).size !== requirements.length) invalid();
    return Object.freeze({ id: identifier(q.id), question: text(q.question, 4096),
      role: choice(q.role, ['overview', 'architecture', 'decisions']), requirements: Object.freeze(requirements),
      ...(contentProfile === undefined ? {} : { contentProfile }) });
  });
  if (questions.length === 0 || new Set(questions.map(q => q.id)).size !== questions.length ||
      questions.reduce((sum, q) => sum + q.requirements.length, 0) > 256) invalid();
  if (isDevelopmentMemoryProfile(questions) && (questions.length !== DEVELOPMENT_MEMORY_AXES.length ||
    questions.some(q => q.contentProfile === undefined) ||
    new Set(questions.map(q => q.contentProfile?.axis)).size !== DEVELOPMENT_MEMORY_AXES.length)) invalid();
  return Object.freeze(questions);
}

export function parseKnowledgeQuestionAnswers(value: unknown,
  questions: readonly KnowledgeAuthoringQuestion[]): readonly KnowledgeQuestionAnswerMapping[] {
  if (isDevelopmentMemoryProfile(questions)) parseKnowledgeAuthoringQuestions(questions);
  const answers = list(boundedJson(value), 64).map(item => {
    const answer = record(item);
    keys(answer, ['id', 'claimIds']);
    const question = questions.find(q => q.id === answer.id) ?? invalid();
    const unassessed = question.contentProfile !== undefined && question.requirements.length === 0;
    const claimIds = list(answer.claimIds, 256).map(identifier);
    if ((unassessed ? claimIds.length !== 0 : claimIds.length === 0) || new Set(claimIds).size !== claimIds.length) invalid();
    return Object.freeze({ id: identifier(answer.id), claimIds: Object.freeze(claimIds) });
  });
  if (answers.length !== questions.length || new Set(answers.map(a => a.id)).size !== answers.length ||
      answers.some(a => !questions.some(q => q.id === a.id))) invalid();
  return Object.freeze(answers);
}

/** Structural source coverage only. Reviewers still judge whether the cited claims answer the question. */
export function inspectKnowledgeAuthoringCoverage(snapshot: KnowledgeSnapshotV1, proposal: KnowledgeProposalV1,
  questions: readonly KnowledgeAuthoringQuestion[], answersValue: unknown,
  previousGenerations?: unknown): KnowledgeQuestionCoverageV1 {
  return inspectKnowledgeQuestionCoverage(snapshot, proposal, authoringMappings(proposal, questions, answersValue),
    snapshot.projectId, previousGenerations);
}

export async function inspectKnowledgeAuthoringCoverageWithHistory(snapshot: KnowledgeSnapshotV1, proposal: KnowledgeProposalV1,
  questions: readonly KnowledgeAuthoringQuestion[], answersValue: unknown,
  history: VerifiedKnowledgeHistory | null | Promise<VerifiedKnowledgeHistory | null>): Promise<KnowledgeQuestionCoverageV1> {
  return await inspectKnowledgeQuestionCoverageWithHistory(snapshot, proposal,
    authoringMappings(proposal, questions, answersValue), snapshot.projectId, history);
}

function authoringMappings(proposal: KnowledgeProposalV1,
  questions: readonly KnowledgeAuthoringQuestion[], answersValue: unknown) {
  const answers = parseKnowledgeQuestionAnswers(answersValue, questions);
  return questions.map(q => {
    const answer = answers.find(a => a.id === q.id) ?? invalid();
    const page = proposal.pages.find(p => p.role === q.role) ?? invalid();
    const claimIds = new Set(page.sections.flatMap(s => s.claims.map(c => c.claimId)));
    if (answer.claimIds.some(id => !claimIds.has(id))) invalid();
    return { id: q.id, claimIds: answer.claimIds, requirements: q.requirements };
  });
}

export const KNOWLEDGE_QUESTION_AUTHORING_INSTRUCTIONS: readonly string[] = Object.freeze([
  'Answer the caller-defined authoringQuestions in their assigned pages. Submit questionAnswers mapping every question id to the claims that answer it.',
  'For each question, inspect the declared source requirements before writing. Report unavailable or heading-only evidence; never invent missing source content.',
  'Describe the selected project: component responsibilities, public interfaces, end-to-end workflows, development commands, verification limits and unresolved work when supported by its sources.',
  'Use the selected project\'s own names and paths. The Wiki generator\'s implementation, policies and workflow are not facts about the selected project.',
  'In decisions, explain supported reasons, alternatives, consequences and changes. Repeating an overview statement with a decision label adds no explanation; do not invent a missing rationale.',
  'Keep source observations, documented intentions, inference and executed verification distinct. A test file or a passed field alone does not prove the current checkout was tested.',
  'Use short claims that answer the question and preserve exact values and commands where relevant. Cite only evidence needed for those claims.',
  'Independent review must check whether each mapped answer addresses its question and required details. Structural coverage is not proof of semantic completeness.',
]);
