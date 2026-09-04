import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { isNodeError } from '../knowledge/errors.js';
import {
  resolveLocalProjectBinding,
  type ResolvedLocalProjectBinding,
  type Sha256Digest,
} from '../knowledge/local-project-registry.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { showProject } from '../knowledge/workspace.js';
import {
  resolveRegisteredProfileBinding,
  type ResolvedRegisteredProfileBindingV1,
} from '../profile/preflight.js';
import {
  consumePreparedSource,
  inspectPreparedSource,
  type PreparedSourceBinding,
} from '../sanitizer/approval.js';
import { readSecurityPolicy } from '../sanitizer/policy.js';
import {
  createProjectSecurityService,
  generatedSourceFilenameKind,
  SANITIZATION_REPORT_SCHEMA_VERSION,
  SANITIZER_RULES_VERSION,
  type PreparedSource,
  type SanitizationReport,
  type SourceSecurityResult,
} from '../sanitizer/index.js';
import {
  createSourceCollectionAdapter,
  type CollectionCandidate,
  type SourceAdapterNoticeV1,
  type SourceCollectionAdapter,
} from './collection-adapters.js';
import { P2A_SOURCE_ADAPTER_ID } from './source-adapter-registry.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from './json-knowledge-adapter.js';
import {
  createP2aExecutionKnowledgeProjector,
} from './p2a-execution-projector.js';
import {
  EXECUTION_INCLUSION_POLICY_VERSION,
  EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION,
  type ExecutionKnowledgeProjectorPort,
  type ExecutionProjectionApplyResult,
  type ExecutionProjectionPlan,
} from './execution-types.js';
import { p2aArtifactRootRefs } from './p2a-source-adapter.js';
import {
  createProjectSourceWriter,
  isCollectableProjectSourceKind,
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
  ProjectSyncSanitizationDiagnostics,
  ProjectSyncSummary,
  ProjectSyncWarning,
  ProjectSyncWriteSummary,
} from './sync.js';
import {
  buildProjectSyncRedactionWarnings,
  buildProjectSyncSanitizationDiagnostics,
  type SyncSanitizationDiagnosticInput,
} from './sync-sanitization-diagnostics.js';
import {
  boundRawSourceInputsAreSafe,
  inspectRawSourceInputs,
  rawSourceInputSanitizationIsSafe,
} from './raw-source-inputs.js';

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
  readonly sanitization?: ProjectSyncSanitizationDiagnostics;
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
  readonly executionProjector?: ExecutionKnowledgeProjectorPort;
  readonly failure: HubSyncFailurePort;
  readonly hooks?: HubSyncHooks;
  readonly jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
  readonly sourceRevisionReader?: SourceRevisionReader;
}

interface PreparedCandidate {
  readonly bodyPrepared: PreparedSource;
  readonly candidate: CollectionCandidate;
  readonly input: ProjectSourceInput;
  readonly metadataPrepared?: PreparedSource;
  readonly rawPrepared?: readonly PreparedSource[];
  readonly report: SanitizationReport;
  readonly reports: readonly SanitizationReport[];
  readonly sourceKind: 'code' | 'json' | 'markdown' | 'planning' | 'text';
  readonly titlePrepared: PreparedSource;
}

interface SanitizedCandidate extends PreparedCandidate {
  readonly snapshot: ProjectSourceTargetSnapshot;
}

interface RejectedCandidate {
  readonly candidate: CollectionCandidate;
  readonly reports: readonly SanitizationReport[];
  readonly sourceKind: 'code' | 'json' | 'markdown' | 'planning' | 'text';
}

type CandidatePreparationOutcome =
  | Readonly<{ readonly ok: false; readonly rejected: RejectedCandidate }>
  | Readonly<{ readonly ok: true; readonly prepared: PreparedCandidate }>;

interface PlannedState {
  readonly binding: ResolvedLocalProjectBinding;
  readonly inventory: SourceSelectionInventory;
  readonly loadedManifest: LoadedSourceCollectionManifest;
  readonly policyDigest: Sha256Digest;
  readonly profile: ResolvedRegisteredProfileBindingV1;
  readonly projectEntryJson: string;
  readonly revision: SourceRevisionSnapshot;
  readonly workspace: string;
}

