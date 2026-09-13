import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { compare, digest, record, sha256, ProjectKnowledgeError } from '../src/knowledge/project-knowledge/guards.js';
import { addProject } from '../src/knowledge/index.js';
import { createProjectSecurityService } from '../src/sanitizer/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { createKnowledgeCompletenessSessionService, captureKnowledgeCompletenessSession,
  replayKnowledgeCompletenessSession, type KnowledgeCompletenessSessionV1,
  type KnowledgeCompletenessStateV1 } from '../src/compiler/project-knowledge/completeness-session.js';
import { createKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { COMPLETENESS_CATEGORIES, COMPLETENESS_LIMITS, KnowledgeCompletenessBudgetError, KnowledgeCompletenessInventoryError, repairKnowledgeCompletenessInventoryDraft,
  acceptKnowledgeCompletenessInventory, completenessBinding, completenessInventoryItems, completenessJson,
  completenessRefKey, createKnowledgeCompletenessExchange, parseKnowledgeCompletenessInventory,
  parseKnowledgeCompletenessInventoryReview, parseKnowledgeCompletenessProseMapping,
  parseKnowledgeCompletenessReconciliation, parseKnowledgeCompletenessReview,
  type KnowledgeCompletenessExchangeV1, type KnowledgeCompletenessInventoryV1,
  type KnowledgeCompletenessInventoryReviewV1, type KnowledgeCompletenessAcceptedInventoryV1 } from '../src/compiler/project-knowledge/completeness.js';
import { fixtureFact, fixtureProposal, fixtureReview, knowledgeFixtureSnapshot, TEST_KNOWLEDGE_ACTOR } from './helpers/project-knowledge-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function sessionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-completeness-'));
  roots.push(root);
  await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
  await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
  const security = createProjectSecurityService({ knowledgeRoot: root });
  const fixture = await context();
  const prepare = async (runId?: string) => {
    const sources = await Promise.all(fixture.exchange.baseExchange.snapshot.sources.map(async source => {
      const result = await security.prepareSource({ projectId: 'parcel', source: source.sourceRef,
        sourceKind: source.format, body: source.content, bodyDigest: sha256(source.content),
        sourceRevisionOrContentSha256: source.sourceContentDigest });
      if (!result.ok) throw new Error('Safe completeness fixture was rejected.');
      return { source, prepared: result.prepared };
    }));
    return await createKnowledgeCompletenessSessionService({ knowledgeRoot: root }).prepare({
      projectId: 'parcel', sources, selectionDigest: fixture.exchange.baseExchange.snapshot.selectionDigest,
      authoringQuestions: fixture.exchange.authoringQuestions, ...(runId === undefined ? {} : { runId }),
    });
  };
  return { root, prepare, session: await prepare() };
}
async function driveInventory(session: KnowledgeCompletenessSessionV1) {
  const exchange = session.exchange;
  const shadow = parseKnowledgeCompletenessInventory(seal(inventoryInput(exchange, 'blind-shadow-reviewer'), 'inventoryDigest'), exchange, 'blind-shadow-reviewer');
  const author = parseKnowledgeCompletenessInventory(seal(inventoryInput(exchange, 'author'), 'inventoryDigest'), exchange, 'author');
  await session.submitShadowInventory(shadow, (await session.status('completeness-reviewer')).stageViewDigest);
  await session.submitAuthorInventory(author, (await session.status('author')).stageViewDigest);
  await session.submitInventoryReview(seal(reviewInput(exchange, shadow, author), 'reviewDigest'),
    (await session.status('completeness-reviewer')).stageViewDigest);
  return (await captureKnowledgeCompletenessSession(session)).state.acceptedInventory ?? (() => { throw new Error('Missing accepted fixture.'); })();
}
async function driveProse(session: KnowledgeCompletenessSessionV1) {
  const accepted = await driveInventory(session), proposal = fixtureProposal(session.exchange.baseExchange.snapshot);
  const mapping = parseKnowledgeCompletenessProseMapping(seal(mappingInput(session.exchange, accepted, proposal.proposalDigest), 'mappingDigest'),
    session.exchange, accepted, proposal);
  await session.submitProse({ schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: session.exchange.projectId,
    runId: session.exchange.runId, proposal, mapping, attempt: 1, correctionOfReviewRoundDigest: null }, (await session.status('author')).stageViewDigest);
  return { accepted, proposal, mapping };
}
async function omissionReview(session: KnowledgeCompletenessSessionV1, defect: 'none' | 'prose' | 'inventory' = 'none') {
  const state = (await captureKnowledgeCompletenessSession(session)).state;
  const accepted = state.acceptedInventory, attempt = state.attempts.at(-1);
  if (!accepted || !attempt) throw new Error('Missing prose fixture.');
  const value = { schemaVersion: 'buildlore.knowledge-completeness-review.v1', ...completenessBinding(session.exchange),
    acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest: attempt.submission.proposal.proposalDigest,
    mappingDigest: attempt.submission.mapping.mappingDigest, round: attempt.submission.attempt, reviewer,
    items: accepted.requiredItems.map(item => ({ itemId: item.itemId, verdict: defect === 'prose' ? 'partial' : 'covered',
      rationale: 'Deterministic protocol verdict, not a live quality judgment.', correction: defect === 'prose' ? 'Preserve the supported qualifier.' : null })),
    questions: [{ questionId: 'purpose', verdict: defect === 'inventory' ? 'inventory-defect' : defect === 'prose' ? 'prose-defect' : 'complete',
      rationale: 'Question-specific fixture judgment.' }],
    inventoryFindings: defect === 'inventory' ? [{ questionId: 'purpose', statement: 'An additional source-grounded requirement was omitted.',
      evidenceIds: accepted.requiredItems[0]?.evidenceIds ?? [], rationale: 'Found during the full-source comparison.' }] : [],
    disclosures: 'frozen-inputs-and-current-proposal-only' };
  return seal(value, 'reviewDigest');
}
async function finalizeInput(session: KnowledgeCompletenessSessionV1) {
  const captured = await captureKnowledgeCompletenessSession(session), round = captured.state.attempts.at(-1)?.reviewRound;
  if (!round) throw new Error('Missing review round.');
  const view = await session.status('author');
  return { input: { schemaVersion: 'buildlore.knowledge-completeness-finalize-input.v1', projectId: session.exchange.projectId,
    runId: session.exchange.runId, proposalDigest: round.proposalDigest, mappingDigest: round.mappingDigest,
    completenessReviewDigest: round.completenessReviewDigest, semanticReviewDigest: round.semanticReviewDigest,
    reviewViewDigest: view.stageViewDigest }, expectStage: view.stageViewDigest };
}

