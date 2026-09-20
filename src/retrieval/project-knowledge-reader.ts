import { knowledgeWikiAssessment, knowledgeWikiReadMetadata } from '../compiler/project-knowledge/wiki-contracts.js';
import { knowledgeWikiRoot } from '../compiler/project-knowledge/wiki-projection.js';
import { knowledgeReaderLookupBatch, validateLookupBatch, type KnowledgeReaderLookupBatchV1, type LookupBatchOptions } from '../compiler/project-knowledge/lookup-batch.js';
import { measureRead, type ReadObserver } from './read-observer.js';
import { assertReadActive } from '../application/read-cancellation.js';
import { knowledgeProgressiveMemory, validateProgressiveMemoryRequest, type KnowledgeProgressiveMemoryV1, type ProgressiveMemoryRequest } from '../compiler/project-knowledge/progressive-memory.js';
import { knowledgeTaskMemory, validateTaskMemoryRequest, type KnowledgeTaskMemoryV1, type TaskMemoryRequest } from '../compiler/project-knowledge/task-memory.js';
import { knowledgeReaderPacket, type KnowledgeReaderPacketV1 } from '../compiler/project-knowledge/reader-packet.js';
import { knowledgeDevelopmentMemory, type KnowledgeDevelopmentMemoryV1 } from '../compiler/project-knowledge/reader-memory.js';
import { screenRetainedKnowledgeValue } from '../compiler/project-knowledge/history-security.js';
import { latestKnowledgeGeneration } from './project-knowledge-authority.js';
import type { KnowledgeHierarchyMappingV1 } from '../compiler/project-knowledge/hierarchy-bridge.js';
import { dirname, resolve } from 'node:path';
import { createApprovedWikiPublicationReader, type ApprovedWikiPublicationSnapshotV1 } from './approved-corpus-store.js';
import { createApprovedWikiHybridRetrievalV3, searchApprovedWikiLexicalV3 } from './hybrid.js';
import { createLocalEmbeddingProvider, type EmbeddingProviderPort } from './embedding/index.js';
import { createFlatFileVectorIndex, type VectorIndexPort } from './vector-index/index.js';
import { createKnowledgeRankingSignals } from './project-knowledge-ranking.js';
import { KNOWLEDGE_SEMANTIC_RELEVANCE_V2 } from './semantic-relevance.js';
import type { LocalWikiRetrievalIntent } from './hybrid-types.js';
import { createProjectSecurityService, readSecurityPolicy } from '../sanitizer/index.js';
import { consumePreparedSource } from '../sanitizer/approval.js';
import { digest, invalid, sha256 } from '../knowledge/project-knowledge/guards.js';
import { renderKnowledgeFiles } from '../compiler/project-knowledge/markdown.js';
import { knowledgeFactSupport } from '../compiler/project-knowledge/citation-support.js';
import { knowledgeReaderPage, knowledgeReaderLookup, type KnowledgeReaderPageV1,
  type KnowledgeReaderLookupV1 } from '../compiler/project-knowledge/reader-surface.js';
import type { KnowledgeFactSupportV1 } from '../compiler/project-knowledge/citation-support.js';
import type { KnowledgeDigest, KnowledgeGenerationV1, KnowledgePageV1,
  KnowledgeRecordV1, KnowledgeEvidenceV1 } from '../knowledge/project-knowledge/types.js';

export interface KnowledgeWikiPageView {
  readonly schemaVersion: 'buildlore.project-knowledge-wiki-page.v1' | 'buildlore.project-knowledge-wiki-page.v2';
  readonly knowledgeReview?: NonNullable<ReturnType<typeof knowledgeWikiReadMetadata>['knowledgeReview']>;
  readonly reviewFindings?: ReturnType<typeof knowledgeWikiAssessment>;
  readonly projectId: string;
  readonly generationDigest: KnowledgeDigest;
  readonly pageId: string;
  readonly role: KnowledgePageV1['role'];
  readonly title: string;
  readonly markdown: string;
  readonly claims: readonly KnowledgePageV1['sections'][number]['claims'][number][];
  readonly facts: readonly KnowledgeRecordV1[];
  readonly evidence: readonly KnowledgeEvidenceV1[];
  readonly egress: 'none';
}

