import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { addProject } from '../src/knowledge/index.js';
import {
  createApprovedWikiHybridRetrieval,
  createApprovedWikiRetrieval,
  type HierarchicalRetrievalGoldV1,
  type RetrievalResultV2,
} from '../src/retrieval/index.js';
import {
  createLocalEmbeddingProvider,
} from '../src/retrieval/embedding/index.js';
import {
  resolveVerifiedLocalModelBinding,
  withVerifiedLocalModelDirectory,
} from '../src/retrieval/embedding/model-binding.js';
import {
  exactCosineTopKForTest,
  type ExactCosineCandidate,
} from '../src/retrieval/vector-index/service.js';
import {
  createFlatFileVectorIndex,
  SEMANTIC_INDEX_LIMITS,
  type RetrievalChunkV1,
} from '../src/retrieval/vector-index/index.js';

const enabled = process.env.BUILDLORE_ACTUAL_MODEL_GATE === '1';
const profileId = 'multilingual-e5-small';

interface ReferenceTensor {
  readonly data: ArrayLike<bigint | number>;
  readonly dims: readonly number[];
}

type ReferenceTokenizer = (
  texts: readonly string[],
  options: Readonly<{
    readonly max_length: 512;
    readonly padding: true;
    readonly truncation: true;
  }>,
) => Readonly<Record<string, ReferenceTensor>>;

interface TransformersReferenceModule {
  readonly AutoTokenizer: {
    from_pretrained(
      directory: string,
      options: Readonly<{ readonly local_files_only: true }>,
    ): Promise<ReferenceTokenizer>;
  };
  readonly env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    cacheDir: string | null;
    fetch: () => Promise<never>;
    localModelPath: string;
    useBrowserCache: boolean;
    useFSCache: boolean;
    useWasmCache: boolean;
  };
}

interface OnnxSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  release(): Promise<void>;
  run(feeds: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, ReferenceTensor>>>;
}

interface OnnxReferenceModule {
  readonly InferenceSession: {
    create(
      path: string,
      options: Readonly<{ readonly executionProviders: readonly ['cpu'] }>,
    ): Promise<OnnxSession>;
  };
  readonly Tensor: new (
    type: 'int64',
    data: BigInt64Array,
    dims: readonly number[],
  ) => unknown;
}

function int64Data(data: ArrayLike<bigint | number>): BigInt64Array {
  const result = new BigInt64Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index];
    if (value === undefined) throw new Error('REFERENCE_INPUT_INVALID');
    result[index] = typeof value === 'bigint' ? value : BigInt(value);
  }
  return result;
}