describe('sanitized completeness session ordering and recovery', () => {
  it('commits shadow before author, hides shadow content from author and never mutates on reads', async () => {
    const { session } = await sessionFixture();
    const first = await captureKnowledgeCompletenessSession(session);
    expect((await session.status()).material).toEqual({});
    await expect(session.submitAuthorInventory(seal(inventoryInput(session.exchange, 'author'), 'inventoryDigest'),
      (await session.status('author')).stageViewDigest)).rejects.toThrow(ProjectKnowledgeError);
    expect((await captureKnowledgeCompletenessSession(session)).state.stateDigest).toBe(first.state.stateDigest);
    await session.submitShadowInventory(seal(inventoryInput(session.exchange, 'blind-shadow-reviewer'), 'inventoryDigest'),
      (await session.status('completeness-reviewer')).stageViewDigest);
    const before = await captureKnowledgeCompletenessSession(session);
    const authorView = await session.status('author');
    expect(authorView.phase).toBe('awaiting-author-inventory');
    expect(authorView.material).not.toHaveProperty('shadowInventory');
    expect(authorView.material).not.toHaveProperty('inventoryReview');
    expect((await session.status('completeness-reviewer')).material).toHaveProperty('shadowInventory');
    expect((await captureKnowledgeCompletenessSession(session)).state.stateDigest).toBe(before.state.stateDigest);
  });

  it('joins frozen requirements to exact prose and evidence without exposing it early or to the source reviewer', async () => {
    const { session, prepare } = await sessionFixture();
    expect((await session.status('completeness-reviewer')).material).not.toHaveProperty('reviewPacket');
    const { accepted, proposal, mapping } = await driveProse(session);
    const before = await captureKnowledgeCompletenessSession(session);
    const authorView = await session.status('author');
    const packet = record(authorView.material.reviewPacket);
    expect(packet).toMatchObject({ projectId: session.exchange.projectId,
      acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest: proposal.proposalDigest, mappingDigest: mapping.mappingDigest });
    const groups = packet.questions as Array<{ question: unknown; items: Array<{ requiredItem: unknown; status: string; locators: unknown[] }> }>;
    expect(groups[0]?.question).toEqual(session.exchange.authoringQuestions[0]);
    expect(groups[0]?.items[0]?.requiredItem).toEqual(accepted.requiredItems[0]);
    const page = proposal.pages.find(page => page.role === 'architecture');
    expect(groups[0]?.items[0]?.locators).toEqual(mapping.items[0]?.locators);
    expect(packet.prose).toEqual([{ locator: mapping.items[0]?.locators[0],
      pageTitle: page?.title, sectionTitle: page?.sections[0]?.title, claim: page?.sections[0]?.claims[0] }]);
    expect(packet.facts).toEqual(proposal.facts);
    expect(packet.evidence).toEqual(session.exchange.baseExchange.snapshot.evidence.filter(item =>
      accepted.requiredItems[0]?.evidenceIds.includes(item.evidenceId)));
    expect((await session.status('completeness-reviewer')).material.reviewPacket).toEqual(packet);
    expect((await session.status('source-reviewer')).material).not.toHaveProperty('reviewPacket');
    expect((await captureKnowledgeCompletenessSession(session)).state).toEqual(before.state);
    const reopened = await prepare(session.exchange.runId);
    await replayKnowledgeCompletenessSession(reopened, before.state);
    expect((await reopened.status('author')).material.reviewPacket).toEqual(packet);
  });

  it('omits an oversized optional join in full while preserving proposal, mappings and review transitions', async () => {
    const { session } = await sessionFixture();
    const accepted = await driveInventory(session), snapshot = session.exchange.baseExchange.snapshot;
    expect((await session.status('author')).material).not.toHaveProperty('reviewPacket');
    const base = fixtureProposal(snapshot), fact = base.facts[0];
    if (!fact) throw new Error('Missing fixture fact.');
    const proposal = createKnowledgeProposal({ projectId: snapshot.projectId, snapshotDigest: snapshot.snapshotDigest,
      baselineGenerationDigest: null, actor: TEST_KNOWLEDGE_ACTOR, facts: [fixtureFact(snapshot)], supersessions: [], conflicts: [],
      pages: base.pages.map(page => ({ ...page, sections: [{ title: 'Large but bounded prose',
        claims: Array.from({ length: page.role === 'decisions' ? 1 : 8 }, (_, index) => ({
          claimId: `claim-${page.role}-${String(index)}`, text: (fact.statement + ' ').repeat(400).slice(0, 16300),
          factIds: [fact.id], presentation: 'current' })) }] })) }, snapshot);
    const locators = proposal.pages.filter(page => page.role !== 'decisions').flatMap(page =>
      page.sections[0]?.claims.map((claim, claimIndex) => ({ pageRole: page.role, sectionIndex: 0, claimIndex, claimId: claim.claimId })) ?? []);
    const rawMapping = mappingInput(session.exchange, accepted, proposal.proposalDigest);
    const mapping = parseKnowledgeCompletenessProseMapping(seal({ ...rawMapping,
      items: rawMapping.items.map(item => ({ ...item, locators })) }, 'mappingDigest'), session.exchange, accepted, proposal);
    await session.submitProse({ schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1',
      projectId: snapshot.projectId, runId: session.exchange.runId, proposal, mapping, attempt: 1,
      correctionOfReviewRoundDigest: null }, (await session.status('author')).stageViewDigest);
    const before = await captureKnowledgeCompletenessSession(session);
    for (const role of ['author', 'completeness-reviewer'] as const) {
      const view = await session.status(role);
      expect(view.material).not.toHaveProperty('reviewPacket');
      expect(view.material.proposal).toEqual(proposal);
      expect(view.material.mapping).toEqual(mapping);
    }
    expect((await captureKnowledgeCompletenessSession(session)).state).toEqual(before.state);
    await session.submitCompletenessReview(await omissionReview(session, 'prose'),
      (await session.status('completeness-reviewer')).stageViewDigest);
    expect((await session.status()).pendingReviewRoles).toEqual(['source-reviewer']);
  });

  it.each(['completeness-first', 'source-first'] as const)('requires both latest independent reviews (%s)', async order => {
    const { session } = await sessionFixture();
    const f = await driveProse(session);
    const complete = async () => await session.submitCompletenessReview(await omissionReview(session),
      (await session.status('completeness-reviewer')).stageViewDigest);
    const source = async () => await session.submitSourceReview(fixtureReview(f.proposal),
      (await session.status('source-reviewer')).stageViewDigest);
    if (order === 'completeness-first') {
      await complete();
      expect((await session.status('source-reviewer')).material).not.toHaveProperty('completenessReview');
    } else {
      await source();
      expect((await session.status('completeness-reviewer')).material).not.toHaveProperty('semanticReview');
    }
    expect((await session.status()).phase).toBe('awaiting-initial-reviews');
    await expect(session.finalize({}, (await session.status('author')).stageViewDigest)).rejects.toThrow();
    if (order === 'completeness-first') await source(); else await complete();
    expect((await session.status()).phase).toBe('review-ready');
    const final = await finalizeInput(session);
    const generation = await session.finalize(final.input, final.expectStage);
    expect(generation.proposal.proposalDigest).toBe(f.proposal.proposalDigest);
    expect((await session.status()).phase).toBe('finalized');
    expect((await session.status()).nextActions).toEqual([]);
    await expect(session.finalize(final.input, final.expectStage)).rejects.toThrow(ProjectKnowledgeError);
  });

  it('replays each closed stage from genuinely prepared sources and rejects recomputed contradictory state', async () => {
    const { session, prepare } = await sessionFixture();
    const snapshots: KnowledgeCompletenessStateV1[] = [(await captureKnowledgeCompletenessSession(session)).state];
    await driveInventory(session); snapshots.push((await captureKnowledgeCompletenessSession(session)).state);
    const accepted = snapshots.at(-1)?.acceptedInventory;
    if (!accepted) throw new Error('Missing accepted fixture.');
    const proposal = fixtureProposal(session.exchange.baseExchange.snapshot);
    const mapping = parseKnowledgeCompletenessProseMapping(seal(mappingInput(session.exchange, accepted, proposal.proposalDigest), 'mappingDigest'),
      session.exchange, accepted, proposal);
    await session.submitProse({ schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: 'parcel',
      runId: session.exchange.runId, proposal, mapping, attempt: 1, correctionOfReviewRoundDigest: null }, (await session.status('author')).stageViewDigest);
    snapshots.push((await captureKnowledgeCompletenessSession(session)).state);
    await session.submitCompletenessReview(await omissionReview(session), (await session.status('completeness-reviewer')).stageViewDigest);
    snapshots.push((await captureKnowledgeCompletenessSession(session)).state);
    await session.submitSourceReview(fixtureReview(proposal), (await session.status('source-reviewer')).stageViewDigest);
    snapshots.push((await captureKnowledgeCompletenessSession(session)).state);
    const final = await finalizeInput(session);
    await session.finalize(final.input, final.expectStage);
    snapshots.push((await captureKnowledgeCompletenessSession(session)).state);
    for (const snapshot of snapshots) {
      const resumed = await prepare(session.exchange.runId);
      await replayKnowledgeCompletenessSession(resumed, snapshot);
      expect((await captureKnowledgeCompletenessSession(resumed)).state).toEqual(snapshot);
    }
    const snapshot = snapshots.at(-1);
    if (!snapshot) throw new Error('Missing final fixture.');
    const { stateDigest: prior, ...basis } = snapshot; void prior;
    await expect(replayKnowledgeCompletenessSession(await prepare(session.exchange.runId), seal({ ...basis, revision: basis.revision + 1 }, 'stateDigest'))).rejects.toThrow();
    await expect(replayKnowledgeCompletenessSession(await prepare(), snapshot)).rejects.toThrow(ProjectKnowledgeError);
  }, 15_000); // Re-prepare and replay every phase under concurrent full-suite load.

  it('allows one correction, freezes inventory and preserves both independent review rounds', async () => {
    const { session } = await sessionFixture();
    const f = await driveProse(session);
    await session.submitCompletenessReview(await omissionReview(session, 'prose'), (await session.status('completeness-reviewer')).stageViewDigest);
    await expect(session.correctProse({}, (await session.status('author')).stageViewDigest)).rejects.toThrow();
    await session.submitSourceReview(fixtureReview(f.proposal), (await session.status('source-reviewer')).stageViewDigest);
    const first = (await captureKnowledgeCompletenessSession(session)).state;
    expect(first.phase).toBe('awaiting-correction');
    await expect(session.reconcileInventory({}, (await session.status('author')).stageViewDigest)).rejects.toThrow();
    const firstAttempt = first.attempts[0];
    if (!firstAttempt?.reviewRound) throw new Error('Missing first review.');
    const unchanged = { ...firstAttempt.submission, attempt: 2, correctionOfReviewRoundDigest: firstAttempt.reviewRound.reviewRoundDigest };
    await expect(session.correctProse(unchanged, (await session.status('author')).stageViewDigest)).rejects.toThrow();
    const proposal = fixtureProposal(session.exchange.baseExchange.snapshot, [
      fixtureFact(session.exchange.baseExchange.snapshot, 'Parcel prepares local delivery manifests with local batch inputs.'),
    ]);
    const mapping = parseKnowledgeCompletenessProseMapping(seal(mappingInput(session.exchange, f.accepted, proposal.proposalDigest), 'mappingDigest'),
      session.exchange, f.accepted, proposal);
    await session.correctProse({ ...unchanged, proposal, mapping }, (await session.status('author')).stageViewDigest);
    expect((await session.status()).phase).toBe('awaiting-correction-reviews');
    const correctedPacket = record((await session.status('completeness-reviewer')).material.reviewPacket);
    expect(correctedPacket.proposalDigest).toBe(proposal.proposalDigest);
    expect(correctedPacket.mappingDigest).toBe(mapping.mappingDigest);
    expect(correctedPacket.acceptedInventoryDigest).toBe(f.accepted.acceptedInventoryDigest);
    expect(JSON.stringify(correctedPacket)).toContain('Parcel prepares local delivery manifests with local batch inputs.');
    expect((await captureKnowledgeCompletenessSession(session)).state.acceptedInventory?.acceptedInventoryDigest).toBe(f.accepted.acceptedInventoryDigest);
    await session.submitSourceReview(fixtureReview(proposal), (await session.status('source-reviewer')).stageViewDigest);
    await expect(session.finalize({}, (await session.status('author')).stageViewDigest)).rejects.toThrow();
    await session.submitCompletenessReview(await omissionReview(session, 'prose'), (await session.status('completeness-reviewer')).stageViewDigest);
    const last = (await captureKnowledgeCompletenessSession(session)).state;
    expect(last.phase).toBe('completeness-failed');
    expect(last.terminal).toEqual({ code: 'review-exhausted', round: 2 });
    expect(last.attempts).toHaveLength(2);
    expect(last.attempts[0]).toEqual(firstAttempt);
    await expect(session.correctProse(unchanged, (await session.status('author')).stageViewDigest)).rejects.toThrow();
  });

  it('makes a later source-grounded inventory defect terminal without permitting list repair', async () => {
    const { session } = await sessionFixture();
    const f = await driveProse(session);
    await session.submitCompletenessReview(await omissionReview(session, 'inventory'), (await session.status('completeness-reviewer')).stageViewDigest);
    const state = (await captureKnowledgeCompletenessSession(session)).state;
    expect(state.terminal).toEqual({ code: 'inventory-defect', round: 1 });
    expect(state.acceptedInventory?.acceptedInventoryDigest).toBe(f.accepted.acceptedInventoryDigest);
    await expect(session.submitSourceReview(fixtureReview(f.proposal), (await session.status('source-reviewer')).stageViewDigest)).rejects.toThrow();
    await expect(session.correctProse({}, (await session.status('author')).stageViewDigest)).rejects.toThrow();
    expect((await captureKnowledgeCompletenessSession(session)).state.stateDigest).toBe(state.stateDigest);
  });

  it('rejects suspected secrets without accepting or echoing inventory values', async () => {
    const { session } = await sessionFixture();
    const before = await captureKnowledgeCompletenessSession(session), input = inventoryInput(session.exchange, 'blind-shadow-reviewer');
    const sentinel = 'ghp_' + '1234567890'.repeat(3) + '123456';
    const bad = { ...input, questions: input.questions.map(q => ({ ...q, categories: q.categories.map(c => ({ ...c,
      items: c.items.map(i => ({ ...i, rationale: sentinel })) })) })) };
    const attempt = session.submitShadowInventory(seal(bad, 'inventoryDigest'), (await session.status('completeness-reviewer')).stageViewDigest);
    await expect(attempt).rejects.toThrow(ProjectKnowledgeError);
    await attempt.catch((error: unknown) => { expect(String(error)).not.toContain(sentinel); });
    expect((await captureKnowledgeCompletenessSession(session)).state.stateDigest).toBe(before.state.stateDigest);
  });

  it('rejects a reviewer shared with the completeness role and fails closed on policy drift', async () => {
    const { root, session } = await sessionFixture(), f = await driveProse(session);
    const { reviewDigest: prior, ...basis } = fixtureReview(f.proposal); void prior;
    await expect(session.submitSourceReview(seal({ ...basis, reviewer }, 'reviewDigest'),
      (await session.status('source-reviewer')).stageViewDigest)).rejects.toThrow(ProjectKnowledgeError);
    await writeSecurityPolicy(root, 'parcel', { capabilities: [], classification: 'internal' });
    await expect(session.status()).rejects.toMatchObject({ code: 'KNOWLEDGE_DRIFT' });
  });
});

