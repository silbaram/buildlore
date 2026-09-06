import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { preparePlannedKnowledgeSession } from '../compiler/project-knowledge/planned-sources.js';
import { bridgeKnowledgeToHierarchy } from '../compiler/project-knowledge/hierarchy-bridge.js';
import { finalizeCompileRun } from '../compiler/hierarchy/index.js';
import { readConfinedSessionUtf8 } from '../compiler/session/safe-io.js';
import { boundedJson, choice, digest, hash, invalid, keys, project, record, text,
  ProjectKnowledgeError } from '../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1, KnowledgeProposalV1 } from '../knowledge/project-knowledge/types.js';
import type { KnowledgeExchangeV1, KnowledgeSessionV1 } from '../compiler/project-knowledge/session.js';
import { parseJsonStrict } from '../knowledge/strict-json.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { createHash } from 'node:crypto';
import { createApprovedWikiProjectionStore, type ApprovedWikiAuthorityV1 } from '../retrieval/approved-corpus-store.js';
import { approveKnowledgeWikiAuthority } from '../retrieval/project-knowledge-authority.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from '../projector/json-knowledge-adapter.js';
import { createHierarchyPayloadStore } from './hierarchical-run-store.js';

export const KNOWLEDGE_WORKFLOW_PURPOSE_VERSION = 'buildlore.hierarchical-workflow-purpose-input.v2';
const RUN_VERSION = 'buildlore.project-knowledge-workflow-run.v1';
type Phase = 'awaiting-proposal' | 'review-ready' | 'finalized' | 'approved';

interface KnowledgeRun {
  readonly schemaVersion: typeof RUN_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly revision: number;
  readonly phase: Phase;
  readonly outputLanguage: string;
  readonly snapshotDigest: KnowledgeDigest;
  readonly exchangeDigest: KnowledgeDigest;
  readonly baselineAuthorityDigest: KnowledgeDigest | null;
  readonly proposal: unknown;
  readonly semanticReview: unknown;
  readonly ledgerDigest: KnowledgeDigest | null;
  readonly approvedAuthorityDigest: KnowledgeDigest | null;
  readonly recordDigest: KnowledgeDigest;
}

export interface KnowledgeWorkflowStatus {
  readonly schemaVersion: 'buildlore.project-knowledge-workflow-status.v1';
  readonly projectId: string;
  readonly runId: string;
  readonly phase: Phase;
  readonly active: boolean;
  readonly generationModel: 'project-knowledge-v1';
  readonly exchange?: KnowledgeExchangeV1;
  readonly proposal?: KnowledgeProposalV1;
  readonly reviewTargets?: readonly string[];
  readonly reviewViewDigest?: KnowledgeDigest;
  readonly ledgerDigest?: KnowledgeDigest;
  readonly generationDigest?: KnowledgeDigest;
  readonly activationArgs?: readonly string[];
  readonly egress: 'none';
  readonly processSpawned: false;
}

export interface ProjectKnowledgeWorkflowService {
  handlesPurpose(projectId: string, path: string): Promise<boolean>;
  handlesRun(projectId: string, runId: string): Promise<boolean>;
  start(projectId: string, purposeFile: string): Promise<KnowledgeWorkflowStatus>;
  status(projectId: string, runId: string): Promise<KnowledgeWorkflowStatus>;
  submit(projectId: string, runId: string, inputFile: string, expectExchange: KnowledgeDigest): Promise<KnowledgeWorkflowStatus>;
  review(projectId: string, runId: string): Promise<KnowledgeWorkflowStatus>;
  finalize(projectId: string, runId: string, inputFile: string, expectReview: KnowledgeDigest): Promise<KnowledgeWorkflowStatus>;
  approve(projectId: string, runId: string, expectLedger: KnowledgeDigest, explicitConfirmation: true): Promise<KnowledgeWorkflowStatus>;
}

