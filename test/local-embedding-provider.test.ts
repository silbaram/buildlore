import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  createEmbeddingIdentityV2,
  MULTILINGUAL_E5_SMALL_PROFILE,
  type EmbeddingArtifactIdentityV2,
} from '../src/retrieval/embedding/index.js';
import { LocalModelDirectoryHandle } from '../src/retrieval/embedding/model-binding.js';
import {
  createLocalEmbeddingProviderForTest as createLocalEmbeddingProvider,
  type LocalEmbeddingRuntime,
  type LocalEmbeddingRuntimeFactory,
} from '../src/retrieval/embedding/provider.js';

function handle(directory = '/private/user/model'): LocalModelDirectoryHandle {
  const dynamic = `sha256:${'2'.repeat(64)}` as const;
  const artifacts: EmbeddingArtifactIdentityV2[] = [
    { basename: 'config.json', bytes: 512, role: 'model-config', sha256: dynamic },
    {
      basename: 'onnx/model.onnx', bytes: 1024, role: 'model',
      sha256: 'sha256:ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
    },
    {
      basename: 'tokenizer.json', bytes: 1024, role: 'tokenizer',
      sha256: 'sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    },
    { basename: 'tokenizer_config.json', bytes: 256, role: 'tokenizer-config', sha256: dynamic },
  ];
  return new LocalModelDirectoryHandle(
    'multilingual-e5-small',
    directory,
    createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, artifacts),
  );
}

function vector(): Float32Array {
  const result = new Float32Array(384);
  result[0] = 1;
  return result;
}

function factory(
  open: (directory: string) => Promise<LocalEmbeddingRuntime>,
): LocalEmbeddingRuntimeFactory {
  return Object.freeze({ open });
}

