import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createKnowledgeSnapshot } from '../../src/knowledge/project-knowledge/evidence.js';
import { digest, sha256 } from '../../src/knowledge/project-knowledge/guards.js';
import { createProposedKnowledgeRecord } from '../../src/knowledge/project-knowledge/records.js';
import type { KnowledgeActorV1, KnowledgeFactInputV1, KnowledgeProposalV1,
  KnowledgeSemanticReviewV1, KnowledgeSnapshotV1 } from '../../src/knowledge/project-knowledge/types.js';
import { createKnowledgeProposal, knowledgeReviewTargets } from '../../src/compiler/project-knowledge/proposal.js';

export const TEST_KNOWLEDGE_ACTOR: KnowledgeActorV1 = Object.freeze({
  sessionId: 'fixture-writer', model: 'deterministic-fixture-not-a-live-ai', kind: 'agent',
});

export async function knowledgeFixtureSnapshot(revision: 'R1' | 'R2' = 'R1'): Promise<KnowledgeSnapshotV1> {
  const root = join(process.cwd(), 'test/fixtures/project-knowledge/v1/generic-md-json', revision);
  const paths = (await readdir(root)).sort();
  const sources = await Promise.all(paths.map(async (path) => {
    const content = await readFile(join(root, path), 'utf8');
    return { sourceId: path.replaceAll('.', '-'), sourceRef: path, content,
      sourceContentDigest: sha256(content), sourceRevision: revision, codeRevision: null, tracked: true,
      format: path.endsWith('.json') ? 'json' as const : 'markdown' as const };
  }));
  return createKnowledgeSnapshot({ projectId: 'parcel', selectionDigest: digest('same-declared-directory'),
    sanitizerPolicyDigest: digest('fixture-policy'), sanitizerRulesVersion: 'fixture-rules', sources }, 'parcel');
}

export function fixtureFact(snapshot: KnowledgeSnapshotV1, statement = 'Parcel prepares local delivery manifests.'): KnowledgeFactInputV1 {
  const item = snapshot.evidence.find((e) => e.sourceRef === 'README.md' && e.excerpt.includes('local batch'));
  if (!item) throw new Error('Missing fixed fixture evidence.');
  return { subject: 'project:parcel', predicate: 'purpose', statement, scope: 'documented purpose',
    classification: 'declared', lifecycle: 'current', evidenceIds: [item.evidenceId], observation: null };
}

export function fixtureProposal(snapshot: KnowledgeSnapshotV1,
  facts: readonly KnowledgeFactInputV1[] = [fixtureFact(snapshot)]): KnowledgeProposalV1 {
  const records = facts.map((f) => createProposedKnowledgeRecord(f, snapshot, TEST_KNOWLEDGE_ACTOR));
  const first = records[0];
  if (!first) throw new Error('Missing fixed fixture fact.');
  return createKnowledgeProposal({ projectId: snapshot.projectId, snapshotDigest: snapshot.snapshotDigest,
    baselineGenerationDigest: null, actor: TEST_KNOWLEDGE_ACTOR, facts, supersessions: [], conflicts: [],
    pages: ['overview', 'architecture', 'decisions'].map((role) => ({ role, title: 'Fixture coverage',
      sections: [{ title: 'Fixture assertions', claims: [{ claimId: `claim-${role}`, text: first.statement,
        factIds: [first.id], presentation: 'current' }] }] })) }, snapshot);
}

/** Deterministic unit-test review, explicitly not evidence of an actual independent AI evaluation. */
export function fixtureReview(proposal: KnowledgeProposalV1): KnowledgeSemanticReviewV1 {
  const basis = { schemaVersion: 'buildlore.knowledge-semantic-review.v1' as const,
    projectId: proposal.projectId, proposalDigest: proposal.proposalDigest, snapshotDigest: proposal.snapshotDigest,
    reviewer: { sessionId: 'fixture-reviewer', model: 'deterministic-fixture-not-a-live-ai', kind: 'agent' as const },
    method: 'source-support-and-currentness' as const, coverageChecked: true as const,
    judgments: knowledgeReviewTargets(proposal).map((targetId) => {
      const claim = proposal.pages.flatMap((p) => p.sections.flatMap((s) => s.claims)).find((c) => c.claimId === targetId);
      const page = proposal.pages.find((p) => targetId === `title:${p.role}` || targetId.startsWith(`section:${p.role}:`));
      const section = page?.sections.find((_, index) => targetId === `section:${page.role}:${String(index)}`);
      const factId = claim?.factIds[0] ?? (section ?? page?.sections[0])?.claims[0]?.factIds[0] ?? targetId;
      const supersession = proposal.supersessions.find((s) => targetId === `supersession:${s.previousFactId}:${s.replacementFactId}`);
      return { targetId, verdict: 'supported' as const,
        evidenceIds: supersession?.evidenceIds ?? proposal.facts.find((f) => f.id === factId)?.evidenceIds ?? proposal.facts[0]?.evidenceIds ?? [],
        rationale: 'Fixed regression fixture; not an actual independent evaluation.' };
    }),
  };
  return { ...basis, reviewDigest: digest(basis) };
}
