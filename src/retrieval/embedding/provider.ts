import { platform, arch } from 'node:process';

import {
  MULTILINGUAL_E5_SMALL_PROFILE,
  MULTILINGUAL_E5_SMALL_PROFILE_ID,
} from './profile.js';
import {
  resolveVerifiedLocalModelBinding,
  withVerifiedLocalModelDirectory,
  type LocalModelDirectoryHandle,
} from './model-binding.js';
import {
  LocalEmbeddingError,
  type EmbeddingBatchResultV1,
  type EmbeddingDocumentTokenCountResultV1,
  type EmbeddingIdentityV2,
  type EmbeddingProviderCapabilitiesV1,
  type EmbeddingProviderPort,
  type EmbeddingProviderState,
} from './types.js';

const MAXIMUM_BATCH_SIZE = 32;
const MAXIMUM_QUERY_UTF8_BYTES = 4096;
const NORMALIZATION_TOLERANCE = 1e-5;
const TRANSFORMERS_PACKAGE_NAME: string = '@huggingface/transformers';

export interface LocalEmbeddingRuntimeResult {
  readonly truncated: readonly boolean[];
  readonly vectors: readonly Float32Array[];
}

export interface LocalEmbeddingRuntime {
  countTokens?(this: void, prefixedTexts: readonly string[]): Promise<readonly number[]>;
  dispose?(): Promise<void>;
  embed(prefixedTexts: readonly string[]): Promise<LocalEmbeddingRuntimeResult>;
}

export interface LocalEmbeddingRuntimeFactory {
  open(directory: string): Promise<LocalEmbeddingRuntime>;
}

export interface CreateLocalEmbeddingProviderOptions {
  readonly hubRoot: string;
  readonly profileId?: string;
}

interface CreateLocalEmbeddingProviderInternalOptions extends CreateLocalEmbeddingProviderOptions {
  readonly resolveBinding?: (
    hubRoot: string,
    profileId: string,
  ) => Promise<LocalModelDirectoryHandle>;
  readonly runtimeFactory?: LocalEmbeddingRuntimeFactory;
}

interface TransformersTensor {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
  readonly type: string;
}

type FeatureExtractor = Readonly<{
  dispose(): Promise<void>;
  tokenizer: unknown;
}> & ((
  texts: string[],
  options: Readonly<{ readonly normalize: true; readonly pooling: 'mean' }>,
) => Promise<TransformersTensor>);

interface TransformersModule {
  readonly env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    cacheDir: string | null;
    customCache: null;
    fetch: (input: string | URL, init?: unknown) => Promise<unknown>;
    localModelPath: string;
    useBrowserCache: boolean;
    useCustomCache: boolean;
    useFSCache: boolean;
    useWasmCache: boolean;
  };
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: Readonly<{
      readonly device: 'cpu';
      readonly dtype: 'fp32';
      readonly local_files_only: true;
      readonly model_file_name: 'model';
      readonly revision: string;
      readonly subfolder: 'onnx';
    }>,
  ): Promise<FeatureExtractor>;
}

function unavailable(): never {
  throw new LocalEmbeddingError('LOCAL_EMBEDDING_UNAVAILABLE', 'runtime-unavailable');
}

function incompatible(): never {
  throw new LocalEmbeddingError('LOCAL_EMBEDDING_INCOMPATIBLE', 'artifact-config-incompatible');
}

function validateText(
  text: string,
  maximumUtf8Bytes: number,
  allowDocumentFormatting: boolean,
): string {
  const normalized = text.normalize('NFC');
  if (normalized.trim() === '' || Buffer.byteLength(normalized, 'utf8') > maximumUtf8Bytes) {
    throw new LocalEmbeddingError('LOCAL_EMBEDDING_CONFIG_INVALID');
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if ((code < 32 && !(allowDocumentFormatting && (code === 9 || code === 10))) ||
        (code >= 127 && code <= 159)) {
      throw new LocalEmbeddingError('LOCAL_EMBEDDING_CONFIG_INVALID');
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = normalized.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new LocalEmbeddingError('LOCAL_EMBEDDING_CONFIG_INVALID');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new LocalEmbeddingError('LOCAL_EMBEDDING_CONFIG_INVALID');
    }
  }
  return normalized;
}

