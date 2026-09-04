import { join, resolve } from 'node:path';

import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import {
  resolveLocalProjectBinding,
  type SourceCheckoutHandle,
} from '../../knowledge/local-project-registry.js';
import { resolveProjectWorkspace } from '../../knowledge/paths.js';
import { decodeUtf8Strict } from '../../knowledge/strict-json.js';
import type { ProjectRecord } from '../../knowledge/types.js';
import { showProject } from '../../knowledge/workspace.js';
import { resolveRegisteredProfileBinding } from '../../profile/preflight.js';
import {
  createSourceCollectionAdapter,
  type CollectionCandidate,
} from '../../projector/collection-adapters.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from '../../projector/json-knowledge-adapter.js';
import {
  readSelectedSourceBytes,
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
  type SelectedSourceFile,
  type SourceSelectionInventory,
} from '../../projector/source-manifest.js';
import {
  createSourceDocument,
  parseSourceDocument,
  renderSourceDocument,
} from '../../projector/source-document.js';
import { isCollectableProjectSourceKind } from '../../projector/project-source-writer.js';
import { sourceRetrievalMeaningFromDescriptor } from '../../projector/source-contracts.js';
import {
  boundRawSourceInputsAreSafe,
  inspectRawSourceInputs,
  rawSourceInputSanitizationIsSafe,
} from '../../projector/raw-source-inputs.js';
import { consumePreparedSource } from '../../sanitizer/approval.js';
import {
  createProjectSecurityService,
  generatedSourceFilenameKind,
  readSecurityPolicy,
  SANITIZER_RULES_VERSION,
  type LoadedSecurityPolicy,
  type SecuritySourceKind,
} from '../../sanitizer/index.js';
import { prepareCompilerEgress, verifyAndConsumeCompilerEgress } from '../security.js';
import { digestSessionValue, sessionSha256 } from './canonical.js';
import {
  finalizeSessionCompilePlan,
  SESSION_COMPILE_CONTRACT_DIGEST,
  SESSION_COMPILE_LIMITS,
} from './contracts.js';
import { SessionCompileError } from './errors.js';
import { readSessionKnowledgeInventory } from './inventory.js';
import {
  createSessionCitationAnchors,
  createSessionTasksAndMerges,
} from './planner-pure.js';
import { readConfinedSessionUtf8 } from './safe-io.js';
import {
  SESSION_COMPILE_ALGORITHM_VERSION,
  SESSION_COMPILE_PLAN_SCHEMA_VERSION,
  type SessionCompilePlanV1,
  type SessionPlannedSource,
  type SessionSha256Digest,
} from './types.js';

const FIXED_COLLECTION_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export interface SessionCompilePlanSnapshot {
  readonly candidateInventoryDigest: SessionSha256Digest;
  readonly pendingSlugs: ReadonlySet<string>;
  readonly plan: SessionCompilePlanV1;
  readonly profileMode: 'custom' | 'default';
  readonly wikiInventoryDigest: SessionSha256Digest;
  readonly workspace: string;
}

export interface SessionCompilePlanner {
  create(projectId: string): Promise<SessionCompilePlanSnapshot>;
}

export interface CreateSessionCompilePlannerOptions {
  readonly hubRoot: string;
  readonly jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
  readonly knowledgeRoot: string;
  /** @internal Verification seam for phase ordering. */
  readonly onPhase?: (phase: SessionCompilePlannerPhase) => void;
}

export type SessionCompilePlannerPhase =
  | 'binding-resolved'
  | 'egress-authorized'
  | 'inventory-read'
  | 'policy-resolved'
  | 'project-resolved'
  | 'sources-collected'
  | 'source-bound'
  | 'source-original-read'
  | 'source-sanitized'
  | 'source-stored-verified'
  | 'sources-verified';

function denied(
  projectId: string,
  recoveryAction: SessionCompileError['recoveryAction'] = 'check-config',
): never {
  throw new SessionCompileError('SESSION_PLAN_DENIED', projectId, { recoveryAction });
}

