import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import {
  decodeUtf8Strict,
  parseJsonWithLocationsStrict,
  type JsonSourceRange,
  type StrictJsonDocument,
} from '../knowledge/strict-json.js';
import type { Sha256Digest, SourceCheckoutHandle } from '../knowledge/local-project-registry.js';
import type {
  SourceAdapterProjectionInputV1,
  SourceAdapterV1,
  SourceCollectionAdapterResult,
} from './collection-adapters.js';
import { ProjectionError } from './errors.js';
import {
  parseJsonExtractionProfiles,
  renderJsonExtractionProfile,
  selectJsonExtractionProfile,
} from './json-extraction-profile.js';
import {
  JSON_SOURCE_ADAPTER_ID,
  type SourceAdapterDefinitionV1,
} from './source-adapter-registry.js';
import {
  parseSourceDescriptor,
  SOURCE_DESCRIPTOR_V2_SCHEMA_VERSION,
  type SourceDescriptorV2,
  type SourceJsonOriginMappingV1,
  type SourceOriginRangeV1,
} from './source-contracts.js';
import { createCollectionSourceIdentity } from './source-identity.js';
import {
  MAX_SELECTED_SOURCE_FILE_BYTES,
  readSelectedSourceBytes,
  type SelectedSourceFile,
} from './source-manifest.js';
import { projectSourceProducer, type ProjectSourceInput } from './project-source-writer.js';
import { bindRawSourceInputs, inspectRawSourceInputs } from './raw-source-inputs.js';
import { createSourceDocument } from './source-document.js';
import { unicodeScalarLength } from './text-units.js';
import { MAX_SOURCE_BODY_CHARS, MAX_SOURCE_ORIGIN_MAPPINGS, type SourceDocument } from './types.js';

export const JSON_PROJECTION_CONTRACT_VERSION = 'buildlore.json-projection.v1' as const;

export interface JsonSourceProjectionInput {
  readonly checkout: SourceCheckoutHandle;
  readonly ingestedAt: string;
  readonly projectId: string;
  readonly repository: string;
  readonly selectedFile: SelectedSourceFile;
}

export interface JsonCollectionCandidate extends ProjectSourceInput {
  readonly adapterId: typeof JSON_SOURCE_ADAPTER_ID;
  readonly adapterVersion: 1;
  readonly canonicalDocument: SourceDocument;
  readonly contentDigest: Sha256Digest;
  readonly declarationId: string;
  readonly descriptor: SourceDescriptorV2;
  readonly documentKind: 'json';
  readonly jsonOrigins: readonly SourceJsonOriginMappingV1[];
  readonly mediaType: 'application/json';
  readonly producer: 'buildlore';
  readonly projectId: string;
  readonly sourceKind: 'json';
  readonly sourceRef: string;
}

interface RenderedJson {
  readonly body: string;
  readonly origins: readonly SourceJsonOriginMappingV1[];
  readonly title?: string;
}

function fail(message: string): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function sourceRange(value: JsonSourceRange): SourceOriginRangeV1 {
  return Object.freeze({
    endColumn: value.end.column,
    endLine: value.end.line,
    startColumn: value.start.column,
    startLine: value.start.line,
  });
}

function scalarText(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (rendered === undefined) return fail('A JSON scalar is invalid.');
  return rendered;
}

function label(value: string): string {
  return JSON.stringify(value);
}

function heading(depth: number, value: string): string {
  const level = Math.min(6, Math.max(2, depth + 2));
  return `${'#'.repeat(level)} ${value}`;
}

