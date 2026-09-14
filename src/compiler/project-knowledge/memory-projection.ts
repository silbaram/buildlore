import { Buffer } from 'node:buffer';
import { digest, invalid } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest } from '../../knowledge/project-knowledge/types.js';
import { tokenizeLexical } from '../../retrieval/strategy.js';
import type { KnowledgeDevelopmentMemoryV1 } from './reader-memory.js';
import { serializeKnowledgeReaderPacketData } from './reader-packet.js';

type Full = KnowledgeDevelopmentMemoryV1;
type Context = Full['evidenceContext'][string];
type ContextTuple = readonly [boolean, Context['sourceRevision'], Context['codeRevision'],
  Context['sourceRevisionUnavailableReason'], Context['codeRevisionUnavailableReason'], KnowledgeDigest, KnowledgeDigest];

export interface TaskEvidenceContext {
  readonly fields: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, ContextTuple>>;
}

function subset<T>(registry: Readonly<Record<string, T>>, aliases: ReadonlySet<string>): Readonly<Record<string, T>> {
  return Object.freeze(Object.fromEntries([...aliases].sort().map(alias => [alias, registry[alias] ?? invalid()])));
}

function compactContexts(full: Full, aliases: ReadonlySet<string>): TaskEvidenceContext {
  const values: Record<string, ContextTuple> = {}, refs: Record<string, string> = {};
  const identities = new Map<string, string>();
  for (const alias of [...aliases].sort()) {
    const c = full.evidenceContext[alias] ?? invalid();
    const tuple: ContextTuple = Object.freeze([c.presentInCurrentSnapshot, c.sourceRevision, c.codeRevision,
      c.sourceRevisionUnavailableReason, c.codeRevisionUnavailableReason, c.sourceContentDigest, c.sanitizedContentDigest]);
    const key = JSON.stringify(tuple);
    let ref = identities.get(key);
    if (ref === undefined) { ref = `c${String(identities.size)}`; identities.set(key, ref); values[ref] = tuple; }
    refs[alias] = ref;
  }
  return Object.freeze({ fields: Object.freeze(['presentInCurrentSnapshot', 'sourceRevision', 'codeRevision',
    'sourceRevisionUnavailableReason', 'codeRevisionUnavailableReason', 'sourceContentDigest', 'sanitizedContentDigest']),
    aliases: Object.freeze(refs), values: Object.freeze(values) });
}

/** Preserve the complete fact -> evidence -> source closure for the selected claims. */
export function selectMemoryReferences(full: Full, factAliases: ReadonlySet<string>): Readonly<
  Pick<Full, 'facts' | 'evidence' | 'sources'> & { evidenceContext: TaskEvidenceContext }
> {
  const facts = subset(full.facts, factAliases);
  const evidenceAliases = new Set(Object.values(facts).flatMap(fact => fact[6]));
  const evidence = subset(full.evidence, evidenceAliases);
  return Object.freeze({ facts, evidence,
    sources: subset(full.sources, new Set(Object.values(evidence).map(item => item[1]))),
    evidenceContext: compactContexts(full, evidenceAliases) });
}

export function createMemoryTokenMatcher(task: string): (text: string) => number {
  const query = new Set(tokenizeLexical(task));
  return (text: string): number => {
    const tokens = new Set(tokenizeLexical(text));
    return [...query].filter(token => tokens.has(token)).length;
  };
}

/** Include the size field itself and the fixed-width digest in the byte budget. */
export function finalizeMemoryProjection<T extends { budget: { serializedBytes: number } }>(
  basis: T, previousDigest: KnowledgeDigest,
): Readonly<T & { memoryDigest: KnowledgeDigest }> {
  let size = 0;
  for (;;) {
    basis.budget.serializedBytes = size;
    const actual = Buffer.byteLength(serializeKnowledgeReaderPacketData({ ...basis, memoryDigest: previousDigest }));
    if (actual === size) break;
    size = actual;
  }
  Object.freeze(basis.budget);
  return Object.freeze({ ...basis, memoryDigest: digest(basis) });
}