describe('local embedding provider', () => {
  it('pins the package-root CPU adapter and disables remote models, caches, and fetch', async () => {
    const source = await readFile(
      new URL('../src/retrieval/embedding/provider.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("'@huggingface/transformers'");
    expect(source).not.toMatch(/@huggingface\/transformers\//u);
    expect(source).toContain("device: 'cpu'");
    expect(source).toContain('allowRemoteModels = false');
    expect(source).toContain('local_files_only: true');
    expect(source).toContain('useFSCache = false');
    expect(source).toContain('useBrowserCache = false');
    expect(source).toContain('useWasmCache = false');
    expect(source).toContain('BUILDLore_LOCAL_NETWORK_DISABLED');
    expect(source).toContain('withVerifiedLocalModelDirectory');
    expect(source).not.toContain('resolveDirectoryForInternalUse');
    expect(source).not.toMatch(/cuda|auto_device|remoteHost\s*=/iu);
  });

  it('initializes lazily and emits E5-prefixed normalized Float32 vectors without egress', async () => {
    const bound = handle();
    const seen: string[][] = [];
    let opens = 0;
    const provider = createLocalEmbeddingProvider({
      hubRoot: '/hub',
      resolveBinding: () => Promise.resolve(bound),
      runtimeFactory: factory(() => {
        opens += 1;
        return Promise.resolve({
          countTokens(prefixedTexts) {
            seen.push([...prefixedTexts]);
            return Promise.resolve(prefixedTexts.map((text) => Array.from(text).length));
          },
          embed(prefixedTexts) {
            seen.push([...prefixedTexts]);
            return Promise.resolve({
              truncated: prefixedTexts.map(() => false),
              vectors: prefixedTexts.map(() => vector()),
            });
          },
        });
      }),
    });

    expect(provider.readiness()).toEqual({ state: 'none' });
    expect(provider.activeIdentity()).toBeNull();
    expect(provider.inspectCapabilities()).toEqual({
      adapterKind: 'transformers-js',
      device: 'cpu',
      egress: 'none',
      maximumBatchSize: 32,
      maximumQueryUtf8Bytes: 4096,
      networkAllowed: false,
      providerUsed: 'local-in-process',
    });
    const counts = await provider.countDocumentTokens(['안내', 'Guide']);
    const documents = await provider.embedDocuments(['안내', 'Guide']);
    const query = await provider.embedQuery('검색');
    expect(opens).toBe(1);
    expect(seen).toEqual([
      ['passage: 안내', 'passage: Guide'],
      ['passage: 안내', 'passage: Guide'],
      ['query: 검색'],
      ['query: 검색'],
    ]);
    expect(counts).toMatchObject({ maximumTokens: 512, tokenCounts: [11, 14] });
    expect(documents).toMatchObject({ egress: 'none', providerUsed: 'local-in-process' });
    expect(documents.vectors.every((item) => item instanceof Float32Array && item.length === 384))
      .toBe(true);
    expect(query.identity.identityDigest).toBe(bound.identity.identityDigest);
    expect(provider.readiness()).toMatchObject({ state: 'ready' });
    expect(JSON.stringify(provider.readiness())).not.toContain('/private/user/model');
  });

  it('accepts Markdown document formatting but keeps query controls fail-closed', async () => {
    const seen: string[][] = [];
    const provider = createLocalEmbeddingProvider({
      hubRoot: '/hub',
      resolveBinding: () => Promise.resolve(handle()),
      runtimeFactory: factory(() => Promise.resolve({
        embed(prefixedTexts) {
          seen.push([...prefixedTexts]);
          return Promise.resolve({
            truncated: prefixedTexts.map(() => false),
            vectors: prefixedTexts.map(() => vector()),
          });
        },
      })),
    });
    const markdown = '- first row\n\tcontinued row\n- final row';
    await expect(provider.embedDocuments([markdown])).resolves.toMatchObject({
      truncated: [false],
    });
    expect(seen).toEqual([[`passage: ${markdown}`]]);
    await expect(provider.embedQuery('first row\nfinal row')).rejects.toMatchObject({
      code: 'LOCAL_EMBEDDING_CONFIG_INVALID',
    });
    expect(seen).toHaveLength(1);
  });

  it('rejects invalid and oversized input before resolving or opening the runtime', async () => {
    let resolves = 0;
    const provider = createLocalEmbeddingProvider({
      hubRoot: '/hub',
      resolveBinding: () => {
        resolves += 1;
        return Promise.resolve(handle());
      },
      runtimeFactory: factory(() => Promise.reject(new Error('must not open'))),
    });
    await expect(provider.embedQuery('a'.repeat(4097))).rejects.toMatchObject({
      code: 'LOCAL_EMBEDDING_CONFIG_INVALID',
    });
    await expect(provider.embedQuery('bad\u0000query')).rejects.toMatchObject({
      code: 'LOCAL_EMBEDDING_CONFIG_INVALID',
    });
    await expect(provider.embedDocuments(Array.from({ length: 33 }, () => 'document')))
      .rejects.toMatchObject({ code: 'LOCAL_EMBEDDING_CONFIG_INVALID' });
    expect(resolves).toBe(0);
  });

  it('rejects an over-token query before vector inference and preserves the ready runtime', async () => {
    let disposeCalls = 0;
    let embedCalls = 0;
    const provider = createLocalEmbeddingProvider({
      hubRoot: '/hub',
      resolveBinding: () => Promise.resolve(handle()),
      runtimeFactory: factory(() => Promise.resolve({
        countTokens(prefixedTexts) {
          return Promise.resolve(prefixedTexts.map((text) => text.length > 1_000 ? 513 : 12));
        },
        dispose() {
          disposeCalls += 1;
          return Promise.resolve();
        },
        embed(prefixedTexts) {
          embedCalls += 1;
          return Promise.resolve({
            truncated: prefixedTexts.map(() => false),
            vectors: prefixedTexts.map(() => vector()),
          });
        },
      })),
    });
    const overTokenQuery = 'token '.repeat(300).trim();

    await expect(provider.embedQuery(overTokenQuery)).rejects.toMatchObject({
      code: 'LOCAL_EMBEDDING_CONFIG_INVALID',
    });
    expect(embedCalls).toBe(0);
    expect(disposeCalls).toBe(0);
    expect(provider.readiness()).toMatchObject({ state: 'ready' });

    await expect(provider.embedQuery('bounded query')).resolves.toMatchObject({
      truncated: [false],
    });
    expect(embedCalls).toBe(1);
  });

  it.each([
    {
      name: 'wrong dimension',
      value: () => new Float32Array(383),
    },
    {
      name: 'zero vector',
      value: () => new Float32Array(384),
    },
    {
      name: 'NaN vector',
      value: () => {
        const result = vector();
        result[1] = Number.NaN;
        return result;
      },
    },
    {
      name: 'infinite vector',
      value: () => {
        const result = vector();
        result[1] = Number.POSITIVE_INFINITY;
        return result;
      },
    },
    {
      name: 'not normalized',
      value: () => {
        const result = vector();
        result[0] = 2;
        return result;
      },
    },
  ])('fails closed for $name runtime output', async ({ value }) => {
    const provider = createLocalEmbeddingProvider({
      hubRoot: '/hub',
      resolveBinding: () => Promise.resolve(handle()),
      runtimeFactory: factory(() => Promise.resolve({
        embed: () => Promise.resolve({ truncated: [false], vectors: [value()] }),
      })),
    });
    await expect(provider.embedQuery('safe')).rejects.toMatchObject({
      code: 'LOCAL_EMBEDDING_INCOMPATIBLE',
    });
  });

  it('converts private runtime failures to value-free retryable state', async () => {
    const privatePath = '/private/user/model/onnx/model.onnx';
    const provider = createLocalEmbeddingProvider({
      hubRoot: '/hub',
      resolveBinding: () => Promise.resolve(handle()),
      runtimeFactory: factory(() => Promise.reject(new Error(privatePath))),
    });
    try {
      await provider.embedQuery('safe');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'LOCAL_EMBEDDING_UNAVAILABLE',
        reasonCode: 'runtime-unavailable',
      });
      expect(JSON.stringify(error)).not.toContain(privatePath);
    }
    expect(provider.readiness()).toMatchObject({
      reasonCode: 'runtime-unavailable',
      state: 'unavailable',
    });
  });

  it('reports truncation without retaining the raw query', async () => {
    const provider = createLocalEmbeddingProvider({
      hubRoot: '/hub',
      resolveBinding: () => Promise.resolve(handle()),
      runtimeFactory: factory(() => Promise.resolve({
        embed: () => Promise.resolve({ truncated: [true], vectors: [vector()] }),
      })),
    });
    const result = await provider.embedQuery('temporary raw question');
    expect(result.truncated).toEqual([true]);
    expect(JSON.stringify(result)).not.toContain('temporary raw question');
    expect(JSON.stringify(provider)).not.toContain('temporary raw question');
  });

  it('discards an embedding when verified artifacts change during the runtime call', async () => {
    let checks = 0;
    let runtimeCalls = 0;
    let bound: LocalModelDirectoryHandle;
    bound = handle();
    const staleIdentity = Object.freeze({
      ...bound.identity,
      identityDigest: `sha256:${'9'.repeat(64)}` as const,
    });
    bound = new LocalModelDirectoryHandle(
      bound.profileId,
      '/private/user/model',
      bound.identity,
      () => Promise.resolve(++checks >= 4 ? staleIdentity : bound.identity),
    );
    const provider = createLocalEmbeddingProvider({
      hubRoot: '/hub',
      resolveBinding: () => Promise.resolve(bound),
      runtimeFactory: factory(() => Promise.resolve({
        embed: () => {
          runtimeCalls += 1;
          return Promise.resolve({ truncated: [false], vectors: [vector()] });
        },
      })),
    });
    await expect(provider.embedQuery('safe')).rejects.toMatchObject({
      code: 'LOCAL_EMBEDDING_INCOMPATIBLE',
      reasonCode: 'binding-stale',
    });
    expect(runtimeCalls).toBe(1);
    expect(provider.activeIdentity()).toBeNull();
    expect(provider.readiness()).toMatchObject({ state: 'incompatible' });
  });
});
