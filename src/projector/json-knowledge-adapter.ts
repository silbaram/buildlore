import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import {
  decodeUtf8Strict,
  parseJsonStrict,
  parseJsonWithLocationsStrict,
  type StrictJsonLocation,
} from '../knowledge/strict-json.js';
import type { Sha256Digest } from '../knowledge/local-project-registry.js';
import type {
  CollectionCandidate,
  SourceAdapterProjectionInputV1,
  SourceAdapterV1,
  SourceCollectionAdapterResult,
} from './collection-adapters.js';
import { ProjectionError } from './errors.js';
import {
  parseSourceAdapterRegistration,
  parseSourceDescriptor,
  parseSourceMetadata,
  parseSourceRetrievalMeaning,
  SOURCE_DESCRIPTOR_V2_SCHEMA_VERSION,
  validateJsonPointer,
  validatePortableSourceRef,
  validateSourceOriginRange,
  type SourceAdapterRegistrationV1,
  type SourceJsonOriginMappingV1,
  type SourceMetadataV1,
  type SourceRetrievalMeaningV1,
} from './source-contracts.js';
import type { SourceAdapterDefinitionV1 } from './source-adapter-registry.js';
import { createCollectionSourceIdentity } from './source-identity.js';
import { readSelectedSourceBytes, type SelectedSourceFile } from './source-manifest.js';
import { projectSourceProducer } from './project-source-writer.js';
import { bindRawSourceInputs, type RawSourceInputV1 } from './raw-source-inputs.js';
import { createSourceDocument } from './source-document.js';
import { unicodeScalarLength } from './text-units.js';
import { MAX_SOURCE_BODY_CHARS, MAX_SOURCE_ORIGIN_MAPPINGS } from './types.js';

export const JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION =
  'buildlore.json-knowledge-adapter.v1' as const;
export const MAX_JSON_ADAPTER_CANDIDATES = 128;

export interface JsonKnowledgeAdapterEntryV1 {
  readonly contentHash: Sha256Digest;
  readonly declarationId: string;
  readonly locations: readonly StrictJsonLocation[];
  readonly sourceRef: string;
  readonly value: unknown;
}

export interface JsonKnowledgeAdapterInputV1 {
  readonly config: unknown;
  readonly configDigest: Sha256Digest;
  readonly entries: readonly JsonKnowledgeAdapterEntryV1[];
  readonly projectId: string;
}

export interface JsonKnowledgeAdapterOriginDraftV1 {
  readonly canonical: Readonly<{
    readonly endColumn: number;
    readonly endLine: number;
    readonly startColumn: number;
    readonly startLine: number;
  }>;
  readonly jsonPointer: string;
  readonly sourceRef: string;
}

export interface JsonKnowledgeAdapterCandidateDraftV1 {
  readonly body: string;
  readonly inputSourceRefs: readonly string[];
  readonly logicalId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly origins: readonly JsonKnowledgeAdapterOriginDraftV1[];
  readonly retrievalMeaning?: SourceRetrievalMeaningV1;
  readonly title: string;
}

export interface JsonKnowledgeAdapterEntryDecisionV1 {
  readonly decision: 'exclude' | 'quarantine';
  readonly reasonCode: string;
  readonly sourceRef: string;
}

export interface JsonKnowledgeAdapterProjectionV1 {
  readonly candidates: readonly JsonKnowledgeAdapterCandidateDraftV1[];
  readonly entries: readonly JsonKnowledgeAdapterEntryDecisionV1[];
}

export interface JsonKnowledgeAdapterV1 {
  readonly contractVersion: typeof JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION;
  readonly matches?: (entry: JsonKnowledgeAdapterEntryV1) => boolean;
  readonly unmatchedDecision?: 'exclude' | 'quarantine';
  readonly project: (
    input: JsonKnowledgeAdapterInputV1,
  ) => Promise<JsonKnowledgeAdapterProjectionV1 | readonly JsonKnowledgeAdapterCandidateDraftV1[]> |
    JsonKnowledgeAdapterProjectionV1 | readonly JsonKnowledgeAdapterCandidateDraftV1[];
  readonly registration: SourceAdapterRegistrationV1;
}

export interface RegisteredJsonKnowledgeAdapterV1 extends SourceAdapterDefinitionV1 {
  readonly registrationDigest: Sha256Digest;
  readonly runtime: SourceAdapterV1;
}

interface LoadedEntry extends JsonKnowledgeAdapterEntryV1 {
  readonly decoded: string;
  readonly file: SelectedSourceFile;
}