function seal(value: object, key: string): object {
  return { ...value, [key]: digest(value) };
}
const reviewer = { ...TEST_KNOWLEDGE_ACTOR, sessionId: 'inventory-fixture-reviewer' };

async function context() {
  const snapshot = await knowledgeFixtureSnapshot();
  const basis = { schemaVersion: 'buildlore.knowledge-exchange.v1' as const, projectId: snapshot.projectId, snapshot,
    baselineGenerationDigest: null, previousRecords: [], previousEvidence: [], instructions: [],
    boundary: { generationActor: 'current-agent-session' as const, egress: 'none' as const, processSpawned: false as const } };
  const exchange = createKnowledgeCompletenessExchange({ ...basis, exchangeDigest: digest(basis) }, [{ id: 'purpose',
    question: 'What does Parcel do?', role: 'overview', requirements: [
      { id: 'purpose-source', sourceRef: 'README.md', jsonPointer: null, contentKind: 'text' },
    ] }]);
  return { exchange, proposal: fixtureProposal(snapshot), evidenceIds: fixtureFact(snapshot).evidenceIds };
}

function inventoryInput(exchange: KnowledgeCompletenessExchangeV1, role: KnowledgeCompletenessInventoryV1['role']) {
  return { schemaVersion: 'buildlore.knowledge-completeness-inventory.v1' as const, ...completenessBinding(exchange), role,
    actor: role === 'author' ? TEST_KNOWLEDGE_ACTOR : reviewer,
    questions: exchange.authoringQuestions.map(question => ({ questionId: question.id,
      categories: COMPLETENESS_CATEGORIES.map(category => ({ category,
        items: category === 'direct-answer' ? [{ itemId: 'purpose-answer', questionId: question.id, category,
          statement: 'Parcel prepares local delivery manifests.', requirementIds: ['purpose-source'], support: 'source-supported' as const,
          evidenceIds: fixtureFact(exchange.baseExchange.snapshot).evidenceIds, relevance: 'current' as const,
          rationale: 'Deterministic protocol fixture, not an independent semantic grade.' }] : [],
        disposition: category === 'direct-answer' ? null : { status: 'not-applicable' as const,
          rationale: 'No additional required category in this narrow protocol fixture.', requirementIds: [], sourceStatuses: [] },
      })) })),
  };
}