async function sanitizeCandidateText(
  candidate: CollectionCandidate,
  body: string,
  sourceKind: Extract<SecuritySourceKind, 'code' | 'json' | 'markdown' | 'planning' | 'text'>,
  security: ReturnType<typeof createProjectSecurityService>,
  policy: LoadedSecurityPolicy,
  projectId: string,
): Promise<string> {
  const bodyDigest = sessionSha256(body);
  const result = await security.prepareSource({
    body,
    bodyDigest,
    projectId,
    source: candidate.sourceUri,
    sourceKind,
    sourceRevisionOrContentSha256: candidate.sourceRevision,
  });
  if (
    !result.ok ||
    result.report.decision !== 'include' ||
    result.report.findingsOverflow ||
    result.report.inputDigest !== bodyDigest ||
    result.report.policyDigest !== policy.digest ||
    result.report.projectId !== projectId ||
    result.report.rulesVersion !== SANITIZER_RULES_VERSION ||
    result.report.summaries.some((summary) =>
      summary.action !== 'redact' && summary.count !== summary.overriddenCount)
  ) return denied(projectId);
  const prepared = consumePreparedSource(result.prepared);
  if (
    prepared === null ||
    prepared.inputBodyDigest !== bodyDigest ||
    prepared.approvedBodyDigest !== result.report.outputDigest ||
    prepared.policyDigest !== policy.digest ||
    prepared.projectId !== projectId ||
    prepared.source !== candidate.sourceUri ||
    prepared.sourceKind !== sourceKind ||
    prepared.sourceRevisionOrContentSha256 !== candidate.sourceRevision ||
    sessionSha256(prepared.approvedBody) !== prepared.approvedBodyDigest
  ) return denied(projectId);
  return prepared.approvedBody;
}

function sourceSelectionDigest(
  inventory: SourceSelectionInventory,
  bindingDigest: SessionSha256Digest,
): SessionSha256Digest {
  return digestSessionValue({
    bindingDigest,
    directories: inventory.directories.map((directory) => ({
      declarationId: directory.declarationId,
      sourceRef: directory.sourceRef,
    })),
    files: inventory.files.map((file) => ({
      byteLength: file.byteLength,
      contentDigest: file.contentDigest,
      declarationId: file.declarationId,
      documentKind: file.documentKind,
      sourceRef: file.sourceRef,
    })),
    manifestDigest: inventory.manifestDigest,
    projectId: inventory.projectId,
    totalBytes: inventory.totalBytes,
  });
}

function plannedSourceId(candidate: CollectionCandidate, sanitizedBody: string): string {
  return 'source-' + digestSessionValue({
    projectId: candidate.projectId,
    revision: candidate.sourceRevision,
    sanitizedContentDigest: sessionSha256(sanitizedBody),
    sourceKind: candidate.sourceKind,
    sourceRef: candidate.sourceRef,
  }).slice('sha256:'.length);
}

async function assertStoredSource(
  workspace: string,
  candidate: CollectionCandidate,
  approvedTitle: string,
  approvedBody: string,
  projectId: string,
): Promise<Readonly<{
  readonly body: string;
  readonly contentDigest: SessionSha256Digest;
}>> {
  const raw = await readConfinedSessionUtf8(
    join(workspace, 'sources', candidate.target),
    workspace,
    SESSION_COMPILE_LIMITS.maxSourceBytes,
    projectId,
  );
  let document;
  try {
    document = parseSourceDocument(raw);
  } catch {
    return denied(projectId);
  }
  let expected;
  try {
    expected = createSourceDocument({
      body: approvedBody,
      ...(candidate.descriptor === undefined ? {} : { descriptor: candidate.descriptor }),
      ingestedAt: document.ingestedAt,
      ...(candidate.originMappings === undefined
        ? {}
        : { originMappings: candidate.originMappings }),
      ...(candidate.jsonOrigins === undefined
        ? {}
        : { jsonOrigins: candidate.jsonOrigins }),
      producer: candidate.producer,
      projectId,
      source: candidate.sourceUri,
      sourceKind: candidate.sourceKind,
      sourceRevision: candidate.sourceRevision,
      sourceType: 'file',
      title: approvedTitle,
    });
  } catch {
    return denied(projectId);
  }
  if (
    renderSourceDocument(document) !== raw ||
    document.buildlore.contentHash !== sessionSha256(document.body)
  ) return denied(projectId);
  if (renderSourceDocument(expected) !== raw) return denied(projectId, 'sync');
  return Object.freeze({
    body: document.body,
    contentDigest: sessionSha256(raw),
  });
}

