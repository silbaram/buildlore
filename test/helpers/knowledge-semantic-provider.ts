import { createHash } from 'node:crypto';
import { createEmbeddingIdentityV2, MULTILINGUAL_E5_SMALL_PROFILE,
  type EmbeddingProviderPort } from '../../src/retrieval/embedding/index.js';

/** Deterministic adapter fixture, never evidence of model quality. No model files or network. */
export function knowledgeSemanticProvider(calls: string[] = []): EmbeddingProviderPort {
  const identity = createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, [
    { basename: 'config.json', bytes: 655, role: 'model-config', sha256: `sha256:${'1'.repeat(64)}` },
    { basename: 'onnx/model.onnx', bytes: 470_268_510, role: 'model',
      sha256: 'sha256:ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665' },
    { basename: 'tokenizer.json', bytes: 17_082_730, role: 'tokenizer',
      sha256: 'sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
    { basename: 'tokenizer_config.json', bytes: 443, role: 'tokenizer-config', sha256: `sha256:${'2'.repeat(64)}` },
  ]);
  const vector = (text: string) => {
    const result = new Float32Array(identity.dimensions);
    // High, distinct similarities exercise retrieval plumbing, not model quality.
    result[0] = 1;
    for (const [i, byte] of createHash('sha256').update(text).digest().entries()) result[i + 1] = (byte + 1) / 4096;
    const norm = Math.sqrt(result.reduce((sum, n) => sum + n * n, 0));
    return result.map(n => n / norm);
  };
  const batch = (texts: readonly string[]) => ({ egress: 'none' as const, identity,
    providerUsed: 'local-in-process' as const, truncated: texts.map(() => false), vectors: texts.map(vector) });
  return {
    activeIdentity: () => identity,
    countDocumentTokens: texts => Promise.resolve({ egress: 'none', identity, maximumTokens: 512,
      providerUsed: 'local-in-process', tokenCounts: texts.map(text => Math.max(1, Array.from(text).length)) }),
    embedDocuments(texts) { calls.push('documents'); return Promise.resolve(batch(texts)); },
    embedQuery(text) { calls.push('query'); return Promise.resolve(batch([text])); },
    inspectCapabilities: () => ({ adapterKind: 'transformers-js', device: 'cpu', egress: 'none',
      maximumBatchSize: 32, maximumQueryUtf8Bytes: 4096, networkAllowed: false, providerUsed: 'local-in-process' }),
    readiness: () => ({ activeIdentity: identity, state: 'ready' }),
  };
}
