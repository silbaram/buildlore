const MAX_JSON_DEPTH = 64;

export class StrictJsonSyntaxError extends SyntaxError {
  constructor() {
    super('JSON input is invalid.');
    this.name = 'StrictJsonSyntaxError';
  }
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

/** Parse the JSON grammar while refusing duplicate object member names. */
export function parseJsonStrict(source: string): unknown {
  if (source.charCodeAt(0) === 0xfeff) fail();
  let offset = 0;

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
          if (typeof value !== 'string') fail();
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

  const value = (depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) fail();
    whitespace();
    const character = source[offset];
    if (character === '"') return string();
    if (character === '{') {
      offset += 1;
      whitespace();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      if (source[offset] === '}') {
        offset += 1;
        return result;
      }
      while (offset < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (source[offset] !== ':') fail();
        offset += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (source[offset] === '}') {
          offset += 1;
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
        return result;
      }
      while (offset < source.length) {
        result.push(value(depth + 1));
        whitespace();
        if (source[offset] === ']') {
          offset += 1;
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
        return parsed;
      }
    }
    const number = source.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (number === undefined) fail();
    offset += number.length;
    const parsed = Number(number);
    if (!Number.isFinite(parsed)) fail();
    return parsed;
  };

  const parsed = value(0);
  whitespace();
  if (offset !== source.length) fail();
  return parsed;
}