interface JsonKnowledgeReferenceAdapterOptions {
  readonly rawSecurityInput: (entry: JsonKnowledgeAdapterEntryV1) => RawSourceInputV1;
}

function rawInputForLoaded(
  entry: LoadedEntry,
  referenceOptions?: JsonKnowledgeReferenceAdapterOptions,
): string | RawSourceInputV1 {
  return referenceOptions?.rawSecurityInput(Object.freeze({
    contentHash: entry.contentHash,
    declarationId: entry.declarationId,
    locations: entry.locations,
    sourceRef: entry.sourceRef,
    value: entry.value,
  })) ?? entry.decoded;
}

function fail(message: string): never {
  throw new ProjectionError('PROJECTION_ARTIFACT_INVALID', message);
}

function sha256(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !allowed.has(key))) {
    fail('JSON knowledge adapter output is invalid.');
  }
}

function property(value: Readonly<Record<string, unknown>>, key: string): unknown {
  return value[key];
}

function immutableConfig(value: unknown): Readonly<{ digest: Sha256Digest; value: unknown }> {
  let canonical: string;
  let parsed: unknown;
  try {
    canonical = serializeCanonicalJson(value ?? null);
    parsed = parseJsonStrict(canonical);
  } catch {
    return fail('JSON knowledge adapter config is invalid.');
  }
  return Object.freeze({ digest: sha256(canonical), value: parsed });
}

async function loadEntries(
  input: SourceAdapterProjectionInputV1,
  registration: SourceAdapterRegistrationV1,
): Promise<readonly LoadedEntry[]> {
  const entries: LoadedEntry[] = [];
  for (const file of input.selectedFiles) {
    if (file.adapterId !== registration.adapterId ||
        file.adapterVersion !== registration.adapterVersion || file.kind !== 'json' ||
        file.documentKind !== 'json' || file.mediaType !== 'application/json') {
      return fail('JSON knowledge adapter input binding is invalid.');
    }
    const bytes = await readSelectedSourceBytes(input.checkout, file);
    try {
      const decoded = decodeUtf8Strict(bytes);
      const parsed = parseJsonWithLocationsStrict(decoded);
      entries.push(Object.freeze({
        contentHash: file.contentDigest,
        declarationId: file.declarationId,
        decoded,
        file,
        locations: parsed.locations,
        sourceRef: file.sourceRef,
        value: parsed.value,
      }));
    } catch {
      return fail('JSON knowledge adapter input is invalid.');
    }
  }
  entries.sort((left, right) => compareText(
    `${left.declarationId}\u0000${left.sourceRef}`,
    `${right.declarationId}\u0000${right.sourceRef}`,
  ));
  return Object.freeze(entries);
}

function validateRegistration(value: SourceAdapterRegistrationV1): SourceAdapterRegistrationV1 {
  const registration = parseSourceAdapterRegistration(value);
  if (registration.adapterId === 'buildlore.generic' || registration.adapterId === 'buildlore.json' ||
      registration.adapterId === 'buildlore.p2a' || registration.kinds.length !== 1 ||
      registration.kinds[0]?.kind !== 'json' ||
      serializeCanonicalJson(registration.kinds[0]?.mediaTypes) !==
        serializeCanonicalJson(['application/json'])) {
    return fail('JSON knowledge adapter registration is invalid.');
  }
  return registration;
}

function customMapRange(): never {
  return fail('JSON knowledge adapter ranges require JSON provenance.');
}

function candidateMetadata(
  registration: SourceAdapterRegistrationV1,
  values: unknown,
): SourceMetadataV1 | undefined {
  if (values === undefined) return undefined;
  if (!isRecord(values)) return fail('JSON knowledge adapter metadata is invalid.');
  return parseSourceMetadata({
    namespace: registration.metadataNamespace,
    schemaVersion: registration.metadataSchemaVersion,
    values,
  });
}

function adapterConfigFor(entries: readonly LoadedEntry[]): Readonly<{ digest: Sha256Digest; value: unknown }> {
  const configurations = entries.map((entry) =>
    entry.file.metadata?.values.adapterConfig ?? null);
  const canonical = configurations.map((value) => serializeCanonicalJson(value));
  if (new Set(canonical).size > 1) return fail('JSON knowledge adapter configs conflict.');
  return immutableConfig(configurations[0] ?? null);
}