interface PlannedExecutionProjection {
  readonly artifactRoot: string;
  readonly plan: ExecutionProjectionPlan;
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

function safeExecutionRef(
  entry: ExecutionProjectionPlan['entries'][number],
): string | null {
  if (entry.taskStableId !== undefined && /^[a-f0-9]{64}$/u.test(entry.taskStableId)) {
    return entry.taskStableId;
  }
  const taskId = entry.lineage?.taskId;
  return taskId !== undefined && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(taskId)
    ? taskId
    : null;
}

function executionEntries(
  plan: ExecutionProjectionPlan,
  projectId: string,
  failure: HubSyncFailurePort,
): readonly ProjectSyncPlanEntrySummary[] {
  if (plan.schemaVersion !== EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION ||
      plan.policyVersion !== EXECUTION_INCLUSION_POLICY_VERSION ||
      plan.projectId !== projectId || !/^sha256:[a-f0-9]{64}$/u.test(plan.planFingerprint)) {
    return failure.fail('SYNC_PLAN_FAILED', 'execution-plan');
  }
  const entries = plan.entries.map((entry): ProjectSyncPlanEntrySummary => {
    if (!['blocked', 'exclude', 'include', 'quarantine'].includes(entry.decision) ||
        !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/u.test(entry.reasonCode) ||
        (entry.sourceRevision !== undefined &&
          !/^sha256:[a-f0-9]{64}$/u.test(entry.sourceRevision)) ||
        (entry.taskStableId !== undefined && !/^[a-f0-9]{64}$/u.test(entry.taskStableId)) ||
        (entry.target !== undefined && generatedSourceFilenameKind(entry.target) !== 'execution') ||
        (entry.writeStatus !== undefined &&
          !['create', 'unchanged', 'update'].includes(entry.writeStatus)) ||
        (entry.decision === 'include' && (
          entry.sourceRevision === undefined || entry.target === undefined ||
          entry.taskStableId === undefined || entry.writeStatus === undefined
        )) ||
        (entry.security !== undefined && (
          entry.security.schemaVersion !== SANITIZATION_REPORT_SCHEMA_VERSION ||
          entry.security.rulesVersion !== SANITIZER_RULES_VERSION ||
          entry.security.projectId !== projectId
        ))) {
      return failure.fail('SYNC_PLAN_FAILED', 'execution-plan');
    }
    return Object.freeze({
      decision: entry.decision,
      reasonCode: entry.reasonCode,
      ...(entry.security === undefined ? {} : { security: entry.security }),
      sourceKind: 'execution',
      sourceRef: safeExecutionRef(entry),
      sourceRevision: entry.sourceRevision ?? null,
      target: entry.target ?? null,
      writeStatus: entry.writeStatus ?? null,
    });
  });
  const counts = countsFor(entries);
  if (counts.error !== 0 || plan.counts.blocked !== counts.blocked ||
      plan.counts.exclude !== counts.exclude || plan.counts.include !== counts.include ||
      plan.counts.quarantine !== counts.quarantine) {
    return failure.fail('SYNC_PLAN_FAILED', 'execution-plan');
  }
  return Object.freeze(entries);
}

async function hasExecutionInventory(
  artifactRoot: string,
  failure: HubSyncFailurePort,
): Promise<boolean> {
  const runsRoot = join(artifactRoot, 'runs');
  try {
    const [status, canonical] = await Promise.all([lstat(runsRoot), realpath(runsRoot)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== runsRoot) {
      return failure.fail('SYNC_SELECTION_FAILED', 'selection');
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    return failure.fail('SYNC_SELECTION_FAILED', 'selection');
  }
}

async function planRegisteredExecutions(input: {
  readonly failure: HubSyncFailurePort;
  readonly knowledgeRoot: string;
  readonly planned: PlannedState;
  readonly projectId: string;
  readonly projector: ExecutionKnowledgeProjectorPort;
}): Promise<readonly PlannedExecutionProjection[]> {
  const p2aFiles = input.planned.inventory.files.filter((file) =>
    file.adapterId === P2A_SOURCE_ADAPTER_ID || file.documentKind === 'p2a-planning');
  if (p2aFiles.length === 0) return Object.freeze([]);
  try {
    input.planned.profile.sourceAdapters.resolve({
      adapterId: P2A_SOURCE_ADAPTER_ID,
      adapterVersion: 1,
      kind: 'execution',
    });
  } catch (cause) {
    return input.failure.fail('SYNC_SELECTION_FAILED', 'selection', { cause });
  }
  let rootRefs: readonly string[];
  try {
    rootRefs = p2aArtifactRootRefs(p2aFiles);
  } catch (cause) {
    return input.failure.fail('SYNC_SELECTION_FAILED', 'selection', { cause });
  }
  const sourceRoot = input.planned.binding.checkout.resolveRootForInternalUse();
  const results: PlannedExecutionProjection[] = [];
  for (const rootRef of rootRefs) {
    const artifactRoot = rootRef === '.'
      ? sourceRoot
      : join(sourceRoot, ...rootRef.split('/'));
    if (!await hasExecutionInventory(artifactRoot, input.failure)) continue;
    try {
      results.push(Object.freeze({
        artifactRoot,
        plan: await input.projector.plan({
          artifactRoot,
          knowledgeRoot: input.knowledgeRoot,
          projectId: input.projectId,
        }),
      }));
    } catch (cause) {
      return input.failure.fail('SYNC_PLAN_FAILED', 'execution-plan', { cause });
    }
  }
  return Object.freeze(results);
}

function validateExecutionTargets(
  collectionEntriesInput: readonly ProjectSyncPlanEntrySummary[],
  executionEntriesInput: readonly ProjectSyncPlanEntrySummary[],
  failure: HubSyncFailurePort,
): void {
  const targets = new Set(collectionEntriesInput
    .filter((entry) => entry.decision === 'include' && entry.target !== null)
    .map((entry) => entry.target));
  for (const entry of executionEntriesInput) {
    if (entry.decision !== 'include' || entry.target === null) continue;
    if (targets.has(entry.target)) return failure.fail('SYNC_TARGET_COLLISION', 'execution-plan');
    targets.add(entry.target);
  }
}

function executionWriteSummaries(
  result: ExecutionProjectionApplyResult,
  plan: ExecutionProjectionPlan,
  projectId: string,
  completedTargets: readonly string[],
  failure: HubSyncFailurePort,
): readonly ProjectSyncWriteSummary[] {
  const plannedWrites = new Map(plan.entries
    .filter((entry) => entry.decision === 'include' && entry.target !== undefined)
    .map((entry) => [entry.target, entry] as const));
  const seenTargets = new Set<string>();
  let invalid = result.projectId !== projectId ||
    result.planFingerprint !== plan.planFingerprint;
  for (const write of result.writes) {
    const planned = plannedWrites.get(write.target);
    if (!/^sha256:[a-f0-9]{64}$/u.test(write.sourceRevision) ||
        !/^[a-f0-9]{64}$/u.test(write.taskStableId) ||
        generatedSourceFilenameKind(write.target) !== 'execution' ||
        !['create', 'unchanged', 'update'].includes(write.writeStatus) ||
        planned === undefined || planned.sourceRevision !== write.sourceRevision ||
        planned.taskStableId !== write.taskStableId || planned.writeStatus !== write.writeStatus ||
        seenTargets.has(write.target)) {
      invalid = true;
    }
    seenTargets.add(write.target);
  }
  if (seenTargets.size !== plannedWrites.size) invalid = true;
  if (invalid) {
    return failure.fail('SYNC_APPLY_FAILED', 'execution-apply', {
      completedTargets,
      partial: completedTargets.length > 0,
      recoveryAction: 'retry-sync',
    });
  }
  return Object.freeze(result.writes.map((write) => Object.freeze({
    sourceKind: 'execution' as const,
    sourceRevision: write.sourceRevision,
    target: write.target,
    writeStatus: write.writeStatus,
  })));
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

function reportAllowsPreparedSource(
  report: SanitizationReport,
  expected: {
    readonly bodyDigest: Sha256Digest;
    readonly policyDigest: Sha256Digest;
    readonly projectId: string;
    readonly sourceIdentitySha256: string;
  },
): boolean {
  return report.schemaVersion === SANITIZATION_REPORT_SCHEMA_VERSION &&
    report.rulesVersion === SANITIZER_RULES_VERSION && report.decision === 'include' &&
    report.findingsOverflow === false && report.inputDigest === expected.bodyDigest &&
    report.policyDigest === expected.policyDigest && report.projectId === expected.projectId &&
    report.sourceIdentitySha256 === expected.sourceIdentitySha256 &&
    report.summaries.every((summary) =>
      ['block', 'quarantine', 'redact'].includes(summary.action) &&
      Number.isSafeInteger(summary.count) && summary.count > 0 &&
      Number.isSafeInteger(summary.overriddenCount) && summary.overriddenCount >= 0 &&
      summary.overriddenCount <= summary.count &&
      /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(summary.ruleId) &&
      (summary.action === 'redact' || summary.count === summary.overriddenCount));
}

function validatedPreparedResult(
  result: SourceSecurityResult,
  expected: {
    readonly bodyDigest: Sha256Digest;
    readonly policyDigest: Sha256Digest;
    readonly projectId: string;
    readonly source: string;
    readonly sourceKind: 'code' | 'json' | 'markdown' | 'planning' | 'text';
    readonly sourceRevision: Sha256Digest;
  },
): PreparedSourceBinding | null {
  if (!result.ok) return null;
  const sourceIdentitySha256 = sha256(expected.source).slice('sha256:'.length);
  if (!reportAllowsPreparedSource(result.report, {
    bodyDigest: expected.bodyDigest,
    policyDigest: expected.policyDigest,
    projectId: expected.projectId,
    sourceIdentitySha256,
  })) return null;
  const binding = inspectPreparedSource(result.prepared);
  if (
    binding === null || binding.inputBodyDigest !== expected.bodyDigest ||
    binding.policyDigest !== expected.policyDigest || binding.projectId !== expected.projectId ||
    binding.rulesVersion !== SANITIZER_RULES_VERSION ||
    binding.source !== expected.source || binding.sourceKind !== expected.sourceKind ||
    binding.sourceRevisionOrContentSha256 !== expected.sourceRevision ||
    binding.approvedBodyDigest !== result.report.outputDigest ||
    binding.classification !== result.report.classification ||
    sha256(binding.approvedBody) !== binding.approvedBodyDigest
  ) return null;
  return binding;
}

function assertPrepared(
  binding: PreparedSourceBinding | null,
  expected: {
    readonly bodyDigest: Sha256Digest;
    readonly policyDigest: Sha256Digest;
    readonly projectId: string;
    readonly source: string;
    readonly sourceKind: 'code' | 'json' | 'markdown' | 'planning' | 'text';
    readonly sourceRevision: Sha256Digest;
  },
  failure: HubSyncFailurePort,
): PreparedSourceBinding {
  if (
    binding === null || binding.inputBodyDigest !== expected.bodyDigest ||
    binding.policyDigest !== expected.policyDigest || binding.projectId !== expected.projectId ||
    binding.rulesVersion !== SANITIZER_RULES_VERSION ||
    binding.source !== expected.source || binding.sourceKind !== expected.sourceKind ||
    binding.sourceRevisionOrContentSha256 !== expected.sourceRevision
  ) failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization');
  return binding;
}

async function prepareCandidate(
  candidate: CollectionCandidate,
  security: ReturnType<typeof createProjectSecurityService>,
  policyDigest: Sha256Digest,
  failure: HubSyncFailurePort,
): Promise<CandidatePreparationOutcome> {
  if (!isCollectableProjectSourceKind(candidate.sourceKind)) {
    return failure.fail('SYNC_SELECTION_FAILED', 'selection');
  }
  const sourceKind = candidate.sourceKind;
  const titleSource = candidate.sourceUri;
  const metadataBody = candidate.descriptor?.metadata === undefined
    ? null
    : serializeCanonicalJson(candidate.descriptor.metadata);
  const requests = [
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
  ];
  if (metadataBody !== null) {
    requests.push(security.prepareSource({
      body: metadataBody,
      bodyDigest: sha256(metadataBody),
      projectId: candidate.projectId,
      source: candidate.sourceUri,
      sourceKind,
      sourceRevisionOrContentSha256: candidate.sourceRevision,
    }));
  }
  const rawInputs = inspectRawSourceInputs(candidate);
  for (const rawInput of rawInputs) {
    requests.push(security.prepareSource({
      body: rawInput.body,
      bodyDigest: sha256(rawInput.body),
      projectId: candidate.projectId,
      source: candidate.sourceUri,
      sourceKind,
      sourceRevisionOrContentSha256: candidate.sourceRevision,
    }));
  }
  const settled = await Promise.allSettled(requests);
  const reports = settled.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? [outcome.value.report] : []);
  const titleResult = settled[0];
  const bodyResult = settled[1];
  const metadataResult = settled[2];
  const rawResultOffset = metadataBody === null ? 2 : 3;
  const rawResults = settled.slice(rawResultOffset);
  if (
    titleResult?.status !== 'fulfilled' || bodyResult?.status !== 'fulfilled' ||
    (metadataBody !== null && metadataResult?.status !== 'fulfilled') ||
    rawResults.some((result) => result.status !== 'fulfilled')
  ) {
    return Object.freeze({
      ok: false as const,
      rejected: Object.freeze({ candidate, reports: Object.freeze(reports), sourceKind }),
    });
  }
  const title = validatedPreparedResult(titleResult.value, {
    bodyDigest: sha256(candidate.title),
    policyDigest,
    projectId: candidate.projectId,
    source: titleSource,
    sourceKind,
    sourceRevision: candidate.sourceRevision,
  });
  const body = validatedPreparedResult(bodyResult.value, {
    bodyDigest: sha256(candidate.body),
    policyDigest,
    projectId: candidate.projectId,
    source: candidate.sourceUri,
    sourceKind,
    sourceRevision: candidate.sourceRevision,
  });
  const metadata = metadataBody === null || metadataResult?.status !== 'fulfilled'
    ? null
    : validatedPreparedResult(metadataResult.value, {
        bodyDigest: sha256(metadataBody),
        policyDigest,
        projectId: candidate.projectId,
        source: candidate.sourceUri,
        sourceKind,
        sourceRevision: candidate.sourceRevision,
      });
  const metadataIsSafe = metadataBody === null || (
    metadata !== null && metadataResult?.status === 'fulfilled' && metadataResult.value.ok &&
    metadata.approvedBody === metadataBody && metadataResult.value.report.summaries.length === 0
  );
  const rawBindings = rawResults.map((result, index) => {
    if (result.status !== 'fulfilled') return null;
    const rawInput = rawInputs[index];
    if (rawInput === undefined) return null;
    return validatedPreparedResult(result.value, {
      bodyDigest: sha256(rawInput.body),
      policyDigest,
      projectId: candidate.projectId,
      source: candidate.sourceUri,
      sourceKind,
      sourceRevision: candidate.sourceRevision,
    });
  });
  const rawInputsAreSafe = rawBindings.every((binding, index) =>
    binding !== null && rawInputs[index] !== undefined &&
    rawResults[index]?.status === 'fulfilled' && rawResults[index].value.ok &&
    rawSourceInputSanitizationIsSafe(
      rawInputs[index],
      binding.approvedBody,
      rawResults[index].value.report.summaries,
    ));
  if (
    title === null || body === null || !titleResult.value.ok || !bodyResult.value.ok ||
    !metadataIsSafe || !rawInputsAreSafe
  ) {
    return Object.freeze({
      ok: false as const,
      rejected: Object.freeze({ candidate, reports: Object.freeze(reports), sourceKind }),
    });
  }
  const input: ProjectSourceInput = Object.freeze({
    body: body.approvedBody,
    ...(candidate.descriptor === undefined ? {} : { descriptor: candidate.descriptor }),
    ingestedAt: candidate.ingestedAt,
    ...(candidate.originMappings === undefined
      ? {}
      : { originMappings: candidate.originMappings }),
    ...(candidate.jsonOrigins === undefined ? {} : { jsonOrigins: candidate.jsonOrigins }),
    producer: candidate.producer,
    sourceKind: candidate.sourceKind,
    sourceRevision: candidate.sourceRevision,
    sourceUri: candidate.sourceUri,
    target: candidate.target,
    title: title.approvedBody,
  });
  return Object.freeze({
    ok: true as const,
    prepared: Object.freeze({
      bodyPrepared: bodyResult.value.prepared,
      candidate,
      input,
      ...(metadataBody === null || metadataResult?.status !== 'fulfilled' || !metadataResult.value.ok
        ? {}
        : { metadataPrepared: metadataResult.value.prepared }),
      ...(rawInputs.length === 0
        ? {}
        : { rawPrepared: Object.freeze(rawResults.flatMap((result) =>
            result.status === 'fulfilled' && result.value.ok ? [result.value.prepared] : [])) }),
      report: bodyResult.value.report,
      reports: Object.freeze([
        titleResult.value.report,
        bodyResult.value.report,
        ...(metadataResult?.status === 'fulfilled' ? [metadataResult.value.report] : []),
        ...rawResults.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value.report] : []),
      ]),
      sourceKind,
      titlePrepared: titleResult.value.prepared,
    }),
  });
}

async function initialState(
  input: HubProjectSyncInput,
  revisionReader: SourceRevisionReader,
  failure: HubSyncFailurePort,
  jsonKnowledgeAdapters: readonly RegisteredJsonKnowledgeAdapterV1[] = [],
): Promise<PlannedState> {
  const knowledgeRoot = join(input.hubRoot, 'knowledge');
  let project;
  let workspace;
  let binding;
  let profile;
  let revision;
  try {
    project = await showProject(knowledgeRoot, input.projectId);
    workspace = await resolveProjectWorkspace(knowledgeRoot, input.projectId, { mustExist: true });
    binding = await resolveLocalProjectBinding(
      input.hubRoot,
      input.projectId,
      project.entry.sourceRepository,
    );
    profile = await resolveRegisteredProfileBinding(knowledgeRoot, input.projectId, {
      registrations: jsonKnowledgeAdapters,
    });
    revision = await revisionReader.read(binding.checkout);
  } catch (cause) {
    return failure.fail('SYNC_BINDING_FAILED', 'binding', { cause });
  }
  let loadedManifest;
  try {
    loadedManifest = await readSourceCollectionManifest(binding.checkout, input.projectId, {
      sourceAdapterRegistry: profile.sourceAdapters,
    });
  } catch (cause) {
    return failure.fail('SYNC_MANIFEST_FAILED', 'manifest', { cause });
  }
  let inventory;
  try {
    inventory = await selectDeclaredSourceFiles(binding.checkout, loadedManifest, {
      sourceAdapterRegistry: profile.sourceAdapters,
    });
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
    profile,
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
  jsonKnowledgeAdapters: readonly RegisteredJsonKnowledgeAdapterV1[] = [],
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
    const profile = await resolveRegisteredProfileBinding(knowledgeRoot, input.projectId, {
      registrations: jsonKnowledgeAdapters,
    });
    const manifest = await readSourceCollectionManifest(binding.checkout, input.projectId, {
      sourceAdapterRegistry: profile.sourceAdapters,
    });
    const inventory = await selectDeclaredSourceFiles(binding.checkout, manifest, {
      sourceAdapterRegistry: profile.sourceAdapters,
    });
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
      policy.digest !== planned.policyDigest || profile.bindingDigest !== planned.profile.bindingDigest
    ) failure.fail('SYNC_INPUT_DRIFT', 'drift');
    for (const item of prepared) await writer.assertUnchanged(item.input, item.snapshot);
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'ProjectSyncError') throw cause;
    failure.fail('SYNC_INPUT_DRIFT', 'drift', { cause });
  }
}