function validateRuntimeResult(
  result: LocalEmbeddingRuntimeResult,
  count: number,
): LocalEmbeddingRuntimeResult {
  if (result.vectors.length !== count || result.truncated.length !== count ||
      result.truncated.some((value) => typeof value !== 'boolean')) incompatible();
  const vectors = result.vectors.map((vector) => {
    if (!(vector instanceof Float32Array) ||
        vector.length !== MULTILINGUAL_E5_SMALL_PROFILE.dimensions) incompatible();
    let squaredNorm = 0;
    for (const component of vector) {
      if (!Number.isFinite(component)) incompatible();
      squaredNorm += component * component;
    }
    const norm = Math.sqrt(squaredNorm);
    if (norm === 0 || Math.abs(norm - 1) > NORMALIZATION_TOLERANCE) incompatible();
    return new Float32Array(vector);
  });
  return Object.freeze({
    truncated: Object.freeze([...result.truncated]),
    vectors: Object.freeze(vectors),
  });
}

function tokenCount(tokenizer: unknown, text: string): number {
  if (typeof tokenizer !== 'function') incompatible();
  const callTokenizer = tokenizer as (
    value: string,
    options: Readonly<{ readonly return_tensor: false; readonly truncation: false }>,
  ) => unknown;
  const encoding = callTokenizer(text, { return_tensor: false, truncation: false });
  if (typeof encoding !== 'object' || encoding === null || !('input_ids' in encoding) ||
      !Array.isArray(encoding.input_ids) || encoding.input_ids.some((item: unknown) =>
        typeof item !== 'number')) incompatible();
  return encoding.input_ids.length;
}

export const transformersJsCpuRuntimeFactory: LocalEmbeddingRuntimeFactory = Object.freeze({
  async open(directory: string): Promise<LocalEmbeddingRuntime> {
    if (platform !== 'linux' || arch !== 'x64') {
      throw new LocalEmbeddingError('LOCAL_EMBEDDING_UNAVAILABLE', 'platform-unsupported');
    }
    try {
      const transformers = await import(TRANSFORMERS_PACKAGE_NAME) as unknown as TransformersModule;
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = false;
      transformers.env.localModelPath = directory;
      transformers.env.useBrowserCache = false;
      transformers.env.useFSCache = false;
      transformers.env.cacheDir = null;
      transformers.env.useCustomCache = false;
      transformers.env.customCache = null;
      transformers.env.useWasmCache = false;
      transformers.env.fetch = () =>
        Promise.reject(new Error('BUILDLore_LOCAL_NETWORK_DISABLED'));
      const extractor = await transformers.pipeline('feature-extraction', directory, {
        device: 'cpu',
        dtype: 'fp32',
        local_files_only: true,
        model_file_name: 'model',
        revision: MULTILINGUAL_E5_SMALL_PROFILE.modelRevision,
        subfolder: 'onnx',
      });
      return Object.freeze({
        countTokens(prefixedTexts: readonly string[]): Promise<readonly number[]> {
          return Promise.resolve(Object.freeze(prefixedTexts.map((text) =>
            tokenCount(extractor.tokenizer, text))));
        },
        async dispose(): Promise<void> {
          await extractor.dispose();
        },
        async embed(prefixedTexts: readonly string[]): Promise<LocalEmbeddingRuntimeResult> {
          const truncated = prefixedTexts.map((text) =>
            tokenCount(extractor.tokenizer, text) > MULTILINGUAL_E5_SMALL_PROFILE.maximumTokens);
          const output = await extractor([...prefixedTexts], {
            normalize: true,
            pooling: 'mean',
          });
          if (output.type !== 'float32' || output.dims.length !== 2 ||
              output.dims[0] !== prefixedTexts.length ||
              output.dims[1] !== MULTILINGUAL_E5_SMALL_PROFILE.dimensions ||
              output.data.length !== prefixedTexts.length *
                MULTILINGUAL_E5_SMALL_PROFILE.dimensions) incompatible();
          const vectors = prefixedTexts.map((_text: string, index: number) => new Float32Array(
            Array.from(output.data).slice(
              index * MULTILINGUAL_E5_SMALL_PROFILE.dimensions,
              (index + 1) * MULTILINGUAL_E5_SMALL_PROFILE.dimensions,
            ),
          ));
          return Object.freeze({ truncated: Object.freeze(truncated), vectors });
        },
      });
    } catch (error) {
      if (error instanceof LocalEmbeddingError) throw error;
      return unavailable();
    }
  },
});

