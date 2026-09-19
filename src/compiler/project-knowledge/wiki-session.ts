import { boundedJson, digest, hash, invalid, keys, list, project, record, text, ProjectKnowledgeError } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from '../../knowledge/project-knowledge/types.js';
import { parseKnowledgeProposal } from './proposal.js';
import { requireKnowledgePreparedSessionCore, type KnowledgeSessionV1 } from './session.js';
import { createKnowledgeWikiDraft, createKnowledgeWikiReview, knowledgeWikiResolutions, knowledgeWikiReviewTargets,
  knowledgeWikiSemanticReview, parseKnowledgeWikiPurpose, parseKnowledgeWikiReview, WIKI_CORRECTION_LIMIT,
  type KnowledgeWikiPurpose, type KnowledgeWikiRevision } from './wiki-contracts.js';

export interface KnowledgeWikiState {
  readonly schemaVersion: 'buildlore.wiki-state.v1';
  readonly projectId: string;
  readonly runId: string;
  readonly exchangeDigest: KnowledgeDigest;
  readonly purpose: KnowledgeWikiPurpose;
  readonly revisions: readonly KnowledgeWikiRevision[];
  readonly stateDigest: KnowledgeDigest;
}
export interface KnowledgeWikiSession {
  state(): KnowledgeWikiState;
  view(): ReturnType<typeof wikiView>;
  inspect(value: unknown, expectStage: KnowledgeDigest): Promise<unknown>;
  submit(value: unknown, resolutions: unknown, expectStage: KnowledgeDigest): Promise<void>;
  review(value: unknown, expectStage: KnowledgeDigest): Promise<void>;
  finalize(expectStage: KnowledgeDigest): Promise<KnowledgeGenerationV1>;
}

function freezeState(basis: Omit<KnowledgeWikiState, 'stateDigest'>): KnowledgeWikiState {
  if (Buffer.byteLength(JSON.stringify(basis)) > 8 * 1024 * 1024) invalid();
  return Object.freeze({ ...basis, stateDigest: digest(basis) });
}
function wikiView(state: KnowledgeWikiState) {
  const last = state.revisions.at(-1), review = last?.review;
  const correctionsRemaining = WIKI_CORRECTION_LIMIT - Math.max(0, state.revisions.length - 1);
  return Object.freeze({ schemaVersion: 'buildlore.wiki-stage.v1' as const, stageDigest: state.stateDigest,
    projectId: state.projectId, runId: state.runId, purpose: state.purpose,
    phase: !last ? 'awaiting-draft' : !review ? 'awaiting-review' : review.usable ? 'reviewed' : 'incomplete',
    correctionCount: Math.max(0, state.revisions.length - 1), correctionsRemaining,
    assessment: !review ? 'pending' : !review.usable ? 'incomplete' : review.findings.some(f => f.status === 'open') ? 'needs-attention' : 'reviewed',
    openFindingCount: review?.findings.filter(f => f.status === 'open').length ?? 0,
    revisionCount: state.revisions.length, proposalDigest: last?.proposal.proposalDigest ?? null,
    reviewDigest: review?.reviewDigest ?? null,
    nextActions: !last ? ['inspect', 'submit'] : !review ? ['inspect', 'review']
      : [...(correctionsRemaining > 0 ? ['inspect', 'revise'] : ['inspect']), ...(review.usable ? ['finalize'] : [])] });
}

