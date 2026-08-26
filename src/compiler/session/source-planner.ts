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
import { createProfileBindingPreflight } from '../../profile/preflight.js';
import {
  createSourceCollectionAdapter,
  type CollectionCandidate,
} from '../../projector/collection-adapters.js';
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
import { consumePreparedSource } from '../../sanitizer/approval.js';
import {
  createProjectSecurityService,
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
  readonly pendingSlugs: ReadonlySet<string>;
  readonly plan: SessionCompilePlanV1;
  readonly profileMode: 'custom' | 'default';
  readonly workspace: string;
}

export interface SessionCompilePlanner {
  create(projectId: string): Promise<SessionCompilePlanSnapshot>;
}

export interface CreateSessionCompilePlannerOptions {
  readonly hubRoot: string;
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

function denied(projectId: string): never {
  throw new SessionCompileError('SESSION_PLAN_DENIED', projectId);
}

async function sanitizeCandidateText(
  candidate: CollectionCandidate,
  body: string,
  sourceKind: Extract<SecuritySourceKind, 'markdown' | 'planning'>,
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
      ingestedAt: document.ingestedAt,
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
    renderSourceDocument(expected) !== raw ||
    document.buildlore.contentHash !== sessionSha256(document.body)
  ) return denied(projectId);
  return Object.freeze({
    body: document.body,
    contentDigest: sessionSha256(raw),
  });
}

function compilerSourceId(candidate: CollectionCandidate, projectId: string): string {
  if (!/^(?:markdown|planning)--[a-f0-9]{64}\.md$/u.test(candidate.target)) {
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
    if (candidate.sourceKind !== 'markdown' && candidate.sourceKind !== 'planning') {
      return denied(input.projectId);
    }
    const file = input.files.get(candidate.sourceRef);
    if (file === undefined || file.contentDigest !== candidate.contentDigest ||
        file.contentDigest !== candidate.sourceRevision) return denied(input.projectId);
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
        sanitizedBody: storedSource.body,
        sourceId: id,
        sourceRef: candidate.sourceRef,
      }),
      compilerSourceContentDigest: storedSource.contentDigest,
      compilerSourceId: compilerSourceId(candidate, input.projectId),
      originalContentDigest: candidate.contentDigest,
      revision: candidate.sourceRevision,
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

function projectProfileDigest(record: ProjectRecord): SessionSha256Digest {
  return digestSessionValue(record.descriptor.schemaVersion === 'buildlore.project.v1'
    ? {
        mode: 'default',
        outputLanguage: 'en',
        profileHash: null,
        profileVersion: record.descriptor.profileVersion,
      }
    : {
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
  const profilePreflight = createProfileBindingPreflight(options.knowledgeRoot);
  return {
    async create(projectId): Promise<SessionCompilePlanSnapshot> {
      try {
        const record = await showProject(options.knowledgeRoot, projectId);
        const workspace = await resolveProjectWorkspace(options.knowledgeRoot, projectId, {
          mustExist: true,
        });
        const profile = await profilePreflight.resolve(projectId);
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
        const loadedManifest = await readSourceCollectionManifest(binding.checkout, projectId);
        const inventory = await selectDeclaredSourceFiles(binding.checkout, loadedManifest, {
          limits: {
            maxAggregateBytes: SESSION_COMPILE_LIMITS.maxPlanBytes,
            maxFileBytes: SESSION_COMPILE_LIMITS.maxSourceBytes,
            maxFileCount: SESSION_COMPILE_LIMITS.maxSources,
          },
        });
        const collection = await createSourceCollectionAdapter().collect({
          checkout: binding.checkout,
          inventory,
          loadedManifest,
          markdownIngestedAt: FIXED_COLLECTION_TIMESTAMP,
        });
        if (collection.compatibilityWarnings.length > 0) return denied(projectId);
        options.onPhase?.('sources-collected');
        const policy = await readSecurityPolicy(options.knowledgeRoot, projectId);
        if (policy.workspace !== workspace) return denied(projectId);
        options.onPhase?.('policy-resolved');
        const sources = await buildPlannedSources({
          candidates: collection.candidates,
          checkout: binding.checkout,
          files: new Map(inventory.files.map((file) => [file.sourceRef, file] as const)),
          ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
          policy,
          projectId,
          security: createProjectSecurityService({ knowledgeRoot: options.knowledgeRoot }),
          workspace,
        });
        options.onPhase?.('sources-verified');
        const egressRequest = Object.freeze({ capability: 'compile' as const, projectId });
        const permit = await prepareCompilerEgress(
          options.knowledgeRoot,
          workspace,
          egressRequest,
        );
        await verifyAndConsumeCompilerEgress(
          permit,
          options.knowledgeRoot,
          workspace,
          egressRequest,
        );
        options.onPhase?.('egress-authorized');
        const knowledge = await readSessionKnowledgeInventory(workspace, projectId);
        options.onPhase?.('inventory-read');
        const planned = createSessionTasksAndMerges(sources, profile.mode, projectId);
        return Object.freeze({
          pendingSlugs: knowledge.pendingSlugs,
          plan: finalizeSessionCompilePlan({
            schemaVersion: SESSION_COMPILE_PLAN_SCHEMA_VERSION,
            projectId,
            contractDigest: SESSION_COMPILE_CONTRACT_DIGEST,
            profileDigest: projectProfileDigest(record),
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
          profileMode: profile.mode,
          workspace,
        });
      } catch (error) {
        if (error instanceof SessionCompileError) throw error;
        return denied(projectId);
      }
    },
  };
}
