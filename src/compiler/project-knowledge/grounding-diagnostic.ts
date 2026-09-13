import { parseKnowledgeSnapshot } from '../../knowledge/project-knowledge/evidence.js';
import { digest, invalid } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from '../../knowledge/project-knowledge/types.js';
import { requireVerifiedKnowledgeHistory, type VerifiedKnowledgeHistory } from '../../retrieval/project-knowledge-history-store.js';
import { inspectClaimEvidenceOverlap } from '../hierarchy/quality.js';
import { parseKnowledgeGenerationChain } from './generation.js';
import { parseKnowledgeProposal } from './proposal.js';

export interface KnowledgeGroundingDiagnosticV1 {
  readonly schemaVersion: 'buildlore.knowledge-grounding-diagnostic.v1';
  readonly projectId: string;
  readonly snapshotDigest: KnowledgeDigest;
  readonly proposalDigest: KnowledgeDigest;
  readonly semanticReviewRequired: true;
  readonly claims: readonly Readonly<{ claimId: string; overlapBasisPoints: number; minimumBasisPoints: number; lexicalCheckPassed: boolean }>[];
  readonly diagnosticDigest: KnowledgeDigest;
}

/** Pre-review diagnostic only: do not weaken claims, add unrelated evidence, or treat overlap as truth.
 * Pure codec, not a sanitizer or finalization authority. No producer-specific knowledge or new scoring policy.
 */
export function inspectKnowledgeProposalGrounding(snapshotValue: unknown, proposalValue: unknown,
  projectId: string, previousGenerations?: unknown): KnowledgeGroundingDiagnosticV1 {
  const previous = previousGenerations === undefined ? null : parseKnowledgeGenerationChain(previousGenerations, projectId).at(-1) ?? null;
  return inspectGrounding(snapshotValue, proposalValue, projectId, previous);
}

export async function inspectKnowledgeProposalGroundingWithHistory(snapshotValue: unknown, proposalValue: unknown,
  projectId: string, history: VerifiedKnowledgeHistory | null | Promise<VerifiedKnowledgeHistory | null>): Promise<KnowledgeGroundingDiagnosticV1> {
  const verified = await history;
  return inspectGrounding(snapshotValue, proposalValue, projectId,
    verified === null ? null : requireVerifiedKnowledgeHistory(verified, projectId).latest);
}

function inspectGrounding(snapshotValue: unknown, proposalValue: unknown, projectId: string,
  previous: KnowledgeGenerationV1 | null): KnowledgeGroundingDiagnosticV1 {
  const snapshot = parseKnowledgeSnapshot(snapshotValue, projectId);
  const proposal = parseKnowledgeProposal(proposalValue, snapshot);
  if (proposal.baselineGenerationDigest !== (previous?.generationDigest ?? null)) invalid();
  const facts = new Map([...(previous?.records ?? []), ...proposal.facts].map(f => [f.id, f]));
  const evidence = new Map([...(previous?.evidence ?? []), ...snapshot.evidence].map(e => [e.evidenceId, e]));
  const claims = proposal.pages.flatMap(page => page.sections.flatMap(section => section.claims.map(claim => {
    const ids = [...new Set(claim.factIds.flatMap(id => facts.get(id)?.evidenceIds ?? invalid()))];
    const contents = ids.map(id => evidence.get(id)?.excerpt ?? invalid());
    return Object.freeze({ claimId: claim.claimId, ...inspectClaimEvidenceOverlap(claim.text, contents) });
  })));
  const basis = { schemaVersion: 'buildlore.knowledge-grounding-diagnostic.v1' as const, projectId,
    snapshotDigest: snapshot.snapshotDigest, proposalDigest: proposal.proposalDigest,
    semanticReviewRequired: true as const, claims: Object.freeze(claims) };
  return Object.freeze({ ...basis, diagnosticDigest: digest(basis) });
}
