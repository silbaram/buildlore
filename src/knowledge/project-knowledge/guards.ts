import { createHash } from 'node:crypto';
import { serializeCanonicalJson } from '../atomic-file.js';
import { parseJsonWithLocationsStrict } from '../strict-json.js';
import type { KnowledgeDigest } from './types.js';

export class ProjectKnowledgeError extends Error {
  readonly code: 'KNOWLEDGE_INVALID' | 'KNOWLEDGE_REVIEW_REQUIRED' | 'KNOWLEDGE_DRIFT'
    | 'KNOWLEDGE_SECURITY_BLOCKED' | 'KNOWLEDGE_SECURITY_INPUT_TOO_LARGE' | 'KNOWLEDGE_CONTEXT_BUDGET_EXCEEDED'
    | 'KNOWLEDGE_COMPLETENESS_BUDGET_EXCEEDED';

  constructor(code: ProjectKnowledgeError['code'] = 'KNOWLEDGE_INVALID') {
    super(code === 'KNOWLEDGE_REVIEW_REQUIRED' ? 'Knowledge requires an independent support review.'
      : code === 'KNOWLEDGE_DRIFT' ? 'Knowledge inputs no longer match the reviewed snapshot.'
        : code === 'KNOWLEDGE_SECURITY_BLOCKED' ? 'Knowledge security screening rejected the input.'
          : code === 'KNOWLEDGE_SECURITY_INPUT_TOO_LARGE' ? 'A knowledge security scan input exceeds the size limit.'
            : code === 'KNOWLEDGE_CONTEXT_BUDGET_EXCEEDED' ? 'Knowledge reader context exceeds the fixed evaluation budget.'
              : code === 'KNOWLEDGE_COMPLETENESS_BUDGET_EXCEEDED' ? 'Knowledge completeness input exceeds the bounded workflow limit.'
        : 'Project knowledge contract is invalid.');
    this.name = 'ProjectKnowledgeError';
    this.code = code;
  }
}

export function invalid(): never { throw new ProjectKnowledgeError(); }
export function sha256(text: string): KnowledgeDigest {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
/** Object-key order is not part of the new language-neutral knowledge identity.
 * Keep the legacy serializer unchanged: older hierarchy digests use its declared
 * property order and must remain readable.
 */
export function digest(value: unknown): KnowledgeDigest {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map((entry: unknown) => canonical(entry));
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b))
        .map(([key, entry]) => [key, canonical(entry)]));
    }
    return item;
  }
  return sha256(serializeCanonicalJson(canonical(value)));
}
export function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Readonly<Record<string, unknown>>;
}
export function keys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  if (Object.keys(value).sort(compare).join('\0') !== [...expected].sort(compare).join('\0')) invalid();
}
export function text(value: unknown, maximum = 16_384): string {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value) > maximum ||
      [...value].some((c) => c.charCodeAt(0) === 127 ||
        (c.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(c))) || !value.isWellFormed()) invalid();
  return value;
}
export function nullableText(value: unknown, maximum = 256): string | null {
  return value === null ? null : text(value, maximum);
}
export function hash(value: unknown): KnowledgeDigest {
  const result = text(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) invalid();
  return result as KnowledgeDigest;
}
export function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value as readonly unknown[];
}
export function hashes(value: unknown, maximum = 8192): readonly KnowledgeDigest[] {
  const result = list(value, maximum).map(hash).sort(compare);
  if (new Set(result).size !== result.length) invalid();
  return Object.freeze(result);
}
export function choice<T extends string>(value: unknown, values: readonly T[]): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) invalid();
  return found;
}
export function portablePath(value: unknown): string {
  const result = text(value, 1024);
  if (result.startsWith('/') || /[\\:]/u.test(result) || [...result].some((c) => c.charCodeAt(0) < 32) ||
      result.split('/').some((part) => part === '' || part === '.' || part === '..')) invalid();
  return result;
}
export function identifier(value: unknown): string {
  const result = text(value, 256);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(result)) invalid();
  return result;
}
export function project(value: unknown, expected: string): string {
  const result = text(value, 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result) || result !== expected) invalid();
  return result;
}
/** Reject non-JSON values, cycles and excessive aggregate input before recursive codecs. */
export function boundedJson(value: unknown): unknown {
  // JSON.stringify silently drops undefined/function fields, converts NaN to
  // null and invokes toJSON/getters. Reject those values before normalization.
  const ancestors = new Set<object>();
  const pending: { value: unknown; depth: number; leave?: boolean }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) invalid();
    if (item.leave) { ancestors.delete(item.value as object); continue; }
    nodes += 1;
    if (nodes > 300_000 || item.depth > 24) invalid();
    if (item.value === null || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'string') {
      if (item.value.length > 524_288 || !item.value.isWellFormed()) invalid();
      continue;
    }
    if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value)) invalid();
      continue;
    }
    if (typeof item.value !== 'object' || ancestors.has(item.value)) invalid();
    const array = Array.isArray(item.value);
    const prototype: unknown = Object.getPrototypeOf(item.value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    if (Object.getOwnPropertySymbols(item.value).length !== 0) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(item.value);
    const names = Object.keys(descriptors).filter((name) => !array || name !== 'length');
    if (array ? names.length > 8192 || names.length !== (item.value as unknown[]).length ||
      names.some((name, index) => name !== String(index)) : names.length > 64) invalid();
    ancestors.add(item.value);
    pending.push({ ...item, leave: true });
    for (const name of names) {
      const property = descriptors[name];
      if (!property || !('value' in property) || !property.enumerable) invalid();
      pending.push({ value: property.value as unknown, depth: item.depth + 1 });
    }
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return invalid(); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 16 * 1024 * 1024) invalid();
  try {
    return parseJsonWithLocationsStrict(serialized, {
      maxDepth: 24, maxArrayItems: 8192, maxNodes: 300_000,
      maxObjectMembers: 64, maxStringScalars: 262_144,
    }).value;
  } catch { return invalid(); }
}
