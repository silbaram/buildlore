import { createHash } from 'node:crypto';

import { resolveProjectWorkspace, showProject } from '../knowledge/index.js';
import {
  consumePreparedSource,
  inspectPreparedSource,
  type PreparedSourceBinding,
} from '../sanitizer/approval.js';
import {
  createProjectSecurityService,
  readSecurityPolicy,
  SANITIZER_RULES_VERSION,
  type PreparedSource,
  type SanitizationReport,
} from '../sanitizer/index.js';
import { ProjectionError } from './errors.js';
import type {
  CreateP2aExecutionProjectorOptions,
  ExecutionCandidate,
  ExecutionKnowledgeProjectorPort,
  ExecutionProjectionApplyResult,
  ExecutionProjectionInput,
  ExecutionProjectionPlan,
  ExecutionProjectionPlanEntry,
  P2aExecutionSelection,
} from './execution-types.js';
import {
  EXECUTION_INCLUSION_POLICY_VERSION,
  EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION,
} from './execution-types.js';
import { createP2aExecutionArtifactAdapter } from './p2a-execution-artifacts.js';
import { canonicalExecutionJson } from './p2a-execution-codecs.js';
import {
  createProjectSourceWriter,
  type ProjectSourceInput,
  type ProjectSourceTargetSnapshot,
  type ProjectSourceWriter,
} from './project-source-writer.js';
import { createSourceDocument, renderSourceDocument } from './source-document.js';
import { validateP2aSourceIdentity } from './source-identity.js';

interface PlannedCandidate {
  readonly input: ProjectSourceInput;
  readonly prepared: PreparedSource;
  readonly report: SanitizationReport;
  readonly source: ExecutionCandidate;
  readonly targetSnapshot: ProjectSourceTargetSnapshot;
}

interface PrivatePlan {
  readonly input: ExecutionProjectionInput;
  readonly planned: readonly PlannedCandidate[];
  readonly policyDigest: `sha256:${string}`;
  readonly repository: string;
  readonly selection: P2aExecutionSelection;
  readonly writer: ProjectSourceWriter;
}

const privatePlans = new WeakMap<ExecutionProjectionPlan, PrivatePlan>();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(
  code: ConstructorParameters<typeof ProjectionError>[0],
  message: string,
): never {
  throw new ProjectionError(code, message);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function securityPayload(source: ExecutionCandidate): string {
  return `${source.title}\n${source.body}`;
}

function approvedInput(candidate: ExecutionCandidate, prepared: PreparedSource): ProjectSourceInput {
  const binding = inspectPreparedSource(prepared);
  if (binding === null) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A prepared execution source is unavailable.');
  }
  const separator = binding.approvedBody.indexOf('\n');
  if (separator < 1) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A prepared execution source is invalid.');
  }
  return {
    body: binding.approvedBody.slice(separator + 1),
    ingestedAt: candidate.ingestedAt,
    producer: 'p2a',
    sourceKind: 'execution',
    sourceRevision: candidate.sourceRevision,
    sourceUri: candidate.sourceUri,
    target: candidate.target,
    title: binding.approvedBody.slice(0, separator),
  };
}

function assertSelectionConsistency(
  selection: P2aExecutionSelection,
  projectId: string,
  repository: string,
): void {
  const included = selection.entries.filter((entry) => entry.decision === 'include');
  const entriesBySource = new Map<string, ExecutionProjectionPlanEntry>();
  for (const entry of included) {
    if (entry.sourceUri === undefined || entriesBySource.has(entry.sourceUri)) {
      fail('PROJECTION_ARTIFACT_INVALID', 'Execution selection is inconsistent.');
    }
    entriesBySource.set(entry.sourceUri, entry);
  }
  const seenTargets = new Set<string>();
  for (const candidate of selection.candidates) {
    const entry = entriesBySource.get(candidate.sourceUri);
    const attempts = candidate.attempts.map((attempt) => ({
      runId: attempt.runId,
      runRef: attempt.runRef,
      runRevision: attempt.runRevision,
      status: attempt.status,
    }));
    if (entry === undefined || seenTargets.has(candidate.target) ||
        validateP2aSourceIdentity({
          artifactPath: candidate.lineage.graphRef,
          iterationId: candidate.lineage.iterationId,
          projectId,
          repository,
          source: candidate.sourceUri,
          sourceKind: 'execution',
          taskContractSha256: candidate.lineage.taskContractSha256,
          taskId: candidate.lineage.taskId,
        }) === null ||
        entry.reasonCode !== candidate.reasonCode || entry.sourceRevision !== candidate.sourceRevision ||
        entry.target !== candidate.target || entry.taskStableId !== candidate.taskStableId ||
        canonicalExecutionJson(entry.lineage) !== canonicalExecutionJson(candidate.lineage) ||
        canonicalExecutionJson(entry.attempts) !== canonicalExecutionJson(attempts)) {
      fail('PROJECTION_ARTIFACT_INVALID', 'Execution selection is inconsistent.');
    }
    entriesBySource.delete(candidate.sourceUri);
    seenTargets.add(candidate.target);
  }
  if (entriesBySource.size !== 0) fail('PROJECTION_ARTIFACT_INVALID', 'Execution selection is inconsistent.');
}