export interface KnowledgeWikiReader {
  list(projectId: string, options?: Readonly<{ cursor?: string; limit?: number }>): Promise<Readonly<Record<string, unknown>> | null>;
  read(projectId: string, pageRef: string): Promise<KnowledgeWikiPageView | null>;
  readPacket(projectId: string): Promise<KnowledgeReaderPacketV1 | null>;
  readMemory(projectId: string): Promise<KnowledgeDevelopmentMemoryV1 | null>;
  readProgressiveMemory(projectId: string, request: ProgressiveMemoryRequest): Promise<KnowledgeProgressiveMemoryV1 | null>;
  readTaskMemory(projectId: string, request: TaskMemoryRequest): Promise<KnowledgeTaskMemoryV1 | null>;
  readContext(projectId: string, pageRef: string): Promise<KnowledgeReaderPageV1 | null>;
  lookup(projectId: string, expectedGeneration: KnowledgeDigest, kind: 'evidence' | 'fact', id: KnowledgeDigest): Promise<KnowledgeReaderLookupV1>;
  lookupBatch(projectId: string, expectedGeneration: KnowledgeDigest, kind: 'evidence' | 'fact', ids: readonly KnowledgeDigest[], options?: LookupBatchOptions): Promise<KnowledgeReaderLookupBatchV1>;
  citations(projectId: string, pageRef: string): Promise<Readonly<Record<string, unknown>> | null>;
  search(projectId: string, query: string, mode: 'lexical' | 'hybrid' | 'semantic' | 'graph', intent?: LocalWikiRetrievalIntent): Promise<Readonly<Record<string, unknown>> | null>;
  evidence(projectId: string, generationDigest: KnowledgeDigest, evidenceId: KnowledgeDigest): Promise<KnowledgeEvidenceV1>;
  fact(projectId: string, generationDigest: KnowledgeDigest, factId: KnowledgeDigest): Promise<KnowledgeFactSupportV1>;
}

export interface CreateKnowledgeWikiReaderOptions {
  readonly observer?: ReadObserver;
  /** Defaults to the parent of the Mode A knowledge checkout. */
  readonly hubRoot?: string;
  readonly provider?: EmbeddingProviderPort;
  readonly vectorIndex?: VectorIndexPort;
}

function resolvePageMapping(mappings: readonly KnowledgeHierarchyMappingV1[], pageRef: string): KnowledgeHierarchyMappingV1 {
  return mappings.find(mapping => [mapping.pageId, mapping.role, `${mapping.role}.md`,
    `wiki/buildlore-hierarchy/${mapping.role}.md`, `buildlore-hierarchy/${mapping.role}.md`].includes(pageRef)) ?? invalid();
}

/** Reads only the selected authority, never archive files, edited projections or a legacy cache. */
export function createKnowledgeWikiReader(knowledgeRoot: string,
  options: CreateKnowledgeWikiReaderOptions = {},
): KnowledgeWikiReader {
  return createReader(knowledgeRoot, options);
}

/** Select once; comparison and every projection use the same validated authority. */
export async function openKnowledgeReadSession(knowledgeRoot: string, projectId: string,
  options: CreateKnowledgeWikiReaderOptions = {},
): Promise<Readonly<{ publication: ApprovedWikiPublicationSnapshotV1; reader: KnowledgeWikiReader; generationDigest: KnowledgeDigest | null }> | null> {
  const publication = await measureRead(options.observer, 'publication', () => createApprovedWikiPublicationReader(knowledgeRoot).read(projectId));
  if (!publication) return null;
  const extension = publication.authority.knowledgeGeneration;
  return Object.freeze({ publication,
    generationDigest: extension ? latestKnowledgeGeneration(extension)?.generationDigest ?? null : null,
    reader: createReader(knowledgeRoot, options, { projectId, publication }) });
}

