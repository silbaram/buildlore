import { knowledgeWikiReadMetadata } from './wiki-contracts.js';
import { hash, invalid } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from '../../knowledge/project-knowledge/types.js';
import { knowledgeReaderLookup, type KnowledgeReaderLookupV1 } from './reader-surface.js';

export interface LookupBatchOptions { readonly maxBytes?: number }
export interface KnowledgeReaderLookupBatchV1 {
  readonly schemaVersion: 'buildlore.knowledge-reader-lookup-batch.v1' | 'buildlore.knowledge-reader-lookup-batch.v2';
  readonly knowledgeReview?: NonNullable<ReturnType<typeof knowledgeWikiReadMetadata>['knowledgeReview']>;
  readonly projectId: string;
  readonly generationDigest: KnowledgeDigest;
  readonly kind: 'evidence' | 'fact';
  readonly requestedCount: number;
  readonly uniqueCount: number;
  readonly items: readonly Readonly<Pick<KnowledgeReaderLookupV1, 'id' | 'result'>>[];
  readonly budget: Readonly<{ maxBytes: number; usedBytes: number }>;
  readonly egress: 'none';
}

export class LookupBatchError extends Error {
  readonly code = 'LOOKUP_BATCH_TOO_LARGE';
  constructor(readonly requiredBytes: number, readonly maxBytes: number) {
    super('LOOKUP_BATCH_TOO_LARGE'); this.name = 'LookupBatchError';
  }
}

export function validateLookupBatch(kind: 'evidence' | 'fact', ids: readonly KnowledgeDigest[],
  options: LookupBatchOptions = {},
): Readonly<{ ids: readonly KnowledgeDigest[]; requestedCount: number; maxBytes: number }> {
  if (kind !== 'evidence' && kind !== 'fact' || !Array.isArray(ids) || ids.length < 1 || ids.length > 16) invalid();
  const maxBytes = options.maxBytes === undefined ? 32768 : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2048 || maxBytes > 65536) invalid();
  return { ids: Object.freeze([...new Set(ids.map(id => hash(id)))]), requestedCount: ids.length, maxBytes };
}

/** Pure projection of a verified generation. Complete items or an error; never clipped evidence. */
export function knowledgeReaderLookupBatch(generation: KnowledgeGenerationV1, kind: 'evidence' | 'fact',
  ids: readonly KnowledgeDigest[], options: LookupBatchOptions = {},
): KnowledgeReaderLookupBatchV1 {
  const request = validateLookupBatch(kind, ids, options);
  const items = Object.freeze(request.ids.map(id => {
    const { result } = knowledgeReaderLookup(generation, kind, id);
    return Object.freeze({ id, result });
  }));
  const budget = { maxBytes: request.maxBytes, usedBytes: 0 };
  const result: KnowledgeReaderLookupBatchV1 = { schemaVersion: generation.wikiProof === undefined ? 'buildlore.knowledge-reader-lookup-batch.v1' : 'buildlore.knowledge-reader-lookup-batch.v2',
    ...knowledgeWikiReadMetadata(generation),
    projectId: generation.projectId, generationDigest: generation.generationDigest, kind,
    requestedCount: request.requestedCount, uniqueCount: items.length, items, budget, egress: 'none' };
  for (;;) {
    const size = Buffer.byteLength(JSON.stringify(result) + '\n');
    if (size === budget.usedBytes) break;
    budget.usedBytes = size;
  }
  if (budget.usedBytes > budget.maxBytes) throw new LookupBatchError(budget.usedBytes, budget.maxBytes);
  Object.freeze(budget);
  return Object.freeze(result);
}
