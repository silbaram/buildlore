import { createHash } from 'node:crypto';

import type {
  AuthoritativeWikiCheckV1,
  AuthoritativeWikiStateV1,
  EvidencePackV1,
  HierarchicalWikiProposalV1,
  HierarchySha256Digest,
  PageOwnershipGraphV1,
} from '../compiler/hierarchy/types.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import {
  neutralSourceRetrievalMeaning,
  validateJsonPointer,
  type SourceDocumentAuthority,
  type SourceDocumentLifecycle,
  type SourceEvidenceKind,
  type SourceRetrievalMeaningOrigin,
  type SourceRetrievalMeaningV1,
} from '../projector/source-contracts.js';
import {
  buildLexicalIndex,
  fuseReciprocalRanks,
  roundSix,
  type LexicalScoreComponents,
  type MatchedRetrievalEvidence,
} from './strategy.js';

export const LEGACY_APPROVED_WIKI_RETRIEVAL_CORPUS_SCHEMA_VERSION =
  'buildlore.approved-wiki-retrieval-corpus.v1' as const;
export const APPROVED_WIKI_RETRIEVAL_CORPUS_SCHEMA_VERSION =
  'buildlore.approved-wiki-retrieval-corpus.v2' as const;
export const SEMANTIC_CONTENT_POLICY_VERSION =
  'buildlore.semantic-content-policy.v1' as const;
export const HIERARCHICAL_RETRIEVAL_RESULT_SCHEMA_VERSION =
  'buildlore.hierarchical-retrieval-result.v1' as const;
export const MODEL_FREE_WIKI_CURATE_RESULT_SCHEMA_VERSION =
  'buildlore.model-free-wiki-curate-result.v1' as const;
export const MODEL_FREE_WIKI_CURATE_MAX_SUGGESTIONS = 256 as const;
export const MODEL_FREE_WIKI_CURATE_MAX_CANDIDATES = 24_576 as const;

const MODEL_FREE_WIKI_CURATE_MAX_REVIEW_UNITS = 16_384;
const APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION_FOR_CURATE =
  'buildlore.approved-wiki-retrieval-projection.v1' as const;
const CURATE_PROPOSAL_PROPERTIES = Object.freeze([
  'schemaVersion',
  'projectId',
  'pageId',
  'blueprintDigest',
  'evidencePackDigest',
  'requestDigest',
  'title',
  'summary',
  'sections',
  'claims',
  'wikilinks',
  'citationIds',
  'lifecycle',
  'proposalDigest',
] as const);

export type HierarchicalRetrievalMode = 'graph' | 'lexical';
export type HierarchicalRetrievalErrorCode =
  | 'HIERARCHICAL_RETRIEVAL_CONFIG_INVALID'
  | 'HIERARCHICAL_RETRIEVAL_CONTRACT_VIOLATION'
  | 'HIERARCHICAL_RETRIEVAL_PROJECT_MISMATCH';

export class HierarchicalRetrievalError extends Error {
  readonly code: HierarchicalRetrievalErrorCode;
  readonly retryable = false;

