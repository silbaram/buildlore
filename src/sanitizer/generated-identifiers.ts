export const GENERATED_SOURCE_KINDS = Object.freeze([
  'execution',
  'markdown',
  'planning',
] as const);

export type GeneratedSourceKind = typeof GENERATED_SOURCE_KINDS[number];

export const GENERATED_IDENTIFIER_PREFIXES = Object.freeze([
  'anchor',
  'candidate',
  'merge',
  'source',
  'task',
] as const);

export type GeneratedIdentifierPrefix = typeof GENERATED_IDENTIFIER_PREFIXES[number];

const GENERATED_SOURCE_KIND_SET: ReadonlySet<string> = new Set(GENERATED_SOURCE_KINDS);
const GENERATED_IDENTIFIER_PREFIX_SET: ReadonlySet<string> =
  new Set(GENERATED_IDENTIFIER_PREFIXES);
const GENERATED_SOURCE_FILENAME_PATTERN = new RegExp(
  `^(${GENERATED_SOURCE_KINDS.join('|')})--([a-f0-9]{64})\\.md$`,
  'u',
);
const GENERATED_IDENTIFIER_PATTERN = new RegExp(
  `^(${GENERATED_IDENTIFIER_PREFIXES.join('|')})-([a-f0-9]{64})$`,
  'u',
);

function isGeneratedSourceKind(value: string): value is GeneratedSourceKind {
  return GENERATED_SOURCE_KIND_SET.has(value);
}

function isGeneratedIdentifierPrefix(value: string): value is GeneratedIdentifierPrefix {
  return GENERATED_IDENTIFIER_PREFIX_SET.has(value);
}

export function generatedSourceFilenameKind(value: string): GeneratedSourceKind | null {
  const match = GENERATED_SOURCE_FILENAME_PATTERN.exec(value);
  const kind = match?.[1];
  return kind !== undefined && isGeneratedSourceKind(kind) ? kind : null;
}

export function isGeneratedIdentifier(
  value: string,
  expectedPrefix?: GeneratedIdentifierPrefix,
): boolean {
  const match = GENERATED_IDENTIFIER_PATTERN.exec(value);
  const prefix = match?.[1];
  return prefix !== undefined && isGeneratedIdentifierPrefix(prefix) &&
    (expectedPrefix === undefined || prefix === expectedPrefix);
}
