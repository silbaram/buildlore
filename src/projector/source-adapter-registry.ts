import { ProjectionError } from './errors.js';
import {
  MAX_SOURCE_METADATA_BYTES,
  MAX_SOURCE_METADATA_DEPTH,
  MAX_SOURCE_METADATA_KEYS,
  parseSourceAdapterRegistration,
  parseSourceMetadata,
  validateSourceOriginRange,
  type GenericSourceKind,
  type RegisteredMediaType,
  type RegisteredSourceKind,
  type SourceAdapterRegistrationV1,
  type SourceMetadataV1,
  type SourceOriginRangeV1,
  type SourceRangeMappingV1,
} from './source-contracts.js';

export const GENERIC_SOURCE_ADAPTER_ID = 'buildlore.generic' as const;
export const P2A_SOURCE_ADAPTER_ID = 'buildlore.p2a' as const;

export interface SourceAdapterDefinitionV1 {
  readonly registration: SourceAdapterRegistrationV1;
  readonly mapRange: (
    mappings: readonly SourceRangeMappingV1[],
    canonicalRange: SourceOriginRangeV1,
  ) => SourceOriginRangeV1;
}

export interface SourceAdapterResolution {
  readonly adapter: SourceAdapterDefinitionV1;
  readonly kind: RegisteredSourceKind;
  readonly mediaType: RegisteredMediaType;
  readonly metadata?: SourceMetadataV1;
}

export interface SourceAdapterResolutionInput {
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly kind: RegisteredSourceKind;
  readonly mediaType?: RegisteredMediaType;
  readonly metadata?: SourceMetadataV1;
}

export interface SourceAdapterRegistry {
  list(): readonly SourceAdapterRegistrationV1[];
  resolve(input: SourceAdapterResolutionInput): SourceAdapterResolution;
}

export interface CreateBuiltInSourceAdapterRegistryOptions {
  readonly includeP2a?: boolean;
  readonly registrations?: readonly SourceAdapterDefinitionV1[];
}

const GENERIC_REGISTRATION = parseSourceAdapterRegistration({
  adapterId: GENERIC_SOURCE_ADAPTER_ID,
  adapterVersion: 1,
  kinds: [
    { kind: 'code', mediaTypes: ['text/x-source-code'] },
    { kind: 'markdown', mediaTypes: ['text/markdown'] },
    { kind: 'text', mediaTypes: ['text/plain'] },
  ],
  limits: {
    maxMetadataBytes: MAX_SOURCE_METADATA_BYTES,
    maxMetadataDepth: MAX_SOURCE_METADATA_DEPTH,
    maxMetadataKeys: MAX_SOURCE_METADATA_KEYS,
  },
  metadataNamespace: GENERIC_SOURCE_ADAPTER_ID,
  metadataSchemaVersion: 'buildlore.generic-metadata.v1',
});

const P2A_REGISTRATION = parseSourceAdapterRegistration({
  adapterId: P2A_SOURCE_ADAPTER_ID,
  adapterVersion: 1,
  kinds: [
    {
      kind: 'execution',
      mediaTypes: ['application/json', 'application/x-ndjson', 'text/markdown'],
    },
    {
      kind: 'planning',
      mediaTypes: ['application/json', 'application/x-ndjson', 'text/markdown'],
    },
  ],
  limits: {
    maxMetadataBytes: MAX_SOURCE_METADATA_BYTES,
    maxMetadataDepth: MAX_SOURCE_METADATA_DEPTH,
    maxMetadataKeys: MAX_SOURCE_METADATA_KEYS,
  },
  metadataNamespace: P2A_SOURCE_ADAPTER_ID,
  metadataSchemaVersion: 'buildlore.p2a-metadata.v1',
});

function fail(message: string): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rangeContains(outer: SourceOriginRangeV1, inner: SourceOriginRangeV1): boolean {
  const startsAfter = inner.startLine > outer.startLine || (
    inner.startLine === outer.startLine && inner.startColumn >= outer.startColumn
  );
  const endsBefore = inner.endLine < outer.endLine || (
    inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn
  );
  return startsAfter && endsBefore;
}