function reviewInput(exchange: KnowledgeCompletenessExchangeV1, shadow: KnowledgeCompletenessInventoryV1,
  author: KnowledgeCompletenessInventoryV1, useShadow = false) {
  return { schemaVersion: 'buildlore.knowledge-completeness-inventory-review.v1' as const, ...completenessBinding(exchange),
    shadowInventoryDigest: shadow.inventoryDigest, authorInventoryDigest: author.inventoryDigest, reviewer,
    judgments: [author, shadow].flatMap(inventory => completenessInventoryItems(inventory).map(item => ({ role: inventory.role,
      itemId: item.itemId, disposition: (inventory.role === 'author') !== useShadow ? 'required' as const : 'duplicate' as const,
      duplicateOf: (inventory.role === 'author') !== useShadow ? null : { role: useShadow ? 'blind-shadow-reviewer' as const : 'author' as const,
        itemId: 'purpose-answer' }, evidenceIds: item.evidenceIds, rationale: 'Explicit union disposition in a deterministic fixture.' }))),
    questions: exchange.authoringQuestions.map(question => ({ questionId: question.id, categories: COMPLETENESS_CATEGORIES.map(category => ({
      category, status: category === 'direct-answer' ? 'complete' as const : 'not-applicable' as const,
      rationale: 'Category disposition is independently declared by this test fixture reviewer.',
    })) })), decision: useShadow ? 'reconcilable' as const : 'accepted' as const };
}

