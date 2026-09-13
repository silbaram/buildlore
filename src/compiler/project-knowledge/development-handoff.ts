import { boundedJson, keys, record } from '../../knowledge/project-knowledge/guards.js';
import { parseKnowledgeAuthoringQuestions, type KnowledgeAuthoringQuestion } from './authoring-questions.js';
import { DEVELOPMENT_MEMORY_AXES, type DevelopmentMemoryAxis, type KnowledgeAuthoringRequirement } from './authoring-questions.js';

const QUESTIONS = Object.freeze([
  { id: 'purpose', role: 'overview', question: 'What does this project currently provide, for whom, and what is outside its supported or confirmed scope?' },
  { id: 'architecture', role: 'architecture', question: 'How does a core workflow connect its entry point, actors, processing, input/output contracts and failure handling? Explain in this answer who performs each stage and which checks precede external transfer or persisted output. Where should a developer make a related change, and which callers, configuration and tests need checking?' },
  { id: 'current-state', role: 'overview', question: 'What is planned, implemented and actually verified? Give current commands and settings, distinguish completion declarations from execution evidence, and identify verified revision/scope and unresolved work.' },
  { id: 'decisions', role: 'decisions', question: 'Why were important choices made? Connect the recorded problem, choice, alternatives, constraints and consequences across relevant documents. Mark missing reasons as unknown instead of inferring historical intent from code.' },
  { id: 'changes', role: 'decisions', question: 'What changed between the available revisions? Connect previous state, current state, recorded reason, changed and preserved behavior, verification and remaining work by development topic, not by source file. Include supported non-runtime changes such as documentation, authoring guidance and development process; coverage in another answer does not complete this answer. Include preserved normal responses and error contracts when supported. State the exact version and behavior covered by each verification reference without extending it to related versions. Preserve supported supersessions and conflicts; missing evidence alone is not feature removal.' },
]);

/** Caller selects sanitized-source requirements; this does not discover files or infer a producer.
 * The resulting ordinary questions use the existing v3 purpose contract unchanged.
 */
export function createDevelopmentHandoffQuestions(value: unknown): readonly KnowledgeAuthoringQuestion[] {
  const requirements = record(boundedJson(value));
  keys(requirements, QUESTIONS.map(question => question.id));
  return parseKnowledgeAuthoringQuestions(QUESTIONS.map(question => ({ ...question, requirements: requirements[question.id] })));
}

/** Opt-in profile; an empty selection means unassessed, never proof of missing project knowledge. */
export function createDevelopmentMemoryQuestions(
  selection: Readonly<Record<DevelopmentMemoryAxis, readonly KnowledgeAuthoringRequirement[]>>,
): readonly KnowledgeAuthoringQuestion[] {
  const input = record(boundedJson(selection));
  keys(input, DEVELOPMENT_MEMORY_AXES);
  return parseKnowledgeAuthoringQuestions(DEVELOPMENT_MEMORY_AXES.map(axis => {
    const question = axis === 'failures-open-work'
      ? { id: axis, role: 'decisions', question: 'What failures, rejected approaches, unresolved problems and next work are recorded? Explain their conditions, known causes, consequences, verification limits and what remains unknown. Do not invent failure history or infer that none exists from an empty selection.' }
      : QUESTIONS.find(question => question.id === axis);
    return { ...question, requirements: input[axis], contentProfile: { id: 'development-memory-v1', axis } };
  }));
}

export const DEVELOPMENT_MEMORY_AUTHORING_INSTRUCTIONS: readonly string[] = Object.freeze([
  'The development-memory-v1 profile covers five explicit knowledge axes. For an axis with no selected requirements, submit an empty claimIds array and leave it unassessed; do not invent facts or assert that the project has no such knowledge.',
  'For selected axes, map grounded claims in the assigned page and cover every declared requirement. Include supported conditions, exceptions, reasons, exact verification scope and unknowns in the prose itself.',
  'Development memory inspection reports declared source and claim links, not semantic correctness or sufficient coverage of the whole project. Independent review and task evaluation must assess those separately.',
]);

export const DEVELOPMENT_HANDOFF_INSPECTION_GUIDE: readonly string[] = Object.freeze([
  'Check coverage before drafting. source-not-selected means unavailable in this snapshot, not absent from the repository. detail-unavailable or heading-only does not prove that the original source lacks the information. Do not guess whether filtering, masking or missing original content caused the gap.',
  'Required source coverage is a starting point, not a ceiling. Find and read supplementary selected documents, JSON records and code needed to answer current state, changes, decision reasons and open work. Request an explicit source-selection update when needed; do not silently expand collection.',
  'Synthesize by development topic: previous state -> change -> recorded reason -> impact -> verification -> remaining work. Link existing facts with explicit reviewed supersessions/conflicts only when the evidence supports them; preserve unknown ordering and concurrent scopes.',
  'For core workflows inspect entry points, relevant callers/callees, input/output contracts, configuration, failure paths and tests. Explain change locations and dependent checks. Do not claim whole-repository analysis, execution or historical intent from code reading.',
  'Review accuracy and information sufficiency separately. An honest unknown avoids invention but does not satisfy a mandatory answer that available evidence supports. Identify omitted supported detail, source gaps and the evidence needed to resolve each unknown.',
  'Make each mapped answer self-contained for its question. Do not rely on another answer to supply relevant actors, trust boundaries or prerequisites before external transfer and persistence. Describe the selected project\'s actors and checks, not the Wiki generator\'s workflow unless it is the selected subject.',
  'For each change, extract both changed and unchanged behavior from the evidence. Preserve supported normal responses, error contracts, compatibility conditions and exceptions in the Wiki itself; an evidence ID alone does not convey these details. Mark missing preservation evidence as unknown, not as a guarantee of compatibility.',
  'Separate a compatibility promise from a test definition and an executed result. Keep each verification claim bound to its exact version, input, behavior and revision; evidence for one version does not verify another. Independent review must check these qualifiers for each mapped answer, including details available in sources but absent from the Wiki.',
  'Before drafting each answer, inventory its supported topics across available source or Wiki sections, including documentation, authoring guidance and development-process changes, not only runtime features. Map each topic to a cited sentence in that answer; coverage in another answer does not count. Reconcile the inventory before submission; omit unsupported topics and state relevant evidence gaps. This is a completeness check, not quality certification.',
]);
