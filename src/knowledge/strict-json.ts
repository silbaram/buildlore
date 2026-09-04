import { unicodeScalarLength } from '../projector/text-units.js';

export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_NODES = 100_000;
export const MAX_JSON_OBJECT_MEMBERS = 10_000;
export const MAX_JSON_ARRAY_ITEMS = 10_000;
export const MAX_JSON_STRING_SCALARS = 16_384;
const MAX_CONFIGURABLE_JSON_LIMIT = Number.MAX_SAFE_INTEGER;

export interface JsonSourcePosition {
  readonly column: number;
  readonly line: number;
}

export interface JsonSourceRange {
  readonly end: JsonSourcePosition;
  readonly start: JsonSourcePosition;
}

export interface StrictJsonLocation {
  readonly pointer: string;
  readonly range: JsonSourceRange;
}

export interface StrictJsonDocument {
  readonly locations: readonly StrictJsonLocation[];
  readonly value: unknown;
}

export interface StrictJsonLimits {
  readonly maxArrayItems?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxObjectMembers?: number;
  readonly maxStringScalars?: number;
}

export class StrictJsonSyntaxError extends SyntaxError {
  constructor() {
    super('JSON input is invalid.');
    this.name = 'StrictJsonSyntaxError';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedLimit(value: number | undefined, defaultValue: number, maximum = defaultValue): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail();
  return value;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
  }
  return value;
}

function fail(): never {
  throw new StrictJsonSyntaxError();
}

