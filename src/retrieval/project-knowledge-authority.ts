import { knowledgeWikiPageOrder, knowledgeWikiRoot } from '../compiler/project-knowledge/wiki-projection.js';
import { createReviewedKnowledgeQuality, type ReviewedKnowledgeQuality } from '../compiler/hierarchy/reviewed-quality.js';
import { createHash } from 'node:crypto';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { appendKnowledgeHistoryReference, parseKnowledgeHistoryReference, type KnowledgeHistoryReferenceV1 } from '../knowledge/project-knowledge/history.js';
import { requireVerifiedKnowledgeHistory, type VerifiedKnowledgeHistory, type KnowledgeGenerationHistoryStorePort } from './project-knowledge-history-store.js';
import { parseKnowledgeGenerationChain } from '../compiler/project-knowledge/generation.js';
import { knowledgeHierarchyPurpose, knowledgeHierarchySnapshot, knowledgeHierarchySections, knowledgeHierarchySummary,
  type KnowledgeHierarchyBridgeV1, type KnowledgeHierarchyMappingV1 } from '../compiler/project-knowledge/hierarchy-bridge.js';
import { boundedJson, compare, digest, invalid, keys, record } from '../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from '../knowledge/project-knowledge/types.js';
import { approveChildSummaryForSynthesis, createCompileCandidateReview,
  checkAuthoritativeWikiState, createHumanActivationApproval, createPageOwnershipGraph,
  digestHierarchyValue,
  finalizeCompileRun, verifyCompileRunApproval,
  type CorpusSnapshotV1, type FinalizeCompileRunInputV1 } from '../compiler/hierarchy/index.js';
import type { ApprovedWikiAuthorityV1, ApprovedWikiAuthorityV3, CurrentApprovedWikiAuthority } from './approved-corpus-store.js';

export interface KnowledgeAuthorityExtensionV1 {
  readonly schemaVersion: 'buildlore.knowledge-authority-extension.v1';
  readonly generationDigest: KnowledgeDigest;
  readonly generations: readonly KnowledgeGenerationV1[];
  readonly pageMappings: readonly KnowledgeHierarchyMappingV1[];
  readonly evidenceMappings: KnowledgeHierarchyBridgeV1['evidenceMappings'];
  readonly extensionDigest: KnowledgeDigest;
}

export interface KnowledgeAuthorityExtensionV2 {
  readonly schemaVersion: 'buildlore.knowledge-authority-extension.v2';
  readonly generationDigest: KnowledgeDigest;
  readonly history: KnowledgeHistoryReferenceV1;
  readonly baselineHistory: KnowledgeHistoryReferenceV1 | null;
  readonly pageMappings: readonly KnowledgeHierarchyMappingV1[];
  readonly evidenceMappings: KnowledgeHierarchyBridgeV1['evidenceMappings'];
  readonly extensionDigest: KnowledgeDigest;
}

export type KnowledgeAuthorityExtension = KnowledgeAuthorityExtensionV1 | KnowledgeAuthorityExtensionV2;
const resolvedHistory = new WeakMap<KnowledgeAuthorityExtensionV2, VerifiedKnowledgeHistory>();

/** Pointer extensions must first be resolved by the confined asynchronous reader. */
export function knowledgeAuthorityHistory(extension: KnowledgeAuthorityExtensionV2): VerifiedKnowledgeHistory {
  const history = resolvedHistory.get(extension) ?? invalid();
  return requireVerifiedKnowledgeHistory(history, history.reference.projectId);
}

export function latestKnowledgeGeneration(extension: KnowledgeAuthorityExtension): KnowledgeGenerationV1 {
  return extension.schemaVersion === 'buildlore.knowledge-authority-extension.v1'
    ? extension.generations.at(-1) ?? invalid() : knowledgeAuthorityHistory(extension).latest;
}

/** Replays the new contract only when its persisted report explicitly selects it. */
export function knowledgeReviewedQuality(generation: KnowledgeGenerationV1,
  finalization: FinalizeCompileRunInputV1): ReviewedKnowledgeQuality | undefined {
  if (!['buildlore.corpus-quality-report.v3', 'buildlore.corpus-quality-report.v4'].includes(finalization.corpusQualityReport.schemaVersion)) return undefined;
  return createReviewedKnowledgeQuality(generation, { outline: finalization.outline,
    proposals: finalization.proposals, evidencePacks: finalization.evidencePacks });
}