const CAPABILITIES: EmbeddingProviderCapabilitiesV1 = Object.freeze({
  adapterKind: 'transformers-js',
  device: 'cpu',
  egress: 'none',
  maximumBatchSize: MAXIMUM_BATCH_SIZE,
  maximumQueryUtf8Bytes: MAXIMUM_QUERY_UTF8_BYTES,
  networkAllowed: false,
  providerUsed: 'local-in-process',
});

function createLocalEmbeddingProviderInternal(
  options: CreateLocalEmbeddingProviderInternalOptions,
): EmbeddingProviderPort {
  const profileId = options.profileId ?? MULTILINGUAL_E5_SMALL_PROFILE_ID;
  const resolveBinding = options.resolveBinding ?? resolveVerifiedLocalModelBinding;
  const runtimeFactory = options.runtimeFactory ?? transformersJsCpuRuntimeFactory;
  let state: EmbeddingProviderState = Object.freeze({ state: 'none' });
  let runtimePromise: Promise<Readonly<{
    readonly handle: LocalModelDirectoryHandle;
    readonly identity: EmbeddingIdentityV2;
    readonly runtime: LocalEmbeddingRuntime;
  }>> | null = null;

  async function initialize(): Promise<Readonly<{
    readonly handle: LocalModelDirectoryHandle;
    readonly identity: EmbeddingIdentityV2;
    readonly runtime: LocalEmbeddingRuntime;
  }>> {
    if (runtimePromise !== null) return runtimePromise;
    state = Object.freeze({ state: 'initializing' });
    runtimePromise = (async () => {
      try {
        const handle = await resolveBinding(options.hubRoot, profileId);
        let runtime: LocalEmbeddingRuntime | undefined;
        let openedRuntime: LocalEmbeddingRuntime | undefined;
        try {
          runtime = await withVerifiedLocalModelDirectory(handle, async (directory) => {
            openedRuntime = await runtimeFactory.open(directory);
            return openedRuntime;
          });
        } catch (error) {
          await openedRuntime?.dispose?.().catch(() => undefined);
          throw error;
        }
        state = Object.freeze({ activeIdentity: handle.identity, state: 'ready' });
        return Object.freeze({ handle, identity: handle.identity, runtime });
      } catch (error) {
        const safeError = error instanceof LocalEmbeddingError
          ? error
          : new LocalEmbeddingError('LOCAL_EMBEDDING_UNAVAILABLE', 'runtime-unavailable');
        const reasonCode = safeError.reasonCode ?? 'runtime-unavailable';
        const recoveryAction = reasonCode === 'binding-missing' ||
          reasonCode === 'model-directory-unavailable'
          ? Object.freeze(['model', 'bind', '--profile', profileId] as const)
          : Object.freeze(['model', 'verify', '--profile', profileId] as const);
        state = Object.freeze({
          reasonCode,
          recoveryAction,
          state: safeError.code === 'LOCAL_EMBEDDING_INCOMPATIBLE'
            ? 'incompatible' as const
            : 'unavailable' as const,
        });
        runtimePromise = null;
        throw safeError;
      }
    })();
    return runtimePromise;
  }

  async function embed(
    texts: readonly string[],
    kind: 'document' | 'query',
  ): Promise<EmbeddingBatchResultV1> {
    if (texts.length < 1 || texts.length > MAXIMUM_BATCH_SIZE) {
      throw new LocalEmbeddingError('LOCAL_EMBEDDING_CONFIG_INVALID');
    }
    const maximumBytes = kind === 'query' ? MAXIMUM_QUERY_UTF8_BYTES : 1024 * 1024;
    const normalized = texts.map((text) => validateText(
      text,
      maximumBytes,
      kind === 'document',
    ));
    const prefix = kind === 'query'
      ? MULTILINGUAL_E5_SMALL_PROFILE.queryPrefix
      : MULTILINGUAL_E5_SMALL_PROFILE.documentPrefix;
    const ready = await initialize();
    try {
      const prefixed = normalized.map((text) => `${prefix}${text}`);
      if (kind === 'query' && ready.runtime.countTokens !== undefined) {
        const countTokens = ready.runtime.countTokens;
        const tokenCounts = await withVerifiedLocalModelDirectory(ready.handle, () =>
          countTokens(prefixed));
        if (tokenCounts.length !== 1 || tokenCounts.some((value) =>
          !Number.isSafeInteger(value) || value < 1)) incompatible();
        if ((tokenCounts[0] ?? Number.POSITIVE_INFINITY) >
            MULTILINGUAL_E5_SMALL_PROFILE.maximumTokens) {
          throw new LocalEmbeddingError('LOCAL_EMBEDDING_CONFIG_INVALID');
        }
      }
      const result = validateRuntimeResult(
        await withVerifiedLocalModelDirectory(ready.handle, () =>
          ready.runtime.embed(prefixed)),
        normalized.length,
      );
      return Object.freeze({
        egress: 'none',
        identity: ready.identity,
        providerUsed: 'local-in-process',
        truncated: result.truncated,
        vectors: result.vectors,
      });
    } catch (error) {
      if (error instanceof LocalEmbeddingError &&
          error.code === 'LOCAL_EMBEDDING_CONFIG_INVALID') throw error;
      await ready.runtime.dispose?.().catch(() => undefined);
      if (error instanceof LocalEmbeddingError) {
        const reasonCode = error.reasonCode ?? 'runtime-unavailable';
        state = Object.freeze({
          reasonCode,
          recoveryAction: Object.freeze(['model', 'verify', '--profile', profileId] as const),
          state: error.code === 'LOCAL_EMBEDDING_INCOMPATIBLE'
            ? 'incompatible' as const
            : 'unavailable' as const,
        });
        runtimePromise = null;
        throw error;
      }
      state = Object.freeze({
        reasonCode: 'runtime-unavailable',
        recoveryAction: Object.freeze(['model', 'verify', '--profile', profileId] as const),
        state: 'unavailable',
      });
      runtimePromise = null;
      return unavailable();
    }
  }

  async function countDocumentTokens(
    texts: readonly string[],
  ): Promise<EmbeddingDocumentTokenCountResultV1> {
    if (texts.length < 1 || texts.length > MAXIMUM_BATCH_SIZE) {
      throw new LocalEmbeddingError('LOCAL_EMBEDDING_CONFIG_INVALID');
    }
    const normalized = texts.map((text) => validateText(text, 1024 * 1024, true));
    const ready = await initialize();
    try {
      const countTokens = ready.runtime.countTokens;
      if (countTokens === undefined) incompatible();
      const tokenCounts = await withVerifiedLocalModelDirectory(ready.handle, () =>
        countTokens(normalized.map((text) =>
          `${MULTILINGUAL_E5_SMALL_PROFILE.documentPrefix}${text}`)));
      if (tokenCounts.length !== normalized.length || tokenCounts.some((value) =>
        !Number.isSafeInteger(value) || value < 1 || value > 10_000_000)) incompatible();
      return Object.freeze({
        egress: 'none',
        identity: ready.identity,
        maximumTokens: 512,
        providerUsed: 'local-in-process',
        tokenCounts: Object.freeze([...tokenCounts]),
      });
    } catch (error) {
      await ready.runtime.dispose?.().catch(() => undefined);
      const safeError = error instanceof LocalEmbeddingError
        ? error
        : new LocalEmbeddingError('LOCAL_EMBEDDING_UNAVAILABLE', 'runtime-unavailable');
      const reasonCode = safeError.reasonCode ?? 'runtime-unavailable';
      state = Object.freeze({
        reasonCode,
        recoveryAction: Object.freeze(['model', 'verify', '--profile', profileId] as const),
        state: safeError.code === 'LOCAL_EMBEDDING_INCOMPATIBLE'
          ? 'incompatible' as const
          : 'unavailable' as const,
      });
      runtimePromise = null;
      throw safeError;
    }
  }

  return Object.freeze({
    activeIdentity(): EmbeddingIdentityV2 | null {
      return state.state === 'ready' ? state.activeIdentity : null;
    },
    countDocumentTokens,
    embedDocuments(texts: readonly string[]): Promise<EmbeddingBatchResultV1> {
      return embed(texts, 'document');
    },
    embedQuery(text: string): Promise<EmbeddingBatchResultV1> {
      return embed([text], 'query');
    },
    inspectCapabilities(): EmbeddingProviderCapabilitiesV1 {
      return CAPABILITIES;
    },
    readiness(): EmbeddingProviderState {
      return state;
    },
  });
}

export function createLocalEmbeddingProvider(
  options: CreateLocalEmbeddingProviderOptions,
): EmbeddingProviderPort {
  return createLocalEmbeddingProviderInternal(options);
}

/** @internal Source-only deterministic seam; absent from the package export map. */
export function createLocalEmbeddingProviderForTest(
  options: CreateLocalEmbeddingProviderInternalOptions,
): EmbeddingProviderPort {
  return createLocalEmbeddingProviderInternal(options);
}
