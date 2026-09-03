import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { digestHierarchyValue } from '../src/compiler/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { addProject } from '../src/knowledge/index.js';
import {
  createEmbeddingIdentityV2,
  MULTILINGUAL_E5_SMALL_PROFILE,
  type EmbeddingIdentityV2,
  type EmbeddingProviderPort,
} from '../src/retrieval/embedding/index.js';
import type {
  ApprovedWikiRetrievalCorpusV1,
  ApprovedWikiRetrievalPageV1,
} from '../src/retrieval/hierarchical.js';
import {
  chunkApprovedWikiCorpus,
  createFlatFileVectorIndex,
  SEMANTIC_INDEX_LIMITS,
  SemanticIndexError,
  splitMarkdownStructures,
  type SemanticIndexActivationGuardV1,
} from '../src/retrieval/vector-index/index.js';
import { createFlatFileVectorIndexForTest } from '../src/retrieval/vector-index/service.js';

const PROJECT_ID = 'semantic-fixture';
const roots: string[] = [];

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function embeddingIdentity(): EmbeddingIdentityV2 {
  return createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, [
    { basename: 'config.json', bytes: 655, role: 'model-config', sha256: digest('1') },
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
  for (let index = 0; index < bytes.length; index += 1) {
    vector[(bytes[index] ?? 0) + index] = ((bytes.at(index) ?? 0) + 1) / 256;
  }
  let squaredNorm = 0;
  for (const component of vector) squaredNorm += component * component;
  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}

function fakeProvider(
  calls: string[][],
  options: Readonly<{ readonly truncated?: boolean }> = {},
): EmbeddingProviderPort {
  const identity = embeddingIdentity();
  return Object.freeze({
    activeIdentity: () => identity,
    countDocumentTokens(texts: readonly string[]) {
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity,
        maximumTokens: 512 as const,
        providerUsed: 'local-in-process' as const,
        tokenCounts: Object.freeze(texts.map((text) =>
          Math.max(1, Array.from(`passage: ${text}`).length))),
      }));
    },
    embedDocuments(texts: readonly string[]) {
      calls.push([...texts]);
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity,
        providerUsed: 'local-in-process' as const,
        truncated: Object.freeze(texts.map(() => options.truncated === true)),
        vectors: Object.freeze(texts.map(vectorFor)),
      }));
    },
    embedQuery(text: string) {
      calls.push([text]);
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity,
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
    readiness: () => Object.freeze({ activeIdentity: identity, state: 'ready' as const }),
  });
}

function page(
  pageId: string,
  body: string,
  revisionCharacter: string,
): ApprovedWikiRetrievalPageV1 {
  const citationIds = [...body.matchAll(
    /(?<!\\)\[\^(citation-[a-z0-9]+(?:-[a-z0-9]+)*)\]/gu,
  )]
    .flatMap((match) => match[1] === undefined ? [] : [match[1]]);
  const uniqueCitationIds = [...new Set(citationIds)];
  return Object.freeze({
    childPageIds: Object.freeze([]),
    pageId,
    parentPageId: null,
    proposalDigest: digest(revisionCharacter),
    relationPageIds: Object.freeze([]),
    sections: Object.freeze([Object.freeze({
      body,
      citationLocators: Object.freeze((uniqueCitationIds.length === 0
        ? [`citation-${pageId.replaceAll('/', '-')}`]
        : uniqueCitationIds).map((citationId) => Object.freeze({
        citationId,
        sourceId: `source-${pageId.replaceAll('/', '-')}`,
      }))),
      sectionId: 'main',
    })]),
    status: 'active' as const,
    summary: `Summary for ${pageId}.`,
    title: `Title ${pageId}`,
  });
}

function corpus(
  pages: readonly ApprovedWikiRetrievalPageV1[],
  generationCharacter: string,
): ApprovedWikiRetrievalCorpusV1 {
  const basis = Object.freeze({
    generationDigest: digest(generationCharacter),
    pages: Object.freeze([...pages].sort((left, right) =>
      left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0)),
    projectId: PROJECT_ID,
    schemaVersion: 'buildlore.approved-wiki-retrieval-corpus.v1' as const,
  });
  return Object.freeze({ ...basis, corpusDigest: digestHierarchyValue(basis) });
}

const STRUCTURED_BODY = `# Semantic index

Atomic semantic storage preserves a healthy generation. [^citation-semantic-fixture-guide]

- manifest is checked
- vectors are checked

| file | role |
| --- | --- |
| vectors.f32 | derived vector rows |

\`\`\`ts
const dimensions = 384;
\`\`\``;

async function knowledgeFixture(projectId: string = PROJECT_ID): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-semantic-index-'));
  roots.push(root);
  const knowledge = join(root, 'knowledge');
  await mkdir(knowledge);
  await addProject(knowledge, {
    displayName: projectId,
    projectId,
    sourceRepository: `https://example.test/${projectId}.git`,
  });
  return knowledge;
}

