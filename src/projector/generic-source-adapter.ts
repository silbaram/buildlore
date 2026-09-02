import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import type { Sha256Digest, SourceCheckoutHandle } from '../knowledge/local-project-registry.js';
import { decodeUtf8Strict } from '../knowledge/strict-json.js';
import { ProjectionError } from './errors.js';
import {
  GENERIC_SOURCE_ADAPTER_ID,
  mediaTypeForGenericKind,
} from './source-adapter-registry.js';
import type {
  GenericSourceKind,
  SourceDescriptorV1,
  SourceRangeMappingV1,
} from './source-contracts.js';
import { parseSourceDescriptor, SOURCE_DESCRIPTOR_SCHEMA_VERSION } from './source-contracts.js';
import {
  projectSourceProducer,
  type ProjectSourceInput,
} from './project-source-writer.js';
import {
  readSelectedSourceBytes,
  type SelectedSourceFile,
} from './source-manifest.js';
import { createSourceDocument, normalizeSourceBody } from './source-document.js';
import { unicodeScalarLength } from './text-units.js';
import { createCollectionSourceIdentity } from './source-identity.js';
import type { SourceDocument } from './types.js';
import type {
  SourceAdapterProjectionInputV1,
  SourceAdapterV1,
  SourceCollectionAdapterResult,
} from './collection-adapters.js';
import type { SourceAdapterDefinitionV1 } from './source-adapter-registry.js';

export interface GenericSourceProjectionInput {
  readonly checkout: SourceCheckoutHandle;
  readonly ingestedAt: string;
  readonly kind: GenericSourceKind;
  readonly projectId: string;
  readonly repository: string;
  readonly selectedFile: SelectedSourceFile;
}

export interface GenericCollectionCandidate extends ProjectSourceInput {
  readonly adapterId: typeof GENERIC_SOURCE_ADAPTER_ID;
  readonly adapterVersion: 1;
  readonly canonicalDocument: SourceDocument;
  readonly contentDigest: Sha256Digest;
  readonly declarationId: string;
  readonly descriptor: SourceDescriptorV1;
  readonly documentKind: GenericSourceKind;
  readonly mediaType: ReturnType<typeof mediaTypeForGenericKind>;
  readonly producer: 'buildlore';
  readonly projectId: string;
  readonly rangeMappings: readonly SourceRangeMappingV1[];
  readonly sourceKind: GenericSourceKind;
  readonly sourceRef: string;
}

const CODE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.c': 'c',
  '.cc': 'cpp',
  '.cjs': 'javascript',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.cxx': 'cpp',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.htm': 'html',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.mjs': 'javascript',
  '.php': 'php',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.scss': 'scss',
  '.sh': 'shell',
  '.sql': 'sql',
  '.svelte': 'svelte',
  '.swift': 'swift',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.xml': 'xml',
});

function fail(message: string): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', message);
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function hasUnsafeTitleCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function fallbackTitle(sourceRef: string, kind: GenericSourceKind): string {
  const filename = basename(sourceRef, extname(sourceRef));
  const readable = filename.replace(/[-_]+/gu, ' ').trim();
  const fallback = readable.length === 0 ? `${kind} document` : readable;
  return Array.from(fallback).slice(0, 250).join('');
}

function titleFor(sourceRef: string, body: string, kind: GenericSourceKind): string {
  if (kind === 'markdown') {
    for (const line of body.split('\n')) {
      const match = /^#(?:[ \t]+)(.*?)(?:[ \t]+#+)?[ \t]*$/u.exec(line);
      const candidate = match?.[1]?.trim();
      if (
        candidate !== undefined &&
        unicodeScalarLength(candidate) > 0 &&
        unicodeScalarLength(candidate) <= 500 &&
        !hasUnsafeTitleCharacter(candidate)
      ) return candidate;
    }
  }
  return fallbackTitle(sourceRef, kind);
}

