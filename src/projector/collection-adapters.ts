import type { Sha256Digest, SourceCheckoutHandle } from '../knowledge/local-project-registry.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { ProjectionError } from './errors.js';
import { createGenericProjectionSourceAdapter } from './generic-source-adapter.js';
import {
  createP2aArtifactAdapter,
  type P2aArtifactAdapter,
} from './p2a-artifacts.js';
import type { ProjectSourceInput, ProjectSourceProducer } from './project-source-writer.js';
import { createP2aProjectionSourceAdapter } from './p2a-source-adapter.js';
import {
  createBuiltInSourceAdapterRegistry,
  GENERIC_SOURCE_ADAPTER_ID,
  genericSourceAdapter,
  P2A_SOURCE_ADAPTER_ID,
  p2aSourceAdapter,
  type SourceAdapterRegistry,
} from './source-adapter-registry.js';
import {
  sourceRetrievalMeaningFromDescriptor,
  validateSourceRetrievalSupersessionGraph,
  type BoundSourceRetrievalMeaningV1,
  type RegisteredMediaType,
  type SourceAdapterRegistrationV1,
  type SourceOriginRangeV1,
  type SourceRangeMappingV1,
} from './source-contracts.js';
import {
  sourceDeclarationDocumentKind,
  sourceDeclarationMediaType,
  type AnySourceDeclaration,
  type LoadedSourceCollectionManifest,
  type SelectedSourceFile,
  type SourceDocumentKind,
  type SourceSelectionInventory,
} from './source-manifest.js';
import type { SourceDocument } from './types.js';

export interface CollectionCandidate extends ProjectSourceInput {
  readonly adapterDocumentKind?: string;
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly canonicalDocument: SourceDocument;
  readonly contentDigest: Sha256Digest;
  readonly declarationId: string;
  readonly documentKind: SourceDocumentKind;
  readonly mediaType?: RegisteredMediaType;
  readonly producer: ProjectSourceProducer;
  readonly projectId: string;
  readonly rangeMappings?: readonly SourceRangeMappingV1[];
  readonly retrievalMeaning?: BoundSourceRetrievalMeaningV1;
  readonly sourceRef: string;
}

export interface SourceCollectionAdapterInput {
  readonly checkout: SourceCheckoutHandle;
  readonly inventory: SourceSelectionInventory;
  readonly ingestedAt?: string;
  readonly loadedManifest: LoadedSourceCollectionManifest;
  readonly sourceAdapterRegistry?: SourceAdapterRegistry;
}

export interface SourceAdapterNoticeV1 {
  readonly adapterId: string;
  readonly code: string;
  readonly fieldName?: string;
  readonly sourceRef: string;
}

export interface SourceAdapterProjectionEntryV1 {
  readonly adapterId: string;
  readonly decision: 'blocked' | 'error' | 'exclude' | 'include' | 'quarantine';
  readonly reasonCode: string;
  readonly sourceRef: string;
  readonly sourceRevision?: Sha256Digest;
  readonly target?: string;
  readonly writeStatus?: 'create' | 'unchanged' | 'update';
}

export interface SourceCollectionAdapterResult {
  readonly candidates: readonly CollectionCandidate[];
  readonly entries: readonly SourceAdapterProjectionEntryV1[];
  readonly notices: readonly SourceAdapterNoticeV1[];
}

export interface SourceAdapterProjectionInputV1 {
  readonly checkout: SourceCheckoutHandle;
  readonly inventory: SourceSelectionInventory;
  readonly ingestedAt?: string;
  readonly loadedManifest: LoadedSourceCollectionManifest;
  readonly selectedFiles: readonly SelectedSourceFile[];
}

export interface SourceAdapterV1 {
  readonly mapRange: (
    mappings: readonly SourceRangeMappingV1[],
    canonicalRange: SourceOriginRangeV1,
  ) => SourceOriginRangeV1;
  readonly project: (
    input: SourceAdapterProjectionInputV1,
  ) => Promise<SourceCollectionAdapterResult>;
  readonly registration: SourceAdapterRegistrationV1;
}