type KnowledgeHierarchyAuthority = Readonly<{ projectId: string; liveSnapshot: CorpusSnapshotV1;
  finalization: FinalizeCompileRunInputV1 }>;

function verifyKnowledgeHierarchy(generation: KnowledgeGenerationV1, authority: KnowledgeHierarchyAuthority):
  Pick<KnowledgeAuthorityExtensionV1, 'pageMappings' | 'evidenceMappings'> {
  if (authority.finalization.outline.purposeDigest !== knowledgeHierarchyPurpose(generation).purposeDigest ||
      digest(authority.liveSnapshot) !== digest(knowledgeHierarchySnapshot(generation))) invalid();
  const units = authority.liveSnapshot.textUnits;
  const facts = new Map(generation.records.map((f) => [f.id, f]));
  const evidenceMappings = generation.evidence.flatMap((e) => {
    const sourceId = `source-${digestHierarchyValue({ projectId: authority.projectId, evidenceId: e.evidenceId }).slice(7)}`;
    const unit = units.find((u) => u.sourceId === sourceId);
    if (!unit) return invalid();
    const matches = authority.finalization.evidencePacks.flatMap((p) => p.units.filter((u) => u.unitId === unit.unitId));
    if (matches.length === 0) return [];
    if (matches.some((m) => m.content !== e.excerpt || m.contentDigest !== e.excerptDigest ||
        m.citation.sourceRevision !== e.sourceContentDigest || digest(m) !== digest(matches[0]))) invalid();
    return [{ evidenceId: e.evidenceId, unitId: unit.unitId, citationId: matches[0]?.citation.citationId ?? invalid() }];
  }).sort((a, b) => compare(a.evidenceId, b.evidenceId));
  const byEvidence = new Map(evidenceMappings.map((e) => [e.evidenceId, e]));
  const pageMappings = knowledgeWikiPageOrder(generation).map((role) => {
    const page = generation.pages.find((p) => p.role === role);
    const blueprint = authority.finalization.outline.blueprints.find((b) => b.stableKey === `knowledge.${role}`);
    const proposal = authority.finalization.proposals.find((p) => p.pageId === blueprint?.pageId);
    if (!page || !blueprint || !proposal || page.title !== proposal.title) invalid();
    const claims = page.sections.flatMap((s) => s.claims).map((claim) => {
      const evidenceIds = [...new Set(claim.factIds.flatMap((id) => facts.get(id)?.evidenceIds ?? invalid()))].sort();
      const matches = evidenceIds.map((id) => byEvidence.get(id) ?? invalid());
      const basis = { text: claim.text, evidenceUnitIds: matches.map((e) => e.unitId).sort(),
        citationIds: matches.map((e) => e.citationId).sort() };
      const hierarchyClaimId = `claim-${digestHierarchyValue(basis).slice(7)}`;
      if (!proposal.claims.some((c) => digest(c) === digest({ ...basis, claimId: hierarchyClaimId }))) invalid();
      return { claimId: claim.claimId, hierarchyClaimId, factIds: claim.factIds };
    });
    const linkedClaims = claims.map((mapping) => proposal.claims.find((claim) => claim.claimId === mapping.hierarchyClaimId) ?? invalid());
    const children = role === knowledgeWikiRoot(generation) ? knowledgeWikiPageOrder(generation).filter(page => page !== role).map((childRole) => {
      const childBlueprint = authority.finalization.outline.blueprints.find((b) => b.stableKey === `knowledge.${childRole}`);
      const child = authority.finalization.proposals.find((p) => p.pageId === childBlueprint?.pageId) ?? invalid();
      return approveChildSummaryForSynthesis(child, createCompileCandidateReview(child, 'accepted', authority.projectId), authority.projectId);
    }) : [];
    const links = [...blueprint.childPageIds, ...(blueprint.parentPageId === null ? [] : [blueprint.parentPageId])].sort();
    const sections = knowledgeHierarchySections(page, linkedClaims, children, links);
    if (proposal.summary !== knowledgeHierarchySummary(page) || digest(proposal.wikilinks) !== digest(links) ||
        sections.some((section) => digest(section) !== digest(proposal.sections.find((s) => s.sectionId === section.sectionId) ?? null))) invalid();
    if (claims.length !== proposal.claims.length || page.sections.length !== proposal.sections.length ||
        page.sections.some((section, index) => proposal.sections.find((s) => s.sectionId === `knowledge-${String(index)}`)?.title !== section.title)) invalid();
    return { role, pageId: blueprint.pageId, claims };
  });
  if (authority.finalization.proposals.length !== generation.pages.length || authority.finalization.outline.blueprints.length !== generation.pages.length) invalid();
  return { pageMappings, evidenceMappings };
}

