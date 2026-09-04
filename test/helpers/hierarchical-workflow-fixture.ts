import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CURRENT_SESSION_PROPOSAL_SUBMISSION_SCHEMA_VERSION,
  SESSION_COMPILE_ALGORITHM_VERSION,
  SESSION_COMPILE_PLAN_SCHEMA_VERSION,
  hierarchySha256,
  type CurrentSessionGenerationExchangeV1,
  type CurrentSessionProposalSubmissionV1,
  type ProjectSessionCompilerPort,
  type SessionCompilePlanV1,
} from '../../src/compiler/index.js';
import {
  createHierarchicalWorkflowService as createWorkflowService,
  type HierarchicalWorkflowServicePort,
} from '../../src/cli/hierarchical-workflow.js';
import type { HierarchicalWorkflowRunStorePort } from '../../src/cli/hierarchical-run-store.js';
import { addProject } from '../../src/knowledge/index.js';
import { sourceRetrievalMeaningFromDescriptor } from '../../src/projector/index.js';
import {
  createApprovedWikiProjectionStore,
  type ApprovedWikiProjectionStorePort,
} from '../../src/retrieval/index.js';
import { SESSION_COMPILE_LIMITS } from '../../src/compiler/session/contracts.js';
import { writeSecurityPolicy } from '../fixtures/security-policy.js';

const SOURCE_BODY =
  '# Reviewable local workflow\n\n' +
  'Local evidence stays reviewable because deterministic receipts bind exact sanitizer policy ' +
  'digests, citation anchors, source revisions, child summaries, Wiki links, quality decisions, ' +
  'human approval, activation lineage, and restart-safe offline state without external providers.\n';
const SECOND_SOURCE_BODY =
  '# Restart recovery\n\n' +
  'Restart recovery rebuilds sanitized evidence packs, replays proposal receipts leaf first, ' +
  'checks explicit review decisions, detects source drift, and confines atomic activation bundles ' +
  'to one project run while preserving clean authoritative Wiki verification.\n';

export interface HierarchicalWorkflowTestFixtureV1 {
  readonly corpusStore: ApprovedWikiProjectionStorePort;
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly projectId: string;
  readonly plannerCalls: string[];
  createService(runStore?: HierarchicalWorkflowRunStorePort): HierarchicalWorkflowServicePort;
  writeJson(name: string, value: unknown): Promise<string>;
  cleanup(): Promise<void>;
}

function fakePlan(projectId: string): SessionCompilePlanV1 {
  const sourceInputs = [
    Object.freeze({ body: SOURCE_BODY, sourceRef: 'docs/workflow.md', suffix: '1' }),
    Object.freeze({ body: SECOND_SOURCE_BODY, sourceRef: 'docs/restart.md', suffix: '2' }),
  ];
  return Object.freeze({
    schemaVersion: SESSION_COMPILE_PLAN_SCHEMA_VERSION,
    projectId,
    contractDigest: hierarchySha256('workflow-contract'),
    planDigest: hierarchySha256('workflow-plan'),
    profileDigest: hierarchySha256('workflow-profile'),
    policyDigest: hierarchySha256('workflow-session-policy'),
    selectionDigest: hierarchySha256('workflow-selection'),
    sourceManifestDigest: hierarchySha256('workflow-manifest'),
    existingKnowledgeDigest: hierarchySha256('workflow-existing-knowledge'),
    algorithmVersion: SESSION_COMPILE_ALGORITHM_VERSION,
    limits: SESSION_COMPILE_LIMITS,
    sources: Object.freeze(sourceInputs.map((source) => {
      const contentDigest = hierarchySha256(source.body);
      return Object.freeze({
        citationAnchors: Object.freeze([]),
        compilerSourceContentDigest: contentDigest,
        compilerSourceId: `source-${source.suffix.repeat(64)}`,
        originalContentDigest: contentDigest,
        revision: contentDigest,
        retrievalMeaning: sourceRetrievalMeaningFromDescriptor(undefined),
        sanitizedBody: source.body,
        sanitizedContentDigest: contentDigest,
        sourceId: `source-${source.suffix === '1' ? '3'.repeat(64) : '4'.repeat(64)}`,
        sourceKind: 'markdown' as const,
        sourceRef: source.sourceRef,
        title: source.suffix === '1' ? 'Restart-safe local evidence' : 'Recovery evidence',
      });
    })),
    tasks: Object.freeze([]),
    mergeCandidates: Object.freeze([]),
    allowedLinkTargets: Object.freeze([]),
  });
}

