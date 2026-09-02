import type {
  SourceDescriptorV1,
  SourceRangeMappingV1,
} from './source-contracts.js';

export const SOURCE_DOCUMENT_SCHEMA_VERSION = 'buildlore.source.v1' as const;
export const SOURCE_DOCUMENT_V2_SCHEMA_VERSION = 'buildlore.source.v2' as const;
export const MAX_SOURCE_BODY_CHARS = 100_000;

export type SourceType = 'file' | 'image' | 'pdf' | 'transcript' | 'web';

export interface BuildLoreSourceMetadata {
  readonly contentHash: `sha256:${string}`;
  readonly producer: string;
  readonly projectId: string;
  readonly descriptor?: SourceDescriptorV1;
  readonly originMappings?: readonly SourceRangeMappingV1[];
  readonly schemaVersion:
    | typeof SOURCE_DOCUMENT_SCHEMA_VERSION
    | typeof SOURCE_DOCUMENT_V2_SCHEMA_VERSION;
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
    | typeof SOURCE_DOCUMENT_V2_SCHEMA_VERSION;
  readonly source: string;
  readonly sourceType?: SourceType;
  readonly title: string;
  readonly truncated?: true;
}

export interface CreateSourceDocumentInput {
  readonly body: string;
  readonly descriptor?: SourceDescriptorV1;
  readonly ingestedAt: string;
  readonly originMappings?: readonly SourceRangeMappingV1[];
  readonly producer: string;
  readonly projectId: string;
  readonly source: string;
  readonly sourceKind: string;
  readonly sourceRevision: `sha256:${string}`;
  readonly sourceType?: SourceType;
  readonly title: string;
}
