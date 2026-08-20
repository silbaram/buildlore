import { createHash } from 'node:crypto';

import { resolveProjectWorkspace, showProject } from '../knowledge/index.js';
import {
  consumeSanitizationApproval,
  type SanitizationApprovalBinding,
} from '../sanitizer/approval.js';
import type { SanitizationRequest, SourceSanitizerPort } from '../sanitizer/index.js';
import { ProjectionError } from './errors.js';
import {
  createP2aArtifactAdapter,
  type P2aArtifactBinding,
  type P2aPlanningCandidate,
} from './p2a-artifacts.js';
import {
  type CreateP2aPlanningProjectorOptions,
  type PlanningProjectionInput,
  type PlanningProjectorPort,
  PROJECTION_PLAN_SCHEMA_VERSION,
  type ProjectionApplyResult,
  type ProjectionPlan,
  type ProjectionPlanEntry,
  type ProjectionWriteResult,
} from './planning-types.js';
import {
  createProjectSourceWriter,
  type ProjectSourceTargetSnapshot,
} from './project-source-writer.js';
import {
  createSourceDocument,
  normalizeSourceBody,
  renderSourceDocument,
} from './source-document.js';

interface PlannedCandidate {
  readonly source: P2aPlanningCandidate;
  readonly targetSnapshot: ProjectSourceTargetSnapshot;
}

interface PrivatePlan {
  readonly artifactRoot: string;
  readonly bindings: readonly P2aArtifactBinding[];
  readonly candidates: readonly PlannedCandidate[];
  readonly input: PlanningProjectionInput;
  readonly repository: string;
  readonly scannedFiles: readonly string[];
}

const privatePlans = new WeakMap<ProjectionPlan, PrivatePlan>();

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

function frozenPlan(
  projectId: string,
  entries: readonly ProjectionPlanEntry[],
  bindings: readonly P2aArtifactBinding[],
  candidates: readonly PlannedCandidate[],
  scannedFiles: readonly string[],
): ProjectionPlan {
  const sorted = [...entries].sort((left, right) => {
    const byPath = compareText(left.sourceArtifact, right.sourceArtifact);
    if (byPath !== 0) return byPath;
    return compareText(left.documentKind ?? '', right.documentKind ?? '');
  });
  const counts = {
    error: sorted.filter((entry) => entry.decision === 'error').length,
    exclude: sorted.filter((entry) => entry.decision === 'exclude').length,
    include: sorted.filter((entry) => entry.decision === 'include').length,
  } as const;
  const fingerprint = sha256(JSON.stringify({
    bindings,
    counts,
    entries: sorted,
    projectId,
    scannedFiles,
    targets: candidates.map(({ source, targetSnapshot }) => ({
      contentDigest: targetSnapshot.contentDigest,
      sourceUri: source.sourceUri,
      target: source.target,
    })),
  }));
  return Object.freeze({
    counts: Object.freeze(counts),
    entries: Object.freeze(sorted.map((entry) => Object.freeze(entry))),
    planFingerprint: fingerprint,
    projectId,
    schemaVersion: PROJECTION_PLAN_SCHEMA_VERSION,
  });
}

function consumeApproval(
  result: Awaited<ReturnType<SourceSanitizerPort['sanitize']>>,
  request: SanitizationRequest,
): SanitizationApprovalBinding {
  if (!result.ok) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A source body was not approved for persistence.');
  }
  const binding = consumeSanitizationApproval(result);
  if (binding === null) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A sanitizer approval is invalid or already used.');
  }
  const approvedBodyDigest = sha256(binding.approvedBody);
  let approvedBody: string;
  try {
    approvedBody = normalizeSourceBody(binding.approvedBody);
  } catch {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A sanitizer approval is invalid.');
  }
  if (
    binding.projectId !== request.projectId ||
    binding.source !== request.source ||
    binding.inputBodyDigest !== request.bodyDigest ||
    binding.approvedBodyDigest !== approvedBodyDigest
  ) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A sanitizer approval is invalid.');
  }
  return { ...binding, approvedBody, approvedBodyDigest: sha256(approvedBody) };
}

function reasonFor(source: P2aPlanningCandidate): ProjectionPlanEntry['reasonCode'] {
  switch (source.documentKind) {
    case 'product-spec':
      return 'approved_product_spec';
    case 'implementation-plan':
      return 'approved_implementation_plan';
    case 'intake':
      return 'approved_intake';
    case 'archived-iteration':
      return 'archived_feature';
  }
}

