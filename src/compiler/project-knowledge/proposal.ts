import { parseKnowledgeSnapshot } from '../../knowledge/project-knowledge/evidence.js';
import { boundedJson, choice, compare, digest, hash, hashes, identifier, invalid, keys, list,
  project, record, text, ProjectKnowledgeError } from '../../knowledge/project-knowledge/guards.js';
import { createProposedKnowledgeRecord, parseKnowledgeActor,
  verifyProposedKnowledgeRecords } from '../../knowledge/project-knowledge/records.js';
import type { KnowledgeGenerationV1, KnowledgePageV1, KnowledgeProposalV1, KnowledgeSemanticReviewV1,
  KnowledgeSnapshotV1 } from '../../knowledge/project-knowledge/types.js';

export function knowledgePageKey(value: unknown): string {
  const key = text(value, 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key) || ['knowledge', 'evidence', 'manifest'].includes(key)) invalid();
  return key;
}

function pages(value: unknown, generic: boolean): readonly KnowledgePageV1[] {
  const claimIds = new Set<string>();
  const result = list(value, generic ? 32 : 3).map((item) => {
    const page = record(item);
    keys(page, ['role', 'title', 'sections']);
    const sections = list(page.sections, 32).map((sectionValue) => {
      const section = record(sectionValue);
      keys(section, ['title', 'claims', ...(generic ? ['sectionId'] : [])]);
      const claims = list(section.claims, 256).map((claimValue) => {
        const claim = record(claimValue);
        keys(claim, ['claimId', 'text', 'factIds', 'presentation']);
        const claimId = identifier(claim.claimId);
        // Author-controlled IDs must not alias facts or generated review targets.
        if (/^(?:sha256|title|section|supersession|conflict):/u.test(claimId) || claimIds.has(claimId)) invalid();
        claimIds.add(claimId);
        const factIds = hashes(claim.factIds, 64);
        if (factIds.length === 0) invalid();
        return Object.freeze({ claimId, text: text(claim.text), factIds,
          presentation: choice(claim.presentation, ['current', 'history', 'uncertainty']) });
      });
      if (claims.length === 0) invalid();
      return Object.freeze({ ...(generic ? { sectionId: knowledgePageKey(section.sectionId) } : {}),
        title: text(section.title, 256), claims: Object.freeze(claims) });
    });
    if (sections.length === 0 || generic && new Set(sections.map(section => section.sectionId)).size !== sections.length ||
        Buffer.byteLength(JSON.stringify(page)) > 262_144) invalid();
    return Object.freeze({ role: generic ? knowledgePageKey(page.role) : choice(page.role, ['overview', 'architecture', 'decisions']),
      title: text(page.title, 256), sections: Object.freeze(sections) });
  }).sort((a, b) => compare(a.role, b.role));
  if ((generic ? result.length === 0 : result.length !== 3) || new Set(result.map((p) => p.role)).size !== result.length) invalid();
  return Object.freeze(result);
}

export function createKnowledgeProposal(value: unknown, snapshotValue: KnowledgeSnapshotV1): KnowledgeProposalV1 {
  const snapshot = parseKnowledgeSnapshot(snapshotValue, snapshotValue.projectId);
  const input = record(boundedJson(value));
  const generic = input.schemaVersion === 'buildlore.knowledge-proposal.v2';
  keys(input, ['projectId', 'snapshotDigest', 'baselineGenerationDigest', 'actor', 'facts', 'pages',
    'supersessions', 'conflicts', ...(generic ? ['schemaVersion', 'rootPageId'] : [])]);
  const actor = parseKnowledgeActor(input.actor);
  const facts = list(input.facts, 2048).map((f) => createProposedKnowledgeRecord(f, snapshot, actor));
  const basis = {
    schemaVersion: generic ? 'buildlore.knowledge-proposal.v2' as const : 'buildlore.knowledge-proposal.v1' as const,
    ...(generic ? { rootPageId: knowledgePageKey(input.rootPageId) } : {}),
    projectId: project(input.projectId, snapshot.projectId), snapshotDigest: hash(input.snapshotDigest),
    baselineGenerationDigest: input.baselineGenerationDigest === null ? null : hash(input.baselineGenerationDigest),
    actor, facts, pages: input.pages, supersessions: input.supersessions, conflicts: input.conflicts,
  };
  return parseProposal({ ...basis, proposalDigest: digest(basis) }, snapshot, true);
}