async function acceptedFixture() {
  const c = await context();
  const shadow = parseKnowledgeCompletenessInventory(seal(inventoryInput(c.exchange, 'blind-shadow-reviewer'), 'inventoryDigest'), c.exchange, 'blind-shadow-reviewer');
  const author = parseKnowledgeCompletenessInventory(seal(inventoryInput(c.exchange, 'author'), 'inventoryDigest'), c.exchange, 'author');
  const review = parseKnowledgeCompletenessInventoryReview(seal(reviewInput(c.exchange, shadow, author), 'reviewDigest'), c.exchange, shadow, author);
  const accepted = acceptKnowledgeCompletenessInventory(c.exchange, shadow, author, review, null);
  return { ...c, shadow, author, review, accepted };
}
function mappingInput(exchange: KnowledgeCompletenessExchangeV1, accepted: KnowledgeCompletenessAcceptedInventoryV1,
  proposalDigest: ReturnType<typeof digest>, mapped = true) {
  return { schemaVersion: 'buildlore.knowledge-completeness-prose-mapping.v1' as const, ...completenessBinding(exchange),
    acceptedInventoryDigest: accepted.acceptedInventoryDigest, proposalDigest, author: accepted.author,
    items: accepted.requiredItems.map(item => ({ itemId: item.itemId, status: mapped ? 'mapped' as const : 'missing' as const,
      locators: mapped ? [{ pageRole: 'architecture' as const, sectionIndex: 0, claimIndex: 0, claimId: 'claim-architecture' }] : [] })) };
}

