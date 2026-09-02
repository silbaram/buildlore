import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import {
  EMBEDDING_IDENTITY_SCHEMA_VERSION,
  type EmbeddingArtifactIdentityV2,
  type EmbeddingIdentityV2,
  type EmbeddingSha256Digest,
} from './types.js';

export const MULTILINGUAL_E5_SMALL_PROFILE_ID = 'multilingual-e5-small' as const;

export interface LocalEmbeddingArtifactProfileV1 {
  readonly basename: string;
  readonly maximumBytes: number;
  readonly requiredSha256: EmbeddingSha256Digest | null;
  readonly role: EmbeddingArtifactIdentityV2['role'];
}

export interface LocalEmbeddingProfileV1 {
  readonly artifacts: readonly LocalEmbeddingArtifactProfileV1[];
  readonly dimensions: 384;
  readonly documentPrefix: 'passage: ';
  readonly licenseId: 'MIT';
  readonly maximumTokens: 512;
  readonly metric: 'cosine';
  readonly modelId: 'intfloat/multilingual-e5-small';
  readonly modelRevision: '614241f622f53c4eeff9890bdc4f31cfecc418b3';
  readonly normalization: 'l2';
  readonly pooling: 'attention-mask-mean';
  readonly profileId: typeof MULTILINGUAL_E5_SMALL_PROFILE_ID;
  readonly queryPrefix: 'query: ';
  readonly scalarEncoding: 'float32-little-endian';
}

export const MULTILINGUAL_E5_SMALL_PROFILE: LocalEmbeddingProfileV1 = Object.freeze({
  artifacts: Object.freeze([
    Object.freeze({
      basename: 'config.json',
      maximumBytes: 1024 * 1024,
      requiredSha256: null,
      role: 'model-config' as const,
    }),
    Object.freeze({
      basename: 'onnx/model.onnx',
      maximumBytes: 1024 * 1024 * 1024,
      requiredSha256:
        'sha256:ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
      role: 'model' as const,
    }),
    Object.freeze({
      basename: 'tokenizer.json',
      maximumBytes: 128 * 1024 * 1024,
      requiredSha256:
        'sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
      role: 'tokenizer' as const,
    }),
    Object.freeze({
      basename: 'tokenizer_config.json',
      maximumBytes: 1024 * 1024,
      requiredSha256: null,
      role: 'tokenizer-config' as const,
    }),
  ]),
  dimensions: 384,
  documentPrefix: 'passage: ',
  licenseId: 'MIT',
  maximumTokens: 512,
  metric: 'cosine',
  modelId: 'intfloat/multilingual-e5-small',
  modelRevision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
  normalization: 'l2',
  pooling: 'attention-mask-mean',
  profileId: MULTILINGUAL_E5_SMALL_PROFILE_ID,
  queryPrefix: 'query: ',
  scalarEncoding: 'float32-little-endian',
});

export function localEmbeddingProfile(profileId: string): LocalEmbeddingProfileV1 | null {
  return profileId === MULTILINGUAL_E5_SMALL_PROFILE_ID ? MULTILINGUAL_E5_SMALL_PROFILE : null;
}

export function createEmbeddingIdentityV2(
  profile: LocalEmbeddingProfileV1,
  artifacts: readonly EmbeddingArtifactIdentityV2[],
): EmbeddingIdentityV2 {
  const candidate = Object.freeze({
    adapter: Object.freeze({
      contractVersion: 1 as const,
      device: 'cpu' as const,
      kind: 'transformers-js' as const,
      packageName: '@huggingface/transformers' as const,
      packageVersion: '4.2.0' as const,
      runtimeDependency: 'onnxruntime-node@1.24.3' as const,
    }),
    artifacts: Object.freeze([...artifacts].sort((left, right) =>
      left.basename < right.basename ? -1 : left.basename > right.basename ? 1 : 0)),
    dimensions: profile.dimensions,
    documentPrefix: profile.documentPrefix,
    licenseId: profile.licenseId,
    maximumTokens: profile.maximumTokens,
    metric: profile.metric,
    modelId: profile.modelId,
    modelRevision: profile.modelRevision,
    normalization: profile.normalization,
    pooling: profile.pooling,
    providerKind: 'local-in-process' as const,
    queryPrefix: profile.queryPrefix,
    scalarEncoding: profile.scalarEncoding,
    schemaVersion: EMBEDDING_IDENTITY_SCHEMA_VERSION,
    tokenizerContractVersion: 1 as const,
  });
  const identityDigest = `sha256:${createHash('sha256')
    .update(serializeCanonicalJson(candidate)).digest('hex')}` as const;
  return Object.freeze({ ...candidate, identityDigest });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) =>
    key === sortedExpected[index]);
}

