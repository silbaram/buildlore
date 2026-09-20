import { boundedJson, choice, compare, digest, hash, hashes, identifier, invalid, keys, list, project, record, text } from '../../knowledge/project-knowledge/guards.js';
import { createProposedKnowledgeRecord, parseKnowledgeActor } from '../../knowledge/project-knowledge/records.js';
import type { KnowledgeActorV1, KnowledgeClaimReviewV1, KnowledgeFactInputV1, KnowledgeDigest, KnowledgeGenerationV1, KnowledgeProposalV1,
  KnowledgeSemanticReviewV1, KnowledgeSnapshotV1 } from '../../knowledge/project-knowledge/types.js';
import { createKnowledgeProposal, knowledgePageKey, knowledgeReviewTargets, parseKnowledgeProposal, parseKnowledgeSemanticReview } from './proposal.js';

export const WIKI_CORRECTION_LIMIT = 2;
export interface KnowledgeWikiPurpose {
  readonly schemaVersion: 'buildlore.wiki-purpose.v1';
  readonly projectId: string;
  readonly outputLanguage: string;
  readonly goal: string;
  readonly audience: string;
  readonly template: 'general' | 'development';
}
export interface KnowledgeWikiFinding {
  readonly id: string;
  readonly pageId: string | null;
  readonly claimId: string | null;
  readonly kind: 'accuracy' | 'citation' | 'missing' | 'conflict' | 'unclear' | 'unknown';
  readonly description: string;
  readonly evidenceIds: readonly KnowledgeDigest[];
  readonly status: 'open' | 'resolved';
  readonly resolution: string | null;
}
export interface KnowledgeWikiResolution {
  readonly findingId: string;
  readonly action: 'corrected' | 'removed' | 'deferred';
  readonly note: string;
}
export interface KnowledgeWikiReview {
  readonly schemaVersion: 'buildlore.wiki-review.v1';
  readonly projectId: string;
  readonly runId: string;
  readonly proposalDigest: KnowledgeDigest;
  readonly snapshotDigest: KnowledgeDigest;
  readonly reviewer: KnowledgeActorV1;
  readonly judgments: readonly KnowledgeClaimReviewV1[];
  readonly findings: readonly KnowledgeWikiFinding[];
  readonly baselineReview: Readonly<{ generationDigest: KnowledgeDigest; decision: 'accepted' | 'incomplete'; rationale: string }> | null;
  readonly usable: boolean;
  readonly rationale: string;
  readonly reviewDigest: KnowledgeDigest;
}
export interface KnowledgeWikiRevision {
  readonly proposal: KnowledgeProposalV1;
  readonly resolutions: readonly KnowledgeWikiResolution[];
  readonly review: KnowledgeWikiReview | null;
}
export interface KnowledgeWikiProof {
  readonly schemaVersion: 'buildlore.wiki-proof.v1';
  readonly projectId: string;
  readonly runId: string;
  readonly purpose: KnowledgeWikiPurpose;
  readonly revisions: readonly KnowledgeWikiRevision[];
  readonly proofDigest: KnowledgeDigest;
}
export interface KnowledgeWikiAssessment {
  readonly status: 'reviewed' | 'needs-attention';
  readonly openFindingCount: number;
  readonly findings: readonly KnowledgeWikiFinding[];
  readonly reviewDigest: KnowledgeDigest;
}

export function parseKnowledgeWikiPurpose(value: unknown, projectId: string): KnowledgeWikiPurpose {
  const r = record(boundedJson(value));
  keys(r, ['schemaVersion', 'projectId', 'outputLanguage', 'goal', 'audience', ...(Object.hasOwn(r, 'template') ? ['template'] : [])]);
  if (r.schemaVersion !== 'buildlore.wiki-purpose.v1') invalid();
  const outputLanguage = text(r.outputLanguage, 35);
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(outputLanguage)) invalid();
  return Object.freeze({ schemaVersion: 'buildlore.wiki-purpose.v1', projectId: project(r.projectId, projectId),
    outputLanguage, goal: text(r.goal, 4096), audience: text(r.audience, 1024),
    template: r.template === undefined ? 'general' : choice(r.template, ['general', 'development']) });
}

