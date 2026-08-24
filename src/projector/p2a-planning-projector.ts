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
import {
  createP2aArtifactAdapter,
  type P2aArtifactBinding,
  type P2aPlanningCandidate,
} from './p2a-artifacts.js';
import {
  type CreateP2aPlanningProjectorOptions,
  type P2aCompatibilityWarning,
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
  type ProjectSourceInput,
  type ProjectSourceTargetSnapshot,
} from './project-source-writer.js';
import { createSourceDocument, renderSourceDocument } from './source-document.js';
import { validateP2aSourceIdentity } from './source-identity.js';

interface PlannedCandidate {
  readonly input: ProjectSourceInput;
  readonly prepared: PreparedSource;
  readonly report: SanitizationReport;
  readonly source: P2aPlanningCandidate;
  readonly targetSnapshot: ProjectSourceTargetSnapshot;
}

interface PrivatePlan {
  readonly artifactRoot: string;
  readonly bindings: readonly P2aArtifactBinding[];
  readonly candidates: readonly PlannedCandidate[];
  readonly input: PlanningProjectionInput;
  readonly policyDigest: `sha256:${string}`;
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

function securityPayload(source: P2aPlanningCandidate): string {
  return `${source.title}\n${source.body}`;
}

function frozenPlan(
  projectId: string,
  entries: readonly ProjectionPlanEntry[],
  bindings: readonly P2aArtifactBinding[],
  candidates: readonly PlannedCandidate[],
  scannedFiles: readonly string[],
  compatibilityWarnings: readonly P2aCompatibilityWarning[],
): ProjectionPlan {
  const sorted = [...entries].sort((left, right) => {
    const byPath = compareText(left.sourceArtifact, right.sourceArtifact);
    if (byPath !== 0) return byPath;
    return compareText(left.documentKind ?? '', right.documentKind ?? '');
  });
  const counts = {
    blocked: sorted.filter((entry) => entry.decision === 'blocked').length,
    error: sorted.filter((entry) => entry.decision === 'error').length,
    exclude: sorted.filter((entry) => entry.decision === 'exclude').length,
    include: sorted.filter((entry) => entry.decision === 'include').length,
    quarantine: sorted.filter((entry) => entry.decision === 'quarantine').length,
  } as const;
  const fingerprint = sha256(JSON.stringify({
    bindings,
    counts,
    entries: sorted,
    projectId,
    scannedFiles,
    compatibilityWarnings,
    targets: candidates.map(({ input, report, targetSnapshot }) => ({
      contentDigest: targetSnapshot.contentDigest,
      outputDigest: report.outputDigest,
      policyDigest: report.policyDigest,
      sourceUri: input.sourceUri,
      target: input.target,
    })),
  }));
  return Object.freeze({
    compatibilityWarnings: Object.freeze(
      compatibilityWarnings.map((warning) => Object.freeze(warning)),
    ),
    counts: Object.freeze(counts),
    entries: Object.freeze(sorted.map((entry) => Object.freeze(entry))),
    planFingerprint: fingerprint,
    projectId,
    schemaVersion: PROJECTION_PLAN_SCHEMA_VERSION,
  });
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

function preparedInput(
  source: P2aPlanningCandidate,
  prepared: PreparedSource,
): ProjectSourceInput {
  const binding = inspectPreparedSource(prepared);
  if (binding === null) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A prepared source is unavailable.');
  }
  const separator = binding.approvedBody.indexOf('\n');
  if (separator < 1) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A prepared source is invalid.');
  }
  return {
    body: binding.approvedBody.slice(separator + 1),
    ingestedAt: source.ingestedAt,
    producer: 'p2a',
    sourceKind: 'planning',
    sourceRevision: source.sourceRevision,
    sourceUri: source.sourceUri,
    target: source.target,
    title: binding.approvedBody.slice(0, separator),
  };
}

