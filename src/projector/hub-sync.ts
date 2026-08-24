import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import {
  resolveLocalProjectBinding,
  type ResolvedLocalProjectBinding,
  type Sha256Digest,
} from '../knowledge/local-project-registry.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { showProject } from '../knowledge/workspace.js';
import {
  consumePreparedSource,
  inspectPreparedSource,
  type PreparedSourceBinding,
} from '../sanitizer/approval.js';
import { readSecurityPolicy } from '../sanitizer/policy.js';
import {
  createProjectSecurityService,
  type PreparedSource,
  type SanitizationReport,
} from '../sanitizer/index.js';
import {
  createSourceCollectionAdapter,
  type CollectionCandidate,
  type SourceCollectionAdapter,
} from './collection-adapters.js';
import {
  createProjectSourceWriter,
  type ProjectSourceInput,
  type ProjectSourceTargetSnapshot,
  type ProjectSourceWriter,
} from './project-source-writer.js';
import {
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
  type LoadedSourceCollectionManifest,
  type SourceSelectionInventory,
} from './source-manifest.js';
import { createSourceDocument, renderSourceDocument } from './source-document.js';
import {
  createSourceRevisionReader,
  type SourceRevisionReader,
  type SourceRevisionSnapshot,
} from './source-revision.js';
import type {
  HubProjectSyncInput,
  ProjectSyncDecisionCounts,
  ProjectSyncErrorCode,
  ProjectSyncFailurePhase,
  ProjectSyncPlanEntrySummary,
  ProjectSyncPlanSummary,
  ProjectSyncSummary,
  ProjectSyncWarning,
  ProjectSyncWriteSummary,
} from './sync.js';

const EMPTY_COUNTS: ProjectSyncDecisionCounts = Object.freeze({
  blocked: 0,
  error: 0,
  exclude: 0,
  include: 0,
  quarantine: 0,
});

interface FailureOptions {
  readonly cause?: unknown;
  readonly completedTargets?: readonly string[];
  readonly partial?: boolean;
  readonly recoveryAction?: 'inspect-plan' | 'retry-sync';
}

export interface HubSyncFailurePort {
  fail(
    code: ProjectSyncErrorCode,
    phase: ProjectSyncFailurePhase,
    options?: FailureOptions,
  ): never;
}

export interface HubSyncHooks {
  readonly afterPlan?: () => Promise<void> | void;
  readonly beforeFirstWrite?: () => Promise<void> | void;
}

export interface HubSyncOptions {
  readonly collectionAdapter?: SourceCollectionAdapter;
  readonly failure: HubSyncFailurePort;
  readonly hooks?: HubSyncHooks;
  readonly sourceRevisionReader?: SourceRevisionReader;
}

interface SanitizedCandidate {
  readonly bodyPrepared: PreparedSource;
  readonly candidate: CollectionCandidate;
  readonly input: ProjectSourceInput;
  readonly report: SanitizationReport;
  readonly snapshot: ProjectSourceTargetSnapshot;
  readonly sourceKind: 'markdown' | 'planning';
  readonly titlePrepared: PreparedSource;
}