/** Small author input: the product constructs identical fact/claim bindings. */
export function createKnowledgeWikiDraft(value: unknown, snapshot: KnowledgeSnapshotV1,
  baselineGenerationDigest: KnowledgeDigest | null): KnowledgeProposalV1 {
  const r = record(boundedJson(value));
  keys(r, ['schemaVersion', 'projectId', 'actor', 'rootPageId', 'pages']);
  if (r.schemaVersion !== 'buildlore.wiki-draft.v1') invalid();
  project(r.projectId, snapshot.projectId);
  const actor = parseKnowledgeActor(r.actor);
  const facts: KnowledgeFactInputV1[] = [];
  const pages = list(r.pages, 32).map(raw => {
    const page = record(raw); keys(page, ['id', 'title', 'sections']);
    const pageId = knowledgePageKey(page.id);
    return { role: pageId, title: text(page.title, 256), sections: list(page.sections, 32).map(rawSection => {
      const section = record(rawSection); keys(section, ['id', 'title', 'claims']);
      return { sectionId: knowledgePageKey(section.id), title: text(section.title, 256), claims: list(section.claims, 256).map(rawClaim => {
        const claim = record(rawClaim); keys(claim, ['id', 'text', 'evidenceIds', ...(Object.hasOwn(claim, 'classification') ? ['classification'] : [])]);
        const id = identifier(claim.id), statement = text(claim.text), evidenceIds = hashes(claim.evidenceIds, 64);
        const input: KnowledgeFactInputV1 = { subject: `wiki:${pageId}:${id}`, predicate: null,
          statement, scope: 'selected source material', classification: claim.classification === undefined ? 'declared'
            : choice(claim.classification, ['declared', 'inferred']), lifecycle: 'current', evidenceIds, observation: null };
        const fact = createProposedKnowledgeRecord(input, snapshot, actor);
        facts.push(input);
        return { claimId: id, text: statement, factIds: [fact.id], presentation: 'current' as const };
      }) };
    }) };
  });
  return createKnowledgeProposal({ schemaVersion: 'buildlore.knowledge-proposal.v2', projectId: snapshot.projectId,
    snapshotDigest: snapshot.snapshotDigest, baselineGenerationDigest, actor, rootPageId: r.rootPageId,
    facts, pages, supersessions: [], conflicts: [] }, snapshot);
}

export function knowledgeWikiReviewTargets(proposal: KnowledgeProposalV1): readonly string[] {
  if (proposal.schemaVersion !== 'buildlore.knowledge-proposal.v2') invalid();
  const factIds = new Set(proposal.facts.map(fact => fact.id));
  return knowledgeReviewTargets(proposal).filter(id => !factIds.has(id as KnowledgeDigest));
}

function location(proposal: KnowledgeProposalV1, targetId: string): Pick<KnowledgeWikiFinding, 'pageId' | 'claimId'> {
  for (const page of proposal.pages) {
    if (targetId === `title:${page.role}` || page.sections.some((section, index) => targetId === `section:${page.role}:${section.sectionId ?? String(index)}`)) {
      return { pageId: page.role, claimId: null };
    }
    if (page.sections.some(section => section.claims.some(claim => claim.claimId === targetId))) return { pageId: page.role, claimId: targetId };
  }
  return invalid();
}
function sourceFindingId(targetId: string): string { return `source-${digest(targetId).slice(7, 31)}`; }

/** A reviewer judges a displayed statement once. Its exactly identical fact uses that same judgment. */
export function knowledgeWikiSemanticReview(review: KnowledgeWikiReview, proposal: KnowledgeProposalV1,
  snapshot: KnowledgeSnapshotV1, previous: KnowledgeGenerationV1 | null): KnowledgeSemanticReviewV1 {
  const judgments = [...review.judgments];
  for (const claim of proposal.pages.flatMap(page => page.sections.flatMap(section => section.claims))) {
    const judgment = review.judgments.find(item => item.targetId === claim.claimId) ?? invalid();
    const fact = proposal.facts.find(item => item.id === claim.factIds[0]) ?? invalid();
    if (claim.factIds.length !== 1 || fact.statement !== claim.text) invalid();
    judgments.push({ ...judgment, targetId: fact.id });
  }
  judgments.sort((a, b) => compare(a.targetId, b.targetId));
  const basis = { schemaVersion: 'buildlore.knowledge-semantic-review.v1' as const, projectId: review.projectId,
    proposalDigest: proposal.proposalDigest, snapshotDigest: snapshot.snapshotDigest, reviewer: review.reviewer,
    method: 'source-support-and-currentness' as const, coverageChecked: true as const, judgments };
  return parseKnowledgeSemanticReview({ ...basis, reviewDigest: digest(basis) }, proposal, snapshot, previous);
}

