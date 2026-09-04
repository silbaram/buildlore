import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CurrentSessionGenerationExchangeV1 } from '../src/compiler/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { addProject } from '../src/knowledge/index.js';
import {
  APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION,
  createApprovedWikiProjectionStore,
  createLocalWikiOperator,
  type ApprovedWikiAuthorityV1,
  type ApprovedWikiProjectionStorePort,
  type ApprovedWikiRetrievalProjectionV1,
} from '../src/retrieval/index.js';
import type {
  EmbeddingProviderPort,
  LocalModelBindingPort,
} from '../src/retrieval/embedding/index.js';
import { readSecurityPolicy } from '../src/sanitizer/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import {
  createApprovedAuthorityFixture,
  createSharedCitationApprovedAuthorityFixture,
} from './helpers/hierarchical-authority-fixture.js';

const PROJECT_ID = 'active-wiki-read';
const roots: string[] = [];

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

function noCallProvider(calls: string[]): EmbeddingProviderPort {
  function unexpected(method: string): never {
    calls.push(method);
    throw new Error('active Wiki reads must not call an embedding provider');
  }
  function unexpectedPromise(method: string): Promise<never> {
    calls.push(method);
    return Promise.reject(new Error('active Wiki reads must not call an embedding provider'));
  }
  return Object.freeze({
    activeIdentity: () => unexpected('activeIdentity'),
    countDocumentTokens: () => unexpectedPromise('countDocumentTokens'),
    embedDocuments: () => unexpectedPromise('embedDocuments'),
    embedQuery: () => unexpectedPromise('embedQuery'),
    inspectCapabilities: () => unexpected('inspectCapabilities'),
    readiness: () => unexpected('readiness'),
  });
}

function noCallLocalModels(calls: string[]): LocalModelBindingPort {
  function unexpected(method: string): Promise<never> {
    calls.push(method);
    return Promise.reject(new Error('active Wiki reads must not inspect a local model'));
  }
  return Object.freeze({
    bind: () => unexpected('bind'),
    inspect: () => unexpected('inspect'),
    verify: () => unexpected('verify'),
  });
}

interface ActiveWikiFixture {
  readonly authority: ApprovedWikiAuthorityV1;
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly projection: ApprovedWikiRetrievalProjectionV1 | null;
  readonly store: ApprovedWikiProjectionStorePort;
}

async function fixture(publish = true, sharedCitation = false): Promise<ActiveWikiFixture> {
  const hubRoot = await mkdtemp(join(process.cwd(), '.test-tmp-active-wiki-read-'));
  roots.push(hubRoot);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: PROJECT_ID,
    projectId: PROJECT_ID,
    sourceRepository: `https://example.test/${PROJECT_ID}.git`,
  });
  const policy = await readSecurityPolicy(knowledgeRoot, PROJECT_ID);
  const authority = sharedCitation
    ? createSharedCitationApprovedAuthorityFixture(PROJECT_ID, policy.digest)
    : createApprovedAuthorityFixture(PROJECT_ID, policy.digest);
  const store = createApprovedWikiProjectionStore(knowledgeRoot);
  const projection = publish
    ? await store.publish({ authority, projectId: PROJECT_ID })
    : null;
  return Object.freeze({ authority, hubRoot, knowledgeRoot, projection, store });
}

function operator(
  item: ActiveWikiFixture,
  calls: string[],
  corpusStore: ApprovedWikiProjectionStorePort = item.store,
) {
  return createLocalWikiOperator({
    corpusStore,
    hubRoot: item.hubRoot,
    knowledgeRoot: item.knowledgeRoot,
    provider: noCallProvider(calls),
  });
}

