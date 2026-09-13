import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createLocalEmbeddingProvider } from '../src/retrieval/embedding/index.js';
import { KNOWLEDGE_SEMANTIC_RELEVANCE_V1, KNOWLEDGE_SEMANTIC_RELEVANCE_V2, semanticCandidateMinimumCosine } from '../src/retrieval/semantic-relevance.js';

describe('model-scoped topical semantic candidate guard', () => {
  it('preserves cross-script retrieval and handles mixed technical prose', () => {
    expect(semanticCandidateMinimumCosine('recursive source collection', 'The source manifest selects directories.')).toBe(KNOWLEDGE_SEMANTIC_RELEVANCE_V2.sameScriptMinimumCosine);
    expect(semanticCandidateMinimumCosine('수집할 폴더 설정', 'The source manifest selects directories.')).toBe(KNOWLEDGE_SEMANTIC_RELEVANCE_V2.crossScriptMinimumCosine);
    expect(semanticCandidateMinimumCosine('How are notes stored?', '메모는 Markdown 파일로 저장하고 Git 이력으로 관리한다.')).toBe(KNOWLEDGE_SEMANTIC_RELEVANCE_V2.crossScriptMinimumCosine);
    expect(semanticCandidateMinimumCosine('검색은 어떻게 해?', 'project-knowledge reader는 semantic/hybrid 검색을 local index로 수행한다.')).toBe(KNOWLEDGE_SEMANTIC_RELEVANCE_V2.sameScriptMinimumCosine);
    expect(semanticCandidateMinimumCosine('12345', '???')).toBe(KNOWLEDGE_SEMANTIC_RELEVANCE_V2.sameScriptMinimumCosine);
    expect(KNOWLEDGE_SEMANTIC_RELEVANCE_V1.scope).toBe('topical-candidates-not-answerability');
  });
});

interface RelevanceFixture {
  documents: Array<{ id: string; project: string; text: string }>;
  queries: Array<{ id: string; split: string; project: string; query: string; expected: string[] }>;
}

describe.runIf(process.env.BUILDLORE_RELEVANCE_MODEL_GATE === '1')('actual local model relevance regression', () => {
  it('retains bilingual relevant documents and abstains on out-of-domain questions in two generic projects', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/semantic-relevance.json', import.meta.url), 'utf8')) as RelevanceFixture;
    const provider = createLocalEmbeddingProvider({ hubRoot: process.env.BUILDLORE_ACTUAL_MODEL_HUB_ROOT ?? process.cwd() });
    const documents = await provider.embedDocuments(fixture.documents.map(d => d.text));
    expect(documents.truncated).not.toContain(true);
    for (const q of fixture.queries) {
      const result = await provider.embedQuery(q.query);
      expect(result.truncated).toEqual([false]);
      const query = result.vectors[0];
      if (!query) throw new Error('Missing test query vector.');
      const admitted = fixture.documents.filter((d, index) => {
        if (d.project !== q.project) return false;
        const vector = documents.vectors[index];
        if (!vector) throw new Error('Missing test document vector.');
        const cosine = vector.reduce((sum, value, i) => sum + value * (query[i] ?? 0), 0);
        return cosine >= semanticCandidateMinimumCosine(q.query, d.text);
      }).map(d => d.id);
      if (q.expected.length === 0) expect(admitted, q.id).toEqual([]);
      else for (const id of q.expected) expect(admitted, q.id).toContain(id);
    }
  }, 180_000);
});
