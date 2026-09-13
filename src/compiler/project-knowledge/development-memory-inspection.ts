import { parseKnowledgeSnapshot } from '../../knowledge/project-knowledge/evidence.js';
import { boundedJson, digest, invalid, list } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeEvidenceV1, KnowledgeGenerationV1, KnowledgePageRole,
  KnowledgeProposalV1, KnowledgeRecordV1, KnowledgeSnapshotV1 } from '../../knowledge/project-knowledge/types.js';
import { requireVerifiedKnowledgeHistory, type VerifiedKnowledgeHistory } from '../../retrieval/project-knowledge-history-store.js';
import { parseKnowledgeGenerationChain } from './generation.js';
import { parseKnowledgeProposal } from './proposal.js';
import { DEVELOPMENT_MEMORY_AXES, inspectKnowledgeAuthoringCoverage, inspectKnowledgeAuthoringCoverageWithHistory,
  isDevelopmentMemoryProfile, parseKnowledgeAuthoringQuestions, parseKnowledgeQuestionAnswers, type DevelopmentMemoryAxis,
  type KnowledgeAuthoringQuestion, type KnowledgeAuthoringRequirement } from './authoring-questions.js';
import type { KnowledgeQuestionCoverageV1 } from './question-coverage.js';

type StructuralStatus = 'covered' | 'incomplete' | 'unassessed';
type CoverageRequirement = KnowledgeQuestionCoverageV1['questions'][number]['requirements'][number];
type MemoryEvidenceLink = Readonly<Pick<KnowledgeEvidenceV1, 'evidenceId' | 'sourceRef' | 'locator' |
  'sourceRevision' | 'codeRevision'> & { presentInCurrentSnapshot: boolean }>;
type MemoryFactLink = Readonly<Pick<KnowledgeRecordV1, 'classification' | 'lifecycle' | 'reviewStatus' |
  'scope' | 'supersededBy'> & { factId: KnowledgeDigest; evidence: readonly MemoryEvidenceLink[] }>;

export interface DevelopmentMemoryInspectionV1 {
  readonly schemaVersion: 'buildlore.development-memory-inspection.v1';
  readonly projectId: string;
  readonly snapshotDigest: KnowledgeDigest;
  readonly proposalDigest: KnowledgeDigest;
  readonly questionsDigest: KnowledgeDigest;
  readonly profileDigest: KnowledgeDigest;
  readonly structuralStatus: StructuralStatus;
  readonly semanticReviewRequired: true;
  readonly axes: readonly Readonly<{
    axis: DevelopmentMemoryAxis; questionId: string; role: KnowledgePageRole;
    requirementSelection: 'selected' | 'unassessed'; structuralStatus: StructuralStatus;
    requirements: readonly Readonly<CoverageRequirement & KnowledgeAuthoringRequirement & {
      sourceStatus: 'available' | 'heading-only' | 'source-not-selected' | 'detail-unavailable';
    }>[];
    links: readonly Readonly<{ claimId: string; pageRole: KnowledgePageRole; sectionIndex: number; claimIndex: number;
      facts: readonly MemoryFactLink[] }>[];
    semanticReviewRequired: true;
  }>[];
  readonly inspectionDigest: KnowledgeDigest;
}

/** Structure and exact locations only; this does not judge the meaning or completeness of prose. */
export function inspectDevelopmentMemoryContent(snapshot: KnowledgeSnapshotV1, proposal: KnowledgeProposalV1,
  questionsValue: readonly KnowledgeAuthoringQuestion[], answers: unknown,
  previousGenerations?: unknown): DevelopmentMemoryInspectionV1 {
  const questions = parseKnowledgeAuthoringQuestions(questionsValue);
  if (!isDevelopmentMemoryProfile(questions)) invalid();
  const chain = previousGenerations === undefined ? [] : list(boundedJson(previousGenerations), 64);
  const previous = chain.length === 0 ? null : parseKnowledgeGenerationChain(chain, snapshot.projectId).at(-1) ?? null;
  const selected = selectedMappings(questions, answers);
  const coverage = selected.questions.length === 0 ? null
    : inspectKnowledgeAuthoringCoverage(snapshot, proposal, selected.questions, selected.answers, chain);
  return inspect(snapshot, proposal, questions, coverage, previous);
}

export async function inspectDevelopmentMemoryContentWithHistory(snapshot: KnowledgeSnapshotV1, proposal: KnowledgeProposalV1,
  questionsValue: readonly KnowledgeAuthoringQuestion[], answers: unknown,
  history: VerifiedKnowledgeHistory | null | Promise<VerifiedKnowledgeHistory | null>): Promise<DevelopmentMemoryInspectionV1> {
  const questions = parseKnowledgeAuthoringQuestions(questionsValue);
  if (!isDevelopmentMemoryProfile(questions)) invalid();
  const verified = await history;
  const previous = verified === null ? null : requireVerifiedKnowledgeHistory(verified, snapshot.projectId).latest;
  const selected = selectedMappings(questions, answers);
  const coverage = selected.questions.length === 0 ? null
    : await inspectKnowledgeAuthoringCoverageWithHistory(snapshot, proposal, selected.questions, selected.answers, verified);
  return inspect(snapshot, proposal, questions, coverage, previous);
}