function maximumBacktickRun(value: string): number {
  let maximum = 0;
  for (const match of value.matchAll(/`+/gu)) maximum = Math.max(maximum, match[0].length);
  return maximum;
}

function canonicalBody(
  sourceRef: string,
  original: string,
  kind: GenericSourceKind,
): Readonly<{ body: string; mappings: readonly SourceRangeMappingV1[] }> {
  const lines = original.split('\n');
  const finalLine = lines.length;
  const finalColumn = unicodeScalarLength(lines.at(-1) ?? '') + 1;
  if (kind !== 'code') {
    return Object.freeze({
      body: original,
      mappings: Object.freeze([Object.freeze({
        canonical: Object.freeze({
          endColumn: finalColumn,
          endLine: finalLine,
          startColumn: 1,
          startLine: 1,
        }),
        origin: Object.freeze({
          endColumn: finalColumn,
          endLine: finalLine,
          startColumn: 1,
          startLine: 1,
        }),
      })]),
    });
  }
  const fence = '`'.repeat(Math.max(3, maximumBacktickRun(original) + 1));
  const language = CODE_LANGUAGE_BY_EXTENSION[extname(sourceRef).toLowerCase()] ?? 'text';
  return Object.freeze({
    body: `${fence}${language}\n${original}\n${fence}`,
    mappings: Object.freeze([Object.freeze({
      canonical: Object.freeze({
        endColumn: finalColumn,
        endLine: finalLine + 1,
        startColumn: 1,
        startLine: 2,
      }),
      origin: Object.freeze({
        endColumn: finalColumn,
        endLine: finalLine,
        startColumn: 1,
        startLine: 1,
      }),
    })]),
  });
}

export async function projectSelectedGenericSource(
  input: GenericSourceProjectionInput,
): Promise<GenericCollectionCandidate> {
  if (input.selectedFile.documentKind !== input.kind) {
    return fail('Selected source kind is invalid.');
  }
  const bytes = await readSelectedSourceBytes(input.checkout, input.selectedFile);
  let original: string;
  try {
    original = normalizeSourceBody(decodeUtf8Strict(bytes));
  } catch {
    return fail('A selected generic source is invalid.');
  }
  const projected = canonicalBody(input.selectedFile.sourceRef, original, input.kind);
  const sourceUri = createCollectionSourceIdentity({
    declarationId: input.selectedFile.declarationId,
    documentKind: input.kind,
    projectId: input.projectId,
    repository: input.repository,
    sourceRef: input.selectedFile.sourceRef,
  });
  const descriptor = parseSourceDescriptor({
    adapterId: GENERIC_SOURCE_ADAPTER_ID,
    adapterVersion: 1,
    contentHash: input.selectedFile.contentDigest,
    declarationId: input.selectedFile.declarationId,
    kind: input.kind,
    mediaType: mediaTypeForGenericKind(input.kind),
    ...(input.selectedFile.metadata === undefined
      ? {}
      : { metadata: input.selectedFile.metadata }),
    projectId: input.projectId,
    schemaVersion: SOURCE_DESCRIPTOR_SCHEMA_VERSION,
    sourceRef: input.selectedFile.sourceRef,
    sourceRevision: input.selectedFile.contentDigest,
    sourceUri,
  });
  const candidate = {
    adapterId: GENERIC_SOURCE_ADAPTER_ID,
    adapterVersion: 1 as const,
    body: projected.body,
    contentDigest: input.selectedFile.contentDigest,
    declarationId: input.selectedFile.declarationId,
    descriptor,
    documentKind: input.kind,
    ingestedAt: input.ingestedAt,
    mediaType: mediaTypeForGenericKind(input.kind),
    producer: 'buildlore' as const,
    projectId: input.projectId,
    originMappings: projected.mappings,
    rangeMappings: projected.mappings,
    sourceKind: input.kind,
    sourceRef: input.selectedFile.sourceRef,
    sourceRevision: input.selectedFile.contentDigest,
    sourceUri,
    target: `${input.kind}--${sha256(sourceUri).slice('sha256:'.length)}.md`,
    title: titleFor(input.selectedFile.sourceRef, original, input.kind),
  };
  projectSourceProducer(candidate);
  let canonicalDocument: SourceDocument;
  try {
    canonicalDocument = createSourceDocument({
      body: candidate.body,
      descriptor: candidate.descriptor,
      ingestedAt: candidate.ingestedAt,
      originMappings: candidate.originMappings,
      producer: candidate.producer,
      projectId: input.projectId,
      source: candidate.sourceUri,
      sourceKind: candidate.sourceKind,
      sourceRevision: candidate.sourceRevision,
      sourceType: 'file',
      title: candidate.title,
    });
  } catch {
    return fail('A collected generic source document is invalid.');
  }
  return Object.freeze({
    ...candidate,
    canonicalDocument: Object.freeze({
      ...canonicalDocument,
      buildlore: Object.freeze({ ...canonicalDocument.buildlore }),
    }),
    originMappings: canonicalDocument.buildlore.originMappings ?? candidate.originMappings,
    rangeMappings: canonicalDocument.buildlore.originMappings ?? candidate.rangeMappings,
  });
}

export function createGenericProjectionSourceAdapter(
  definition: SourceAdapterDefinitionV1,
): SourceAdapterV1 {
  if (definition.registration.adapterId !== GENERIC_SOURCE_ADAPTER_ID) {
    return fail('Generic source adapter registration is invalid.');
  }
  return Object.freeze({
    async project(input: SourceAdapterProjectionInputV1): Promise<SourceCollectionAdapterResult> {
      if (input.selectedFiles.length > 0 && input.ingestedAt === undefined) {
        return fail('Generic source timestamp is unavailable.');
      }
      const candidates: GenericCollectionCandidate[] = [];
      for (const file of input.selectedFiles) {
        if (file.documentKind === 'p2a-planning') {
          return fail('Generic source binding is invalid.');
        }
        candidates.push(await projectSelectedGenericSource({
          checkout: input.checkout,
          ingestedAt: input.ingestedAt as string,
          kind: file.documentKind,
          projectId: input.inventory.projectId,
          repository: input.loadedManifest.manifest.sourceRepository,
          selectedFile: file,
        }));
      }
      return Object.freeze({
        candidates: Object.freeze(candidates),
        entries: Object.freeze([]),
        notices: Object.freeze([]),
      });
    },
    mapRange: definition.mapRange,
    registration: definition.registration,
  });
}
