import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addProject } from '../src/knowledge/index.js';
import { createProjectSecurityService } from '../src/sanitizer/index.js';
import { digest, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import type { KnowledgeGenerationV1 } from '../src/knowledge/project-knowledge/types.js';
import { createKnowledgeCompletenessSessionService, captureKnowledgeCompletenessSession } from '../src/compiler/project-knowledge/completeness-session.js';
import { COMPLETENESS_CATEGORIES, completenessBinding } from '../src/compiler/project-knowledge/completeness.js';
import { replayKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { knowledgeFixtureSnapshot, fixtureProposal, fixtureReview, TEST_KNOWLEDGE_ACTOR } from './helpers/project-knowledge-fixture.js';

function seal<T extends object>(value: T, key: string): T {
  const basis = { ...value }; delete (basis as Record<string, unknown>)[key];
  return { ...basis, [key]: digest(basis) };
}

async function reviewedFixture(root: string, proofPolicy: 'persisted-v1' | 'legacy-v1') {
  await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
  await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
  const snapshot = await knowledgeFixtureSnapshot(), security = createProjectSecurityService({ knowledgeRoot: root });
  const sources = await Promise.all(snapshot.sources.map(async source => {
    const result = await security.prepareSource({ projectId: 'parcel', source: source.sourceRef, sourceKind: source.format,
      body: source.content, bodyDigest: sha256(source.content), sourceRevisionOrContentSha256: source.sourceContentDigest });
    if (!result.ok) throw new Error('Rejected safe proof fixture');
    return { source, prepared: result.prepared };
  }));
  const session = await createKnowledgeCompletenessSessionService({ knowledgeRoot: root }).prepare({ projectId: 'parcel', sources,
    selectionDigest: snapshot.selectionDigest, proofPolicy,
    authoringQuestions: [{ id: 'purpose', role: 'overview', question: 'What does Parcel do?', requirements: [
      { id: 'source', sourceRef: 'README.md', jsonPointer: null, contentKind: 'text' }] }] });
  const exchange = session.exchange, binding = completenessBinding(exchange), proposal = fixtureProposal(exchange.baseExchange.snapshot);
  const reviewer = { ...TEST_KNOWLEDGE_ACTOR, sessionId: 'proof-omission-fixture' };
  const inventory = (role: 'author' | 'blind-shadow-reviewer') => seal({ schemaVersion: 'buildlore.knowledge-completeness-inventory.v1',
    ...binding, role, actor: role === 'author' ? proposal.actor : reviewer, questions: [{ questionId: 'purpose',
      categories: COMPLETENESS_CATEGORIES.map(category => ({ category,
        items: category === 'direct-answer' ? [{ itemId: 'purpose-answer', questionId: 'purpose', category,
          statement: proposal.facts[0]!.statement, requirementIds: ['source'], support: 'source-supported',
          evidenceIds: proposal.facts[0]!.evidenceIds, relevance: 'current', rationale: 'Protocol fixture; not a live AI review.' }] : [],
        disposition: category === 'direct-answer' ? null : { status: 'not-applicable', rationale: 'Outside this test question.',
          requirementIds: [], sourceStatuses: [] } })) }] }, 'inventoryDigest');
  const shadow = inventory('blind-shadow-reviewer'), author = inventory('author');
  await session.submitShadowInventory(shadow, (await session.status('completeness-reviewer')).stageViewDigest);
  await session.submitAuthorInventory(author, (await session.status('author')).stageViewDigest);
  await session.submitInventoryReview(seal({ schemaVersion: 'buildlore.knowledge-completeness-inventory-review.v1', ...binding,
    shadowInventoryDigest: (shadow as Record<string, unknown>).inventoryDigest, authorInventoryDigest: (author as Record<string, unknown>).inventoryDigest, reviewer,
    judgments: [
      { role: 'author', itemId: 'purpose-answer', disposition: 'required', duplicateOf: null, evidenceIds: proposal.facts[0]!.evidenceIds, rationale: 'Required test proposition.' },
      { role: 'blind-shadow-reviewer', itemId: 'purpose-answer', disposition: 'duplicate', duplicateOf: { role: 'author', itemId: 'purpose-answer' }, evidenceIds: proposal.facts[0]!.evidenceIds, rationale: 'Same test proposition.' },
    ], questions: [{ questionId: 'purpose', categories: COMPLETENESS_CATEGORIES.map(category => ({ category,
      status: category === 'direct-answer' ? 'complete' : 'not-applicable', rationale: 'Fixture disposition.' })) }], decision: 'accepted' }, 'reviewDigest'),
  (await session.status('completeness-reviewer')).stageViewDigest);
  const accepted = (await captureKnowledgeCompletenessSession(session)).state.acceptedInventory!;
  const mapping = seal({ schemaVersion: 'buildlore.knowledge-completeness-prose-mapping.v1', ...binding,
    acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest: proposal.proposalDigest, author: proposal.actor,
    items: accepted.requiredItems.map(item => ({ itemId: item.itemId, status: 'mapped', locators: [
      { pageRole: 'overview', sectionIndex: 0, claimIndex: 0, claimId: 'claim-overview' }] })) }, 'mappingDigest');
  await session.submitProse({ schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: 'parcel', runId: exchange.runId,
    proposal, mapping, attempt: 1, correctionOfReviewRoundDigest: null }, (await session.status('author')).stageViewDigest);
  await session.submitCompletenessReview(seal({ schemaVersion: 'buildlore.knowledge-completeness-review.v1', ...binding,
    acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest: proposal.proposalDigest,
    mappingDigest: (mapping as Record<string, unknown>).mappingDigest, round: 1, reviewer,
    items: accepted.requiredItems.map(item => ({ itemId: item.itemId, verdict: 'covered', rationale: 'Fixture verdict.', correction: null })),
    questions: [{ questionId: 'purpose', verdict: 'complete', rationale: 'Fixture question.' }], inventoryFindings: [],
    disclosures: 'frozen-inputs-and-current-proposal-only' }, 'reviewDigest'), (await session.status('completeness-reviewer')).stageViewDigest);
  await session.submitSourceReview(fixtureReview(proposal), (await session.status('source-reviewer')).stageViewDigest);
  const round = (await captureKnowledgeCompletenessSession(session)).state.attempts[0]!.reviewRound!, view = await session.status('author');
  return session.finalize({ schemaVersion: 'buildlore.knowledge-completeness-finalize-input.v1', projectId: 'parcel', runId: exchange.runId,
    proposalDigest: round.proposalDigest, mappingDigest: round.mappingDigest, completenessReviewDigest: round.completenessReviewDigest,
    semanticReviewDigest: round.semanticReviewDigest, reviewViewDigest: view.stageViewDigest }, view.stageViewDigest);
}

describe('portable completeness proof admission', () => {
  let root: string, generation: KnowledgeGenerationV1;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'buildlore-proof-'));
    generation = await reviewedFixture(root, 'persisted-v1');
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  it('replays exact review inputs after serialization without a live session capability', () => {
    expect(generation.schemaVersion).toBe('buildlore.knowledge-generation.v2');
    if (generation.completenessProof?.schemaVersion !== 'buildlore.knowledge-completeness-proof.v1') throw new Error('Expected legacy proof.');
    expect(generation.completenessProof.attempts[0]?.proposal).toBeNull();
    expect(replayKnowledgeGeneration(JSON.parse(JSON.stringify(generation)), 'parcel', null)).toEqual(generation);
  });
  it('rejects stripped, mismatched or relabeled proof even after outer hashes are recomputed', () => {
    const { completenessProof, ...stripped } = generation;
    expect(() => replayKnowledgeGeneration(seal(stripped, 'generationDigest'), 'parcel', null)).toThrow();
    expect(() => replayKnowledgeGeneration(seal({ ...generation, schemaVersion: 'buildlore.knowledge-generation.v1' }, 'generationDigest'), 'parcel', null)).toThrow();
    const altered = seal({ ...completenessProof, semanticReviewDigest: sha256('another review') }, 'proofDigest');
    expect(() => replayKnowledgeGeneration(seal({ ...generation, completenessProof: altered }, 'generationDigest'), 'parcel', null)).toThrow();
  });
  it('rejects a structurally bound but failed omission verdict without trusting a pass label', () => {
    const proof = generation.completenessProof!;
    if (proof.schemaVersion !== 'buildlore.knowledge-completeness-proof.v1') throw new Error('Expected legacy proof.');
    const attempt = proof.attempts[0]!;
    const omission = seal({ ...attempt.completenessReview,
      items: attempt.completenessReview.items.map(item => ({ ...item, verdict: 'partial', correction: 'Missing qualifier.' })),
      questions: attempt.completenessReview.questions.map(q => ({ ...q, verdict: 'prose-defect' })) }, 'reviewDigest');
    const altered = seal({ ...proof, attempts: [{ ...attempt, completenessReview: omission }] }, 'proofDigest');
    expect(() => replayKnowledgeGeneration(seal({ ...generation, completenessProof: altered }, 'generationDigest'), 'parcel', null)).toThrow();
  });
  it('rejects missing reviews, cross-project reads, altered questions and missing mappings', () => {
    const proof = generation.completenessProof!;
    if (proof.schemaVersion !== 'buildlore.knowledge-completeness-proof.v1') throw new Error('Expected legacy proof.');
    for (const patch of [{ attempts: [] }, { authoringQuestions: [] }, { acceptedInventoryDigest: sha256('different inventory') },
      { attempts: [{ ...proof.attempts[0], reviewOrder: ['source'] }] }]) {
      expect(() => replayKnowledgeGeneration(seal({ ...generation, completenessProof: seal({ ...proof, ...patch }, 'proofDigest') }, 'generationDigest'), 'parcel', null)).toThrow();
    }
    expect(() => replayKnowledgeGeneration(generation, 'other', null)).toThrow();
  });
  it('preserves legacy session generation without upgrading its history digest', async () => {
    const other = await mkdtemp(join(tmpdir(), 'buildlore-proof-legacy-'));
    try {
      const legacy = await reviewedFixture(other, 'legacy-v1');
      expect(legacy.schemaVersion).toBe('buildlore.knowledge-generation.v1');
      expect(legacy).not.toHaveProperty('completenessProof');
      expect(replayKnowledgeGeneration(JSON.parse(JSON.stringify(legacy)), 'parcel', null)).toEqual(legacy);
    } finally { await rm(other, { recursive: true, force: true }); }
  });
});