export async function resolveKnowledgeAuthorityExtension(value: unknown, authority: KnowledgeHierarchyAuthority,
  store: KnowledgeGenerationHistoryStorePort): Promise<KnowledgeAuthorityExtensionV2> {
  const input = record(boundedJson(value));
  keys(input, ['schemaVersion', 'generationDigest', 'history', 'baselineHistory', 'pageMappings', 'evidenceMappings', 'extensionDigest']);
  if (input.schemaVersion !== 'buildlore.knowledge-authority-extension.v2') invalid();
  const history = await store.verify(input.history, authority.projectId);
  const baselineHistory = input.baselineHistory === null ? null : parseKnowledgeHistoryReference(input.baselineHistory, authority.projectId);
  const generation = history.latest;
  if (generation.baselineGenerationDigest !== (baselineHistory?.headGenerationDigest ?? null) ||
      digest(appendKnowledgeHistoryReference(baselineHistory, generation.generationDigest, authority.projectId)) !== digest(history.reference)) invalid();
  const mappings = verifyKnowledgeHierarchy(generation, authority);
  const basis = { schemaVersion: 'buildlore.knowledge-authority-extension.v2' as const,
    generationDigest: generation.generationDigest, history: history.reference, baselineHistory, ...mappings };
  const result = Object.freeze({ ...basis, extensionDigest: digest(basis) });
  if (digest(input) !== digest(result)) invalid();
  resolvedHistory.set(result, history);
  return result;
}

/** @internal A resolved extension cannot be moved to a different hierarchy proof. */
export function verifyResolvedKnowledgeAuthorityExtension(extension: KnowledgeAuthorityExtensionV2,
  authority: KnowledgeHierarchyAuthority): void {
  const history = knowledgeAuthorityHistory(extension);
  if (history.reference.projectId !== authority.projectId || digest(history.reference) !== digest(extension.history) ||
      history.latest.generationDigest !== extension.generationDigest) invalid();
  const mappings = verifyKnowledgeHierarchy(history.latest, authority);
  if (digest(mappings.pageMappings) !== digest(extension.pageMappings) ||
      digest(mappings.evidenceMappings) !== digest(extension.evidenceMappings)) invalid();
}

export interface KnowledgeHistoryAppendV1 {
  readonly schemaVersion: 'buildlore.knowledge-history-append.v1';
  readonly projectId: string;
  readonly baselineRecordDigest: KnowledgeDigest | null;
  readonly baselineHistory: KnowledgeHistoryReferenceV1 | null;
  readonly history: KnowledgeHistoryReferenceV1;
  readonly generation: KnowledgeGenerationV1;
  readonly appendDigest: KnowledgeDigest;
}

/** A single candidate and its exact predecessor, never an embedded history array. */
export function createKnowledgeHistoryAppend(authority: ApprovedWikiAuthorityV3): KnowledgeHistoryAppendV1 {
  const extension = authority.knowledgeGeneration;
  const basis = { schemaVersion: 'buildlore.knowledge-history-append.v1' as const, projectId: authority.projectId,
    baselineRecordDigest: authority.baselineRecordDigest, baselineHistory: extension.baselineHistory,
    history: extension.history, generation: latestKnowledgeGeneration(extension) };
  return Object.freeze({ ...basis, appendDigest: digest(basis) });
}

export function verifyKnowledgeHistoryAppend(value: unknown, authority: ApprovedWikiAuthorityV3): void {
  const input = record(value);
  keys(input, ['schemaVersion', 'projectId', 'baselineRecordDigest', 'baselineHistory', 'history', 'generation', 'appendDigest']);
  boundedJson(input.generation);
  const { generation: payload, ...metadata } = input;
  void payload;
  if (Buffer.byteLength(JSON.stringify(boundedJson(metadata))) > 12_288 ||
      digest(input) !== digest(createKnowledgeHistoryAppend(authority))) invalid();
}