function requiredProjection(item: ActiveWikiFixture): ApprovedWikiRetrievalProjectionV1 {
  if (item.projection === null) throw new Error('test projection is unavailable');
  return item.projection;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('active hierarchical Wiki reads', () => {
  it('lists deterministic bounded pages with an opaque projection-bound cursor', async () => {
    const item = await fixture();
    const projection = requiredProjection(item);
    const calls: string[] = [];
    const wiki = operator(item, calls);

    const first = await wiki.listPages({ limit: 1, projectId: PROJECT_ID });
    const repeated = await wiki.listPages({ limit: 1, projectId: PROJECT_ID });
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      egress: 'none',
      generationDigest: projection.corpus.generationDigest,
      projectId: PROJECT_ID,
      providerUsed: 'none',
      total: 2,
    });
    expect(first.cursor).toMatch(/^cursor-[a-f0-9]{64}$/u);
    expect(first.cursor).not.toContain(PROJECT_ID);
    expect(first.cursor).not.toContain(first.pages[0]?.pageId ?? 'unavailable-page');
    expect(first.cursor).not.toContain(projection.corpus.generationDigest);

    if (first.cursor === null) throw new Error('test pagination cursor is unavailable');
    const second = await wiki.listPages({
      cursor: first.cursor,
      limit: 1,
      projectId: PROJECT_ID,
    });
    await expect(wiki.listPages({
      cursor: first.cursor,
      limit: 1,
      projectId: PROJECT_ID,
    })).resolves.toEqual(second);
    expect(second.cursor).toBeNull();
    expect([...first.pages, ...second.pages].map((page) => page.pageId)).toEqual(
      projection.corpus.pages.map((page) => page.pageId).sort(),
    );
    const modelCalls: string[] = [];
    await expect(createLocalWikiOperator({
      hubRoot: item.hubRoot,
      knowledgeRoot: item.knowledgeRoot,
      localModels: noCallLocalModels(modelCalls),
    }).listPages({ projectId: PROJECT_ID })).resolves.toMatchObject({
      providerUsed: 'none',
      total: 2,
    });
    expect(modelCalls).toEqual([]);
    await expect(wiki.listPages({ limit: 101, projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID' });
    const unknownCursor = `cursor-${'0'.repeat(64)}`;
    const cursorError = await wiki.listPages({
      cursor: unknownCursor,
      projectId: PROJECT_ID,
    }).then(() => null, (error: unknown) => error);
    expect(cursorError).toMatchObject({ code: 'LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID' });
    expect(JSON.stringify(cursorError)).not.toContain(unknownCursor);
    expect(calls).toEqual([]);
  });

  it('reads a raw hierarchy page with exact active projection fields and no provider', async () => {
    const item = await fixture();
    const projection = requiredProjection(item);
    const page = projection.corpus.pages[0];
    if (page === undefined) throw new Error('test page is unavailable');
    const calls: string[] = [];
    const wiki = operator(item, calls);

    await expect(wiki.readPage({ pageId: page.pageId, projectId: PROJECT_ID }))
      .resolves.toEqual(expect.objectContaining({
        childPageIds: page.childPageIds,
        corpusDigest: projection.corpus.corpusDigest,
        generationDigest: projection.corpus.generationDigest,
        pageId: page.pageId,
        parentPageId: page.parentPageId,
        projectId: PROJECT_ID,
        proposalDigest: page.proposalDigest,
        relationPageIds: page.relationPageIds,
        sections: page.sections.map((section) => ({
          body: section.body,
          citationLocators: section.citationLocators,
          sectionId: section.sectionId,
        })),
        status: 'active',
        summary: page.summary,
        title: page.title,
      }));
    await expect(wiki.readPage({ pageId: 'page-invalid', projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID' });
    await expect(wiki.readPage({
      pageId: `page-${'0'.repeat(64)}`,
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: 'LOCAL_WIKI_RETRIEVAL_CONTRACT_INVALID' });
    await expect(wiki.pageCitations({
      pageId: page.pageId,
      projectId: PROJECT_ID,
      sectionId: 'missing-section',
    })).rejects.toMatchObject({ code: 'LOCAL_WIKI_RETRIEVAL_CONTRACT_INVALID' });
    expect(calls).toEqual([]);
  });

  it('returns exact rendered local and authorized direct-child citation anchors', async () => {
    const item = await fixture();
    const projection = requiredProjection(item);
    const rootOwner = item.authority.ownershipGraph.pages.find((page) =>
      page.parentPageId === null);
    if (rootOwner === undefined) throw new Error('test root owner is unavailable');
    const rootPage = projection.corpus.pages.find((page) => page.pageId === rootOwner.pageId);
    const rootPack = item.authority.finalization.evidencePacks.find((pack) =>
      pack.pageId === rootOwner.pageId);
    const rootExchange = item.authority.finalization.generationHandoffs
      .map((handoff) => handoff.exchange as CurrentSessionGenerationExchangeV1)
      .find((exchange) => exchange.pageId === rootOwner.pageId);
    if (rootPage === undefined || rootPack === undefined || rootExchange === undefined) {
      throw new Error('test root authority is unavailable');
    }
    const anchorById = new Map(item.authority.finalization.evidencePacks
      .flatMap((pack) => pack.units.map((unit) => [unit.citation.citationId, unit.citation] as const)));
    const expectedIds = [...new Set(rootPage.sections.flatMap((section) =>
      section.citationLocators.map((locator) => locator.citationId)))].sort();
    expect(expectedIds).toEqual(expect.arrayContaining([
      ...rootPack.units.map((unit) => unit.citation.citationId),
      ...rootExchange.request.approvedChildSummaries.flatMap((summary) => summary.citationIds),
    ]));
    const expected = expectedIds.map((citationId) => {
      const anchor = anchorById.get(citationId);
      if (anchor === undefined) throw new Error('test citation anchor is unavailable');
      return {
        citationId: anchor.citationId,
        quoteDigest: anchor.quoteDigest,
        range: anchor.range,
        sourceId: anchor.sourceId,
        sourceRef: anchor.sourceRef,
        sourceRevision: anchor.sourceRevision,
      };
    });
    const calls: string[] = [];
    const wiki = operator(item, calls);

    const result = await wiki.pageCitations({ pageId: rootPage.pageId, projectId: PROJECT_ID });
    expect(result).toMatchObject({
      generationDigest: projection.corpus.generationDigest,
      pageId: rootPage.pageId,
      projectId: PROJECT_ID,
      providerUsed: 'none',
      sectionId: null,
    });
    expect(result.citations).toEqual(expected);
    expect(result.citations).toHaveLength(2);
    const sectionId = rootPage.sections[0]?.sectionId;
    if (sectionId === undefined) throw new Error('test root section is unavailable');
    await expect(wiki.pageCitations({
      pageId: rootPage.pageId,
      projectId: PROJECT_ID,
      sectionId,
    })).resolves.toMatchObject({ citations: expected });
    expect(calls).toEqual([]);
  });

  it('accepts one canonical citation anchor reused exactly across two page packs', async () => {
    const item = await fixture(true, true);
    const projection = requiredProjection(item);
    const firstPack = item.authority.finalization.evidencePacks[0];
    const secondPack = item.authority.finalization.evidencePacks[1];
    if (firstPack === undefined || secondPack === undefined) {
      throw new Error('shared citation test packs are unavailable');
    }
    const sharedCitationId = firstPack.units.map((unit) => unit.citation.citationId)
      .find((citationId) => secondPack.units.some((unit) =>
        unit.citation.citationId === citationId));
    expect(sharedCitationId).toBeDefined();
    const rootPage = projection.corpus.pages.find((page) => page.parentPageId === null);
    const anchor = firstPack.units.find((unit) =>
      unit.citation.citationId === sharedCitationId)?.citation;
    if (rootPage === undefined || anchor === undefined) {
      throw new Error('shared citation test authority is unavailable');
    }
    const calls: string[] = [];

    const result = await operator(item, calls).pageCitations({
      pageId: rootPage.pageId,
      projectId: PROJECT_ID,
    });
    expect(result).toMatchObject({
      providerUsed: 'none',
    });
    expect(result.citations.filter((citation) => citation.citationId === sharedCitationId))
      .toEqual([{
        citationId: anchor.citationId,
        quoteDigest: anchor.quoteDigest,
        range: anchor.range,
        sourceId: anchor.sourceId,
        sourceRef: anchor.sourceRef,
        sourceRevision: anchor.sourceRevision,
      }]);
    expect(calls).toEqual([]);
  });

  it('fails closed for absent, wrong-project, invalid, and policy-stale projections', async () => {
    const empty = await fixture(false);
    const emptyCalls: string[] = [];
    await expect(operator(empty, emptyCalls).listPages({ projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'LOCAL_WIKI_PROJECTION_UNAVAILABLE' });
    expect(emptyCalls).toEqual([]);

    const item = await fixture();
    const projection = requiredProjection(item);
    const wrongProjectId = 'active-wiki-other';
    await addProject(item.knowledgeRoot, {
      displayName: wrongProjectId,
      projectId: wrongProjectId,
      sourceRepository: `https://example.test/${wrongProjectId}.git`,
    });
    const wrongStore = Object.freeze({
      ...item.store,
      read: () => Promise.resolve(projection),
    }) satisfies ApprovedWikiProjectionStorePort;
    await expect(operator(item, [], wrongStore).listPages({ projectId: wrongProjectId }))
      .rejects.toMatchObject({ code: 'LOCAL_WIKI_RETRIEVAL_PROJECT_MISMATCH' });

    const invalidStore = Object.freeze({
      ...item.store,
      read: () => Promise.resolve({
        ...projection,
        corpus: { ...projection.corpus, pages: [] },
      }),
    }) satisfies ApprovedWikiProjectionStorePort;
    await expect(operator(item, [], invalidStore).listPages({ projectId: PROJECT_ID }))
      .rejects.toMatchObject({ code: 'LOCAL_WIKI_PROJECTION_INVALID' });

    await writeSecurityPolicy(item.knowledgeRoot, PROJECT_ID, { classification: 'internal' });
    await expect(operator(item, []).readPage({
      pageId: projection.corpus.pages[0]?.pageId ?? 'page-invalid',
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: 'LOCAL_WIKI_PROJECTION_INVALID' });
  });

  it('rejects conflicting authority anchors and unrelated projected citation injection', async () => {
    const item = await fixture();
    const projection = requiredProjection(item);
    const rootOwner = item.authority.ownershipGraph.pages.find((page) =>
      page.parentPageId === null);
    const leafOwner = item.authority.ownershipGraph.pages.find((page) =>
      page.parentPageId !== null);
    if (rootOwner === undefined || leafOwner === undefined) {
      throw new Error('test hierarchy owners are unavailable');
    }
    const conflicting = JSON.parse(JSON.stringify(item.authority)) as ApprovedWikiAuthorityV1;
    const firstCitation = conflicting.finalization.evidencePacks[0]?.units[0]?.citation;
    const secondCitation = conflicting.finalization.evidencePacks[1]?.units[0]?.citation;
    if (firstCitation === undefined || secondCitation === undefined) {
      throw new Error('test citation anchors are unavailable');
    }
    (secondCitation as { citationId: string }).citationId = firstCitation.citationId;
    const conflictingStore = Object.freeze({
      ...item.store,
      readAuthority: () => Promise.resolve(conflicting),
    }) satisfies ApprovedWikiProjectionStorePort;
    const conflictCalls: string[] = [];
    const conflictError = await operator(item, conflictCalls, conflictingStore).pageCitations({
      pageId: rootOwner.pageId,
      projectId: PROJECT_ID,
    }).then(() => null, (error: unknown) => error);
    expect(conflictError).toMatchObject({ code: 'LOCAL_WIKI_PROJECTION_INVALID' });
    expect(JSON.stringify(conflictError)).not.toContain(firstCitation.citationId);
    expect(conflictCalls).toEqual([]);

    const injectedCorpus = JSON.parse(JSON.stringify(projection.corpus)) as
      ApprovedWikiRetrievalProjectionV1['corpus'];
    const leafPage = injectedCorpus.pages.find((page) => page.pageId === leafOwner.pageId);
    const rootCitation = item.authority.finalization.evidencePacks
      .find((pack) => pack.pageId === rootOwner.pageId)?.units[0]?.citation;
    const locator = leafPage?.sections[0]?.citationLocators[0];
    if (leafPage === undefined || rootCitation === undefined || locator === undefined) {
      throw new Error('test citation injection input is unavailable');
    }
    (locator as { citationId: string; sourceId: string }).citationId = rootCitation.citationId;
    (locator as { citationId: string; sourceId: string }).sourceId = rootCitation.sourceId;
    const { corpusDigest: ignoredCorpusDigest, ...corpusBasis } = injectedCorpus;
    void ignoredCorpusDigest;
    const corpus = Object.freeze({ ...corpusBasis, corpusDigest: digest(corpusBasis) });
    const projectionBasis = Object.freeze({
      corpus,
      projectId: PROJECT_ID,
      sanitizerPolicyDigest: projection.sanitizerPolicyDigest,
      schemaVersion: APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION,
    });
    const injectedProjection = Object.freeze({
      ...projectionBasis,
      projectionDigest: digest(projectionBasis),
    });
    const injectedStore = Object.freeze({
      ...item.store,
      read: () => Promise.resolve(injectedProjection),
    }) satisfies ApprovedWikiProjectionStorePort;
    const injectionCalls: string[] = [];
    await expect(operator(item, injectionCalls, injectedStore).pageCitations({
      pageId: leafOwner.pageId,
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: 'LOCAL_WIKI_PROJECTION_INVALID' });
    expect(injectionCalls).toEqual([]);
  });
});
