export const EMBEDDING_IDENTITY_SCHEMA_VERSION = 'buildlore.embedding-identity.v2' as const;
export const LOCAL_MODEL_BINDING_SCHEMA_VERSION = 'buildlore.local-model-binding.v1' as const;

export type EmbeddingSha256Digest = `sha256:${string}`;
export type LocalEmbeddingReasonCode =
  | 'artifact-checksum-mismatch'
  | 'artifact-config-incompatible'
  | 'artifact-missing'
  | 'binding-missing'
  | 'binding-stale'
  | 'model-directory-unavailable'
  | 'platform-unsupported'
  | 'runtime-unavailable';

export type LocalEmbeddingRecoveryAction =
  | readonly ['model', 'bind', '--profile', string]
  | readonly ['model', 'verify', '--profile', string];

export interface EmbeddingArtifactIdentityV2 {
  readonly basename: string;
  readonly bytes: number;
  readonly role: 'model' | 'model-config' | 'tokenizer' | 'tokenizer-config';
  readonly sha256: EmbeddingSha256Digest;
}

export interface EmbeddingIdentityV2 {
  readonly adapter: {
    readonly contractVersion: 1;
    readonly device: 'cpu';
    readonly kind: 'transformers-js';
    readonly packageName: '@huggingface/transformers';
    readonly packageVersion: '4.2.0';
    readonly runtimeDependency: 'onnxruntime-node@1.24.3';
  };
  readonly artifacts: readonly EmbeddingArtifactIdentityV2[];
  readonly dimensions: 384;
  readonly documentPrefix: 'passage: ';
  readonly identityDigest: EmbeddingSha256Digest;
  readonly licenseId: 'MIT';
  readonly maximumTokens: 512;
  readonly metric: 'cosine';
  readonly modelId: 'intfloat/multilingual-e5-small';
  readonly modelRevision: '614241f622f53c4eeff9890bdc4f31cfecc418b3';
  readonly normalization: 'l2';
  readonly pooling: 'attention-mask-mean';
  readonly providerKind: 'local-in-process';
  readonly queryPrefix: 'query: ';
  readonly scalarEncoding: 'float32-little-endian';
  readonly schemaVersion: typeof EMBEDDING_IDENTITY_SCHEMA_VERSION;
  readonly tokenizerContractVersion: 1;
}

export interface LocalModelBindingV1 {
  readonly directory: string;
  readonly profileId: string;
  readonly schemaVersion: typeof LOCAL_MODEL_BINDING_SCHEMA_VERSION;
  readonly verifiedIdentity: EmbeddingIdentityV2 | null;
}

export interface LocalModelBindingRegistryV1 {
  readonly bindings: readonly LocalModelBindingV1[];
  readonly schemaVersion: 'buildlore.local-model-bindings.v1';
}

export interface LocalModelBindingViewV1 {
  readonly activeIdentity: EmbeddingIdentityV2 | null;
  readonly profileId: string;
  readonly reasonCode: LocalEmbeddingReasonCode | null;
  readonly recoveryAction: LocalEmbeddingRecoveryAction | null;
  readonly state: 'incompatible' | 'none' | 'ready' | 'unavailable';
}

export type EmbeddingProviderState =
  | Readonly<{ readonly state: 'none' }>
  | Readonly<{ readonly state: 'initializing' }>
  | Readonly<{
      readonly activeIdentity: EmbeddingIdentityV2;
      readonly state: 'ready';
    }>
  | Readonly<{
      readonly reasonCode: LocalEmbeddingReasonCode;
      readonly recoveryAction: LocalEmbeddingRecoveryAction;
      readonly state: 'unavailable';
    }>
  | Readonly<{
      readonly reasonCode: LocalEmbeddingReasonCode;
      readonly recoveryAction: LocalEmbeddingRecoveryAction;
      readonly state: 'incompatible';
    }>;

export interface EmbeddingProviderCapabilitiesV1 {
  readonly adapterKind: 'transformers-js';
  readonly device: 'cpu';
  readonly egress: 'none';
  readonly maximumBatchSize: 32;
  readonly maximumQueryUtf8Bytes: 4096;
  readonly networkAllowed: false;
  readonly providerUsed: 'local-in-process';
}

export interface EmbeddingBatchResultV1 {
  readonly egress: 'none';
  readonly identity: EmbeddingIdentityV2;
  readonly providerUsed: 'local-in-process';
  readonly truncated: readonly boolean[];
  readonly vectors: readonly Float32Array[];
}

export interface EmbeddingDocumentTokenCountResultV1 {
  readonly egress: 'none';
  readonly identity: EmbeddingIdentityV2;
  readonly maximumTokens: 512;
  readonly providerUsed: 'local-in-process';
  readonly tokenCounts: readonly number[];
}

export interface EmbeddingProviderPort {
  activeIdentity(): EmbeddingIdentityV2 | null;
  countDocumentTokens(texts: readonly string[]): Promise<EmbeddingDocumentTokenCountResultV1>;
  embedDocuments(texts: readonly string[]): Promise<EmbeddingBatchResultV1>;
  embedQuery(text: string): Promise<EmbeddingBatchResultV1>;
  inspectCapabilities(): EmbeddingProviderCapabilitiesV1;
  readiness(): EmbeddingProviderState;
}

export type LocalEmbeddingErrorCode =
  | 'LOCAL_EMBEDDING_BUSY'
  | 'LOCAL_EMBEDDING_CONFIG_INVALID'
  | 'LOCAL_EMBEDDING_INCOMPATIBLE'
  | 'LOCAL_EMBEDDING_UNAVAILABLE'
  | 'LOCAL_EMBEDDING_WRITE_FAILED';

export class LocalEmbeddingError extends Error {
  readonly code: LocalEmbeddingErrorCode;
  readonly reasonCode: LocalEmbeddingReasonCode | null;
  readonly retryable: boolean;

  constructor(
    code: LocalEmbeddingErrorCode,
    reasonCode: LocalEmbeddingReasonCode | null = null,
  ) {
    super(code === 'LOCAL_EMBEDDING_CONFIG_INVALID'
      ? 'Local embedding configuration is invalid.'
      : code === 'LOCAL_EMBEDDING_BUSY'
        ? 'Local model binding registry is busy.'
        : code === 'LOCAL_EMBEDDING_WRITE_FAILED'
          ? 'Local model binding could not be updated safely.'
          : code === 'LOCAL_EMBEDDING_INCOMPATIBLE'
            ? 'Local embedding artifacts are incompatible.'
            : 'Local embedding is unavailable.');
    this.name = 'LocalEmbeddingError';
    this.code = code;
    this.reasonCode = reasonCode;
    this.retryable = code !== 'LOCAL_EMBEDDING_CONFIG_INVALID';
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      code: this.code,
      message: this.message,
      reasonCode: this.reasonCode,
      retryable: this.retryable,
    });
  }
}
