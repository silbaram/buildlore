import { createHash } from 'node:crypto';

import type {
  CurrentSessionGenerationExchangeV1,
  EvidenceCitationAnchorV1,
  TextUnitRangeV1,
} from '../compiler/index.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import {
  readSecurityPolicy,
} from '../sanitizer/index.js';
import {
  APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION,
  createApprovedWikiProjectionStore,
  ApprovedWikiProjectionError,
  readApprovedWikiPublicationSnapshot,
  verifyApprovedWikiAuthority,
  type ApprovedWikiAuthorityV1,
  type ApprovedWikiRetrievalProjectionV1,
  type ApprovedWikiProjectionStatusV1,
  type ApprovedWikiProjectionStorePort,
} from './approved-corpus-store.js';
import {
  createLocalEmbeddingProvider,
  createLocalModelBindingService,
  LocalEmbeddingError,
  type EmbeddingIdentityV2,
  type EmbeddingProviderPort,
  type LocalModelBindingPort,
} from './embedding/index.js';
import { createApprovedWikiHybridRetrievalV3 } from './hybrid.js';
import {
  LocalWikiRetrievalError,
  type LocalWikiRetrievalPortV3,
  type LocalWikiRetrievalRequestV3,
  type RetrievalResultV3,
} from './hybrid-types.js';
import {
  createModelFreeWikiCurateResult,
  createApprovedWikiRetrieval,
  projectApprovedWikiForRetrieval,
  type ApprovedWikiRetrievalPageV1,
  type ApprovedWikiRetrievalSectionV1,
  type ModelFreeWikiCurateResultV1,
} from './hierarchical.js';
import {
  createHierarchicalMarkdownPublication,
  withHierarchicalMarkdownLineageLock,
  type HierarchicalMarkdownPublicationPort,
  type HierarchicalMarkdownRepositoryLeasePort,
} from './hierarchical-markdown-publication.js';
import {
  createFlatFileVectorIndex,
  SEMANTIC_CHUNKER_IDENTITY,
  SemanticIndexError,
  type SemanticIndexActivationGuardV1,
  type SemanticIndexBuildResultV1,
  type SemanticIndexStatusV1,
  type VectorIndexPort,
} from './vector-index/index.js';

export const LOCAL_WIKI_INDEX_STATUS_SCHEMA_VERSION =
  'buildlore.local-wiki-index-status.v2' as const;
export const LOCAL_WIKI_INDEX_REBUILD_SCHEMA_VERSION =
  'buildlore.local-wiki-index-rebuild.v1' as const;
export const LOCAL_ACTIVE_WIKI_PAGE_LIST_SCHEMA_VERSION =
  'buildlore.local-active-wiki-page-list.v1' as const;
export const LOCAL_ACTIVE_WIKI_PAGE_SCHEMA_VERSION =
  'buildlore.local-active-wiki-page.v1' as const;
export const LOCAL_ACTIVE_WIKI_PAGE_CITATIONS_SCHEMA_VERSION =
  'buildlore.local-active-wiki-page-citations.v1' as const;
export const LOCAL_ACTIVE_WIKI_MAX_PAGE_LIMIT = 100 as const;

const LOCAL_MODEL_PROFILE_ID = 'multilingual-e5-small';
const DEFAULT_ACTIVE_WIKI_PAGE_LIMIT = 50;
const PAGE_ID_PATTERN = /^page-[a-f0-9]{64}$/u;
const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CURSOR_PATTERN = /^cursor-[a-f0-9]{64}$/u;
const PROJECTION_PROPERTIES = Object.freeze([
  'corpus',
  'projectId',
  'projectionDigest',
  'sanitizerPolicyDigest',
  'schemaVersion',
] as const);

export type LocalActiveWikiPageCursorV1 = `cursor-${string}`;

export interface LocalActiveWikiPageListInputV1 {
  readonly cursor?: string;
  readonly limit?: number;
  readonly projectId: string;
}

export interface LocalActiveWikiPageInputV1 {
  readonly pageId: string;
  readonly projectId: string;
}

export interface LocalActiveWikiCurateInputV1 {
  readonly projectId: string;
}

export interface LocalActiveWikiPageCitationsInputV1 extends LocalActiveWikiPageInputV1 {
  readonly sectionId?: string;
}

