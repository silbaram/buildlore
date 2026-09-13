import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { addProject } from '../src/knowledge/index.js';
import { digestHierarchyValue } from '../src/compiler/hierarchy/contracts.js';
import { createLocalEmbeddingProvider } from '../src/retrieval/embedding/index.js';
import { createFlatFileVectorIndex } from '../src/retrieval/vector-index/index.js';
import { createApprovedWikiHybridRetrievalV3 } from '../src/retrieval/hybrid.js';
import { projectApprovedWikiSemanticText, type ApprovedWikiRetrievalCorpusV1 } from '../src/retrieval/hierarchical.js';
import { createLocalWikiOperator } from '../src/retrieval/local-wiki-operator.js';
import { KNOWLEDGE_SEMANTIC_RELEVANCE_V2 } from '../src/retrieval/semantic-relevance.js';
import { record, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { createProjectSecurityService, readSecurityPolicy } from '../src/sanitizer/index.js';
import { createKnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

interface Fixture {
  documents: Array<{ id: string; project: string; text: string }>;
  queries: Array<{ id: string; project: string; query: string; expected: string[] }>;
}
function corpusFor(fixture: Fixture, projectId: string): ApprovedWikiRetrievalCorpusV1 {
  const pages = fixture.documents.filter(d => d.project === projectId).map(d => {
    const citationId = `citation-${d.id}`, sourceId = `source-${d.id}`, body = `${d.text} [^${citationId}]`;
    return { childPageIds: [], meaningSignals: [], pageId: d.id, parentPageId: null, proposalDigest: digestHierarchyValue(d),
      relationPageIds: [], sections: [{ body, meaningSignals: [], citationLocators: [{ citationId, sourceId }],
        ...projectApprovedWikiSemanticText(body, d.id), sectionId: 'content' }], status: 'active' as const, summary: d.id, title: d.id };
  }).sort((a, b) => a.pageId < b.pageId ? -1 : 1);
  const basis = { generationDigest: digestHierarchyValue(fixture.documents), pages, projectId,
    schemaVersion: 'buildlore.approved-wiki-retrieval-corpus.v2' as const };
  return { ...basis, corpusDigest: digestHierarchyValue(basis) };
}

describe.runIf(process.env.BUILDLORE_RELEVANCE_MODEL_GATE === '1')('frozen corpus actual-model CLI/SDK route evaluation', () => {
  it('keeps target sections and refuses unrelated semantic candidates without changing labels', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json');
    const rows: unknown[] = []; const failures: string[] = [];
    try {
      const provider = createLocalEmbeddingProvider({ hubRoot: process.env.BUILDLORE_ACTUAL_MODEL_HUB_ROOT ?? process.cwd() });
      await provider.embedQuery('Initialize the pinned local model.');
      const identity = provider.activeIdentity(); if (!identity) throw new Error('Model identity unavailable.');
      const vectorIndex = createFlatFileVectorIndex(f.knowledgeRoot);
      const projects = new Set([f.projectId]);
      const files = (process.env.BUILDLORE_RELEVANCE_FIXTURES ?? 'semantic-relevance.json,semantic-relevance-calibration-v2.json,semantic-relevance-holdout-v2.json,semantic-relevance-holdout-v3.json').split(',');
      for (const file of files) {
        if (!/^[a-z0-9-]+\.json$/u.test(file)) throw new Error('Invalid fixture name.');
        const fixture = JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')) as Fixture;
        for (const projectId of new Set(fixture.documents.map(d => d.project))) {
          if (!projects.has(projectId)) { await addProject(f.knowledgeRoot, { projectId, displayName: projectId,
            sourceRepository: `https://example.test/${projectId}.git` }); projects.add(projectId); }
          await writeSecurityPolicy(f.knowledgeRoot, projectId, { capabilities: [] });
          const policy = await readSecurityPolicy(f.knowledgeRoot, projectId);
          const security = createProjectSecurityService({ knowledgeRoot: f.knowledgeRoot });
          const texts = [...fixture.documents.filter(d => d.project === projectId).map(d => d.text),
            ...fixture.queries.filter(q => q.project === projectId).map(q => q.query)];
          for (const body of texts) {
            const result = await security.prepareSource({ projectId, body, bodyDigest: sha256(body), sourceRevisionOrContentSha256: sha256(body), source: 'calibration.md', sourceKind: 'markdown' });
            expect(result.ok).toBe(true);
          }
          const corpus = corpusFor(fixture, projectId);
          await vectorIndex.buildFull({ projectId, corpus, provider, embeddingIdentity: identity, sanitizerPolicyDigest: policy.digest });
          const sdk = createApprovedWikiHybridRetrievalV3({ corpus, projectId, provider, vectorIndex,
            sanitizerPolicyDigest: policy.digest, filterLowRelevanceSemanticHits: true });
          const operator = { ...createLocalWikiOperator({ hubRoot: f.hubRoot, knowledgeRoot: f.knowledgeRoot, provider }), search: sdk.search.bind(sdk) };
          for (const query of fixture.queries.filter(q => q.project === projectId)) for (const mode of ['semantic', 'hybrid'] as const) {
            const data = await sdk.search({ projectId, query: query.query, mode, intent: 'current' });
            let stdout = '', stderr = '';
            const exitCode = await runCli(['search', '--project', projectId, '--query', query.query, '--mode', mode, '--intent', 'current', '--json'],
              { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, { cwd: f.hubRoot, localWiki: operator });
            const cli = record(JSON.parse(stdout) as unknown);
            expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' }); expect(cli.data).toEqual(data);
            expect(data.fallback).toBeNull(); expect(data.effectiveMode).toBe(mode);
            for (const hit of data.hits) {
              expect(hit.locator.projectId).toBe(projectId);
              expect(corpus.pages.some(p => p.pageId === hit.locator.pageId && p.sections.some(s => s.sectionId === hit.locator.sectionId))).toBe(true);
            }
            const pass = query.expected.length ? query.expected.every(id => data.hits.slice(0, 10).some(h => h.locator.pageId === id))
              : mode === 'semantic' ? data.hits.length === 0 : data.hits.every(hit => hit.channels.every(channel => channel.channel !== 'semantic'));
            rows.push({ fixture: file, projectId, queryId: query.id, mode, cliSdkEqual: true, pass, data });
            if (!pass) failures.push(`${file}:${query.id}:${mode}`);
          }
          await expect(sdk.search({ projectId: 'another-project', query: 'test query', mode: 'semantic' })).rejects.toThrow();
        }
      }
      const output = process.env.BUILDLORE_RELEVANCE_REPORT;
      if (output) await writeFile(output, JSON.stringify({ policy: KNOWLEDGE_SEMANTIC_RELEVANCE_V2, identity,
        scope: 'Actual local model, persisted flat-file index, SDK retrieval and in-process CLI through injected localWiki adapter; synthetic source support only. Default live project route verified separately.', rows, failures }, null, 2) + '\n', { flag: 'wx' });
      expect(failures).toEqual([]);
    } finally { await f.cleanup(); }
  }, 1800000);
});
