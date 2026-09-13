import { KNOWLEDGE_SEMANTIC_RELEVANCE_V2 } from '../src/retrieval/semantic-relevance.js';
import { latestKnowledgeGeneration } from '../src/retrieval/project-knowledge-authority.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture,
  type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { knowledgeSemanticProvider } from './helpers/knowledge-semantic-provider.js';
import * as embedding from '../src/retrieval/embedding/index.js';
import { createLocalWikiOperator } from '../src/retrieval/local-wiki-operator.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { createApprovedWikiProjectionStore } from '../src/retrieval/approved-corpus-store.js';
import { record } from '../src/knowledge/project-knowledge/guards.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { createRepositoryWriterLease } from '../src/knowledge/repository-writer-lease.js';
import { createFlatFileVectorIndex } from '../src/retrieval/vector-index/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map(f => f.cleanup()));
});

describe('project knowledge semantic search through the default CLI route', () => {
  it.each(['generic-md-json', 'optional-p2a'] as const)('uses real index retrieval and preserves support for %s', async sample => {
    const f = await createKnowledgeWorkflowFixture(sample);
    fixtures.push(f);
    const calls: string[] = [];
    const provider = knowledgeSemanticProvider(calls);
    const factory = vi.spyOn(embedding, 'createLocalEmbeddingProvider').mockReturnValue(provider);
    const purpose = await f.json('semantic-purpose.json', {
      schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
      projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en',
    });
    const activate = async () => {
      expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      const start = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
      expect(start).toMatchObject({ exitCode: 0 });
      const completed = await submitWorkflowFixture(f, start.data);
      expect(await f.cli(completed.approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
    };
    await activate();
    const search = (mode: string, query = 'local') => f.cli(['search', '--project', f.projectId, '--mode', mode, '--query', query]);
    const missing = await search('semantic');
    expect(missing.exitCode).not.toBe(0);
    expect(JSON.stringify(missing)).toContain('semantic-index-unavailable');
    expect(await search('hybrid')).toMatchObject({ exitCode: 0, data: {
      effectiveMode: 'lexical-graph', fallback: { reasonCode: 'semantic-index-unavailable' }, providerUsed: 'none',
    } });
    expect(calls).toEqual([]);

    const identity = provider.activeIdentity();
    if (!identity) throw new Error('Missing fixture identity.');
    const operator = createLocalWikiOperator({ hubRoot: f.hubRoot, knowledgeRoot: f.knowledgeRoot,
      provider, embeddingIdentity: identity, repositoryLease: createRepositoryWriterLease() });
    const built = await operator.rebuildIndex({ projectId: f.projectId });
    expect(built.result.outcome).toBe('activated');
    const store = createApprovedWikiProjectionStore(f.knowledgeRoot);
    const authority = await store.readAuthority(f.projectId);
    const generation = authority.knowledgeGeneration && latestKnowledgeGeneration(authority.knowledgeGeneration);
    if (!generation) throw new Error('Missing fixture generation.');
    const projection = await store.read(f.projectId);
    calls.length = 0;
    for (const mode of ['semantic', 'hybrid']) {
      const result = await search(mode, 'orchard nebula'); // no lexical match in either fixture
      expect(result).toMatchObject({ exitCode: 0, data: {
        schemaVersion: 'buildlore.project-knowledge-search.v2', supportScope: 'matched-section',
        requestedMode: mode, effectiveMode: mode, fallback: null, providerUsed: 'local-in-process',
        generationDigest: generation.generationDigest, corpusDigest: projection.corpus.corpusDigest,
        identity: { indexGenerationId: expect.any(String) as unknown, indexManifestDigest: expect.any(String) as unknown },
      } });
      const hits = result.data.hits;
      if (!Array.isArray(hits)) throw new Error('Missing search hits.');
      expect(hits.length).toBeGreaterThan(0);
      for (const raw of hits as unknown[]) {
        const hit = record(raw);
        expect(hit).toMatchObject({ locator: { projectId: f.projectId },
          channels: expect.arrayContaining([expect.objectContaining({ channel: 'semantic' })]) as unknown,
          facts: expect.arrayContaining([expect.objectContaining({ projectId: f.projectId, reviewStatus: 'accepted' })]) as unknown,
          evidence: expect.arrayContaining([expect.objectContaining({ projectId: f.projectId })]) as unknown,
          meaningAdjustment: { authority: 0.001, lifecycle: 0.003 },
        });
        const page = generation.pages.find(p => p.role === hit.role);
        const section = page?.sections.find((_, i) => record(hit.locator).sectionId === `knowledge-${String(i)}`);
        expect(hit.claims).toEqual(section?.claims);
      }
    }
    expect(calls).toEqual(['query', 'query']);
    expect(factory).toHaveBeenCalledWith({ hubRoot: f.hubRoot });
    factory.mockClear();
    const reusableReader = createKnowledgeWikiReader(f.knowledgeRoot, { hubRoot: f.hubRoot });
    for (const mode of ['semantic', 'hybrid'] as const) {
      expect(await reusableReader.search(f.projectId, 'orchard nebula', mode))
        .toMatchObject({ effectiveMode: mode, fallback: null });
    }
    expect(factory).toHaveBeenCalledTimes(1);

    const index = { ...createFlatFileVectorIndex(f.knowledgeRoot) };
    const searchIndex = index.searchExactDistinctSections.bind(index);
    const weak = vi.spyOn(index, 'searchExactDistinctSections').mockImplementation(async (...args) => {
      const result = await searchIndex(...args);
      return { ...result, hits: result.hits.map(hit => ({ ...hit, score: 0.809999 })) };
    });
    const filteredReader = createKnowledgeWikiReader(f.knowledgeRoot, { hubRoot: f.hubRoot, provider, vectorIndex: index });
    expect(await filteredReader.search(f.projectId, 'local', 'semantic')).toMatchObject({
      effectiveMode: 'semantic', fallback: null, hits: [],
      semanticRelevancePolicy: { sameScriptMinimumCosine: KNOWLEDGE_SEMANTIC_RELEVANCE_V2.sameScriptMinimumCosine },
    });
    const hybrid = await filteredReader.search(f.projectId, 'local', 'hybrid');
    if (!hybrid || !Array.isArray(hybrid.hits)) throw new Error('Missing hybrid results.');
    expect(hybrid.hits.length).toBeGreaterThan(0);
    for (const hit of hybrid.hits as unknown[]) {
      expect(record(hit).channels).not.toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'semantic' })]));
    }
    weak.mockImplementation(async (...args) => {
      const result = await searchIndex(...args);
      return { ...result, hits: result.hits.map(hit => ({ ...hit, score: -2 })) };
    });
    await expect(filteredReader.search(f.projectId, 'local', 'semantic')).rejects.toThrow();
    weak.mockRestore();
    calls.length = 0;
    factory.mockClear();
    expect(await search('lexical')).toMatchObject({ exitCode: 0, data: { effectiveMode: 'lexical' } });
    expect(await search('graph')).toMatchObject({ exitCode: 0, data: { effectiveMode: 'lexical-graph' } });
    expect(factory).not.toHaveBeenCalled();
    const unsafe = `ghp_${'1234567890'.repeat(3)}123456`;
    const blocked = await search('semantic', unsafe);
    expect(blocked.exitCode).not.toBe(0);
    expect(JSON.stringify(blocked)).not.toContain(unsafe);
    expect(calls).toEqual([]);
    const foreign = f.projectId === 'parcel' ? 'lantern' : 'parcel';
    expect((await f.cli(['search', '--project', foreign, '--mode', 'semantic', '--query', 'local'])).exitCode).not.toBe(0);

    await f.setRevision('R2');
    await activate();
    const stale = await search('semantic');
    expect(stale.exitCode).not.toBe(0);
    expect(JSON.stringify(stale)).toContain('semantic-index-stale');
    expect(await search('hybrid')).toMatchObject({ exitCode: 0, data: {
      effectiveMode: 'lexical-graph', fallback: { reasonCode: 'semantic-index-stale' },
    } });
    expect(calls).toEqual([]);
    await operator.rebuildIndex({ projectId: f.projectId });
    expect(await search('semantic')).toMatchObject({ exitCode: 0, data: { effectiveMode: 'semantic', fallback: null } });

    // Rotation while awaiting the provider must not attach the old generation's support.
    const reader = createKnowledgeWikiReader(f.knowledgeRoot, { hubRoot: f.hubRoot, provider });
    // Another request may evict the single-entry cache while this query awaits
    // the model. Compare verified content identity, not JS object identity.
    vi.spyOn(provider, 'embedQuery').mockImplementationOnce(async text => {
      await expect(reader.read('unregistered', 'overview')).rejects.toThrow();
      return knowledgeSemanticProvider().embedQuery(text);
    });
    expect(await reader.search(f.projectId, 'local', 'semantic')).toMatchObject({
      effectiveMode: 'semantic', fallback: null,
    });
    const policyPath = join(f.knowledgeRoot, 'projects', f.projectId, 'security-policy.json');
    const policyBytes = await readFile(policyPath);
    vi.spyOn(provider, 'embedQuery').mockImplementationOnce(async text => {
      const result = await knowledgeSemanticProvider().embedQuery(text);
      await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { classification: 'internal' });
      return result;
    });
    await expect(reader.search(f.projectId, 'local', 'semantic')).rejects.toThrow();
    await writeFile(policyPath, policyBytes);
    vi.spyOn(provider, 'embedQuery').mockImplementationOnce(async text => {
      const result = await knowledgeSemanticProvider().embedQuery(text);
      await writeFile(join(f.knowledgeRoot, 'projects', f.projectId,
        '.llmwiki/buildlore-hierarchy/approved-authority.json'), serializeCanonicalJson(authority));
      return result;
    });
    await expect(reader.search(f.projectId, 'local', 'semantic')).rejects.toThrow();
  }, 60_000);
});