export interface LocalActiveWikiPageListItemV1 {
  readonly childPageIds: readonly string[];
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly proposalDigest: `sha256:${string}`;
  readonly relationPageIds: readonly string[];
  readonly sectionIds: readonly string[];
  readonly status: 'active';
  readonly summary: string;
  readonly title: string;
}

export interface LocalActiveWikiProjectionIdentityV1 {
  readonly corpusDigest: `sha256:${string}`;
  readonly egress: 'none';
  readonly generationDigest: `sha256:${string}`;
  readonly projectId: string;
  readonly projectionDigest: `sha256:${string}`;
  readonly providerUsed: 'none';
  readonly sanitizerPolicyDigest: `sha256:${string}`;
}

export interface LocalActiveWikiPageListV1 extends LocalActiveWikiProjectionIdentityV1 {
  readonly cursor: LocalActiveWikiPageCursorV1 | null;
  readonly pages: readonly LocalActiveWikiPageListItemV1[];
  readonly schemaVersion: typeof LOCAL_ACTIVE_WIKI_PAGE_LIST_SCHEMA_VERSION;
  readonly total: number;
}

export interface LocalActiveWikiPageV1 extends LocalActiveWikiProjectionIdentityV1 {
  readonly childPageIds: readonly string[];
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly proposalDigest: `sha256:${string}`;
  readonly relationPageIds: readonly string[];
  readonly schemaVersion: typeof LOCAL_ACTIVE_WIKI_PAGE_SCHEMA_VERSION;
  readonly sections: readonly ApprovedWikiRetrievalSectionV1[];
  readonly status: 'active';
  readonly summary: string;
  readonly title: string;
}

export interface LocalActiveWikiCitationV1 {
  readonly citationId: string;
  readonly quoteDigest: `sha256:${string}`;
  readonly range: TextUnitRangeV1;
  readonly sourceId: string;
  readonly sourceRef: string;
  readonly sourceRevision: `sha256:${string}`;
}

export interface LocalActiveWikiPageCitationsV1 extends LocalActiveWikiProjectionIdentityV1 {
  readonly citations: readonly LocalActiveWikiCitationV1[];
  readonly pageId: string;
  readonly schemaVersion: typeof LOCAL_ACTIVE_WIKI_PAGE_CITATIONS_SCHEMA_VERSION;
  readonly sectionId: string | null;
}

export interface LocalWikiIndexStatusV2 {
  readonly schemaVersion: typeof LOCAL_WIKI_INDEX_STATUS_SCHEMA_VERSION;
  readonly projectId: string;
  readonly materialization: Awaited<ReturnType<HierarchicalMarkdownPublicationPort['status']>>;
  readonly projection: ApprovedWikiProjectionStatusV1;
  readonly reasonCode:
    | 'approved-wiki-projection-invalid'
    | 'approved-wiki-projection-unavailable'
    | 'semantic-index-incompatible'
    | 'semantic-index-stale'
    | 'semantic-index-unavailable'
    | null;
  readonly recoveryAction:
    | readonly ['compile', 'activate', '--project', string]
    | readonly ['index', 'rebuild', '--project', string]
    | readonly ['index', 'rebuild', '--full', '--project', string]
    | null;
  readonly semanticUsable: boolean;
  readonly semanticIndex: SemanticIndexStatusV1;
}

/** @deprecated Use LocalWikiIndexStatusV2. */
export type LocalWikiIndexStatusV1 = LocalWikiIndexStatusV2;

export interface LocalWikiIndexRebuildResultV1 {
  readonly schemaVersion: typeof LOCAL_WIKI_INDEX_REBUILD_SCHEMA_VERSION;
  readonly projectId: string;
  readonly requestedMode: 'full' | 'incremental';
  readonly result: SemanticIndexBuildResultV1;
}

export interface LocalWikiOperatorPort extends LocalWikiRetrievalPortV3 {
  curate(input: LocalActiveWikiCurateInputV1): Promise<ModelFreeWikiCurateResultV1>;
  indexStatus(projectId: string): Promise<LocalWikiIndexStatusV2>;
  listPages(input: LocalActiveWikiPageListInputV1): Promise<LocalActiveWikiPageListV1>;
  pageCitations(
    input: LocalActiveWikiPageCitationsInputV1,
  ): Promise<LocalActiveWikiPageCitationsV1>;
  readPage(input: LocalActiveWikiPageInputV1): Promise<LocalActiveWikiPageV1>;
  rebuildIndex(input: Readonly<{
    readonly full?: boolean;
    readonly projectId: string;
  }>): Promise<LocalWikiIndexRebuildResultV1>;
}