  constructor(code: HierarchicalRetrievalErrorCode) {
    super(code === 'HIERARCHICAL_RETRIEVAL_CONFIG_INVALID'
      ? 'Hierarchical retrieval input is invalid.'
      : code === 'HIERARCHICAL_RETRIEVAL_PROJECT_MISMATCH'
        ? 'Hierarchical retrieval project does not match.'
        : 'Hierarchical retrieval contract is invalid.');
    this.name = 'HierarchicalRetrievalError';
    this.code = code;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export interface ApprovedWikiCitationLocatorV1 {
  readonly citationId: string;
  readonly jsonPointer?: string;
  readonly sourceId: string;
}

export interface ApprovedWikiMeaningSignalV1 {
  readonly authority: SourceDocumentAuthority;
  readonly evidenceKind: SourceEvidenceKind;
  readonly iterationGroup: string | null;
  readonly lifecycle: SourceDocumentLifecycle;
  readonly origin: SourceRetrievalMeaningOrigin;
  readonly revisionOrdinal: number;
  readonly sourceId: string;
  readonly topicGroup: string | null;
}

export type SemanticExclusionKind =
  | 'citation-marker'
  | 'duplicate-boilerplate'
  | 'machine-provenance'
  | 'renderer-boilerplate';

export interface ApprovedWikiSemanticExclusionSummaryV1 {
  readonly excludedKinds: readonly SemanticExclusionKind[];
  readonly excludedUtf8Bytes: number;
  readonly policyDigest: HierarchySha256Digest;
  readonly policyVersion: typeof SEMANTIC_CONTENT_POLICY_VERSION;
}

export interface ApprovedWikiRetrievalSectionV1 {
  readonly body: string;
  readonly citationLocators: readonly ApprovedWikiCitationLocatorV1[];
  readonly exclusionSummary?: ApprovedWikiSemanticExclusionSummaryV1;
  readonly meaningSignals?: readonly ApprovedWikiMeaningSignalV1[];
  readonly semanticContentDigest?: HierarchySha256Digest;
  readonly semanticText?: string;
  readonly sectionId: string;
}

export interface ApprovedWikiRetrievalPageV1 {
  readonly childPageIds: readonly string[];
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly proposalDigest: HierarchySha256Digest;
  readonly meaningSignals?: readonly ApprovedWikiMeaningSignalV1[];
  readonly relationPageIds: readonly string[];
  readonly sections: readonly ApprovedWikiRetrievalSectionV1[];
  readonly status: 'active';
  readonly summary: string;
  readonly title: string;
}

export interface ApprovedWikiRetrievalCorpusV1 {
  readonly corpusDigest: HierarchySha256Digest;
  readonly generationDigest: HierarchySha256Digest;
  readonly pages: readonly ApprovedWikiRetrievalPageV1[];
  readonly projectId: string;
  readonly schemaVersion:
    | typeof LEGACY_APPROVED_WIKI_RETRIEVAL_CORPUS_SCHEMA_VERSION
    | typeof APPROVED_WIKI_RETRIEVAL_CORPUS_SCHEMA_VERSION;
}

export interface ProjectApprovedWikiInputV1 {
  readonly authorityCheck: AuthoritativeWikiCheckV1;
  readonly evidencePacks: readonly EvidencePackV1[];
  /** Exact child-summary citations authorized by verified generation handoffs, per page. */
  readonly inheritedCitationAuthorizations?: readonly Readonly<{
    readonly pageId: string;
    readonly citationIds: readonly string[];
  }>[];
  readonly ownershipGraph: PageOwnershipGraphV1;
  readonly proposals: readonly HierarchicalWikiProposalV1[];
  readonly sourceMeanings?: readonly Readonly<{
    readonly meaning: SourceRetrievalMeaningV1;
    readonly origin: SourceRetrievalMeaningOrigin;
    readonly sourceId: string;
  }>[];
  readonly state: AuthoritativeWikiStateV1;
}

export interface ApprovedWikiPageSummaryV1 {
  readonly childPageIds: readonly string[];
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly sectionIds: readonly string[];
  readonly title: string;
}

export interface HierarchicalRetrievalLocatorV1 {
  readonly citationIds: readonly string[];
  readonly pageId: string;
  readonly projectId: string;
  readonly sectionId: string;
  readonly sourceIds: readonly string[];
}

export interface HierarchicalRetrievalChannelV1 {
  readonly channel: HierarchicalRetrievalMode;
  readonly rank: number;
  readonly score: number;
}

export interface HierarchicalRetrievalHitV1 {
  readonly channels: readonly HierarchicalRetrievalChannelV1[];
  readonly locator: HierarchicalRetrievalLocatorV1;
  readonly matchedEvidence: readonly MatchedRetrievalEvidence[];
  readonly rank: number;
  readonly score: number;
  readonly scoreComponents: {
    readonly combinedScore: number;
    readonly lexical?: LexicalScoreComponents;
  };
  readonly scoreKind: 'lexical-graph-rrf' | 'lexical-weighted-coverage';
  readonly title: string;
}

export interface HierarchicalRetrievalSearchRequestV1 {
  readonly mode?: HierarchicalRetrievalMode;
  readonly projectId: string;
  readonly query: string;
}

export interface HierarchicalRetrievalSearchResultV1 {
  readonly effectiveMode: HierarchicalRetrievalMode;
  readonly fallback: null;
  readonly hits: readonly HierarchicalRetrievalHitV1[];
  readonly modelUsed: false;
  readonly projectId: string;
  readonly providerUsed: false;
  readonly requestedMode: HierarchicalRetrievalMode;
  readonly schemaVersion: typeof HIERARCHICAL_RETRIEVAL_RESULT_SCHEMA_VERSION;
}

export type ModelFreeWikiCurateReasonCode =
  | 'broken-link'
  | 'possible-duplicate'
  | 'unsupported-claim'
  | 'weakly-connected-page';

export type ModelFreeWikiCurateReviewAction =
  | 'review-claim-support'
  | 'review-link-target'
  | 'review-page-connection'
  | 'review-possible-duplicate';

/** Stable, path-free evidence that lets a reviewer locate the flagged Wiki surface. */
export interface ModelFreeWikiCurateEvidenceLocatorV1 {
  readonly citationIds: readonly string[];
  readonly claimId: string | null;
  readonly pageId: string;
  readonly relatedPageId: string | null;
  readonly sectionId: string | null;
}

export interface ModelFreeWikiCurateSuggestionV1 {
  readonly automaticMutation: false;
  readonly evidenceLocators: readonly ModelFreeWikiCurateEvidenceLocatorV1[];
  readonly pageIds: readonly string[];
  readonly reasonCode: ModelFreeWikiCurateReasonCode;
  readonly reviewAction: ModelFreeWikiCurateReviewAction;
  readonly suggestionId: `suggestion-${string}`;
}

export interface ModelFreeWikiCurateInputV1 {
  readonly authorityCheck: AuthoritativeWikiCheckV1;
  readonly corpus: ApprovedWikiRetrievalCorpusV1;
  readonly projectionDigest: HierarchySha256Digest;
  readonly proposals: readonly HierarchicalWikiProposalV1[];
  readonly sanitizerPolicyDigest: HierarchySha256Digest;
}

export interface ModelFreeWikiCurateResultV1 {
  readonly authorityCheckDigest: HierarchySha256Digest;
  readonly candidateCount: number;
  readonly corpusDigest: HierarchySha256Digest;
  readonly egress: 'none';
  readonly generationDigest: HierarchySha256Digest;
  readonly modelUsed: 'none';
  readonly mutationApplied: false;
  readonly projectId: string;
  readonly projectionDigest: HierarchySha256Digest;
  readonly providerUsed: 'none';
  readonly readOnly: true;
  readonly resultDigest: HierarchySha256Digest;
  readonly sanitizerPolicyDigest: HierarchySha256Digest;
  readonly schemaVersion: typeof MODEL_FREE_WIKI_CURATE_RESULT_SCHEMA_VERSION;
  readonly suggestionCount: number;
  readonly suggestions: readonly ModelFreeWikiCurateSuggestionV1[];
  readonly truncated: boolean;
}

export interface ApprovedWikiRetrievalPortV1 {
  citations(projectId: string, pageId: string, sectionId?: string):
    readonly ApprovedWikiCitationLocatorV1[];
  list(projectId: string): readonly ApprovedWikiPageSummaryV1[];
  read(projectId: string, pageId: string): ApprovedWikiRetrievalPageV1;
  search(request: HierarchicalRetrievalSearchRequestV1): HierarchicalRetrievalSearchResultV1;
}

const MAX_QUERY_CHARS = 8_192;
const MAX_HITS = 20;
const MAX_GRAPH_SEEDS = 5;
const MAX_GRAPH_DEPTH = 2;
const SAFE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;
const SAFE_PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value: unknown): HierarchySha256Digest {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

const SEMANTIC_CONTENT_POLICY_BASIS = Object.freeze({
  citationMarkers: 'remove-unescaped-outside-fences',
  duplicateBoilerplate: 'exact-normalized-line',
  markdownFences: 'commonmark-closing-line-v1',
  machineProvenance: 'closed-key-prefixes',
  rendererBoilerplate: 'closed-sentences',
  version: SEMANTIC_CONTENT_POLICY_VERSION,
});

export const SEMANTIC_CONTENT_POLICY_DIGEST = digest(SEMANTIC_CONTENT_POLICY_BASIS);

function isMachineProvenanceLine(value: string): boolean {
  const normalized = value.trim().replace(/^[-*][ \t]+/u, '').replace(/^`|`$/gu, '');
  return /^(?:authority|blueprint|content|corpus|evidence|generation|materialization|policy|proposal|record|renderer|request|revision|sanitizer|snapshot|source|unit)[_-](?:digest|id|ids|revision)(?:[ \t]*:|[ \t]+=)/iu.test(normalized) ||
    /^(?:sha256:)?[a-f0-9]{64}(?:[ \t]+(?:sha256:)?[a-f0-9]{64})*$/u.test(normalized);
}

function isRendererBoilerplateLine(value: string): boolean {
  const normalized = value.trim();
  return /^(?:this (?:document|page) (?:is|was) generated by BuildLore|BuildLore(?:에서|가) 생성한 (?:문서|페이지)(?:입니다)?)[.!]?$/iu.test(normalized);
}

export function projectApprovedWikiSemanticText(
  body: string,
  fallback: string,
): Readonly<{
  readonly exclusionSummary: ApprovedWikiSemanticExclusionSummaryV1;
  readonly semanticContentDigest: HierarchySha256Digest;
  readonly semanticText: string;
}> {
  const kinds = new Set<SemanticExclusionKind>();
  const lines: string[] = [];
  const seenBoilerplate = new Set<string>();
  let fence: Readonly<{ readonly character: '`' | '~'; readonly length: number }> | null = null;
  for (const original of body.split('\n')) {
    if (fence !== null) {
      const closingRun = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(original)?.[1];
      lines.push(original);
      if (closingRun !== undefined && closingRun[0] === fence.character &&
          closingRun.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(original);
    const fenceMatch = opening?.[1];
    const fenceInfo = opening?.[2] ?? '';
    if (fenceMatch !== undefined && !(fenceMatch[0] === '`' && fenceInfo.includes('`'))) {
      const character = fenceMatch[0] as '`' | '~';
      lines.push(original);
      fence = Object.freeze({ character, length: fenceMatch.length });
      continue;
    }
    if (isMachineProvenanceLine(original)) {
      kinds.add('machine-provenance');
      continue;
    }
    if (isRendererBoilerplateLine(original)) {
      const key = original.trim().toLowerCase();
      if (seenBoilerplate.has(key)) kinds.add('duplicate-boilerplate');
      else kinds.add('renderer-boilerplate');
      seenBoilerplate.add(key);
      continue;
    }
    const withoutCitations = original.replace(
      /(?<!\\)\[\^(citation-[a-z0-9]+(?:-[a-z0-9]+)*)\]/gu,
      '',
    );
    if (withoutCitations !== original) kinds.add('citation-marker');
    lines.push(withoutCitations.replace(/[ \t]+$/u, ''));
  }
  const compact: string[] = [];
  for (const line of lines) {
    if (line.trim() === '' && compact.at(-1)?.trim() === '') continue;
    compact.push(line);
  }
  const semanticText = compact.join('\n').trim() || fallback.normalize('NFC').trim();
  const excludedUtf8Bytes = Math.max(
    0,
    Buffer.byteLength(body, 'utf8') - Buffer.byteLength(semanticText, 'utf8'),
  );
  return Object.freeze({
    exclusionSummary: Object.freeze({
      excludedKinds: Object.freeze([...kinds].sort(compareText)),
      excludedUtf8Bytes,
      policyDigest: SEMANTIC_CONTENT_POLICY_DIGEST,
      policyVersion: SEMANTIC_CONTENT_POLICY_VERSION,
    }),
    semanticContentDigest: digest(semanticText),
    semanticText,
  });
}

function exactProject(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new HierarchicalRetrievalError('HIERARCHICAL_RETRIEVAL_PROJECT_MISMATCH');
  }
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    SAFE_ID.test(value) && value === value.normalize('NFC');
}

function safeJsonPointer(value: unknown): boolean {
  if (value === undefined) return true;
  try {
    validateJsonPointer(value);
    return true;
  } catch {
    return false;
  }
}

function safeText(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum ||
      value !== value.normalize('NFC')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeQuery(value: unknown): value is string {
  return safeText(value, MAX_QUERY_CHARS) && ![...value].some((character) =>
    (character.codePointAt(0) ?? 0) < 32) && /[\p{L}\p{N}]/u.test(value);
}

function projectionInvalid(): never {
  throw new HierarchicalRetrievalError('HIERARCHICAL_RETRIEVAL_CONTRACT_VIOLATION');
}

function corpusWithoutDigest(corpus: Omit<ApprovedWikiRetrievalCorpusV1, 'corpusDigest'>):
Readonly<Record<string, unknown>> {
  return { ...corpus };
}

function checkWithoutDigest(check: AuthoritativeWikiCheckV1): Readonly<Record<string, unknown>> {
  const { checkDigest, ...basis } = check;
  void checkDigest;
  return basis;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function renderedCitationIds(body: string): readonly string[] {
  const citationIds = new Set<string>();
  let fence: Readonly<{ readonly character: '`' | '~'; readonly length: number }> | null = null;
  for (const line of body.split('\n')) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fenceMatch !== undefined) {
      const character = fenceMatch[0] as '`' | '~';
      if (fence === null) fence = Object.freeze({ character, length: fenceMatch.length });
      else if (fence.character === character && fenceMatch.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    for (const match of line.matchAll(/(?<!\\)\[\^(citation-[a-z0-9]+(?:-[a-z0-9]+)*)\]/gu)) {
      if (match[1] !== undefined) citationIds.add(match[1]);
    }
  }
  return sortedUnique([...citationIds]);
}

export function projectApprovedWikiForRetrieval(
  input: ProjectApprovedWikiInputV1,
  expectedProjectId: string,
): ApprovedWikiRetrievalCorpusV1 {
  const { authorityCheck, state, ownershipGraph } = input;
  exactProject(state.projectId, expectedProjectId);
  exactProject(ownershipGraph.projectId, expectedProjectId);
  exactProject(authorityCheck.projectId, expectedProjectId);
  const activePageIds = [...state.activePages.map((page) => page.pageId)].sort(compareText);
  const stalePageIds = [...authorityCheck.retrievalStalePageIds].sort(compareText);
  const unaffectedPageIds = [...authorityCheck.unaffectedPageIds].sort(compareText);
  const classifiedPageIds = [...stalePageIds, ...unaffectedPageIds].sort(compareText);
  if (state.status !== 'active' || state.ownershipGraphDigest !== ownershipGraph.graphDigest ||
      state.snapshotDigest !== ownershipGraph.snapshotDigest ||
      state.receiptSetDigest !== ownershipGraph.receiptSetDigest ||
      state.reviewSurfaceDigest !== ownershipGraph.reviewSurfaceDigest ||
      state.integratedReviewSetDigest !== ownershipGraph.integratedReviewSetDigest ||
      state.childSynthesisReviewSetDigest !== ownershipGraph.childSynthesisReviewSetDigest ||
      authorityCheck.generationDigest !== state.generationDigest ||
      authorityCheck.humanActivationApprovalDigest !== state.humanActivationApprovalDigest ||
      authorityCheck.receiptSetDigest !== state.receiptSetDigest ||
      authorityCheck.reviewSurfaceDigest !== state.reviewSurfaceDigest ||
      authorityCheck.integratedReviewSetDigest !== state.integratedReviewSetDigest ||
      authorityCheck.childSynthesisReviewSetDigest !== state.childSynthesisReviewSetDigest ||
      authorityCheck.checkDigest !== digest(checkWithoutDigest(authorityCheck)) ||
      !sameStrings(stalePageIds, authorityCheck.retrievalStalePageIds) ||
      !sameStrings(unaffectedPageIds, authorityCheck.unaffectedPageIds) ||
      !sameStrings([...authorityCheck.stalePageIds].sort(compareText), stalePageIds) ||
      !sameStrings(classifiedPageIds, activePageIds) ||
      new Set(classifiedPageIds).size !== classifiedPageIds.length ||
      (authorityCheck.status === 'clean' && stalePageIds.length !== 0) ||
      (authorityCheck.status === 'stale' && stalePageIds.length === 0) ||
      (authorityCheck.status !== 'clean' && authorityCheck.status !== 'stale') ||
      unaffectedPageIds.length === 0) projectionInvalid();
  const proposals = new Map(input.proposals.map((proposal) => [proposal.pageId, proposal]));
  const packs = new Map(input.evidencePacks.map((pack) => [pack.pageId, pack]));
  const ownership = new Map(ownershipGraph.pages.map((page) => [page.pageId, page]));
  const active = new Map(state.activePages.map((page) => [page.pageId, page]));
  const retrievable = new Set(unaffectedPageIds);
  if (proposals.size !== input.proposals.length || packs.size !== input.evidencePacks.length ||
      ownership.size !== ownershipGraph.pages.length || active.size !== state.activePages.length ||
      active.size !== proposals.size || active.size !== packs.size || active.size !== ownership.size) {
    projectionInvalid();
  }
  const inheritedValues = input.inheritedCitationAuthorizations ?? activePageIds.map((pageId) =>
    Object.freeze({ pageId, citationIds: Object.freeze([]) }));
  const inherited = new Map<string, readonly string[]>();
  if (!Array.isArray(inheritedValues) || inheritedValues.length !== activePageIds.length) {
    projectionInvalid();
  }
  const inheritedPageIds: string[] = [];
  for (const item of inheritedValues) {
    if (!isRecord(item) ||
        Object.keys(item).sort().join('\0') !== ['citationIds', 'pageId'].join('\0')) {
      projectionInvalid();
    }
    const pageId = item.pageId;
    const citationIds = item.citationIds;
    if (
      !safeId(pageId) || !active.has(pageId) || inherited.has(pageId) ||
      !isStringArray(citationIds) ||
      !sameStrings(citationIds, sortedUnique(citationIds)) ||
      citationIds.some((citationId) =>
        !safeId(citationId) || !citationId.startsWith('citation-'))
    ) projectionInvalid();
    inheritedPageIds.push(pageId);
    inherited.set(pageId, Object.freeze([...citationIds]));
  }
  if (!sameStrings(inheritedPageIds, activePageIds)) projectionInvalid();
  const globalCitationAnchors = new Map<string, EvidencePackV1['units'][number]['citation']>();
  const globalCitationLocators = new Map<string, ApprovedWikiCitationLocatorV1>();
  const sourceMeanings = new Map((input.sourceMeanings ?? []).map((entry) => [
    entry.sourceId,
    Object.freeze({
      authority: entry.meaning.authority,
      evidenceKind: entry.meaning.evidenceKind,
      iterationGroup: entry.meaning.iterationGroup,
      lifecycle: entry.meaning.lifecycle,
      origin: entry.origin,
      revisionOrdinal: entry.meaning.revisionOrdinal,
      sourceId: entry.sourceId,
      topicGroup: entry.meaning.topicGroup,
    } satisfies ApprovedWikiMeaningSignalV1),
  ]));
  if (sourceMeanings.size !== (input.sourceMeanings?.length ?? 0)) projectionInvalid();
  const meaningSignal = (sourceId: string): ApprovedWikiMeaningSignalV1 => {
    const declared = sourceMeanings.get(sourceId);
    if (declared !== undefined) return declared;
    const neutral = neutralSourceRetrievalMeaning();
    return Object.freeze({
      authority: neutral.authority,
      evidenceKind: neutral.evidenceKind,
      iterationGroup: neutral.iterationGroup,
      lifecycle: neutral.lifecycle,
      origin: 'legacy-default',
      revisionOrdinal: neutral.revisionOrdinal,
      sourceId,
      topicGroup: neutral.topicGroup,
    });
  };
  for (const pack of input.evidencePacks) {
    const localIds = new Set<string>();
    for (const unit of pack.units) {
      const citation = unit.citation;
      if (localIds.has(citation.citationId)) projectionInvalid();
      localIds.add(citation.citationId);
      const existing = globalCitationAnchors.get(citation.citationId);
      if (existing !== undefined && serializeCanonicalJson(existing) !==
          serializeCanonicalJson(citation)) projectionInvalid();
      globalCitationAnchors.set(citation.citationId, citation);
      globalCitationLocators.set(citation.citationId, Object.freeze({
        citationId: citation.citationId,
        ...(citation.jsonPointer === undefined ? {} : { jsonPointer: citation.jsonPointer }),
        sourceId: citation.sourceId,
      }));
    }
  }
  for (const [pageId, citationIds] of inherited) {
    const owner = ownership.get(pageId);
    if (owner === undefined) projectionInvalid();
    const childCitationIds = new Set(owner.childPageIds.flatMap((childPageId) => {
      const childProposal = proposals.get(childPageId);
      if (childProposal === undefined) projectionInvalid();
      return [...childProposal.citationIds];
    }));
    if (citationIds.some((citationId) =>
      !childCitationIds.has(citationId) || !globalCitationLocators.has(citationId))) {
      projectionInvalid();
    }
  }
  const pages = Object.freeze(unaffectedPageIds.map((pageId) => {
    const identity = active.get(pageId);
    const proposal = proposals.get(pageId);
    const pack = packs.get(pageId);
    const owner = ownership.get(pageId);
    if (identity === undefined || proposal === undefined || pack === undefined || owner === undefined ||
        identity.status !== 'active' || identity.proposalDigest !== proposal.proposalDigest ||
        identity.ownershipDigest !== owner.ownershipDigest ||
        proposal.projectId !== expectedProjectId || pack.projectId !== expectedProjectId ||
        proposal.evidencePackDigest !== pack.packDigest || owner.proposalDigest !== proposal.proposalDigest) {
      projectionInvalid();
    }
    const localCitations = new Map(pack.units.map((unit) => [unit.citation.citationId, Object.freeze({
      citationId: unit.citation.citationId,
      ...(unit.citation.jsonPointer === undefined
        ? {}
        : { jsonPointer: unit.citation.jsonPointer }),
      sourceId: unit.citation.sourceId,
    })]));
    const inheritedCitationIds = inherited.get(pageId);
    if (inheritedCitationIds === undefined) projectionInvalid();
    const allowedCitationIds = new Set([...localCitations.keys(), ...inheritedCitationIds]);
    if (localCitations.size !== pack.units.length ||
        proposal.citationIds.some((id) => !allowedCitationIds.has(id) ||
          !globalCitationLocators.has(id)) ||
        inheritedCitationIds.some((id) => !proposal.citationIds.includes(id))) {
      projectionInvalid();
    }
    const sections = Object.freeze(proposal.sections.flatMap((section) => {
      if (!owner.sectionIds.includes(section.sectionId)) projectionInvalid();
      const citationIds = renderedCitationIds(section.body);
      if (citationIds.some((citationId) =>
        !proposal.citationIds.includes(citationId) ||
        !allowedCitationIds.has(citationId) || !globalCitationLocators.has(citationId))) {
        projectionInvalid();
      }
      if (citationIds.length === 0) return [];
      const semantic = projectApprovedWikiSemanticText(
        section.body,
        `${proposal.title}\n${proposal.summary}\n${section.sectionId}`,
      );
      return [Object.freeze({
        body: section.body,
        citationLocators: Object.freeze(citationIds.map((citationId) =>
          globalCitationLocators.get(citationId) as ApprovedWikiCitationLocatorV1)),
        exclusionSummary: semantic.exclusionSummary,
        meaningSignals: Object.freeze(sortedUnique(citationIds.map((citationId) =>
          (globalCitationLocators.get(citationId) as ApprovedWikiCitationLocatorV1).sourceId))
          .map(meaningSignal)),
        semanticContentDigest: semantic.semanticContentDigest,
        semanticText: semantic.semanticText,
        sectionId: section.sectionId,
      })];
    }));
    if (sections.length < 1 || new Set(sections.map((section) => section.sectionId)).size !==
        sections.length) projectionInvalid();
    const relationPageIds = sortedUnique([
      ...(owner.parentPageId === null || !retrievable.has(owner.parentPageId)
        ? [] : [owner.parentPageId]),
      ...owner.childPageIds,
      ...proposal.wikilinks,
    ].filter((relatedPageId) => retrievable.has(relatedPageId)));
    if (relationPageIds.some((relatedPageId) => !retrievable.has(relatedPageId) ||
        relatedPageId === pageId)) projectionInvalid();
    return Object.freeze({
      childPageIds: Object.freeze(owner.childPageIds.filter((childPageId) =>
        retrievable.has(childPageId))),
      pageId,
      parentPageId: owner.parentPageId !== null && retrievable.has(owner.parentPageId)
        ? owner.parentPageId : null,
      proposalDigest: proposal.proposalDigest,
      meaningSignals: Object.freeze([...new Map(sections.flatMap((section) =>
        (section.meaningSignals ?? []).map((signal) => [signal.sourceId, signal] as const))).values()]
        .sort((left, right) => compareText(left.sourceId, right.sourceId))),
      relationPageIds,
      sections,
      status: 'active' as const,
      summary: proposal.summary,
      title: proposal.title,
    });
  }));
  const candidate = Object.freeze({
    generationDigest: state.generationDigest,
    pages,
    projectId: expectedProjectId,
    schemaVersion: APPROVED_WIKI_RETRIEVAL_CORPUS_SCHEMA_VERSION,
  });
  return Object.freeze({ ...candidate, corpusDigest: digest(corpusWithoutDigest(candidate)) });
}

interface CurateSuggestionBasis {
  readonly automaticMutation: false;
  readonly evidenceLocators: readonly ModelFreeWikiCurateEvidenceLocatorV1[];
  readonly pageIds: readonly string[];
  readonly reasonCode: ModelFreeWikiCurateReasonCode;
  readonly reviewAction: ModelFreeWikiCurateReviewAction;
}

function curateInputInvalid(): never {
  throw new HierarchicalRetrievalError('HIERARCHICAL_RETRIEVAL_CONTRACT_VIOLATION');
}

function validateCurateInput(
  input: ModelFreeWikiCurateInputV1,
  expectedProjectId: string,
): void {
  validateCorpus(input.corpus, expectedProjectId);
  exactProject(input.authorityCheck.projectId, expectedProjectId);
  const projectionBasis = Object.freeze({
    corpus: input.corpus,
    projectId: expectedProjectId,
    sanitizerPolicyDigest: input.sanitizerPolicyDigest,
    schemaVersion: APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION_FOR_CURATE,
  });
  if (!DIGEST.test(input.projectionDigest) || !DIGEST.test(input.sanitizerPolicyDigest) ||
      input.projectionDigest !== digest(projectionBasis) ||
      input.authorityCheck.checkDigest !== digest(checkWithoutDigest(input.authorityCheck)) ||
      input.authorityCheck.generationDigest !== input.corpus.generationDigest ||
      input.authorityCheck.status !== 'clean' ||
      input.authorityCheck.changedSourceIds.length !== 0 ||
      input.authorityCheck.configurationDriftReasonCodes.length !== 0 ||
      input.authorityCheck.directlyStalePageIds.length !== 0 ||
      input.authorityCheck.stalePageIds.length !== 0 ||
      input.authorityCheck.retrievalStalePageIds.length !== 0) curateInputInvalid();
  const pageIds = input.corpus.pages.map((page) => page.pageId).sort(compareText);
  if (!sameStrings(input.authorityCheck.unaffectedPageIds, pageIds) ||
      input.proposals.length !== input.corpus.pages.length) curateInputInvalid();
  const pageById = new Map(input.corpus.pages.map((page) => [page.pageId, page]));
  const proposalIds = new Set<string>();
  let reviewUnits = 0;
  for (const proposal of input.proposals) {
    if (!isRecord(proposal) ||
        !sameStrings(Object.keys(proposal).sort(compareText),
          [...CURATE_PROPOSAL_PROPERTIES].sort(compareText))) curateInputInvalid();
    const { proposalDigest, ...proposalBasis } = proposal;
    exactProject(proposal.projectId, expectedProjectId);
    const page = pageById.get(proposal.pageId);
    if (page === undefined || proposalIds.has(proposal.pageId) ||
        proposalDigest !== digest(proposalBasis) ||
        proposal.proposalDigest !== page.proposalDigest ||
        !isStringArray(proposal.wikilinks) || proposal.wikilinks.length > 96 ||
        !isStringArray(proposal.citationIds) || proposal.citationIds.length > 1_024 ||
        !Array.isArray(proposal.claims) || proposal.claims.length > 256 ||
        proposal.wikilinks.some((pageId) => !safeId(pageId)) ||
        proposal.citationIds.some((citationId) => !safeId(citationId)) ||
        proposal.claims.some((claim: unknown) => !isRecord(claim) || !safeId(claim.claimId) ||
          !isStringArray(claim.citationIds) || claim.citationIds.length > 100 ||
          claim.citationIds.some((citationId) => !safeId(citationId)) ||
          !isStringArray(claim.evidenceUnitIds) || claim.evidenceUnitIds.length > 1_024 ||
          claim.evidenceUnitIds.some((unitId) => !safeId(unitId)))) curateInputInvalid();
    reviewUnits += proposal.wikilinks.length + proposal.claims.length;
    if (reviewUnits > MODEL_FREE_WIKI_CURATE_MAX_REVIEW_UNITS) curateInputInvalid();
    proposalIds.add(proposal.pageId);
  }
}

function locatorForPage(
  page: ApprovedWikiRetrievalPageV1,
  claimId: string | null,
  relatedPageId: string | null,
  preferredCitationIds: readonly string[] = [],
): ModelFreeWikiCurateEvidenceLocatorV1 {
  const sections = [...page.sections].sort((left, right) =>
    compareText(left.sectionId, right.sectionId));
  const selected = sections.find((section) => preferredCitationIds.some((citationId) =>
    section.citationLocators.some((locator) => locator.citationId === citationId))) ?? sections[0];
  const availableCitationIds = selected === undefined ? [] : selected.citationLocators
    .map((locator) => locator.citationId);
  const citations = preferredCitationIds.length === 0
    ? availableCitationIds
    : preferredCitationIds.filter((citationId) => availableCitationIds.includes(citationId));
  return Object.freeze({
    citationIds: sortedUnique(citations),
    claimId,
    pageId: page.pageId,
    relatedPageId,
    sectionId: selected?.sectionId ?? null,
  });
}

function curateSuggestion(basis: CurateSuggestionBasis): ModelFreeWikiCurateSuggestionV1 {
  return Object.freeze({
    ...basis,
    suggestionId: `suggestion-${digest(basis).slice('sha256:'.length)}`,
  });
}

function normalizedPageContent(page: ApprovedWikiRetrievalPageV1): string {
  return [
    page.title,
    page.summary,
    ...[...page.sections].sort((left, right) => compareText(left.sectionId, right.sectionId))
      .map((section) => section.body),
  ].join('\n')
    .normalize('NFC')
    .toLowerCase()
    .replace(/(?<!\\)\[\^citation-[a-z0-9]+(?:-[a-z0-9]+)*\]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * @internal Pure transformer for a projection and proposals already replay-verified from the
 * stored authority by LocalWikiOperator. It independently rechecks their canonical digests,
 * and has no provider, process, filesystem, persistence, approval, or mutation capability.
 */
export function createModelFreeWikiCurateResult(
  input: ModelFreeWikiCurateInputV1,
  expectedProjectId: string,
): ModelFreeWikiCurateResultV1 {
  validateCurateInput(input, expectedProjectId);
  const pages = [...input.corpus.pages].sort((left, right) =>
    compareText(left.pageId, right.pageId));
  const pageById = new Map(pages.map((page) => [page.pageId, page]));
  const proposalById = new Map(input.proposals.map((proposal) => [proposal.pageId, proposal]));
  const suggestions: ModelFreeWikiCurateSuggestionV1[] = [];
  let candidateCount = 0;
  const addSuggestion = (basis: CurateSuggestionBasis): void => {
    candidateCount += 1;
    if (suggestions.length < MODEL_FREE_WIKI_CURATE_MAX_SUGGESTIONS) {
      suggestions.push(curateSuggestion(basis));
    }
  };

  for (const page of pages) {
    const proposal = proposalById.get(page.pageId) ?? curateInputInvalid();
    for (const relatedPageId of [...proposal.wikilinks].sort(compareText)) {
      if (pageById.has(relatedPageId)) continue;
      addSuggestion(Object.freeze({
        automaticMutation: false,
        evidenceLocators: Object.freeze([
          locatorForPage(page, null, relatedPageId),
        ]),
        pageIds: Object.freeze([page.pageId]),
        reasonCode: 'broken-link',
        reviewAction: 'review-link-target',
      }));
    }
  }

  const duplicateGroups = new Map<string, ApprovedWikiRetrievalPageV1[]>();
  for (const page of pages) {
    const fingerprint = createHash('sha256').update(normalizedPageContent(page)).digest('hex');
    const group = duplicateGroups.get(fingerprint) ?? [];
    group.push(page);
    duplicateGroups.set(fingerprint, group);
  }
  for (const group of [...duplicateGroups.values()]
    .filter((items) => items.length > 1)
    .sort((left, right) => compareText(left[0]?.pageId ?? '', right[0]?.pageId ?? ''))) {
    const canonical = group[0] ?? curateInputInvalid();
    for (const duplicate of group.slice(1)) {
      addSuggestion(Object.freeze({
        automaticMutation: false,
        evidenceLocators: Object.freeze([
          locatorForPage(canonical, null, duplicate.pageId),
          locatorForPage(duplicate, null, canonical.pageId),
        ]),
        pageIds: Object.freeze([canonical.pageId, duplicate.pageId]),
        reasonCode: 'possible-duplicate',
        reviewAction: 'review-possible-duplicate',
      }));
    }
  }

  for (const page of pages) {
    const proposal = proposalById.get(page.pageId) ?? curateInputInvalid();
    const renderedCitationIds = new Set(page.sections.flatMap((section) =>
      section.citationLocators.map((locator) => locator.citationId)));
    for (const claim of [...proposal.claims].sort((left, right) =>
      compareText(left.claimId, right.claimId))) {
      const unsupported = claim.evidenceUnitIds.length === 0 || claim.citationIds.length === 0 ||
        claim.citationIds.some((citationId) => !proposal.citationIds.includes(citationId) ||
          !renderedCitationIds.has(citationId));
      if (!unsupported) continue;
      addSuggestion(Object.freeze({
        automaticMutation: false,
        evidenceLocators: Object.freeze([
          locatorForPage(page, claim.claimId, null, claim.citationIds),
        ]),
        pageIds: Object.freeze([page.pageId]),
        reasonCode: 'unsupported-claim',
        reviewAction: 'review-claim-support',
      }));
    }
  }

  if (pages.length > 1) {
    const inbound = new Map(pages.map((page) => [page.pageId, new Set<string>()]));
    for (const page of pages) {
      for (const relatedPageId of page.relationPageIds) inbound.get(relatedPageId)?.add(page.pageId);
    }
    for (const page of pages) {
      const connections = new Set([
        ...(page.parentPageId === null ? [] : [page.parentPageId]),
        ...page.childPageIds,
        ...page.relationPageIds,
        ...(inbound.get(page.pageId) ?? []),
      ]);
      if (connections.size > 1) continue;
      addSuggestion(Object.freeze({
        automaticMutation: false,
        evidenceLocators: Object.freeze([
          locatorForPage(page, null, [...connections].sort(compareText)[0] ?? null),
        ]),
        pageIds: Object.freeze([page.pageId]),
        reasonCode: 'weakly-connected-page',
        reviewAction: 'review-page-connection',
      }));
    }
  }

  const resultBasis = Object.freeze({
    authorityCheckDigest: input.authorityCheck.checkDigest,
    candidateCount,
    corpusDigest: input.corpus.corpusDigest,
    egress: 'none' as const,
    generationDigest: input.corpus.generationDigest,
    modelUsed: 'none' as const,
    mutationApplied: false as const,
    projectId: expectedProjectId,
    projectionDigest: input.projectionDigest,
    providerUsed: 'none' as const,
    readOnly: true as const,
    sanitizerPolicyDigest: input.sanitizerPolicyDigest,
    schemaVersion: MODEL_FREE_WIKI_CURATE_RESULT_SCHEMA_VERSION,
    suggestionCount: suggestions.length,
    suggestions: Object.freeze(suggestions),
    truncated: candidateCount > MODEL_FREE_WIKI_CURATE_MAX_SUGGESTIONS,
  });
  if (candidateCount > MODEL_FREE_WIKI_CURATE_MAX_CANDIDATES) curateInputInvalid();
  return Object.freeze({ ...resultBasis, resultDigest: digest(resultBasis) });
}

interface IndexedSection {
  readonly key: string;
  readonly page: ApprovedWikiRetrievalPageV1;
  readonly section: ApprovedWikiRetrievalSectionV1;
  readonly syntheticPageId: string;
}

const RETRIEVAL_AUTHORITIES = new Set<SourceDocumentAuthority>([
  'canonical', 'historical', 'supporting', 'unknown',
]);
const RETRIEVAL_LIFECYCLES = new Set<SourceDocumentLifecycle>([
  'current', 'deprecated', 'draft', 'superseded', 'unknown',
]);
const RETRIEVAL_EVIDENCE_KINDS = new Set<SourceEvidenceKind>([
  'architecture', 'decision', 'execution', 'failure', 'implementation', 'other',
  'overview', 'planning', 'verification',
]);
const SEMANTIC_EXCLUSION_KINDS = new Set<SemanticExclusionKind>([
  'citation-marker', 'duplicate-boilerplate', 'machine-provenance', 'renderer-boilerplate',
]);

function validateMeaningSignals(value: unknown): value is readonly ApprovedWikiMeaningSignalV1[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  let previous = '';
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).sort().join('\0') !== [
      'authority', 'evidenceKind', 'iterationGroup', 'lifecycle', 'origin', 'revisionOrdinal',
      'sourceId', 'topicGroup',
    ].sort().join('\0') ||
      !safeId(item.sourceId) || item.sourceId <= previous ||
      typeof item.authority !== 'string' ||
      !RETRIEVAL_AUTHORITIES.has(item.authority as SourceDocumentAuthority) ||
      typeof item.lifecycle !== 'string' ||
      !RETRIEVAL_LIFECYCLES.has(item.lifecycle as SourceDocumentLifecycle) ||
      typeof item.evidenceKind !== 'string' ||
      !RETRIEVAL_EVIDENCE_KINDS.has(item.evidenceKind as SourceEvidenceKind) ||
      (item.origin !== 'adapter' && item.origin !== 'legacy-default' &&
        item.origin !== 'manifest' && item.origin !== 'profile') ||
      typeof item.revisionOrdinal !== 'number' || !Number.isSafeInteger(item.revisionOrdinal) ||
      item.revisionOrdinal < 0 ||
      (item.topicGroup !== null && !safeId(item.topicGroup)) ||
      (item.iterationGroup !== null && !safeId(item.iterationGroup))) return false;
    previous = item.sourceId;
  }
  return true;
}

function validateSemanticSection(section: ApprovedWikiRetrievalSectionV1): boolean {
  const semanticFields = [
    section.exclusionSummary,
    section.meaningSignals,
    section.semanticContentDigest,
    section.semanticText,
  ];
  if (semanticFields.every((value) => value === undefined)) return true;
  if (semanticFields.some((value) => value === undefined) ||
      !safeText(section.semanticText, 1_048_576) ||
      section.semanticContentDigest !== digest(section.semanticText) ||
      !validateMeaningSignals(section.meaningSignals) ||
      !isRecord(section.exclusionSummary)) return false;
  const summary = section.exclusionSummary;
  if (Object.keys(summary).sort().join('\0') !== [
    'excludedKinds', 'excludedUtf8Bytes', 'policyDigest', 'policyVersion',
  ].sort().join('\0') || summary.policyVersion !== SEMANTIC_CONTENT_POLICY_VERSION ||
      summary.policyDigest !== SEMANTIC_CONTENT_POLICY_DIGEST ||
      typeof summary.excludedUtf8Bytes !== 'number' ||
      !Number.isSafeInteger(summary.excludedUtf8Bytes) || summary.excludedUtf8Bytes < 0 ||
      !Array.isArray(summary.excludedKinds) || summary.excludedKinds.length > 4 ||
      summary.excludedKinds.some((kind) => typeof kind !== 'string' ||
        !SEMANTIC_EXCLUSION_KINDS.has(kind as SemanticExclusionKind)) ||
      !sameStrings(summary.excludedKinds as string[],
        sortedUnique(summary.excludedKinds as string[]))) return false;
  return true;
}

function validateCorpus(corpus: ApprovedWikiRetrievalCorpusV1, expectedProjectId: string): void {
  exactProject(corpus.projectId, expectedProjectId);
  const enriched = corpus.schemaVersion === APPROVED_WIKI_RETRIEVAL_CORPUS_SCHEMA_VERSION;
  if ((!enriched &&
      corpus.schemaVersion !== LEGACY_APPROVED_WIKI_RETRIEVAL_CORPUS_SCHEMA_VERSION) ||
      !SAFE_PROJECT_ID.test(corpus.projectId) || corpus.projectId.length > 64 ||
      !DIGEST.test(corpus.generationDigest) || !DIGEST.test(corpus.corpusDigest) ||
      corpus.pages.length < 1 || corpus.pages.length > 4_096 ||
      corpus.corpusDigest !== digest(corpusWithoutDigest({
        generationDigest: corpus.generationDigest,
        pages: corpus.pages,
        projectId: corpus.projectId,
        schemaVersion: corpus.schemaVersion,
      }))) projectionInvalid();
  const pageIds = new Set<string>();
  let totalSections = 0;
  let totalChars = 0;
  for (const page of corpus.pages) {
    if (!safeId(page.pageId) || pageIds.has(page.pageId) || page.status !== 'active' ||
        !DIGEST.test(page.proposalDigest) || !safeText(page.title, 512) ||
        !safeText(page.summary, 4_000) || page.sections.length < 1 ||
        page.sections.length > 256 || !Array.isArray(page.relationPageIds) ||
        (enriched
          ? page.meaningSignals === undefined || !validateMeaningSignals(page.meaningSignals)
          : page.meaningSignals !== undefined) ||
        new Set(page.childPageIds).size !== page.childPageIds.length ||
        new Set(page.relationPageIds).size !== page.relationPageIds.length) projectionInvalid();
    pageIds.add(page.pageId);
    totalSections += page.sections.length;
    const sectionIds = new Set<string>();
    for (const section of page.sections) {
      if (!safeId(section.sectionId) || sectionIds.has(section.sectionId) ||
          !safeText(section.body, 1_048_576) || section.citationLocators.length < 1 ||
          section.citationLocators.length > 100 || section.citationLocators.some((locator) =>
            !safeId(locator.citationId) || !safeId(locator.sourceId) ||
            !safeJsonPointer(locator.jsonPointer)) ||
          new Set(section.citationLocators.map((locator) =>
            `${locator.citationId}\u0000${locator.sourceId}`)).size !==
            section.citationLocators.length || !validateSemanticSection(section) ||
          (enriched
            ? section.semanticText === undefined
            : section.semanticText !== undefined)) projectionInvalid();
      sectionIds.add(section.sectionId);
      totalChars += page.title.length + 1 + section.sectionId.length + page.summary.length +
        section.body.length;
    }
  }
  if (totalSections > 4_096 || totalChars > 32 * 1_048_576) projectionInvalid();
  for (const page of corpus.pages) {
    const relations = [
      ...(page.parentPageId === null ? [] : [page.parentPageId]),
      ...page.childPageIds,
      ...page.relationPageIds,
    ];
    if (relations.some((pageId) => !pageIds.has(pageId) || pageId === page.pageId)) {
      projectionInvalid();
    }
  }
}

function indexSections(
  corpus: ApprovedWikiRetrievalCorpusV1,
  useSemanticText: boolean,
): {
  readonly byKey: ReadonlyMap<string, IndexedSection>;
  readonly lexical: ReturnType<typeof buildLexicalIndex>;
} {
  const sections = corpus.pages.flatMap((page) => page.sections.map((section) => {
    const key = `${page.pageId}\u0000${section.sectionId}`;
    const syntheticPageId = `sections/${createHash('sha256').update(key).digest('hex')}`;
    return Object.freeze({ key, page, section, syntheticPageId });
  })).sort((left, right) => compareText(left.key, right.key));
  return {
    byKey: new Map(sections.map((section) => [section.key, section])),
    lexical: buildLexicalIndex(sections.map((entry) => ({
      body: useSemanticText ? entry.section.semanticText ?? entry.section.body : entry.section.body,
      freshness: 'fresh',
      pageId: entry.syntheticPageId,
      sourceRefs: sortedUnique(entry.section.citationLocators.map((locator) =>
        `source@approved:${locator.sourceId}`)),
      summary: entry.page.summary,
      title: `${entry.page.title} ${entry.section.sectionId}`,
    }))),
  };
}

function graphRanks(
  seeds: readonly IndexedSection[],
  corpusPages: ReadonlyMap<string, ApprovedWikiRetrievalPageV1>,
  byKey: ReadonlyMap<string, IndexedSection>,
): ReadonlyMap<string, number> {
  const candidates = new Map<string, { readonly distance: number; readonly seedRank: number }>();
  seeds.slice(0, MAX_GRAPH_SEEDS).forEach((seed, seedIndex) => {
    const visited = new Set([seed.page.pageId]);
    let frontier = [seed.page.pageId];
    for (let distance = 1; distance <= MAX_GRAPH_DEPTH; distance += 1) {
      const next: string[] = [];
      for (const pageId of frontier) {
        const page = corpusPages.get(pageId);
        for (const relatedPageId of page?.relationPageIds ?? []) {
          if (visited.has(relatedPageId)) continue;
          visited.add(relatedPageId);
          next.push(relatedPageId);
          const related = corpusPages.get(relatedPageId);
          for (const section of related?.sections ?? []) {
            const key = `${relatedPageId}\u0000${section.sectionId}`;
            const prior = candidates.get(key);
            const candidate = { distance, seedRank: seedIndex + 1 };
            if (prior === undefined || candidate.distance < prior.distance ||
                (candidate.distance === prior.distance && candidate.seedRank < prior.seedRank)) {
              candidates.set(key, candidate);
            }
          }
        }
      }
      frontier = next.sort(compareText);
    }
  });
  const ordered = [...candidates].filter(([key]) => byKey.has(key)).sort((left, right) =>
    left[1].distance - right[1].distance || left[1].seedRank - right[1].seedRank ||
    compareText(left[0], right[0]));
  return new Map(ordered.map(([key], index) => [key, index + 1]));
}

function locator(
  projectId: string,
  entry: IndexedSection,
): HierarchicalRetrievalLocatorV1 {
  return Object.freeze({
    citationIds: sortedUnique(entry.section.citationLocators.map((item) => item.citationId)),
    pageId: entry.page.pageId,
    projectId,
    sectionId: entry.section.sectionId,
    sourceIds: sortedUnique(entry.section.citationLocators.map((item) => item.sourceId)),
  });
}

function checkMethodProject(projectId: string, expectedProjectId: string): void {
  if (projectId !== expectedProjectId) {
    throw new HierarchicalRetrievalError('HIERARCHICAL_RETRIEVAL_PROJECT_MISMATCH');
  }
}

function createApprovedWikiRetrievalInternal(
  corpus: ApprovedWikiRetrievalCorpusV1,
  expectedProjectId: string,
  useSemanticText: boolean,
): ApprovedWikiRetrievalPortV1 {
  validateCorpus(corpus, expectedProjectId);
  const pages = new Map(corpus.pages.map((page) => [page.pageId, page]));
  const indexed = indexSections(corpus, useSemanticText);
  const sectionBySynthetic = new Map([...indexed.byKey.values()].map((entry) =>
    [entry.syntheticPageId, entry]));
  return Object.freeze({
    citations(projectId: string, pageId: string, sectionId?: string) {
      checkMethodProject(projectId, expectedProjectId);
      const page = pages.get(pageId);
      if (page === undefined || (sectionId !== undefined && !safeId(sectionId))) projectionInvalid();
      const sections = sectionId === undefined
        ? page.sections
        : page.sections.filter((section) => section.sectionId === sectionId);
      if (sections.length < 1) projectionInvalid();
      return Object.freeze([...new Map(sections.flatMap((section) => section.citationLocators)
        .map((item) => [`${item.citationId}\u0000${item.sourceId}`, item])).values()]
        .sort((left, right) => compareText(left.citationId, right.citationId) ||
          compareText(left.sourceId, right.sourceId)));
    },
    list(projectId: string) {
      checkMethodProject(projectId, expectedProjectId);
      return Object.freeze(corpus.pages.map((page) => Object.freeze({
        childPageIds: page.childPageIds,
        pageId: page.pageId,
        parentPageId: page.parentPageId,
        sectionIds: Object.freeze(page.sections.map((section) => section.sectionId)),
        title: page.title,
      })));
    },
    read(projectId: string, pageId: string) {
      checkMethodProject(projectId, expectedProjectId);
      const page = pages.get(pageId);
      if (page === undefined) projectionInvalid();
      return page;
    },
    search(request: HierarchicalRetrievalSearchRequestV1) {
      checkMethodProject(request.projectId, expectedProjectId);
      const mode = request.mode ?? 'graph';
      if ((mode !== 'graph' && mode !== 'lexical') || !isSafeQuery(request.query)) {
        throw new HierarchicalRetrievalError('HIERARCHICAL_RETRIEVAL_CONFIG_INVALID');
      }
      const lexical = indexed.lexical.search(request.query).map((entry) => ({
        entry: sectionBySynthetic.get(entry.page.pageId) as IndexedSection,
        lexical: entry,
      }));
      const graph = mode === 'graph'
        ? graphRanks(lexical.map((entry) => entry.entry), pages, indexed.byKey)
        : new Map<string, number>();
      const lexicalKeys = lexical.map((entry) => entry.entry.key);
      const lexicalRankByKey = new Map(lexicalKeys.map((key, index) => [key, index + 1]));
      const fused = mode === 'graph'
        ? [...fuseReciprocalRanks(lexicalKeys, [...graph.keys()])].sort((left, right) =>
            right.combinedScore - left.combinedScore ||
            Number(lexicalRankByKey.has(right.pageId)) - Number(lexicalRankByKey.has(left.pageId)) ||
            compareText(left.pageId, right.pageId))
        : lexical.map((entry) => ({
            combinedScore: entry.lexical.score,
            lexicalContribution: entry.lexical.score,
            lexicalRank: entry.lexical.lexicalRank,
            pageId: entry.entry.key,
            semanticContribution: 0,
          }));
      const lexicalByKey = new Map(lexical.map((entry) => [entry.entry.key, entry.lexical]));
      const hits = Object.freeze(fused.slice(0, MAX_HITS).map((ranked, index) => {
        const entry = indexed.byKey.get(ranked.pageId);
        if (entry === undefined) projectionInvalid();
        const lexicalItem = lexicalByKey.get(ranked.pageId);
        const graphRank = graph.get(ranked.pageId);
        const channels: HierarchicalRetrievalChannelV1[] = [];
        if (lexicalItem !== undefined) channels.push(Object.freeze({
          channel: 'lexical',
          rank: lexicalItem.lexicalRank,
          score: lexicalItem.score,
        }));
        if (graphRank !== undefined) channels.push(Object.freeze({
          channel: 'graph',
          rank: graphRank,
          score: roundSix(1 / graphRank),
        }));
        return Object.freeze({
          channels: Object.freeze(channels),
          locator: locator(expectedProjectId, entry),
          matchedEvidence: lexicalItem?.matchedEvidence ?? [],
          rank: index + 1,
          score: ranked.combinedScore,
          scoreComponents: Object.freeze({
            combinedScore: ranked.combinedScore,
            ...(lexicalItem === undefined ? {} : { lexical: lexicalItem.scoreComponents }),
          }),
          scoreKind: mode === 'graph' ? 'lexical-graph-rrf' as const :
            'lexical-weighted-coverage' as const,
          title: entry.page.title,
        });
      }));
      return Object.freeze({
        effectiveMode: mode,
        fallback: null,
        hits,
        modelUsed: false,
        projectId: expectedProjectId,
        providerUsed: false,
        requestedMode: mode,
        schemaVersion: HIERARCHICAL_RETRIEVAL_RESULT_SCHEMA_VERSION,
      });
    },
  });
}

export function createApprovedWikiRetrieval(
  corpus: ApprovedWikiRetrievalCorpusV1,
  expectedProjectId: string,
): ApprovedWikiRetrievalPortV1 {
  return createApprovedWikiRetrievalInternal(corpus, expectedProjectId, true);
}

/** Exact pre-semantic-content baseline used only by the bound quality evaluator. */
export function createApprovedWikiLegacyRetrieval(
  corpus: ApprovedWikiRetrievalCorpusV1,
  expectedProjectId: string,
): ApprovedWikiRetrievalPortV1 {
  return createApprovedWikiRetrievalInternal(corpus, expectedProjectId, false);
}
