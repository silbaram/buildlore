export const WIKI_LIST_SCHEMA_VERSION = 'buildlore.wiki-list.v1' as const;
export const WIKI_PAGE_SCHEMA_VERSION = 'buildlore.wiki-page.v1' as const;
export const WIKI_CITATIONS_SCHEMA_VERSION = 'buildlore.wiki-citations.v1' as const;
export const WIKI_EXPORT_SCHEMA_VERSION = 'buildlore.wiki-export.v1' as const;

export type WikiPageRef = `${string}/${string}`;
export type WikiExportFormat = 'json' | 'okf';

export interface WikiPageSummaryV1 {
  readonly pageRef: WikiPageRef;
  readonly projectId: string;
  readonly schemaVersion: typeof WIKI_PAGE_SCHEMA_VERSION;
  readonly sourceCount: number;
  readonly summary: string;
  readonly title: string;
  readonly verified: true;
}

export interface WikiPageV1 extends WikiPageSummaryV1 {
  readonly body: string;
  readonly sourceRefs: readonly string[];
}

export interface CitationRangeV1 {
  readonly endColumn: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly startLine: number;
}

export interface CitationRecordV1 {
  readonly citationId: string;
  readonly jsonPointer?: string;
  readonly pageRef: WikiPageRef;
  readonly projectId: string;
  readonly range: CitationRangeV1;
  readonly sourceRef: string;
  readonly sourceRevision: `sha256:${string}`;
}

export interface WikiListResultV1 {
  readonly cursor?: string;
  readonly pages: readonly WikiPageSummaryV1[];
  readonly projectId: string;
  readonly schemaVersion: typeof WIKI_LIST_SCHEMA_VERSION;
  readonly total: number;
}

export interface WikiCitationsResultV1 {
  readonly citations: readonly CitationRecordV1[];
  readonly pageRef: WikiPageRef;
  readonly projectId: string;
  readonly schemaVersion: typeof WIKI_CITATIONS_SCHEMA_VERSION;
}

export interface WikiListInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly projectId: string;
}

export interface WikiPageInput {
  readonly pageRef: string;
  readonly projectId: string;
}

export interface WikiReadPort {
  citations(input: WikiPageInput): Promise<WikiCitationsResultV1>;
  list(input: WikiListInput): Promise<WikiListResultV1>;
  read(input: WikiPageInput): Promise<WikiPageV1>;
}

export interface WikiSnapshotPageV1 {
  readonly body: string;
  readonly citations: readonly CitationRecordV1[];
  readonly pageRef: WikiPageRef;
  readonly sourceRefs: readonly string[];
  readonly summary: string;
  readonly title: string;
}

export interface WikiSnapshotV1 {
  readonly digest: `sha256:${string}`;
  readonly pages: readonly WikiSnapshotPageV1[];
  readonly projectId: string;
}

export interface WikiSnapshotPort {
  snapshot(projectId: string): Promise<WikiSnapshotV1>;
}

export type WikiServicePort = WikiReadPort & WikiSnapshotPort;

export interface WikiExportInput {
  readonly format: WikiExportFormat;
  readonly outputRoot: string;
  readonly projectId: string;
}

export interface WikiExportResultV1 {
  readonly digest: `sha256:${string}`;
  readonly fileCount: number;
  readonly format: WikiExportFormat;
  readonly pageCount: number;
  readonly projectId: string;
  readonly schemaVersion: typeof WIKI_EXPORT_SCHEMA_VERSION;
}

export interface WikiExportPort {
  export(input: WikiExportInput): Promise<WikiExportResultV1>;
}

export interface WikiJsonExportV1 {
  readonly format: 'json';
  readonly pages: readonly WikiSnapshotPageV1[];
  readonly projectId: string;
  readonly schemaVersion: typeof WIKI_EXPORT_SCHEMA_VERSION;
}