function renderJson(
  document: StrictJsonDocument,
  sourceRef: string,
  contentHash: Sha256Digest,
): RenderedJson {
  const locations = new Map(document.locations.map((entry) => [entry.pointer, entry.range] as const));
  const lines: string[] = [];
  const origins: SourceJsonOriginMappingV1[] = [];

  const emit = (line: string, pointer: string): void => {
    const range = locations.get(pointer);
    if (range === undefined || origins.length >= MAX_SOURCE_ORIGIN_MAPPINGS) {
      return fail('JSON projection exceeds its origin mapping limit.');
    }
    if (unicodeScalarLength(line) + 1 > MAX_SOURCE_BODY_CHARS) {
      return fail('JSON projection exceeds its output limit.');
    }
    const lineNumber = lines.length + 1;
    lines.push(line);
    origins.push(Object.freeze({
      canonical: Object.freeze({
        endColumn: unicodeScalarLength(line) + 1,
        endLine: lineNumber,
        startColumn: 1,
        startLine: lineNumber,
      }),
      origin: Object.freeze({
        contentHash,
        jsonPointer: pointer,
        range: sourceRange(range),
        sourceRef,
      }),
    }));
  };

  const visit = (value: unknown, pointer: string, depth: number): void => {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        emit('_Empty array._', pointer);
        return;
      }
      value.forEach((entry, index) => {
        const childPointer = `${pointer}/${String(index)}`;
        if (typeof entry !== 'object' || entry === null) {
          emit(`${String(index + 1)}. ${scalarText(entry)}`, childPointer);
        } else {
          emit(heading(depth, `Item ${String(index + 1)}`), childPointer);
          visit(entry, childPointer, depth + 1);
        }
      });
      return;
    }
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
      if (entries.length === 0) {
        emit('_Empty object._', pointer);
        return;
      }
      for (const [key, entry] of entries) {
        const childPointer = `${pointer}/${pointerSegment(key)}`;
        emit(heading(depth, label(key)), childPointer);
        if (typeof entry !== 'object' || entry === null) {
          emit(scalarText(entry), childPointer);
        } else {
          visit(entry, childPointer, depth + 1);
        }
      }
      return;
    }
    emit(scalarText(value), pointer);
  };

  visit(document.value, '', 0);
  const body = lines.join('\n');
  if (unicodeScalarLength(body) > MAX_SOURCE_BODY_CHARS) {
    return fail('JSON projection exceeds its output limit.');
  }
  return Object.freeze({ body, origins: Object.freeze(origins) });
}

function fallbackTitle(sourceRef: string): string {
  const name = basename(sourceRef, extname(sourceRef)).replace(/[-_]+/gu, ' ').trim();
  return Array.from(name.length === 0 ? 'JSON document' : name).slice(0, 250).join('');
}