interface PlannedState {
  readonly binding: ResolvedLocalProjectBinding;
  readonly inventory: SourceSelectionInventory;
  readonly loadedManifest: LoadedSourceCollectionManifest;
  readonly policyDigest: Sha256Digest;
  readonly projectEntryJson: string;
  readonly revision: SourceRevisionSnapshot;
  readonly workspace: string;
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function countsFor(entries: readonly ProjectSyncPlanEntrySummary[]): ProjectSyncDecisionCounts {
  const counts = { ...EMPTY_COUNTS };
  for (const entry of entries) counts[entry.decision] += 1;
  return Object.freeze(counts);
}

function planSummary(
  entriesInput: readonly ProjectSyncPlanEntrySummary[],
  binding: Readonly<Record<string, unknown>>,
): ProjectSyncPlanSummary {
  const entries = Object.freeze([...entriesInput].sort((left, right) => compareText(
    `${left.sourceKind}:${left.sourceRef ?? ''}:${left.target ?? ''}:${left.reasonCode}`,
    `${right.sourceKind}:${right.sourceRef ?? ''}:${right.target ?? ''}:${right.reasonCode}`,
  )));
  return Object.freeze({
    counts: countsFor(entries),
    entries,
    planFingerprint: sha256(serializeCanonicalJson({ binding, entries })),
  });
}

function emptyPlan(projectId: string): ProjectSyncPlanSummary {
  return Object.freeze({
    counts: EMPTY_COUNTS,
    entries: Object.freeze([]),
    planFingerprint: sha256(serializeCanonicalJson({ projectId, sourceKind: 'execution' })),
  });
}

function safePlanningRef(value: string): string | null {
  return value.length > 0 && value.length <= 512 &&
    /^[A-Za-z0-9._/-]+$/u.test(value) &&
    !value.startsWith('/') && !value.includes('..')
    ? value
    : null;
}

function inventoryDigest(inventory: SourceSelectionInventory): Sha256Digest {
  return sha256(serializeCanonicalJson({
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
  }));
}

function hasSuspectedSecret(report: SanitizationReport): boolean {
  return report.summaries.some((summary) =>
    summary.count > 0 && (
      summary.ruleId.startsWith('credential.') ||
      summary.ruleId.startsWith('private-key.') ||
      summary.ruleId === 'entropy.candidate' ||
      summary.ruleId === 'input.redaction-incomplete'
    ));
}

function assertPrepared(
  binding: PreparedSourceBinding | null,
  expected: {
    readonly bodyDigest: Sha256Digest;
    readonly policyDigest: Sha256Digest;
    readonly projectId: string;
    readonly source: string;
    readonly sourceKind: 'markdown' | 'planning';
    readonly sourceRevision: Sha256Digest;
  },
  failure: HubSyncFailurePort,
): PreparedSourceBinding {
  if (
    binding === null || binding.inputBodyDigest !== expected.bodyDigest ||
    binding.policyDigest !== expected.policyDigest || binding.projectId !== expected.projectId ||
    binding.source !== expected.source || binding.sourceKind !== expected.sourceKind ||
    binding.sourceRevisionOrContentSha256 !== expected.sourceRevision
  ) failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization');
  return binding;
}

async function prepareCandidate(
  candidate: CollectionCandidate,
  security: ReturnType<typeof createProjectSecurityService>,
  policyDigest: Sha256Digest,
  writer: ProjectSourceWriter,
  failure: HubSyncFailurePort,
): Promise<SanitizedCandidate> {
  if (candidate.sourceKind !== 'markdown' && candidate.sourceKind !== 'planning') {
    return failure.fail('SYNC_SELECTION_FAILED', 'selection');
  }
  const sourceKind = candidate.sourceKind;
  const titleSource = candidate.sourceUri;
  let titleResult;
  let bodyResult;
  try {
    [titleResult, bodyResult] = await Promise.all([
      security.prepareSource({
        body: candidate.title,
        bodyDigest: sha256(candidate.title),
        projectId: candidate.projectId,
        source: titleSource,
        sourceKind,
        sourceRevisionOrContentSha256: candidate.sourceRevision,
      }),
      security.prepareSource({
        body: candidate.body,
        bodyDigest: sha256(candidate.body),
        projectId: candidate.projectId,
        source: candidate.sourceUri,
        sourceKind,
        sourceRevisionOrContentSha256: candidate.sourceRevision,
      }),
    ]);
  } catch (cause) {
    return failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization', { cause });
  }
  if (
    !titleResult.ok || !bodyResult.ok ||
    titleResult.report.policyDigest !== policyDigest ||
    bodyResult.report.policyDigest !== policyDigest ||
    hasSuspectedSecret(titleResult.report) || hasSuspectedSecret(bodyResult.report)
  ) return failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization');

  const title = assertPrepared(inspectPreparedSource(titleResult.prepared), {
    bodyDigest: sha256(candidate.title),
    policyDigest,
    projectId: candidate.projectId,
    source: titleSource,
    sourceKind,
    sourceRevision: candidate.sourceRevision,
  }, failure);
  const body = assertPrepared(inspectPreparedSource(bodyResult.prepared), {
    bodyDigest: sha256(candidate.body),
    policyDigest,
    projectId: candidate.projectId,
    source: candidate.sourceUri,
    sourceKind,
    sourceRevision: candidate.sourceRevision,
  }, failure);
  const input: ProjectSourceInput = Object.freeze({
    body: body.approvedBody,
    ingestedAt: candidate.ingestedAt,
    producer: candidate.producer,
    sourceKind: candidate.sourceKind,
    sourceRevision: candidate.sourceRevision,
    sourceUri: candidate.sourceUri,
    target: candidate.target,
    title: title.approvedBody,
  });
  let snapshot;
  try {
    snapshot = await writer.inspect(input);
  } catch (cause) {
    return failure.fail('SYNC_TARGET_COLLISION', 'write', { cause });
  }
  return Object.freeze({
    bodyPrepared: bodyResult.prepared,
    candidate,
    input,
    report: bodyResult.report,
    snapshot,
    sourceKind,
    titlePrepared: titleResult.prepared,
  });
}

async function initialState(
  input: HubProjectSyncInput,
  revisionReader: SourceRevisionReader,
  failure: HubSyncFailurePort,
): Promise<PlannedState> {
  const knowledgeRoot = join(input.hubRoot, 'knowledge');
  let project;
  let workspace;
  let binding;
  let revision;
  try {
    project = await showProject(knowledgeRoot, input.projectId);
    workspace = await resolveProjectWorkspace(knowledgeRoot, input.projectId, { mustExist: true });
    binding = await resolveLocalProjectBinding(
      input.hubRoot,
      input.projectId,
      project.entry.sourceRepository,
    );
    revision = await revisionReader.read(binding.checkout);
  } catch (cause) {
    return failure.fail('SYNC_BINDING_FAILED', 'binding', { cause });
  }
  let loadedManifest;
  try {
    loadedManifest = await readSourceCollectionManifest(binding.checkout, input.projectId);
  } catch (cause) {
    return failure.fail('SYNC_MANIFEST_FAILED', 'manifest', { cause });
  }
  let inventory;
  try {
    inventory = await selectDeclaredSourceFiles(binding.checkout, loadedManifest);
  } catch (cause) {
    return failure.fail('SYNC_SELECTION_FAILED', 'selection', { cause });
  }
  let policyDigest;
  try {
    policyDigest = (await readSecurityPolicy(knowledgeRoot, input.projectId)).digest;
  } catch (cause) {
    return failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization', { cause });
  }
  return Object.freeze({
    binding,
    inventory,
    loadedManifest,
    policyDigest,
    projectEntryJson: serializeCanonicalJson(project.entry),
    revision,
    workspace,
  });
}

async function assertInputsUnchanged(
  input: HubProjectSyncInput,
  planned: PlannedState,
  revisionReader: SourceRevisionReader,
  prepared: readonly SanitizedCandidate[],
  writer: ProjectSourceWriter,
  failure: HubSyncFailurePort,
): Promise<void> {
  try {
    const knowledgeRoot = join(input.hubRoot, 'knowledge');
    const project = await showProject(knowledgeRoot, input.projectId);
    const workspace = await resolveProjectWorkspace(knowledgeRoot, input.projectId, {
      mustExist: true,
    });
    const binding = await resolveLocalProjectBinding(
      input.hubRoot,
      input.projectId,
      project.entry.sourceRepository,
    );
    const revision = await revisionReader.read(binding.checkout);
    const manifest = await readSourceCollectionManifest(binding.checkout, input.projectId);
    const inventory = await selectDeclaredSourceFiles(binding.checkout, manifest);
    const policy = await readSecurityPolicy(knowledgeRoot, input.projectId);
    if (
      serializeCanonicalJson(project.entry) !== planned.projectEntryJson ||
      workspace !== planned.workspace || binding.bindingDigest !== planned.binding.bindingDigest ||
      binding.sourceRepositoryDigest !== planned.binding.sourceRepositoryDigest ||
      binding.checkout.resolveRootForInternalUse() !==
        planned.binding.checkout.resolveRootForInternalUse() ||
      serializeCanonicalJson(revision) !== serializeCanonicalJson(planned.revision) ||
      manifest.manifestDigest !== planned.loadedManifest.manifestDigest ||
      serializeCanonicalJson(inventory) !== serializeCanonicalJson(planned.inventory) ||
      policy.digest !== planned.policyDigest
    ) failure.fail('SYNC_INPUT_DRIFT', 'drift');
    for (const item of prepared) await writer.assertUnchanged(item.input, item.snapshot);
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'ProjectSyncError') throw cause;
    failure.fail('SYNC_INPUT_DRIFT', 'drift', { cause });
  }
}