export interface CreateLocalWikiOperatorOptions {
  readonly corpusStore?: ApprovedWikiProjectionStorePort;
  readonly embeddingIdentity?: EmbeddingIdentityV2;
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly localModels?: LocalModelBindingPort;
  readonly markdownPublication?: HierarchicalMarkdownPublicationPort;
  readonly provider?: EmbeddingProviderPort;
  readonly repositoryLease?: HierarchicalMarkdownRepositoryLeasePort;
  readonly vectorIndex?: VectorIndexPort;
}

function projectionRecovery(projectId: string) {
  return Object.freeze(['compile', 'activate', '--project', projectId] as const);
}

function indexRecovery(projectId: string, full = false) {
  return full
    ? Object.freeze(['index', 'rebuild', '--full', '--project', projectId] as const)
    : Object.freeze(['index', 'rebuild', '--project', projectId] as const);
}

function mapProjectionError(error: unknown, projectId: string): LocalWikiRetrievalError {
  if (!(error instanceof ApprovedWikiProjectionError)) {
    return new LocalWikiRetrievalError('LOCAL_WIKI_PROJECTION_INVALID', {
      recoveryAction: projectionRecovery(projectId),
    });
  }
  return new LocalWikiRetrievalError(
    error.code === 'APPROVED_WIKI_PROJECTION_UNAVAILABLE'
      ? 'LOCAL_WIKI_PROJECTION_UNAVAILABLE'
      : error.code === 'APPROVED_WIKI_PROJECTION_PROJECT_MISMATCH'
        ? 'LOCAL_WIKI_RETRIEVAL_PROJECT_MISMATCH'
        : 'LOCAL_WIKI_PROJECTION_INVALID',
    { recoveryAction: projectionRecovery(projectId) },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function projectionInvalid(projectId: string): never {
  throw new LocalWikiRetrievalError('LOCAL_WIKI_PROJECTION_INVALID', {
    recoveryAction: projectionRecovery(projectId),
  });
}

function inputInvalid(): never {
  throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID');
}

function contractInvalid(): never {
  throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_CONTRACT_INVALID');
}

function projectMismatch(): never {
  throw new LocalWikiRetrievalError('LOCAL_WIKI_RETRIEVAL_PROJECT_MISMATCH');
}

function exactProperties(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 &&
    value === value.normalize('NFC') && PROJECT_ID_PATTERN.test(value);
}

function validatePageInput(value: unknown, citations: false): LocalActiveWikiPageInputV1;
function validatePageInput(value: unknown, citations: true): LocalActiveWikiPageCitationsInputV1;
function validatePageInput(
  value: unknown,
  citations: boolean,
): LocalActiveWikiPageInputV1 | LocalActiveWikiPageCitationsInputV1 {
  const allowed = citations ? ['pageId', 'projectId', 'sectionId'] : ['pageId', 'projectId'];
  if (!isRecord(value) || !exactProperties(value, allowed) ||
      !Object.hasOwn(value, 'pageId') || !Object.hasOwn(value, 'projectId') ||
      !validProjectId(value.projectId) || typeof value.pageId !== 'string' ||
      !PAGE_ID_PATTERN.test(value.pageId)) inputInvalid();
  if (citations && value.sectionId !== undefined &&
      (typeof value.sectionId !== 'string' || value.sectionId.length > 256 ||
        value.sectionId !== value.sectionId.normalize('NFC') ||
        !SAFE_ID_PATTERN.test(value.sectionId))) inputInvalid();
  return value as unknown as LocalActiveWikiPageInputV1 | LocalActiveWikiPageCitationsInputV1;
}

function validateListInput(value: unknown): Readonly<{
  readonly cursor: string | undefined;
  readonly limit: number;
  readonly projectId: string;
}> {
  if (!isRecord(value) || !exactProperties(value, ['cursor', 'limit', 'projectId']) ||
      !Object.hasOwn(value, 'projectId') || !validProjectId(value.projectId)) inputInvalid();
  const limit = value.limit === undefined ? DEFAULT_ACTIVE_WIKI_PAGE_LIMIT : value.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 ||
      Number(limit) > LOCAL_ACTIVE_WIKI_MAX_PAGE_LIMIT) inputInvalid();
  if (value.cursor !== undefined &&
      (typeof value.cursor !== 'string' || !CURSOR_PATTERN.test(value.cursor))) inputInvalid();
  return Object.freeze({
    cursor: value.cursor,
    limit: Number(limit),
    projectId: value.projectId,
  });
}

function validateCurateInput(value: unknown): LocalActiveWikiCurateInputV1 {
  if (!isRecord(value) || !exactProperties(value, ['projectId']) ||
      !Object.hasOwn(value, 'projectId') || !validProjectId(value.projectId)) inputInvalid();
  return Object.freeze({ projectId: value.projectId });
}

function immutableSnapshot<T>(value: T, projectId: string): T {
  try {
    return JSON.parse(serializeCanonicalJson(value)) as T;
  } catch {
    return projectionInvalid(projectId);
  }
}

function validateProjection(
  value: ApprovedWikiRetrievalProjectionV1,
  projectId: string,
): ApprovedWikiRetrievalProjectionV1 {
  if (!isRecord(value) ||
      Object.keys(value).sort().join('\0') !== [...PROJECTION_PROPERTIES].sort().join('\0') ||
      value.schemaVersion !== APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION ||
      !isRecord(value.corpus) || value.projectId !== projectId ||
      value.corpus.projectId !== projectId) {
    if (isRecord(value) && (value.projectId !== projectId ||
        (isRecord(value.corpus) && value.corpus.projectId !== projectId))) projectMismatch();
    projectionInvalid(projectId);
  }
  if (!DIGEST_PATTERN.test(value.sanitizerPolicyDigest) ||
      !DIGEST_PATTERN.test(value.projectionDigest)) projectionInvalid(projectId);
  const basis = Object.freeze({
    corpus: value.corpus,
    projectId: value.projectId,
    sanitizerPolicyDigest: value.sanitizerPolicyDigest,
    schemaVersion: value.schemaVersion,
  });
  try {
    createApprovedWikiRetrieval(value.corpus, projectId);
  } catch {
    projectionInvalid(projectId);
  }
  if (value.projectionDigest !== sha256(basis)) projectionInvalid(projectId);
  return value;
}

function projectionIdentity(
  projection: ApprovedWikiRetrievalProjectionV1,
): LocalActiveWikiProjectionIdentityV1 {
  return Object.freeze({
    corpusDigest: projection.corpus.corpusDigest,
    egress: 'none' as const,
    generationDigest: projection.corpus.generationDigest,
    projectId: projection.projectId,
    projectionDigest: projection.projectionDigest,
    providerUsed: 'none' as const,
    sanitizerPolicyDigest: projection.sanitizerPolicyDigest,
  });
}

function pageListItem(page: ApprovedWikiRetrievalPageV1): LocalActiveWikiPageListItemV1 {
  return Object.freeze({
    childPageIds: Object.freeze([...page.childPageIds]),
    pageId: page.pageId,
    parentPageId: page.parentPageId,
    proposalDigest: page.proposalDigest,
    relationPageIds: Object.freeze([...page.relationPageIds]),
    sectionIds: Object.freeze(page.sections.map((section) => section.sectionId)),
    status: page.status,
    summary: page.summary,
    title: page.title,
  });
}

function pageResult(
  projection: ApprovedWikiRetrievalProjectionV1,
  page: ApprovedWikiRetrievalPageV1,
): LocalActiveWikiPageV1 {
  return Object.freeze({
    ...projectionIdentity(projection),
    childPageIds: Object.freeze([...page.childPageIds]),
    pageId: page.pageId,
    parentPageId: page.parentPageId,
    proposalDigest: page.proposalDigest,
    relationPageIds: Object.freeze([...page.relationPageIds]),
    schemaVersion: LOCAL_ACTIVE_WIKI_PAGE_SCHEMA_VERSION,
    sections: Object.freeze(page.sections.map((section) => Object.freeze({
      body: section.body,
      citationLocators: Object.freeze(section.citationLocators.map((locator) => Object.freeze({
        citationId: locator.citationId,
        sourceId: locator.sourceId,
      }))),
      sectionId: section.sectionId,
    }))),
    status: page.status,
    summary: page.summary,
    title: page.title,
  });
}

function cursorFor(
  projection: ApprovedWikiRetrievalProjectionV1,
  offset: number,
): LocalActiveWikiPageCursorV1 {
  const token = createHash('sha256').update(serializeCanonicalJson({
    corpusDigest: projection.corpus.corpusDigest,
    generationDigest: projection.corpus.generationDigest,
    offset,
    projectId: projection.projectId,
    schemaVersion: LOCAL_ACTIVE_WIKI_PAGE_LIST_SCHEMA_VERSION,
  })).digest('hex');
  return `cursor-${token}`;
}

function cursorOffset(
  cursor: string | undefined,
  projection: ApprovedWikiRetrievalProjectionV1,
): number {
  if (cursor === undefined) return 0;
  for (let offset = 1; offset < projection.corpus.pages.length; offset += 1) {
    if (cursorFor(projection, offset) === cursor) return offset;
  }
  return inputInvalid();
}

function authorityProjection(
  authority: ApprovedWikiAuthorityV1,
  projectId: string,
): ApprovedWikiRetrievalProjectionV1 {
  const inheritedCitationAuthorizations = Object.freeze(authority.finalization.generationHandoffs
    .map((handoff) => handoff.exchange as CurrentSessionGenerationExchangeV1)
    .map((exchange) => Object.freeze({
      citationIds: Object.freeze([...new Set(exchange.request.approvedChildSummaries
        .flatMap((summary) => [...summary.citationIds]))].sort(compareText)),
      pageId: exchange.pageId,
    }))
    .sort((left, right) => compareText(left.pageId, right.pageId)));
  const corpus = projectApprovedWikiForRetrieval({
    authorityCheck: authority.authorityCheck,
    evidencePacks: authority.finalization.evidencePacks,
    inheritedCitationAuthorizations,
    ownershipGraph: authority.ownershipGraph,
    proposals: authority.finalization.proposals,
    state: authority.state,
  }, projectId);
  createApprovedWikiRetrieval(corpus, projectId);
  const basis = Object.freeze({
    corpus,
    projectId,
    sanitizerPolicyDigest: authority.liveSnapshot.sanitizerPolicyDigest,
    schemaVersion: APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION,
  });
  return Object.freeze({ ...basis, projectionDigest: sha256(basis) });
}

function globalCitationAnchors(
  authority: ApprovedWikiAuthorityV1,
  projectId: string,
): ReadonlyMap<string, EvidenceCitationAnchorV1> {
  const anchors = new Map<string, EvidenceCitationAnchorV1>();
  for (const pack of authority.finalization.evidencePacks) {
    for (const unit of pack.units) {
      const existing = anchors.get(unit.citation.citationId);
      if (existing !== undefined && !sameValue(existing, unit.citation)) {
        projectionInvalid(projectId);
      }
      anchors.set(unit.citation.citationId, unit.citation);
    }
  }
  return anchors;
}

async function verifiedIdentity(
  options: CreateLocalWikiOperatorOptions,
): Promise<EmbeddingIdentityV2> {
  if (options.embeddingIdentity !== undefined) return options.embeddingIdentity;
  const view = await (options.localModels ??
    createLocalModelBindingService(options.hubRoot)).verify(LOCAL_MODEL_PROFILE_ID);
  if (view.state !== 'ready' || view.activeIdentity === null) {
    throw new LocalEmbeddingError(
      view.state === 'incompatible'
        ? 'LOCAL_EMBEDDING_INCOMPATIBLE'
        : 'LOCAL_EMBEDDING_UNAVAILABLE',
      view.reasonCode,
    );
  }
  return view.activeIdentity;
}

export function createLocalWikiOperator(
  options: CreateLocalWikiOperatorOptions,
): LocalWikiOperatorPort {
  const corpusStore = options.corpusStore ??
    createApprovedWikiProjectionStore(options.knowledgeRoot);
  const vectorIndex = options.vectorIndex ?? createFlatFileVectorIndex(options.knowledgeRoot);
  const provider = options.provider ?? createLocalEmbeddingProvider({ hubRoot: options.hubRoot });
  const markdownPublication = options.markdownPublication ??
    createHierarchicalMarkdownPublication({ knowledgeRoot: options.knowledgeRoot });
  const repositoryLease = options.repositoryLease;

  async function readProjection(projectId: string) {
    try {
      return immutableSnapshot(await corpusStore.read(projectId), projectId);
    } catch (error) {
      if (error instanceof LocalWikiRetrievalError) throw error;
      throw mapProjectionError(error, projectId);
    }
  }

  async function compatibleProjection(projectId: string) {
    const projection = validateProjection(await readProjection(projectId), projectId);
    let policy: Awaited<ReturnType<typeof readSecurityPolicy>>;
    try {
      policy = await readSecurityPolicy(options.knowledgeRoot, projectId);
    } catch {
      return projectionInvalid(projectId);
    }
    if (projection.sanitizerPolicyDigest !== policy.digest) {
      projectionInvalid(projectId);
    }
    return projection;
  }

  async function matchingAuthority(
    projection: ApprovedWikiRetrievalProjectionV1,
    projectId: string,
  ): Promise<ApprovedWikiAuthorityV1> {
    let authority: ApprovedWikiAuthorityV1;
    try {
      authority = immutableSnapshot(await corpusStore.readAuthority(projectId), projectId);
      verifyApprovedWikiAuthority(authority, projectId);
      const expectedProjection = authorityProjection(authority, projectId);
      if (!sameValue(expectedProjection, projection)) projectionInvalid(projectId);
      const policy = await readSecurityPolicy(options.knowledgeRoot, projectId);
      if (policy.digest !== projection.sanitizerPolicyDigest) projectionInvalid(projectId);
    } catch (error) {
      if (error instanceof LocalWikiRetrievalError) throw error;
      throw mapProjectionError(error, projectId);
    }
    return authority;
  }

  function selectedPage(
    projection: ApprovedWikiRetrievalProjectionV1,
    pageId: string,
  ): ApprovedWikiRetrievalPageV1 {
    return projection.corpus.pages.find((page) => page.pageId === pageId) ?? contractInvalid();
  }

  const operator: LocalWikiOperatorPort = {
    async curate(rawInput) {
      const input = validateCurateInput(rawInput);
      const projection = await compatibleProjection(input.projectId);
      const authority = await matchingAuthority(projection, input.projectId);
      try {
        return createModelFreeWikiCurateResult({
          authorityCheck: authority.authorityCheck,
          corpus: projection.corpus,
          projectionDigest: projection.projectionDigest,
          proposals: authority.finalization.proposals,
          sanitizerPolicyDigest: projection.sanitizerPolicyDigest,
        }, input.projectId);
      } catch (error) {
        if (error instanceof LocalWikiRetrievalError) throw error;
        return projectionInvalid(input.projectId);
      }
    },
    async indexStatus(projectId) {
      const [materialization, projection, semanticIndex] = await Promise.all([
        markdownPublication.status(projectId),
        corpusStore.status(projectId),
        vectorIndex.status(projectId),
      ]);
      const projectionUnavailable = projection.state === 'none';
      let policyMatches = projection.state !== 'ready';
      if (projection.state === 'ready') {
        try {
          policyMatches = (await readSecurityPolicy(options.knowledgeRoot, projectId)).digest ===
            projection.sanitizerPolicyDigest;
        } catch {
          policyMatches = false;
        }
      }
      const projectionInvalid = projection.state === 'invalid' || !policyMatches;
      const indexUnavailable = semanticIndex.state === 'none';
      const indexIncompatible = semanticIndex.state === 'incompatible';
      const indexStale = projection.state === 'ready' && semanticIndex.state === 'ready' && (
        semanticIndex.manifest.projectId !== projectId ||
        semanticIndex.manifest.corpusDigest !== projection.corpusDigest ||
        semanticIndex.manifest.wikiGenerationDigest !== projection.generationDigest ||
        semanticIndex.manifest.sanitizerPolicyDigest !== projection.sanitizerPolicyDigest
      );
      const reasonCode = projectionUnavailable
        ? 'approved-wiki-projection-unavailable' as const
        : projectionInvalid
          ? 'approved-wiki-projection-invalid' as const
          : indexUnavailable
            ? 'semantic-index-unavailable' as const
            : indexIncompatible
              ? 'semantic-index-incompatible' as const
              : indexStale
                ? 'semantic-index-stale' as const
                : null;
      return Object.freeze({
        projectId,
        materialization,
        projection,
        reasonCode,
        recoveryAction: reasonCode === null
          ? null
          : projectionUnavailable || projectionInvalid
            ? projectionRecovery(projectId)
            : indexRecovery(projectId, indexIncompatible || indexStale),
        schemaVersion: LOCAL_WIKI_INDEX_STATUS_SCHEMA_VERSION,
        semanticUsable: reasonCode === null,
        semanticIndex,
      });
    },
    async listPages(rawInput) {
      const input = validateListInput(rawInput);
      const projection = await compatibleProjection(input.projectId);
      const pages = [...projection.corpus.pages].sort((left, right) =>
        compareText(left.pageId, right.pageId));
      const offset = cursorOffset(input.cursor, projection);
      const selected = pages.slice(offset, offset + input.limit);
      const nextOffset = offset + selected.length;
      return Object.freeze({
        ...projectionIdentity(projection),
        cursor: nextOffset < pages.length ? cursorFor(projection, nextOffset) : null,
        pages: Object.freeze(selected.map(pageListItem)),
        schemaVersion: LOCAL_ACTIVE_WIKI_PAGE_LIST_SCHEMA_VERSION,
        total: pages.length,
      });
    },
    async pageCitations(rawInput) {
      const input = validatePageInput(rawInput, true);
      const projection = await compatibleProjection(input.projectId);
      const page = selectedPage(projection, input.pageId);
      const sections = input.sectionId === undefined
        ? page.sections
        : page.sections.filter((section) => section.sectionId === input.sectionId);
      if (sections.length < 1) contractInvalid();
      const authority = await matchingAuthority(projection, input.projectId);
      const anchors = globalCitationAnchors(authority, input.projectId);
      const owner = authority.ownershipGraph.pages.find((item) => item.pageId === page.pageId) ??
        projectionInvalid(input.projectId);
      const pack = authority.finalization.evidencePacks.find((item) =>
        item.pageId === page.pageId) ?? projectionInvalid(input.projectId);
      const exchange = authority.finalization.generationHandoffs
        .map((handoff) => handoff.exchange as CurrentSessionGenerationExchangeV1)
        .find((item) => item.pageId === page.pageId) ?? projectionInvalid(input.projectId);
      const localCitationIds = new Set(pack.units.map((unit) => unit.citation.citationId));
      const inheritedCitationIds = new Set<string>();
      for (const summary of exchange.request.approvedChildSummaries) {
        if (!owner.childPageIds.includes(summary.pageId)) projectionInvalid(input.projectId);
        for (const citationId of summary.citationIds) inheritedCitationIds.add(citationId);
      }
      const selectedAnchors = new Map<string, EvidenceCitationAnchorV1>();
      for (const section of sections) {
        for (const locator of section.citationLocators) {
          if (!localCitationIds.has(locator.citationId) &&
              !inheritedCitationIds.has(locator.citationId)) projectionInvalid(input.projectId);
          const anchor = anchors.get(locator.citationId);
          if (anchor === undefined || anchor.sourceId !== locator.sourceId) {
            projectionInvalid(input.projectId);
          }
          selectedAnchors.set(locator.citationId, anchor);
        }
      }
      const citations = Object.freeze([...selectedAnchors.values()]
        .sort((left, right) => compareText(left.citationId, right.citationId))
        .map((anchor): LocalActiveWikiCitationV1 => Object.freeze({
          citationId: anchor.citationId,
          quoteDigest: anchor.quoteDigest,
          range: Object.freeze({
            endColumn: anchor.range.endColumn,
            endLine: anchor.range.endLine,
            startColumn: anchor.range.startColumn,
            startLine: anchor.range.startLine,
          }),
          sourceId: anchor.sourceId,
          sourceRef: anchor.sourceRef,
          sourceRevision: anchor.sourceRevision,
        })));
      return Object.freeze({
        ...projectionIdentity(projection),
        citations,
        pageId: page.pageId,
        schemaVersion: LOCAL_ACTIVE_WIKI_PAGE_CITATIONS_SCHEMA_VERSION,
        sectionId: input.sectionId ?? null,
      });
    },
    async readPage(rawInput) {
      const input = validatePageInput(rawInput, false);
      const projection = await compatibleProjection(input.projectId);
      return pageResult(projection, selectedPage(projection, input.pageId));
    },
    async rebuildIndex(input) {
      if (repositoryLease === undefined) {
        throw new SemanticIndexError('SEMANTIC_INDEX_CONFIG_INVALID', 'artifact-invalid');
      }
      const projection = await compatibleProjection(input.projectId);
      const embeddingIdentity = await verifiedIdentity(options);
      let expectedPublication: Awaited<ReturnType<typeof readApprovedWikiPublicationSnapshot>>;
      try {
        expectedPublication = await readApprovedWikiPublicationSnapshot(
          options.knowledgeRoot,
          input.projectId,
        );
      } catch (error) {
        throw mapProjectionError(error, input.projectId);
      }
      if (!sameValue(expectedPublication.projection, projection)) {
        projectionInvalid(input.projectId);
      }
      const activationGuard: SemanticIndexActivationGuardV1 = async (candidate, activate) => {
        try {
          return await repositoryLease.withLease(
            options.knowledgeRoot,
            'semantic-index-activation',
            async (lease) => {
              await lease.updatePhase('semantic-lineage');
              return withHierarchicalMarkdownLineageLock(
                options.knowledgeRoot,
                input.projectId,
                async () => {
                  const current = await readApprovedWikiPublicationSnapshot(
                    options.knowledgeRoot,
                    input.projectId,
                  );
                  const policy = await readSecurityPolicy(options.knowledgeRoot, input.projectId);
                  const currentEmbeddingIdentity = await verifiedIdentity(options);
                  const providerIdentity = provider.activeIdentity();
                  if (current.authorityDigest !== expectedPublication.authorityDigest ||
                      current.recordDigest !== expectedPublication.recordDigest ||
                      !sameValue(current.projection, expectedPublication.projection) ||
                      policy.digest !== expectedPublication.projection.sanitizerPolicyDigest ||
                      currentEmbeddingIdentity.identityDigest !== embeddingIdentity.identityDigest ||
                      providerIdentity?.identityDigest !== embeddingIdentity.identityDigest ||
                      candidate.projectId !== input.projectId ||
                      candidate.corpusDigest !== projection.corpus.corpusDigest ||
                      candidate.wikiGenerationDigest !== projection.corpus.generationDigest ||
                      candidate.sanitizerPolicyDigest !== projection.sanitizerPolicyDigest ||
                      candidate.chunkerIdentityDigest !==
                        SEMANTIC_CHUNKER_IDENTITY.identityDigest ||
                      candidate.embeddingIdentityDigest !== embeddingIdentity.identityDigest) {
                    throw new SemanticIndexError('SEMANTIC_INDEX_INCOMPATIBLE', 'lineage-drift');
                  }
                  return activate();
                },
              );
            },
          );
        } catch (error) {
          if (error instanceof SemanticIndexError) throw error;
          throw new SemanticIndexError('SEMANTIC_INDEX_INCOMPATIBLE', 'lineage-drift');
        }
      };
      const buildInput = Object.freeze({
        activationGuard,
        corpus: projection.corpus,
        embeddingIdentity,
        projectId: input.projectId,
        provider,
        sanitizerPolicyDigest: projection.sanitizerPolicyDigest,
      });
      const requestedMode = input.full === true ? 'full' as const : 'incremental' as const;
      const result = requestedMode === 'full'
        ? await vectorIndex.buildFull(buildInput)
        : await vectorIndex.buildIncremental(buildInput);
      return Object.freeze({
        projectId: input.projectId,
        requestedMode,
        result,
        schemaVersion: LOCAL_WIKI_INDEX_REBUILD_SCHEMA_VERSION,
      });
    },
    async search(request: LocalWikiRetrievalRequestV3): Promise<RetrievalResultV3> {
      const projection = await compatibleProjection(request.projectId);
      return createApprovedWikiHybridRetrievalV3({
        corpus: projection.corpus,
        projectId: request.projectId,
        provider,
        sanitizerPolicyDigest: projection.sanitizerPolicyDigest,
        vectorIndex,
      }).search(request);
    },
  };
  return Object.freeze(operator);
}