/** New reviews keep prior issue identities, including resolved and deferred issues. */
export function createKnowledgeWikiReview(value: unknown, proposal: KnowledgeProposalV1, snapshot: KnowledgeSnapshotV1,
  runId: string, prior: KnowledgeWikiRevision | null = null, previous: KnowledgeGenerationV1 | null = null): KnowledgeWikiReview {
  const r = record(boundedJson(value));
  keys(r, ['schemaVersion', 'projectId', 'runId', 'proposalDigest', 'snapshotDigest', 'reviewer',
    'judgments', 'findings', 'baselineReview', 'usable', 'rationale', ...(Object.hasOwn(r, 'reviewDigest') ? ['reviewDigest'] : [])]);
  if (r.schemaVersion !== 'buildlore.wiki-review.v1' || r.runId !== runId || r.proposalDigest !== proposal.proposalDigest ||
    r.snapshotDigest !== snapshot.snapshotDigest || typeof r.usable !== 'boolean') invalid();
  const baselineReview = r.baselineReview === null ? null : (() => {
    const b = record(r.baselineReview); keys(b, ['generationDigest', 'decision', 'rationale']);
    return { generationDigest: hash(b.generationDigest), decision: choice(b.decision, ['accepted', 'incomplete']), rationale: text(b.rationale, 4096) };
  })();
  if ((baselineReview?.generationDigest ?? null) !== (previous?.generationDigest ?? null)) invalid();
  const reviewer = parseKnowledgeActor(r.reviewer);
  if (reviewer.sessionId === proposal.actor.sessionId || prior !== null && reviewer.sessionId === prior.proposal.actor.sessionId) invalid();
  const evidence = new Set(snapshot.evidence.map(item => item.evidenceId));
  const judgments = list(r.judgments, 8192).map(raw => {
    const j = record(raw); keys(j, ['targetId', 'verdict', 'evidenceIds', 'rationale']);
    const evidenceIds = hashes(j.evidenceIds, 64), verdict = choice(j.verdict, ['supported', 'unsupported', 'insufficient', 'conflicting']);
    if (evidenceIds.some(id => !evidence.has(id)) || verdict === 'supported' && evidenceIds.length === 0) invalid();
    const targetId = text(j.targetId, 256);
    location(proposal, targetId);
    if (verdict === 'supported') {
      const linked = proposal.pages.flatMap(page => page.sections.flatMap((section, index) =>
        targetId === `title:${page.role}` || targetId === `section:${page.role}:${section.sectionId ?? String(index)}` ? section.claims
          : section.claims.filter(claim => claim.claimId === targetId)));
      const attached = new Set(linked.flatMap(claim => claim.factIds.flatMap(id => proposal.facts.find(fact => fact.id === id)?.evidenceIds ?? invalid())));
      if (!evidenceIds.some(id => attached.has(id))) invalid();
    }
    return { targetId, verdict, evidenceIds, rationale: text(j.rationale, 4096) };
  }).sort((a, b) => compare(a.targetId, b.targetId));
  if (digest(judgments.map(j => j.targetId)) !== digest(knowledgeWikiReviewTargets(proposal))) invalid();
  const previousFindings = prior?.review?.findings ?? [];
  const findings: KnowledgeWikiFinding[] = list(r.findings, 128).map(raw => {
    const f = record(raw); keys(f, ['id', 'pageId', 'claimId', 'kind', 'description', 'evidenceIds', 'status', 'resolution']);
    const id = identifier(f.id), previousFinding = previousFindings.find(item => item.id === id);
    const pageId = f.pageId === null ? null : knowledgePageKey(f.pageId), claimId = f.claimId === null ? null : identifier(f.claimId);
    const page = pageId === null ? null : proposal.pages.find(item => item.role === pageId);
    if (id.startsWith('source-') || (pageId !== null && !page || claimId !== null && !page?.sections.some(section =>
      section.claims.some(claim => claim.claimId === claimId))) &&
      (!previousFinding || previousFinding.pageId !== pageId || previousFinding.claimId !== claimId)) invalid();
    const evidenceIds = hashes(f.evidenceIds, 64);
    if (evidenceIds.some(item => !evidence.has(item))) invalid();
    const status = choice(f.status, ['open', 'resolved']);
    if (status === 'resolved' && (!previousFinding || f.resolution === null)) invalid();
    if (previousFinding && (previousFinding.pageId !== pageId || previousFinding.claimId !== claimId ||
      previousFinding.kind !== f.kind || previousFinding.description !== f.description || digest(previousFinding.evidenceIds) !== digest(evidenceIds))) invalid();
    return { id, pageId, claimId, kind: choice(f.kind, ['accuracy', 'citation', 'missing', 'conflict', 'unclear', 'unknown']),
      description: text(f.description, 4096), evidenceIds, status, resolution: f.resolution === null ? null : text(f.resolution, 4096) };
  });
  if (new Set(findings.map(f => f.id)).size !== findings.length || previousFindings.some(f => !f.id.startsWith('source-') &&
    !findings.some(next => next.id === f.id))) invalid();
  for (const judgment of judgments.filter(j => j.verdict !== 'supported')) {
    findings.push({ id: sourceFindingId(judgment.targetId), ...location(proposal, judgment.targetId),
      kind: judgment.verdict === 'conflicting' ? 'conflict' : judgment.verdict === 'insufficient' ? 'citation' : 'accuracy',
      description: judgment.rationale, evidenceIds: judgment.evidenceIds, status: 'open', resolution: null });
  }
  for (const old of previousFindings.filter(f => f.id.startsWith('source-') && !findings.some(next => next.id === f.id))) {
    findings.push({ ...old, status: 'resolved', resolution: old.status === 'resolved' ? old.resolution
      : 'The independently reviewed revision corrected or removed the affected statement.' });
  }
  findings.sort((a, b) => compare(a.id, b.id));
  const hasSupportedClaim = proposal.pages.some(page => page.sections.some(section => section.claims.some(claim =>
    judgments.find(j => j.targetId === claim.claimId)?.verdict === 'supported')));
  const basis = { schemaVersion: 'buildlore.wiki-review.v1' as const, projectId: project(r.projectId, proposal.projectId), runId,
    proposalDigest: proposal.proposalDigest, snapshotDigest: snapshot.snapshotDigest, reviewer, judgments: Object.freeze(judgments),
    findings: Object.freeze(findings), baselineReview, usable: r.usable && hasSupportedClaim && (baselineReview === null || baselineReview.decision === 'accepted'), rationale: text(r.rationale, 4096) };
  const result = Object.freeze({ ...basis, reviewDigest: digest(basis) });
  if (Object.hasOwn(r, 'reviewDigest') && hash(r.reviewDigest) !== result.reviewDigest) invalid();
  return result;
}