function collectionEntries(
  prepared: readonly SanitizedCandidate[],
  adapterEntries: readonly Readonly<{
    readonly adapterId: string;
    readonly decision: string;
    readonly reasonCode: string;
    readonly sourceRef: string;
    readonly sourceRevision?: Sha256Digest;
    readonly target?: string;
    readonly writeStatus?: 'create' | 'unchanged' | 'update';
  }>[],
  inventory: SourceSelectionInventory,
  failure: HubSyncFailurePort,
): readonly ProjectSyncPlanEntrySummary[] {
  const entries: ProjectSyncPlanEntrySummary[] = prepared.map((item) => Object.freeze({
    decision: 'include' as const,
    reasonCode: item.candidate.documentKind === 'p2a-planning'
      ? 'selected_p2a_planning'
      : `selected_${item.candidate.documentKind}`,
    security: item.report,
    sourceKind: item.candidate.sourceKind,
    sourceRef: item.candidate.sourceRef,
    sourceRevision: item.candidate.sourceRevision,
    target: item.candidate.target,
    writeStatus: item.snapshot.writeStatus,
  }));
  for (const entry of adapterEntries) {
    if (entry.decision === 'include') continue;
    if (!['blocked', 'error', 'exclude', 'quarantine'].includes(entry.decision)) continue;
    const selected = entry.adapterId === P2A_SOURCE_ADAPTER_ID
      ? undefined
      : inventory.files.find((file) =>
          file.adapterId === entry.adapterId && file.sourceRef === entry.sourceRef);
    if (entry.adapterId !== P2A_SOURCE_ADAPTER_ID && selected?.kind === undefined) {
      return failure.fail('SYNC_SELECTION_FAILED', 'selection');
    }
    entries.push(Object.freeze({
      decision: entry.decision as 'blocked' | 'error' | 'exclude' | 'quarantine',
      reasonCode: entry.reasonCode,
      sourceKind: entry.adapterId === P2A_SOURCE_ADAPTER_ID
        ? 'planning'
        : selected?.kind ?? 'json',
      sourceRef: safePlanningRef(entry.sourceRef),
      sourceRevision: entry.sourceRevision ?? null,
      target: entry.target ?? null,
      writeStatus: entry.writeStatus ?? null,
    }));
  }
  return Object.freeze(entries);
}