async function resolveApplyProjectState(
  knowledgeRoot: string,
  projectId: string,
): Promise<Readonly<{ repository: string; workspace: string }>> {
  try {
    const project = await showProject(knowledgeRoot, projectId);
    const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
    return { repository: project.entry.sourceRepository, workspace };
  } catch {
    return fail('PROJECTION_ARTIFACT_CHANGED', 'Project metadata changed after planning.');
  }
}

async function assertTargetsUnchanged(
  writer: ProjectSourceWriter,
  planned: readonly PlannedCandidate[],
): Promise<void> {
  try {
    for (const item of planned) await writer.assertUnchanged(item.input, item.targetSnapshot);
  } catch {
    fail('PROJECTION_ARTIFACT_CHANGED', 'A source target changed after planning.');
  }
}

function freezePlan(
  projectId: string,
  entries: readonly ExecutionProjectionPlanEntry[],
  planned: readonly PlannedCandidate[],
  bindings: readonly Readonly<{ relativePath: string; revision: `sha256:${string}` }>[],
): ExecutionProjectionPlan {
  const sorted = [...entries].sort((left, right) => compareText(
    left.attempts[0]?.runRef ?? left.sourceUri ?? '',
    right.attempts[0]?.runRef ?? right.sourceUri ?? '',
  ));
  const counts = {
    blocked: sorted.filter((entry) => entry.decision === 'blocked').length,
    exclude: sorted.filter((entry) => entry.decision === 'exclude').length,
    include: sorted.filter((entry) => entry.decision === 'include').length,
    quarantine: sorted.filter((entry) => entry.decision === 'quarantine').length,
  } as const;
  const planFingerprint = sha256(canonicalExecutionJson({
    bindings,
    counts,
    entries: sorted,
    policyVersion: EXECUTION_INCLUSION_POLICY_VERSION,
    projectId,
    targets: planned.map((item) => ({
      contentDigest: item.targetSnapshot.contentDigest,
      outputDigest: item.report.outputDigest,
      policyDigest: item.report.policyDigest,
      sourceUri: item.source.sourceUri,
      target: item.source.target,
    })),
  }));
  const immutableEntries = sorted.map((entry) => Object.freeze({
    ...entry,
    attempts: Object.freeze(entry.attempts.map((attempt) => Object.freeze({ ...attempt }))),
    ...(entry.lineage === undefined ? {} : { lineage: Object.freeze({ ...entry.lineage }) }),
  }));
  return Object.freeze({
    counts: Object.freeze(counts),
    entries: Object.freeze(immutableEntries),
    planFingerprint,
    policyVersion: EXECUTION_INCLUSION_POLICY_VERSION,
    projectId,
    schemaVersion: EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION,
  });
}

function consumePrepared(
  item: PlannedCandidate,
  projectId: string,
  policyDigest: `sha256:${string}`,
): PreparedSourceBinding {
  const binding = consumePreparedSource(item.prepared);
  if (binding === null || binding.projectId !== projectId ||
      binding.source !== item.source.sourceUri || binding.sourceKind !== 'execution' ||
      binding.sourceRevisionOrContentSha256 !== item.source.sourceRevision ||
      binding.inputBodyDigest !== sha256(securityPayload(item.source)) ||
      binding.approvedBodyDigest !== sha256(binding.approvedBody) ||
      binding.policyDigest !== policyDigest ||
      binding.rulesVersion !== SANITIZER_RULES_VERSION ||
      binding.untrustedData !== item.report.summaries.some((summary) =>
        summary.action === 'quarantine' && summary.count > 0) ||
      binding.approvedBody !== `${item.input.title}\n${item.input.body}`) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A prepared execution source binding is invalid.');
  }
  return binding;
}

