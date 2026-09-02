import { join, posix } from 'node:path';

import type { Sha256Digest } from '../knowledge/local-project-registry.js';
import type {
  CollectionCandidate,
  SourceAdapterProjectionInputV1,
  SourceAdapterV1,
  SourceCollectionAdapterResult,
} from './collection-adapters.js';
import { ProjectionError } from './errors.js';
import type { P2aArtifactAdapter } from './p2a-artifacts.js';
import {
  projectSourceProducer,
  type ProjectSourceInput,
  type ProjectSourceProducer,
} from './project-source-writer.js';
import {
  P2A_SOURCE_ADAPTER_ID,
  type SourceAdapterDefinitionV1,
} from './source-adapter-registry.js';
import { readSelectedSourceBytes, type SelectedSourceFile } from './source-manifest.js';
import { createSourceDocument } from './source-document.js';
import { validateP2aSourceIdentity } from './source-identity.js';
import type { SourceDocument } from './types.js';

function fail(
  code: ConstructorParameters<typeof ProjectionError>[0],
  message: string,
): never {
  throw new ProjectionError(code, message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function p2aArtifactRootRefs(files: readonly SelectedSourceFile[]): readonly string[] {
  const roots = files
    .filter((file) => posix.basename(file.sourceRef) === 'current-spec.json')
    .map((file) => posix.dirname(file.sourceRef))
    .sort(compareText);
  if (roots.length < 1 || new Set(roots).size !== roots.length) {
    return fail('PROJECTION_ARTIFACT_INVALID', 'Selected P2A planning roots are invalid.');
  }
  return Object.freeze(roots);
}

function planningRoots(files: readonly SelectedSourceFile[]): ReadonlyMap<string, SelectedSourceFile[]> {
  const roots = p2aArtifactRootRefs(files);
  const grouped = new Map<string, SelectedSourceFile[]>();
  for (const root of roots) grouped.set(root, []);
  for (const file of files) {
    const matches = roots.filter((root) =>
      root === '.' || file.sourceRef.startsWith(`${root}/`));
    if (matches.length !== 1) {
      return fail('PROJECTION_ARTIFACT_INVALID', 'Selected P2A planning binding is ambiguous.');
    }
    grouped.get(matches[0] as string)?.push(file);
  }
  return grouped;
}

function relativeToPlanningRoot(root: string, sourceRef: string): string {
  return root === '.' ? sourceRef : sourceRef.slice(root.length + 1);
}

function canonicalCandidate(
  input: ProjectSourceInput & {
    readonly adapterDocumentKind: string;
    readonly contentDigest: Sha256Digest;
    readonly declarationId: string;
    readonly producer: ProjectSourceProducer;
    readonly projectId: string;
    readonly sourceRef: string;
  },
  projectId: string,
): CollectionCandidate {
  projectSourceProducer(input);
  let canonicalDocument: SourceDocument;
  try {
    canonicalDocument = createSourceDocument({
      body: input.body,
      ingestedAt: input.ingestedAt,
      producer: input.producer,
      projectId,
      source: input.sourceUri,
      sourceKind: input.sourceKind,
      sourceRevision: input.sourceRevision,
      sourceType: 'file',
      title: input.title,
    });
  } catch {
    return fail('PROJECTION_ARTIFACT_INVALID', 'A collected source document is invalid.');
  }
  return Object.freeze({
    ...input,
    adapterDocumentKind: input.adapterDocumentKind,
    adapterId: P2A_SOURCE_ADAPTER_ID,
    adapterVersion: 1,
    canonicalDocument: Object.freeze({
      ...canonicalDocument,
      buildlore: Object.freeze({ ...canonicalDocument.buildlore }),
    }),
    documentKind: 'p2a-planning',
  });
}

export function createP2aProjectionSourceAdapter(
  definition: SourceAdapterDefinitionV1,
  artifactAdapter: P2aArtifactAdapter,
): SourceAdapterV1 {
  if (definition.registration.adapterId !== P2A_SOURCE_ADAPTER_ID) {
    return fail('PROJECTION_ARTIFACT_INVALID', 'P2A source adapter registration is invalid.');
  }
  return Object.freeze({
    async project(input: SourceAdapterProjectionInputV1): Promise<SourceCollectionAdapterResult> {
      if (input.selectedFiles.some((file) => file.documentKind !== 'p2a-planning')) {
        return fail('PROJECTION_ARTIFACT_INVALID', 'P2A source binding is invalid.');
      }
      for (const file of input.selectedFiles) await readSelectedSourceBytes(input.checkout, file);
      const candidates: CollectionCandidate[] = [];
      const entries: SourceCollectionAdapterResult['entries'][number][] = [];
      const notices: SourceCollectionAdapterResult['notices'][number][] = [];
      const rootPath = input.checkout.resolveRootForInternalUse();
      for (const [rootRef, files] of planningRoots(input.selectedFiles)) {
        const selection = await artifactAdapter.read({
          artifactRoot: rootRef === '.'
            ? rootPath
            : join(rootPath, ...rootRef.split('/')),
          projectId: input.inventory.projectId,
        }, input.loadedManifest.manifest.sourceRepository, {
          selectedFiles: files.map((file) => relativeToPlanningRoot(rootRef, file.sourceRef)),
        });
        notices.push(...selection.compatibilityWarnings.map((warning) => Object.freeze({
          adapterId: P2A_SOURCE_ADAPTER_ID,
          code: warning.code,
          ...(warning.fieldName === undefined ? {} : { fieldName: warning.fieldName }),
          sourceRef: warning.sourceArtifact,
        })));
        entries.push(...selection.entries.map((entry) => Object.freeze({
          adapterId: P2A_SOURCE_ADAPTER_ID,
          decision: entry.decision,
          reasonCode: entry.reasonCode,
          sourceRef: entry.sourceArtifact,
          ...(entry.sourceRevision === undefined ? {} : { sourceRevision: entry.sourceRevision }),
          ...(entry.target === undefined ? {} : { target: entry.target }),
          ...(entry.writeStatus === undefined ? {} : { writeStatus: entry.writeStatus }),
        })));
        const filesByRef = new Map(files.map((file) => [file.sourceRef, file] as const));
        for (const candidate of selection.candidates) {
          if (validateP2aSourceIdentity({
            artifactPath: candidate.sourceArtifact,
            documentKind: candidate.documentKind,
            projectId: input.inventory.projectId,
            repository: input.loadedManifest.manifest.sourceRepository,
            source: candidate.sourceUri,
            sourceKind: 'planning',
          }) === null) {
            return fail('PROJECTION_ARTIFACT_INVALID', 'A planning source identity is invalid.');
          }
          const sourceRef = rootRef === '.'
            ? candidate.sourceArtifact
            : `${rootRef}/${candidate.sourceArtifact}`;
          const file = filesByRef.get(sourceRef);
          if (file === undefined) {
            return fail('PROJECTION_ARTIFACT_INVALID', 'A planning candidate is not selected.');
          }
          candidates.push(canonicalCandidate({
            ...candidate,
            adapterDocumentKind: candidate.documentKind,
            contentDigest: file.contentDigest,
            declarationId: file.declarationId,
            producer: 'p2a',
            projectId: input.inventory.projectId,
            sourceRef,
          }, input.inventory.projectId));
        }
      }
      return Object.freeze({
        candidates: Object.freeze(candidates),
        entries: Object.freeze(entries),
        notices: Object.freeze(notices),
      });
    },
    mapRange: definition.mapRange,
    registration: definition.registration,
  });
}