/** Authors only the bounded exchange contract returned to an already-running test agent. */
export function authorHierarchicalWorkflowProposal(
  exchange: CurrentSessionGenerationExchangeV1,
): CurrentSessionProposalSubmissionV1 {
  const units = exchange.evidencePack.units;
  const evidenceUnitIds = Object.freeze(units.map((unit) => unit.unitId).sort());
  const citationIds = Object.freeze(units.map((unit) => unit.citation.citationId).sort());
  const evidenceTokens = units.flatMap((unit) =>
    unit.content.match(/[\p{L}\p{N}_-]+/gu) ?? []);
  if (evidenceTokens.length < 8 || evidenceUnitIds.length === 0) {
    throw new Error('Workflow exchange evidence is insufficient for the test author.');
  }
  const markers = citationIds.map((citationId) => `[^${citationId}]`).join(' ');
  const links = exchange.request.requiredLinkPageIds
    .map((pageId) => `[[${pageId}]]`).join(' ');
  const childSummaries = exchange.request.approvedChildSummaries.map((summary) =>
    `${summary.summary} ${summary.citationIds.map((citationId) =>
      `[^${citationId}]`).join(' ')}`).join(' ');
  const claims = exchange.request.requiredSections.map((sectionId, index) => {
    const start = (exchange.request.generationOrder * 11 + index * 5) % evidenceTokens.length;
    const selected = Array.from({ length: Math.min(6, evidenceTokens.length) }, (_, offset) =>
      evidenceTokens[(start + offset) % evidenceTokens.length] as string);
    const questionTokens = exchange.writingBrief.keyQuestions.flatMap((question) =>
      question.match(/[\p{L}\p{N}_-]+/gu) ?? [])
      .filter((token) => !['a', 'an', 'does', 'how', 'is', 'the'].includes(token.toLowerCase()))
      .slice(0, 2);
    const identity = exchange.pageId.slice('page-'.length);
    return Object.freeze({
      text: [
        ...selected,
        ...questionTokens,
        `context-${identity.slice(0, 12)}`,
        `detail-${identity.slice(12, 24)}`,
        `section-${sectionId}`,
        `order-${exchange.request.generationOrder}`,
      ].join(' '),
      evidenceUnitIds,
      citationIds,
    });
  });
  const sections = Object.freeze(exchange.request.requiredSections.map((sectionId, index) => {
    const claim = claims[index];
    if (claim === undefined) throw new Error('Workflow claim is missing.');
    return Object.freeze({
      sectionId,
      body: `${claim.text} ${markers}` +
        `${index === 0 && childSummaries.length > 0 ? ` ${childSummaries}` : ''}` +
        `${index === 0 && links.length > 0 ? ` ${links}` : ''}`,
    });
  }));
  const firstClaim = claims[0];
  if (firstClaim === undefined) throw new Error('Workflow summary claim is missing.');
  return Object.freeze({
    schemaVersion: CURRENT_SESSION_PROPOSAL_SUBMISSION_SCHEMA_VERSION,
    projectId: exchange.projectId,
    pageId: exchange.pageId,
    exchangeDigest: exchange.exchangeDigest,
    requestDigest: exchange.requestDigest,
    title: exchange.writingBrief.title,
    summary: firstClaim.text,
    sections,
    claims: Object.freeze(claims),
    wikilinks: exchange.request.requiredLinkPageIds,
  });
}

export async function createHierarchicalWorkflowTestFixture(
  projectId = 'hierarchy-workflow',
  transformPlan: (plan: SessionCompilePlanV1) => SessionCompilePlanV1 = (plan) => plan,
): Promise<HierarchicalWorkflowTestFixtureV1> {
  const hubRoot = await mkdtemp(join(tmpdir(), 'buildlore-hierarchy-workflow-'));
  await chmod(hubRoot, 0o755);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot, { mode: 0o755 });
  await addProject(knowledgeRoot, {
    displayName: 'Hierarchy workflow fixture',
    projectId,
    sourceRepository: `https://example.test/${projectId}.git`,
  });
  await writeSecurityPolicy(knowledgeRoot, projectId, { capabilities: [] });
  const corpusStore = createApprovedWikiProjectionStore(knowledgeRoot);
  const plannerCalls: string[] = [];
  const plan = transformPlan(fakePlan(projectId));
  const compiler: Pick<ProjectSessionCompilerPort, 'plan'> = Object.freeze({
    plan(input) {
      plannerCalls.push(input.projectId);
      return Promise.resolve(plan);
    },
  });
  const fixture: HierarchicalWorkflowTestFixtureV1 = {
    corpusStore,
    hubRoot,
    knowledgeRoot,
    projectId,
    plannerCalls,
    createService: (runStore) => createWorkflowService({
      compiler,
      corpusStore,
      hubRoot,
      knowledgeRoot,
      ...(runStore === undefined ? {} : { runStore }),
    }),
    async writeJson(name, value) {
      const relative = `.buildlore/workflow-inputs/${name}`;
      const directory = join(hubRoot, '.buildlore/workflow-inputs');
      await mkdir(directory, { mode: 0o700, recursive: true });
      await writeFile(join(hubRoot, relative), JSON.stringify(value), { mode: 0o600 });
      return relative;
    },
    cleanup: () => rm(hubRoot, { force: true, recursive: true }),
  };
  return Object.freeze(fixture);
}