/** Exact predecessor history is part of the publication compare, in addition to hierarchy state. */
export function verifyKnowledgeAuthorityPredecessor(authority: ApprovedWikiAuthorityV3,
  previous: CurrentApprovedWikiAuthority | null): void {
  const extension = previous?.knowledgeGeneration;
  let reference: KnowledgeHistoryReferenceV1 | null = null;
  if (extension?.schemaVersion === 'buildlore.knowledge-authority-extension.v2') reference = extension.history;
  else if (extension !== undefined) {
    for (const generation of extension.generations) reference = appendKnowledgeHistoryReference(reference, generation.generationDigest, authority.projectId);
  }
  if (digest(reference) !== digest(authority.knowledgeGeneration.baselineHistory) ||
      authority.baselineRecordDigest !== knowledgeBaselineRecordDigest(previous)) invalid();
}

function canonicalDigest(value: unknown): KnowledgeDigest {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

export function knowledgeBaselineRecordDigest(authority: CurrentApprovedWikiAuthority | null): KnowledgeDigest | null {
  return authority === null ? null : canonicalDigest({ authority, authorityDigest: canonicalDigest(authority),
    projectId: authority.projectId, schemaVersion: 'buildlore.approved-wiki-authority-record.v1' });
}

/** Stages immutable, screened objects only. Explicit activation commits the new authority. */
export async function approveKnowledgeWikiHistoryAuthority(input: Readonly<{
  generation: KnowledgeGenerationV1; bridge: KnowledgeHierarchyBridgeV1;
  previousAuthority: CurrentApprovedWikiAuthority | null; explicitConfirmation: true;
  store: KnowledgeGenerationHistoryStorePort;
}>): Promise<ApprovedWikiAuthorityV3> {
  if (input.explicitConfirmation !== true) invalid();
  const { bridge, previousAuthority, store } = input;
  const projectId = bridge.snapshot.projectId;
  if (previousAuthority !== null && previousAuthority.projectId !== projectId) invalid();
  if (bridge.finalization.baselineGenerationDigest !== (previousAuthority?.state.generationDigest ?? null) ||
      digest([...bridge.finalization.baselineProposals].sort((a, b) => compare(a.pageId, b.pageId))) !==
      digest([...(previousAuthority?.finalization.proposals ?? [])].sort((a, b) => compare(a.pageId, b.pageId)))) invalid();
  const previousExtension = previousAuthority?.knowledgeGeneration;
  const baseline = previousExtension === undefined ? null : previousExtension.schemaVersion === 'buildlore.knowledge-authority-extension.v1'
    ? await store.stageLegacy(previousExtension.generations, projectId) : await store.verify(previousExtension.history, projectId);
  const history = await store.stageAppend({ projectId, baseline, generation: input.generation });
  const basis = { schemaVersion: 'buildlore.knowledge-authority-extension.v2' as const,
    generationDigest: history.latest.generationDigest, history: history.reference, baselineHistory: baseline?.reference ?? null,
    pageMappings: bridge.pageMappings, evidenceMappings: bridge.evidenceMappings };
  const extension = await resolveKnowledgeAuthorityExtension({ ...basis, extensionDigest: digest(basis) },
    { projectId, liveSnapshot: bridge.snapshot, finalization: bridge.finalization }, store);
  const finalization = bridge.finalization;
  const reviewedQuality = knowledgeReviewedQuality(latestKnowledgeGeneration(extension), finalization);
  const ledger = finalizeCompileRun(finalization, projectId, reviewedQuality);
  const ownershipGraph = createPageOwnershipGraph(bridge.snapshot, finalization.outline, ledger,
    finalization.proposals, finalization.evidencePacks, projectId);
  const currentState = previousAuthority?.state ?? null;
  const humanActivationApproval = createHumanActivationApproval({ ledger, ownershipGraph, currentState,
    decision: 'approved', explicitConfirmation: true }, projectId);
  const state = verifyCompileRunApproval({ currentState, finalization, humanActivationApproval,
    ledger, liveSnapshot: bridge.snapshot, ownershipGraph }, projectId, reviewedQuality);
  return Object.freeze({ schemaVersion: 'buildlore.approved-wiki-authority.v3', projectId,
    baselineRecordDigest: knowledgeBaselineRecordDigest(previousAuthority), knowledgeGeneration: extension,
    currentState, finalization, humanActivationApproval, ledger, liveSnapshot: bridge.snapshot, ownershipGraph, state,
    authorityCheck: checkAuthoritativeWikiState(state, ownershipGraph, bridge.snapshot, humanActivationApproval, projectId) });
}

/** Replay knowledge, then prove that the existing approved hierarchy carries the same claims and evidence. */
export function parseKnowledgeAuthorityExtension(value: unknown,
  authority: Readonly<{ projectId: string; liveSnapshot: CorpusSnapshotV1; finalization: FinalizeCompileRunInputV1 }>,
): KnowledgeAuthorityExtensionV1 {
  const input = record(boundedJson(value));
  keys(input, ['schemaVersion', 'generationDigest', 'generations', 'pageMappings', 'evidenceMappings', 'extensionDigest']);
  const generations = parseKnowledgeGenerationChain(input.generations, authority.projectId);
  const generation = generations.at(-1);
  if (!generation || input.schemaVersion !== 'buildlore.knowledge-authority-extension.v1' ||
      input.generationDigest !== generation.generationDigest ||
      authority.finalization.outline.purposeDigest !== knowledgeHierarchyPurpose(generation).purposeDigest ||
      digest(authority.liveSnapshot) !== digest(knowledgeHierarchySnapshot(generation))) invalid();
  const { pageMappings, evidenceMappings } = verifyKnowledgeHierarchy(generation, authority);
  const basis = { schemaVersion: 'buildlore.knowledge-authority-extension.v1' as const,
    generationDigest: generation.generationDigest, generations, pageMappings, evidenceMappings };
  const result = Object.freeze({ ...basis, extensionDigest: digest(basis) });
  if (digest(input) !== digest(result)) invalid();
  return result;
}

export function createKnowledgeAuthorityExtension(generations: readonly KnowledgeGenerationV1[],
  bridge: KnowledgeHierarchyBridgeV1, projectId: string): KnowledgeAuthorityExtensionV1 {
  const generation = generations.at(-1);
  if (!generation) invalid();
  const basis = { schemaVersion: 'buildlore.knowledge-authority-extension.v1' as const,
    generationDigest: generation.generationDigest, generations,
    pageMappings: bridge.pageMappings, evidenceMappings: bridge.evidenceMappings };
  return parseKnowledgeAuthorityExtension({ ...basis, extensionDigest: digest(basis) }, {
    projectId, liveSnapshot: bridge.snapshot, finalization: bridge.finalization });
}

/** Creates the existing approval-bound envelope; publication remains a separate explicit step. */
export function approveKnowledgeWikiAuthority(input: Readonly<{
  generations: readonly KnowledgeGenerationV1[];
  bridge: KnowledgeHierarchyBridgeV1;
  previousAuthority: ApprovedWikiAuthorityV1 | null;
  explicitConfirmation: true;
}>): ApprovedWikiAuthorityV1 {
  if (input.explicitConfirmation !== true) invalid();
  const { bridge, previousAuthority } = input;
  const projectId = bridge.snapshot.projectId;
  if (previousAuthority !== null && previousAuthority.projectId !== projectId) invalid();
  const previousChain = previousAuthority?.knowledgeGeneration?.generations ?? [];
  if (input.generations.length !== previousChain.length + 1 ||
      digest(input.generations.slice(0, -1)) !== digest(previousChain) ||
      bridge.finalization.baselineGenerationDigest !== (previousAuthority?.state.generationDigest ?? null) ||
      digest([...bridge.finalization.baselineProposals].sort((a, b) => compare(a.pageId, b.pageId))) !==
        digest([...(previousAuthority?.finalization.proposals ?? [])].sort((a, b) => compare(a.pageId, b.pageId)))) invalid();
  const extension = createKnowledgeAuthorityExtension(input.generations, bridge, projectId);
  const finalization = bridge.finalization;
  const reviewedQuality = knowledgeReviewedQuality(latestKnowledgeGeneration(extension), finalization);
  const ledger = finalizeCompileRun(finalization, projectId, reviewedQuality);
  const ownershipGraph = createPageOwnershipGraph(bridge.snapshot, finalization.outline, ledger,
    finalization.proposals, finalization.evidencePacks, projectId);
  const currentState = previousAuthority?.state ?? null;
  const humanActivationApproval = createHumanActivationApproval({ ledger, ownershipGraph, currentState,
    decision: 'approved', explicitConfirmation: true }, projectId);
  const state = verifyCompileRunApproval({ currentState, finalization, humanActivationApproval,
    ledger, liveSnapshot: bridge.snapshot, ownershipGraph }, projectId, reviewedQuality);
  return Object.freeze({ schemaVersion: 'buildlore.approved-wiki-authority.v2', projectId,
    knowledgeGeneration: extension, currentState, finalization, humanActivationApproval, ledger,
    liveSnapshot: bridge.snapshot, ownershipGraph, state,
    authorityCheck: checkAuthoritativeWikiState(state, ownershipGraph, bridge.snapshot, humanActivationApproval, projectId) });
}