function selectedMappings(questions: readonly KnowledgeAuthoringQuestion[], value: unknown) {
  const answers = parseKnowledgeQuestionAnswers(value, questions);
  const selected = questions.filter(q => q.requirements.length > 0).map(question => {
    const { contentProfile, ...ordinary } = question;
    void contentProfile;
    return ordinary;
  });
  return { questions: selected, answers: answers.filter(answer => selected.some(q => q.id === answer.id)) };
}

function inspect(snapshotValue: KnowledgeSnapshotV1, proposalValue: KnowledgeProposalV1,
  questions: readonly KnowledgeAuthoringQuestion[], coverage: KnowledgeQuestionCoverageV1 | null,
  previous: KnowledgeGenerationV1 | null): DevelopmentMemoryInspectionV1 {
  const snapshot = parseKnowledgeSnapshot(snapshotValue, snapshotValue.projectId);
  const proposal = parseKnowledgeProposal(proposalValue, snapshot);
  if (proposal.baselineGenerationDigest !== (previous?.generationDigest ?? null)) invalid();
  const facts = new Map([...(previous?.records ?? []), ...proposal.facts].map(fact => [fact.id, fact]));
  const evidence = new Map([...(previous?.evidence ?? []), ...snapshot.evidence].map(item => [item.evidenceId, item]));
  const currentEvidence = new Set(snapshot.evidence.map(item => item.evidenceId));
  const locations = new Map(proposal.pages.flatMap(page => page.sections.flatMap((section, sectionIndex) =>
    section.claims.map((claim, claimIndex) => [claim.claimId, { claim, pageRole: page.role, sectionIndex, claimIndex }] as const))));
  const axes = DEVELOPMENT_MEMORY_AXES.map(axis => {
    const question = questions.find(q => q.contentProfile?.axis === axis) ?? invalid();
    const selected = question.requirements.length > 0;
    const covered = selected ? coverage?.questions.find(q => q.id === question.id) ?? invalid() : null;
    const requirements = question.requirements.map(requirement => {
      const item = covered?.requirements.find(item => item.id === requirement.id) ?? invalid();
      const sourceSelected = snapshot.sources.some(source => source.sourceRef === requirement.sourceRef ||
        source.origins?.some(origin => origin.sourceRef === requirement.sourceRef));
      return Object.freeze({ ...requirement, ...item, sourceStatus: item.status === 'unavailable'
        ? sourceSelected ? 'detail-unavailable' as const : 'source-not-selected' as const
        : item.status === 'heading-only' ? 'heading-only' as const : 'available' as const });
    });
    const links = (covered?.claimIds ?? []).map(claimId => {
      const location = locations.get(claimId) ?? invalid();
      const linkedFacts = location.claim.factIds.map(factId => {
        const fact = facts.get(factId) ?? invalid();
        if (fact.projectId !== snapshot.projectId) invalid();
        const linkedEvidence = fact.evidenceIds.map(evidenceId => {
          const item = evidence.get(evidenceId) ?? invalid();
          if (item.projectId !== snapshot.projectId) invalid();
          return Object.freeze({ evidenceId, sourceRef: item.sourceRef, locator: item.locator,
            presentInCurrentSnapshot: currentEvidence.has(evidenceId), sourceRevision: item.sourceRevision, codeRevision: item.codeRevision });
        });
        return Object.freeze({ factId: fact.id, classification: fact.classification, lifecycle: fact.lifecycle,
          reviewStatus: fact.reviewStatus, scope: fact.scope, supersededBy: fact.supersededBy, evidence: Object.freeze(linkedEvidence) });
      });
      return Object.freeze({ claimId, pageRole: location.pageRole, sectionIndex: location.sectionIndex,
        claimIndex: location.claimIndex, facts: Object.freeze(linkedFacts) });
    });
    return Object.freeze({ axis, questionId: question.id, role: question.role,
      requirementSelection: selected ? 'selected' as const : 'unassessed' as const,
      structuralStatus: !selected ? 'unassessed' as const : covered?.complete ? 'covered' as const : 'incomplete' as const,
      requirements: Object.freeze(requirements), links: Object.freeze(links), semanticReviewRequired: true as const });
  });
  const basis = { schemaVersion: 'buildlore.development-memory-inspection.v1' as const, projectId: snapshot.projectId,
    snapshotDigest: snapshot.snapshotDigest, proposalDigest: proposal.proposalDigest, questionsDigest: digest(questions),
    profileDigest: digest(questions.map(q => q.contentProfile)),
    structuralStatus: axes.some(axis => axis.structuralStatus === 'incomplete') ? 'incomplete' as const
      : axes.some(axis => axis.structuralStatus === 'unassessed') ? 'unassessed' as const : 'covered' as const,
    semanticReviewRequired: true as const, axes: Object.freeze(axes) };
  return Object.freeze({ ...basis, inspectionDigest: digest(basis) });
}
