import { createApprovedWikiProjectionStore, readApprovedWikiPublicationSnapshot } from './approved-corpus-store.js';
import { searchApprovedWikiLexicalV3 } from './hybrid.js';
import { createKnowledgeRankingSignals } from './project-knowledge-ranking.js';
import type { LocalWikiRetrievalIntent } from './hybrid-types.js';
import { createProjectSecurityService, readSecurityPolicy } from '../sanitizer/index.js';
import { consumePreparedSource } from '../sanitizer/approval.js';
import { digest, invalid, sha256 } from '../knowledge/project-knowledge/guards.js';
import { renderKnowledgeFiles } from '../compiler/project-knowledge/markdown.js';
import type { KnowledgeDigest, KnowledgeGenerationV1, KnowledgePageV1,
  KnowledgeRecordV1, KnowledgeEvidenceV1 } from '../knowledge/project-knowledge/types.js';

export interface KnowledgeWikiPageView {
  readonly schemaVersion: 'buildlore.project-knowledge-wiki-page.v1';
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
  citations(projectId: string, pageRef: string): Promise<Readonly<Record<string, unknown>> | null>;
  search(projectId: string, query: string, mode: 'lexical' | 'hybrid' | 'semantic' | 'graph', intent?: LocalWikiRetrievalIntent): Promise<Readonly<Record<string, unknown>> | null>;
  evidence(projectId: string, generationDigest: KnowledgeDigest, evidenceId: KnowledgeDigest): Promise<KnowledgeEvidenceV1>;
}