export function createP2aPlanningProjector(
  options: CreateP2aPlanningProjectorOptions = {},
): PlanningProjectorPort {
  const artifactAdapter = options.artifactReader ?? createP2aArtifactAdapter(options.revisionClock);
  const sourceWriter = options.sourceWriter ?? {
    create: createProjectSourceWriter,
  };
  return {
    async plan(input): Promise<ProjectionPlan> {
      const project = await showProject(input.knowledgeRoot, input.projectId);
      const workspace = await resolveProjectWorkspace(input.knowledgeRoot, input.projectId, {
        mustExist: true,
      });
      const selection = await artifactAdapter.read(input, project.entry.sourceRepository);
      const writer = await sourceWriter.create(workspace, input.projectId);
      const candidates: PlannedCandidate[] = [];
      const includeEntries: ProjectionPlanEntry[] = [];
      const targets = new Map<string, string>();
      for (const source of selection.candidates) {
        const existingSource = targets.get(source.target);
        if (existingSource !== undefined && existingSource !== source.sourceUri) {
          includeEntries.push({
            decision: 'error',
            documentKind: source.documentKind,
            reasonCode: 'source_collision',
            sourceArtifact: source.sourceArtifact,
            sourceRevision: source.sourceRevision,
            sourceUri: source.sourceUri,
            target: source.target,
          });
          continue;
        }
        targets.set(source.target, source.sourceUri);
        const targetSnapshot = await writer.inspect(source);
        candidates.push({ source, targetSnapshot });
        includeEntries.push({
          decision: 'include',
          documentKind: source.documentKind,
          ingestedAt: source.ingestedAt,
          reasonCode: reasonFor(source),
          sourceArtifact: source.sourceArtifact,
          sourceRevision: source.sourceRevision,
          sourceUri: source.sourceUri,
          target: source.target,
          timestampSource: source.timestampSource,
          writeStatus: targetSnapshot.writeStatus,
        });
      }
      const plan = frozenPlan(
        input.projectId,
        [...selection.entries, ...includeEntries],
        selection.bindings,
        candidates,
        selection.scannedFiles,
      );
      privatePlans.set(plan, {
        artifactRoot: selection.artifactRoot,
        bindings: selection.bindings,
        candidates,
        input: { ...input },
        repository: project.entry.sourceRepository,
        scannedFiles: selection.scannedFiles,
      });
      return plan;
    },

    async apply(plan, sanitizer): Promise<ProjectionApplyResult> {
      const bound = privatePlans.get(plan);
      if (bound === undefined || plan.schemaVersion !== PROJECTION_PLAN_SCHEMA_VERSION) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'The projection plan is not bound to this process.');
      }
      if (plan.counts.error > 0) {
        return fail('PROJECTION_ARTIFACT_INVALID', 'The projection plan contains blocking errors.');
      }
      const project = await showProject(bound.input.knowledgeRoot, plan.projectId);
      if (project.entry.sourceRepository !== bound.repository) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'Project metadata changed after planning.');
      }
      await artifactAdapter.verify(bound.artifactRoot, bound.bindings, bound.scannedFiles);
      const workspace = await resolveProjectWorkspace(
        bound.input.knowledgeRoot,
        plan.projectId,
        { mustExist: true },
      );
      const writer = await sourceWriter.create(workspace, plan.projectId);
      for (const { source, targetSnapshot } of bound.candidates) {
        await writer.assertUnchanged(source, targetSnapshot);
      }

      const approvals: Array<{
        readonly approval: SanitizationApprovalBinding;
        readonly source: P2aPlanningCandidate;
        readonly targetSnapshot: ProjectSourceTargetSnapshot;
      }> = [];
      for (const { source, targetSnapshot } of bound.candidates) {
        const request: SanitizationRequest = {
          body: source.body,
          bodyDigest: sha256(source.body),
          projectId: plan.projectId,
          source: source.sourceUri,
        };
        let result;
        try {
          result = await sanitizer.sanitize(request);
        } catch {
          return fail('PROJECTION_SANITIZATION_FAILED', 'Source sanitization failed.');
        }
        approvals.push({
          approval: consumeApproval(result, request),
          source,
          targetSnapshot,
        });
      }

      const rendered = approvals.map(({ approval, source, targetSnapshot }) => ({
        markdown: renderSourceDocument(createSourceDocument({
          body: approval.approvedBody,
          ingestedAt: source.ingestedAt,
          producer: 'p2a',
          projectId: plan.projectId,
          source: source.sourceUri,
          sourceKind: 'planning',
          sourceRevision: source.sourceRevision,
          sourceType: 'file',
          title: source.title,
        })),
        source,
        targetSnapshot,
      }));
      try {
        const refreshedProject = await showProject(bound.input.knowledgeRoot, plan.projectId);
        const refreshedWorkspace = await resolveProjectWorkspace(
          bound.input.knowledgeRoot,
          plan.projectId,
          { mustExist: true },
        );
        if (
          refreshedProject.entry.sourceRepository !== bound.repository ||
          refreshedWorkspace !== workspace
        ) {
          fail('PROJECTION_ARTIFACT_CHANGED', 'Project metadata changed during sanitization.');
        }
      } catch (error) {
        if (error instanceof ProjectionError) throw error;
        fail('PROJECTION_ARTIFACT_CHANGED', 'Project metadata changed during sanitization.');
      }
      await artifactAdapter.verify(bound.artifactRoot, bound.bindings, bound.scannedFiles);
      for (const { source, targetSnapshot } of rendered) {
        await writer.assertUnchanged(source, targetSnapshot);
      }

      const writes: ProjectionWriteResult[] = [];
      for (const { markdown, source, targetSnapshot } of rendered) {
        writes.push({
          documentKind: source.documentKind,
          sourceRevision: source.sourceRevision,
          target: source.target,
          writeStatus: await writer.write(source, markdown, targetSnapshot),
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