/** Canonical saved reviews include generated source issues; input reviews do not need to repeat them. */
export function parseKnowledgeWikiReview(value: unknown, proposal: KnowledgeProposalV1, snapshot: KnowledgeSnapshotV1,
  runId: string, prior: KnowledgeWikiRevision | null, previous: KnowledgeGenerationV1 | null = null): KnowledgeWikiReview {
  const r = record(boundedJson(value));
  const { reviewDigest, ...input } = r;
  const result = createKnowledgeWikiReview({ ...input, findings: list(r.findings, 24576).filter(f =>
    !text(record(f).id, 256).startsWith('source-')) }, proposal, snapshot, runId, prior, previous);
  if (hash(reviewDigest) !== result.reviewDigest || digest(r) !== digest(result)) invalid();
  return result;
}

export function knowledgeWikiResolutions(value: unknown, prior: KnowledgeWikiRevision | null): readonly KnowledgeWikiResolution[] {
  const open = prior?.review?.findings.filter(f => f.status === 'open') ?? [];
  const resolutions = list(value, 8192).map(raw => {
    const r = record(raw); keys(r, ['findingId', 'action', 'note']);
    const findingId = identifier(r.findingId);
    if (!open.some(f => f.id === findingId)) invalid();
    return { findingId, action: choice(r.action, ['corrected', 'removed', 'deferred']), note: text(r.note, 4096) };
  });
  if (new Set(resolutions.map(r => r.findingId)).size !== resolutions.length) invalid();
  for (const finding of open) if (!resolutions.some(r => r.findingId === finding.id)) {
    resolutions.push({ findingId: finding.id, action: 'deferred', note: 'No author correction was supplied for this issue; it remains subject to independent review.' });
  }
  return Object.freeze(resolutions.sort((a, b) => compare(a.findingId, b.findingId)));
}

