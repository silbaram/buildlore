import { parseKnowledgeSnapshot } from '../../knowledge/project-knowledge/evidence.js';
import { boundedJson, digest, identifier, invalid, keys, list, record } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from '../../knowledge/project-knowledge/types.js';
import { requireVerifiedKnowledgeHistory, type VerifiedKnowledgeHistory } from '../../retrieval/project-knowledge-history-store.js';
import { createKnowledgeEvidenceCoverage } from './citation-support.js';
import { parseKnowledgeGenerationChain } from './generation.js';
import { parseKnowledgeProposal } from './proposal.js';

export interface KnowledgeQuestionCoverageV1 {
  readonly schemaVersion: 'buildlore.knowledge-question-coverage.v1';
  readonly projectId: string;
  readonly snapshotDigest: KnowledgeDigest;
  readonly proposalDigest: KnowledgeDigest;
  readonly requirementsDigest: KnowledgeDigest;
  readonly semanticReviewRequired: true;
  readonly questions: readonly Readonly<{
    id: string;
    claimIds: readonly string[];
    requirements: readonly Readonly<{
      id: string;
      status: 'covered' | 'uncited' | 'heading-only' | 'unavailable';
      evidenceIds: readonly KnowledgeDigest[];
      citedEvidenceIds: readonly KnowledgeDigest[];
    }>[];
    complete: boolean;
  }>[];
  readonly complete: boolean;
  readonly coverageDigest: KnowledgeDigest;
}

/** Checks caller-declared question/claim/source mappings, not the meaning of prose.
 * Use sanitized exchanges; this pure diagnostic neither collects files nor approves claims.
 * Hidden evaluation criteria must not be copied into a reader's context.
 */
export function inspectKnowledgeQuestionCoverage(snapshotValue: unknown, proposalValue: unknown,
  questionsValue: unknown, projectId: string, previousGenerations?: unknown): KnowledgeQuestionCoverageV1 {
  const chain = previousGenerations === undefined ? [] : list(boundedJson(previousGenerations), 64);
  const previous = chain.length === 0 ? null : parseKnowledgeGenerationChain(chain, projectId).at(-1) ?? null;
  return inspectCoverage(snapshotValue, proposalValue, questionsValue, projectId, previous);
}

/** Async counterpart for a resolved (or resolving) store capability, never a fake one-item chain. */
export async function inspectKnowledgeQuestionCoverageWithHistory(snapshotValue: unknown, proposalValue: unknown,
  questionsValue: unknown, projectId: string,
  history: VerifiedKnowledgeHistory | null | Promise<VerifiedKnowledgeHistory | null>): Promise<KnowledgeQuestionCoverageV1> {
  const verified = await history;
  const previous = verified === null ? null : requireVerifiedKnowledgeHistory(verified, projectId).latest;
  return inspectCoverage(snapshotValue, proposalValue, questionsValue, projectId, previous);
}

function inspectCoverage(snapshotValue: unknown, proposalValue: unknown, questionsValue: unknown,
  projectId: string, previous: KnowledgeGenerationV1 | null): KnowledgeQuestionCoverageV1 {
  const snapshot = parseKnowledgeSnapshot(snapshotValue, projectId);
  const proposal = parseKnowledgeProposal(proposalValue, snapshot);
  if (proposal.baselineGenerationDigest !== (previous?.generationDigest ?? null)) invalid();
  const facts = new Map([...(previous?.records ?? []), ...proposal.facts].map(fact => [fact.id, fact]));
  const claims = new Map(proposal.pages.flatMap(page => page.sections.flatMap(section => section.claims))
    .map(claim => [claim.claimId, claim]));
  const input = boundedJson(questionsValue);
  const questionInputs = list(input, 64);
  if (questionInputs.reduce<number>((sum, value) => sum + list(record(value).requirements, 256).length, 0) > 256) invalid();
  const questions = questionInputs.map(value => {
    const question = record(value);
    keys(question, ['id', 'claimIds', 'requirements']);
    const id = identifier(question.id);
    const claimIds = list(question.claimIds, 256).map(identifier).sort();
    if (new Set(claimIds).size !== claimIds.length) invalid();
    const cited = new Set(claimIds.flatMap(claimId => {
      const claim = claims.get(claimId);
      if (!claim) return invalid();
      return claim.factIds.flatMap(factId => facts.get(factId)?.evidenceIds ?? invalid());
    }));
    const coverage = createKnowledgeEvidenceCoverage(snapshot, question.requirements, projectId);
    const requirements = coverage.requirements.map(requirement => {
      const citedEvidenceIds = Object.freeze(requirement.evidenceIds.filter(evidenceId => cited.has(evidenceId)).sort());
      return Object.freeze({ ...requirement, status: requirement.status === 'available'
        ? citedEvidenceIds.length > 0 ? 'covered' as const : 'uncited' as const : requirement.status,
      citedEvidenceIds });
    });
    return Object.freeze({ id, claimIds: Object.freeze(claimIds), requirements: Object.freeze(requirements),
      complete: requirements.every(requirement => requirement.status === 'covered') });
  });
  if (questions.length === 0 || new Set(questions.map(question => question.id)).size !== questions.length) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-question-coverage.v1' as const, projectId,
    snapshotDigest: snapshot.snapshotDigest, proposalDigest: proposal.proposalDigest,
    requirementsDigest: digest(input), semanticReviewRequired: true as const, questions: Object.freeze(questions),
    complete: questions.every(question => question.complete) };
  const result = Object.freeze({ ...basis, coverageDigest: digest(basis) });
  boundedJson(result);
  return result;
}