/** No pre-prose inventory gate. All source disclosure and persistence are screened. */
export async function createKnowledgeWikiSession(base: KnowledgeSessionV1, purposeValue: unknown, runId: string,
  saved?: unknown): Promise<KnowledgeWikiSession> {
  if (base.exchange.schemaVersion !== 'buildlore.knowledge-exchange.v3' || !/^run-[a-f0-9]{64}$/u.test(runId)) invalid();
  const core = requireKnowledgePreparedSessionCore(base), snapshot = base.exchange.snapshot;
  const purpose = parseKnowledgeWikiPurpose(purposeValue, snapshot.projectId);
  await core.screen(purpose);
  let state = freezeState({ schemaVersion: 'buildlore.wiki-state.v1', projectId: snapshot.projectId, runId,
    exchangeDigest: base.exchange.exchangeDigest, purpose, revisions: [] });
  if (saved !== undefined) {
    const r = record(boundedJson(saved)); keys(r, ['schemaVersion', 'projectId', 'runId', 'exchangeDigest', 'purpose', 'revisions', 'stateDigest']);
    if (r.schemaVersion !== state.schemaVersion || r.projectId !== state.projectId || r.runId !== runId ||
      r.exchangeDigest !== state.exchangeDigest || digest(r.purpose) !== digest(purpose)) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
    const revisions: KnowledgeWikiRevision[] = [];
    const values = list(r.revisions, WIKI_CORRECTION_LIMIT + 1);
    for (const [index, value] of values.entries()) {
      const item = record(value); keys(item, ['proposal', 'resolutions', 'review']);
      const prior = revisions.at(-1) ?? null, proposal = parseKnowledgeProposal(item.proposal, snapshot);
      if (proposal.schemaVersion !== 'buildlore.knowledge-proposal.v2' || proposal.baselineGenerationDigest !== base.exchange.baselineGenerationDigest ||
        prior !== null && prior.review === null || item.review === null && index !== values.length - 1) invalid();
      const resolutions = knowledgeWikiResolutions(item.resolutions, prior);
      const review = item.review === null ? null : parseKnowledgeWikiReview(item.review, proposal, snapshot, runId, prior, core.previous);
      if (review !== null) knowledgeWikiSemanticReview(review, proposal, snapshot, core.previous);
      revisions.push({ proposal, resolutions, review });
    }
    if (revisions.some(revision => revisions.some(author => author.proposal.actor.sessionId === revision.review?.reviewer.sessionId))) invalid();
    const next = freezeState({ ...stateBasis(state), revisions: Object.freeze(revisions) });
    if (hash(r.stateDigest) !== next.stateDigest || digest(r) !== digest(next)) invalid();
    await core.screen(next);
    state = next;
  }
  let busy = false;
  const guard = (expected: KnowledgeDigest): void => {
    if (busy || expected !== state.stateDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  };
  return Object.freeze({ state: () => state, view: () => wikiView(state),
    async inspect(value: unknown, expected: KnowledgeDigest): Promise<unknown> {
      guard(expected);
      const r = record(boundedJson(value));
      keys(r, ['schemaVersion', 'projectId', 'mode', 'offset', 'limit', 'maxBytes', ...(Object.hasOwn(r, 'query') ? ['query'] : [])]);
      if (r.schemaVersion !== 'buildlore.wiki-inspection.v1') invalid();
      project(r.projectId, snapshot.projectId);
      const offset = integer(r.offset, 0, 16384), limit = integer(r.limit, 1, 128), maxBytes = integer(r.maxBytes, 1024, 131072);
      const mode = text(r.mode, 32), query = r.query === undefined ? '' : text(r.query, 1024).toLocaleLowerCase();
      let items: readonly unknown[];
      if (mode === 'sources') items = snapshot.sources.map(({ content, ...source }) => ({ ...source, contentBytes: Buffer.byteLength(content) }));
      else if (mode === 'evidence') items = snapshot.evidence.filter(e => query === '' || [e.sourceRef, e.excerpt].some(v => v.toLocaleLowerCase().includes(query)));
      else if (mode === 'draft') {
        const proposal = state.revisions.at(-1)?.proposal;
        items = proposal?.pages.flatMap(page => page.sections.flatMap(section => section.claims.map(claim => ({
          pageId: page.role, pageTitle: page.title, sectionId: section.sectionId, sectionTitle: section.title, claim,
          evidenceIds: claim.factIds.flatMap(id => proposal.facts.find(fact => fact.id === id)?.evidenceIds ?? invalid()),
        })))) ?? [];
      }
      else if (mode === 'targets') items = state.revisions.at(-1) ? knowledgeWikiReviewTargets(state.revisions.at(-1)?.proposal ?? invalid()) : [];
      else if (mode === 'findings') items = state.revisions.at(-1)?.review?.findings ?? [];
      else if (mode === 'history') items = state.revisions.flatMap((revision, index): unknown[] => [{ index, proposalDigest: revision.proposal.proposalDigest,
        author: revision.proposal.actor, reviewDigest: revision.review?.reviewDigest ?? null, usable: revision.review?.usable ?? null },
        ...revision.resolutions.map(resolution => ({ index, resolution })), ...revision.review?.findings.map(finding => ({ index, finding })) ?? []]);
      else if (mode === 'baseline') items = core.previous?.pages.flatMap(page => page.sections.flatMap(section =>
        section.claims.map(claim => ({ pageId: page.role, pageTitle: page.title, sectionId: section.sectionId ?? null, sectionTitle: section.title, claim })))) ?? [];
      else invalid();
      if (offset > items.length) invalid();
      await core.screen({ request: r, items });
      const selected: unknown[] = [];
      const response = () => ({ schemaVersion: 'buildlore.wiki-inspection-result.v1', projectId: snapshot.projectId, runId,
        stageDigest: state.stateDigest, snapshotDigest: snapshot.snapshotDigest, baselineGenerationDigest: base.exchange.baselineGenerationDigest,
        mode, totalItems: items.length, offset, nextOffset: offset + selected.length < items.length ? offset + selected.length : null, items: selected });
      for (const item of items.slice(offset, offset + limit)) {
        selected.push(item);
        if (Buffer.byteLength(JSON.stringify(response())) > maxBytes) { selected.pop(); break; }
      }
      if (!selected.length && offset < items.length) return { ...response(), budgetExceeded: true,
        requiredBytes: Buffer.byteLength(JSON.stringify({ ...response(), items: [items[offset]] })) };
      return response();
    },
    async submit(value: unknown, resolutionsValue: unknown, expected: KnowledgeDigest): Promise<void> {
      guard(expected); busy = true;
      try {
        const prior = state.revisions.at(-1) ?? null;
        if (prior !== null && (prior.review === null || state.revisions.length >= WIKI_CORRECTION_LIMIT + 1)) invalid();
        const proposal = createKnowledgeWikiDraft(value, snapshot, base.exchange.baselineGenerationDigest);
        if (state.revisions.some(revision => revision.review?.reviewer.sessionId === proposal.actor.sessionId)) invalid();
        const resolutions = knowledgeWikiResolutions(resolutionsValue, prior);
        const next = freezeState({ ...stateBasis(state), revisions: Object.freeze([...state.revisions, { proposal, resolutions, review: null }]) });
        await core.screen(next);
        state = next;
      } finally { busy = false; }
    },
    async review(value: unknown, expected: KnowledgeDigest): Promise<void> {
      guard(expected); busy = true;
      try {
        const last = state.revisions.at(-1) ?? invalid();
        if (last.review !== null) invalid();
        const review = createKnowledgeWikiReview(value, last.proposal, snapshot, runId, state.revisions.at(-2) ?? null, core.previous);
        if (state.revisions.some(revision => revision.proposal.actor.sessionId === review.reviewer.sessionId)) invalid();
        knowledgeWikiSemanticReview(review, last.proposal, snapshot, core.previous);
        const next = freezeState({ ...stateBasis(state), revisions: Object.freeze([...state.revisions.slice(0, -1), { ...last, review }]) });
        await core.screen(next);
        state = next;
      } finally { busy = false; }
    },
    async finalize(expected: KnowledgeDigest): Promise<KnowledgeGenerationV1> {
      guard(expected); busy = true;
      try {
        const last = state.revisions.at(-1) ?? invalid();
        if (!last.review?.usable) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
        const proofBasis = { schemaVersion: 'buildlore.wiki-proof.v1', projectId: state.projectId, runId, purpose, revisions: state.revisions };
        const proof = { ...proofBasis, proofDigest: digest(proofBasis) };
        await core.screen(proof);
        await base.submit(last.proposal, base.exchange.exchangeDigest);
        return await base.finalize(knowledgeWikiSemanticReview(last.review, last.proposal, snapshot, core.previous), last.proposal.proposalDigest, undefined, proof);
      } finally { busy = false; }
    },
  });
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function stateBasis(state: KnowledgeWikiState): Omit<KnowledgeWikiState, 'stateDigest'> {
  const { stateDigest: _, ...basis } = state; void _; return basis;
}
