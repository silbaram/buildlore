import type {
  SourceDescriptor,
  SourceJsonOriginMappingV1,
  SourceRangeMappingV1,
} from './source-contracts.js';

export const SOURCE_DOCUMENT_SCHEMA_VERSION = 'buildlore.source.v1' as const;
export const SOURCE_DOCUMENT_V2_SCHEMA_VERSION = 'buildlore.source.v2' as const;
export const SOURCE_DOCUMENT_V3_SCHEMA_VERSION = 'buildlore.source.v3' as const;
export const MAX_SOURCE_BODY_CHARS = 100_000;
export const MAX_SOURCE_ORIGIN_MAPPINGS = 128;

export type SourceType = 'file' | 'image' | 'pdf' | 'transcript' | 'web';

export interface BuildLoreSourceMetadata {
  readonly contentHash: `sha256:${string}`;
  readonly producer: string;
  readonly projectId: string;
  readonly descriptor?: SourceDescriptor;
  readonly jsonOrigins?: readonly SourceJsonOriginMappingV1[];
  readonly originMappings?: readonly SourceRangeMappingV1[];
  readonly schemaVersion:
    | typeof SOURCE_DOCUMENT_SCHEMA_VERSION
    | typeof SOURCE_DOCUMENT_V2_SCHEMA_VERSION
    | typeof SOURCE_DOCUMENT_V3_SCHEMA_VERSION;
  readonly sourceKind: string;
  readonly sourceRevision: `sha256:${string}`;
}

export interface SourceDocument {
  readonly body: string;
  readonly buildlore: BuildLoreSourceMetadata;
  readonly ingestedAt: string;
  readonly originalChars?: number;
  readonly schemaVersion:
    | typeof SOURCE_DOCUMENT_SCHEMA_VERSION
    | typeof SOURCE_DOCUMENT_V2_SCHEMA_VERSION
    | typeof SOURCE_DOCUMENT_V3_SCHEMA_VERSION;
  readonly source: string;
  readonly sourceType?: SourceType;
  readonly title: string;
  readonly truncated?: true;
}

export interface CreateSourceDocumentInput {
  readonly body: string;
  readonly descriptor?: SourceDescriptor;
  readonly ingestedAt: string;
  readonly originMappings?: readonly SourceRangeMappingV1[];
  readonly jsonOrigins?: readonly SourceJsonOriginMappingV1[];
  readonly producer: string;
  readonly projectId: string;
  readonly source: string;
  readonly sourceKind: string;
  readonly sourceRevision: `sha256:${string}`;
  readonly sourceType?: SourceType;
  readonly title: string;
}