function collectionEntries(
  prepared: readonly SanitizedCandidate[],
  planningEntries: readonly Readonly<{
    readonly decision: string;
    readonly reasonCode: string;
    readonly sourceArtifact: string;
    readonly sourceRevision?: Sha256Digest;
    readonly target?: string;
    readonly writeStatus?: 'create' | 'unchanged' | 'update';
  }>[],
): readonly ProjectSyncPlanEntrySummary[] {
  const entries: ProjectSyncPlanEntrySummary[] = prepared.map((item) => Object.freeze({
    decision: 'include' as const,
    reasonCode: item.candidate.documentKind === 'markdown'
      ? 'selected_markdown'
      : 'selected_p2a_planning',
    security: item.report,
    sourceKind: item.candidate.sourceKind,
    sourceRef: item.candidate.sourceRef,
    sourceRevision: item.candidate.sourceRevision,
    target: item.candidate.target,
    writeStatus: item.snapshot.writeStatus,
  }));
  for (const entry of planningEntries) {
    if (entry.decision === 'include') continue;
    if (!['blocked', 'error', 'exclude', 'quarantine'].includes(entry.decision)) continue;
    entries.push(Object.freeze({
      decision: entry.decision as 'blocked' | 'error' | 'exclude' | 'quarantine',
      reasonCode: entry.reasonCode,
      sourceKind: 'planning',
      sourceRef: safePlanningRef(entry.sourceArtifact),
      sourceRevision: entry.sourceRevision ?? null,
      target: entry.target ?? null,
      writeStatus: entry.writeStatus ?? null,
    }));
  }
  return Object.freeze(entries);
}