function createReader(knowledgeRoot: string, options: CreateKnowledgeWikiReaderOptions,
  selected?: Readonly<{ projectId: string; publication: ApprovedWikiPublicationSnapshotV1 }>,
): KnowledgeWikiReader {
  const publications = createApprovedWikiPublicationReader(knowledgeRoot);
  const security = createProjectSecurityService({ knowledgeRoot });
  let provider = options.provider;
  let vectorIndex = options.vectorIndex;
  const screen = async (projectId: string, source: string, body: string,
    policyDigest: KnowledgeDigest): Promise<void> => {
    const result = await security.prepareSource({ projectId, source, sourceKind: 'wiki',
      body, bodyDigest: sha256(body), sourceRevisionOrContentSha256: sha256(body) });
    const approved = result.ok ? consumePreparedSource(result.prepared) : null;
    if (!approved || approved.approvedBody !== body || approved.policyDigest !== policyDigest) invalid();
  };
  const load = async (projectId: string) => {
    if (selected && selected.projectId !== projectId) invalid();
    assertReadActive();
    const publication = selected ? selected.publication : await measureRead(options.observer, 'publication', () => publications.read(projectId).catch(() => invalid()));
    if (publication === null) return null;
    const extension = publication.authority.knowledgeGeneration;
    if (!extension) return null;
    const generation = latestKnowledgeGeneration(extension);
    const policy = await measureRead(options.observer, 'policy', () => readSecurityPolicy(knowledgeRoot, projectId));
    if (!generation || generation.snapshot.sanitizerPolicyDigest !== policy.digest) invalid();
    // Re-screen only the materialized retrieval surface. The immutable generation
    // also carries the complete sanitized source snapshot for lineage checks; when
    // serialized as one wiki document, benign security-rule source fragments can
    // combine into prompt-injection false positives even though none are exposed by
    // the reader. Activation applies the same per-file boundary before persistence.
    await measureRead(options.observer, 'materialized-screen', async () => {
      for (const file of renderKnowledgeFiles(generation)) {
        assertReadActive();
        await screen(projectId, `buildlore-hierarchy/${file.path}`, file.body, policy.digest);
      }
    });
    return { publication, extension, generation, policy };
  };
  const loadExpectedGeneration = async (projectId: string, expectedGeneration: KnowledgeDigest) => {
    const loaded = await load(projectId);
    if (!loaded || loaded.generation.generationDigest !== expectedGeneration) invalid();
    return loaded;
  };
  const readMemoryProjection = async <T>(projectId: string,
    name: 'development-memory' | 'task-memory' | 'progressive-memory',
    project: (generation: KnowledgeGenerationV1) => T, task?: string): Promise<T | null> => {
    const loaded = await load(projectId);
    if (!loaded) return null;
    if (task !== undefined) {
      await screen(projectId, `buildlore-hierarchy/${name}-request.txt`, task, loaded.policy.digest);
    }
    const result = project(loaded.generation);
    await screenRetainedKnowledgeValue(result, body =>
      screen(projectId, `buildlore-hierarchy/${name}.json`, body, loaded.policy.digest));
    return result;
  };
  const pageView = (generation: KnowledgeGenerationV1, page: KnowledgePageV1, pageId: string): KnowledgeWikiPageView => {
    const claims = page.sections.flatMap((s) => s.claims);
    const ids = new Set(claims.flatMap((c) => c.factIds));
    const facts = generation.records.filter((f) => ids.has(f.id));
    const evidenceIds = new Set(facts.flatMap((f) => f.evidenceIds));
    return { schemaVersion: generation.wikiProof === undefined ? 'buildlore.project-knowledge-wiki-page.v1' : 'buildlore.project-knowledge-wiki-page.v2',
      ...knowledgeWikiReadMetadata(generation),
      ...(generation.wikiProof === undefined ? {} : { reviewFindings: knowledgeWikiAssessment(generation) }), projectId: generation.projectId,
      generationDigest: generation.generationDigest, pageId, role: page.role, title: page.title,
      markdown: renderKnowledgeFiles(generation).find((f) => f.path === `${page.role}.md`)?.body ?? invalid(),
      claims, facts, evidence: generation.evidence.filter((e) => evidenceIds.has(e.evidenceId)), egress: 'none' };
  };
  const reader: KnowledgeWikiReader = {
    async readProgressiveMemory(projectId, request) {
      const validated = validateProgressiveMemoryRequest(request);
      return readMemoryProjection(projectId, 'progressive-memory',
        generation => knowledgeProgressiveMemory(generation, validated), validated.task);
    },
    async readTaskMemory(projectId, request) {
      const validated = validateTaskMemoryRequest(request);
      return readMemoryProjection(projectId, 'task-memory',
        generation => knowledgeTaskMemory(generation, validated), validated.task);
    },
    async readMemory(projectId) {
      return readMemoryProjection(projectId, 'development-memory', knowledgeDevelopmentMemory);
    },
    async readPacket(projectId) {
      const loaded = await load(projectId);
      if (!loaded) return null;
      const result = knowledgeReaderPacket(loaded.generation);
      await screen(projectId, 'buildlore-hierarchy/reader-packet.json', JSON.stringify(result), loaded.policy.digest);
      return result;
    },
    async readContext(projectId, pageRef) {
      const loaded = await load(projectId);
      if (!loaded) return null;
      const mapping = resolvePageMapping(loaded.extension.pageMappings, pageRef);
      const result = knowledgeReaderPage(loaded.generation, mapping.role);
      await screen(projectId, 'buildlore-hierarchy/reader-page.json', JSON.stringify(result), loaded.policy.digest);
      return result;
    },
    async lookup(projectId, expectedGeneration, kind, id) {
      const loaded = await loadExpectedGeneration(projectId, expectedGeneration);
      const result = await measureRead(options.observer, 'lookup-project', () => Promise.resolve(knowledgeReaderLookup(loaded.generation, kind, id)));
      await measureRead(options.observer, 'response-screen', () => screen(projectId, 'buildlore-hierarchy/reader-lookup.json', JSON.stringify(result), loaded.policy.digest));
      assertReadActive();
      return result;
    },
    async lookupBatch(projectId, expectedGeneration, kind, ids, batchOptions = {}) {
      const validated = validateLookupBatch(kind, ids, batchOptions);
      const inputIds = Object.freeze([...ids]);
      const loaded = await loadExpectedGeneration(projectId, expectedGeneration);
      assertReadActive();
      const result = await measureRead(options.observer, 'lookup-project', () => Promise.resolve(
        knowledgeReaderLookupBatch(loaded.generation, kind, inputIds, { maxBytes: validated.maxBytes })), inputIds.length);
      await measureRead(options.observer, 'response-screen', async () => {
        for (const item of result.items) {
          assertReadActive();
          await screen(projectId, 'buildlore-hierarchy/reader-lookup.json', JSON.stringify(item.result), loaded.policy.digest);
        }
        await screen(projectId, 'buildlore-hierarchy/reader-lookup-batch.json', JSON.stringify(result), loaded.policy.digest);
      }, result.uniqueCount);
      assertReadActive();
      return result;
    },
    async list(projectId, options = {}) {
      const loaded = await load(projectId);
      if (!loaded) return null;
      const limit = options.limit ?? 3;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
      const mappings = loaded.extension.pageMappings;
      const cursorFor = (offset: number) => `knowledge-${digest({ projectId, generationDigest: loaded.generation.generationDigest, offset }).slice(7)}`;
      const start = options.cursor === undefined ? 0 : Array.from({ length: mappings.length - 1 }, (_, i) => i + 1).find((offset) => cursorFor(offset) === options.cursor) ?? invalid();
      const end = Math.min(start + limit, mappings.length);
      return { schemaVersion: loaded.generation.wikiProof === undefined ? 'buildlore.project-knowledge-wiki-list.v1' : 'buildlore.project-knowledge-wiki-list.v2',
        ...knowledgeWikiReadMetadata(loaded.generation), projectId,
        generationDigest: loaded.generation.generationDigest, cursor: end < mappings.length ? cursorFor(end) : null, total: mappings.length,
        pages: mappings.slice(start, end).map((mapping) => ({ pageId: mapping.pageId, role: mapping.role,
          path: `wiki/buildlore-hierarchy/${mapping.role}.md`,
          title: loaded.generation.pages.find((p) => p.role === mapping.role)?.title ?? invalid() })), egress: 'none' };
    },
    async read(projectId, pageRef) {
      const loaded = await load(projectId);
      if (!loaded) return null;
      const mapping = resolvePageMapping(loaded.extension.pageMappings, pageRef);
      const page = loaded.generation.pages.find((p) => p.role === mapping.role);
      if (!page) invalid();
      return pageView(loaded.generation, page, mapping.pageId);
    },
    async citations(projectId, pageRef) {
      const page = await reader.read(projectId, pageRef);
      if (!page) return null;
      return { schemaVersion: page.knowledgeReview === undefined ? 'buildlore.project-knowledge-wiki-citations.v1' : 'buildlore.project-knowledge-wiki-citations.v2',
        ...(page.knowledgeReview === undefined ? {} : { knowledgeReview: page.knowledgeReview, reviewFindings: page.reviewFindings }), projectId,
        generationDigest: page.generationDigest, pageId: page.pageId, role: page.role,
        claims: page.claims, facts: page.facts, evidence: page.evidence, egress: 'none' };
    },
    async evidence(projectId, expectedGeneration, evidenceId) {
      const loaded = await loadExpectedGeneration(projectId, expectedGeneration);
      return loaded.generation.evidence.find((e) => e.evidenceId === evidenceId) ?? invalid();
    },
    async fact(projectId, expectedGeneration, factId) {
      const loaded = await loadExpectedGeneration(projectId, expectedGeneration);
      return knowledgeFactSupport(loaded.generation, factId);
    },
    async search(projectId, query, mode, intent = 'auto') {
      const loaded = await load(projectId);
      if (!loaded) return null;
      await screen(projectId, 'project-knowledge-query.md', query,
        loaded.generation.snapshot.sanitizerPolicyDigest);
      const corpus = loaded.publication.projection.corpus;
      const meaningForHit = createKnowledgeRankingSignals(loaded.extension, corpus);
      const request = { projectId, query, intent, mode };
      const result = mode === 'lexical' || mode === 'graph'
        ? searchApprovedWikiLexicalV3(corpus, request, meaningForHit)
        : await createApprovedWikiHybridRetrievalV3({
          corpus, projectId, meaningForHit, sanitizerPolicyDigest: loaded.policy.digest,
          filterLowRelevanceSemanticHits: true,
          provider: provider ??= createLocalEmbeddingProvider({
            hubRoot: options.hubRoot ?? dirname(resolve(knowledgeRoot)),
          }),
          vectorIndex: vectorIndex ??= createFlatFileVectorIndex(knowledgeRoot),
        }).search(request);
      if (mode === 'semantic' || mode === 'hybrid') {
        // Do not attach support from a generation replaced during asynchronous retrieval.
        const current = await publications.read(projectId).catch(() => invalid());
        if (current === null || current.recordDigest !== loaded.publication.recordDigest ||
          current.projection.projectionDigest !== loaded.publication.projection.projectionDigest ||
          (await readSecurityPolicy(knowledgeRoot, projectId)).digest !== loaded.policy.digest) invalid();
      }
      const basis = { ...result, schemaVersion: loaded.generation.wikiProof === undefined ? 'buildlore.project-knowledge-search.v2' : 'buildlore.project-knowledge-search.v3',
        ...knowledgeWikiReadMetadata(loaded.generation),
        semanticRelevancePolicy: mode === 'semantic' || mode === 'hybrid' ? KNOWLEDGE_SEMANTIC_RELEVANCE_V2 : null,
        supportScope: 'matched-section' as const,
        requestedMode: mode, generationDigest: loaded.generation.generationDigest,
        corpusDigest: loaded.publication.projection.corpus.corpusDigest,
        hits: result.hits.map((hit) => {
          const mapping = loaded.extension.pageMappings.find((m) => m.pageId === hit.locator.pageId) ?? invalid();
          const page = loaded.generation.pages.find((p) => p.role === mapping.role) ?? invalid();
          const section = page.sections.find((_, index) => `knowledge-${String(index)}` === hit.locator.sectionId) ?? invalid();
          const claims = section.claims;
          const factIds = new Set(claims.flatMap(claim => claim.factIds));
          const facts = loaded.generation.records.filter(fact => factIds.has(fact.id));
          const evidenceIds = new Set(facts.flatMap(fact => fact.evidenceIds));
          const evidence = loaded.generation.evidence.filter(item => evidenceIds.has(item.evidenceId));
          // The hierarchy's overview contains reviewed child summaries. Expose
          // their original pages and fact state instead of pretending the text
          // is a claim in the named overview Markdown.
          const inheritedClaims = mapping.role === knowledgeWikiRoot(loaded.generation) && hit.locator.sectionId === 'knowledge-0'
            ? loaded.generation.pages.filter((p) => p.role !== knowledgeWikiRoot(loaded.generation)).map((child) => {
            const childMapping = loaded.extension.pageMappings.find((m) => m.role === child.role) ?? invalid();
            const claim = child.sections[0]?.claims[0] ?? invalid();
            const facts = loaded.generation.records.filter((fact) => claim.factIds.includes(fact.id));
            return { pageId: childMapping.pageId, role: child.role, claim, facts,
              evidence: loaded.generation.evidence.filter((e) => facts.some((fact) => fact.evidenceIds.includes(e.evidenceId))) };
          }) : [];
          return { ...hit, role: mapping.role, claims, facts, evidence, inheritedClaims };
        }), egress: 'none' };
      return { ...basis, resultDigest: digest(basis) };
    },
  };
  return Object.freeze(reader);
}