export function parseEmbeddingIdentityV2(value: unknown): EmbeddingIdentityV2 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'adapter', 'artifacts', 'dimensions', 'documentPrefix', 'identityDigest', 'licenseId',
    'maximumTokens', 'metric', 'modelId', 'modelRevision', 'normalization', 'pooling',
    'providerKind', 'queryPrefix', 'scalarEncoding', 'schemaVersion',
    'tokenizerContractVersion',
  ]) || value.schemaVersion !== EMBEDDING_IDENTITY_SCHEMA_VERSION ||
      value.modelId !== MULTILINGUAL_E5_SMALL_PROFILE.modelId ||
      value.modelRevision !== MULTILINGUAL_E5_SMALL_PROFILE.modelRevision ||
      value.licenseId !== 'MIT' || value.providerKind !== 'local-in-process' ||
      value.dimensions !== 384 || value.scalarEncoding !== 'float32-little-endian' ||
      value.metric !== 'cosine' || value.pooling !== 'attention-mask-mean' ||
      value.normalization !== 'l2' || value.maximumTokens !== 512 ||
      value.documentPrefix !== 'passage: ' || value.queryPrefix !== 'query: ' ||
      value.tokenizerContractVersion !== 1 || !isRecord(value.adapter) ||
      !exactKeys(value.adapter, [
        'contractVersion', 'device', 'kind', 'packageName', 'packageVersion', 'runtimeDependency',
      ]) || value.adapter.contractVersion !== 1 || value.adapter.device !== 'cpu' ||
      value.adapter.kind !== 'transformers-js' ||
      value.adapter.packageName !== '@huggingface/transformers' ||
      value.adapter.packageVersion !== '4.2.0' ||
      value.adapter.runtimeDependency !== 'onnxruntime-node@1.24.3' ||
      !Array.isArray(value.artifacts) ||
      value.artifacts.length !== MULTILINGUAL_E5_SMALL_PROFILE.artifacts.length) return null;
  const expectedProfiles = new Map(MULTILINGUAL_E5_SMALL_PROFILE.artifacts.map((artifact) =>
    [artifact.basename, artifact]));
  const artifacts: EmbeddingArtifactIdentityV2[] = [];
  for (const item of value.artifacts) {
    if (!isRecord(item) || !exactKeys(item, ['basename', 'bytes', 'role', 'sha256']) ||
        typeof item.basename !== 'string' || typeof item.bytes !== 'number' ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
        typeof item.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(item.sha256)) {
      return null;
    }
    const profileArtifact = expectedProfiles.get(item.basename);
    if (profileArtifact === undefined || profileArtifact.role !== item.role ||
        item.bytes > profileArtifact.maximumBytes ||
        (profileArtifact.requiredSha256 !== null &&
          item.sha256 !== profileArtifact.requiredSha256)) return null;
    artifacts.push(Object.freeze({
      basename: item.basename,
      bytes: item.bytes,
      role: profileArtifact.role,
      sha256: item.sha256 as EmbeddingSha256Digest,
    }));
  }
  if (new Set(artifacts.map((item) => item.basename)).size !== artifacts.length) return null;
  const recreated = createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, artifacts);
  return value.identityDigest === recreated.identityDigest ? recreated : null;
}