describe('closed source-grounded completeness contracts', () => {
  it('retains seven dispositions per question and accepts the independently reviewed union', async () => {
    const f = await acceptedFixture();
    expect(f.accepted.requiredItems).toHaveLength(1);
    expect(f.accepted.requiredItems[0]?.origin).toEqual({ role: 'author', itemId: 'purpose-answer' });
    expect(f.accepted.shadowInventoryDigest).toBe(f.shadow.inventoryDigest);
    expect(f.accepted.authorInventoryDigest).toBe(f.author.inventoryDigest);
    expect(f.accepted.optionalDispositions[0]?.categories).toHaveLength(7);
    expect(f.accepted.reconciliationDigest).toBeNull();
    expect(Object.isFrozen(f.accepted.requiredItems)).toBe(true);
  });

  it.each(['question', 'category', 'item', 'requirement', 'evidence', 'project', 'digest'] as const)(
    'rejects a changed %s even with newly computed editable digests', async field => {
      const f = await context();
      const input = inventoryInput(f.exchange, 'author');
      const question = input.questions[0]; const category = question?.categories[0]; const item = category?.items[0];
      if (!question || !category || !item) throw new Error('Missing fixture item.');
      let value: unknown;
      if (field === 'question') value = { ...input, questions: [] };
      else if (field === 'category') value = { ...input, questions: [{ ...question, categories: question.categories.slice(1) }] };
      else if (field === 'item') value = { ...input, questions: [{ ...question, categories: [{ ...category, items: [item, item] }, ...question.categories.slice(1)] }] };
      else if (field === 'requirement') value = { ...input, questions: [{ ...question, categories: [{ ...category, items: [{ ...item, requirementIds: ['invented'] }] }, ...question.categories.slice(1)] }] };
      else if (field === 'evidence') value = { ...input, questions: [{ ...question, categories: [{ ...category, items: [{ ...item, evidenceIds: [digest('absent evidence')] }] }, ...question.categories.slice(1)] }] };
      else if (field === 'project') value = { ...input, projectId: 'another-project' };
      else value = { ...input, questionsDigest: digest('other questions') };
      expect(() => parseKnowledgeCompletenessInventory(seal(record(value), 'inventoryDigest'), f.exchange, 'author')).toThrow(ProjectKnowledgeError);
    });

  it('rejects unknown fields, incomplete categories and source requirements omitted from all items', async () => {
    const f = await context(), input = inventoryInput(f.exchange, 'author');
    expect(() => parseKnowledgeCompletenessInventory(seal({ ...input, extra: true }, 'inventoryDigest'), f.exchange, 'author')).toThrow();
    const value = { ...input, questions: input.questions.map(q => ({ ...q, categories: q.categories.map(c => ({ ...c,
      items: c.items.map(i => ({ ...i, requirementIds: [] })) })) })) };
    expect(() => parseKnowledgeCompletenessInventory(seal(value, 'inventoryDigest'), f.exchange, 'author')).toThrow(ProjectKnowledgeError);
  });

  it('does not evaluate getters or toJSON before JSON admission', () => {
    const getter = vi.fn(() => 'not admitted');
    expect(() => completenessJson(Object.defineProperty({}, 'body', { enumerable: true, get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const toJSON = vi.fn(() => ({}));
    expect(() => completenessJson({ toJSON })).toThrow();
    expect(toJSON).not.toHaveBeenCalled();
    expect(() => completenessJson({ text: '\ud800' })).toThrow();
  });

  it('enforces canonical byte admission at the boundary without exposing body values', () => {
    const overhead = Buffer.byteLength(serializeCanonicalJson({ body: '' }));
    const body = 'a'.repeat(COMPLETENESS_LIMITS.artifact - overhead);
    expect(completenessJson({ body }).body).toBe(body);
    expect(() => completenessJson({ body: body + 'a' })).toThrow(KnowledgeCompletenessBudgetError);
    try { completenessJson({ body: body + 'a' }); } catch (error) {
      expect(error).toMatchObject({ code: 'KNOWLEDGE_COMPLETENESS_BUDGET_EXCEEDED', maximumBytes: 262_144 });
      expect(String(error)).not.toContain(body);
    }
  });

  it('rejects self review and deletion of a shadow reviewer item', async () => {
    const f = await acceptedFixture();
    const input = reviewInput(f.exchange, f.shadow, f.author);
    expect(() => parseKnowledgeCompletenessInventoryReview(seal({ ...input, reviewer: TEST_KNOWLEDGE_ACTOR }, 'reviewDigest'),
      f.exchange, f.shadow, f.author)).toThrow(ProjectKnowledgeError);
    expect(() => parseKnowledgeCompletenessInventoryReview(seal({ ...input, judgments: input.judgments.slice(0, 1) }, 'reviewDigest'),
      f.exchange, f.shadow, f.author)).toThrow(ProjectKnowledgeError);
  });

  it('admits exactly reviewed shadow additions and preserves all reconciliation dispositions', async () => {
    const f = await acceptedFixture();
    const review = parseKnowledgeCompletenessInventoryReview(seal(reviewInput(f.exchange, f.shadow, f.author, true), 'reviewDigest'),
      f.exchange, f.shadow, f.author);
    const input = { schemaVersion: 'buildlore.knowledge-completeness-inventory-reconciliation.v1', ...completenessBinding(f.exchange),
      inventoryReviewDigest: review.reviewDigest, author: f.author.actor, dispositions: review.judgments.map(j => ({ role: j.role,
        itemId: j.itemId, disposition: j.disposition, rationale: 'Accept the exact reviewed union disposition.' })) };
    const reconciliation = parseKnowledgeCompletenessReconciliation(seal(input, 'reconciliationDigest'), f.exchange, review, f.author.actor);
    const result = acceptKnowledgeCompletenessInventory(f.exchange, f.shadow, f.author, review, reconciliation);
    expect(result.requiredItems[0]?.origin.role).toBe('blind-shadow-reviewer');
    expect(result.reconciliationDigest).toBe(reconciliation.reconciliationDigest);
    expect(() => parseKnowledgeCompletenessReconciliation(seal({ ...input, dispositions: [] }, 'reconciliationDigest'),
      f.exchange, review, f.author.actor)).toThrow(ProjectKnowledgeError);
    const changed = { ...input, dispositions: input.dispositions.map(d => ({ ...d, disposition: 'not-required' })) };
    expect(() => parseKnowledgeCompletenessReconciliation(seal(changed, 'reconciliationDigest'),
      f.exchange, review, f.author.actor)).toThrow(ProjectKnowledgeError);
  });

  it('does not turn unresolved inventory findings into accepted canonical prose', async () => {
    const f = await acceptedFixture();
    const input = reviewInput(f.exchange, f.shadow, f.author);
    const review: KnowledgeCompletenessInventoryReviewV1 = parseKnowledgeCompletenessInventoryReview(seal({ ...input, decision: 'unresolved' }, 'reviewDigest'),
      f.exchange, f.shadow, f.author);
    expect(() => acceptKnowledgeCompletenessInventory(f.exchange, f.shadow, f.author, review, null)).toThrow(ProjectKnowledgeError);
  });

  it('allows exact cross-page mappings and rejects stale or mismatching claim indices', async () => {
    const f = await acceptedFixture();
    const input = mappingInput(f.exchange, f.accepted, f.proposal.proposalDigest);
    const mapping = parseKnowledgeCompletenessProseMapping(seal(input, 'mappingDigest'), f.exchange, f.accepted, f.proposal);
    expect(mapping.items[0]?.locators[0]?.pageRole).toBe('architecture');
    const bad = { ...input, items: input.items.map(item => ({ ...item, locators: item.locators.map(l => ({ ...l, claimId: 'claim-overview' })) })) };
    expect(() => parseKnowledgeCompletenessProseMapping(seal(bad, 'mappingDigest'), f.exchange, f.accepted, f.proposal)).toThrow();
    expect(() => parseKnowledgeCompletenessProseMapping(seal({ ...input, acceptedInventoryDigest: digest('old inventory') }, 'mappingDigest'),
      f.exchange, f.accepted, f.proposal)).toThrow();
  });

  it.each([
    { lifecycle: 'current', presentation: 'current', defect: 'none', passed: true },
    { lifecycle: 'stale', presentation: 'uncertainty', defect: 'none', passed: true },
    { lifecycle: 'current', presentation: 'uncertainty', defect: 'none', passed: false },
    { lifecycle: 'stale', presentation: 'current', defect: 'none', passed: false },
    { lifecycle: 'current', presentation: 'current', defect: 'omission', passed: false },
    { lifecycle: 'current', presentation: 'current', defect: 'unsupported', passed: false },
  ] as const)('reviews and finalizes knowledge limits using fact state: $lifecycle/$presentation/$defect', async testCase => {
    const { session, prepare } = await sessionFixture(), exchange = session.exchange;
    const snapshot = exchange.baseExchange.snapshot;
    const evidence = snapshot.evidence.find(e => e.sourceRef === 'README.md' && e.excerpt.includes('implementation has not been evidenced'));
    if (!evidence) throw new Error('Missing documented verification limit.');
    const statement = 'Carrier booking is planned; its implementation has not been evidenced.';
    const build = (role: KnowledgeCompletenessInventoryV1['role']) => {
      const input = inventoryInput(exchange, role);
      return parseKnowledgeCompletenessInventory(seal({ ...input, questions: input.questions.map(q => ({ ...q,
        categories: q.categories.map(c => c.category !== 'verification-limit' ? c : { ...c, disposition: null,
          items: [{ itemId: 'booking-limit', questionId: q.questionId, category: c.category, statement,
            requirementIds: ['purpose-source'], evidenceIds: [evidence.evidenceId], support: 'evidence-backed-known-unknown',
            relevance: 'uncertainty', rationale: 'Selected README explicitly records the implementation evidence limit.' }] }) })) }, 'inventoryDigest'), exchange, role);
    };
    const shadow = build('blind-shadow-reviewer'), author = build('author');
    await session.submitShadowInventory(shadow, (await session.status('completeness-reviewer')).stageViewDigest);
    await session.submitAuthorInventory(author, (await session.status('author')).stageViewDigest);
    const input = reviewInput(exchange, shadow, author);
    await session.submitInventoryReview(seal({ ...input,
      judgments: input.judgments.map(j => ({ ...j, duplicateOf: j.disposition === 'duplicate' ? { role: 'author', itemId: j.itemId } : null }))
        .sort((a, b) => compare(completenessRefKey(a), completenessRefKey(b))),
      questions: input.questions.map(q => ({ ...q, categories: q.categories.map(c => c.category === 'verification-limit'
        ? { ...c, status: 'complete' } : c) })),
    }, 'reviewDigest'), (await session.status('completeness-reviewer')).stageViewDigest);
    const accepted = (await captureKnowledgeCompletenessSession(session)).state.acceptedInventory;
    if (!accepted) throw new Error('Missing accepted limit inventory.');
    const limit = { ...fixtureFact(snapshot), predicate: 'verification-limit', statement,
      lifecycle: testCase.lifecycle, evidenceIds: [evidence.evidenceId] };
    const limitRecord = fixtureProposal(snapshot, [limit]).facts[0];
    if (!limitRecord) throw new Error('Missing limit record.');
    const ordinary = fixtureProposal(snapshot);
    const proposal = createKnowledgeProposal({ projectId: exchange.projectId, snapshotDigest: snapshot.snapshotDigest,
      baselineGenerationDigest: null, actor: ordinary.actor, facts: [fixtureFact(snapshot), limit], supersessions: [], conflicts: [],
      pages: ordinary.pages.map(p => ({ ...p, sections: p.sections.map(section => ({ ...section, claims: [...section.claims,
        { claimId: `limit-${p.role}`, text: testCase.defect === 'omission' ? 'Carrier booking is planned.' : statement,
          factIds: [limitRecord.id], presentation: testCase.presentation }] })) })),
    }, snapshot);
    const mapped = mappingInput(exchange, accepted, proposal.proposalDigest);
    const mapping = parseKnowledgeCompletenessProseMapping(seal({ ...mapped, items: mapped.items.map((item, i) =>
      accepted.requiredItems[i]?.category === 'verification-limit' ? { ...item, locators: [{ pageRole: 'architecture',
        sectionIndex: 0, claimIndex: 1, claimId: 'limit-architecture' }] } : item) }, 'mappingDigest'), exchange, accepted, proposal);
    await session.submitProse({ schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: exchange.projectId,
      runId: exchange.runId, proposal, mapping, attempt: 1, correctionOfReviewRoundDigest: null }, (await session.status('author')).stageViewDigest);
    await session.submitCompletenessReview(await omissionReview(session, testCase.defect === 'omission' ? 'prose' : 'none'),
      (await session.status('completeness-reviewer')).stageViewDigest);
    const { reviewDigest: oldDigest, ...sourceReview } = fixtureReview(proposal); void oldDigest;
    await session.submitSourceReview(seal({ ...sourceReview, judgments: sourceReview.judgments.map(j =>
      testCase.defect === 'unsupported' && j.targetId === limitRecord.id ? { ...j, verdict: 'unsupported' } : j) }, 'reviewDigest'),
    (await session.status('source-reviewer')).stageViewDigest);
    if (!testCase.passed) {
      expect((await session.status()).phase).toBe('awaiting-correction');
      const final = await finalizeInput(session);
      await expect(session.finalize(final.input, final.expectStage)).rejects.toThrow(ProjectKnowledgeError);
      return;
    }
    expect((await session.status()).phase).toBe('review-ready');
    const final = await finalizeInput(session), generation = await session.finalize(final.input, final.expectStage);
    expect(generation.records.find(f => f.id === limitRecord.id)).toMatchObject({ lifecycle: testCase.lifecycle, reviewStatus: 'accepted', statement });
    expect(generation.proposal.pages[1]?.sections[0]?.claims[1]).toMatchObject({ text: statement, presentation: testCase.presentation });
    const captured = await captureKnowledgeCompletenessSession(session), resumed = await prepare(exchange.runId);
    await replayKnowledgeCompletenessSession(resumed, captured.state);
    expect((await captureKnowledgeCompletenessSession(resumed)).state).toEqual(captured.state);
    expect((await resumed.status()).phase).toBe('finalized');
  });

  it('separates missing prose from newly found inventory defects and refuses fake covered verdicts', async () => {
    const f = await acceptedFixture();
    const mapping = parseKnowledgeCompletenessProseMapping(seal(mappingInput(f.exchange, f.accepted, f.proposal.proposalDigest, false), 'mappingDigest'),
      f.exchange, f.accepted, f.proposal);
    const input = { schemaVersion: 'buildlore.knowledge-completeness-review.v1', ...completenessBinding(f.exchange),
      acceptedInventoryDigest: f.accepted.acceptedInventoryDigest, proposalDigest: f.proposal.proposalDigest,
      mappingDigest: mapping.mappingDigest, round: 1, reviewer,
      items: f.accepted.requiredItems.map(item => ({ itemId: item.itemId, verdict: 'missing', rationale: 'No mapped prose.', correction: 'Write the supported answer.' })),
      questions: [{ questionId: 'purpose', verdict: 'prose-defect', rationale: 'Required answer is missing.' }],
      inventoryFindings: [], disclosures: 'frozen-inputs-and-current-proposal-only' };
    expect(parseKnowledgeCompletenessReview(seal(input, 'reviewDigest'), f.exchange, f.accepted, mapping, 1).items[0]?.verdict).toBe('missing');
    expect(() => parseKnowledgeCompletenessReview(seal({ ...input, items: input.items.map(i => ({ ...i, verdict: 'covered', correction: null })) }, 'reviewDigest'),
      f.exchange, f.accepted, mapping, 1)).toThrow();
    const defect = { ...input, questions: [{ questionId: 'purpose', verdict: 'inventory-defect', rationale: 'A source-grounded requirement was missed.' }],
      inventoryFindings: [{ questionId: 'purpose', statement: 'A required qualifier from the selected source.', evidenceIds: f.evidenceIds, rationale: 'Located in the frozen source.' }] };
    expect(parseKnowledgeCompletenessReview(seal(defect, 'reviewDigest'), f.exchange, f.accepted, mapping, 1).inventoryFindings).toHaveLength(1);
    expect(() => parseKnowledgeCompletenessReview(seal({ ...defect, inventoryFindings: [] }, 'reviewDigest'), f.exchange, f.accepted, mapping, 1)).toThrow();
  });

  it('records source-unavailable requirements as gaps rather than inventing coverage', async () => {
    const f = await context();
    const exchange = createKnowledgeCompletenessExchange(f.exchange.baseExchange, [{ id: 'purpose', question: 'What is the missing plan?',
      role: 'overview', requirements: [{ id: 'missing-source', sourceRef: 'missing.md', jsonPointer: null, contentKind: 'text' }] }]);
    const input = { ...inventoryInput(exchange, 'author'), questions: [{ questionId: 'purpose', categories: COMPLETENESS_CATEGORIES.map(category => ({
      category, items: [], disposition: { status: category === 'direct-answer' ? 'source-gap-unknown' : 'not-applicable',
        rationale: 'The selected snapshot does not contain the declared source.', requirementIds: category === 'direct-answer' ? ['missing-source'] : [],
        sourceStatuses: category === 'direct-answer' ? [{ requirementId: 'missing-source', status: 'unavailable' }] : [] },
    })) }] };
    const inventory = parseKnowledgeCompletenessInventory(seal(input, 'inventoryDigest'), exchange, 'author');
    expect(completenessInventoryItems(inventory)).toHaveLength(0);
    expect(inventory.questions[0]?.categories[0]?.disposition?.status).toBe('source-gap-unknown');
    expect(completenessRefKey({ role: 'author', itemId: 'x' })).toBe('author:x');
  });
});


describe('caller-owned inventory draft diagnostics and repair', () => {
  it('locates a current-source mismatch and repairs one item without mutating the draft or remaining items', async () => {
    const { exchange } = await context(), input = inventoryInput(exchange, 'author');
    const items = input.questions[0]!.categories[0]!.items;
    const original = structuredClone(items[0]!);
    items.push({ ...original, itemId: 'another-supported-item' });
    items[0]!.evidenceIds = [exchange.baseExchange.snapshot.evidence.find(e => e.sourceRef !== 'README.md')!.evidenceId];
    const bad = seal(input, 'inventoryDigest'), before = JSON.stringify(bad);
    let diagnostic;
    try { parseKnowledgeCompletenessInventory(bad, exchange, 'author'); }
    catch (error) {
      expect(error).toBeInstanceOf(KnowledgeCompletenessInventoryError);
      diagnostic = (error as KnowledgeCompletenessInventoryError).details;
    }
    expect(diagnostic).toEqual({ schemaVersion: 'buildlore.knowledge-completeness-inventory-diagnostic.v1',
      rule: 'requirement-needs-current-evidence', draftDigest: digest(bad),
      questionIndex: 0, categoryIndex: 0, itemIndex: 0, requirementIndex: 0 });
    expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThan(COMPLETENESS_LIMITS.recovery);
    const patch = { draftDigest: digest(bad), questionIndex: 0, categoryIndex: 0, itemIndex: 0, replacement: original };
    const repaired = repairKnowledgeCompletenessInventoryDraft(bad, exchange, 'author', patch);
    expect(repaired.questions[0]!.categories[0]!.items[0]).toEqual(original);
    expect(repaired.questions[0]!.categories[0]!.items.slice(1)).toEqual(items.slice(1));
    expect(repaired.questions[0]!.categories.slice(1)).toEqual(input.questions[0]!.categories.slice(1));
    expect(JSON.stringify(bad)).toBe(before);
    expect(() => repairKnowledgeCompletenessInventoryDraft(bad, exchange, 'author', { ...patch, draftDigest: digest('stale') }))
      .toThrow(ProjectKnowledgeError);
    expect(() => repairKnowledgeCompletenessInventoryDraft(bad, exchange, 'blind-shadow-reviewer', patch)).toThrow(ProjectKnowledgeError);
    expect(() => repairKnowledgeCompletenessInventoryDraft({ ...record(bad), projectId: 'elsewhere' }, exchange, 'author', patch)).toThrow();
    expect(() => repairKnowledgeCompletenessInventoryDraft(bad, exchange, 'author', { ...patch, itemIndex: 2 })).toThrow();
    expect(() => repairKnowledgeCompletenessInventoryDraft(bad, exchange, 'author', { ...patch, replacement: { ...original, itemId: 'renamed' } })).toThrow();
    expect(() => repairKnowledgeCompletenessInventoryDraft(bad, exchange, 'author', { ...patch, replacement: items[0] }))
      .toThrow(KnowledgeCompletenessInventoryError);
    const secondBad = structuredClone(input);
    secondBad.questions[0]!.categories[0]!.items[1]!.evidenceIds = items[0]!.evidenceIds;
    const twice = seal(secondBad, 'inventoryDigest');
    expect(() => repairKnowledgeCompletenessInventoryDraft(twice, exchange, 'author', { ...patch, draftDigest: digest(twice) }))
      .toThrow(KnowledgeCompletenessInventoryError);
  });

  it('never echoes invalid item values or evaluates accessors when reporting a location or repairing', async () => {
    const { exchange } = await context(), input = inventoryInput(exchange, 'author');
    input.questions[0]!.categories[0]!.items[0]!.statement = 'private-fixture-marker';
    input.questions[0]!.categories[0]!.items[0]!.requirementIds = ['unknown-fixture-id'];
    try { parseKnowledgeCompletenessInventory(seal(input, 'inventoryDigest'), exchange, 'author'); expect.fail('Rejected item expected.'); }
    catch (error) {
      expect(error).toBeInstanceOf(KnowledgeCompletenessInventoryError);
      expect(JSON.stringify(error)).not.toContain('private-fixture-marker');
      expect(JSON.stringify(error)).not.toContain('unknown-fixture-id');
      expect((error as KnowledgeCompletenessInventoryError).details.rule).toBe('requirement-not-declared');
    }
    const getter = vi.fn(() => 'private-fixture-marker');
    const unsafe = Object.defineProperty({}, 'questions', { enumerable: true, get: getter });
    expect(() => parseKnowledgeCompletenessInventory(unsafe, exchange, 'author')).toThrow();
    expect(() => repairKnowledgeCompletenessInventoryDraft(unsafe, exchange, 'author', {})).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not satisfy a current requirement with only historical evidence', async () => {
    const { exchange } = await context(), historical = await knowledgeFixtureSnapshot('R2');
    const base = { ...exchange.baseExchange, previousEvidence: historical.evidence };
    const withHistory = createKnowledgeCompletenessExchange(base, exchange.authoringQuestions);
    const input = inventoryInput(withHistory, 'author');
    const evidence = historical.evidence.find(e => e.sourceRef === 'README.md' &&
      !base.snapshot.evidence.some(current => current.evidenceId === e.evidenceId))!;
    expect(evidence).toBeDefined();
    input.questions[0]!.categories[0]!.items[0]!.evidenceIds = [evidence.evidenceId];
    expect(() => parseKnowledgeCompletenessInventory(seal(input, 'inventoryDigest'), withHistory, 'author'))
      .toThrow(KnowledgeCompletenessInventoryError);
  });
});