/** Reads only the selected authority, never archive files, edited projections or a legacy cache. */
export function createKnowledgeWikiReader(knowledgeRoot: string): KnowledgeWikiReader {
  const corpusStore = createApprovedWikiProjectionStore(knowledgeRoot);
  const security = createProjectSecurityService({ knowledgeRoot });
  const screen = async (projectId: string, body: string, policyDigest: KnowledgeDigest): Promise<void> => {
    const result = await security.prepareSource({ projectId, source: 'project-knowledge-reader.md', sourceKind: 'wiki',
      body, bodyDigest: sha256(body), sourceRevisionOrContentSha256: sha256(body) });
    const approved = result.ok ? consumePreparedSource(result.prepared) : null;
    if (!approved || approved.approvedBody !== body || approved.policyDigest !== policyDigest || approved.untrustedData) invalid();
  };
  const load = async (projectId: string) => {
    const status = await corpusStore.status(projectId);
    if (status.state === 'none') return null;
    if (status.state !== 'ready') invalid();
    const publication = await readApprovedWikiPublicationSnapshot(knowledgeRoot, projectId);
    const extension = publication.authority.knowledgeGeneration;
    if (!extension) return null;
    const generation = extension.generations.at(-1);
    const policy = await readSecurityPolicy(knowledgeRoot, projectId);
    if (!generation || generation.snapshot.sanitizerPolicyDigest !== policy.digest) invalid();
    await screen(projectId, JSON.stringify(generation), policy.digest);
    return { publication, extension, generation };
  };
  const pageView = (generation: KnowledgeGenerationV1, page: KnowledgePageV1, pageId: string): KnowledgeWikiPageView => {
    const claims = page.sections.flatMap((s) => s.claims);
    const ids = new Set(claims.flatMap((c) => c.factIds));
    const facts = generation.records.filter((f) => ids.has(f.id));
    const evidenceIds = new Set(facts.flatMap((f) => f.evidenceIds));
    return { schemaVersion: 'buildlore.project-knowledge-wiki-page.v1', projectId: generation.projectId,
      generationDigest: generation.generationDigest, pageId, role: page.role, title: page.title,
      markdown: renderKnowledgeFiles(generation).find((f) => f.path === `${page.role}.md`)?.body ?? invalid(),
      claims, facts, evidence: generation.evidence.filter((e) => evidenceIds.has(e.evidenceId)), egress: 'none' };
  };
  const reader: KnowledgeWikiReader = {
    async list(projectId, options = {}) {
      const loaded = await load(projectId);
      if (!loaded) return null;
      const limit = options.limit ?? 3;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
      const mappings = loaded.extension.pageMappings;
      const cursorFor = (offset: number) => `knowledge-${digest({ projectId, generationDigest: loaded.generation.generationDigest, offset }).slice(7)}`;
      const start = options.cursor === undefined ? 0 : [1, 2].find((offset) => cursorFor(offset) === options.cursor) ?? invalid();
      const end = Math.min(start + limit, 3);
      return { schemaVersion: 'buildlore.project-knowledge-wiki-list.v1', projectId,
        generationDigest: loaded.generation.generationDigest, cursor: end < 3 ? cursorFor(end) : null, total: 3,
        pages: mappings.slice(start, end).map((mapping) => ({ pageId: mapping.pageId, role: mapping.role,
          path: `wiki/buildlore-hierarchy/${mapping.role}.md`,
          title: loaded.generation.pages.find((p) => p.role === mapping.role)?.title ?? invalid() })), egress: 'none' };
    },
    async read(projectId, pageRef) {
      const loaded = await load(projectId);
      if (!loaded) return null;
      const mapping = loaded.extension.pageMappings.find((m) => [m.pageId, m.role, `${m.role}.md`,
        `wiki/buildlore-hierarchy/${m.role}.md`, `buildlore-hierarchy/${m.role}.md`].includes(pageRef));
      if (!mapping) invalid();
      const page = loaded.generation.pages.find((p) => p.role === mapping.role);
      if (!page) invalid();
      return pageView(loaded.generation, page, mapping.pageId);
    },
    async citations(projectId, pageRef) {
      const page = await reader.read(projectId, pageRef);
      if (!page) return null;
      return { schemaVersion: 'buildlore.project-knowledge-wiki-citations.v1', projectId,
        generationDigest: page.generationDigest, pageId: page.pageId, role: page.role,
        claims: page.claims, facts: page.facts, evidence: page.evidence, egress: 'none' };
    },
    async evidence(projectId, expectedGeneration, evidenceId) {
      const loaded = await load(projectId);
      if (!loaded || loaded.generation.generationDigest !== expectedGeneration) invalid();
      return loaded.generation.evidence.find((e) => e.evidenceId === evidenceId) ?? invalid();
    },
    async search(projectId, query, mode, intent = 'auto') {
      const loaded = await load(projectId);
      if (!loaded) return null;
      await screen(projectId, query, loaded.generation.snapshot.sanitizerPolicyDigest);
      const result = searchApprovedWikiLexicalV3(loaded.publication.projection.corpus,
        { projectId, query, intent, mode: mode === 'graph' ? 'graph' : 'lexical' },
        createKnowledgeRankingSignals(loaded.extension, loaded.publication.projection.corpus));
      const basis = { ...result, schemaVersion: 'buildlore.project-knowledge-search.v1',
        requestedMode: mode, generationDigest: loaded.generation.generationDigest,
        corpusDigest: loaded.publication.projection.corpus.corpusDigest,
        fallback: mode === 'hybrid' || mode === 'semantic'
          ? { reasonCode: 'project-knowledge-semantic-index-unavailable', effectiveMode: 'lexical' } : null,
        hits: result.hits.map((hit) => {
          const mapping = loaded.extension.pageMappings.find((m) => m.pageId === hit.locator.pageId) ?? invalid();
          const page = loaded.generation.pages.find((p) => p.role === mapping.role) ?? invalid();
          const view = pageView(loaded.generation, page, mapping.pageId);
          // The hierarchy's overview contains reviewed child summaries. Expose
          // their original pages and fact state instead of pretending the text
          // is a claim in the named overview Markdown.
          const inheritedClaims = mapping.role === 'overview' ? loaded.generation.pages.filter((p) => p.role !== 'overview').map((child) => {
            const childMapping = loaded.extension.pageMappings.find((m) => m.role === child.role) ?? invalid();
            const childView = pageView(loaded.generation, child, childMapping.pageId);
            const claim = child.sections[0]?.claims[0] ?? invalid();
            const facts = childView.facts.filter((fact) => claim.factIds.includes(fact.id));
            return { pageId: childMapping.pageId, role: child.role, claim, facts,
              evidence: childView.evidence.filter((e) => facts.some((fact) => fact.evidenceIds.includes(e.evidenceId))) };
          }) : [];
          return { ...hit, role: mapping.role, claims: view.claims, facts: view.facts, evidence: view.evidence, inheritedClaims };
        }), egress: 'none' };
      return { ...basis, resultDigest: digest(basis) };
    },
  };
  return Object.freeze(reader);
}
