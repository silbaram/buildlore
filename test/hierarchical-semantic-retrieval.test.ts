import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { digestHierarchyValue } from '../src/compiler/index.js';
import { addProject } from '../src/knowledge/index.js';
import {
  createApprovedWikiHybridRetrieval as createApprovedWikiHybridRetrievalV2,
  createApprovedWikiHybridRetrievalV3 as createApprovedWikiHybridRetrieval,
  projectApprovedWikiSemanticText,
  LocalWikiRetrievalError,
  RETRIEVAL_FUSION_POLICY_V1,
  RETRIEVAL_RANKING_POLICY_V2,
  RETRIEVAL_RESULT_V2_SCHEMA_VERSION,
  type ApprovedWikiMeaningSignalV1,
  type ApprovedWikiRetrievalCorpusV1,
  type ApprovedWikiRetrievalPageV1,
  type HierarchicalRetrievalGoldV1,
} from '../src/retrieval/index.js';
import {
  createEmbeddingIdentityV2,
  LocalEmbeddingError,
  MULTILINGUAL_E5_SMALL_PROFILE,
  type EmbeddingIdentityV2,
  type EmbeddingProviderPort,
} from '../src/retrieval/embedding/index.js';
import {
  createFlatFileVectorIndex,
  type VectorIndexPort,
} from '../src/retrieval/vector-index/index.js';

const PROJECT_ID = 'buildlore-fixture';
const SANITIZER_DIGEST = `sha256:${'f'.repeat(64)}` as const;
const roots: string[] = [];

async function goldFixture(): Promise<HierarchicalRetrievalGoldV1> {
  return JSON.parse(await readFile(
    new URL('./fixtures/retrieval/v2/hierarchical-gold.json', import.meta.url),
    'utf8',
  )) as HierarchicalRetrievalGoldV1;
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function identity(character = '1'): EmbeddingIdentityV2 {
  return createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, [
    { basename: 'config.json', bytes: 655, role: 'model-config', sha256: digest(character) },
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
      basename: 'tokenizer_config.json',
      bytes: 443,
      role: 'tokenizer-config',
      sha256: digest('2'),
    },
  ]);
}

function vectorFor(text: string): Float32Array {
  const bytes = createHash('sha256').update(text).digest();
  const vector = new Float32Array(384);
  for (const [index, byte] of bytes.entries()) {
    const component = (byte + index) % 384;
    vector[component] = (vector[component] ?? 0) + (byte + 1) / 256;
  }
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}

function provider(
  calls: Array<Readonly<{ readonly kind: 'document' | 'query'; readonly texts: readonly string[] }>>,
  activeIdentity: EmbeddingIdentityV2 = identity(),
): EmbeddingProviderPort {
  return Object.freeze({
    activeIdentity: () => activeIdentity,
    countDocumentTokens(texts: readonly string[]) {
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity: activeIdentity,
        maximumTokens: 512 as const,
        providerUsed: 'local-in-process' as const,
        tokenCounts: Object.freeze(texts.map((text) =>
          Math.max(1, Array.from(`passage: ${text}`).length))),
      }));
    },
    embedDocuments(texts: readonly string[]) {
      calls.push(Object.freeze({ kind: 'document' as const, texts: Object.freeze([...texts]) }));
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity: activeIdentity,
        providerUsed: 'local-in-process' as const,
        truncated: Object.freeze(texts.map(() => false)),
        vectors: Object.freeze(texts.map(vectorFor)),
      }));
    },
    embedQuery(text: string) {
      calls.push(Object.freeze({ kind: 'query' as const, texts: Object.freeze([text]) }));
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity: activeIdentity,
        providerUsed: 'local-in-process' as const,
        truncated: Object.freeze([false]),
        vectors: Object.freeze([vectorFor(text)]),
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
    readiness: () => Object.freeze({ activeIdentity, state: 'ready' as const }),
  });
}

async function knowledgeFixture(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-hybrid-retrieval-'));
  roots.push(root);
  const knowledge = join(root, 'knowledge');
  await mkdir(knowledge);
  await addProject(knowledge, {
    displayName: PROJECT_ID,
    projectId: PROJECT_ID,
    sourceRepository: `https://example.test/${PROJECT_ID}.git`,
  });
  return knowledge;
}