export function parseKnowledgeProposal(value: unknown, snapshot: KnowledgeSnapshotV1,
): KnowledgeProposalV1 {
  return parseProposal(value, snapshot, false);
}

function parseProposal(value: unknown, snapshot: KnowledgeSnapshotV1,
  canonicalize: boolean): KnowledgeProposalV1 {
  const input = record(boundedJson(value));
  const generic = input.schemaVersion === 'buildlore.knowledge-proposal.v2';
  keys(input, ['schemaVersion', 'projectId', 'snapshotDigest', 'baselineGenerationDigest',
    'actor', 'facts', 'pages', 'supersessions', 'conflicts', 'proposalDigest', ...(generic ? ['rootPageId'] : [])]);
  if ((!generic && input.schemaVersion !== 'buildlore.knowledge-proposal.v1') || input.snapshotDigest !== snapshot.snapshotDigest) invalid();
  const actor = parseKnowledgeActor(input.actor);
  const facts = verifyProposedKnowledgeRecords(input.facts, snapshot, actor);
  const supersessions = list(input.supersessions, 2048).map((item) => {
    const link = record(item);
    keys(link, ['previousFactId', 'replacementFactId', 'evidenceIds']);
    const evidenceIds = hashes(link.evidenceIds);
    const previousFactId = hash(link.previousFactId);
    const replacementFactId = hash(link.replacementFactId);
    if (previousFactId === replacementFactId || evidenceIds.length === 0 ||
        !facts.some((f) => f.id === replacementFactId) ||
        evidenceIds.some((id) => !snapshot.evidence.some((e) => e.evidenceId === id))) invalid();
    return Object.freeze({ previousFactId, replacementFactId, evidenceIds });
  }).sort((a, b) => compare(a.previousFactId, b.previousFactId));
  if (new Set(supersessions.map((s) => s.previousFactId)).size !== supersessions.length) invalid();
  const conflicts = list(input.conflicts, 2048).map((item) => {
    const conflict = record(item);
    keys(conflict, ['factIds']);
    const factIds = hashes(conflict.factIds, 64);
    if (factIds.length < 2) invalid();
    return Object.freeze({ factIds });
  }).sort((a, b) => compare(digest(a), digest(b)));
  if (new Set(conflicts.map(digest)).size !== conflicts.length) invalid();
  const parsedPages = pages(input.pages, generic);
  const rootPageId = generic ? knowledgePageKey(input.rootPageId) : undefined;
  if (rootPageId !== undefined && !parsedPages.some(page => page.role === rootPageId)) invalid();
  if (generic) {
    const claims = parsedPages.flatMap(page => page.sections.flatMap(section => section.claims));
    // Generic draft conversion creates one exact statement per claim. This permits
    // one source judgment to cover the identical statement and its display claim.
    if (claims.length !== facts.length || supersessions.length !== 0 || conflicts.length !== 0 ||
        new Set(claims.flatMap(claim => claim.factIds)).size !== facts.length || parsedPages.some(page =>
          page.sections.some(section => section.claims.some(claim => {
          const fact = facts.find(item => item.id === claim.factIds[0]);
          return claim.factIds.length !== 1 || !fact || fact.statement !== claim.text || fact.subject !== `wiki:${page.role}:${claim.claimId}` ||
            fact.scope !== 'selected source material' || fact.predicate !== null || fact.lifecycle !== 'current';
        })))) invalid();
  }
  const basis = { schemaVersion: generic ? 'buildlore.knowledge-proposal.v2' as const : 'buildlore.knowledge-proposal.v1' as const,
    ...(rootPageId === undefined ? {} : { rootPageId }),
    projectId: project(input.projectId, snapshot.projectId), snapshotDigest: snapshot.snapshotDigest,
    baselineGenerationDigest: input.baselineGenerationDigest === null ? null : hash(input.baselineGenerationDigest),
    actor, facts, pages: parsedPages, supersessions: Object.freeze(supersessions), conflicts: Object.freeze(conflicts) };
  const result = Object.freeze({ ...basis, proposalDigest: digest(basis) });
  knowledgeReviewTargets(result);
  if (!canonicalize && digest(input) !== digest(result)) invalid();
  return result;
}