function warningsFor(
  warnings: readonly Readonly<{
    readonly code: ProjectSyncWarning['code'];
    readonly fieldName?: string;
    readonly sourceArtifact: string;
  }>[],
): readonly ProjectSyncWarning[] {
  return Object.freeze(warnings.map((warning) => Object.freeze({
    code: warning.code,
    ...(warning.fieldName === undefined ? {} : { fieldName: warning.fieldName }),
    sourceKind: 'planning' as const,
    sourceRef: safePlanningRef(warning.sourceArtifact) ?? 'unavailable',
  })));
}

export async function runHubProjectSync(
  input: HubProjectSyncInput,
  options: HubSyncOptions,
): Promise<ProjectSyncSummary> {
  const { failure } = options;
  const revisionReader = options.sourceRevisionReader ?? createSourceRevisionReader();
  const adapter = options.collectionAdapter ?? createSourceCollectionAdapter();
  const planned = await initialState(input, revisionReader, failure);
  let collection;
  try {
    collection = await adapter.collect({
      checkout: planned.binding.checkout,
      inventory: planned.inventory,
      loadedManifest: planned.loadedManifest,
      markdownIngestedAt: planned.revision.committedAt,
    });
  } catch (cause) {
    return failure.fail('SYNC_SELECTION_FAILED', 'selection', { cause });
  }

  const knowledgeRoot = join(input.hubRoot, 'knowledge');
  const security = createProjectSecurityService({ knowledgeRoot });
  let writer;
  try {
    writer = await createProjectSourceWriter(planned.workspace, input.projectId);
  } catch (cause) {
    return failure.fail('SYNC_TARGET_COLLISION', 'write', { cause });
  }
  const prepared: SanitizedCandidate[] = [];
  for (const candidate of collection.candidates) {
    prepared.push(await prepareCandidate(
      candidate,
      security,
      planned.policyDigest,
      writer,
      failure,
    ));
  }
  const entries = collectionEntries(prepared, collection.planningEntries);
  if (entries.some((entry) =>
    entry.decision === 'blocked' || entry.decision === 'error' || entry.decision === 'quarantine')) {
    return failure.fail('SYNC_PLAN_BLOCKED', 'selection');
  }
  const digest = inventoryDigest(planned.inventory);
  const summaryBinding = Object.freeze({
    bindingDigest: planned.binding.bindingDigest,
    inventoryDigest: digest,
    manifestDigest: planned.loadedManifest.manifestDigest,
    policyDigest: planned.policyDigest,
    projectId: input.projectId,
    sourceHead: planned.revision.head,
  });
  const aggregate = planSummary(entries, summaryBinding);
  const planning = planSummary(
    entries.filter((entry) => entry.sourceKind === 'planning'),
    { ...summaryBinding, sourceKind: 'planning' },
  );
  const execution = emptyPlan(input.projectId);
  const warnings = warningsFor(collection.compatibilityWarnings);
  const common = {
    bindingDigest: planned.binding.bindingDigest,
    collection: aggregate,
    execution,
    inventoryDigest: digest,
    manifestDigest: planned.loadedManifest.manifestDigest,
    partial: warnings.length > 0,
    planning,
    projectId: input.projectId,
    schemaVersion: 'buildlore.project-sync.v1' as const,
    sourceHead: planned.revision.head,
    warnings,
  };
  if (input.dryRun) {
    return Object.freeze({
      ...common,
      appliedCount: 0,
      dryRun: true,
      remainingCount: prepared.filter((item) => item.snapshot.writeStatus !== 'unchanged').length,
      writes: Object.freeze([]),
    });
  }

  await options.hooks?.afterPlan?.();
  await options.hooks?.beforeFirstWrite?.();
  await assertInputsUnchanged(input, planned, revisionReader, prepared, writer, failure);
  const writes: ProjectSyncWriteSummary[] = [];
  for (const item of prepared) {
    try {
      const title = assertPrepared(consumePreparedSource(item.titlePrepared), {
        bodyDigest: sha256(item.candidate.title),
        policyDigest: planned.policyDigest,
        projectId: input.projectId,
        source: item.candidate.sourceUri,
        sourceKind: item.sourceKind,
        sourceRevision: item.candidate.sourceRevision,
      }, failure);
      const body = assertPrepared(consumePreparedSource(item.bodyPrepared), {
        bodyDigest: sha256(item.candidate.body),
        policyDigest: planned.policyDigest,
        projectId: input.projectId,
        source: item.candidate.sourceUri,
        sourceKind: item.sourceKind,
        sourceRevision: item.candidate.sourceRevision,
      }, failure);
      const approvedInput = Object.freeze({
        ...item.input,
        body: body.approvedBody,
        title: title.approvedBody,
      });
      const markdown = renderSourceDocument(createSourceDocument({
        body: approvedInput.body,
        ingestedAt: approvedInput.ingestedAt,
        producer: item.candidate.producer,
        projectId: input.projectId,
        source: approvedInput.sourceUri,
        sourceKind: approvedInput.sourceKind,
        sourceRevision: approvedInput.sourceRevision,
        sourceType: 'file',
        title: approvedInput.title,
      }));
      const writeStatus = await writer.write(approvedInput, markdown, item.snapshot);
      writes.push(Object.freeze({
        sourceKind: approvedInput.sourceKind,
        sourceRevision: approvedInput.sourceRevision,
        target: approvedInput.target,
        writeStatus,
      }));
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'ProjectSyncError') throw cause;
      return failure.fail('SYNC_APPLY_FAILED', 'write', {
        cause,
        completedTargets: writes.map((write) => write.target),
        partial: writes.length > 0,
        recoveryAction: 'retry-sync',
      });
    }
  }
  return Object.freeze({
    ...common,
    appliedCount: writes.filter((write) => write.writeStatus !== 'unchanged').length,
    dryRun: false,
    remainingCount: 0,
    writes: Object.freeze(writes),
  });
}