function compilerSourceId(candidate: CollectionCandidate, projectId: string): string {
  const sourceKind = generatedSourceFilenameKind(candidate.target);
  if (
    sourceKind === null ||
    sourceKind === 'execution' ||
    sourceKind !== candidate.sourceKind
  ) {
    return denied(projectId);
  }
  return candidate.target;
}

async function buildPlannedSources(input: {
  readonly candidates: readonly CollectionCandidate[];
  readonly checkout: SourceCheckoutHandle;
  readonly files: ReadonlyMap<string, SelectedSourceFile>;
  readonly policy: LoadedSecurityPolicy;
  readonly onPhase?: (phase: SessionCompilePlannerPhase) => void;
  readonly projectId: string;
  readonly security: ReturnType<typeof createProjectSecurityService>;
  readonly workspace: string;
}): Promise<readonly SessionPlannedSource[]> {
  if (input.candidates.length === 0 || input.candidates.length > SESSION_COMPILE_LIMITS.maxSources) {
    return denied(input.projectId);
  }
  const result: SessionPlannedSource[] = [];
  for (const candidate of input.candidates) {
    if (!isCollectableProjectSourceKind(candidate.sourceKind)) {
      return denied(input.projectId);
    }
    const file = input.files.get(candidate.sourceRef);
    if (file === undefined || file.contentDigest !== candidate.contentDigest ||
        (candidate.descriptor?.schemaVersion === 'buildlore.source-descriptor.v2'
          ? !candidate.descriptor.inputBindings.some((binding) =>
              binding.sourceRef === file.sourceRef && binding.contentHash === file.contentDigest)
          : file.contentDigest !== candidate.sourceRevision)) return denied(input.projectId);
    input.onPhase?.('source-bound');
    const approvedTitle = await sanitizeCandidateText(
      candidate,
      candidate.title,
      candidate.sourceKind,
      input.security,
      input.policy,
      input.projectId,
    );
    const approvedBody = await sanitizeCandidateText(
      candidate,
      candidate.body,
      candidate.sourceKind,
      input.security,
      input.policy,
      input.projectId,
    );
    for (const rawInput of inspectRawSourceInputs(candidate)) {
      const rawBodyDigest = sessionSha256(rawInput.body);
      const rawResult = await input.security.prepareSource({
        body: rawInput.body,
        bodyDigest: rawBodyDigest,
        projectId: input.projectId,
        source: candidate.sourceUri,
        sourceKind: candidate.sourceKind,
        sourceRevisionOrContentSha256: candidate.sourceRevision,
      });
      const rawPrepared = rawResult.ok ? consumePreparedSource(rawResult.prepared) : null;
      if (!rawResult.ok || rawPrepared === null ||
          rawPrepared.inputBodyDigest !== rawBodyDigest ||
          rawPrepared.approvedBodyDigest !== rawResult.report.outputDigest ||
          rawPrepared.policyDigest !== input.policy.digest ||
          rawPrepared.projectId !== input.projectId ||
          rawPrepared.source !== candidate.sourceUri ||
          rawPrepared.sourceKind !== candidate.sourceKind ||
          rawPrepared.sourceRevisionOrContentSha256 !== candidate.sourceRevision ||
          !rawSourceInputSanitizationIsSafe(
            rawInput,
            rawPrepared.approvedBody,
            rawResult.report.summaries,
          )) return denied(input.projectId);
    }
    input.onPhase?.('source-sanitized');
    const storedSource = await assertStoredSource(
      input.workspace,
      candidate,
      approvedTitle,
      approvedBody,
      input.projectId,
    );
    input.onPhase?.('source-stored-verified');
    const originalBody = decodeUtf8Strict(await readSelectedSourceBytes(input.checkout, file));
    input.onPhase?.('source-original-read');
    const id = plannedSourceId(candidate, storedSource.body);
    result.push(Object.freeze({
      citationAnchors: createSessionCitationAnchors({
        originalBody,
        ...(candidate.originMappings === undefined
          ? {}
          : { originMappings: candidate.originMappings }),
        ...(candidate.jsonOrigins === undefined
          ? {}
          : { jsonOrigins: candidate.jsonOrigins }),
        sanitizedBody: storedSource.body,
        sourceId: id,
        sourceRef: candidate.sourceRef,
      }),
      compilerSourceContentDigest: storedSource.contentDigest,
      compilerSourceId: compilerSourceId(candidate, input.projectId),
      originalContentDigest: candidate.contentDigest,
      revision: candidate.sourceRevision,
      retrievalMeaning: candidate.retrievalMeaning ??
        sourceRetrievalMeaningFromDescriptor(candidate.descriptor),
      sanitizedBody: storedSource.body,
      sanitizedContentDigest: sessionSha256(storedSource.body),
      sourceId: id,
      sourceKind: candidate.sourceKind,
      sourceRef: candidate.sourceRef,
      title: approvedTitle,
    }));
  }
  result.sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0);
  if (Buffer.byteLength(serializeCanonicalJson(result), 'utf8') >
      SESSION_COMPILE_LIMITS.maxPlanBytes) return denied(input.projectId);
  return Object.freeze(result);
}