export function knowledgeReviewTargets(proposal: KnowledgeProposalV1): readonly string[] {
  const targets = [
    ...proposal.facts.map((fact) => fact.id),
    ...proposal.pages.flatMap((page) => page.sections.flatMap((section) => section.claims.map((claim) => claim.claimId))),
    ...proposal.supersessions.map((link) => `supersession:${link.previousFactId}:${link.replacementFactId}`),
    ...proposal.conflicts.map((conflict) => `conflict:${digest(conflict)}`),
    // Titles are author-controlled claims too; they cannot escape coverage review.
    ...proposal.pages.flatMap((page) => [`title:${page.role}`,
      ...page.sections.map((section, index) => `section:${page.role}:${section.sectionId ?? String(index)}`)]),
  ].sort(compare);
  if (targets.length > 8192 || new Set(targets).size !== targets.length) invalid();
  return Object.freeze(targets);
}

export function parseKnowledgeSemanticReview(value: unknown, proposal: KnowledgeProposalV1,
  snapshot: KnowledgeSnapshotV1,
  previous: KnowledgeGenerationV1 | null = null,
): KnowledgeSemanticReviewV1 {
  if (proposal.baselineGenerationDigest !== (previous?.generationDigest ?? null) ||
      (previous !== null && previous.projectId !== snapshot.projectId)) invalid();
  // Historical support is available only from the generation bound by the proposal.
  const evidence = new Set([...snapshot.evidence, ...(previous?.evidence ?? [])].map((e) => e.evidenceId));
  const input = record(boundedJson(value));
  keys(input, ['schemaVersion', 'projectId', 'proposalDigest', 'snapshotDigest', 'reviewer',
    'method', 'coverageChecked', 'judgments', 'reviewDigest']);
  if (input.schemaVersion !== 'buildlore.knowledge-semantic-review.v1' ||
      input.proposalDigest !== proposal.proposalDigest || input.snapshotDigest !== snapshot.snapshotDigest ||
      input.method !== 'source-support-and-currentness' || input.coverageChecked !== true) invalid();
  const reviewer = parseKnowledgeActor(input.reviewer);
  if (reviewer.sessionId === proposal.actor.sessionId) throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
  const judgments = list(input.judgments, 8192).map((item) => {
    const judgment = record(item);
    keys(judgment, ['targetId', 'verdict', 'evidenceIds', 'rationale']);
    const evidenceIds = hashes(judgment.evidenceIds);
    if (evidenceIds.some((id) => !evidence.has(id))) invalid();
    const verdict = choice(judgment.verdict, ['supported', 'unsupported', 'insufficient', 'conflicting']);
    if (verdict === 'supported' && evidenceIds.length === 0) invalid();
    return Object.freeze({ targetId: text(judgment.targetId, 256), verdict,
      evidenceIds, rationale: text(judgment.rationale) });
  }).sort((a, b) => compare(a.targetId, b.targetId));
  if (new Set(judgments.map((j) => j.targetId)).size !== judgments.length ||
      digest(judgments.map((j) => j.targetId)) !== digest(knowledgeReviewTargets(proposal))) {
    throw new ProjectKnowledgeError('KNOWLEDGE_REVIEW_REQUIRED');
  }
  const basis = { schemaVersion: 'buildlore.knowledge-semantic-review.v1' as const,
    projectId: project(input.projectId, proposal.projectId), proposalDigest: proposal.proposalDigest,
    snapshotDigest: snapshot.snapshotDigest, reviewer, method: 'source-support-and-currentness' as const,
    coverageChecked: true as const, judgments: Object.freeze(judgments) };
  const result = Object.freeze({ ...basis, reviewDigest: digest(basis) });
  if (digest(input) !== digest(result)) invalid();
  return result;
}