function originMappings(
  draft: JsonKnowledgeAdapterCandidateDraftV1,
  entries: ReadonlyMap<string, LoadedEntry>,
): readonly SourceJsonOriginMappingV1[] {
  if (!Array.isArray(draft.origins) || draft.origins.length < 1 ||
      draft.origins.length > MAX_SOURCE_ORIGIN_MAPPINGS) {
    return fail('JSON knowledge adapter origins are invalid.');
  }
  return Object.freeze(draft.origins.map((origin) => {
    if (!isRecord(origin)) return fail('JSON knowledge adapter origin is invalid.');
    exactKeys(origin, ['canonical', 'jsonPointer', 'sourceRef']);
    const sourceRef = validatePortableSourceRef(origin.sourceRef);
    const entry = entries.get(sourceRef);
    const jsonPointer = validateJsonPointer(origin.jsonPointer);
    const location = entry?.locations.find((item) => item.pointer === jsonPointer);
    if (entry === undefined || location === undefined) {
      return fail('JSON knowledge adapter origin binding is invalid.');
    }
    return Object.freeze({
      canonical: validateSourceOriginRange(origin.canonical),
      origin: Object.freeze({
        contentHash: entry.contentHash,
        jsonPointer,
        range: Object.freeze({
          endColumn: location.range.end.column,
          endLine: location.range.end.line,
          startColumn: location.range.start.column,
          startLine: location.range.start.line,
        }),
        sourceRef,
      }),
    });
  }));
}