function mapBoundedRange(
  mappings: readonly SourceRangeMappingV1[],
  value: SourceOriginRangeV1,
): SourceOriginRangeV1 {
  const canonicalRange = validateSourceOriginRange(value);
  const validatedMappings = mappings.map((mapping) => Object.freeze({
    canonical: validateSourceOriginRange(mapping.canonical),
    origin: validateSourceOriginRange(mapping.origin),
  }));
  if (validatedMappings.some((mapping) =>
    mapping.canonical.endLine - mapping.canonical.startLine !==
      mapping.origin.endLine - mapping.origin.startLine)) {
    return fail('Source range mapping is invalid.');
  }
  const matches = validatedMappings.filter((mapping) =>
    rangeContains(mapping.canonical, canonicalRange));
  if (matches.length !== 1) return fail('Source range mapping is unavailable.');
  const mapping = matches[0];
  if (mapping === undefined) return fail('Source range mapping is unavailable.');
  const startLineDelta = canonicalRange.startLine - mapping.canonical.startLine;
  const endLineDelta = canonicalRange.endLine - mapping.canonical.startLine;
  const startColumn = canonicalRange.startLine === mapping.canonical.startLine
    ? mapping.origin.startColumn + canonicalRange.startColumn - mapping.canonical.startColumn
    : canonicalRange.startColumn;
  const endColumn = canonicalRange.endLine === mapping.canonical.endLine
    ? mapping.origin.endColumn + canonicalRange.endColumn - mapping.canonical.endColumn
    : canonicalRange.endColumn;
  return validateSourceOriginRange({
    endColumn,
    endLine: mapping.origin.startLine + endLineDelta,
    startColumn,
    startLine: mapping.origin.startLine + startLineDelta,
  });
}

function adapter(registration: SourceAdapterRegistrationV1): SourceAdapterDefinitionV1 {
  return Object.freeze({
    mapRange: mapBoundedRange,
    registration,
  });
}

export function genericSourceAdapter(): SourceAdapterDefinitionV1 {
  return adapter(GENERIC_REGISTRATION);
}

export function p2aSourceAdapter(): SourceAdapterDefinitionV1 {
  return adapter(P2A_REGISTRATION);
}

export function mediaTypeForGenericKind(kind: GenericSourceKind): RegisteredMediaType {
  switch (kind) {
    case 'code':
      return 'text/x-source-code';
    case 'markdown':
      return 'text/markdown';
    case 'text':
      return 'text/plain';
  }
}

export function createSourceAdapterRegistry(
  adapters: readonly SourceAdapterDefinitionV1[],
): SourceAdapterRegistry {
  const byId = new Map<string, SourceAdapterDefinitionV1>();
  const namespaces = new Set<string>();
  const kinds = new Set<RegisteredSourceKind>();
  for (const candidate of adapters) {
    const registration = parseSourceAdapterRegistration(candidate.registration);
    if (byId.has(registration.adapterId)) return fail('Source adapter id is duplicated.');
    if (namespaces.has(registration.metadataNamespace)) {
      return fail('Source adapter metadata namespace is duplicated.');
    }
    for (const entry of registration.kinds) {
      if (kinds.has(entry.kind)) return fail('Source adapter kind is duplicated.');
      kinds.add(entry.kind);
    }
    byId.set(registration.adapterId, Object.freeze({
      mapRange: (
        mappings: readonly SourceRangeMappingV1[],
        canonicalRange: SourceOriginRangeV1,
      ) => candidate.mapRange(mappings, canonicalRange),
      registration,
    }));
    namespaces.add(registration.metadataNamespace);
  }
  if (byId.size < 1) return fail('At least one source adapter is required.');
  return Object.freeze({
    list(): readonly SourceAdapterRegistrationV1[] {
      return Object.freeze([...byId.values()]
        .map((entry) => entry.registration)
        .sort((left, right) => compareText(left.adapterId, right.adapterId)));
    },
    resolve(input: SourceAdapterResolutionInput): SourceAdapterResolution {
      const selected = byId.get(input.adapterId);
      if (
        selected === undefined ||
        input.adapterVersion !== selected.registration.adapterVersion
      ) return fail('Source adapter registration is unavailable.');
      const kind = selected.registration.kinds.find((entry) => entry.kind === input.kind);
      if (kind === undefined) return fail('Source adapter kind is unavailable.');
      const mediaType = input.mediaType ?? kind.mediaTypes[0];
      if (mediaType === undefined || !kind.mediaTypes.includes(mediaType)) {
        return fail('Source adapter media type is unavailable.');
      }
      let metadata: SourceMetadataV1 | undefined;
      if (input.metadata !== undefined) {
        metadata = parseSourceMetadata(input.metadata);
        if (
          metadata.namespace !== selected.registration.metadataNamespace ||
          metadata.schemaVersion !== selected.registration.metadataSchemaVersion
        ) return fail('Source adapter metadata binding is unavailable.');
      }
      return Object.freeze({
        adapter: selected,
        kind: input.kind,
        mediaType,
        ...(metadata === undefined ? {} : { metadata }),
      });
    },
  });
}

export function createBuiltInSourceAdapterRegistry(
  options: CreateBuiltInSourceAdapterRegistryOptions = {},
): SourceAdapterRegistry {
  const adapters = [
    genericSourceAdapter(),
    ...(options.includeP2a === false ? [] : [p2aSourceAdapter()]),
    ...(options.registrations ?? []),
  ];
  return createSourceAdapterRegistry(adapters);
}