/** Decode UTF-8 without replacement characters or a leading byte-order mark. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail();
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail();
  }
  if (value.charCodeAt(0) === 0xfeff) fail();
  return value;
}

/** Parse strict JSON and retain an RFC 6901 pointer-to-source location index. */
export function parseJsonWithLocationsStrict(
  source: string,
  limits: StrictJsonLimits = {},
): StrictJsonDocument {
  if (source.charCodeAt(0) === 0xfeff) fail();
  let offset = 0;
  let nodeCount = 0;
  const ranges: Array<Readonly<{ endOffset: number; pointer: string; startOffset: number }>> = [];
  const maximums = Object.freeze({
    arrayItems: boundedLimit(
      limits.maxArrayItems,
      MAX_JSON_ARRAY_ITEMS,
      MAX_CONFIGURABLE_JSON_LIMIT,
    ),
    depth: boundedLimit(limits.maxDepth, MAX_JSON_DEPTH),
    nodes: boundedLimit(limits.maxNodes, MAX_JSON_NODES, MAX_CONFIGURABLE_JSON_LIMIT),
    objectMembers: boundedLimit(
      limits.maxObjectMembers,
      MAX_JSON_OBJECT_MEMBERS,
      MAX_CONFIGURABLE_JSON_LIMIT,
    ),
    stringScalars: boundedLimit(
      limits.maxStringScalars,
      MAX_JSON_STRING_SCALARS,
      MAX_CONFIGURABLE_JSON_LIMIT,
    ),
  });

  const whitespace = (): void => {
    while (offset < source.length && [0x09, 0x0a, 0x0d, 0x20]
      .includes(source.charCodeAt(offset))) {
      offset += 1;
    }
  };

  const string = (): string => {
    if (source[offset] !== '"') fail();
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < source.length) {
      const character = source[offset];
      const code = source.charCodeAt(offset);
      if (!escaped && character === '"') {
        offset += 1;
        try {
          const value = JSON.parse(source.slice(start, offset)) as unknown;
          if (
            typeof value !== 'string' ||
            unicodeScalarLength(value) > maximums.stringScalars ||
            hasUnpairedSurrogate(value)
          ) fail();
          return value;
        } catch {
          return fail();
        }
      }
      if (!escaped && (code < 0x20 || character === undefined)) fail();
      if (!escaped && character === '\\') {
        escaped = true;
      } else {
        escaped = false;
      }
      offset += 1;
    }
    return fail();
  };

  const value = (depth: number, pointer: string): unknown => {
    if (depth > maximums.depth) fail();
    whitespace();
    nodeCount += 1;
    if (nodeCount > maximums.nodes) fail();
    const startOffset = offset;
    const character = source[offset];
    if (character === '"') {
      const result = string();
      ranges.push(Object.freeze({ endOffset: offset, pointer, startOffset }));
      return result;
    }
    if (character === '{') {
      offset += 1;
      whitespace();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      if (source[offset] === '}') {
        offset += 1;
        ranges.push(Object.freeze({ endOffset: offset, pointer, startOffset }));
        return result;
      }
      while (offset < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        if (keys.size > maximums.objectMembers) fail();
        whitespace();
        if (source[offset] !== ':') fail();
        offset += 1;
        result[key] = value(depth + 1, `${pointer}/${escapePointerSegment(key)}`);
        whitespace();
        if (source[offset] === '}') {
          offset += 1;
          ranges.push(Object.freeze({ endOffset: offset, pointer, startOffset }));
          return result;
        }
        if (source[offset] !== ',') fail();
        offset += 1;
      }
      return fail();
    }
    if (character === '[') {
      offset += 1;
      whitespace();
      const result: unknown[] = [];
      if (source[offset] === ']') {
        offset += 1;
        ranges.push(Object.freeze({ endOffset: offset, pointer, startOffset }));
        return result;
      }
      while (offset < source.length) {
        if (result.length >= maximums.arrayItems) fail();
        result.push(value(depth + 1, `${pointer}/${String(result.length)}`));
        whitespace();
        if (source[offset] === ']') {
          offset += 1;
          ranges.push(Object.freeze({ endOffset: offset, pointer, startOffset }));
          return result;
        }
        if (source[offset] !== ',') fail();
        offset += 1;
      }
      return fail();
    }
    for (const [literal, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        ranges.push(Object.freeze({ endOffset: offset, pointer, startOffset }));
        return parsed;
      }
    }
    const number = source.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (number === undefined) fail();
    offset += number.length;
    const parsed = Number(number);
    if (!Number.isFinite(parsed)) fail();
    ranges.push(Object.freeze({ endOffset: offset, pointer, startOffset }));
    return parsed;
  };

  const parsed = value(0, '');
  whitespace();
  if (offset !== source.length) fail();

  const boundaries = new Set<number>();
  for (const range of ranges) {
    boundaries.add(range.startOffset);
    boundaries.add(range.endOffset);
  }
  const positions = new Map<number, JsonSourcePosition>();
  let line = 1;
  let column = 1;
  for (let index = 0; index <= source.length; index += 1) {
    if (boundaries.has(index)) positions.set(index, Object.freeze({ column, line }));
    if (index === source.length) break;
    const code = source.charCodeAt(index);
    if (code === 0x0a) {
      line += 1;
      column = 1;
    } else if (code === 0x0d) {
      if (source.charCodeAt(index + 1) === 0x0a) index += 1;
      line += 1;
      column = 1;
    } else {
      if (code >= 0xd800 && code <= 0xdbff) index += 1;
      column += 1;
    }
  }
  const locations = ranges
    .map((range) => {
      const start = positions.get(range.startOffset);
      const end = positions.get(range.endOffset);
      if (start === undefined || end === undefined) fail();
      return Object.freeze({ pointer: range.pointer, range: Object.freeze({ end, start }) });
    })
    .sort((left, right) => compareText(left.pointer, right.pointer));
  if (new Set(locations.map((entry) => entry.pointer)).size !== locations.length) fail();
  return Object.freeze({
    locations: Object.freeze(locations),
    value: deepFreeze(parsed),
  });
}

/** Parse the JSON grammar while refusing duplicate object member names. */
export function parseJsonStrict(source: string): unknown {
  const sourceBound = Math.max(1, unicodeScalarLength(source));
  return parseJsonWithLocationsStrict(source, {
    maxArrayItems: sourceBound,
    maxNodes: sourceBound,
    maxObjectMembers: sourceBound,
    maxStringScalars: sourceBound,
  }).value;
}
