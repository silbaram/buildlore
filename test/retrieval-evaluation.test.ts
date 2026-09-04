import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalDigest,
  calculateMetrics,
  createRetrievalEvaluation,
  parseFrozenRetrievalCorpus,
  parseRecordedMorphologyCandidate,
  parseRecordedSemanticFixture,
  parseRetrievalEvaluationReport,
  readBoundedJson,
  renderRetrievalEvaluationHuman,
  renderRetrievalEvaluationJson,
  RetrievalEvaluationError,
  type FrozenRetrievalCorpusV1,
} from '../src/retrieval/evaluation/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { addProject } from '../src/knowledge/index.js';
import { digestHierarchyValue } from '../src/compiler/index.js';
import {
  LLM_WIKI_QUALITY_CASES_V3,
  RETRIEVAL_FUSION_POLICY_V1,
  RETRIEVAL_RANKING_POLICY_V2,
  RETRIEVAL_RESULT_V3_SCHEMA_VERSION,
  createApprovedWikiHybridRetrievalV3,
  runLlmWikiRetrievalQualityV3,
  type HierarchicalRetrievalGoldV1,
  type LocalWikiRetrievalPortV3,
  type LocalWikiRetrievalRequestV3,
} from '../src/retrieval/index.js';
import {
  createEmbeddingIdentityV2,
  MULTILINGUAL_E5_SMALL_PROFILE,
  type EmbeddingProviderPort,
} from '../src/retrieval/embedding/index.js';
import { createFlatFileVectorIndex } from '../src/retrieval/vector-index/index.js';
import { llmWikiQualityFixture } from './helpers/llm-wiki-quality-fixture.js';

const root = join(process.cwd(), 'test', 'fixtures', 'retrieval', 'v1');

async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, name), 'utf8')) as unknown;
}

async function fixtures() {
  const corpus = parseFrozenRetrievalCorpus(await json('corpus.json'));
  return {
    corpus,
    morphology: parseRecordedMorphologyCandidate(await json('morphology.json'), corpus),
    semantic: parseRecordedSemanticFixture(await json('semantic.json'), corpus),
  };
}