export function createP2aExecutionKnowledgeProjector(
  options: CreateP2aExecutionProjectorOptions = {},
): ExecutionKnowledgeProjectorPort {
  const artifactReader = options.artifactReader ?? createP2aExecutionArtifactAdapter();
  const sourceWriter = options.sourceWriter ?? { create: createProjectSourceWriter };
  const verifySelection = async (selection: P2aExecutionSelection): Promise<void> => {
    try {
      await artifactReader.verify(selection);
    } catch {
      fail('PROJECTION_ARTIFACT_CHANGED', 'Execution artifacts changed after planning.');
    }
  };
  return {
    async plan(input): Promise<ExecutionProjectionPlan> {
      const project = await showProject(input.knowledgeRoot, input.projectId);
      const workspace = await resolveProjectWorkspace(input.knowledgeRoot, input.projectId, {
        mustExist: true,
      });
      const loadedPolicy = await readSecurityPolicy(input.knowledgeRoot, input.projectId);
      const security = createProjectSecurityService({ knowledgeRoot: input.knowledgeRoot });
      const selection = await artifactReader.read(input, project.entry.sourceRepository);
      assertSelectionConsistency(selection, input.projectId, project.entry.sourceRepository);
      const writer = await sourceWriter.create(workspace, input.projectId);
      const planned: PlannedCandidate[] = [];
      const reports = new Map<string, SanitizationReport>();
      const snapshots = new Map<string, ProjectSourceTargetSnapshot>();
      for (const source of selection.candidates) {
        const payload = securityPayload(source);
        const result = await security.prepareSource({
          body: payload,
          bodyDigest: sha256(payload),
          projectId: input.projectId,
          source: source.sourceUri,
          sourceKind: 'execution',
          sourceRevisionOrContentSha256: source.sourceRevision,
        });
        reports.set(source.sourceUri, result.report);
        if (!result.ok) continue;
        const candidateInput = approvedInput(source, result.prepared);
        const targetSnapshot = await writer.inspect(candidateInput);
        planned.push({
          input: candidateInput,
          prepared: result.prepared,
          report: result.report,
          source,
          targetSnapshot,
        });
        snapshots.set(source.sourceUri, targetSnapshot);
      }
      const entries = selection.entries.map((entry) => {
        if (entry.sourceUri === undefined) return entry;
        const report = reports.get(entry.sourceUri);
        if (report === undefined) return entry;
        const snapshot = snapshots.get(entry.sourceUri);
        if (snapshot === undefined) {
          return {
            ...entry,
            decision: report.decision,
            reasonCode: report.decision === 'quarantine'
              ? 'security_quarantine' as const
              : 'security_blocked' as const,
            security: report,
          };
        }
        return { ...entry, security: report, writeStatus: snapshot.writeStatus };
      });
      const plan = freezePlan(input.projectId, entries, planned, selection.bindings);
      privatePlans.set(plan, {
        input: { ...input },
        planned,
        policyDigest: loadedPolicy.digest,
        repository: project.entry.sourceRepository,
        selection,
        writer,
      });
      return plan;
    },

    async apply(plan): Promise<ExecutionProjectionApplyResult> {
      const bound = privatePlans.get(plan);
      if (bound === undefined || plan.schemaVersion !== EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'The execution plan is not bound here.');
      }
      if (plan.counts.quarantine > 0 || plan.counts.blocked > 0) {
        return fail('PROJECTION_ARTIFACT_INVALID', 'The execution plan contains blocking security decisions.');
      }
      const state = await resolveApplyProjectState(bound.input.knowledgeRoot, plan.projectId);
      if (state.repository !== bound.repository) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'Project metadata changed after planning.');
      }
      const currentPolicy = await readSecurityPolicy(bound.input.knowledgeRoot, plan.projectId);
      if (currentPolicy.digest !== bound.policyDigest) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'Security policy changed after planning.');
      }
      await verifySelection(bound.selection);
      await assertTargetsUnchanged(bound.writer, bound.planned);
      const approved = bound.planned.map((item) => {
        consumePrepared(item, plan.projectId, bound.policyDigest);
        return item;
      });
      const rendered = approved.map((item) => ({
        item,
        markdown: renderSourceDocument(createSourceDocument({
          body: item.input.body,
          ingestedAt: item.source.ingestedAt,
          producer: 'p2a',
          projectId: plan.projectId,
          source: item.source.sourceUri,
          sourceKind: 'execution',
          sourceRevision: item.source.sourceRevision,
          sourceType: 'file',
          title: item.input.title,
        })),
      }));
      const refreshed = await resolveApplyProjectState(bound.input.knowledgeRoot, plan.projectId);
      const refreshedPolicy = await readSecurityPolicy(bound.input.knowledgeRoot, plan.projectId);
      if (refreshed.repository !== bound.repository || refreshed.workspace !== state.workspace ||
          refreshedPolicy.digest !== bound.policyDigest) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'Project security state changed during apply.');
      }
      await verifySelection(bound.selection);
      await assertTargetsUnchanged(bound.writer, bound.planned);
      const writes = [];
      for (const { item, markdown } of rendered) {
        writes.push({
          sourceRevision: item.source.sourceRevision,
          target: item.source.target,
          taskStableId: item.source.taskStableId,
          writeStatus: await bound.writer.write(item.input, markdown, item.targetSnapshot),
        });
      }
      return { planFingerprint: plan.planFingerprint, projectId: plan.projectId, writes };
    },
  };
}