export function knowledgeWikiAssessment(generation: KnowledgeGenerationV1): KnowledgeWikiAssessment | null {
  if (generation.schemaVersion !== 'buildlore.knowledge-generation.v3') return null;
  const review = generation.wikiProof?.revisions.at(-1)?.review ?? invalid();
  const findings = review.findings.filter(f => f.status === 'open');
  return Object.freeze({ status: findings.length ? 'needs-attention' : 'reviewed', openFindingCount: findings.length,
    findings, reviewDigest: review.reviewDigest });
}

export function parseKnowledgeWikiProof(value: unknown, snapshot: KnowledgeSnapshotV1, proposal: KnowledgeProposalV1,
  semantic: KnowledgeSemanticReviewV1, previous: KnowledgeGenerationV1 | null): KnowledgeWikiProof {
  const r = record(boundedJson(value));
  if (Buffer.byteLength(JSON.stringify(r)) > 8 * 1024 * 1024) invalid();
  keys(r, ['schemaVersion', 'projectId', 'runId', 'purpose', 'revisions', 'proofDigest']);
  if (r.schemaVersion !== 'buildlore.wiki-proof.v1' || proposal.schemaVersion !== 'buildlore.knowledge-proposal.v2') invalid();
  const runId = text(r.runId, 68);
  if (!/^run-[a-f0-9]{64}$/u.test(runId)) invalid();
  const purpose = parseKnowledgeWikiPurpose(r.purpose, snapshot.projectId), revisions: KnowledgeWikiRevision[] = [];
  for (const raw of list(r.revisions, WIKI_CORRECTION_LIMIT + 1)) {
    const revision = record(raw); keys(revision, ['proposal', 'resolutions', 'review']);
    const candidate = parseKnowledgeProposal(revision.proposal, snapshot), prior = revisions.at(-1) ?? null;
    if (candidate.schemaVersion !== 'buildlore.knowledge-proposal.v2' || candidate.baselineGenerationDigest !== (previous?.generationDigest ?? null)) invalid();
    const resolutions = knowledgeWikiResolutions(revision.resolutions, prior);
    if (digest(resolutions) !== digest(revision.resolutions)) invalid();
    const review = parseKnowledgeWikiReview(revision.review, candidate, snapshot, runId, prior, previous);
    knowledgeWikiSemanticReview(review, candidate, snapshot, previous);
    revisions.push({ proposal: candidate, resolutions, review });
  }
  if (revisions.some(revision => revisions.some(author => author.proposal.actor.sessionId === revision.review?.reviewer.sessionId))) invalid();
  const last = revisions.at(-1) ?? invalid();
  if (!last.review?.usable || last.proposal.proposalDigest !== proposal.proposalDigest ||
    knowledgeWikiSemanticReview(last.review, proposal, snapshot, previous).reviewDigest !== semantic.reviewDigest) invalid();
  const basis = { schemaVersion: 'buildlore.wiki-proof.v1' as const, projectId: project(r.projectId, snapshot.projectId), runId, purpose,
    revisions: Object.freeze(revisions) };
  const result = Object.freeze({ ...basis, proofDigest: digest(basis) });
  if (hash(r.proofDigest) !== result.proofDigest || digest(r) !== digest(result)) invalid();
  return result;
}

/** Small, always-present review metadata survives selective memory budgets. */
export function knowledgeWikiReadMetadata(generation: KnowledgeGenerationV1) {
  const assessment = knowledgeWikiAssessment(generation);
  if (assessment === null) return {};
  const root = generation.pages.find(page => page.role === generation.proposal.rootPageId)?.role ?? generation.pages[0]?.role ?? invalid();
  return { knowledgeReview: { status: assessment.status, openFindingCount: assessment.openFindingCount,
    reviewDigest: assessment.reviewDigest, detailsPage: root,
    limitation: 'Only independently supported assertions are published. Read review findings for remaining gaps.' } };
}