function qualityVectorFor(text: string): Float32Array {
  const vector = new Float32Array(384);
  const normalized = Array.from(text.normalize('NFC').toLowerCase())
    .filter((character) => !/\s/u.test(character));
  for (let index = 0; index < normalized.length; index += 1) {
    const token = `${normalized[index] ?? ''}${normalized[index + 1] ?? ''}`;
    const digest = createHash('sha256').update(token, 'utf8').digest();
    const component = ((digest[0] ?? 0) * 256 + (digest[1] ?? 0)) % vector.length;
    vector[component] = (vector[component] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}

function qualityCandidate(
  expectedByQuery: ReturnType<typeof llmWikiQualityFixture>['expectedByQuery'],
  embeddingIdentityDigest: `sha256:${string}`,
  overrides: ReadonlyMap<string, string> = new Map(),
): LocalWikiRetrievalPortV3 {
  return Object.freeze({
    search(request: LocalWikiRetrievalRequestV3) {
      const qualityCase = LLM_WIKI_QUALITY_CASES_V3.find((candidate) =>
        candidate.text === request.query);
      if (qualityCase === undefined) throw new Error('Unexpected quality query.');
      const selectedQueryId = overrides.get(qualityCase.queryId) ?? qualityCase.queryId;
      const expected = expectedByQuery.get(selectedQueryId);
      if (expected === undefined) throw new Error('Expected quality locator is missing.');
      return Promise.resolve(Object.freeze({
        effectiveChannels: Object.freeze(['lexical', 'graph', 'semantic'] as const),
        effectiveIntent: qualityCase.intent,
        effectiveMode: 'hybrid' as const,
        egress: 'none' as const,
        fallback: null,
        fusionPolicy: RETRIEVAL_FUSION_POLICY_V1,
        hits: Object.freeze([Object.freeze({
          baseScore: 0.1,
          channels: Object.freeze([
            Object.freeze({ channel: 'lexical' as const, contribution: 0.03, rank: 1, score: 1 }),
            Object.freeze({ channel: 'graph' as const, contribution: 0.03, rank: 1, score: 1 }),
            Object.freeze({ channel: 'semantic' as const, contribution: 0.04, rank: 1, score: 1 }),
          ]),
          chunkId: `chunk-${digestHierarchyValue(qualityCase.queryId).slice('sha256:'.length)}`,
          diversificationReason: 'primary-distinct-groups' as const,
          finalScore: 0.1,
          locator: Object.freeze({
            citationIds: Object.freeze([expected.citationId]),
            pageId: expected.pageId,
            projectId: request.projectId,
            sectionId: expected.sectionId,
            sourceIds: Object.freeze([expected.sourceId]),
          }),
          matchedEvidence: Object.freeze([]),
          meaningAdjustment: Object.freeze({
            authority: 0,
            evidenceKind: 0,
            lifecycle: 0,
            reasonCodes: Object.freeze([]),
            total: 0,
          }),
          rank: 1,
          score: 0.1,
          scoreComponents: Object.freeze({ combinedScore: 0.1 }),
          scoreKind: 'rrf-v1' as const,
          title: expected.title,
        })]),
        identity: Object.freeze({
          embeddingIdentityDigest,
          indexGenerationId: `generation-${digestHierarchyValue('quality-generation-id')
            .slice('sha256:'.length)}`,
          indexManifestDigest: digestHierarchyValue('quality-index'),
        }),
        intentReasonCodes: Object.freeze([
          qualityCase.intent === 'current' ? 'explicit-current' as const : 'explicit-historical' as const,
        ]),
        projectId: request.projectId,
        providerUsed: 'local-in-process' as const,
        rankingPolicy: RETRIEVAL_RANKING_POLICY_V2,
        requestedIntent: qualityCase.intent,
        requestedMode: 'hybrid' as const,
        schemaVersion: RETRIEVAL_RESULT_V3_SCHEMA_VERSION,
      }));
    },
  });
}

describe('provider-free retrieval evaluation', () => {
  it('executes the fixed eight-query gate against a corpus-bound retrieval port', async () => {
    const fixture = JSON.parse(await readFile(
      new URL('./fixtures/retrieval/v2/hierarchical-gold.json', import.meta.url),
      'utf8',
    )) as HierarchicalRetrievalGoldV1;
    const embeddingIdentity = createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, [
      { basename: 'config.json', bytes: 655, role: 'model-config', sha256: `sha256:${'1'.repeat(64)}` },
      {
        basename: 'onnx/model.onnx',
        bytes: 470_268_510,
        role: 'model',
        sha256: 'sha256:ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
      },
      {
        basename: 'tokenizer.json',
        bytes: 17_082_730,
        role: 'tokenizer',
        sha256: 'sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
      },
      {
        basename: 'tokenizer_config.json', bytes: 443, role: 'tokenizer-config',
        sha256: `sha256:${'4'.repeat(64)}`,
      },
    ]);
    let tokenCountCalls = 0;
    const provider: EmbeddingProviderPort = Object.freeze({
      activeIdentity: () => embeddingIdentity,
      countDocumentTokens(texts: readonly string[]) {
        tokenCountCalls += 1;
        return Promise.resolve(Object.freeze({
          egress: 'none' as const,
          identity: embeddingIdentity,
          maximumTokens: 512 as const,
          providerUsed: 'local-in-process' as const,
          tokenCounts: Object.freeze(texts.map((text) => Math.max(1, [...text].length))),
        }));
      },
      embedDocuments(texts: readonly string[]) {
        return Promise.resolve(Object.freeze({
          egress: 'none' as const,
          identity: embeddingIdentity,
          providerUsed: 'local-in-process' as const,
          truncated: Object.freeze(texts.map(() => false)),
          vectors: Object.freeze(texts.map(qualityVectorFor)),
        }));
      },
      embedQuery(text: string) {
        return Promise.resolve(Object.freeze({
          egress: 'none' as const,
          identity: embeddingIdentity,
          providerUsed: 'local-in-process' as const,
          truncated: Object.freeze([false]),
          vectors: Object.freeze([qualityVectorFor(text)]),
        }));
      },
      inspectCapabilities: () => Object.freeze({
        adapterKind: 'transformers-js' as const,
        device: 'cpu' as const,
        egress: 'none' as const,
        maximumBatchSize: 32 as const,
        maximumQueryUtf8Bytes: 4096 as const,
        networkAllowed: false as const,
        providerUsed: 'local-in-process' as const,
      }),
      readiness: () => Object.freeze({ activeIdentity: embeddingIdentity, state: 'ready' as const }),
    });
    const temporaryRoot = await mkdtemp(join(process.cwd(), '.test-tmp-llm-quality-'));
    try {
      const knowledgeRoot = join(temporaryRoot, 'knowledge');
      await mkdir(knowledgeRoot);
      await addProject(knowledgeRoot, {
        displayName: fixture.corpus.projectId,
        projectId: fixture.corpus.projectId,
        sourceRepository: `https://example.test/${fixture.corpus.projectId}.git`,
      });
      const vectorIndex = createFlatFileVectorIndex(knowledgeRoot);
      const actual = createApprovedWikiHybridRetrievalV3({
        corpus: fixture.corpus,
        projectId: fixture.corpus.projectId,
        provider,
        sanitizerPolicyDigest: `sha256:${'f'.repeat(64)}`,
        vectorIndex,
      });
      const requests: LocalWikiRetrievalRequestV3[] = [];
      const candidate = Object.freeze({
        async search(request: LocalWikiRetrievalRequestV3) {
          requests.push(request);
          return actual.search(request);
        },
      });
      const first = await runLlmWikiRetrievalQualityV3({
        candidate,
        corpus: fixture.corpus,
        mode: 'lexical',
        projectId: fixture.corpus.projectId,
        provider,
      });

      expect(LLM_WIKI_QUALITY_CASES_V3).toHaveLength(8);
      expect(LLM_WIKI_QUALITY_CASES_V3.map((qualityCase) => qualityCase.text)).toEqual([
        '프로젝트 구성',
        'BuildLore는 무엇인가',
        'Wiki 생성과 activation 과정',
        '비밀정보 sanitizer 동작 방식',
        'semantic index 생성과 검색 방법',
        '현재 지원되는 source 종류',
        '실패 후 복구와 검증 기록',
        '특정 iteration 또는 Gate의 과거 결정',
      ]);
      expect(requests.map((request) => request.query)).toEqual(
        LLM_WIKI_QUALITY_CASES_V3.map((qualityCase) => qualityCase.text),
      );
      expect(requests.map((request) => request.intent)).toEqual(
        LLM_WIKI_QUALITY_CASES_V3.map((qualityCase) => qualityCase.intent),
      );
      expect(requests.every((request) => request.topK === 5)).toBe(true);
      expect(first).toMatchObject({
        corpusDigest: fixture.corpus.corpusDigest,
        overallPassed: false,
        providerIdentityDigest: embeddingIdentity.identityDigest,
        queryCount: 8,
      });
      expect(tokenCountCalls).toBeGreaterThan(0);
      expect(first.aggregate.candidate.contextUtf8Bytes).toBeGreaterThan(0);
      expect(first.aggregate.candidate.providerTokenCount).toBeGreaterThan(0);

      await expect(runLlmWikiRetrievalQualityV3({
        candidate,
        corpus: fixture.corpus,
        mode: 'hybrid',
        projectId: fixture.corpus.projectId,
        provider,
      })).rejects.toThrow('LLM_WIKI_RETRIEVAL_EVAL_INVALID');

      const qualityFixture = llmWikiQualityFixture();
      await addProject(knowledgeRoot, {
        displayName: qualityFixture.corpus.projectId,
        projectId: qualityFixture.corpus.projectId,
        sourceRepository: `https://example.test/${qualityFixture.corpus.projectId}.git`,
      });
      const qualityVectorIndex = createFlatFileVectorIndex(knowledgeRoot);
      await qualityVectorIndex.buildFull({
        corpus: qualityFixture.corpus,
        embeddingIdentity,
        projectId: qualityFixture.corpus.projectId,
        provider,
        sanitizerPolicyDigest: `sha256:${'f'.repeat(64)}`,
      });
      const qualityActual = createApprovedWikiHybridRetrievalV3({
        corpus: qualityFixture.corpus,
        projectId: qualityFixture.corpus.projectId,
        provider,
        sanitizerPolicyDigest: `sha256:${'f'.repeat(64)}`,
        vectorIndex: qualityVectorIndex,
      });
      const qualityReports = [];
      for (const mode of ['lexical', 'graph', 'semantic', 'hybrid'] as const) {
        qualityReports.push(await runLlmWikiRetrievalQualityV3({
          candidate: qualityActual,
          corpus: qualityFixture.corpus,
          mode,
          projectId: qualityFixture.corpus.projectId,
          provider,
        }));
      }
      expect(qualityReports.map((report) => report.mode)).toEqual([
        'lexical', 'graph', 'semantic', 'hybrid',
      ]);
      expect(qualityReports.map((report) => report.candidateIdentity.mode)).toEqual([
        'lexical', 'graph', 'semantic', 'hybrid',
      ]);
      const hybrid = qualityReports[3];
      if (hybrid === undefined) throw new Error('Hybrid quality report is missing.');
      expect(hybrid.queryResults.filter((result) => !result.passed)).toEqual([]);
      expect(hybrid.overallPassed).toBe(true);
      expect(hybrid.candidateIdentity).toMatchObject({
        embeddingIdentityDigest: embeddingIdentity.identityDigest,
        mode: 'hybrid',
      });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }

  });

  it('passes a grounded eight-query candidate and rejects an unrelated same-kind hit', async () => {
    const fixture = llmWikiQualityFixture();
    const embeddingIdentity = createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, [
      { basename: 'config.json', bytes: 1, role: 'model-config', sha256: `sha256:${'1'.repeat(64)}` },
      { basename: 'onnx/model.onnx', bytes: 1, role: 'model', sha256: `sha256:${'2'.repeat(64)}` },
      { basename: 'tokenizer.json', bytes: 1, role: 'tokenizer', sha256: `sha256:${'3'.repeat(64)}` },
      {
        basename: 'tokenizer_config.json', bytes: 1, role: 'tokenizer-config',
        sha256: `sha256:${'4'.repeat(64)}`,
      },
    ]);
    const provider: EmbeddingProviderPort = Object.freeze({
      activeIdentity: () => embeddingIdentity,
      countDocumentTokens(texts: readonly string[]) {
        return Promise.resolve(Object.freeze({
          egress: 'none' as const,
          identity: embeddingIdentity,
          maximumTokens: 512 as const,
          providerUsed: 'local-in-process' as const,
          tokenCounts: Object.freeze(texts.map((text) => Math.max(1, [...text].length))),
        }));
      },
      embedDocuments: () => Promise.reject(new Error('not used by quality fixture')),
      embedQuery: () => Promise.reject(new Error('not used by quality fixture')),
      inspectCapabilities: () => Object.freeze({
        adapterKind: 'transformers-js' as const,
        device: 'cpu' as const,
        egress: 'none' as const,
        maximumBatchSize: 32 as const,
        maximumQueryUtf8Bytes: 4096 as const,
        networkAllowed: false as const,
        providerUsed: 'local-in-process' as const,
      }),
      readiness: () => Object.freeze({ activeIdentity: embeddingIdentity, state: 'ready' as const }),
    });
    const passed = await runLlmWikiRetrievalQualityV3({
      candidate: qualityCandidate(fixture.expectedByQuery, embeddingIdentity.identityDigest),
      corpus: fixture.corpus,
      mode: 'hybrid',
      projectId: fixture.corpus.projectId,
      provider,
    });

    expect(passed.overallPassed).toBe(true);
    expect(passed.queryResults.every((result) => result.passed)).toBe(true);
    expect(passed).toMatchObject({
      baselineIdentity: {
        mode: 'graph',
        retrievalVersion: 'approved-wiki-legacy-raw-v1',
      },
      candidateIdentity: {
        embeddingIdentityDigest: embeddingIdentity.identityDigest,
        mode: 'hybrid',
      },
      mode: 'hybrid',
    });
    expect(passed.baselineIdentity.identityDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(passed.candidateIdentity.identityDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const misrouted = await runLlmWikiRetrievalQualityV3({
      candidate: qualityCandidate(
        fixture.expectedByQuery,
        embeddingIdentity.identityDigest,
        new Map([['secret-sanitizer', 'semantic-index']]),
      ),
      corpus: fixture.corpus,
      mode: 'hybrid',
      projectId: fixture.corpus.projectId,
      provider,
    });
    expect(misrouted.queryResults.find((result) => result.queryId === 'secret-sanitizer'))
      .toMatchObject({ passed: false, candidate: { recallAt5: 0 } });
    expect(misrouted.overallPassed).toBe(false);

    const invalidCandidate = qualityCandidate(
      fixture.expectedByQuery,
      embeddingIdentity.identityDigest,
    );
    await expect(runLlmWikiRetrievalQualityV3({
      candidate: Object.freeze({
        async search(request: LocalWikiRetrievalRequestV3) {
          const result = await invalidCandidate.search(request);
          const firstHit = result.hits[0];
          if (firstHit === undefined) return result;
          return Object.freeze({
            ...result,
            hits: Object.freeze([Object.freeze({ ...firstHit, chunkId: 'chunk-invalid' })]),
          });
        },
      }),
      corpus: fixture.corpus,
      mode: 'hybrid',
      projectId: fixture.corpus.projectId,
      provider,
    })).rejects.toThrow('LLM_WIKI_RETRIEVAL_EVAL_INVALID');

    const stalePageId = 'quality/what-is-buildlore';
    const staleSourceId = fixture.expectedByQuery.get('what-is-buildlore')?.sourceId;
    if (staleSourceId === undefined) throw new Error('Expected quality source is missing.');
    const stalePages = Object.freeze(fixture.corpus.pages.map((page) => page.pageId !== stalePageId
      ? page
      : Object.freeze({
          ...page,
          meaningSignals: Object.freeze((page.meaningSignals ?? []).map((meaning) =>
            meaning.sourceId !== staleSourceId ? meaning : Object.freeze({
              ...meaning,
              authority: 'historical' as const,
              lifecycle: 'superseded' as const,
            }))),
          sections: Object.freeze(page.sections.map((section) => Object.freeze({
            ...section,
            meaningSignals: Object.freeze((section.meaningSignals ?? []).map((meaning) =>
              meaning.sourceId !== staleSourceId ? meaning : Object.freeze({
                ...meaning,
                authority: 'historical' as const,
                lifecycle: 'superseded' as const,
              }))),
          }))),
        })));
    const staleBasis = Object.freeze({
      generationDigest: fixture.corpus.generationDigest,
      pages: stalePages,
      projectId: fixture.corpus.projectId,
      schemaVersion: fixture.corpus.schemaVersion,
    });
    const staleCorpus = Object.freeze({
      ...staleBasis,
      corpusDigest: digestHierarchyValue(staleBasis),
    });
    const staleCurrent = await runLlmWikiRetrievalQualityV3({
      candidate: qualityCandidate(fixture.expectedByQuery, embeddingIdentity.identityDigest),
      corpus: staleCorpus,
      mode: 'hybrid',
      projectId: staleCorpus.projectId,
      provider,
    });
    expect(staleCurrent.queryResults.find((result) => result.queryId === 'what-is-buildlore'))
      .toMatchObject({ candidate: { recallAt5: 0 }, passed: false });
  });

  it('[V9-V-05][V9-V-07][V9-V-08][V9-V-09][V10-V-15] validates categories, thresholds, hashes, and recorded identities', async () => {
    const value = await fixtures();
    expect(parseRetrievalEvaluationReport(await json('baseline.json')).overallPassed).toBe(true);
    expect(new Set(value.corpus.queries.map((query) => query.category))).toEqual(new Set([
      'code-symbol-korean',
      'korean-exact',
      'korean-spacing-morphology',
      'korean-synonym',
      'korean-to-english',
    ]));
    expect(value.corpus.hashes).toEqual({
      corpusSha256: 'sha256:4c656f7a1ee332097542ae084ba77e48014e82206df7204b92dbcf4ca0e37012',
      judgementSha256: 'sha256:a0d8767ce717b4d86d8813e92d63c14fad2e11bf761f0243daaae7ca1b6851b3',
      querySha256: 'sha256:056ed130e87a6eaf16130ad483bf1612827c03be41d193f964ea8e023143fe6c',
    });
  });

  it('[V9-V-05][V10-V-01][V10-V-12] fails closed across the frozen input negative matrix', async () => {
    const raw = await json('corpus.json') as FrozenRetrievalCorpusV1;
    expect(() => parseFrozenRetrievalCorpus({ ...raw, extra: true })).toThrowError(
      RetrievalEvaluationError,
    );
    expect(() => parseFrozenRetrievalCorpus({
      ...raw,
      hashes: { ...raw.hashes, querySha256: `sha256:${'0'.repeat(64)}` },
    })).toThrowError(RetrievalEvaluationError);

    const corpus = parseFrozenRetrievalCorpus(raw);
    const semantic = await json('semantic.json') as Record<string, unknown>;
    const rankings = semantic.rankings as Array<Record<string, unknown>>;
    expect(() => parseRecordedSemanticFixture({
      ...semantic,
      rankings: [
        { ...rankings[0], pageIds: ['concepts/not-in-corpus'] },
        ...rankings.slice(1),
      ],
    }, corpus)).toThrowError(RetrievalEvaluationError);

    const mutate = (
      change: (copy: Record<string, unknown>) => void,
      hashPart?: 'documents' | 'judgements' | 'queries',
    ): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
      change(copy);
      if (hashPart !== undefined) {
        const hashKey = hashPart === 'documents'
          ? 'corpusSha256'
          : hashPart === 'queries' ? 'querySha256' : 'judgementSha256';
        (copy.hashes as Record<string, unknown>)[hashKey] = canonicalDigest(copy[hashPart]);
      }
      return copy;
    };
    const invalidCorpora = [
      mutate((copy) => {
        const queries = copy.queries as Array<Record<string, unknown>>;
        queries[0] = { ...queries[0], category: 'unknown-category' };
      }, 'queries'),
      mutate((copy) => {
        const documents = copy.documents as Array<Record<string, unknown>>;
        documents[1] = { ...documents[1], evidenceId: documents[0]?.evidenceId };
      }, 'documents'),
      mutate((copy) => {
        const queries = copy.queries as Array<Record<string, unknown>>;
        queries[1] = { ...queries[1], queryId: queries[0]?.queryId };
      }, 'queries'),
      mutate((copy) => {
        const judgements = copy.judgements as Array<Record<string, unknown>>;
        copy.judgements = judgements.filter((entry) => entry.queryId !== 'q-exact-auth');
      }, 'judgements'),
      mutate((copy) => {
        const documents = copy.documents as Array<Record<string, unknown>>;
        documents[0] = { ...documents[0], body: 'x'.repeat(8_193) };
      }, 'documents'),
      mutate((copy) => {
        const queries = copy.queries as Array<Record<string, unknown>>;
        queries[0] = { ...queries[0], text: 'unsafe\u0000query' };
      }, 'queries'),
      { ...raw, schemaVersion: 'buildlore.retrieval-corpus.v2' },
    ];
    for (const invalid of invalidCorpora) {
      expect(() => parseFrozenRetrievalCorpus(invalid)).toThrowError(RetrievalEvaluationError);
    }
  });

  it('[V9-V-23][V10-V-12] rejects no-leak violations even with recomputed hashes', async () => {
    const raw = await json('corpus.json') as FrozenRetrievalCorpusV1;
    for (const mutation of [
      (copy: FrozenRetrievalCorpusV1) => {
        (copy.documents[0] as { body: string }).body = 'https://private.example/token';
      },
      (copy: FrozenRetrievalCorpusV1) => {
        (copy.documents[0] as unknown as { sourceRefs: string[] }).sourceRefs = [
          'repo@v1:/home/person/private.md',
        ];
      },
      (copy: FrozenRetrievalCorpusV1) => {
        (copy.documents[0] as { body: string }).body =
          `unsafe ${`sk-proj-${'A'.repeat(24)}`} /root/private-data`;
      },
    ]) {
      const copy = JSON.parse(JSON.stringify(raw)) as FrozenRetrievalCorpusV1;
      mutation(copy);
      (copy.hashes as { corpusSha256: `sha256:${string}` }).corpusSha256 =
        canonicalDigest(copy.documents);
      expect(() => parseFrozenRetrievalCorpus(copy)).toThrowError(RetrievalEvaluationError);
    }

    const queryCopy = JSON.parse(JSON.stringify(raw)) as FrozenRetrievalCorpusV1;
    (queryCopy.queries[0] as { text: string }).text = 'HTTPS://private.example/query';
    (queryCopy.hashes as { querySha256: `sha256:${string}` }).querySha256 =
      canonicalDigest(queryCopy.queries);
    expect(() => parseFrozenRetrievalCorpus(queryCopy)).toThrowError(RetrievalEvaluationError);
  });

  it('[V10-V-14] normalizes equivalent corpus collection ordering before hashing', async () => {
    const raw = await json('corpus.json') as FrozenRetrievalCorpusV1;
    const documents = [...raw.documents].reverse();
    const queries = [...raw.queries].reverse();
    const judgements = [...raw.judgements].reverse();
    const reversed: FrozenRetrievalCorpusV1 = {
      ...raw,
      documents,
      hashes: {
        corpusSha256: canonicalDigest(documents),
        judgementSha256: canonicalDigest(judgements),
        querySha256: canonicalDigest(queries),
      },
      judgements,
      queries,
    };

    expect(reversed.hashes).toEqual(raw.hashes);
    expect(parseFrozenRetrievalCorpus(reversed)).toEqual(parseFrozenRetrievalCorpus(raw));
  });

  it('[V9-V-20][V10-V-01][V10-V-14] requires one canonical UTF-8 representation', async () => {
    for (const name of ['corpus.json', 'semantic.json', 'morphology.json', 'baseline.json']) {
      const raw = await readFile(join(root, name), 'utf8');
      expect(raw).toBe(serializeCanonicalJson(JSON.parse(raw) as unknown));
      await expect(readBoundedJson(join(root, name))).resolves.toBeDefined();
    }

    const temporaryRoot = await mkdtemp(join(process.cwd(), '.test-tmp-retrieval-codec-'));
    try {
      const path = join(temporaryRoot, 'invalid.json');
      for (const raw of [
        '\ufeff{}\n',
        '{"a":1,"a":2}\n',
        '{"a":1}\n',
      ]) {
        await writeFile(path, raw, 'utf8');
        await expect(readBoundedJson(path)).rejects.toBeInstanceOf(RetrievalEvaluationError);
      }
      await writeFile(path, Buffer.from([0xc3, 0x28]));
      await expect(readBoundedJson(path)).rejects.toBeInstanceOf(RetrievalEvaluationError);

      const outsideRoot = await mkdtemp(join(process.cwd(), '.test-tmp-retrieval-outside-'));
      try {
        await writeFile(join(outsideRoot, 'baseline.json'),
          serializeCanonicalJson(await json('baseline.json')), 'utf8');
        await symlink(outsideRoot, join(temporaryRoot, 'linked'), 'dir');
        await expect(readBoundedJson(join(temporaryRoot, 'linked', 'baseline.json'), {
          confinementRoot: temporaryRoot,
        })).rejects.toBeInstanceOf(RetrievalEvaluationError);
      } finally {
        await rm(outsideRoot, { force: true, recursive: true });
      }
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('[V9-V-06] matches hand-calculated Recall@5 and MRR edge cases', async () => {
    const { corpus } = await fixtures();
    const rankings = new Map(corpus.queries.map((query) => [query.queryId, [] as string[]]));
    rankings.set('q-exact-auth', ['concepts/security', 'guides/auth-recovery']);
    rankings.set('q-exact-cache', ['guides/cache-invalidation']);
    const exact = calculateMetrics(corpus, rankings, 'lexical')
      .find((metric) => metric.category === 'korean-exact');
    expect(exact).toMatchObject({ mrr: 0.75, queryCount: 2, recallAt5: 1 });

    const multipleRelevantCorpus: FrozenRetrievalCorpusV1 = {
      ...corpus,
      judgements: [
        ...corpus.judgements,
        { evidenceId: 'doc-security', queryId: 'q-exact-auth', relevance: 1 },
      ],
    };
    const edgeRankings = new Map(corpus.queries.map((query) =>
      [query.queryId, [] as string[]] as const));
    edgeRankings.set('q-exact-auth', [
      'guides/auth-recovery',
      'guides/cache-invalidation',
      'guides/deployment',
      'concepts/observability',
      'concepts/retry-policy',
      'concepts/security',
    ]);
    const edge = calculateMetrics(multipleRelevantCorpus, edgeRankings, 'lexical')
      .find((metric) => metric.category === 'korean-exact');
    expect(edge).toMatchObject({ mrr: 0.5, queryCount: 2, recallAt5: 0.25 });
  });

  it('[V9-V-08][V9-V-09][V9-V-10][V9-V-20][V10-V-02][V10-V-15] emits an auditable byte-stable positive report', async () => {
    const input = await fixtures();
    const evaluate = () => {
      let tick = 0;
      return createRetrievalEvaluation({
        architecture: 'test-arch',
        clock: () => tick++,
        nodeVersion: 'v24.test',
        operatingSystem: 'test-os',
        sampleCount: 3,
        warmupCount: 1,
      }).evaluate(input);
    };
    const first = evaluate();
    const second = evaluate();
    expect(first.overallPassed).toBe(true);
    expect(first.candidateComparisonPassed).toBe(true);
    expect(first.candidates).toEqual(expect.arrayContaining([
      {
        candidateId: 'v8-unicode-word',
        dependencyImpact: 'none',
        decision: 'rejected',
        deterministicOffline: true,
        identity: 'buildlore-v8-unicode-word-v1',
        indexBytes: first.candidates[0]?.indexBytes,
        indexBytesUnavailableReason: null,
        licenseId: 'BuildLore-internal',
        metrics: first.candidates[0]?.metrics,
        reasonCodes: ['spacing-morphology-recall-lower'],
        sourceEvidenceIds: ['LOCAL-2'],
      },
      {
        candidateId: 'buildlore-unicode-hangul-ngram',
        dependencyImpact: 'none',
        decision: 'selected',
        deterministicOffline: true,
        identity: first.selectedStrategy.strategyDigest,
        indexBytes: first.candidates[1]?.indexBytes,
        indexBytesUnavailableReason: null,
        licenseId: 'BuildLore-internal',
        metrics: first.candidates[1]?.metrics,
        reasonCodes: ['deterministic', 'offline', 'no-new-dependency', 'quality-gates-passed'],
        sourceEvidenceIds: ['LOCAL-4', 'WEB-3'],
      },
      {
        candidateId: 'garu-ko',
        dependencyImpact: 'deferred-wasm-model',
        decision: 'recorded-only',
        deterministicOffline: true,
        identity: '0.1.0/recorded.2026.08',
        indexBytes: null,
        indexBytesUnavailableReason: 'recorded-ranking-has-no-index-artifact',
        licenseId: 'MIT',
        metrics: first.candidates[2]?.metrics,
        reasonCodes: ['runtime-dependency-deferred', 'recorded-candidate-only'],
        sourceEvidenceIds: ['WEB-5'],
      },
    ]));
    expect(first.candidates[0]?.indexBytes).toEqual(expect.any(Number));
    expect(first.candidates[1]?.indexBytes).toEqual(expect.any(Number));
    expect(first.candidates[0]?.metrics.some((metric) => metric.mode === 'lexical')).toBe(true);
    expect(first.performance).toMatchObject({
      architecture: 'test-arch',
      latencyMilliseconds: { maximum: 1, median: 1, minimum: 1 },
      nodeVersion: 'v24.test',
      operatingSystem: 'test-os',
    });
    expect(renderRetrievalEvaluationJson(first)).toBe(renderRetrievalEvaluationJson(second));
    expect(renderRetrievalEvaluationHuman(first)).toContain(
      'candidate buildlore-unicode-hangul-ngram: selected; dependency=none',
    );
    expect(renderRetrievalEvaluationHuman(first)).toContain('performance: comparable; reasons=none');
    expect(parseRetrievalEvaluationReport(
      JSON.parse(renderRetrievalEvaluationJson(first)) as unknown,
    )).toEqual(first);
    expect(first.metrics).toContainEqual(expect.objectContaining({
      category: 'korean-exact',
      mode: 'lexical',
      mrr: 1,
      recallAt5: 1,
    }));
    expect(first.metrics).toContainEqual(expect.objectContaining({
      category: 'korean-to-english',
      mode: 'semantic',
      recallAt5: 1,
    }));

    const stableEvaluation = (baseline?: ReturnType<typeof evaluate>) => {
      let tick = 0;
      return createRetrievalEvaluation({
        architecture: 'stable-arch',
        clock: () => tick++,
        cpuModelClass: `sha256:${'4'.repeat(64)}`,
        logicalCpuCount: 4,
        nodeVersion: 'v24.stable',
        operatingSystem: 'stable-os',
        sampleCount: 3,
        timerKind: 'injected',
        warmupCount: 1,
      }).evaluate({ ...input, ...(baseline === undefined ? {} : { baseline }) });
    };
    const stableBaseline = stableEvaluation();
    const stableCurrent = stableEvaluation(stableBaseline);
    expect(stableCurrent.performance).toMatchObject({ comparable: true, reasonCodes: [] });

    const matchingBaseline = createRetrievalEvaluation({
      architecture: 'test-arch',
      clock: () => 1,
      nodeVersion: 'v24.test',
      operatingSystem: 'test-os',
      sampleCount: 1,
      warmupCount: 0,
    }).evaluate({ ...input, baseline: first });
    expect(matchingBaseline.regression).toEqual({
      compatible: true,
      passed: true,
      reasonCodes: [],
    });
    expect(matchingBaseline.performance).toMatchObject({
      comparable: false,
      reasonCodes: ['runner-identity-incompatible'],
    });

    const incompatible = createRetrievalEvaluation({
      clock: () => 1,
      sampleCount: 1,
      warmupCount: 0,
    }).evaluate({
      ...input,
      baseline: {
        ...first,
        inputHashes: {
          ...first.inputHashes,
          querySha256: `sha256:${'0'.repeat(64)}`,
        },
      },
    });
    expect(incompatible).toMatchObject({
      overallPassed: false,
      regression: {
        compatible: false,
        passed: false,
        reasonCodes: ['evaluation-identity-incompatible'],
      },
    });
    const semanticSnapshotDrift = createRetrievalEvaluation({
      clock: () => 1,
      sampleCount: 1,
      warmupCount: 0,
    }).evaluate({
      ...input,
      baseline: {
        ...first,
        semanticFixtureId: 'recorded-semantic-v2',
      },
    });
    expect(semanticSnapshotDrift.regression).toEqual({
      compatible: false,
      passed: false,
      reasonCodes: ['evaluation-identity-incompatible'],
    });
  });

  it('[V9-V-21][V10-V-03] separates performance comparability from deterministic quality', async () => {
    const input = await fixtures();
    const baseline = parseRetrievalEvaluationReport(await json('baseline.json'));
    let tick = 0;
    const report = createRetrievalEvaluation({
      architecture: 'different-arch',
      clock: () => tick++,
      cpuModelClass: `sha256:${'2'.repeat(64)}`,
      logicalCpuCount: 8,
      nodeVersion: 'v24-different',
      operatingSystem: 'different-os',
      sampleCount: 3,
      timerKind: 'injected',
      warmupCount: 1,
    }).evaluate({ ...input, baseline });
    expect(report.performance).toMatchObject({
      comparable: false,
      reasonCodes: ['runner-identity-incompatible'],
    });
    expect(report.regression).toEqual({ compatible: true, passed: true, reasonCodes: [] });
    expect(report.overallPassed).toBe(true);

    expect(() => createRetrievalEvaluation({ sampleCount: 0 }).evaluate(input))
      .toThrowError(RetrievalEvaluationError);
    expect(() => createRetrievalEvaluation({ warmupCount: 101 }).evaluate(input))
      .toThrowError(RetrievalEvaluationError);
    expect(() => createRetrievalEvaluation({
      cpuModelClass: 'sha256:invalid',
    }).evaluate(input)).toThrowError(RetrievalEvaluationError);
    expect(() => createRetrievalEvaluation({
      architecture: 'https://private.example/runner',
    }).evaluate(input)).toThrowError(RetrievalEvaluationError);
    const timingAnomaly = createRetrievalEvaluation({
      clock: () => Number.NaN,
      sampleCount: 2,
      warmupCount: 0,
    }).evaluate(input);
    expect(timingAnomaly.performance).toMatchObject({
      comparable: false,
      latencyMilliseconds: null,
      reasonCodes: ['timing-samples-invalid'],
    });
  });

  it('[V9-V-22] detects a compatible quality regression without using performance variance', async () => {
    const input = await fixtures();
    let baselineTick = 0;
    const baseline = createRetrievalEvaluation({
      architecture: 'quality-arch',
      clock: () => baselineTick++,
      cpuModelClass: `sha256:${'5'.repeat(64)}`,
      logicalCpuCount: 2,
      nodeVersion: 'v24.quality',
      operatingSystem: 'quality-os',
      sampleCount: 2,
      timerKind: 'injected',
      warmupCount: 0,
    }).evaluate(input);
    const prior = JSON.parse(renderRetrievalEvaluationJson(baseline)) as Record<string, unknown>;
    const improve = (metrics: Array<Record<string, unknown>>): void => {
      const metric = metrics.find((entry) =>
        entry.mode === 'lexical' && entry.category === 'korean-to-english');
      if (metric === undefined) throw new Error('Expected lexical cross-lingual metric.');
      metric.mrr = 0.5;
      metric.recallAt5 = 0.5;
      metric.passed = true;
    };
    improve(prior.metrics as Array<Record<string, unknown>>);
    const candidates = prior.candidates as Array<Record<string, unknown>>;
    const selected = candidates.find((candidate) => candidate.decision === 'selected');
    if (selected === undefined) throw new Error('Expected selected candidate.');
    improve(selected.metrics as Array<Record<string, unknown>>);
    const acceptedBaseline = parseRetrievalEvaluationReport(prior);

    let currentTick = 0;
    const current = createRetrievalEvaluation({
      architecture: 'quality-arch',
      clock: () => currentTick++,
      cpuModelClass: `sha256:${'5'.repeat(64)}`,
      logicalCpuCount: 2,
      nodeVersion: 'v24.quality',
      operatingSystem: 'quality-os',
      sampleCount: 2,
      timerKind: 'injected',
      warmupCount: 0,
    }).evaluate({ ...input, baseline: acceptedBaseline });
    expect(current.performance.comparable).toBe(true);
    expect(current.regression).toEqual({
      compatible: true,
      passed: false,
      reasonCodes: ['quality-regression'],
    });
    expect(current.overallPassed).toBe(false);
  });

  it('[V10-V-04][V10-V-12] rejects duplicate and contradictory report summaries', async () => {
    const input = await fixtures();
    let tick = 0;
    const report = createRetrievalEvaluation({
      architecture: 'test-arch',
      clock: () => tick++,
      cpuModelClass: `sha256:${'3'.repeat(64)}`,
      logicalCpuCount: 2,
      nodeVersion: 'v24.test',
      operatingSystem: 'test-os',
      sampleCount: 1,
      timerKind: 'injected',
      warmupCount: 0,
    }).evaluate(input);
    const clone = (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    const invalidReports: Record<string, unknown>[] = [];

    const duplicateMetrics = clone();
    const metrics = duplicateMetrics.metrics as unknown[];
    duplicateMetrics.metrics = Array.from({ length: 15 }, () => metrics[0]);
    invalidReports.push(duplicateMetrics);

    const duplicateCandidates = clone();
    const candidates = duplicateCandidates.candidates as unknown[];
    duplicateCandidates.candidates = [candidates[1], candidates[1], candidates[2]];
    invalidReports.push(duplicateCandidates);

    const contradictedMetric = clone();
    const contradictedMetrics = contradictedMetric.metrics as Array<Record<string, unknown>>;
    contradictedMetrics[0] = { ...contradictedMetrics[0], passed: false };
    invalidReports.push(contradictedMetric);

    const contradictedOverall = clone();
    contradictedOverall.overallPassed = false;
    invalidReports.push(contradictedOverall);

    const contradictedCandidate = clone();
    contradictedCandidate.candidateComparisonPassed = false;
    contradictedCandidate.overallPassed = false;
    invalidReports.push(contradictedCandidate);

    const contradictedPerformance = clone();
    contradictedPerformance.performance = {
      ...(contradictedPerformance.performance as Record<string, unknown>),
      comparable: true,
      reasonCodes: ['runner-identity-incompatible'],
    };
    invalidReports.push(contradictedPerformance);

    const oversizedQueryCount = clone();
    const oversizedMetrics = oversizedQueryCount.metrics as Array<Record<string, unknown>>;
    oversizedMetrics[0] = { ...oversizedMetrics[0], queryCount: 501 };
    invalidReports.push(oversizedQueryCount);

    for (const invalid of invalidReports) {
      expect(() => parseRetrievalEvaluationReport(invalid)).toThrowError(
        RetrievalEvaluationError,
      );
    }
  });

  it('[V10-V-01] publishes recursively closed schemas matching codec sections', async () => {
    const corpusSchema = JSON.parse(await readFile(
      join(process.cwd(), 'schemas', 'retrieval-corpus.schema.json'),
      'utf8',
    )) as Record<string, unknown>;
    const reportSchema = JSON.parse(await readFile(
      join(process.cwd(), 'schemas', 'retrieval-evaluation.schema.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(corpusSchema).toMatchObject({ additionalProperties: false });
    expect(reportSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        candidates: { items: { $ref: '#/$defs/candidate' } },
        embeddingFixtureIdentity: { $ref: '#/$defs/embeddingIdentity' },
        performance: { $ref: '#/$defs/performance' },
        selectedStrategy: { $ref: '#/$defs/strategy' },
      },
    });
    expect(reportSchema.$defs).toMatchObject({
      candidate: { additionalProperties: false },
      embeddingIdentity: { additionalProperties: false },
      metric: { additionalProperties: false },
      performance: { additionalProperties: false },
      strategy: { additionalProperties: false },
    });
    const requirePortablePatterns = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(requirePortablePatterns);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'pattern' && typeof entry === 'string') {
          expect(() => new RegExp(entry, 'u')).not.toThrow();
        } else {
          requirePortablePatterns(entry);
        }
      }
    };
    requirePortablePatterns(corpusSchema);
    requirePortablePatterns(reportSchema);
  });
});