function authorityDigest(authority: ApprovedWikiAuthorityV1): KnowledgeDigest {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(authority)).digest('hex')}`;
}

function freezeRun(basis: Omit<KnowledgeRun, 'recordDigest'>): KnowledgeRun {
  return Object.freeze({ ...basis, recordDigest: digest(basis) });
}

function parseRun(value: unknown, projectId: string, runId: string): KnowledgeRun {
  const input = record(boundedJson(value));
  keys(input, ['schemaVersion', 'projectId', 'runId', 'revision', 'phase', 'outputLanguage',
    'snapshotDigest', 'exchangeDigest', 'baselineAuthorityDigest', 'proposal', 'semanticReview',
    'ledgerDigest', 'approvedAuthorityDigest', 'recordDigest']);
  if (input.schemaVersion !== RUN_VERSION || input.runId !== runId || !/^run-[0-9a-f]{64}$/u.test(runId) ||
      typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.outputLanguage !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(input.outputLanguage)) invalid();
  const phase = choice(input.phase, ['awaiting-proposal', 'review-ready', 'finalized', 'approved']);
  const early = phase === 'awaiting-proposal' || phase === 'review-ready';
  if ((phase === 'awaiting-proposal') !== (input.proposal === null) ||
      (early ? input.semanticReview !== null || input.ledgerDigest !== null
        : input.semanticReview === null || input.ledgerDigest === null) ||
      (phase === 'approved') !== (input.approvedAuthorityDigest !== null)) invalid();
  const result = freezeRun({ schemaVersion: RUN_VERSION, projectId: project(input.projectId, projectId), runId,
    revision: input.revision, phase, outputLanguage: input.outputLanguage,
    snapshotDigest: hash(input.snapshotDigest), exchangeDigest: hash(input.exchangeDigest),
    baselineAuthorityDigest: input.baselineAuthorityDigest === null ? null : hash(input.baselineAuthorityDigest),
    proposal: input.proposal, semanticReview: input.semanticReview,
    ledgerDigest: input.ledgerDigest === null ? null : hash(input.ledgerDigest),
    approvedAuthorityDigest: input.approvedAuthorityDigest === null ? null : hash(input.approvedAuthorityDigest) });
  if (digest(input) !== digest(result)) invalid();
  return result;
}

function nextRecord(current: KnowledgeRun, updates: Partial<Omit<KnowledgeRun,
  'projectId' | 'runId' | 'recordDigest' | 'revision' | 'schemaVersion'>>): KnowledgeRun {
  const { recordDigest: old, ...basis } = current;
  void old;
  return freezeRun({ ...basis, ...updates, revision: current.revision + 1 });
}

export function createProjectKnowledgeWorkflow(options: Readonly<{
  hubRoot: string;
  knowledgeRoot: string;
  jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
}>): ProjectKnowledgeWorkflowService {
  const hubRoot = resolve(options.hubRoot);
  const knowledgeRoot = resolve(options.knowledgeRoot);
  const store = createHierarchyPayloadStore(hubRoot, parseRun);
  const corpus = createApprovedWikiProjectionStore(knowledgeRoot);
  const readInput = async (path: string, projectId: string): Promise<unknown> =>
    parseJsonStrict(await readConfinedSessionUtf8(resolve(hubRoot, path), hubRoot, 16 * 1024 * 1024, projectId));
  const baseline = async (projectId: string): Promise<ApprovedWikiAuthorityV1 | null> => {
    const state = await corpus.status(projectId);
    if (state.state === 'invalid') invalid();
    return state.state === 'none' ? null : corpus.readAuthority(projectId);
  };
  const prepare = (projectId: string, previous: ApprovedWikiAuthorityV1 | null, outputLanguage: string) =>
    preparePlannedKnowledgeSession({ ...options, hubRoot, knowledgeRoot, projectId, outputLanguage,
      previousGenerations: previous?.knowledgeGeneration?.generations ?? [] });
  const baseStatus = (run: KnowledgeRun, active = false): KnowledgeWorkflowStatus => ({
    schemaVersion: 'buildlore.project-knowledge-workflow-status.v1', projectId: run.projectId,
    runId: run.runId, phase: run.phase, active, generationModel: 'project-knowledge-v1', egress: 'none', processSpawned: false });
  const restore = async (run: KnowledgeRun): Promise<Readonly<{
    previous: ApprovedWikiAuthorityV1 | null; session: KnowledgeSessionV1; proposal: KnowledgeProposalV1 | null;
    generation: KnowledgeGenerationV1 | null;
  }>> => {
    const previous = await baseline(run.projectId);
    if ((previous === null ? null : authorityDigest(previous)) !== run.baselineAuthorityDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
    const { session } = await prepare(run.projectId, previous, run.outputLanguage);
    if (session.exchange.exchangeDigest !== run.exchangeDigest || session.exchange.snapshot.snapshotDigest !== run.snapshotDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
    const proposal = run.proposal === null ? null : await session.submit(run.proposal, run.exchangeDigest);
    const generation = run.semanticReview === null || proposal === null ? null
      : await session.finalize(run.semanticReview, proposal.proposalDigest);
    return { previous, session, proposal, generation };
  };
  const bridgeFor = (generation: KnowledgeGenerationV1, previous: ApprovedWikiAuthorityV1 | null) =>
    bridgeKnowledgeToHierarchy({ knowledgeRoot, generation,
      baselineGenerationDigest: previous?.state.generationDigest ?? null,
      baselineProposals: previous?.finalization.proposals ?? [] });
  const reviewViewDigest = (run: KnowledgeRun, proposal: KnowledgeProposalV1): KnowledgeDigest =>
    digest({ projectId: run.projectId, runId: run.runId, exchangeDigest: run.exchangeDigest, proposalDigest: proposal.proposalDigest });
  const service: ProjectKnowledgeWorkflowService = {
    async handlesPurpose(projectId, path) {
      return record(await readInput(path, projectId)).schemaVersion === KNOWLEDGE_WORKFLOW_PURPOSE_VERSION;
    },
    async handlesRun(projectId, runId) { return await store.schema(projectId, runId) === RUN_VERSION; },
    async start(projectId, purposeFile) {
      const purpose = record(await readInput(purposeFile, projectId));
      keys(purpose, ['schemaVersion', 'projectId', 'generationModel', 'outputLanguage']);
      project(purpose.projectId, projectId);
      if (purpose.schemaVersion !== KNOWLEDGE_WORKFLOW_PURPOSE_VERSION || purpose.generationModel !== 'project-knowledge-v1') invalid();
      const outputLanguage = text(purpose.outputLanguage, 35);
      const previous = await baseline(projectId);
      const { session } = await prepare(projectId, previous, outputLanguage);
      const run = freezeRun({ schemaVersion: RUN_VERSION, projectId, runId: `run-${randomBytes(32).toString('hex')}`,
        revision: 0, phase: 'awaiting-proposal', outputLanguage, snapshotDigest: session.exchange.snapshot.snapshotDigest,
        exchangeDigest: session.exchange.exchangeDigest, baselineAuthorityDigest: previous === null ? null : authorityDigest(previous),
        proposal: null, semanticReview: null, ledgerDigest: null, approvedAuthorityDigest: null });
      await store.create(run);
      return { ...baseStatus(run), exchange: session.exchange };
    },
    async status(projectId, runId) {
      const run = await store.read(projectId, runId);
      const current = await baseline(projectId);
      if (run.phase === 'approved' && current !== null && authorityDigest(current) === run.approvedAuthorityDigest) {
        return { ...baseStatus(run, true), generationDigest: current.knowledgeGeneration?.generationDigest ?? invalid(),
          ledgerDigest: run.ledgerDigest ?? invalid() };
      }
      const restored = await restore(run);
      return { ...baseStatus(run), exchange: restored.session.exchange,
        ...(restored.proposal === null ? {} : { proposal: restored.proposal, reviewTargets: restored.session.reviewTargets(),
          reviewViewDigest: reviewViewDigest(run, restored.proposal) }),
        ...(run.ledgerDigest === null ? {} : { ledgerDigest: run.ledgerDigest }),
        ...(restored.generation === null ? {} : { generationDigest: restored.generation.generationDigest }) };
    },
    async submit(projectId, runId, inputFile, expectExchange) {
      const run = await store.read(projectId, runId);
      if (!['awaiting-proposal', 'review-ready'].includes(run.phase)) invalid();
      const restored = await restore(run);
      const proposal = await restored.session.submit(await readInput(inputFile, projectId), expectExchange);
      const next = nextRecord(run, { phase: 'review-ready', proposal });
      await store.replace(run, next);
      return { ...baseStatus(next), proposal, reviewTargets: restored.session.reviewTargets(), reviewViewDigest: reviewViewDigest(next, proposal) };
    },
    async review(projectId, runId) { return service.status(projectId, runId); },
    async finalize(projectId, runId, inputFile, expectReview) {
      const run = await store.read(projectId, runId);
      if (run.phase !== 'review-ready') invalid();
      const restored = await restore(run);
      if (!restored.proposal || expectReview !== reviewViewDigest(run, restored.proposal)) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
      const generation = await restored.session.finalize(await readInput(inputFile, projectId), restored.proposal.proposalDigest);
      const bridge = await bridgeFor(generation, restored.previous);
      const ledger = finalizeCompileRun(bridge.finalization, projectId);
      const next = nextRecord(run, { phase: 'finalized', semanticReview: generation.review, ledgerDigest: ledger.ledgerDigest });
      await store.replace(run, next);
      return { ...baseStatus(next), generationDigest: generation.generationDigest, ledgerDigest: ledger.ledgerDigest };
    },
    async approve(projectId, runId, expectLedger, explicitConfirmation) {
      const run = await store.read(projectId, runId);
      if (!['finalized', 'approved'].includes(run.phase) || explicitConfirmation !== true || expectLedger !== run.ledgerDigest) invalid();
      const restored = await restore(run);
      if (!restored.generation) invalid();
      const bridge = await bridgeFor(restored.generation, restored.previous);
      const ledger = finalizeCompileRun(bridge.finalization, projectId);
      if (ledger.ledgerDigest !== expectLedger) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
      const authority = approveKnowledgeWikiAuthority({ generations: [
        ...(restored.previous?.knowledgeGeneration?.generations ?? []), restored.generation],
      bridge, previousAuthority: restored.previous, explicitConfirmation: true });
      const next = run.phase === 'approved' ? run : nextRecord(run, { phase: 'approved', approvedAuthorityDigest: authorityDigest(authority) });
      if (next.approvedAuthorityDigest !== authorityDigest(authority)) invalid();
      await store.replace(run, next, authority);
      return { ...baseStatus(next), generationDigest: restored.generation.generationDigest, ledgerDigest: ledger.ledgerDigest,
        activationArgs: ['compile', 'activate', '--project', projectId, '--input', store.activationPath(projectId, runId),
          '--confirm-approval', authority.humanActivationApproval.approvalDigest] };
    },
  };
  return Object.freeze(service);
}