function consumePrepared(
  item: PlannedCandidate,
  projectId: string,
  policyDigest: `sha256:${string}`,
): PreparedSourceBinding {
  const binding = consumePreparedSource(item.prepared);
  if (binding === null || binding.projectId !== projectId ||
      binding.source !== item.source.sourceUri || binding.sourceKind !== 'planning' ||
      binding.sourceRevisionOrContentSha256 !== item.source.sourceRevision ||
      binding.inputBodyDigest !== sha256(securityPayload(item.source)) ||
      binding.approvedBodyDigest !== sha256(binding.approvedBody) ||
      binding.policyDigest !== policyDigest ||
      binding.rulesVersion !== SANITIZER_RULES_VERSION ||
      binding.untrustedData !== item.report.summaries.some((summary) =>
        summary.action === 'quarantine' && summary.count > 0) ||
      binding.approvedBody !== `${item.input.title}\n${item.input.body}`) {
    return fail('PROJECTION_SANITIZATION_FAILED', 'A prepared source binding is invalid.');
  }
  return binding;
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

export function createP2aPlanningProjector(
  options: CreateP2aPlanningProjectorOptions = {},
): PlanningProjectorPort {
  const artifactAdapter = options.artifactReader ?? createP2aArtifactAdapter(options.revisionClock);
  const sourceWriter = options.sourceWriter ?? { create: createProjectSourceWriter };
  return {
    async plan(input): Promise<ProjectionPlan> {
      const project = await showProject(input.knowledgeRoot, input.projectId);
      const workspace = await resolveProjectWorkspace(input.knowledgeRoot, input.projectId, {
        mustExist: true,
      });
      const loadedPolicy = await readSecurityPolicy(input.knowledgeRoot, input.projectId);
      const security = createProjectSecurityService({ knowledgeRoot: input.knowledgeRoot });
      const selection = await artifactAdapter.read(input, project.entry.sourceRepository);
      const writer = await sourceWriter.create(workspace, input.projectId);
      const candidates: PlannedCandidate[] = [];
      const includeEntries: ProjectionPlanEntry[] = [];
      const targets = new Map<string, string>();
      for (const source of selection.candidates) {
        if (validateP2aSourceIdentity({
          artifactPath: source.sourceArtifact,
          documentKind: source.documentKind,
          projectId: input.projectId,
          repository: project.entry.sourceRepository,
          source: source.sourceUri,
          sourceKind: 'planning',
        }) === null) {
          includeEntries.push({
            decision: 'quarantine',
            documentKind: source.documentKind,
            reasonCode: 'path_unsafe',
            sourceArtifact: source.sourceArtifact,
            sourceRevision: source.sourceRevision,
            target: source.target,
          });
          continue;
        }
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
        const payload = securityPayload(source);
        const result = await security.prepareSource({
          body: payload,
          bodyDigest: sha256(payload),
          projectId: input.projectId,
          source: source.sourceUri,
          sourceKind: 'planning',
          sourceRevisionOrContentSha256: source.sourceRevision,
        });
        if (!result.ok) {
          includeEntries.push({
            decision: result.report.decision,
            documentKind: source.documentKind,
            reasonCode: result.report.decision === 'quarantine'
              ? 'security_quarantine'
              : 'security_blocked',
            security: result.report,
            sourceArtifact: source.sourceArtifact,
            sourceRevision: source.sourceRevision,
            sourceUri: source.sourceUri,
            target: source.target,
          });
          continue;
        }
        const approvedInput = preparedInput(source, result.prepared);
        const targetSnapshot = await writer.inspect(approvedInput);
        candidates.push({
          input: approvedInput,
          prepared: result.prepared,
          report: result.report,
          source,
          targetSnapshot,
        });
        includeEntries.push({
          decision: 'include',
          documentKind: source.documentKind,
          ingestedAt: source.ingestedAt,
          reasonCode: reasonFor(source),
          security: result.report,
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
        selection.compatibilityWarnings,
      );
      privatePlans.set(plan, {
        artifactRoot: selection.artifactRoot,
        bindings: selection.bindings,
        candidates,
        input: { ...input },
        policyDigest: loadedPolicy.digest,
        repository: project.entry.sourceRepository,
        scannedFiles: selection.scannedFiles,
      });
      return plan;
    },

    async apply(plan): Promise<ProjectionApplyResult> {
      const bound = privatePlans.get(plan);
      if (bound === undefined || plan.schemaVersion !== PROJECTION_PLAN_SCHEMA_VERSION) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'The projection plan is not bound to this process.');
      }
      if (plan.counts.error > 0 || plan.counts.blocked > 0 || plan.counts.quarantine > 0) {
        return fail('PROJECTION_ARTIFACT_INVALID', 'The projection plan contains blocking security decisions.');
      }
      const state = await resolveApplyProjectState(bound.input.knowledgeRoot, plan.projectId);
      if (state.repository !== bound.repository) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'Project metadata changed after planning.');
      }
      const currentPolicy = await readSecurityPolicy(bound.input.knowledgeRoot, plan.projectId);
      if (currentPolicy.digest !== bound.policyDigest) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'Security policy changed after planning.');
      }
      await artifactAdapter.verify(bound.artifactRoot, bound.bindings, bound.scannedFiles);
      const workspace = state.workspace;
      const writer = await sourceWriter.create(workspace, plan.projectId);
      for (const item of bound.candidates) {
        await writer.assertUnchanged(item.input, item.targetSnapshot);
      }
      const approved = bound.candidates.map((item) => {
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
          sourceKind: 'planning',
          sourceRevision: item.source.sourceRevision,
          sourceType: 'file',
          title: item.input.title,
        })),
      }));
      const refreshed = await resolveApplyProjectState(bound.input.knowledgeRoot, plan.projectId);
      const refreshedPolicy = await readSecurityPolicy(bound.input.knowledgeRoot, plan.projectId);
      if (refreshed.repository !== bound.repository ||
          refreshed.workspace !== workspace || refreshedPolicy.digest !== bound.policyDigest) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'Project security state changed during apply.');
      }
      await artifactAdapter.verify(bound.artifactRoot, bound.bindings, bound.scannedFiles);
      for (const { item } of rendered) {
        await writer.assertUnchanged(item.input, item.targetSnapshot);
      }
      const writes: ProjectionWriteResult[] = [];
      for (const { item, markdown } of rendered) {
        writes.push({
          documentKind: item.source.documentKind,
          sourceRevision: item.source.sourceRevision,
          target: item.source.target,
          writeStatus: await writer.write(item.input, markdown, item.targetSnapshot),
        });
      }
      return { planFingerprint: plan.planFingerprint, projectId: plan.projectId, writes };
    },
  };
}
