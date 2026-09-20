import { valueDigest } from '../connection/contracts.js';
import { parseKnowledgePublishPlan, parseKnowledgePublishResult } from './publication-codec.js';
import { serializeCanonicalJson } from './atomic-file.js';
import { inspectKnowledgeWorkspace } from './knowledge-workspace.js';
import { createKnowledgePublicationService, type KnowledgePublicationPort } from './publication-service.js';
import { PublicationError, type KnowledgePublishPlan, type KnowledgePublishResult, type KnowledgePublishPlanInput,
  type KnowledgePublishCommitInput, type KnowledgePublishPushInput } from './publication-types.js';

export interface WorkspacePublishPlan extends Omit<KnowledgePublishPlan, 'schemaVersion'> {
  readonly schemaVersion: 'buildlore.workspace-publish-plan.v1';
  readonly mode: 'knowledge';
  /** The reviewed inner plan is recorded in the existing knowledge commit lineage. */
  readonly knowledgePlanDigest: KnowledgePublishPlan['planDigest'];
}
type WorkspaceResult<T> = T extends KnowledgePublishResult
  ? Omit<T, 'schemaVersion' | 'pinRequired'> & { readonly schemaVersion: 'buildlore.workspace-publish-result.v1'; readonly pinRequired: false; readonly parentPin: 'not_applicable' }
  : never;
export type WorkspacePublishResult = WorkspaceResult<KnowledgePublishResult>;

export function normalizeWorkspacePublication(value: unknown): WorkspacePublishPlan | WorkspacePublishResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PublicationError('PUBLISH_PLAN_DRIFT');
  const data = value as Record<string, unknown>;
  if (data.schemaVersion === 'buildlore.workspace-publish-plan.v1') {
    const { mode, knowledgePlanDigest, ...inner } = data;
    if (mode !== 'knowledge' || typeof knowledgePlanDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(knowledgePlanDigest)) throw new PublicationError('PUBLISH_PLAN_DRIFT');
    const plan = parseKnowledgePublishPlan(serializeCanonicalJson({ ...inner, schemaVersion: 'buildlore.knowledge-publish-plan.v1' }));
    return { ...plan, schemaVersion: 'buildlore.workspace-publish-plan.v1', mode, knowledgePlanDigest: knowledgePlanDigest as WorkspacePublishPlan['knowledgePlanDigest'] };
  }
  const { parentPin, ...inner } = data;
  if (data.schemaVersion !== 'buildlore.workspace-publish-result.v1' || data.pinRequired !== false || parentPin !== 'not_applicable') throw new PublicationError('PUBLISH_PLAN_DRIFT');
  return result(parseKnowledgePublishResult(serializeCanonicalJson({ ...inner, schemaVersion: 'buildlore.knowledge-publish-result.v1', pinRequired: true })));
}
export interface WorkspacePublicationPort {
  plan(input: KnowledgePublishPlanInput): Promise<WorkspacePublishPlan>;
  commit(input: KnowledgePublishCommitInput): Promise<WorkspacePublishResult>;
  push(input: KnowledgePublishPushInput): Promise<WorkspacePublishResult>;
}
function result(value: KnowledgePublishResult): WorkspacePublishResult {
  return { ...value, schemaVersion: 'buildlore.workspace-publish-result.v1', pinRequired: false, parentPin: 'not_applicable' };
}
export function createWorkspacePublicationService(root: string, inner: KnowledgePublicationPort = createKnowledgePublicationService(root)): WorkspacePublicationPort {
  async function plan(input: KnowledgePublishPlanInput): Promise<WorkspacePublishPlan> {
    const marker = await inspectKnowledgeWorkspace(root);
    const original = await inner.plan(input);
    const base = { ...original, schemaVersion: 'buildlore.workspace-publish-plan.v1' as const,
      mode: 'knowledge' as const, knowledgePlanDigest: original.planDigest };
    return { ...base, planDigest: valueDigest({ workspace: marker, plan: base }) };
  }
  return {
    plan,
    async commit(input) {
      const { expectedPlanDigest, ...selection } = input;
      const reviewed = await plan(selection);
      if (expectedPlanDigest !== reviewed.planDigest) throw new PublicationError('PUBLISH_PLAN_DRIFT');
      return result(await inner.commit({ ...selection, expectedPlanDigest: reviewed.knowledgePlanDigest }));
    },
    async push(input) {
      await inspectKnowledgeWorkspace(root);
      return result(await inner.push(input));
    },
  };
}