export interface SourceCollectionAdapter {
  collect(input: SourceCollectionAdapterInput): Promise<SourceCollectionAdapterResult>;
}

export interface CreateSourceCollectionAdapterOptions {
  readonly includeP2a?: boolean;
  readonly p2aArtifactAdapter?: P2aArtifactAdapter;
  readonly sourceAdapterRegistry?: SourceAdapterRegistry;
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

function belongsToDeclaration(
  file: SelectedSourceFile,
  declaration: AnySourceDeclaration,
): boolean {
  const documentKind = sourceDeclarationDocumentKind(declaration);
  const expectedAdapterId = 'adapterId' in declaration
    ? declaration.adapterId
    : documentKind === 'p2a-planning' ? P2A_SOURCE_ADAPTER_ID : GENERIC_SOURCE_ADAPTER_ID;
  const expectedKind = 'kind' in declaration
    ? declaration.kind
    : documentKind === 'p2a-planning' ? 'planning' : documentKind;
  const expectedMetadata = 'metadata' in declaration ? declaration.metadata : undefined;
  if (
    file.declarationId !== declaration.id ||
    file.documentKind !== documentKind ||
    adapterIdFor(file) !== expectedAdapterId ||
    (file.adapterVersion ?? 1) !== ('adapterVersion' in declaration
      ? declaration.adapterVersion
      : 1) ||
    (file.kind ?? (documentKind === 'p2a-planning' ? 'planning' : documentKind)) !==
      expectedKind ||
    (file.mediaType !== undefined &&
      file.mediaType !== sourceDeclarationMediaType(declaration, file.sourceRef)) ||
    serializeCanonicalJson(file.metadata ?? null) !==
      serializeCanonicalJson(expectedMetadata ?? null)
  ) return false;
  if (declaration.pathType === 'file') return file.sourceRef === declaration.path;
  if (!file.sourceRef.startsWith(`${declaration.path}/`)) return false;
  return declaration.recursive === true ||
    !file.sourceRef.slice(declaration.path.length + 1).includes('/');
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

function adapterIdFor(file: SelectedSourceFile): string {
  return file.adapterId ?? (
    file.documentKind === 'p2a-planning' ? P2A_SOURCE_ADAPTER_ID : GENERIC_SOURCE_ADAPTER_ID
  );
}

function registeredRuntimeAdapters(
  options: CreateSourceCollectionAdapterOptions,
): ReadonlyMap<string, SourceAdapterV1> {
  const p2aArtifactAdapter = options.p2aArtifactAdapter ?? createP2aArtifactAdapter();
  const adapters = [
    createGenericProjectionSourceAdapter(genericSourceAdapter()),
    ...(options.includeP2a === false
      ? []
      : [createP2aProjectionSourceAdapter(p2aSourceAdapter(), p2aArtifactAdapter)]),
  ];
  const result = new Map<string, SourceAdapterV1>();
  for (const adapter of adapters) {
    const adapterId = adapter.registration.adapterId;
    if (result.has(adapterId)) {
      return fail('PROJECTION_ARTIFACT_INVALID', 'Source projection adapter is duplicated.');
    }
    result.set(adapterId, adapter);
  }
  return result;
}

export function createSourceCollectionAdapter(
  options: CreateSourceCollectionAdapterOptions = {},
): SourceCollectionAdapter {
  const runtimeAdapters = registeredRuntimeAdapters(options);
  return {
    async collect(input): Promise<SourceCollectionAdapterResult> {
      const selected = selectedFilesByIdentity(input);
      const registry = input.sourceAdapterRegistry ?? options.sourceAdapterRegistry ??
        createBuiltInSourceAdapterRegistry({
        includeP2a: options.includeP2a ?? input.loadedManifest.manifest.sources.some((source) =>
          ('adapterId' in source && source.adapterId === P2A_SOURCE_ADAPTER_ID) ||
          ('documentKind' in source && source.documentKind === 'p2a-planning')),
        });
      const candidates: CollectionCandidate[] = [];
      const entries: SourceAdapterProjectionEntryV1[] = [];
      const notices: SourceAdapterNoticeV1[] = [];
      const filesByAdapter = new Map<string, SelectedSourceFile[]>();
      for (const file of selected.values()) {
        const adapterId = adapterIdFor(file);
        const resolution = registry.resolve({
          adapterId,
          adapterVersion: file.adapterVersion ?? 1,
          kind: file.kind ?? (
            file.documentKind === 'p2a-planning' ? 'planning' : file.documentKind
          ),
          ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
          ...(file.metadata === undefined ? {} : { metadata: file.metadata }),
        });
        const runtime = runtimeAdapters.get(adapterId);
        if (runtime === undefined || serializeCanonicalJson(runtime.registration) !==
            serializeCanonicalJson(resolution.adapter.registration)) {
          return fail('PROJECTION_ARTIFACT_INVALID', 'Source projection adapter is unavailable.');
        }
        const grouped = filesByAdapter.get(adapterId) ?? [];
        grouped.push(file);
        filesByAdapter.set(adapterId, grouped);
      }
      for (const adapterId of [...filesByAdapter.keys()].sort(compareText)) {
        const runtime = runtimeAdapters.get(adapterId);
        const files = filesByAdapter.get(adapterId);
        if (runtime === undefined || files === undefined) {
          return fail('PROJECTION_ARTIFACT_INVALID', 'Source projection adapter is unavailable.');
        }
        const projected = await runtime.project({
          checkout: input.checkout,
          inventory: input.inventory,
          ...(input.ingestedAt === undefined ? {} : { ingestedAt: input.ingestedAt }),
          loadedManifest: input.loadedManifest,
          selectedFiles: Object.freeze([...files].sort((left, right) =>
            compareText(left.sourceRef, right.sourceRef))),
        });
        const selectedBindings = new Set(files.map((file) =>
          `${file.declarationId}\u0000${file.sourceRef}`));
        if (projected.candidates.some((candidate) =>
          candidate.adapterId !== runtime.registration.adapterId ||
          candidate.adapterVersion !== runtime.registration.adapterVersion ||
          candidate.projectId !== input.inventory.projectId ||
          !selectedBindings.has(`${candidate.declarationId}\u0000${candidate.sourceRef}`))) {
          return fail('PROJECTION_ARTIFACT_INVALID', 'Projected source binding is invalid.');
        }
        candidates.push(...projected.candidates);
        if (projected.entries.some((entry) => entry.adapterId !== adapterId) ||
            projected.notices.some((notice) => notice.adapterId !== adapterId)) {
          return fail('PROJECTION_ARTIFACT_INVALID', 'Projected adapter output is invalid.');
        }
        entries.push(...projected.entries);
        notices.push(...projected.notices);
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
      validateSourceRetrievalSupersessionGraph(candidates.map((candidate) => Object.freeze({
        retrievalMeaning: (candidate.retrievalMeaning ??
          sourceRetrievalMeaningFromDescriptor(candidate.descriptor)).meaning,
        sourceRef: candidate.sourceRef,
      })));
      return Object.freeze({
        candidates: Object.freeze(candidates),
        entries: Object.freeze([...entries].sort((left, right) =>
          compareText(
            `${left.adapterId}:${left.sourceRef}:${left.decision}:${left.reasonCode}`,
            `${right.adapterId}:${right.sourceRef}:${right.decision}:${right.reasonCode}`,
          ))),
        notices: Object.freeze([...notices].sort((left, right) =>
          compareText(
            `${left.adapterId}:${left.sourceRef}:${left.code}:${left.fieldName ?? ''}`,
            `${right.adapterId}:${right.sourceRef}:${right.code}:${right.fieldName ?? ''}`,
          ))),
      });
    },
  };
}