function warningsFor(
  warnings: readonly SourceAdapterNoticeV1[],
  failure: HubSyncFailurePort,
): readonly ProjectSyncWarning[] {
  const allowed = new Set([
    'p2a-additive-field-ignored',
    'p2a-compatibility-warning-overflow',
    'p2a-document-compatibility-excluded',
  ]);
  return Object.freeze(warnings.map((warning) => {
    if (warning.adapterId !== P2A_SOURCE_ADAPTER_ID || !allowed.has(warning.code)) {
      return failure.fail('SYNC_SELECTION_FAILED', 'selection');
    }
    return Object.freeze({
      code: warning.code as Extract<
        ProjectSyncWarning,
        { readonly sourceKind: 'planning' }
      >['code'],
      ...(warning.fieldName === undefined ? {} : { fieldName: warning.fieldName }),
      sourceKind: 'planning' as const,
      sourceRef: safePlanningRef(warning.sourceRef) ?? 'unavailable',
    });
  }));
}

function warningSortKey(warning: ProjectSyncWarning): string {
  return warning.code === 'sanitization-redaction-applied'
    ? `${warning.code}\u0000${warning.ruleId}`
    : `${warning.code}\u0000${warning.sourceRef}\u0000${warning.fieldName ?? ''}`;
}

export async function runHubProjectSync(
  input: HubProjectSyncInput,
  options: HubSyncOptions,
): Promise<ProjectSyncSummary> {
  const { failure } = options;
  const revisionReader = options.sourceRevisionReader ?? createSourceRevisionReader();
  const adapter = options.collectionAdapter ?? createSourceCollectionAdapter({
    ...(options.jsonKnowledgeAdapters === undefined
      ? {}
      : { jsonKnowledgeAdapters: options.jsonKnowledgeAdapters }),
  });
  const executionProjector = options.executionProjector ??
    createP2aExecutionKnowledgeProjector();
  const planned = await initialState(
    input,
    revisionReader,
    failure,
    options.jsonKnowledgeAdapters,
  );
  let collection;
  try {
    collection = await adapter.collect({
      checkout: planned.binding.checkout,
      ingestedAt: planned.revision.committedAt,
      inventory: planned.inventory,
      loadedManifest: planned.loadedManifest,
      sourceAdapterRegistry: planned.profile.sourceAdapters,
    });
  } catch (cause) {
    return failure.fail('SYNC_SELECTION_FAILED', 'selection', { cause });
  }

  const knowledgeRoot = join(input.hubRoot, 'knowledge');
  const security = createProjectSecurityService({ knowledgeRoot });
  if (!await boundRawSourceInputsAreSafe(collection, {
    policyDigest: planned.policyDigest,
    projectId: input.projectId,
    security,
    source: `buildlore://project/${input.projectId}/selected-json-inputs`,
    sourceKind: 'json',
    sourceRevision: planned.loadedManifest.manifestDigest,
  })) {
    return failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization');
  }
  let writer;
  try {
    writer = await createProjectSourceWriter(planned.workspace, input.projectId);
  } catch (cause) {
    return failure.fail('SYNC_TARGET_COLLISION', 'write', { cause });
  }
  const preparedWithoutSnapshots: PreparedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  for (const candidate of collection.candidates) {
    const outcome = await prepareCandidate(
      candidate,
      security,
      planned.policyDigest,
      failure,
    );
    if (outcome.ok) preparedWithoutSnapshots.push(outcome.prepared);
    else rejected.push(outcome.rejected);
  }
  if (rejected.length > 0) {
    const diagnosticInputs: SyncSanitizationDiagnosticInput[] = rejected.map((item) => ({
      reports: item.reports,
      sourceIdentitySha256: sha256(item.candidate.sourceUri).slice('sha256:'.length),
      sourceKind: item.sourceKind,
      sourceRef: item.candidate.sourceRef,
    }));
    return failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization', {
      sanitization: buildProjectSyncSanitizationDiagnostics(diagnosticInputs),
    });
  }
  const prepared: SanitizedCandidate[] = [];
  for (const item of preparedWithoutSnapshots) {
    let snapshot;
    try {
      snapshot = await writer.inspect(item.input);
    } catch (cause) {
      return failure.fail('SYNC_TARGET_COLLISION', 'write', { cause });
    }
    prepared.push(Object.freeze({ ...item, snapshot }));
  }
  const entries = collectionEntries(prepared, collection.entries, planned.inventory, failure);
  if (entries.some((entry) =>
    entry.decision === 'blocked' || entry.decision === 'error' || entry.decision === 'quarantine')) {
    return failure.fail('SYNC_PLAN_BLOCKED', 'selection');
  }
  const plannedExecutions = await planRegisteredExecutions({
    failure,
    knowledgeRoot,
    planned,
    projectId: input.projectId,
    projector: executionProjector,
  });
  const executionEntriesInput = Object.freeze(plannedExecutions.flatMap((execution) =>
    executionEntries(execution.plan, input.projectId, failure)));
  if (executionEntriesInput.some((entry) =>
    entry.decision === 'blocked' || entry.decision === 'error' || entry.decision === 'quarantine')) {
    return failure.fail('SYNC_PLAN_BLOCKED', 'execution-plan');
  }
  validateExecutionTargets(entries, executionEntriesInput, failure);
  const digest = inventoryDigest(planned.inventory);
  const summaryBinding = Object.freeze({
    bindingDigest: planned.binding.bindingDigest,
    inventoryDigest: digest,
    manifestDigest: planned.loadedManifest.manifestDigest,
    policyDigest: planned.policyDigest,
    profileBindingDigest: planned.profile.bindingDigest,
    projectId: input.projectId,
    sourceHead: planned.revision.head,
  });
  const aggregate = planSummary(entries, summaryBinding);
  const planning = planSummary(
    entries.filter((entry) => entry.sourceKind === 'planning'),
    { ...summaryBinding, sourceKind: 'planning' },
  );
  const execution = plannedExecutions.length === 0
    ? emptyPlan(input.projectId)
    : planSummary(executionEntriesInput, {
        ...summaryBinding,
        planFingerprints: plannedExecutions.map((item) => item.plan.planFingerprint),
        sourceKind: 'execution',
      });
  const redactionWarnings = buildProjectSyncRedactionWarnings(prepared.map((item) => ({
    reports: item.reports,
    sourceIdentitySha256: sha256(item.candidate.sourceUri).slice('sha256:'.length),
    sourceKind: item.sourceKind,
    sourceRef: item.candidate.sourceRef,
  })));
  if (redactionWarnings === null) {
    return failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization');
  }
  const warnings = Object.freeze([
    ...warningsFor(collection.notices, failure),
    ...redactionWarnings,
  ].sort((left, right) => compareText(warningSortKey(left), warningSortKey(right))));
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
      remainingCount: prepared.filter((item) => item.snapshot.writeStatus !== 'unchanged').length +
        execution.entries.filter((entry) => entry.decision === 'include' &&
          entry.writeStatus !== 'unchanged').length,
      writes: Object.freeze([]),
    });
  }

  await options.hooks?.afterPlan?.();
  await options.hooks?.beforeFirstWrite?.();
  await assertInputsUnchanged(
    input,
    planned,
    revisionReader,
    prepared,
    writer,
    failure,
    options.jsonKnowledgeAdapters,
  );
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
      const metadataBody = item.candidate.descriptor?.metadata === undefined
        ? null
        : serializeCanonicalJson(item.candidate.descriptor.metadata);
      if (metadataBody !== null) {
        const metadata = assertPrepared(
          item.metadataPrepared === undefined ? null : consumePreparedSource(item.metadataPrepared),
          {
            bodyDigest: sha256(metadataBody),
            policyDigest: planned.policyDigest,
            projectId: input.projectId,
            source: item.candidate.sourceUri,
            sourceKind: item.sourceKind,
            sourceRevision: item.candidate.sourceRevision,
          },
          failure,
        );
        if (metadata.approvedBody !== metadataBody) {
          failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization');
        }
      }
      const rawInputs = inspectRawSourceInputs(item.candidate);
      if ((item.rawPrepared?.length ?? 0) !== rawInputs.length) {
        failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization');
      }
      for (const [index, rawInput] of rawInputs.entries()) {
        const raw = assertPrepared(
          item.rawPrepared?.[index] === undefined
            ? null
            : consumePreparedSource(item.rawPrepared[index]),
          {
            bodyDigest: sha256(rawInput.body),
            policyDigest: planned.policyDigest,
            projectId: input.projectId,
            source: item.candidate.sourceUri,
            sourceKind: item.sourceKind,
            sourceRevision: item.candidate.sourceRevision,
          },
          failure,
        );
        if (rawInput.allowedRedactionRuleIds.length === 0 && raw.approvedBody !== rawInput.body) {
          failure.fail('SYNC_SANITIZATION_FAILED', 'sanitization');
        }
      }
      const approvedInput = Object.freeze({
        ...item.input,
        body: body.approvedBody,
        title: title.approvedBody,
      });
      const markdown = renderSourceDocument(createSourceDocument({
        body: approvedInput.body,
        ...(approvedInput.descriptor === undefined
          ? {}
          : { descriptor: approvedInput.descriptor }),
        ingestedAt: approvedInput.ingestedAt,
        ...(approvedInput.originMappings === undefined
          ? {}
          : { originMappings: approvedInput.originMappings }),
        ...(approvedInput.jsonOrigins === undefined
          ? {}
          : { jsonOrigins: approvedInput.jsonOrigins }),
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
  for (const execution of plannedExecutions) {
    let applied: ExecutionProjectionApplyResult;
    try {
      applied = await executionProjector.apply(execution.plan);
    } catch (cause) {
      return failure.fail('SYNC_APPLY_FAILED', 'execution-apply', {
        cause,
        completedTargets: writes.map((write) => write.target),
        partial: writes.length > 0,
        recoveryAction: 'retry-sync',
      });
    }
    writes.push(...executionWriteSummaries(
      applied,
      execution.plan,
      input.projectId,
      writes.map((write) => write.target),
      failure,
    ));
  }
  return Object.freeze({
    ...common,
    appliedCount: writes.filter((write) => write.writeStatus !== 'unchanged').length,
    dryRun: false,
    remainingCount: 0,
    writes: Object.freeze(writes),
  });
}