export async function projectSelectedJsonSource(
  input: JsonSourceProjectionInput,
): Promise<JsonCollectionCandidate> {
  if (
    input.selectedFile.documentKind !== 'json' ||
    input.selectedFile.kind !== 'json' ||
    input.selectedFile.mediaType !== 'application/json' ||
    input.selectedFile.adapterId !== JSON_SOURCE_ADAPTER_ID ||
    input.selectedFile.adapterVersion !== 1 ||
    input.selectedFile.byteLength > MAX_SELECTED_SOURCE_FILE_BYTES
  ) return fail('Selected JSON source binding is invalid.');
  const bytes = await readSelectedSourceBytes(input.checkout, input.selectedFile);
  let decoded: string;
  let parsed: StrictJsonDocument;
  try {
    decoded = decodeUtf8Strict(bytes);
    parsed = parseJsonWithLocationsStrict(decoded);
  } catch {
    return fail('A selected JSON source is invalid.');
  }
  const metadataValues = input.selectedFile.metadata?.values;
  let appliedProfile;
  let projected: RenderedJson;
  try {
    const profiles = metadataValues?.profiles === undefined
      ? Object.freeze([])
      : parseJsonExtractionProfiles(metadataValues.profiles);
    if (metadataValues?.profileRequired !== undefined &&
        typeof metadataValues.profileRequired !== 'boolean') {
      return fail('JSON extraction profile requirement is invalid.');
    }
    appliedProfile = selectJsonExtractionProfile(
      parsed,
      profiles,
      metadataValues?.profileRequired === true,
    );
    projected = appliedProfile === undefined
      ? renderJson(parsed, input.selectedFile.sourceRef, input.selectedFile.contentDigest)
      : renderJsonExtractionProfile(
          parsed,
          appliedProfile,
          input.selectedFile.sourceRef,
          input.selectedFile.contentDigest,
        );
  } catch {
    return fail('A selected JSON extraction profile is invalid.');
  }
  const sourceUri = createCollectionSourceIdentity({
    declarationId: input.selectedFile.declarationId,
    documentKind: 'json',
    projectId: input.projectId,
    repository: input.repository,
    sourceRef: input.selectedFile.sourceRef,
  });
  const projectionRevision = sha256(serializeCanonicalJson({
    adapterId: JSON_SOURCE_ADAPTER_ID,
    adapterVersion: 1,
    body: projected.body,
    contentHash: input.selectedFile.contentDigest,
    contractVersion: JSON_PROJECTION_CONTRACT_VERSION,
    profileDigest: appliedProfile?.contentDigest ?? null,
    sourceRef: input.selectedFile.sourceRef,
  }));
  const parsedDescriptor = parseSourceDescriptor({
    adapterId: JSON_SOURCE_ADAPTER_ID,
    adapterVersion: 1,
    contentHash: input.selectedFile.contentDigest,
    declarationId: input.selectedFile.declarationId,
    inputBindings: [{
      contentHash: input.selectedFile.contentDigest,
      sourceRef: input.selectedFile.sourceRef,
    }],
    kind: 'json',
    mediaType: 'application/json',
    ...(input.selectedFile.metadata === undefined ? {} : { metadata: input.selectedFile.metadata }),
    ...(appliedProfile === undefined ? {} : {
      profileBinding: {
        contentDigest: appliedProfile.contentDigest,
        id: appliedProfile.profile.id,
        schemaVersion: appliedProfile.profile.schemaVersion,
      },
    }),
    projectId: input.projectId,
    projectionRevision,
    schemaVersion: SOURCE_DESCRIPTOR_V2_SCHEMA_VERSION,
    sourceRef: input.selectedFile.sourceRef,
    sourceRevision: projectionRevision,
    sourceUri,
  });
  if (parsedDescriptor.schemaVersion !== SOURCE_DESCRIPTOR_V2_SCHEMA_VERSION) {
    return fail('JSON source descriptor is invalid.');
  }
  const descriptor = parsedDescriptor;
  const candidate = {
    adapterId: JSON_SOURCE_ADAPTER_ID,
    adapterVersion: 1 as const,
    body: projected.body,
    contentDigest: input.selectedFile.contentDigest,
    declarationId: input.selectedFile.declarationId,
    descriptor,
    documentKind: 'json' as const,
    ingestedAt: input.ingestedAt,
    jsonOrigins: projected.origins,
    mediaType: 'application/json' as const,
    producer: 'buildlore' as const,
    projectId: input.projectId,
    sourceKind: 'json' as const,
    sourceRef: input.selectedFile.sourceRef,
    sourceRevision: projectionRevision,
    sourceUri,
    target: `json--${sha256(sourceUri).slice('sha256:'.length)}.md`,
    title: projected.title ?? fallbackTitle(input.selectedFile.sourceRef),
  };
  projectSourceProducer(candidate);
  let canonicalDocument: SourceDocument;
  try {
    canonicalDocument = createSourceDocument({
      body: candidate.body,
      descriptor: candidate.descriptor,
      ingestedAt: candidate.ingestedAt,
      jsonOrigins: candidate.jsonOrigins,
      producer: candidate.producer,
      projectId: input.projectId,
      source: candidate.sourceUri,
      sourceKind: candidate.sourceKind,
      sourceRevision: candidate.sourceRevision,
      sourceType: 'file',
      title: candidate.title,
    });
  } catch {
    return fail('A collected JSON source document is invalid.');
  }
  const result = Object.freeze({
    ...candidate,
    canonicalDocument: Object.freeze({
      ...canonicalDocument,
      buildlore: Object.freeze({ ...canonicalDocument.buildlore }),
    }),
    jsonOrigins: canonicalDocument.buildlore.jsonOrigins ?? candidate.jsonOrigins,
  });
  return bindRawSourceInputs(result, [decoded]);
}

export function createJsonProjectionSourceAdapter(
  definition: SourceAdapterDefinitionV1,
): SourceAdapterV1 {
  if (definition.registration.adapterId !== JSON_SOURCE_ADAPTER_ID) {
    return fail('JSON source adapter registration is invalid.');
  }
  return Object.freeze({
    async project(input: SourceAdapterProjectionInputV1): Promise<SourceCollectionAdapterResult> {
      if (input.selectedFiles.length > 0 && input.ingestedAt === undefined) {
        return fail('JSON source timestamp is unavailable.');
      }
      const candidates: JsonCollectionCandidate[] = [];
      for (const selectedFile of input.selectedFiles) {
        candidates.push(await projectSelectedJsonSource({
          checkout: input.checkout,
          ingestedAt: input.ingestedAt as string,
          projectId: input.inventory.projectId,
          repository: input.loadedManifest.manifest.sourceRepository,
          selectedFile,
        }));
      }
      return bindRawSourceInputs(Object.freeze({
        candidates: Object.freeze(candidates),
        entries: Object.freeze([]),
        notices: Object.freeze([]),
      }), candidates.flatMap((candidate) => inspectRawSourceInputs(candidate)));
    },
    mapRange: definition.mapRange,
    registration: definition.registration,
  });
}
