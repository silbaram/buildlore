import type { KnowledgeGenerationV1 } from '../../knowledge/project-knowledge/types.js';
import { parseJsonWithLocationsStrict } from '../../knowledge/strict-json.js';
import { invalid } from '../../knowledge/project-knowledge/guards.js';

function* retainedValueFields(value: unknown, key: string): Generator<string> {
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      for (const item of items) yield* retainedValueFields(item, key);
    } else if (value !== null && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        // Include keys even for empty objects/arrays, and do not JSON-escape them.
        yield name;
        yield* retainedValueFields(item, name);
      }
    } else {
      yield `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
    }
  }

/** Only accepts a chain already replayed by parseKnowledgeGenerationChain.
 * Scan decoded fields, not JSON-escaped source prose. Whole values retain their
 * key context and line boundaries; unrelated fields never become one sentence.
 * This covers all retained snapshots, reviews and metadata, not just live facts.
 */
export async function screenRetainedKnowledgeHistory(
  generations: readonly KnowledgeGenerationV1[],
  screen: (body: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  function* retainedFields(generation: KnowledgeGenerationV1): Generator<string> {
    yield* retainedValueFields(generation, 'generations');
    for (const source of generation.snapshot.sources) {
      // The replay already validated JSON syntax. Decode source keys too: an
      // escaped key with an empty container has no scalar evidence excerpt.
      if (source.format === 'json') yield* retainedValueFields(parseJsonWithLocationsStrict(source.content).value, 'content');
    }
  }
  for (const generation of generations) await screenKnowledgeFields(retainedFields(generation), screen, signal);
}

/** @internal Screen already structurally verified authority metadata before exact-byte archival. */
export async function screenRetainedKnowledgeValue(value: unknown, screen: (body: string) => Promise<void>,
  signal?: AbortSignal): Promise<void> {
  await screenKnowledgeFields(retainedValueFields(value, 'authority'), screen, signal);
}

async function screenKnowledgeFields(fields: Iterable<string>, screen: (body: string) => Promise<void>,
  signal?: AbortSignal): Promise<void> {
  // Deduplication must never grow with total retained history. Reset it with
  // every batch, while preserving each entire decoded field (even > 1 MiB).
  const seen = new Set<string>();
  let pending: string[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (signal?.aborted) invalid();
    if (pending.length > 0) await screen(pending.join('\n'));
    if (signal?.aborted) invalid();
    pending = [];
    bytes = 0;
    seen.clear();
  };
  for (const body of fields) {
    if (signal?.aborted) invalid();
    if (seen.has(body)) continue;
    const size = Buffer.byteLength(body, 'utf8') + 1;
    if (bytes > 0 && bytes + size > 1024 * 1024) await flush();
    pending.push(body);
    seen.add(body);
    bytes += size;
  }
  await flush();
}