function projectProfileDigest(
  record: ProjectRecord,
  profileBindingDigest: SessionSha256Digest,
): SessionSha256Digest {
  return digestSessionValue(record.descriptor.schemaVersion === 'buildlore.project.v1'
    ? {
        profileBindingDigest,
        mode: 'default',
        outputLanguage: 'en',
        profileHash: null,
        profileVersion: record.descriptor.profileVersion,
      }
    : {
        profileBindingDigest,
        mode: 'custom',
        outputLanguage: record.descriptor.outputLanguage,
        profileHash: record.descriptor.profileHash,
        profileId: record.descriptor.profileId,
        profileVersion: record.descriptor.profileVersion,
      });
}

export function createSessionCompilePlanner(
  options: CreateSessionCompilePlannerOptions,
): SessionCompilePlanner {
  return {
    async create(projectId): Promise<SessionCompilePlanSnapshot> {
      try {
        const record = await showProject(options.knowledgeRoot, projectId);
        const workspace = await resolveProjectWorkspace(options.knowledgeRoot, projectId, {
          mustExist: true,
        });
        const profile = await resolveRegisteredProfileBinding(options.knowledgeRoot, projectId, {
          registrations: options.jsonKnowledgeAdapters ?? [],
        });
        if (resolve(options.knowledgeRoot, record.workspacePath) !== workspace ||
            profile.workspace !== workspace) {
          return denied(projectId);
        }
        options.onPhase?.('project-resolved');
        const binding = await resolveLocalProjectBinding(
          options.hubRoot,
          projectId,
          record.entry.sourceRepository,
        );
        options.onPhase?.('binding-resolved');
        const loadedManifest = await readSourceCollectionManifest(binding.checkout, projectId, {
          sourceAdapterRegistry: profile.sourceAdapters,
        });
        const inventory = await selectDeclaredSourceFiles(binding.checkout, loadedManifest, {
          limits: {
            maxAggregateBytes: SESSION_COMPILE_LIMITS.maxPlanBytes,
            maxFileBytes: SESSION_COMPILE_LIMITS.maxSourceBytes,
            maxFileCount: SESSION_COMPILE_LIMITS.maxSources,
          },
          sourceAdapterRegistry: profile.sourceAdapters,
        });
        const collection = await createSourceCollectionAdapter({
          ...(options.jsonKnowledgeAdapters === undefined
            ? {}
            : { jsonKnowledgeAdapters: options.jsonKnowledgeAdapters }),
        }).collect({
          checkout: binding.checkout,
          ingestedAt: FIXED_COLLECTION_TIMESTAMP,
          inventory,
          loadedManifest,
          sourceAdapterRegistry: profile.sourceAdapters,
        });
        if (collection.notices.length > 0 || collection.entries.some((entry) =>
          entry.decision === 'blocked' || entry.decision === 'error' ||
          entry.decision === 'quarantine')) return denied(projectId);
        options.onPhase?.('sources-collected');
        const policy = await readSecurityPolicy(options.knowledgeRoot, projectId);
        if (policy.workspace !== workspace) return denied(projectId);
        options.onPhase?.('policy-resolved');
        const security = createProjectSecurityService({ knowledgeRoot: options.knowledgeRoot });
        if (!await boundRawSourceInputsAreSafe(collection, {
          policyDigest: policy.digest,
          projectId,
          security,
          source: `buildlore://project/${projectId}/selected-json-inputs`,
          sourceKind: 'json',
          sourceRevision: loadedManifest.manifestDigest,
        })) return denied(projectId);
        const sources = await buildPlannedSources({
          candidates: collection.candidates,
          checkout: binding.checkout,
          files: new Map(inventory.files.map((file) => [file.sourceRef, file] as const)),
          ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
          policy,
          projectId,
          security,
          workspace,
        });
        options.onPhase?.('sources-verified');
        const egressRequest = Object.freeze({ capability: 'compile' as const, projectId });
        const permit = await prepareCompilerEgress(
          options.knowledgeRoot,
          workspace,
          egressRequest,
          options.jsonKnowledgeAdapters ?? [],
        );
        await verifyAndConsumeCompilerEgress(
          permit,
          options.knowledgeRoot,
          workspace,
          egressRequest,
          options.jsonKnowledgeAdapters ?? [],
        );
        options.onPhase?.('egress-authorized');
        const knowledge = await readSessionKnowledgeInventory(workspace, projectId);
        options.onPhase?.('inventory-read');
        const freshProfile = await resolveRegisteredProfileBinding(
          options.knowledgeRoot,
          projectId,
          { registrations: options.jsonKnowledgeAdapters ?? [] },
        );
        if (freshProfile.workspace !== profile.workspace ||
            freshProfile.bindingDigest !== profile.bindingDigest) {
          return denied(projectId);
        }
        const planned = createSessionTasksAndMerges(
          sources,
          profile.binding.upstreamProfile,
          projectId,
        );
        return Object.freeze({
          candidateInventoryDigest: knowledge.candidateInventoryDigest,
          pendingSlugs: knowledge.pendingSlugs,
          plan: finalizeSessionCompilePlan({
            schemaVersion: SESSION_COMPILE_PLAN_SCHEMA_VERSION,
            projectId,
            contractDigest: SESSION_COMPILE_CONTRACT_DIGEST,
            profileDigest: projectProfileDigest(record, profile.bindingDigest),
            policyDigest: policy.digest,
            selectionDigest: sourceSelectionDigest(inventory, binding.bindingDigest),
            sourceManifestDigest: loadedManifest.manifestDigest,
            existingKnowledgeDigest: knowledge.digest,
            algorithmVersion: SESSION_COMPILE_ALGORITHM_VERSION,
            limits: SESSION_COMPILE_LIMITS,
            sources,
            tasks: planned.tasks,
            mergeCandidates: planned.mergeCandidates,
            allowedLinkTargets: knowledge.allowedLinkTargets,
          }),
          profileMode: profile.binding.upstreamProfile,
          wikiInventoryDigest: knowledge.wikiDigest,
          workspace,
        });
      } catch (error) {
        if (error instanceof SessionCompileError) throw error;
        return denied(projectId);
      }
    },
  };
}
