import { join, posix } from 'node:path';

import type { Sha256Digest, SourceCheckoutHandle } from '../knowledge/local-project-registry.js';
import { ProjectionError } from './errors.js';
import { projectSelectedMarkdown } from './markdown-projector.js';
import {
  createP2aArtifactAdapter,
  type P2aArtifactAdapter,
} from './p2a-artifacts.js';
import type {
  P2aCompatibilityWarning,
  PlanningDocumentKind,
  ProjectionPlanEntry,
} from './planning-types.js';
import {
  projectSourceProducer,
  type ProjectSourceInput,
  type ProjectSourceProducer,
} from './project-source-writer.js';
import {
  readSelectedSourceBytes,
  type LoadedSourceCollectionManifest,
  type SelectedSourceFile,
  type SourceDeclaration,
  type SourceDocumentKind,
  type SourceSelectionInventory,
} from './source-manifest.js';
import { createSourceDocument } from './source-document.js';
import { validateP2aSourceIdentity } from './source-identity.js';
import type { SourceDocument } from './types.js';

export interface CollectionCandidate extends ProjectSourceInput {
  readonly canonicalDocument: SourceDocument;
  readonly contentDigest: Sha256Digest;
  readonly declarationId: string;
  readonly documentKind: SourceDocumentKind;
  readonly planningDocumentKind?: PlanningDocumentKind;
  readonly producer: ProjectSourceProducer;
  readonly projectId: string;
  readonly sourceRef: string;
}

export interface SourceCollectionAdapterInput {
  readonly checkout: SourceCheckoutHandle;
  readonly inventory: SourceSelectionInventory;
  readonly loadedManifest: LoadedSourceCollectionManifest;
  readonly markdownIngestedAt?: string;
  readonly planningExplicitTimestamp?: string;
}

export interface SourceCollectionAdapterResult {
  readonly candidates: readonly CollectionCandidate[];
  readonly compatibilityWarnings: readonly P2aCompatibilityWarning[];
  readonly planningEntries: readonly ProjectionPlanEntry[];
}

export interface SourceCollectionAdapter {
  collect(input: SourceCollectionAdapterInput): Promise<SourceCollectionAdapterResult>;
}

export interface CreateSourceCollectionAdapterOptions {
  readonly p2aArtifactAdapter?: P2aArtifactAdapter;
}

