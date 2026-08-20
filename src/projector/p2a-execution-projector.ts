import { createHash } from 'node:crypto';

import { resolveProjectWorkspace, showProject } from '../knowledge/index.js';
import {
  consumeSanitizationApproval,
  type SanitizationApprovalBinding,
} from '../sanitizer/approval.js';
import type { SanitizationRequest, SourceSanitizerPort } from '../sanitizer/index.js';
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
import {
  createSourceDocument,
  normalizeSourceBody,
  renderSourceDocument,
} from './source-document.js';

interface PlannedCandidate {
  readonly input: ProjectSourceInput;
  readonly source: ExecutionCandidate;
  readonly targetSnapshot: ProjectSourceTargetSnapshot;
}

interface PrivatePlan {
  readonly input: ExecutionProjectionInput;
  readonly planned: readonly PlannedCandidate[];
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

function sourceInput(candidate: ExecutionCandidate): ProjectSourceInput {
  return {
    body: candidate.body,
    ingestedAt: candidate.ingestedAt,
    sourceKind: 'execution',
    sourceRevision: candidate.sourceRevision,
    sourceUri: candidate.sourceUri,
    target: candidate.target,
    title: candidate.title,
  };
}

function assertSelectionConsistency(selection: P2aExecutionSelection): void {
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
    if (
      entry === undefined ||
      seenTargets.has(candidate.target) ||
      entry.reasonCode !== candidate.reasonCode ||
      entry.sourceRevision !== candidate.sourceRevision ||
      entry.target !== candidate.target ||
      entry.taskStableId !== candidate.taskStableId ||
      canonicalExecutionJson(entry.lineage) !== canonicalExecutionJson(candidate.lineage) ||
      canonicalExecutionJson(entry.attempts) !== canonicalExecutionJson(attempts)
    ) fail('PROJECTION_ARTIFACT_INVALID', 'Execution selection is inconsistent.');
    entriesBySource.delete(candidate.sourceUri);
    seenTargets.add(candidate.target);
  }
  if (entriesBySource.size !== 0) {
    fail('PROJECTION_ARTIFACT_INVALID', 'Execution selection is inconsistent.');
  }
}

function consumeApproval(
  result: Awaited<ReturnType<SourceSanitizerPort['sanitize']>>,
  request: SanitizationRequest,
): SanitizationApprovalBinding {
  if (!result.ok) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'An execution source was not approved.');
  }
  const binding = consumeSanitizationApproval(result);
  if (binding === null) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A sanitizer approval is invalid or used.');
  }
  let approvedBody: string;
  try {
    approvedBody = normalizeSourceBody(binding.approvedBody);
  } catch {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A sanitizer approval is invalid.');
  }
  if (
    binding.projectId !== request.projectId || binding.source !== request.source ||
    binding.inputBodyDigest !== request.bodyDigest ||
    binding.approvedBodyDigest !== sha256(binding.approvedBody)
  ) return fail('PROJECTION_SANITIZATION_FAILED', 'A sanitizer approval is invalid.');
  return { ...binding, approvedBody, approvedBodyDigest: sha256(approvedBody) };
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
    for (const item of planned) {
      await writer.assertUnchanged(item.input, item.targetSnapshot);
    }
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
      sourceUri: item.source.sourceUri,
      target: item.source.target,
    })),
  }));
  const immutableEntries = sorted.map((entry) => Object.freeze({
    ...entry,
    attempts: Object.freeze(entry.attempts.map((attempt) => Object.freeze({ ...attempt }))),
    ...(entry.lineage === undefined
      ? {}
      : { lineage: Object.freeze({ ...entry.lineage }) }),
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
      const selection = await artifactReader.read(input, project.entry.sourceRepository);
      assertSelectionConsistency(selection);
      const writer = await sourceWriter.create(workspace, input.projectId);
      const planned: PlannedCandidate[] = [];
      const snapshots = new Map<string, ProjectSourceTargetSnapshot>();
      for (const source of selection.candidates) {
        const candidateInput = sourceInput(source);
        const targetSnapshot = await writer.inspect(candidateInput);
        planned.push({ input: candidateInput, source, targetSnapshot });
        snapshots.set(source.sourceUri, targetSnapshot);
      }
      const entries = selection.entries.map((entry) => {
        const snapshot = entry.sourceUri === undefined ? undefined : snapshots.get(entry.sourceUri);
        return snapshot === undefined ? entry : { ...entry, writeStatus: snapshot.writeStatus };
      });
      const plan = freezePlan(input.projectId, entries, planned, selection.bindings);
      privatePlans.set(plan, {
        input: { ...input },
        planned,
        repository: project.entry.sourceRepository,
        selection,
        writer,
      });
      return plan;
    },

    async apply(plan, sanitizer): Promise<ExecutionProjectionApplyResult> {
      const bound = privatePlans.get(plan);
      if (bound === undefined || plan.schemaVersion !== EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'The execution plan is not bound here.');
      }
      if (plan.counts.quarantine > 0) {
        return fail('PROJECTION_ARTIFACT_INVALID', 'The execution plan contains quarantine.');
      }
      const state = await resolveApplyProjectState(bound.input.knowledgeRoot, plan.projectId);
      if (state.repository !== bound.repository) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'Project metadata changed after planning.');
      }
      await verifySelection(bound.selection);
      const workspace = state.workspace;
      const writer = bound.writer;
      await assertTargetsUnchanged(writer, bound.planned);

      const approvals: Array<Readonly<{
        approvedBody: string;
        item: PlannedCandidate;
      }>> = [];
      for (const item of bound.planned) {
        const request: SanitizationRequest = {
          body: item.source.body,
          bodyDigest: sha256(item.source.body),
          projectId: plan.projectId,
          source: item.source.sourceUri,
        };
        let result;
        try {
          result = await sanitizer.sanitize(request);
        } catch {
          return fail('PROJECTION_SANITIZATION_FAILED', 'Execution sanitization failed.');
        }
        approvals.push({
          approvedBody: consumeApproval(result, request).approvedBody,
          item,
        });
      }

      const rendered = approvals.map(({ approvedBody, item }) => ({
        item,
        markdown: renderSourceDocument(createSourceDocument({
          body: approvedBody,
          ingestedAt: item.source.ingestedAt,
          producer: 'p2a',
          projectId: plan.projectId,
          source: item.source.sourceUri,
          sourceKind: 'execution',
          sourceRevision: item.source.sourceRevision,
          sourceType: 'file',
          title: item.source.title,
        })),
      }));

      const refreshed = await resolveApplyProjectState(bound.input.knowledgeRoot, plan.projectId);
      if (
        refreshed.repository !== bound.repository ||
        refreshed.workspace !== workspace
      ) return fail('PROJECTION_ARTIFACT_CHANGED', 'Project metadata changed during sanitization.');
      await verifySelection(bound.selection);
      await assertTargetsUnchanged(writer, bound.planned);

      const writes = [];
      for (const { item, markdown } of rendered) {
        writes.push({
          sourceRevision: item.source.sourceRevision,
          target: item.source.target,
          taskStableId: item.source.taskStableId,
          writeStatus: await writer.write(item.input, markdown, item.targetSnapshot),
        });
      }
      return {
        planFingerprint: plan.planFingerprint,
        projectId: plan.projectId,
        writes,
      };
    },
  };
}