function buildInput(
  value: ApprovedWikiRetrievalCorpusV1,
  provider: EmbeddingProviderPort,
) {
  return Object.freeze({
    corpus: value,
    embeddingIdentity: embeddingIdentity(),
    projectId: PROJECT_ID,
    provider,
    sanitizerPolicyDigest: digest('f'),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe('project-scoped flat-file semantic index', () => {
  it('[HSW-A-12] preserves Markdown structures in stable path-free retrieval chunks', async () => {
    expect(splitMarkdownStructures(STRUCTURED_BODY).map(({ kind }) => kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'table',
      'fenced-code',
    ]);
    const value = corpus([page('semantic-fixture/guide', STRUCTURED_BODY, 'a')], 'b');
    const counter = (texts: readonly string[]) => Promise.resolve(texts.map((text) =>
      Math.max(1, Array.from(`passage: ${text}`).length)));
    const first = await chunkApprovedWikiCorpus(value, PROJECT_ID, counter);
    const second = await chunkApprovedWikiCorpus(value, PROJECT_ID, counter);
    expect(first).toEqual(second);
    expect(first.chunks).toHaveLength(5);
    expect(first.chunks.map(({ chunk }) => chunk.structureKind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'table',
      'fenced-code',
    ]);
    expect(first.chunks.every(({ chunk }, rowOrdinal) =>
      chunk.rowOrdinal === rowOrdinal && chunk.maximumTokens === 512 &&
      chunk.tokenCount <= 512 && chunk.tokenTruncated === false)).toBe(true);
    expect(first.chunks.map(({ chunk }) => chunk.citationLocators.length)).toEqual([0, 1, 0, 0, 0]);
    expect(JSON.stringify(first.chunks.map(({ chunk }) => chunk))).not.toContain(
      'Atomic semantic storage',
    );
  });

  it('[SFM-SC-01][SFM-SC-03] distinguishes evidence citations from Markdown examples',
    async () => {
      const body = `Ordinary [^id], escaped \\[^citation-escaped], and approved
[^citation-evidence] markers coexist.

\`\`\`md
[^citation-code-example]
\`\`\``;
      const base = page('semantic-fixture/footnotes', body, 'a');
      const section = base.sections[0];
      if (section === undefined) throw new Error('Fixture is incomplete.');
      const value = corpus([Object.freeze({
        ...base,
        sections: Object.freeze([Object.freeze({
          ...section,
          citationLocators: Object.freeze([Object.freeze({
            citationId: 'citation-evidence',
            sourceId: 'source-semantic-fixture-footnotes',
          })]),
        })]),
      })], 'b');
      const result = await chunkApprovedWikiCorpus(value, PROJECT_ID, (texts) =>
        Promise.resolve(texts.map((text) => Math.max(1, Array.from(text).length))));

      expect(result.chunks).toHaveLength(2);
      expect(result.chunks[0]?.chunk.citationLocators).toEqual([{
        citationId: 'citation-evidence',
        sourceId: 'source-semantic-fixture-footnotes',
      }]);
      expect(result.chunks[1]?.chunk).toMatchObject({
        citationLocators: [],
        structureKind: 'fenced-code',
      });
    });

  it('[SFM-SC-02] rejects an unresolved reserved evidence citation without reflecting text',
    async () => {
      const base = page(
        'semantic-fixture/unresolved',
        'Sensitive-looking prose uses [^citation-missing].',
        'a',
      );
      const section = base.sections[0];
      if (section === undefined) throw new Error('Fixture is incomplete.');
      const value = corpus([Object.freeze({
        ...base,
        sections: Object.freeze([Object.freeze({
          ...section,
          citationLocators: Object.freeze([Object.freeze({
            citationId: 'citation-approved',
            sourceId: 'source-semantic-fixture-unresolved',
          })]),
        })]),
      })], 'b');

      await expect(chunkApprovedWikiCorpus(value, PROJECT_ID, (texts) =>
        Promise.resolve(texts.map(() => 3)))).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_CONFIG_INVALID',
        message: 'Semantic index contract is invalid.',
        reasonCode: 'artifact-invalid',
      });
    });

  it('[HSW-A-12] deterministically bounds long structures without token truncation', async () => {
    const body = Array.from({ length: 160 }, (_value, index) =>
      `문단-${index}-semantic-retrieval`).join(' ');
    const value = corpus([page('semantic-fixture/long', body, 'a')], 'b');
    const counter = (texts: readonly string[]) => Promise.resolve(texts.map((text) =>
      Math.max(1, Array.from(`passage: ${text}`).length)));
    const first = await chunkApprovedWikiCorpus(value, PROJECT_ID, counter);
    const second = await chunkApprovedWikiCorpus(value, PROJECT_ID, counter);
    expect(first).toEqual(second);
    expect(first.chunks.length).toBeGreaterThan(1);
    expect(first.chunks.every(({ chunk, text }) =>
      chunk.structureKind === 'paragraph' && chunk.tokenTruncated === false &&
      chunk.tokenCount <= 512 &&
      chunk.utf8Bytes === Buffer.byteLength(text, 'utf8') &&
      chunk.utf8Bytes <= SEMANTIC_INDEX_LIMITS.maximumChunkUtf8Bytes)).toBe(true);
    expect(new Set(first.chunks.map(({ chunk }) => chunk.chunkId)).size)
      .toBe(first.chunks.length);
  });

  it('[HSW-A-12] uses provider token counts for adversarial multilingual text', async () => {
    const body = `${'ﷺ'.repeat(149)} [^citation-adversarial]`;
    const value = corpus([page('semantic-fixture/adversarial', body, 'a')], 'b');
    const counter = (texts: readonly string[]) => Promise.resolve(texts.map((text) =>
      Array.from(`passage: ${text}`).reduce((count, scalar) =>
        count + (scalar === 'ﷺ' ? 4 : 1), 0)));
    const result = await chunkApprovedWikiCorpus(value, PROJECT_ID, counter);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.every(({ chunk }) =>
      chunk.tokenCount <= 512 && chunk.tokenTruncated === false &&
      chunk.citationLocators[0]?.citationId === 'citation-adversarial')).toBe(true);
  });

  it('[HSW-A-12] rejects the 50,001st structure before tokenizing or retaining it', async () => {
    const body = Array.from({ length: 50_001 }, (_value, index) => `# h${index}`).join('\n');
    const value = corpus([page('semantic-fixture/limit', body, 'a')], 'b');
    let counted = 0;
    await expect(chunkApprovedWikiCorpus(value, PROJECT_ID, (texts) => {
      counted += texts.length;
      return Promise.resolve(texts.map(() => 3));
    })).rejects.toMatchObject({
      code: 'SEMANTIC_INDEX_LIMIT_EXCEEDED',
      reasonCode: 'limit-exceeded',
    });
    expect(counted).toBe(50_000);
  });

  it('[HSW-V-13][HSW-V-15] atomically builds, validates, and exact-searches four files', async () => {
    const knowledge = await knowledgeFixture();
    const calls: string[][] = [];
    const value = corpus([page('semantic-fixture/guide', STRUCTURED_BODY, 'a')], 'b');
    const service = createFlatFileVectorIndex(knowledge);
    const result = await service.buildFull(buildInput(value, fakeProvider(calls)));

    expect(result).toMatchObject({
      outcome: 'activated',
      ledger: { createdRows: 5, egress: 'none', providerUsed: 'local-in-process' },
      manifest: {
        byteOrder: 'little-endian',
        dimensions: 384,
        projectId: PROJECT_ID,
        rowCount: 5,
        vectorBytes: 5 * 384 * 4,
      },
    });
    expect(calls.flat()).toEqual(splitMarkdownStructures(STRUCTURED_BODY).map(({ text }) => text));
    const generation = join(
      knowledge,
      'projects',
      PROJECT_ID,
      '.buildlore',
      'indexes',
      'semantic',
      'generations',
      result.manifest.generationId,
    );
    expect((await readdir(generation)).sort()).toEqual([
      'checksums.json',
      'chunks.jsonl',
      'manifest.json',
      'vectors.f32',
    ]);
    expect((await readFile(join(generation, 'vectors.f32'))).byteLength)
      .toBe(result.manifest.rowCount * 384 * 4);
    expect(await readFile(join(generation, 'chunks.jsonl'), 'utf8'))
      .not.toContain('Atomic semantic storage');
    await expect(service.status(PROJECT_ID)).resolves.toMatchObject({ state: 'ready' });

    const firstText = splitMarkdownStructures(STRUCTURED_BODY)[0]?.text;
    if (firstText === undefined) throw new Error('Fixture is incomplete.');
    const search = await service.searchExact(PROJECT_ID, vectorFor(firstText), 3);
    expect(search.hits).toHaveLength(3);
    expect(search.hits[0]).toMatchObject({
      pageId: 'semantic-fixture/guide',
      sectionId: 'main',
    });
    expect(search.hits[0]?.score).toBeCloseTo(1, 6);
    expect(JSON.stringify(search)).not.toContain(firstText);
  });

  it('[HSW-V-14] reuses unchanged content across add/change/delete/rename like a clean build', async () => {
    const incrementalKnowledge = await knowledgeFixture();
    const fullKnowledge = await knowledgeFixture();
    const incrementalCalls: string[][] = [];
    const fullCalls: string[][] = [];
    const first = corpus([
      page('guides/keep', 'Keep this paragraph unchanged. [^citation-guides-keep]', '1'),
      page('guides/change', 'Change the old paragraph. [^citation-guides-change]', '2'),
      page('guides/delete', 'Delete this paragraph. [^citation-guides-delete]', '3'),
      page('guides/rename', 'Rename but retain this text. [^citation-shared-rename]', '4'),
    ], '5');
    const second = corpus([
      page('guides/keep', 'Keep this paragraph unchanged. [^citation-guides-keep]', '1'),
      page('guides/change', 'Change the new paragraph. [^citation-guides-change]', '6'),
      page('guides/renamed', 'Rename but retain this text. [^citation-shared-rename]', '4'),
      page('guides/add', 'Add this paragraph. [^citation-guides-add]', '7'),
    ], '8');
    const incremental = createFlatFileVectorIndex(incrementalKnowledge);
    await incremental.buildFull(buildInput(first, fakeProvider(incrementalCalls)));
    incrementalCalls.splice(0);
    const updated = await incremental.buildIncremental(
      buildInput(second, fakeProvider(incrementalCalls)),
    );
    expect(updated.ledger).toMatchObject({
      createdRows: 2,
      deletedRows: 3,
      effectiveMode: 'incremental',
      reusedRows: 2,
    });
    expect(incrementalCalls.flat()).toHaveLength(2);

    const full = createFlatFileVectorIndex(fullKnowledge);
    const rebuilt = await full.buildFull(buildInput(second, fakeProvider(fullCalls)));
    const relative = (...parts: string[]) => join(
      'projects', PROJECT_ID, '.buildlore', 'indexes', 'semantic', 'generations', ...parts,
    );
    const [incrementalChunks, fullChunks, incrementalVectors, fullVectors] = await Promise.all([
      readFile(join(incrementalKnowledge, relative(updated.manifest.generationId, 'chunks.jsonl'))),
      readFile(join(fullKnowledge, relative(rebuilt.manifest.generationId, 'chunks.jsonl'))),
      readFile(join(incrementalKnowledge, relative(updated.manifest.generationId, 'vectors.f32'))),
      readFile(join(fullKnowledge, relative(rebuilt.manifest.generationId, 'vectors.f32'))),
    ]);
    expect(incrementalChunks).toEqual(fullChunks);
    expect(incrementalVectors).toEqual(fullVectors);
    const query = vectorFor('Rename but retain this text. [^citation-shared-rename]');
    await expect(incremental.searchExact(PROJECT_ID, query, 4)).resolves.toEqual(
      await full.searchExact(PROJECT_ID, query, 4),
    );
  });

  it('holds the activation guard across active selection and also checks unchanged success',
    async () => {
      const knowledge = await knowledgeFixture();
      const calls: string[][] = [];
      const value = corpus([page('semantic-fixture/guide', STRUCTURED_BODY, 'a')], 'b');
      const service = createFlatFileVectorIndex(knowledge);
      const activePath = join(
        knowledge,
        'projects',
        PROJECT_ID,
        '.buildlore',
        'indexes',
        'semantic',
        'active.json',
      );
      const events: string[] = [];
      const guard: SemanticIndexActivationGuardV1 = async (candidate, activate) => {
        events.push(`before:${candidate.manifestDigest}`);
        await expect(readFile(activePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        const result = await activate();
        events.push(`after:${candidate.manifestDigest}`);
        expect(await readFile(activePath, 'utf8')).toContain(candidate.manifestDigest);
        return result;
      };
      const first = await service.buildFull({
        ...buildInput(value, fakeProvider(calls)),
        activationGuard: guard,
      });
      expect(events).toEqual([
        `before:${first.manifest.manifestDigest}`,
        `after:${first.manifest.manifestDigest}`,
      ]);

      let unchangedGuardCalls = 0;
      const unchanged = await service.buildIncremental({
        ...buildInput(value, fakeProvider(calls)),
        activationGuard: async (candidate, activate) => {
          unchangedGuardCalls += 1;
          expect(candidate.manifestDigest).toBe(first.manifest.manifestDigest);
          return activate();
        },
      });
      expect(unchanged.outcome).toBe('unchanged');
      expect(unchangedGuardCalls).toBe(1);
    });

  it('rejects stale full, resume and import selectors while preserving the prior active pointer',
    async () => {
      const knowledge = await knowledgeFixture();
      const service = createFlatFileVectorIndex(knowledge);
      const initial = corpus([
        page('semantic-fixture/guide', 'Initial content. [^citation-guide]', 'a'),
      ], 'b');
      const changed = corpus([
        page('semantic-fixture/guide', 'Changed content. [^citation-guide]', 'c'),
      ], 'd');
      const healthy = await service.buildFull(buildInput(initial, fakeProvider([])));
      const rejectGuard: SemanticIndexActivationGuardV1 = () => Promise.reject(
        new SemanticIndexError('SEMANTIC_INDEX_INCOMPATIBLE', 'lineage-drift'),
      );
      const changedCalls: string[][] = [];
      await expect(service.buildFull({
        ...buildInput(changed, fakeProvider(changedCalls)),
        activationGuard: rejectGuard,
      })).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_INCOMPATIBLE',
        reasonCode: 'lineage-drift',
      });
      await expect(service.openActive(PROJECT_ID)).resolves.toMatchObject({
        manifest: { manifestDigest: healthy.manifest.manifestDigest },
      });
      const callsBeforeResume = changedCalls.flat().length;
      await expect(service.resume({
        ...buildInput(changed, fakeProvider(changedCalls)),
        activationGuard: rejectGuard,
      })).rejects.toMatchObject({ reasonCode: 'lineage-drift' });
      expect(changedCalls.flat()).toHaveLength(callsBeforeResume);
      await expect(service.openActive(PROJECT_ID)).resolves.toMatchObject({
        manifest: { manifestDigest: healthy.manifest.manifestDigest },
      });

      const sourceKnowledge = await knowledgeFixture();
      const source = createFlatFileVectorIndex(sourceKnowledge);
      const sourceBuild = await source.buildFull(buildInput(changed, fakeProvider([])));
      const bundleRoot = await mkdtemp(join(process.cwd(), '.test-tmp-semantic-guard-bundle-'));
      roots.push(bundleRoot);
      const bundle = join(bundleRoot, 'bundle');
      await source.exportBundle({ destinationDirectory: bundle, projectId: PROJECT_ID });
      await expect(service.importBundle({
        activationGuard: rejectGuard,
        bundleDirectory: bundle,
        corpusDigest: changed.corpusDigest,
        embeddingIdentity: embeddingIdentity(),
        projectId: PROJECT_ID,
        sanitizerPolicyDigest: digest('f'),
      })).rejects.toMatchObject({ reasonCode: 'lineage-drift' });
      expect(sourceBuild.manifest.manifestDigest).not.toBe(healthy.manifest.manifestDigest);
      await expect(service.openActive(PROJECT_ID)).resolves.toMatchObject({
        manifest: { manifestDigest: healthy.manifest.manifestDigest },
      });
    });

  it('[HSW-V-14] resumes an interrupted staging generation through normal rebuild', async () => {
    const knowledge = await knowledgeFixture();
    const calls: string[][] = [];
    const body = Array.from({ length: 40 }, (_value, index) =>
      `Paragraph ${index} has deterministic content. [^citation-bulk-page]`).join('\n\n');
    const value = corpus([page('bulk/page', body, 'a')], 'b');
    let interrupted = false;
    const service = createFlatFileVectorIndexForTest(knowledge, {
      afterBatch: () => {
        if (!interrupted) {
          interrupted = true;
          throw new Error('injected interruption');
        }
      },
    });
    await expect(service.buildFull(buildInput(value, fakeProvider(calls)))).rejects.toMatchObject({
      code: 'SEMANTIC_INDEX_BUILD_INCOMPLETE',
      reasonCode: 'build-interrupted',
    });
    await expect(service.status(PROJECT_ID)).resolves.toEqual({
      projectId: PROJECT_ID,
      state: 'none',
    });
    const resumed = await service.buildFull(buildInput(value, fakeProvider(calls)));
    expect(resumed.manifest.rowCount).toBe(40);
    expect(resumed.ledger.createdRows).toBe(40);
    expect(calls.map((batch) => batch.length)).toEqual([32, 8]);
    await expect(service.status(PROJECT_ID)).resolves.toMatchObject({ state: 'ready' });
  });

  it('[HSW-V-14] resumes pending finalization and retains the prior healthy generation', async () => {
    const knowledge = await knowledgeFixture();
    const calls: string[][] = [];
    let interruptPending = false;
    let interrupted = false;
    const service = createFlatFileVectorIndexForTest(knowledge, {
      afterPendingWrite: () => {
        if (interruptPending && !interrupted) {
          interrupted = true;
          throw new Error('injected pending interruption');
        }
      },
    });
    const initial = corpus([
      page('semantic-fixture/guide', 'Initial healthy content. [^citation-guide]', 'a'),
    ], 'b');
    const healthy = await service.buildFull(buildInput(initial, fakeProvider(calls)));
    const changed = corpus([
      page('semantic-fixture/guide', 'Replacement content. [^citation-guide]', 'c'),
    ], 'd');
    interruptPending = true;
    await expect(service.buildIncremental(buildInput(changed, fakeProvider(calls))))
      .rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_BUILD_INCOMPLETE',
        reasonCode: 'build-interrupted',
      });
    await expect(service.openActive(PROJECT_ID)).resolves.toMatchObject({
      manifest: { manifestDigest: healthy.manifest.manifestDigest },
    });
    const callCountAfterInterruption = calls.flat().length;
    const recovered = await service.buildIncremental(buildInput(changed, fakeProvider(calls)));
    expect(recovered).toMatchObject({
      ledger: { effectiveMode: 'incremental', recoveryState: 'complete' },
      outcome: 'activated',
    });
    expect(calls.flat()).toHaveLength(callCountAfterInterruption);
    await expect(service.openActive(PROJECT_ID)).resolves.toMatchObject({
      manifest: { manifestDigest: recovered.manifest.manifestDigest },
    });
  });

  it('quarantines a stale pending build and continues with the current approved corpus', async () => {
    const knowledge = await knowledgeFixture();
    const calls: string[][] = [];
    let interrupt = true;
    const service = createFlatFileVectorIndexForTest(knowledge, {
      afterPendingWrite: () => {
        if (interrupt) {
          interrupt = false;
          throw new Error('injected stale pending');
        }
      },
    });
    const stale = corpus([
      page('semantic-fixture/guide', 'Stale content. [^citation-guide]', 'a'),
    ], 'b');
    await expect(service.buildFull(buildInput(stale, fakeProvider(calls))))
      .rejects.toMatchObject({ code: 'SEMANTIC_INDEX_BUILD_INCOMPLETE' });
    const current = corpus([
      page('semantic-fixture/guide', 'Current content. [^citation-guide]', 'c'),
    ], 'd');
    const recovered = await service.buildIncremental(buildInput(current, fakeProvider(calls)));
    expect(recovered).toMatchObject({
      ledger: { effectiveMode: 'full', inputCorpusDigest: current.corpusDigest },
      outcome: 'activated',
    });
    const quarantine = join(
      knowledge, 'projects', PROJECT_ID, '.buildlore', 'indexes', 'semantic', 'quarantine',
    );
    const names = await readdir(quarantine);
    expect(names.some((name) => name.startsWith('pending-'))).toBe(true);
    expect(names.some((name) => name.startsWith('stage-'))).toBe(true);
  });

  it('does not satisfy an explicit full request by activating incremental pending work', async () => {
    const knowledge = await knowledgeFixture();
    const calls: string[][] = [];
    let interrupt = false;
    const service = createFlatFileVectorIndexForTest(knowledge, {
      afterPendingWrite: () => {
        if (interrupt) {
          interrupt = false;
          throw new Error('injected incremental pending');
        }
      },
    });
    const initial = corpus([
      page('semantic-fixture/guide', 'Initial content. [^citation-guide]', 'a'),
    ], 'b');
    await service.buildFull(buildInput(initial, fakeProvider(calls)));
    const changed = corpus([
      page('semantic-fixture/guide', 'Changed content. [^citation-guide]', 'c'),
    ], 'd');
    interrupt = true;
    await expect(service.buildIncremental(buildInput(changed, fakeProvider(calls))))
      .rejects.toMatchObject({ code: 'SEMANTIC_INDEX_BUILD_INCOMPLETE' });
    calls.splice(0);
    const rebuilt = await service.buildFull(buildInput(changed, fakeProvider(calls)));
    expect(rebuilt.ledger).toMatchObject({
      createdRows: 1,
      effectiveMode: 'full',
      requestedMode: 'full',
    });
    expect(calls.flat()).toHaveLength(1);
  });

  it('quarantines an interrupted stage initialization and rebuilds normally', async () => {
    const knowledge = await knowledgeFixture();
    let interrupt = true;
    const service = createFlatFileVectorIndexForTest(knowledge, {
      afterStageDirectoryCreate: () => {
        if (interrupt) {
          interrupt = false;
          throw new Error('injected stage initialization interruption');
        }
      },
    });
    const value = corpus([
      page('semantic-fixture/guide', 'Recover stage initialization. [^citation-guide]', 'a'),
    ], 'b');
    await expect(service.buildFull(buildInput(value, fakeProvider([]))))
      .rejects.toMatchObject({ code: 'SEMANTIC_INDEX_BUILD_INCOMPLETE' });
    await expect(service.buildFull(buildInput(value, fakeProvider([]))))
      .resolves.toMatchObject({ outcome: 'activated' });
    const quarantine = join(
      knowledge, 'projects', PROJECT_ID, '.buildlore', 'indexes', 'semantic', 'quarantine',
    );
    expect((await readdir(quarantine)).some((name) => name.startsWith('stage-'))).toBe(true);
  });

  it('quarantines a stage containing an abandoned atomic temporary file', async () => {
    const knowledge = await knowledgeFixture();
    let interrupt = true;
    const service = createFlatFileVectorIndexForTest(knowledge, {
      afterBatch: () => {
        if (interrupt) {
          interrupt = false;
          throw new Error('injected atomic write interruption');
        }
      },
    });
    const value = corpus([
      page('semantic-fixture/guide', 'Recover atomic temporary state. [^citation-guide]', 'a'),
    ], 'b');
    await expect(service.buildFull(buildInput(value, fakeProvider([]))))
      .rejects.toMatchObject({ code: 'SEMANTIC_INDEX_BUILD_INCOMPLETE' });
    const staging = join(
      knowledge, 'projects', PROJECT_ID, '.buildlore', 'indexes', 'semantic', 'staging',
    );
    const stageName = (await readdir(staging)).find((name) => name.startsWith('build-'));
    if (stageName === undefined) throw new Error('Interrupted stage is missing.');
    await writeFile(
      join(staging, stageName, '.build-state.json.00000000-0000-4000-8000-000000000000.tmp'),
      'partial',
      'utf8',
    );
    await expect(service.buildFull(buildInput(value, fakeProvider([]))))
      .resolves.toMatchObject({ outcome: 'activated' });
    const quarantine = join(
      knowledge, 'projects', PROJECT_ID, '.buildlore', 'indexes', 'semantic', 'quarantine',
    );
    expect((await readdir(quarantine)).some((name) => name.startsWith('stage-'))).toBe(true);
  });

  it('keeps the prior active generation when ledger persistence is interrupted', async () => {
    const knowledge = await knowledgeFixture();
    const calls: string[][] = [];
    let interrupt = false;
    const service = createFlatFileVectorIndexForTest(knowledge, {
      beforeLedgerPersist: () => {
        if (interrupt) {
          interrupt = false;
          throw new Error('injected ledger interruption');
        }
      },
    });
    const initial = corpus([
      page('semantic-fixture/guide', 'Healthy content. [^citation-guide]', 'a'),
    ], 'b');
    const healthy = await service.buildFull(buildInput(initial, fakeProvider(calls)));
    const changed = corpus([
      page('semantic-fixture/guide', 'Replacement content. [^citation-guide]', 'c'),
    ], 'd');
    interrupt = true;
    await expect(service.buildIncremental(buildInput(changed, fakeProvider(calls))))
      .rejects.toMatchObject({ code: 'SEMANTIC_INDEX_BUILD_INCOMPLETE' });
    await expect(service.openActive(PROJECT_ID)).resolves.toMatchObject({
      manifest: { manifestDigest: healthy.manifest.manifestDigest },
    });
    const callsAfterInterruption = calls.flat().length;
    const recovered = await service.buildIncremental(buildInput(changed, fakeProvider(calls)));
    expect(calls.flat()).toHaveLength(callsAfterInterruption);
    await expect(service.openActive(PROJECT_ID)).resolves.toMatchObject({
      manifest: { manifestDigest: recovered.manifest.manifestDigest },
    });
  });

  it('honors an explicit full rebuild even when the active corpus is unchanged', async () => {
    const knowledge = await knowledgeFixture();
    const calls: string[][] = [];
    const value = corpus([page('semantic-fixture/guide', STRUCTURED_BODY, 'a')], 'b');
    const service = createFlatFileVectorIndex(knowledge);
    const first = await service.buildFull(buildInput(value, fakeProvider(calls)));
    calls.splice(0);
    const rebuilt = await service.buildFull(buildInput(value, fakeProvider(calls)));
    expect(rebuilt).toMatchObject({
      ledger: { createdRows: 5, effectiveMode: 'full', requestedMode: 'full' },
      outcome: 'activated',
    });
    expect(rebuilt.manifest.manifestDigest).toBe(first.manifest.manifestDigest);
    expect(calls.flat()).toHaveLength(5);
  });

  it('fails closed on a corrupt active generation until an explicit full rebuild quarantines it',
    async () => {
      const knowledge = await knowledgeFixture();
      const value = corpus([page('semantic-fixture/guide', STRUCTURED_BODY, 'a')], 'b');
      const service = createFlatFileVectorIndex(knowledge);
      const healthy = await service.buildFull(buildInput(value, fakeProvider([])));
      const generations = join(
        knowledge,
        'projects',
        PROJECT_ID,
        '.buildlore',
        'indexes',
        'semantic',
        'generations',
      );
      const vectorPath = join(generations, healthy.manifest.generationId, 'vectors.f32');
      const handle = await open(vectorPath, 'r+');
      await handle.truncate(4);
      await handle.close();
      await expect(service.buildIncremental(buildInput(value, fakeProvider([]))))
        .rejects.toMatchObject({ code: 'SEMANTIC_INDEX_INCOMPATIBLE' });

      const calls: string[][] = [];
      const rebuilt = await service.buildFull(buildInput(value, fakeProvider(calls)));
      expect(rebuilt.manifest.manifestDigest).toBe(healthy.manifest.manifestDigest);
      expect(calls.flat()).toHaveLength(5);
      expect((await readdir(generations)).some((name) => name.startsWith('quarantine-')))
        .toBe(true);
      await expect(service.status(PROJECT_ID)).resolves.toMatchObject({ state: 'ready' });
    });

  it('[HSW-V-15][HSW-V-19] exports/imports a model-free bundle and rejects corruption', async () => {
    const sourceKnowledge = await knowledgeFixture();
    const targetKnowledge = await knowledgeFixture();
    const calls: string[][] = [];
    const value = corpus([page('semantic-fixture/guide', STRUCTURED_BODY, 'a')], 'b');
    const source = createFlatFileVectorIndex(sourceKnowledge);
    const built = await source.buildFull(buildInput(value, fakeProvider(calls)));
    const bundleRoot = await mkdtemp(join(process.cwd(), '.test-tmp-semantic-bundle-'));
    roots.push(bundleRoot);
    const bundle = join(bundleRoot, 'bundle');
    await expect(source.exportBundle({
      destinationDirectory: bundle,
      projectId: PROJECT_ID,
    })).resolves.toMatchObject({ fileCount: 4, manifestDigest: built.manifest.manifestDigest });
    expect((await readdir(bundle)).sort()).toEqual([
      'checksums.json',
      'chunks.jsonl',
      'manifest.json',
      'vectors.f32',
    ]);
    const bundleText = `${await readFile(join(bundle, 'manifest.json'), 'utf8')}\n${
      await readFile(join(bundle, 'chunks.jsonl'), 'utf8')}`;
    expect(bundleText).not.toContain('Atomic semantic storage');
    expect(bundleText).not.toContain(process.cwd());

    const target = createFlatFileVectorIndex(targetKnowledge);
    await expect(target.importBundle({
      bundleDirectory: bundle,
      corpusDigest: value.corpusDigest,
      embeddingIdentity: embeddingIdentity(),
      projectId: PROJECT_ID,
      sanitizerPolicyDigest: digest('f'),
    })).resolves.toMatchObject({ fileCount: 4 });
    const query = vectorFor(splitMarkdownStructures(STRUCTURED_BODY)[0]?.text ?? 'missing');
    await expect(target.searchExact(PROJECT_ID, query, 5)).resolves.toEqual(
      await source.searchExact(PROJECT_ID, query, 5),
    );
    expect(calls.flat()).toHaveLength(5);

    const vectorPath = join(
      targetKnowledge,
      'projects',
      PROJECT_ID,
      '.buildlore',
      'indexes',
      'semantic',
      'generations',
      built.manifest.generationId,
      'vectors.f32',
    );
    const handle = await open(vectorPath, 'r+');
    await handle.truncate(4);
    await handle.close();
    await expect(target.status(PROJECT_ID)).resolves.toMatchObject({
      recoveryAction: ['index', 'rebuild', '--full', '--project', PROJECT_ID],
      state: 'incompatible',
    });
    await expect(target.searchExact(PROJECT_ID, query, 5)).rejects.toMatchObject({
      code: 'SEMANTIC_INDEX_INCOMPATIBLE',
    });
  });

  it('[HSW-SC-28] rejects non-finite vectors and manifest count, dimension, digest, and size drift',
    async () => {
      const sourceKnowledge = await knowledgeFixture();
      const value = corpus([page('semantic-fixture/guide', STRUCTURED_BODY, 'a')], 'b');
      const source = createFlatFileVectorIndex(sourceKnowledge);
      await source.buildFull(buildInput(value, fakeProvider([])));
      const bundleRoot = await mkdtemp(join(process.cwd(), '.test-tmp-semantic-faults-'));
      roots.push(bundleRoot);
      const bundle = join(bundleRoot, 'bundle');
      await source.exportBundle({ destinationDirectory: bundle, projectId: PROJECT_ID });
      const manifestPath = join(bundle, 'manifest.json');
      const originalManifestSource = await readFile(manifestPath, 'utf8');
      const originalManifest = JSON.parse(originalManifestSource) as Record<string, unknown>;

      const rehash = (value: Record<string, unknown>): Record<string, unknown> => {
        const { manifestDigest: ignored, ...basis } = value;
        void ignored;
        return { ...basis, manifestDigest: digestHierarchyValue(basis) };
      };
      const manifestFaults: readonly Readonly<{
        readonly name: string;
        readonly mutate: (value: Record<string, unknown>) => Record<string, unknown>;
      }>[] = [
        {
          name: 'row count',
          mutate: (manifest) => rehash({ ...manifest, rowCount: 2, vectorBytes: 2 * 384 * 4 }),
        },
        {
          name: 'dimension',
          mutate: (manifest) => ({ ...manifest, dimensions: 383 }),
        },
        {
          name: 'manifest digest',
          mutate: (manifest) => ({ ...manifest, manifestDigest: digest('0') }),
        },
        {
          name: 'metadata size limit',
          mutate: (manifest) => ({
            ...manifest,
            metadataBytes: SEMANTIC_INDEX_LIMITS.maximumMetadataBytes + 1,
          }),
        },
      ];
      for (const fault of manifestFaults) {
        await writeFile(
          manifestPath,
          serializeCanonicalJson(fault.mutate({ ...originalManifest })),
          'utf8',
        );
        const target = createFlatFileVectorIndex(await knowledgeFixture());
        await expect(target.importBundle({
          bundleDirectory: bundle,
          corpusDigest: value.corpusDigest,
          embeddingIdentity: embeddingIdentity(),
          projectId: PROJECT_ID,
          sanitizerPolicyDigest: digest('f'),
        }), fault.name).rejects.toMatchObject({ code: 'SEMANTIC_INDEX_INCOMPATIBLE' });
        await writeFile(manifestPath, originalManifestSource, 'utf8');
      }

      const checksumsPath = join(bundle, 'checksums.json');
      const chunksBytes = await readFile(join(bundle, 'chunks.jsonl'));
      const vectorsPath = join(bundle, 'vectors.f32');
      const vectorBytes = await readFile(vectorsPath);
      new DataView(vectorBytes.buffer, vectorBytes.byteOffset, vectorBytes.byteLength)
        .setFloat32(0, Number.POSITIVE_INFINITY, true);
      await writeFile(vectorsPath, vectorBytes);
      const originalChecksums = JSON.parse(
        await readFile(checksumsPath, 'utf8'),
      ) as Record<string, unknown>;
      const components = [
        {
          basename: 'chunks.jsonl',
          bytes: chunksBytes.byteLength,
          sha256: `sha256:${createHash('sha256').update(chunksBytes).digest('hex')}`,
        },
        {
          basename: 'vectors.f32',
          bytes: vectorBytes.byteLength,
          sha256: `sha256:${createHash('sha256').update(vectorBytes).digest('hex')}`,
        },
      ];
      const checksumsBasis = {
        schemaVersion: originalChecksums.schemaVersion,
        components,
      };
      const checksums = {
        ...checksumsBasis,
        checksumsDigest: digestHierarchyValue(checksumsBasis),
      };
      await writeFile(checksumsPath, serializeCanonicalJson(checksums), 'utf8');
      const nonFiniteManifest = rehash({
        ...originalManifest,
        componentChecksums: components,
        checksumsDigest: checksums.checksumsDigest,
      });
      await writeFile(manifestPath, serializeCanonicalJson(nonFiniteManifest), 'utf8');
      const nonFiniteTarget = createFlatFileVectorIndex(await knowledgeFixture());
      await expect(nonFiniteTarget.importBundle({
        bundleDirectory: bundle,
        corpusDigest: value.corpusDigest,
        embeddingIdentity: embeddingIdentity(),
        projectId: PROJECT_ID,
        sanitizerPolicyDigest: digest('f'),
      })).rejects.toMatchObject({ code: 'SEMANTIC_INDEX_INCOMPATIBLE' });
    });

  it('fails before activation on truncation and lock contention while retaining the prior index', async () => {
    const knowledge = await knowledgeFixture();
    const value = corpus([page('semantic-fixture/guide', STRUCTURED_BODY, 'a')], 'b');
    const service = createFlatFileVectorIndex(knowledge);
    const healthy = await service.buildFull(buildInput(value, fakeProvider([])));
    const changed = corpus([page(
      'semantic-fixture/guide',
      `${STRUCTURED_BODY}\n\nA changed paragraph. [^citation-semantic-fixture-guide]`,
      'c',
    )], 'd');
    await expect(service.buildIncremental(
      buildInput(changed, fakeProvider([], { truncated: true })),
    )).rejects.toMatchObject({
      code: 'SEMANTIC_INDEX_DOCUMENT_TRUNCATED',
      reasonCode: 'truncated-document',
    });
    await expect(service.openActive(PROJECT_ID)).resolves.toMatchObject({
      manifest: { manifestDigest: healthy.manifest.manifestDigest },
    });

    const lock = join(
      knowledge,
      'projects',
      PROJECT_ID,
      '.buildlore',
      'indexes',
      'semantic',
      'build.lock',
    );
    await writeFile(lock, 'held\n', { encoding: 'utf8', flag: 'wx' });
    await expect(service.buildIncremental(buildInput(changed, fakeProvider([]))))
      .rejects.toMatchObject({ code: 'SEMANTIC_INDEX_BUSY', reasonCode: 'lock-busy' });
    expect(SEMANTIC_INDEX_LIMITS).toMatchObject({
      maximumBatchSize: 32,
      maximumChunks: 50_000,
      maximumGenerationBytes: 268_435_456,
      maximumMetadataBytes: 134_217_728,
      maximumVectorBytes: 76_800_000,
    });
  });

  it('recovers a canonical build lock whose owner process no longer exists', async () => {
    const knowledge = await knowledgeFixture();
    const initial = corpus([
      page('semantic-fixture/guide', 'Initial content. [^citation-guide]', 'a'),
    ], 'b');
    const service = createFlatFileVectorIndex(knowledge);
    await service.buildFull(buildInput(initial, fakeProvider([])));
    const semanticRoot = join(
      knowledge,
      'projects',
      PROJECT_ID,
      '.buildlore',
      'indexes',
      'semantic',
    );
    const lock = join(semanticRoot, 'build.lock');
    await writeFile(lock, `${JSON.stringify({
      schemaVersion: 'buildlore.semantic-index-lock.v1',
      ownerProcessId: 2_147_483_647,
      ownerProcessStartTime: null,
      createdAtMilliseconds: Date.now(),
      nonce: 'a'.repeat(32),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const changed = corpus([
      page('semantic-fixture/guide', 'Changed content. [^citation-guide]', 'c'),
    ], 'd');
    await expect(service.buildIncremental(buildInput(changed, fakeProvider([]))))
      .resolves.toMatchObject({ outcome: 'activated' });
    expect(await readdir(semanticRoot)).not.toContain('build.lock');
  });

  it('recovers a lock after PID reuse is detected from the process start time', async () => {
    const knowledge = await knowledgeFixture();
    const initial = corpus([
      page('semantic-fixture/guide', 'Initial content. [^citation-guide]', 'a'),
    ], 'b');
    const service = createFlatFileVectorIndex(knowledge);
    await service.buildFull(buildInput(initial, fakeProvider([])));
    const semanticRoot = join(
      knowledge, 'projects', PROJECT_ID, '.buildlore', 'indexes', 'semantic',
    );
    await writeFile(join(semanticRoot, 'build.lock'), `${JSON.stringify({
      schemaVersion: 'buildlore.semantic-index-lock.v1',
      ownerProcessId: process.pid,
      ownerProcessStartTime: '0',
      createdAtMilliseconds: Date.now(),
      nonce: 'b'.repeat(32),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const changed = corpus([
      page('semantic-fixture/guide', 'Changed content. [^citation-guide]', 'c'),
    ], 'd');
    await expect(service.buildIncremental(buildInput(changed, fakeProvider([]))))
      .resolves.toMatchObject({ outcome: 'activated' });
  });

  it('keeps the public chunker schema pinned to the runtime identity', async () => {
    const schema = JSON.parse(await readFile(
      new URL('../schemas/semantic-index.schema.json', import.meta.url),
      'utf8',
    )) as { $defs: { chunker: { properties: { identityDigest: { const: string } } } } };
    const { SEMANTIC_CHUNKER_IDENTITY } = await import(
      '../src/retrieval/vector-index/chunking.js'
    );
    expect(schema.$defs.chunker.properties.identityDigest.const)
      .toBe(SEMANTIC_CHUNKER_IDENTITY.identityDigest);
  });
});