function fail(
  code: ConstructorParameters<typeof ProjectionError>[0],
  message: string,
): never {
  throw new ProjectionError(code, message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function belongsToDeclaration(file: SelectedSourceFile, declaration: SourceDeclaration): boolean {
  if (
    file.declarationId !== declaration.id ||
    file.documentKind !== declaration.documentKind
  ) return false;
  return declaration.pathType === 'file'
    ? file.sourceRef === declaration.path
    : file.sourceRef.startsWith(`${declaration.path}/`);
}

function selectedFilesByIdentity(
  input: SourceCollectionAdapterInput,
): ReadonlyMap<string, SelectedSourceFile> {
  const { checkout, inventory, loadedManifest } = input;
  if (
    inventory.projectId !== checkout.projectId ||
    inventory.projectId !== loadedManifest.manifest.projectId ||
    inventory.manifestDigest !== loadedManifest.manifestDigest
  ) {
    return fail('PROJECTION_PROJECT_MISMATCH', 'Source collection bindings do not match.');
  }
  const declarations = new Map(
    loadedManifest.manifest.sources.map((declaration) => [declaration.id, declaration] as const),
  );
  const selected = new Map<string, SelectedSourceFile>();
  for (const file of inventory.files) {
    const declaration = declarations.get(file.declarationId);
    if (declaration === undefined || !belongsToDeclaration(file, declaration)) {
      return fail('PROJECTION_ARTIFACT_INVALID', 'Selected source binding is invalid.');
    }
    if (selected.has(file.sourceRef)) {
      return fail('PROJECTION_SOURCE_COLLISION', 'A selected source identity is duplicated.');
    }
    selected.set(file.sourceRef, file);
  }
  return selected;
}

function canonicalCandidate(
  input: ProjectSourceInput & {
    readonly contentDigest: Sha256Digest;
    readonly declarationId: string;
    readonly documentKind: SourceDocumentKind;
    readonly planningDocumentKind?: PlanningDocumentKind;
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
    canonicalDocument: Object.freeze({
      ...canonicalDocument,
      buildlore: Object.freeze({ ...canonicalDocument.buildlore }),
    }),
  });
}

function planningRoots(files: readonly SelectedSourceFile[]): ReadonlyMap<string, SelectedSourceFile[]> {
  const roots = files
    .filter((file) => posix.basename(file.sourceRef) === 'current-spec.json')
    .map((file) => posix.dirname(file.sourceRef))
    .sort(compareText);
  if (roots.length < 1 || new Set(roots).size !== roots.length) {
    return fail('PROJECTION_ARTIFACT_INVALID', 'Selected P2A planning roots are invalid.');
  }
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

export function createSourceCollectionAdapter(
  options: CreateSourceCollectionAdapterOptions = {},
): SourceCollectionAdapter {
  const p2aAdapter = options.p2aArtifactAdapter ?? createP2aArtifactAdapter();
  return {
    async collect(input): Promise<SourceCollectionAdapterResult> {
      const selected = selectedFilesByIdentity(input);
      const candidates: CollectionCandidate[] = [];
      const compatibilityWarnings: P2aCompatibilityWarning[] = [];
      const planningEntries: ProjectionPlanEntry[] = [];
      const markdownFiles = [...selected.values()]
        .filter((file) => file.documentKind === 'markdown')
        .sort((left, right) => compareText(left.sourceRef, right.sourceRef));
      if (markdownFiles.length > 0 && input.markdownIngestedAt === undefined) {
        return fail('PROJECTION_TIMESTAMP_UNAVAILABLE', 'Markdown source timestamp is unavailable.');
      }
      for (const file of markdownFiles) {
        candidates.push(await projectSelectedMarkdown({
          checkout: input.checkout,
          ingestedAt: input.markdownIngestedAt as string,
          projectId: input.inventory.projectId,
          repository: input.loadedManifest.manifest.sourceRepository,
          selectedFile: file,
        }));
      }

      const p2aFiles = [...selected.values()]
        .filter((file) => file.documentKind === 'p2a-planning')
        .sort((left, right) => compareText(left.sourceRef, right.sourceRef));
      if (p2aFiles.length > 0) {
        for (const file of p2aFiles) await readSelectedSourceBytes(input.checkout, file);
        const rootPath = input.checkout.resolveRootForInternalUse();
        for (const [rootRef, files] of planningRoots(p2aFiles)) {
          const selection = await p2aAdapter.read({
            artifactRoot: rootRef === '.'
              ? rootPath
              : join(rootPath, ...rootRef.split('/')),
            ...(input.planningExplicitTimestamp === undefined
              ? {}
              : { explicitTimestamp: input.planningExplicitTimestamp }),
            projectId: input.inventory.projectId,
          }, input.loadedManifest.manifest.sourceRepository, {
            selectedFiles: files.map((file) => relativeToPlanningRoot(rootRef, file.sourceRef)),
          });
          compatibilityWarnings.push(...selection.compatibilityWarnings);
          planningEntries.push(...selection.entries);
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
              contentDigest: file.contentDigest,
              declarationId: file.declarationId,
              documentKind: 'p2a-planning',
              planningDocumentKind: candidate.documentKind,
              producer: 'p2a',
              projectId: input.inventory.projectId,
              sourceRef,
            }, input.inventory.projectId));
          }
        }
      }

      candidates.sort((left, right) => compareText(
        `${left.declarationId}:${left.sourceRef}:${left.sourceUri}`,
        `${right.declarationId}:${right.sourceRef}:${right.sourceUri}`,
      ));
      const targets = new Set<string>();
      for (const candidate of candidates) {
        if (targets.has(candidate.target)) {
          return fail('PROJECTION_SOURCE_COLLISION', 'A collection target identity is duplicated.');
        }
        targets.add(candidate.target);
      }
      return Object.freeze({
        candidates: Object.freeze(candidates),
        compatibilityWarnings: Object.freeze([...compatibilityWarnings].sort((left, right) =>
          compareText(
            `${left.sourceArtifact}:${left.code}:${left.fieldName ?? ''}`,
            `${right.sourceArtifact}:${right.code}:${right.fieldName ?? ''}`,
          ))),
        planningEntries: Object.freeze([...planningEntries].sort((left, right) =>
          compareText(left.sourceArtifact, right.sourceArtifact))),
      });
    },
  };
}