function buildInput(
  corpus: ApprovedWikiRetrievalCorpusV1,
  embeddingProvider: EmbeddingProviderPort,
) {
  return Object.freeze({
    corpus,
    embeddingIdentity: identity(),
    projectId: PROJECT_ID,
    provider: embeddingProvider,
    sanitizerPolicyDigest: SANITIZER_DIGEST,
  });
}

function intentCorpus(currentFloorCollision = false): ApprovedWikiRetrievalCorpusV1 {
  const signal = (
    sourceId: string,
    authority: ApprovedWikiMeaningSignalV1['authority'],
    lifecycle: ApprovedWikiMeaningSignalV1['lifecycle'],
    evidenceKind: ApprovedWikiMeaningSignalV1['evidenceKind'],
    iterationGroup: string | null,
    topicGroup = 'architecture',
  ): ApprovedWikiMeaningSignalV1 => Object.freeze({
    authority,
    evidenceKind,
    iterationGroup,
    lifecycle,
    origin: 'manifest',
    revisionOrdinal: lifecycle === 'current' ? 25 : 12,
    sourceId,
    topicGroup,
  });
  const createPage = (
    pageId: string,
    citationId: string,
    meaning: ApprovedWikiMeaningSignalV1,
    bodyOverride?: string,
  ): ApprovedWikiRetrievalPageV1 => {
    const body = bodyOverride ?? `Project architecture retrieval design${pageId.startsWith('historical')
      ? ' legacy-marker legacy-marker' : ''}. [^${citationId}]`;
    const semantic = projectApprovedWikiSemanticText(body, 'Project architecture');
    return Object.freeze({
      childPageIds: Object.freeze([]),
      meaningSignals: Object.freeze([meaning]),
      pageId,
      parentPageId: null,
      proposalDigest: digest(pageId.startsWith('current') ? '7' : '8'),
      relationPageIds: Object.freeze([]),
      sections: Object.freeze([Object.freeze({
        body,
        citationLocators: Object.freeze([Object.freeze({
          citationId,
          sourceId: meaning.sourceId,
        })]),
        exclusionSummary: semantic.exclusionSummary,
        meaningSignals: Object.freeze([meaning]),
        semanticContentDigest: semantic.semanticContentDigest,
        semanticText: semantic.semanticText,
        sectionId: 'main',
      })]),
      status: 'active',
      summary: 'Project architecture retrieval design.',
      title: 'Project architecture',
    });
  };
  const current = signal('source-current', 'canonical', 'current', 'architecture', null);
  const currentImplementation = signal(
    'source-current-implementation', 'supporting', 'current', 'implementation', null,
    currentFloorCollision ? 'architecture' : 'implementation',
  );
  const historical = signal(
    'source-historical', 'historical', 'superseded', 'planning', 'v12',
    currentFloorCollision ? 'historical-architecture' : 'architecture',
  );
  const unknown = signal('source-unknown', 'unknown', 'unknown', 'other', null);
  const pages = currentFloorCollision
    ? [
        createPage(
          'unknown/architecture',
          'citation-unknown',
          unknown,
          'Project architecture retrieval design legacy marker. [^citation-unknown]',
        ),
        createPage(
          'current/architecture',
          'citation-current',
          current,
          'Project architecture retrieval. [^citation-current]',
        ),
        createPage(
          'current/implementation',
          'citation-current-implementation',
          currentImplementation,
          'Project architecture retrieval. [^citation-current-implementation]',
        ),
        createPage('historical/architecture', 'citation-historical', historical),
      ]
    : [
        createPage('current/architecture', 'citation-current', current),
        createPage('historical/architecture', 'citation-historical', historical),
      ];
  const basis = Object.freeze({
    generationDigest: digest('6'),
    pages: Object.freeze(pages),
    projectId: PROJECT_ID,
    schemaVersion: 'buildlore.approved-wiki-retrieval-corpus.v2' as const,
  });
  return Object.freeze({ ...basis, corpusDigest: digestHierarchyValue(basis) });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('approved Wiki local semantic and hybrid retrieval', () => {
  it('removes only closed semantic noise while retaining raw evidence and fenced examples', () => {
    const body = `This page is generated by BuildLore.
source_digest: sha256:${'a'.repeat(64)}
Useful meaning. [^citation-live]
Escaped \\[^citation-example]

\`\`\`md
[^citation-code-example]
\`\`\``;
    const projected = projectApprovedWikiSemanticText(body, 'Fallback');

    expect(body).toContain('source_digest');
    expect(projected.semanticText).toBe(`Useful meaning.
Escaped \\[^citation-example]

\`\`\`md
[^citation-code-example]
\`\`\``);
    expect(projected.exclusionSummary.excludedKinds).toEqual([
      'citation-marker', 'machine-provenance', 'renderer-boilerplate',
    ]);
    expect(projected.exclusionSummary.excludedUtf8Bytes).toBeGreaterThan(0);
  });

  it('does not treat a fenced code line with trailing content as a closing fence', () => {
    const body = `\`\`\`md
\`\`\`example
source_digest: sha256:${'a'.repeat(64)}
\`\`\``;

    const projected = projectApprovedWikiSemanticText(body, 'Fallback');

    expect(projected.semanticText).toBe(body);
    expect(projected.exclusionSummary.excludedKinds).toEqual([]);
  });

  it('pins the public retrieval v3 schema to the runtime ranking policy', async () => {
    const schema = JSON.parse(await readFile(
      new URL('../schemas/retrieval-result-v3.schema.json', import.meta.url),
      'utf8',
    )) as { $defs: { rankingPolicy: { properties: { policyDigest: { const: string } } } } };
    expect(schema.$defs.rankingPolicy.properties.policyDigest.const)
      .toBe(RETRIEVAL_RANKING_POLICY_V2.policyDigest);
  });

  it('applies explicit and bounded auto intent with deterministic two-pass diversification',
    async () => {
      const corpus = intentCorpus();
      const retrieval = createApprovedWikiHybridRetrieval({
        corpus,
        projectId: PROJECT_ID,
        provider: provider([]),
        sanitizerPolicyDigest: SANITIZER_DIGEST,
        vectorIndex: createFlatFileVectorIndex(await knowledgeFixture()),
      });
      const current = await retrieval.search({
        intent: 'current', mode: 'lexical', projectId: PROJECT_ID,
        query: 'Project architecture retrieval design', topK: 2,
      });
      const historical = await retrieval.search({
        intent: 'historical', mode: 'lexical', projectId: PROJECT_ID,
        query: 'Project architecture retrieval design', topK: 2,
      });
      const autoHistorical = await retrieval.search({
        mode: 'lexical', projectId: PROJECT_ID,
        query: 'Gate B project architecture retrieval design', topK: 2,
      });
      const neutral = await retrieval.search({
        intent: 'neutral', mode: 'lexical', projectId: PROJECT_ID,
        query: 'Project architecture retrieval design', topK: 2,
      });

      expect(current).toMatchObject({
        effectiveIntent: 'current',
        intentReasonCodes: ['explicit-current'],
        requestedIntent: 'current',
        rankingPolicy: RETRIEVAL_RANKING_POLICY_V2,
      });
      expect(current.hits.map((hit) => hit.locator.pageId)).toEqual([
        'current/architecture', 'historical/architecture',
      ]);
      expect(current.hits[0]).toMatchObject({
        diversificationReason: 'primary-distinct-groups',
        meaningAdjustment: {
          authority: 0.0015,
          evidenceKind: 0.001,
          lifecycle: 0.003,
          total: 0.0055,
        },
      });
      expect(current.hits[1]?.diversificationReason).toBe('secondary-fill');
      expect(historical.hits[0]?.locator.pageId).toBe('historical/architecture');
      expect(historical.hits[0]?.meaningAdjustment.total).toBe(0.0055);
      expect(autoHistorical).toMatchObject({
        effectiveIntent: 'historical',
        intentReasonCodes: ['auto-historical-gate-marker'],
        requestedIntent: 'auto',
      });
      expect(neutral.hits.every((hit) => hit.meaningAdjustment.total === 0 &&
        hit.baseScore === hit.finalScore)).toBe(true);
      const currentFloor = await retrieval.search({
        intent: 'current', mode: 'lexical', projectId: PROJECT_ID,
        query: 'Project architecture retrieval design legacy marker', topK: 2,
      });
      expect(currentFloor.hits[0]?.locator.pageId).toBe('current/architecture');
      expect((currentFloor.hits[1]?.baseScore ?? 0)).toBeGreaterThan(
        currentFloor.hits[0]?.baseScore ?? 0,
      );
      expect(await retrieval.search({
        mode: 'lexical', projectId: PROJECT_ID, query: 'totally unrelated bananas', topK: 2,
      })).toMatchObject({ hits: [] });
      expect(await retrieval.search({
        intent: 'current', mode: 'lexical', projectId: PROJECT_ID,
        query: 'Project architecture retrieval design', topK: 2,
      })).toEqual(current);
    });

  it('keeps current evidence ahead of stale evidence after group diversification', async () => {
    const corpus = intentCorpus(true);
    const retrieval = createApprovedWikiHybridRetrieval({
      corpus,
      projectId: PROJECT_ID,
      provider: provider([]),
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex: createFlatFileVectorIndex(await knowledgeFixture()),
    });

    const result = await retrieval.search({
      intent: 'current',
      mode: 'lexical',
      projectId: PROJECT_ID,
      query: 'Project architecture retrieval design legacy marker',
      topK: 3,
    });

    const pageIds = result.hits.map((hit) => hit.locator.pageId);
    expect(pageIds).toContain('current/architecture');
    expect(pageIds).toContain('current/implementation');
    expect(pageIds).not.toContain('historical/architecture');
  });

  it('neutralizes every historical adjustment axis when a section has mixed current signals',
    async () => {
      const source = intentCorpus();
      const currentPage = source.pages.find((page) => page.pageId === 'current/architecture');
      const historicalPage = source.pages.find((page) =>
        page.pageId === 'historical/architecture');
      const currentMeaning = currentPage?.meaningSignals?.[0];
      const historicalMeaning = historicalPage?.meaningSignals?.[0];
      if (currentPage === undefined || currentMeaning === undefined || historicalMeaning === undefined) {
        throw new Error('Fixture is incomplete.');
      }
      const body = 'Project architecture retrieval design. ' +
        '[^citation-current] [^citation-historical]';
      const semantic = projectApprovedWikiSemanticText(body, 'Mixed architecture');
      const mixedPage: ApprovedWikiRetrievalPageV1 = Object.freeze({
        ...currentPage,
        meaningSignals: Object.freeze([currentMeaning, historicalMeaning]),
        pageId: 'mixed/architecture',
        proposalDigest: digestHierarchyValue('mixed-meaning'),
        sections: Object.freeze([Object.freeze({
          body,
          citationLocators: Object.freeze([
            Object.freeze({ citationId: 'citation-current', sourceId: currentMeaning.sourceId }),
            Object.freeze({
              citationId: 'citation-historical', sourceId: historicalMeaning.sourceId,
            }),
          ]),
          exclusionSummary: semantic.exclusionSummary,
          meaningSignals: Object.freeze([currentMeaning, historicalMeaning]),
          semanticContentDigest: semantic.semanticContentDigest,
          semanticText: semantic.semanticText,
          sectionId: 'main',
        })]),
      });
      const basis = Object.freeze({
        generationDigest: digestHierarchyValue('mixed-generation'),
        pages: Object.freeze([mixedPage]),
        projectId: PROJECT_ID,
        schemaVersion: 'buildlore.approved-wiki-retrieval-corpus.v2' as const,
      });
      const retrieval = createApprovedWikiHybridRetrieval({
        corpus: Object.freeze({ ...basis, corpusDigest: digestHierarchyValue(basis) }),
        projectId: PROJECT_ID,
        provider: provider([]),
        sanitizerPolicyDigest: SANITIZER_DIGEST,
        vectorIndex: createFlatFileVectorIndex(await knowledgeFixture()),
      });

      const result = await retrieval.search({
        intent: 'historical',
        mode: 'lexical',
        projectId: PROJECT_ID,
        query: 'Project architecture retrieval design',
        topK: 1,
      });

      expect(result.hits[0]?.meaningAdjustment).toEqual({
        authority: 0,
        evidenceKind: 0,
        lifecycle: 0,
        reasonCodes: [
          'conflicting-authority-neutral',
          'conflicting-evidence-kind-neutral',
          'conflicting-lifecycle-neutral',
        ],
        total: 0,
      });
    });

  it('preserves the published v2 result shape through its compatibility facade', async () => {
    const retrieval = createApprovedWikiHybridRetrievalV2({
      corpus: intentCorpus(),
      projectId: PROJECT_ID,
      provider: provider([]),
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex: createFlatFileVectorIndex(await knowledgeFixture()),
    });

    const result = await retrieval.search({
      mode: 'lexical',
      projectId: PROJECT_ID,
      query: 'Project architecture retrieval design',
      topK: 2,
    });

    expect(result.schemaVersion).toBe(RETRIEVAL_RESULT_V2_SCHEMA_VERSION);
    expect(result).not.toHaveProperty('effectiveIntent');
    expect(result).not.toHaveProperty('rankingPolicy');
    expect(result.hits[0]).not.toHaveProperty('meaningAdjustment');
    expect(result.hits[0]).not.toHaveProperty('diversificationReason');
  });

  it('[HSW-A-15][HSW-IF-09] embeds once, fences identity, and restores canonical locators', async () => {
    const gold = await goldFixture();
    const knowledge = await knowledgeFixture();
    const baseVectorIndex = createFlatFileVectorIndex(knowledge);
    await baseVectorIndex.buildFull(buildInput(gold.corpus, provider([])));
    const requestedTopKs: number[] = [];
    const vectorIndex: VectorIndexPort = Object.freeze({
      ...baseVectorIndex,
      searchExactDistinctSections(projectId: string, queryVector: Float32Array, topK?: number) {
        requestedTopKs.push(topK ?? 10);
        return baseVectorIndex.searchExactDistinctSections(projectId, queryVector, topK);
      },
    });
    const calls: Array<Readonly<{
      readonly kind: 'document' | 'query';
      readonly texts: readonly string[];
    }>> = [];
    const retrieval = createApprovedWikiHybridRetrieval({
      corpus: gold.corpus,
      projectId: PROJECT_ID,
      provider: provider(calls),
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex,
    });
    const rawQuery = gold.corpus.pages.find((page) => page.pageId === 'guides/auth-recovery')
      ?.sections[0]?.body;
    if (rawQuery === undefined) throw new Error('Fixture is incomplete.');
    const semantic = await retrieval.search({
      mode: 'semantic',
      projectId: PROJECT_ID,
      query: rawQuery,
      topK: 5,
    });

    expect(calls).toEqual([{ kind: 'query', texts: [rawQuery] }]);
    expect(semantic).toMatchObject({
      effectiveChannels: ['semantic'],
      effectiveMode: 'semantic',
      egress: 'none',
      fallback: null,
      fusionPolicy: null,
      identity: {
        embeddingIdentityDigest: identity().identityDigest,
      },
      providerUsed: 'local-in-process',
      requestedMode: 'semantic',
    });
    expect(semantic.identity.indexGenerationId).toMatch(/^generation-/u);
    expect(semantic.identity.indexManifestDigest).toMatch(/^sha256:/u);
    expect(semantic.hits[0]).toMatchObject({
      channels: [{ channel: 'semantic', rank: 1 }],
      locator: {
        citationIds: ['citation-auth'],
        pageId: 'guides/auth-recovery',
        projectId: PROJECT_ID,
        sectionId: 'recovery-steps',
        sourceIds: ['source-auth'],
      },
      scoreKind: 'exact-cosine',
    });
    expect(semantic.hits[0]?.score).toBeCloseTo(1, 5);
    expect(JSON.stringify(semantic)).not.toContain(rawQuery);

    calls.splice(0);
    const firstHybrid = await retrieval.search({
      mode: 'hybrid', projectId: PROJECT_ID, query: 'authentication recovery', topK: 10,
    });
    calls.splice(0);
    const secondHybrid = await retrieval.search({
      mode: 'hybrid', projectId: PROJECT_ID, query: 'authentication recovery', topK: 10,
    });
    expect(firstHybrid).toEqual(secondHybrid);
    expect(firstHybrid).toMatchObject({
      effectiveChannels: ['lexical', 'graph', 'semantic'],
      effectiveMode: 'hybrid',
      fallback: null,
      fusionPolicy: {
        algorithm: 'reciprocal-rank-fusion',
        algorithmVersion: 1,
        channelWeights: { graph: 1, lexical: 1, semantic: 1 },
        rankConstant: 60,
        tieBreak: ['pageId', 'sectionId', 'chunkId'],
      },
    });
    for (const hit of firstHybrid.hits) {
      expect(hit.score).toBeCloseTo(
        hit.channels.reduce((sum, channel) => sum + 1 / (60 + channel.rank), 0),
        10,
      );
    }
    expect(requestedTopKs).toEqual([5, 10, 10]);
    expect(RETRIEVAL_FUSION_POLICY_V1.policyDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('does not widen a v2 semantic chunk to unrelated section citations', async () => {
    const original = intentCorpus();
    const targetPage = original.pages.find((page) => page.pageId === 'current/architecture');
    const targetSection = targetPage?.sections[0];
    if (targetPage === undefined || targetSection?.semanticText === undefined) {
      throw new Error('Fixture is incomplete.');
    }
    const pages = original.pages.map((page) => page.pageId !== targetPage.pageId
      ? page
      : Object.freeze({
          ...page,
          sections: Object.freeze([Object.freeze({
            ...targetSection,
            citationLocators: Object.freeze([
              ...targetSection.citationLocators,
              Object.freeze({ citationId: 'citation-extra', sourceId: 'source-extra' }),
            ].sort((left, right) => left.citationId < right.citationId ? -1 : 1)),
          })]),
        }));
    const basis = Object.freeze({
      generationDigest: original.generationDigest,
      pages: Object.freeze(pages),
      projectId: original.projectId,
      schemaVersion: original.schemaVersion,
    });
    const corpus = Object.freeze({ ...basis, corpusDigest: digestHierarchyValue(basis) });
    const knowledge = await knowledgeFixture();
    const vectorIndex = createFlatFileVectorIndex(knowledge);
    await vectorIndex.buildFull(buildInput(corpus, provider([])));
    const retrieval = createApprovedWikiHybridRetrieval({
      corpus,
      projectId: PROJECT_ID,
      provider: provider([]),
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex,
    });

    const result = await retrieval.search({
      mode: 'semantic',
      projectId: PROJECT_ID,
      query: targetSection.semanticText,
      topK: 1,
    });

    expect(result.hits[0]?.locator).toMatchObject({
      citationIds: ['citation-current'],
      sourceIds: ['source-current'],
    });
  });

  it('[HSW-EC-14] fails semantic-only and visibly degrades only hybrid when index is absent', async () => {
    const gold = await goldFixture();
    const knowledge = await knowledgeFixture();
    const calls: Array<Readonly<{
      readonly kind: 'document' | 'query';
      readonly texts: readonly string[];
    }>> = [];
    const retrieval = createApprovedWikiHybridRetrieval({
      corpus: gold.corpus,
      projectId: PROJECT_ID,
      provider: provider(calls),
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex: createFlatFileVectorIndex(knowledge),
    });

    await expect(retrieval.search({
      mode: 'semantic', projectId: PROJECT_ID, query: 'authentication recovery',
    })).rejects.toMatchObject({
      code: 'LOCAL_WIKI_SEMANTIC_UNAVAILABLE',
      reasonCode: 'semantic-index-unavailable',
      recoveryAction: ['index', 'rebuild', '--project', PROJECT_ID],
    });
    await expect(retrieval.search({
      mode: 'hybrid', projectId: PROJECT_ID, query: 'authentication recovery',
    })).resolves.toMatchObject({
      effectiveChannels: ['lexical', 'graph'],
      effectiveMode: 'lexical-graph',
      fallback: {
        excludedChannel: 'semantic',
        fromMode: 'hybrid',
        reasonCode: 'semantic-index-unavailable',
        toMode: 'lexical-graph',
      },
      providerUsed: 'none',
    });
    await expect(retrieval.search({
      mode: 'lexical', projectId: PROJECT_ID, query: 'authentication recovery',
    })).resolves.toMatchObject({ effectiveChannels: ['lexical'], fallback: null });
    expect(calls).toEqual([]);
  });

  it('does not query stale indexes or accept a different active embedding identity', async () => {
    const gold = await goldFixture();
    const knowledge = await knowledgeFixture();
    const vectorIndex = createFlatFileVectorIndex(knowledge);
    await vectorIndex.buildFull(buildInput(gold.corpus, provider([])));
    const staleBasis = Object.freeze({
      generationDigest: digest('9'),
      pages: gold.corpus.pages,
      projectId: gold.corpus.projectId,
      schemaVersion: gold.corpus.schemaVersion,
    });
    const staleCorpus = Object.freeze({
      ...staleBasis,
      corpusDigest: digestHierarchyValue(staleBasis),
    });
    const staleCalls: Array<Readonly<{
      readonly kind: 'document' | 'query';
      readonly texts: readonly string[];
    }>> = [];
    const stale = createApprovedWikiHybridRetrieval({
      corpus: staleCorpus,
      projectId: PROJECT_ID,
      provider: provider(staleCalls),
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex,
    });
    await expect(stale.search({
      mode: 'semantic', projectId: PROJECT_ID, query: 'retrieval',
    })).rejects.toMatchObject({
      code: 'LOCAL_WIKI_SEMANTIC_UNAVAILABLE',
      reasonCode: 'semantic-index-stale',
      recoveryAction: ['index', 'rebuild', '--full', '--project', PROJECT_ID],
    });
    await expect(stale.search({
      mode: 'hybrid', projectId: PROJECT_ID, query: 'retrieval',
    })).resolves.toMatchObject({ fallback: { reasonCode: 'semantic-index-stale' } });
    expect(staleCalls).toEqual([]);

    const mismatchCalls: Array<Readonly<{
      readonly kind: 'document' | 'query';
      readonly texts: readonly string[];
    }>> = [];
    const mismatch = createApprovedWikiHybridRetrieval({
      corpus: gold.corpus,
      projectId: PROJECT_ID,
      provider: provider(mismatchCalls, identity('3')),
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex,
    });
    await expect(mismatch.search({
      mode: 'semantic', projectId: PROJECT_ID, query: 'retrieval',
    })).rejects.toMatchObject({
      code: 'LOCAL_WIKI_SEMANTIC_UNAVAILABLE',
      reasonCode: 'embedding-identity-mismatch',
    });
    expect(mismatchCalls).toEqual([]);
  });

  it('never disguises an invalid or truncated semantic query as hybrid fallback', async () => {
    const gold = await goldFixture();
    const knowledge = await knowledgeFixture();
    const vectorIndex = createFlatFileVectorIndex(knowledge);
    await vectorIndex.buildFull(buildInput(gold.corpus, provider([])));
    const calls: Array<Readonly<{
      readonly kind: 'document' | 'query';
      readonly texts: readonly string[];
    }>> = [];
    const configured = provider(calls);
    const invalidQueryProvider: EmbeddingProviderPort = Object.freeze({
      ...configured,
      embedQuery(text: string) {
        calls.push(Object.freeze({ kind: 'query' as const, texts: Object.freeze([text]) }));
        return Promise.reject(new LocalEmbeddingError('LOCAL_EMBEDDING_CONFIG_INVALID'));
      },
    });
    const invalidQueryRetrieval = createApprovedWikiHybridRetrieval({
      corpus: gold.corpus,
      projectId: PROJECT_ID,
      provider: invalidQueryProvider,
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex,
    });
    for (const mode of ['semantic', 'hybrid'] as const) {
      await expect(invalidQueryRetrieval.search({
        mode, projectId: PROJECT_ID, query: 'bounded but over-token query',
      })).rejects.toMatchObject({ code: 'LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID' });
    }

    const truncating = provider(calls);
    const truncatedQueryProvider: EmbeddingProviderPort = Object.freeze({
      ...truncating,
      async embedQuery(text: string) {
        const result = await truncating.embedQuery(text);
        return Object.freeze({ ...result, truncated: Object.freeze([true]) });
      },
    });
    const truncatedQueryRetrieval = createApprovedWikiHybridRetrieval({
      corpus: gold.corpus,
      projectId: PROJECT_ID,
      provider: truncatedQueryProvider,
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex,
    });
    await expect(truncatedQueryRetrieval.search({
      mode: 'hybrid', projectId: PROJECT_ID, query: 'truncation sentinel',
    })).rejects.toMatchObject({ code: 'LOCAL_WIKI_RETRIEVAL_CONFIG_INVALID' });
    expect(calls.filter((call) => call.kind === 'query')).toHaveLength(3);
  });

  it('rejects cross-project and unsafe query input before provider or index work value-free', async () => {
    const gold = await goldFixture();
    const knowledge = await knowledgeFixture();
    const calls: Array<Readonly<{
      readonly kind: 'document' | 'query';
      readonly texts: readonly string[];
    }>> = [];
    const retrieval = createApprovedWikiHybridRetrieval({
      corpus: gold.corpus,
      projectId: PROJECT_ID,
      provider: provider(calls),
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex: createFlatFileVectorIndex(knowledge),
    });
    const privateQuery = 'private-token-value\nnext';
    const credentialQuery = `find ghp_${'A'.repeat(24)}`;
    const absolutePathQuery = 'find /home/private-user/project/config.json';
    for (const request of [
      { mode: 'hybrid' as const, projectId: 'other-private-project', query: 'retrieval' },
      { mode: 'hybrid' as const, projectId: PROJECT_ID, query: privateQuery },
      { mode: 'hybrid' as const, projectId: PROJECT_ID, query: credentialQuery },
      { mode: 'semantic' as const, projectId: PROJECT_ID, query: absolutePathQuery },
      { mode: 'semantic' as const, projectId: PROJECT_ID, query: 'a'.repeat(4097) },
    ]) {
      try {
        await retrieval.search(request);
        throw new Error('Expected retrieval failure.');
      } catch (error) {
        expect(error).toBeInstanceOf(LocalWikiRetrievalError);
        expect(JSON.stringify(error)).not.toContain(privateQuery);
        expect(JSON.stringify(error)).not.toContain(credentialQuery);
        expect(JSON.stringify(error)).not.toContain(absolutePathQuery);
        expect(JSON.stringify(error)).not.toContain('other-private-project');
      }
    }
    expect(calls).toEqual([]);
  });

  it('[HSW-V-19] recreates the same logical top-K after deleting only the derived index', async () => {
    const gold = await goldFixture();
    const knowledge = await knowledgeFixture();
    const vectorIndex = createFlatFileVectorIndex(knowledge);
    await vectorIndex.buildFull(buildInput(gold.corpus, provider([])));
    const search = async () => createApprovedWikiHybridRetrieval({
      corpus: gold.corpus,
      projectId: PROJECT_ID,
      provider: provider([]),
      sanitizerPolicyDigest: SANITIZER_DIGEST,
      vectorIndex,
    }).search({
      mode: 'hybrid', projectId: PROJECT_ID, query: 'local retrieval channels', topK: 10,
    });
    const before = await search();
    await rm(join(
      knowledge,
      'projects',
      PROJECT_ID,
      '.buildlore',
      'indexes',
      'semantic',
    ), { force: true, recursive: true });
    await vectorIndex.buildFull(buildInput(gold.corpus, provider([])));
    const after = await search();
    expect(after.hits).toEqual(before.hits);
    expect(after.identity).toEqual(before.identity);
  });
});