async function projectCustom(
  adapter: JsonKnowledgeAdapterV1,
  registration: SourceAdapterRegistrationV1,
  registrationDigest: Sha256Digest,
  input: SourceAdapterProjectionInputV1,
  referenceOptions?: JsonKnowledgeReferenceAdapterOptions,
): Promise<SourceCollectionAdapterResult> {
  if (input.selectedFiles.length > 0 && input.ingestedAt === undefined) {
    return fail('JSON knowledge adapter timestamp is unavailable.');
  }
  const loaded = await loadEntries(input, registration);
  let matched: readonly LoadedEntry[];
  try {
    matched = Object.freeze(loaded.filter((entry) => adapter.matches?.(entry) ?? true));
  } catch {
    return fail('JSON knowledge adapter match failed.');
  }
  const config = adapterConfigFor(matched.length === 0 ? loaded : matched);
  let projected: JsonKnowledgeAdapterProjectionV1 | readonly JsonKnowledgeAdapterCandidateDraftV1[];
  try {
    projected = await adapter.project(Object.freeze({
      config: config.value,
      configDigest: config.digest,
      entries: Object.freeze(matched.map(({
        contentHash, declarationId, locations, sourceRef, value,
      }) => Object.freeze({ contentHash, declarationId, locations, sourceRef, value }))),
      projectId: input.inventory.projectId,
    }));
  } catch {
    return fail('JSON knowledge adapter projection failed.');
  }
  let draftValues: readonly unknown[];
  let decisionValues: readonly unknown[] = Object.freeze([]);
  if (Array.isArray(projected)) {
    draftValues = projected;
  } else if (isRecord(projected)) {
    exactKeys(projected, ['candidates', 'entries']);
    const candidatesValue = property(projected, 'candidates');
    const entriesValue = property(projected, 'entries');
    if (!Array.isArray(candidatesValue) || !Array.isArray(entriesValue)) {
      return fail('JSON knowledge adapter projection is invalid.');
    }
    draftValues = candidatesValue;
    decisionValues = entriesValue;
  } else {
    return fail('JSON knowledge adapter projection is invalid.');
  }
  if (draftValues.length > MAX_JSON_ADAPTER_CANDIDATES ||
      decisionValues.length > matched.length) {
    return fail('JSON knowledge adapter candidates are invalid.');
  }
  const bySourceRef = new Map(matched.map((entry) => [entry.sourceRef, entry] as const));
  const decidedSourceRefs = new Set<string>();
  const adapterEntries = decisionValues.map((value) => {
    if (!isRecord(value)) return fail('JSON knowledge adapter entry decision is invalid.');
    exactKeys(value, ['decision', 'reasonCode', 'sourceRef']);
    const sourceRef = validatePortableSourceRef(value.sourceRef);
    if (!bySourceRef.has(sourceRef) || decidedSourceRefs.has(sourceRef) ||
        (value.decision !== 'exclude' && value.decision !== 'quarantine') ||
        typeof value.reasonCode !== 'string' || value.reasonCode.length > 128 ||
        !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/u.test(value.reasonCode)) {
      return fail('JSON knowledge adapter entry decision is invalid.');
    }
    decidedSourceRefs.add(sourceRef);
    return Object.freeze({
      adapterId: registration.adapterId,
      decision: value.decision,
      reasonCode: value.reasonCode,
      sourceRef,
    });
  });
  const candidates: CollectionCandidate[] = [];
  const referencedSourceRefs = new Set<string>();
  let previousLogicalId = '';
  for (const draft of draftValues) {
    if (!isRecord(draft)) return fail('JSON knowledge adapter candidate is invalid.');
    exactKeys(draft, ['body', 'inputSourceRefs', 'logicalId', 'origins', 'title'], [
      'metadata', 'retrievalMeaning',
    ]);
    if (typeof draft.logicalId !== 'string' ||
        !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(draft.logicalId) ||
        draft.logicalId.length > 128 || compareText(draft.logicalId, previousLogicalId) <= 0 ||
        typeof draft.title !== 'string' || unicodeScalarLength(draft.title) < 1 ||
        unicodeScalarLength(draft.title) > 500 || typeof draft.body !== 'string' ||
        unicodeScalarLength(draft.body) > MAX_SOURCE_BODY_CHARS ||
        !Array.isArray(draft.inputSourceRefs) || draft.inputSourceRefs.length < 1 ||
        draft.inputSourceRefs.length > 128) {
      return fail('JSON knowledge adapter candidate is invalid.');
    }
    previousLogicalId = draft.logicalId;
    const sourceRefs = draft.inputSourceRefs.map(validatePortableSourceRef);
    if (new Set(sourceRefs).size !== sourceRefs.length || sourceRefs.some((sourceRef, index) =>
      !bySourceRef.has(sourceRef) || (index > 0 && compareText(sourceRef, sourceRefs[index - 1] ?? '') <= 0))) {
      return fail('JSON knowledge adapter candidate inputs are invalid.');
    }
    const inputEntries = sourceRefs.map((sourceRef) => bySourceRef.get(sourceRef) as LoadedEntry);
    if (sourceRefs.some((sourceRef) => decidedSourceRefs.has(sourceRef))) {
      return fail('JSON knowledge adapter input decision conflicts with a candidate.');
    }
    for (const sourceRef of sourceRefs) referencedSourceRefs.add(sourceRef);
    const primary = inputEntries[0];
    if (primary === undefined) return fail('JSON knowledge adapter candidate input is unavailable.');
    const metadata = candidateMetadata(registration, draft.metadata);
    const retrievalMeaning = draft.retrievalMeaning === undefined
      ? undefined
      : parseSourceRetrievalMeaning(draft.retrievalMeaning);
    const validatedDraft = draft as unknown as JsonKnowledgeAdapterCandidateDraftV1;
    const jsonOrigins = originMappings(validatedDraft, bySourceRef);
    const identityRef = `adapter/${sha256(`${registration.adapterId}\u0000${draft.logicalId}`)
      .slice('sha256:'.length)}.json`;
    const sourceUri = createCollectionSourceIdentity({
      declarationId: primary.declarationId,
      documentKind: 'json',
      projectId: input.inventory.projectId,
      repository: input.loadedManifest.manifest.sourceRepository,
      sourceRef: identityRef,
    });
    const inputBindings = inputEntries.map((entry) => Object.freeze({
      contentHash: entry.contentHash,
      sourceRef: entry.sourceRef,
    }));
    const projectionRevision = sha256(serializeCanonicalJson({
      adapterId: registration.adapterId,
      adapterVersion: registration.adapterVersion,
      body: draft.body,
      configDigest: config.digest,
      inputBindings,
      jsonOrigins,
      logicalId: draft.logicalId,
      metadata: metadata ?? null,
      registrationDigest,
      retrievalMeaning: retrievalMeaning ?? null,
      title: draft.title,
    }));
    const descriptor = parseSourceDescriptor({
      adapterConfigDigest: config.digest,
      adapterId: registration.adapterId,
      adapterRegistrationDigest: registrationDigest,
      adapterVersion: registration.adapterVersion,
      contentHash: primary.contentHash,
      declarationId: primary.declarationId,
      inputBindings,
      kind: 'json',
      mediaType: 'application/json',
      ...(metadata === undefined ? {} : { metadata }),
      projectId: input.inventory.projectId,
      projectionRevision,
      schemaVersion: SOURCE_DESCRIPTOR_V2_SCHEMA_VERSION,
      sourceRef: primary.sourceRef,
      sourceRevision: projectionRevision,
      sourceUri,
    });
    if (descriptor.schemaVersion !== SOURCE_DESCRIPTOR_V2_SCHEMA_VERSION) {
      return fail('JSON knowledge adapter descriptor is invalid.');
    }
    const candidate = {
      adapterId: registration.adapterId,
      adapterVersion: registration.adapterVersion,
      body: draft.body,
      canonicalDocument: createSourceDocument({
        body: draft.body,
        descriptor,
        ingestedAt: input.ingestedAt as string,
        jsonOrigins,
        producer: 'buildlore',
        projectId: input.inventory.projectId,
        source: sourceUri,
        sourceKind: 'json',
        sourceRevision: projectionRevision,
        sourceType: 'file',
        title: draft.title,
      }),
      contentDigest: primary.contentHash,
      declarationId: primary.declarationId,
      descriptor,
      documentKind: 'json' as const,
      ingestedAt: input.ingestedAt as string,
      jsonOrigins,
      mediaType: 'application/json' as const,
      producer: 'buildlore' as const,
      projectId: input.inventory.projectId,
      ...(retrievalMeaning === undefined
        ? {}
        : { retrievalMeaning: Object.freeze({ meaning: retrievalMeaning, origin: 'adapter' as const }) }),
      sourceKind: 'json' as const,
      sourceRef: primary.sourceRef,
      sourceRevision: projectionRevision,
      sourceUri,
      target: `json--${sha256(sourceUri).slice('sha256:'.length)}.md`,
      title: draft.title,
    };
    projectSourceProducer(candidate);
    candidates.push(bindRawSourceInputs(
      Object.freeze(candidate),
      inputEntries.map((entry) => rawInputForLoaded(entry, referenceOptions)),
    ));
  }
  if (matched.some((entry) =>
    !referencedSourceRefs.has(entry.sourceRef) && !decidedSourceRefs.has(entry.sourceRef))) {
    return fail('JSON knowledge adapter did not account for every matched input.');
  }
  return bindRawSourceInputs(Object.freeze({
    candidates: Object.freeze(candidates),
    entries: Object.freeze([
      ...adapterEntries,
      ...loaded.filter((entry) => !matched.includes(entry)).map((entry) => Object.freeze({
        adapterId: registration.adapterId,
        decision: adapter.unmatchedDecision ?? 'exclude',
        reasonCode: adapter.unmatchedDecision === 'quarantine'
          ? 'adapter_schema_unsupported'
          : 'adapter_not_matched',
        sourceRef: entry.sourceRef,
      })),
    ]),
    notices: Object.freeze([]),
  }), loaded.map((entry) => rawInputForLoaded(entry, referenceOptions)));
}

