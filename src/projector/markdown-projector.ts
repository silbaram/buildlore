import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import type { Sha256Digest, SourceCheckoutHandle } from '../knowledge/local-project-registry.js';
import { decodeUtf8Strict } from '../knowledge/strict-json.js';
import { ProjectionError } from './errors.js';
import {
  projectSourceProducer,
  type ProjectSourceInput,
} from './project-source-writer.js';
import {
  readSelectedSourceBytes,
  type SelectedSourceFile,
} from './source-manifest.js';
import { createSourceDocument, normalizeSourceBody } from './source-document.js';
import { createCollectionSourceIdentity } from './source-identity.js';
import type { SourceDocument } from './types.js';

export interface MarkdownProjectionInput {
  readonly checkout: SourceCheckoutHandle;
  readonly ingestedAt: string;
  readonly projectId: string;
  readonly repository: string;
  readonly selectedFile: SelectedSourceFile;
}

export interface MarkdownCollectionCandidate extends ProjectSourceInput {
  readonly canonicalDocument: SourceDocument;
  readonly contentDigest: Sha256Digest;
  readonly declarationId: string;
  readonly documentKind: 'markdown';
  readonly producer: 'buildlore';
  readonly projectId: string;
  readonly sourceKind: 'markdown';
  readonly sourceRef: string;
}

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

function titleFromMarkdown(sourceRef: string, body: string): string {
  for (const line of body.split('\n')) {
    const match = /^#(?:[ \t]+)(.*?)(?:[ \t]+#+)?[ \t]*$/u.exec(line);
    const candidate = match?.[1]?.trim();
    if (
      candidate !== undefined &&
      candidate.length > 0 &&
      candidate.length <= 500 &&
      !hasUnsafeTitleCharacter(candidate)
    ) return candidate;
  }
  const filename = basename(sourceRef, extname(sourceRef));
  const readable = filename.replace(/[-_]+/gu, ' ').trim();
  const fallback = readable.length === 0 ? 'Markdown document' : readable;
  return Array.from(fallback).slice(0, 250).join('');
}

export async function projectSelectedMarkdown(
  input: MarkdownProjectionInput,
): Promise<MarkdownCollectionCandidate> {
  if (input.selectedFile.documentKind !== 'markdown') {
    return fail('Selected source is not Markdown.');
  }
  const bytes = await readSelectedSourceBytes(input.checkout, input.selectedFile);
  let body: string;
  try {
    body = normalizeSourceBody(decodeUtf8Strict(bytes));
  } catch {
    return fail('A selected Markdown source is invalid.');
  }
  const sourceUri = createCollectionSourceIdentity({
    declarationId: input.selectedFile.declarationId,
    documentKind: 'markdown',
    projectId: input.projectId,
    repository: input.repository,
    sourceRef: input.selectedFile.sourceRef,
  });
  const candidate = {
    body,
    contentDigest: input.selectedFile.contentDigest,
    declarationId: input.selectedFile.declarationId,
    documentKind: 'markdown' as const,
    ingestedAt: input.ingestedAt,
    producer: 'buildlore' as const,
    projectId: input.projectId,
    sourceKind: 'markdown' as const,
    sourceRef: input.selectedFile.sourceRef,
    sourceRevision: input.selectedFile.contentDigest,
    sourceUri,
    target: `markdown--${sha256(sourceUri).slice('sha256:'.length)}.md`,
    title: titleFromMarkdown(input.selectedFile.sourceRef, body),
  };
  projectSourceProducer(candidate);
  let canonicalDocument: SourceDocument;
  try {
    canonicalDocument = createSourceDocument({
      body: candidate.body,
      ingestedAt: candidate.ingestedAt,
      producer: candidate.producer,
      projectId: input.projectId,
      source: candidate.sourceUri,
      sourceKind: candidate.sourceKind,
      sourceRevision: candidate.sourceRevision,
      sourceType: 'file',
      title: candidate.title,
    });
  } catch {
    return fail('A collected Markdown document is invalid.');
  }
  return Object.freeze({
    ...candidate,
    canonicalDocument: Object.freeze({
      ...canonicalDocument,
      buildlore: Object.freeze({ ...canonicalDocument.buildlore }),
    }),
  });
}
