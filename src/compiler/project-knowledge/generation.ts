import { parseKnowledgeSnapshot } from '../../knowledge/project-knowledge/evidence.js';
import { boundedJson, choice, compare, digest, invalid, record } from '../../knowledge/project-knowledge/guards.js';
import { reconcileKnowledge } from '../../knowledge/project-knowledge/reconcile.js';
import type { KnowledgeGenerationV1, KnowledgeProposalV1, KnowledgeSemanticReviewV1,
  KnowledgeSnapshotV1, KnowledgeRendererVersion } from '../../knowledge/project-knowledge/types.js';
import { parseKnowledgeProposal, parseKnowledgeSemanticReview } from './proposal.js';

const replayedGenerations = new WeakSet<KnowledgeGenerationV1>();

/** Pure compilation. Persistence additionally requires the project security and activation boundaries. */
export function createKnowledgeGeneration(snapshotValue: KnowledgeSnapshotV1,
  proposalValue: KnowledgeProposalV1, reviewValue: KnowledgeSemanticReviewV1,
  previous: KnowledgeGenerationV1 | null,
  rendererVersion: KnowledgeRendererVersion = 'knowledge-markdown-v2'): KnowledgeGenerationV1 {
  const renderer = choice(rendererVersion, ['knowledge-markdown-v1', 'knowledge-markdown-v2']);
  if (previous !== null && !replayedGenerations.has(previous)) invalid();
  const snapshot = parseKnowledgeSnapshot(snapshotValue, snapshotValue.projectId);
  const proposal = parseKnowledgeProposal(proposalValue, snapshot);
  const review = parseKnowledgeSemanticReview(reviewValue, proposal, snapshot, previous);
  const records = reconcileKnowledge(snapshot, proposal, review, previous);
  const evidenceById = new Map([
    ...(previous?.evidence ?? []).map((item) => [item.evidenceId, item] as const),
    ...snapshot.evidence.map((item) => [item.evidenceId, item] as const),
  ]);
  const evidenceIds = new Set(records.flatMap((r) => r.evidenceIds));
  const evidence = [...evidenceById.values()].filter((item) => evidenceIds.has(item.evidenceId))
    .sort((a, b) => compare(a.evidenceId, b.evidenceId));
  if (evidence.length !== evidenceIds.size || evidence.length > 8192) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-generation.v1' as const,
    projectId: snapshot.projectId, snapshot, baselineGenerationDigest: previous?.generationDigest ?? null,
    proposal, review, records, evidence: Object.freeze(evidence), pages: proposal.pages,
    reconciliationPolicyVersion: 'conservative-currentness-v1' as const,
    rendererVersion: renderer };
  boundedJson(basis);
  const generation = Object.freeze({ ...basis, generationDigest: digest(basis) });
  replayedGenerations.add(generation);
  return generation;
}

/** Replay one bounded generation against a genuinely replayed predecessor.
 * This is not a shortcut for accepting an arbitrary baseline or a stored digest.
 */
export function replayKnowledgeGeneration(value: unknown, expectedProjectId: string,
  previous: KnowledgeGenerationV1 | null): KnowledgeGenerationV1 {
  const input = record(boundedJson(value));
  const snapshot = parseKnowledgeSnapshot(input.snapshot, expectedProjectId);
  const proposal = parseKnowledgeProposal(input.proposal, snapshot);
  const review = parseKnowledgeSemanticReview(input.review, proposal, snapshot, previous);
  const generation = createKnowledgeGeneration(snapshot, proposal, review, previous,
    choice(input.rendererVersion, ['knowledge-markdown-v1', 'knowledge-markdown-v2'] as const));
  if (digest(input) !== digest(generation)) invalid();
  return generation;
}

/** Replay a bounded legacy chain from genesis. New persisted history uses the
 * async history store; these existing in-memory admission limits are unchanged.
 */
export function parseKnowledgeGenerationChain(value: unknown,
  expectedProjectId: string): readonly KnowledgeGenerationV1[] {
  const bounded = boundedJson(value);
  if (!Array.isArray(bounded) || bounded.length === 0 || bounded.length > 64) invalid();
  const items: readonly unknown[] = bounded;
  const generations: KnowledgeGenerationV1[] = [];
  let previous: KnowledgeGenerationV1 | null = null;
  for (const item of items) {
    const generation = replayKnowledgeGeneration(item, expectedProjectId, previous);
    generations.push(generation);
    previous = generation;
  }
  return Object.freeze(generations);
}