function registerAdapter(
  adapter: JsonKnowledgeAdapterV1,
  referenceOptions?: JsonKnowledgeReferenceAdapterOptions,
): RegisteredJsonKnowledgeAdapterV1 {
  if (adapter.contractVersion !== JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION ||
      typeof adapter.project !== 'function' ||
      (adapter.matches !== undefined && typeof adapter.matches !== 'function') ||
      (adapter.unmatchedDecision !== undefined && adapter.unmatchedDecision !== 'exclude' &&
        adapter.unmatchedDecision !== 'quarantine')) {
    return fail('JSON knowledge adapter contract is invalid.');
  }
  const registration = validateRegistration(adapter.registration);
  const registrationDigest = sha256(serializeCanonicalJson(registration));
  const runtime: SourceAdapterV1 = Object.freeze({
    mapRange: customMapRange,
    project: (input: SourceAdapterProjectionInputV1) =>
      projectCustom(adapter, registration, registrationDigest, input, referenceOptions),
    registration,
  });
  return Object.freeze({
    mapRange: customMapRange,
    registration,
    registrationDigest,
    runtime,
  });
}

export function registerJsonKnowledgeAdapter(
  adapter: JsonKnowledgeAdapterV1,
): RegisteredJsonKnowledgeAdapterV1 {
  return registerAdapter(adapter);
}

/** @internal Reserved for bundled reference adapters; not part of the package export surface. */
export function registerJsonKnowledgeReferenceAdapter(
  adapter: JsonKnowledgeAdapterV1,
  options: JsonKnowledgeReferenceAdapterOptions,
): RegisteredJsonKnowledgeAdapterV1 {
  if (typeof options.rawSecurityInput !== 'function') {
    return fail('JSON knowledge reference adapter policy is invalid.');
  }
  return registerAdapter(adapter, options);
}