function normalize(vector: Float32Array): Float32Array {
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('REFERENCE_VECTOR_INVALID');
  return Float32Array.from(vector, (value) => value / norm);
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error('REFERENCE_VECTOR_INVALID');
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

function positiveQuality(
  results: readonly RetrievalResultV2[],
  questions: HierarchicalRetrievalGoldV1['questions'],
): Readonly<{ readonly mrr: number; readonly recallAt5: number }> {
  let reciprocalRanks = 0;
  let recalls = 0;
  let count = 0;
  questions.forEach((question, index) => {
    if (question.expected.length < 1) return;
    const result = results[index];
    if (result === undefined) throw new Error('ACTUAL_QUALITY_RESULT_MISSING');
    const expected = new Set(question.expected.map((locator) =>
      `${locator.pageId}\u0000${locator.sectionId}`));
    const ranks = result.hits.map((hit) =>
      `${hit.locator.pageId}\u0000${hit.locator.sectionId}`);
    const found = ranks.slice(0, 5).filter((key) => expected.has(key)).length;
    const first = ranks.findIndex((key) => expected.has(key));
    recalls += found / expected.size;
    reciprocalRanks += first < 0 ? 0 : 1 / (first + 1);
    count += 1;
  });
  return Object.freeze({ mrr: reciprocalRanks / count, recallAt5: recalls / count });
}

function benchmarkCandidates(vector: Float32Array): readonly ExactCosineCandidate[] {
  const citationLocators = Object.freeze([
    { citationId: 'citation-benchmark', sourceId: 'source-benchmark' },
  ]);
  return Object.freeze(Array.from({ length: SEMANTIC_INDEX_LIMITS.maximumChunks }, (_, index) => {
    const hexadecimal = index.toString(16).padStart(64, '0');
    const chunk: RetrievalChunkV1 = Object.freeze({
      schemaVersion: 'buildlore.retrieval-chunk.v2',
      projectId: 'benchmark',
      pageId: `pages/page-${index.toString().padStart(5, '0')}`,
      pageRevision: `sha256:${'1'.repeat(64)}`,
      sectionId: 'main',
      chunkId: `chunk-${hexadecimal}`,
      rowOrdinal: index,
      segmentOrdinal: 0,
      structureOrdinal: index,
      structureKind: 'paragraph',
      contentDigest: `sha256:${hexadecimal}`,
      utf8Bytes: 1,
      maximumTokens: 512,
      tokenCount: 1,
      tokenTruncated: false,
      chunkerDigest: `sha256:${'2'.repeat(64)}`,
      citationLocators,
      meaningSignals: Object.freeze([]),
      eligibility: 'eligible',
      skipReason: null,
    });
    return Object.freeze({ chunk, vector });
  }));
}

async function independentOnnxEmbeddings(
  directory: string,
  texts: readonly string[],
): Promise<readonly Float32Array[]> {
  const transformersPackage: string = '@huggingface/transformers';
  const onnxPackage: string = 'onnxruntime-node';
  const [transformers, onnx] = await Promise.all([
    import(transformersPackage) as Promise<TransformersReferenceModule>,
    import(onnxPackage) as Promise<OnnxReferenceModule>,
  ]);
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = false;
  transformers.env.localModelPath = directory;
  transformers.env.useBrowserCache = false;
  transformers.env.useFSCache = false;
  transformers.env.useWasmCache = false;
  transformers.env.cacheDir = null;
  transformers.env.fetch = () => Promise.reject(new Error('REFERENCE_NETWORK_DISABLED'));
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(directory, {
    local_files_only: true,
  });
  const encoding = tokenizer(texts, { max_length: 512, padding: true, truncation: true });
  const session = await onnx.InferenceSession.create(join(directory, 'onnx/model.onnx'), {
    executionProviders: ['cpu'],
  });
  try {
    const feeds: Record<string, unknown> = {};
    for (const name of session.inputNames) {
      const source = encoding[name];
      if (source === undefined) {
        const inputIds = encoding.input_ids;
        if (name !== 'token_type_ids' || inputIds === undefined) {
          throw new Error('REFERENCE_INPUT_INVALID');
        }
        feeds[name] = new onnx.Tensor(
          'int64',
          new BigInt64Array(inputIds.data.length),
          inputIds.dims,
        );
        continue;
      }
      feeds[name] = new onnx.Tensor('int64', int64Data(source.data), source.dims);
    }
    const outputs = await session.run(feeds);
    const outputName = session.outputNames.includes('last_hidden_state')
      ? 'last_hidden_state'
      : session.outputNames[0];
    const hidden = outputName === undefined ? undefined : outputs[outputName];
    const mask = encoding.attention_mask;
    if (hidden === undefined || mask === undefined || hidden.dims.length !== 3 ||
        hidden.dims[0] !== texts.length || hidden.dims[2] !== 384 || mask.dims.length !== 2) {
      throw new Error('REFERENCE_OUTPUT_INVALID');
    }
    const sequenceLength = hidden.dims[1];
    if (sequenceLength === undefined || !(hidden.data instanceof Float32Array)) {
      throw new Error('REFERENCE_OUTPUT_INVALID');
    }
    const vectors: Float32Array[] = [];
    for (let batch = 0; batch < texts.length; batch += 1) {
      const pooled = new Float32Array(384);
      let count = 0;
      for (let token = 0; token < sequenceLength; token += 1) {
        const maskValue = mask.data[batch * sequenceLength + token];
        if (maskValue === 0 || maskValue === 0n) continue;
        count += 1;
        for (let component = 0; component < 384; component += 1) {
          pooled[component] = (pooled[component] ?? 0) +
            Number(hidden.data[(batch * sequenceLength + token) * 384 + component] ?? 0);
        }
      }
      if (count === 0) throw new Error('REFERENCE_OUTPUT_INVALID');
      for (let component = 0; component < pooled.length; component += 1) {
        pooled[component] = (pooled[component] ?? 0) / count;
      }
      vectors.push(normalize(pooled));
    }
    return vectors;
  } finally {
    await session.release();
  }
}

describe.runIf(enabled)('actual local embedding model acceptance gate', () => {
  it('passes offline CPU vector parity, top-K parity, and bounded runtime checks', async () => {
    const hubRoot = process.env.BUILDLORE_ACTUAL_MODEL_HUB_ROOT ?? process.cwd();
    const handle = await resolveVerifiedLocalModelBinding(hubRoot, profileId);
    const temporaryRoot = await mkdtemp(join(process.cwd(), '.test-tmp-actual-semantic-'));
    let networkCalls = 0;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = () => {
      networkCalls += 1;
      return Promise.reject(new Error('ACTUAL_GATE_NETWORK_DISABLED'));
    };
    try {
      const provider = createLocalEmbeddingProvider({ hubRoot });
      const documents = [
        'BuildLore는 로컬 우선 지식 위키를 구성한다.',
        'The semantic index is a reproducible derived view.',
        'Atomic registries protect local model bindings.',
      ];
      const question = '로컬 의미 검색 인덱스는 무엇인가?';
      const coldStarted = performance.now();
      const providerDocuments = await provider.embedDocuments(documents);
      const coldMilliseconds = performance.now() - coldStarted;
      const providerQuery = await provider.embedQuery(question);
      const reference = await withVerifiedLocalModelDirectory(handle, (directory) =>
        independentOnnxEmbeddings(directory, [
          ...documents.map((text) => `passage: ${text}`),
          `query: ${question}`,
        ]));
      const providerVectors = [...providerDocuments.vectors, ...providerQuery.vectors];
      expect(reference).toHaveLength(providerVectors.length);
      for (let index = 0; index < providerVectors.length; index += 1) {
        const actual = providerVectors[index];
        const expected = reference[index];
        if (actual === undefined || expected === undefined) {
          throw new Error('REFERENCE_VECTOR_INVALID');
        }
        let maximumComponentDelta = 0;
        for (let component = 0; component < actual.length; component += 1) {
          maximumComponentDelta = Math.max(
            maximumComponentDelta,
            Math.abs((actual[component] ?? 0) - (expected[component] ?? 0)),
          );
        }
        expect(maximumComponentDelta).toBeLessThanOrEqual(1e-5);
        expect(cosine(actual, expected)).toBeGreaterThanOrEqual(0.99999);
      }
      const providerRanking = providerDocuments.vectors.map((value, index) => ({
        index,
        score: cosine(providerQuery.vectors[0] as Float32Array, value),
      })).sort((left, right) => right.score - left.score).map((item) => item.index);
      const referenceQuery = reference.at(-1) as Float32Array;
      const referenceRanking = reference.slice(0, documents.length).map((value, index) => ({
        index,
        score: cosine(referenceQuery, value),
      })).sort((left, right) => right.score - left.score).map((item) => item.index);
      expect(providerRanking).toEqual(referenceRanking);

      const warmDurations: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const started = performance.now();
        await provider.embedQuery(question);
        warmDurations.push(performance.now() - started);
      }
      expect(coldMilliseconds).toBeLessThanOrEqual(20_000);
      expect(percentile95(warmDurations)).toBeLessThanOrEqual(1_500);

      const gold = JSON.parse(await readFile(
        new URL('./fixtures/retrieval/v2/hierarchical-gold.json', import.meta.url),
        'utf8',
      )) as HierarchicalRetrievalGoldV1;
      const knowledgeRoot = join(temporaryRoot, 'knowledge');
      await mkdir(knowledgeRoot);
      await addProject(knowledgeRoot, {
        displayName: gold.corpus.projectId,
        projectId: gold.corpus.projectId,
        sourceRepository: 'https://example.test/actual-semantic.git',
      });
      const vectorIndex = createFlatFileVectorIndex(knowledgeRoot);
      const built = await vectorIndex.buildFull({
        corpus: gold.corpus,
        embeddingIdentity: providerDocuments.identity,
        projectId: gold.corpus.projectId,
        provider,
        sanitizerPolicyDigest: `sha256:${'f'.repeat(64)}`,
      });
      expect(built.manifest.metadataBytes + built.manifest.vectorBytes)
        .toBeLessThanOrEqual(SEMANTIC_INDEX_LIMITS.maximumGenerationBytes);
      const retrieval = createApprovedWikiHybridRetrieval({
        corpus: gold.corpus,
        projectId: gold.corpus.projectId,
        provider,
        sanitizerPolicyDigest: `sha256:${'f'.repeat(64)}`,
        vectorIndex,
      });
      const semanticResults: RetrievalResultV2[] = [];
      const hybridResults: RetrievalResultV2[] = [];
      for (const goldQuestion of gold.questions) {
        semanticResults.push(await retrieval.search({
          mode: 'semantic',
          projectId: gold.corpus.projectId,
          query: goldQuestion.text,
          topK: 10,
        }));
        hybridResults.push(await retrieval.search({
          mode: 'hybrid',
          projectId: gold.corpus.projectId,
          query: goldQuestion.text,
          topK: 10,
        }));
      }
      const semanticQuality = positiveQuality(semanticResults, gold.questions);
      const hybridQuality = positiveQuality(hybridResults, gold.questions);
      expect(semanticQuality.recallAt5).toBeGreaterThanOrEqual(0.85);
      expect(semanticQuality.mrr).toBeGreaterThanOrEqual(0.7);
      expect(hybridQuality.recallAt5).toBeGreaterThanOrEqual(0.85);
      expect(hybridQuality.mrr).toBeGreaterThanOrEqual(0.7);

      const baseline = createApprovedWikiRetrieval(gold.corpus, gold.corpus.projectId);
      for (const goldQuestion of gold.questions.filter((item) =>
        item.language === 'code' && item.expected.length > 0)) {
        const lexical = baseline.search({
          mode: 'lexical', projectId: gold.corpus.projectId, query: goldQuestion.text,
        });
        const hybrid = hybridResults[gold.questions.indexOf(goldQuestion)];
        if (hybrid === undefined) throw new Error('ACTUAL_QUALITY_RESULT_MISSING');
        for (const expected of goldQuestion.expected) {
          const key = `${expected.pageId}\u0000${expected.sectionId}`;
          const lexicalRank = lexical.hits.findIndex((hit) =>
            `${hit.locator.pageId}\u0000${hit.locator.sectionId}` === key);
          if (lexicalRank >= 0 && lexicalRank < 5) {
            expect(hybrid.hits.slice(0, 5).some((hit) =>
              `${hit.locator.pageId}\u0000${hit.locator.sectionId}` === key)).toBe(true);
          }
        }
      }

      const recoveryQuery = '로컬에서 서버나 데이터베이스 없이 실행';
      const lexicalRecovery = baseline.search({
        mode: 'lexical', projectId: gold.corpus.projectId, query: recoveryQuery,
      });
      const semanticRecovery = await retrieval.search({
        mode: 'semantic', projectId: gold.corpus.projectId, query: recoveryQuery, topK: 5,
      });
      expect(lexicalRecovery.hits.some((hit) => hit.locator.pageId === 'guides/deployment'))
        .toBe(false);
      expect(semanticRecovery.hits.some((hit) => hit.locator.pageId === 'guides/deployment'))
        .toBe(true);

      const warmSearchDurations: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const started = performance.now();
        await retrieval.search({
          mode: 'semantic', projectId: gold.corpus.projectId, query: recoveryQuery, topK: 5,
        });
        warmSearchDurations.push(performance.now() - started);
      }
      expect(percentile95(warmSearchDurations)).toBeLessThanOrEqual(1_500);

      const scanVector = new Float32Array(384);
      scanVector[0] = 1;
      const candidates = benchmarkCandidates(scanVector);
      exactCosineTopKForTest(scanVector, candidates, 20);
      exactCosineTopKForTest(scanVector, candidates, 20);
      const scanDurations: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const started = performance.now();
        expect(exactCosineTopKForTest(scanVector, candidates, 20)).toHaveLength(20);
        scanDurations.push(performance.now() - started);
      }
      expect(percentile95(scanDurations)).toBeLessThanOrEqual(500);
      expect(process.memoryUsage().rss).toBeLessThanOrEqual(2 * 1024 * 1024 * 1024);
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = priorFetch;
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 120_000);
});
