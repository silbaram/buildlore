import { preparePlannedKnowledgeCompletenessSession } from '../compiler/project-knowledge/planned-sources.js';
import { captureKnowledgeCompletenessSession, replayKnowledgeCompletenessSession,
  type KnowledgeCompletenessAction, type KnowledgeCompletenessPhase, type KnowledgeCompletenessSessionV1,
  type KnowledgeCompletenessStageViewV1 } from '../compiler/project-knowledge/completeness-session.js';
import { COMPLETENESS_LIMITS, completenessJson, type CompletenessRole } from '../compiler/project-knowledge/completeness.js';
import { createKnowledgeGenerationHistoryStore } from '../retrieval/project-knowledge-history-store.js';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { preparePlannedKnowledgeSession } from '../compiler/project-knowledge/planned-sources.js';
import { bridgeKnowledgeToHierarchy } from '../compiler/project-knowledge/hierarchy-bridge.js';
import { finalizeCompileRun } from '../compiler/hierarchy/index.js';
import { readConfinedSessionUtf8 } from '../compiler/session/safe-io.js';
import { boundedJson, choice, digest, hash, invalid, keys, project, record, text,
  ProjectKnowledgeError } from '../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1, KnowledgeProposalV1, KnowledgeRendererVersion } from '../knowledge/project-knowledge/types.js';
import type { KnowledgeExchangeV1, KnowledgeSessionV1 } from '../compiler/project-knowledge/session.js';
import { parseJsonStrict } from '../knowledge/strict-json.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { createHash } from 'node:crypto';
import { createApprovedWikiProjectionStore, type CurrentApprovedWikiAuthority } from '../retrieval/approved-corpus-store.js';
import { approveKnowledgeWikiHistoryAuthority, knowledgeAuthorityHistory } from '../retrieval/project-knowledge-authority.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from '../projector/json-knowledge-adapter.js';
import { createHierarchyPayloadStore } from './hierarchical-run-store.js';
import { inspectKnowledgeAuthoringCoverage, inspectKnowledgeAuthoringCoverageWithHistory, parseKnowledgeAuthoringQuestions, parseKnowledgeQuestionAnswers,
  isDevelopmentMemoryProfile, type KnowledgeAuthoringQuestion, type KnowledgeQuestionAnswerMapping } from '../compiler/project-knowledge/authoring-questions.js';
import type { KnowledgeQuestionCoverageV1 } from '../compiler/project-knowledge/question-coverage.js';
import { createKnowledgeEvidenceCoverage } from '../compiler/project-knowledge/citation-support.js';
import type { KnowledgeAuthoringInspection } from '../compiler/project-knowledge/authoring-inspection.js';
import { KNOWLEDGE_CHANGE_IMPACT_REQUEST_VERSION, type KnowledgeChangeImpactV1 } from '../compiler/project-knowledge/change-impact.js';
import type { DevelopmentMemoryInspectionV1 } from '../compiler/project-knowledge/development-memory-inspection.js';

export const KNOWLEDGE_WORKFLOW_PURPOSE_VERSION = 'buildlore.hierarchical-workflow-purpose-input.v2';
export const KNOWLEDGE_QUESTIONS_PURPOSE_VERSION = 'buildlore.hierarchical-workflow-purpose-input.v3';
const LEGACY_RUN_VERSION = 'buildlore.project-knowledge-workflow-run.v1';
const RUN_VERSION = 'buildlore.project-knowledge-workflow-run.v2';
const QUESTIONS_RUN_VERSION = 'buildlore.project-knowledge-workflow-run.v3';
type Phase = 'awaiting-proposal' | 'review-ready' | 'finalized' | 'approved';

interface KnowledgeRun {
  readonly schemaVersion: typeof RUN_VERSION | typeof LEGACY_RUN_VERSION | typeof QUESTIONS_RUN_VERSION;
  readonly authoringQuestions?: readonly KnowledgeAuthoringQuestion[];
  readonly questionAnswers?: readonly KnowledgeQuestionAnswerMapping[] | null;
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
  readonly completenessAssessment: 'unassessed';
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
  readonly authoringQuestions?: readonly KnowledgeAuthoringQuestion[];
  readonly sourceCoverage?: readonly Readonly<{ id: string; coverage: ReturnType<typeof createKnowledgeEvidenceCoverage> | null;
    requirementSelection?: 'selected' | 'unassessed' }>[];
  readonly questionCoverage?: KnowledgeQuestionCoverageV1;
  readonly developmentMemoryInspection?: DevelopmentMemoryInspectionV1;
  readonly inspectionArgs?: readonly string[];
}

export interface ProjectKnowledgeWorkflowService {
  handlesPurpose(projectId: string, path: string): Promise<boolean>;
  handlesRun(projectId: string, runId: string): Promise<boolean>;
  start(projectId: string, purposeFile: string): Promise<KnowledgeWorkflowStatus>;
  status(projectId: string, runId: string): Promise<KnowledgeWorkflowStatus>;
  inspect(projectId: string, runId: string, inputFile: string, expectExchange: KnowledgeDigest): Promise<KnowledgeAuthoringInspection | KnowledgeChangeImpactV1>;
  submit(projectId: string, runId: string, inputFile: string, expectExchange: KnowledgeDigest): Promise<KnowledgeWorkflowStatus>;
  review(projectId: string, runId: string): Promise<KnowledgeWorkflowStatus>;
  finalize(projectId: string, runId: string, inputFile: string, expectReview: KnowledgeDigest): Promise<KnowledgeWorkflowStatus>;
  approve(projectId: string, runId: string, expectLedger: KnowledgeDigest, explicitConfirmation: true): Promise<KnowledgeWorkflowStatus>;
}

function authorityDigest(authority: CurrentApprovedWikiAuthority): KnowledgeDigest {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(authority)).digest('hex')}`;
}

function freezeRun(basis: Omit<KnowledgeRun, 'recordDigest'>): KnowledgeRun {
  return Object.freeze({ ...basis, recordDigest: digest(basis) });
}

function parseRun(value: unknown, projectId: string, runId: string): KnowledgeRun {
  const input = record(boundedJson(value));
  keys(input, ['schemaVersion', 'projectId', 'runId', 'revision', 'phase', 'outputLanguage',
    'snapshotDigest', 'exchangeDigest', 'baselineAuthorityDigest', 'proposal', 'semanticReview',
    'ledgerDigest', 'approvedAuthorityDigest', 'recordDigest',
    ...(input.schemaVersion === QUESTIONS_RUN_VERSION ? ['authoringQuestions', 'questionAnswers'] : [])]);
  const schemaVersion = choice(input.schemaVersion, [LEGACY_RUN_VERSION, RUN_VERSION, QUESTIONS_RUN_VERSION]);
  if (input.runId !== runId || !/^run-[0-9a-f]{64}$/u.test(runId) ||
      typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.outputLanguage !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(input.outputLanguage)) invalid();
  const phase = choice(input.phase, ['awaiting-proposal', 'review-ready', 'finalized', 'approved']);
  const authoringQuestions = schemaVersion === QUESTIONS_RUN_VERSION ? parseKnowledgeAuthoringQuestions(input.authoringQuestions) : undefined;
  const questionAnswers = authoringQuestions === undefined ? undefined : input.questionAnswers === null ? null
    : parseKnowledgeQuestionAnswers(input.questionAnswers, authoringQuestions);
  if (authoringQuestions !== undefined && (phase === 'awaiting-proposal') !== (questionAnswers === null)) invalid();
  const early = phase === 'awaiting-proposal' || phase === 'review-ready';
  if ((phase === 'awaiting-proposal') !== (input.proposal === null) ||
      (early ? input.semanticReview !== null || input.ledgerDigest !== null
        : input.semanticReview === null || input.ledgerDigest === null) ||
      (phase === 'approved') !== (input.approvedAuthorityDigest !== null)) invalid();
  const result = freezeRun({ schemaVersion, projectId: project(input.projectId, projectId), runId,
    ...(authoringQuestions === undefined ? {} : { authoringQuestions, questionAnswers: questionAnswers ?? null }),
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
  const historyStore = createKnowledgeGenerationHistoryStore({ knowledgeRoot });
  const readInput = async (path: string, projectId: string): Promise<unknown> =>
    parseJsonStrict(await readConfinedSessionUtf8(resolve(hubRoot, path), hubRoot, 16 * 1024 * 1024, projectId));
  const baseline = async (projectId: string): Promise<CurrentApprovedWikiAuthority | null> => {
    const state = await corpus.status(projectId);
    if (state.state === 'invalid') invalid();
    return state.state === 'none' ? null : corpus.readAuthority(projectId);
  };
  const prepare = (projectId: string, previous: CurrentApprovedWikiAuthority | null, outputLanguage: string,
    rendererVersion: KnowledgeRendererVersion = 'knowledge-markdown-v2',
    authoringQuestions?: readonly KnowledgeAuthoringQuestion[]) =>
    preparePlannedKnowledgeSession({ ...options, hubRoot, knowledgeRoot, projectId, outputLanguage, rendererVersion,
      ...(authoringQuestions === undefined ? {} : { authoringQuestions }),
      ...(previous?.knowledgeGeneration?.schemaVersion === 'buildlore.knowledge-authority-extension.v2'
        ? { previousHistory: knowledgeAuthorityHistory(previous.knowledgeGeneration) }
        : { previousGenerations: previous?.knowledgeGeneration?.generations ?? [] }) });
  const baseStatus = (run: KnowledgeRun, active = false): KnowledgeWorkflowStatus => ({
    schemaVersion: 'buildlore.project-knowledge-workflow-status.v1', projectId: run.projectId,
    runId: run.runId, phase: run.phase, active, completenessAssessment: 'unassessed', generationModel: 'project-knowledge-v1', egress: 'none', processSpawned: false,
    ...(run.authoringQuestions === undefined ? {} : { authoringQuestions: run.authoringQuestions,
      ...(!['awaiting-proposal', 'review-ready'].includes(run.phase) ? {} : {
        inspectionArgs: ['compile', 'hierarchy', 'inspect', '--project', run.projectId, '--run', run.runId,
          '--expect-exchange', run.exchangeDigest] }) }) });
  const coverageStatus = async (run: KnowledgeRun, session: KnowledgeSessionV1, proposal: KnowledgeProposalV1 | null,
    previous: CurrentApprovedWikiAuthority | null): Promise<Pick<KnowledgeWorkflowStatus, 'sourceCoverage' | 'questionCoverage' | 'developmentMemoryInspection'>> =>
    run.authoringQuestions === undefined ? {} : {
      sourceCoverage: run.authoringQuestions.map(q => ({ id: q.id,
        ...(q.contentProfile === undefined ? {} : { requirementSelection: q.requirements.length === 0 ? 'unassessed' as const : 'selected' as const }),
        coverage: q.contentProfile !== undefined && q.requirements.length === 0 ? null
          : createKnowledgeEvidenceCoverage(session.exchange.snapshot, q.requirements, run.projectId) })),
      ...(session.developmentMemoryInspection() === null ? {} : { developmentMemoryInspection: session.developmentMemoryInspection() ?? invalid() }),
      ...(proposal === null || isDevelopmentMemoryProfile(run.authoringQuestions) ? {} : { questionCoverage: previous?.knowledgeGeneration?.schemaVersion === 'buildlore.knowledge-authority-extension.v2'
        ? await inspectKnowledgeAuthoringCoverageWithHistory(session.exchange.snapshot, proposal, run.authoringQuestions, run.questionAnswers, knowledgeAuthorityHistory(previous.knowledgeGeneration))
        : inspectKnowledgeAuthoringCoverage(session.exchange.snapshot, proposal, run.authoringQuestions, run.questionAnswers, previous?.knowledgeGeneration?.generations ?? []) }),
    };
  const restore = async (run: KnowledgeRun): Promise<Readonly<{
    previous: CurrentApprovedWikiAuthority | null; session: KnowledgeSessionV1; proposal: KnowledgeProposalV1 | null;
    generation: KnowledgeGenerationV1 | null;
  }>> => {
    const previous = await baseline(run.projectId);
    if ((previous === null ? null : authorityDigest(previous)) !== run.baselineAuthorityDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
    const { session } = await prepare(run.projectId, previous, run.outputLanguage,
      run.schemaVersion === LEGACY_RUN_VERSION ? 'knowledge-markdown-v1' : 'knowledge-markdown-v2', run.authoringQuestions);
    if (session.exchange.exchangeDigest !== run.exchangeDigest || session.exchange.snapshot.snapshotDigest !== run.snapshotDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
    const proposal = run.proposal === null ? null : await session.submit(run.proposal, run.exchangeDigest, undefined,
      run.questionAnswers ?? undefined);
    const generation = run.semanticReview === null || proposal === null ? null
      : await session.finalize(run.semanticReview, proposal.proposalDigest);
    return { previous, session, proposal, generation };
  };
  const bridgeFor = (generation: KnowledgeGenerationV1, previous: CurrentApprovedWikiAuthority | null, expectedLedgerDigest?: KnowledgeDigest) =>
    bridgeKnowledgeToHierarchy({ knowledgeRoot, generation, ...(expectedLedgerDigest === undefined ? {} : { expectedLedgerDigest }),
      baselineGenerationDigest: previous?.state.generationDigest ?? null,
      baselineProposals: previous?.finalization.proposals ?? [] });
  const reviewViewDigest = (run: KnowledgeRun, proposal: KnowledgeProposalV1, session: KnowledgeSessionV1): KnowledgeDigest =>
    digest({ projectId: run.projectId, runId: run.runId, exchangeDigest: run.exchangeDigest, proposalDigest: proposal.proposalDigest,
      ...(session.developmentMemoryInspection() === null ? {} : { developmentMemoryInspectionDigest: session.developmentMemoryInspection()?.inspectionDigest }),
      ...(run.authoringQuestions === undefined ? {} : { questionAnswers: run.questionAnswers }) });
  const service: ProjectKnowledgeWorkflowService = {
    async handlesPurpose(projectId, path) {
      const version = record(await readInput(path, projectId)).schemaVersion;
      return version === KNOWLEDGE_WORKFLOW_PURPOSE_VERSION || version === KNOWLEDGE_QUESTIONS_PURPOSE_VERSION;
    },
    async handlesRun(projectId, runId) {
      const version = await store.schema(projectId, runId);
      return version === RUN_VERSION || version === LEGACY_RUN_VERSION || version === QUESTIONS_RUN_VERSION;
    },
    async start(projectId, purposeFile) {
      const purpose = record(await readInput(purposeFile, projectId));
      const questionsMode = purpose.schemaVersion === KNOWLEDGE_QUESTIONS_PURPOSE_VERSION;
      keys(purpose, ['schemaVersion', 'projectId', 'generationModel', 'outputLanguage', ...(questionsMode ? ['authoringQuestions'] : [])]);
      project(purpose.projectId, projectId);
      if ((!questionsMode && purpose.schemaVersion !== KNOWLEDGE_WORKFLOW_PURPOSE_VERSION) || purpose.generationModel !== 'project-knowledge-v1') invalid();
      const authoringQuestions = questionsMode ? parseKnowledgeAuthoringQuestions(purpose.authoringQuestions) : undefined;
      const outputLanguage = text(purpose.outputLanguage, 35);
      const previous = await baseline(projectId);
      const { session } = await prepare(projectId, previous, outputLanguage, 'knowledge-markdown-v2', authoringQuestions);
      const run = freezeRun({ schemaVersion: questionsMode ? QUESTIONS_RUN_VERSION : RUN_VERSION, projectId, runId: `run-${randomBytes(32).toString('hex')}`,
        ...(authoringQuestions === undefined ? {} : { authoringQuestions, questionAnswers: null }),
        revision: 0, phase: 'awaiting-proposal', outputLanguage, snapshotDigest: session.exchange.snapshot.snapshotDigest,
        exchangeDigest: session.exchange.exchangeDigest, baselineAuthorityDigest: previous === null ? null : authorityDigest(previous),
        proposal: null, semanticReview: null, ledgerDigest: null, approvedAuthorityDigest: null });
      await store.create(run);
      return { ...baseStatus(run), exchange: session.exchange, ...await coverageStatus(run, session, null, previous) };
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
        ...await coverageStatus(run, restored.session, restored.proposal, restored.previous),
        ...(restored.proposal === null ? {} : { proposal: restored.proposal, reviewTargets: restored.session.reviewTargets(),
          reviewViewDigest: reviewViewDigest(run, restored.proposal, restored.session) }),
        ...(run.ledgerDigest === null ? {} : { ledgerDigest: run.ledgerDigest }),
        ...(restored.generation === null ? {} : { generationDigest: restored.generation.generationDigest }) };
    },
    async inspect(projectId, runId, inputFile, expectExchange) {
      const run = await store.read(projectId, runId);
      if (!['awaiting-proposal', 'review-ready'].includes(run.phase)) invalid();
      if (expectExchange !== run.exchangeDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
      const input = await readInput(inputFile, projectId);
      const changeImpact = record(input).schemaVersion === KNOWLEDGE_CHANGE_IMPACT_REQUEST_VERSION;
      if (!changeImpact && run.authoringQuestions === undefined) invalid();
      const restored = await restore(run);
      return changeImpact ? restored.session.inspectChangeImpact(input, expectExchange)
        : restored.session.inspect(input, expectExchange);
    },
    async submit(projectId, runId, inputFile, expectExchange) {
      const run = await store.read(projectId, runId);
      if (!['awaiting-proposal', 'review-ready'].includes(run.phase)) invalid();
      const restored = await restore(run);
      const input = await readInput(inputFile, projectId);
      let proposalInput = input;
      let questionAnswers: readonly KnowledgeQuestionAnswerMapping[] | undefined;
      if (run.authoringQuestions !== undefined) {
        const submission = record(input);
        keys(submission, ['schemaVersion', 'projectId', 'proposal', 'questionAnswers']);
        if (submission.schemaVersion !== 'buildlore.knowledge-question-submission.v1') invalid();
        project(submission.projectId, projectId);
        questionAnswers = parseKnowledgeQuestionAnswers(submission.questionAnswers, run.authoringQuestions);
        proposalInput = submission.proposal;
      }
      const proposal = await restored.session.submit(proposalInput, expectExchange, undefined, questionAnswers);
      const next = nextRecord(run, { phase: 'review-ready', proposal,
        ...(questionAnswers === undefined ? {} : { questionAnswers }) });
      await store.replace(run, next);
      return { ...baseStatus(next), proposal, ...await coverageStatus(next, restored.session, proposal, restored.previous),
        reviewTargets: restored.session.reviewTargets(), reviewViewDigest: reviewViewDigest(next, proposal, restored.session) };
    },
    async review(projectId, runId) { return service.status(projectId, runId); },
    async finalize(projectId, runId, inputFile, expectReview) {
      const run = await store.read(projectId, runId);
      if (run.phase !== 'review-ready') invalid();
      const restored = await restore(run);
      if (!restored.proposal || expectReview !== reviewViewDigest(run, restored.proposal, restored.session)) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
      const generation = await restored.session.finalize(await readInput(inputFile, projectId), restored.proposal.proposalDigest);
      const bridge = await bridgeFor(generation, restored.previous);
      const ledger = finalizeCompileRun(bridge.finalization, projectId, bridge.reviewedQuality);
      const next = nextRecord(run, { phase: 'finalized', semanticReview: generation.review, ledgerDigest: ledger.ledgerDigest });
      await store.replace(run, next);
      return { ...baseStatus(next), generationDigest: generation.generationDigest, ledgerDigest: ledger.ledgerDigest };
    },
    async approve(projectId, runId, expectLedger, explicitConfirmation) {
      const run = await store.read(projectId, runId);
      if (!['finalized', 'approved'].includes(run.phase) || explicitConfirmation !== true || expectLedger !== run.ledgerDigest) invalid();
      const restored = await restore(run);
      if (!restored.generation) invalid();
      const bridge = await bridgeFor(restored.generation, restored.previous, expectLedger);
      const ledger = finalizeCompileRun(bridge.finalization, projectId, bridge.reviewedQuality);
      if (ledger.ledgerDigest !== expectLedger) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
      const authority = await approveKnowledgeWikiHistoryAuthority({ generation: restored.generation, store: historyStore,
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

export const KNOWLEDGE_COMPLETENESS_PURPOSE_VERSION = 'buildlore.hierarchical-workflow-purpose-input.v4';
export const KNOWLEDGE_CORRECTION_PURPOSE_VERSION = 'buildlore.hierarchical-workflow-purpose-input.v5';
export const KNOWLEDGE_CORRECTION_RUN_VERSION = 'buildlore.project-knowledge-workflow-run.v6';
const LEGACY_COMPLETENESS_RUN_VERSION = 'buildlore.project-knowledge-workflow-run.v4';
export const KNOWLEDGE_COMPLETENESS_RUN_VERSION = 'buildlore.project-knowledge-workflow-run.v5';
export interface KnowledgeCompletenessWorkflowStatusV2 {
  readonly schemaVersion: 'buildlore.project-knowledge-workflow-status.v2' | 'buildlore.project-knowledge-workflow-status.v3';
  readonly projectId: string;
  readonly runId: string;
  readonly phase: KnowledgeCompletenessPhase | 'approved';
  readonly active: boolean;
  readonly generationModel: 'project-knowledge-v1';
  readonly authoringMode: 'completeness-v1' | 'completeness-v2';
  readonly completenessAssessment: 'pending' | 'failed' | 'verified' | 'legacy-local-review';
  readonly stage: KnowledgeCompletenessStageViewV1 | null;
  readonly generationDigest: KnowledgeDigest | null;
  readonly ledgerDigest: KnowledgeDigest | null;
  readonly activationArgs?: readonly string[];
  readonly egress: 'none';
  readonly processSpawned: false;
}
interface CompletenessRun {
  readonly schemaVersion: typeof KNOWLEDGE_COMPLETENESS_RUN_VERSION | typeof LEGACY_COMPLETENESS_RUN_VERSION | typeof KNOWLEDGE_CORRECTION_RUN_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly revision: number;
  readonly phase: KnowledgeCompletenessPhase | 'approved';
  readonly outputLanguage: string;
  readonly authoringMode: 'completeness-v1' | 'completeness-v2';
  readonly authoringQuestions: readonly KnowledgeAuthoringQuestion[];
  readonly snapshotDigest: KnowledgeDigest;
  readonly exchangeDigest: KnowledgeDigest;
  readonly baselineAuthorityDigest: KnowledgeDigest | null;
  readonly state: unknown;
  readonly generationDigest: KnowledgeDigest | null;
  readonly ledgerDigest: KnowledgeDigest | null;
  readonly approvedAuthorityDigest: KnowledgeDigest | null;
  readonly recordDigest: KnowledgeDigest;
}
const PHASES = ['awaiting-shadow-inventory', 'awaiting-author-inventory', 'awaiting-inventory-review',
  'awaiting-inventory-reconciliation', 'awaiting-proposal', 'awaiting-initial-reviews', 'awaiting-correction',
  'awaiting-correction-reviews', 'awaiting-inventory-correction', 'review-ready', 'finalized', 'approved', 'completeness-failed'] as const;
function freezeCompletenessRun(basis: Omit<CompletenessRun, 'recordDigest'>): CompletenessRun {
  const run = Object.freeze({ ...basis, recordDigest: digest(basis) });
  completenessJson(run, COMPLETENESS_LIMITS.run); return run;
}
function parseCompletenessRun(value: unknown, projectId: string, runId: string): CompletenessRun {
  const r = completenessJson(value, COMPLETENESS_LIMITS.run);
  keys(r, ['schemaVersion', 'projectId', 'runId', 'revision', 'phase', 'outputLanguage', 'authoringMode', 'authoringQuestions',
    'snapshotDigest', 'exchangeDigest', 'baselineAuthorityDigest', 'state', 'generationDigest', 'ledgerDigest', 'approvedAuthorityDigest', 'recordDigest']);
  const version = choice(r.schemaVersion, [KNOWLEDGE_COMPLETENESS_RUN_VERSION, LEGACY_COMPLETENESS_RUN_VERSION, KNOWLEDGE_CORRECTION_RUN_VERSION]);
  const mode = version === KNOWLEDGE_CORRECTION_RUN_VERSION ? 'completeness-v2' : 'completeness-v1';
  if (r.authoringMode !== mode || r.runId !== runId ||
    !/^run-[0-9a-f]{64}$/u.test(runId) || typeof r.revision !== 'number' || !Number.isSafeInteger(r.revision) || r.revision < 0 ||
    typeof r.outputLanguage !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(r.outputLanguage)) invalid();
  const phase = choice(r.phase, PHASES), final = phase === 'finalized' || phase === 'approved';
  const state = record(r.state);
  if (state.schemaVersion !== (mode === 'completeness-v2' ? 'buildlore.knowledge-completeness-state.v2' : 'buildlore.knowledge-completeness-state.v1') ||
    mode === 'completeness-v1' && phase === 'awaiting-inventory-correction' || state.projectId !== projectId || state.runId !== runId || state.exchangeDigest !== r.exchangeDigest ||
    state.snapshotDigest !== r.snapshotDigest || state.phase !== (phase === 'approved' ? 'finalized' : phase) ||
    state.revision !== r.revision - (phase === 'approved' ? 1 : 0) || state.finalized !== final ||
    final !== (r.generationDigest !== null) || final !== (r.ledgerDigest !== null) ||
    (phase === 'approved') !== (r.approvedAuthorityDigest !== null)) invalid();
  const run = freezeCompletenessRun({ schemaVersion: version, projectId: project(r.projectId, projectId), runId,
    revision: r.revision, phase, outputLanguage: r.outputLanguage, authoringMode: mode,
    authoringQuestions: parseKnowledgeAuthoringQuestions(r.authoringQuestions), snapshotDigest: hash(r.snapshotDigest),
    exchangeDigest: hash(r.exchangeDigest), baselineAuthorityDigest: r.baselineAuthorityDigest === null ? null : hash(r.baselineAuthorityDigest),
    state, generationDigest: r.generationDigest === null ? null : hash(r.generationDigest),
    ledgerDigest: r.ledgerDigest === null ? null : hash(r.ledgerDigest),
    approvedAuthorityDigest: r.approvedAuthorityDigest === null ? null : hash(r.approvedAuthorityDigest) });
  if (digest(r) !== digest(run)) invalid(); return run;
}

export function createProjectKnowledgeCompletenessWorkflow(options: Readonly<{
  hubRoot: string; knowledgeRoot: string; jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
}>) {
  const hubRoot = resolve(options.hubRoot), knowledgeRoot = resolve(options.knowledgeRoot);
  const store = createHierarchyPayloadStore(hubRoot, parseCompletenessRun), corpus = createApprovedWikiProjectionStore(knowledgeRoot);
  const history = createKnowledgeGenerationHistoryStore({ knowledgeRoot });
  const readInput = async (path: string, projectId: string): Promise<unknown> =>
    parseJsonStrict(await readConfinedSessionUtf8(resolve(hubRoot, path), hubRoot, 16 * 1024 * 1024, projectId));
  const baseline = async (projectId: string): Promise<CurrentApprovedWikiAuthority | null> => {
    const status = await corpus.status(projectId);
    if (status.state === 'invalid') invalid(); return status.state === 'none' ? null : corpus.readAuthority(projectId);
  };
  const prepare = async (projectId: string, runId: string, previous: CurrentApprovedWikiAuthority | null,
    outputLanguage: string, authoringQuestions: readonly KnowledgeAuthoringQuestion[], proofPolicy: 'persisted-v1' | 'legacy-v1' = 'persisted-v1', inventoryPolicy: 'completeness-v1' | 'completeness-v2' = 'completeness-v1') =>
    await preparePlannedKnowledgeCompletenessSession({ ...options, hubRoot, knowledgeRoot, projectId, runId, outputLanguage, authoringQuestions, proofPolicy, inventoryPolicy,
      ...(previous?.knowledgeGeneration?.schemaVersion === 'buildlore.knowledge-authority-extension.v2'
        ? { previousHistory: knowledgeAuthorityHistory(previous.knowledgeGeneration) }
        : { previousGenerations: previous?.knowledgeGeneration?.generations ?? [] }) });
  const bridgeFor = (generation: KnowledgeGenerationV1, previous: CurrentApprovedWikiAuthority | null, expectedLedgerDigest?: KnowledgeDigest) =>
    bridgeKnowledgeToHierarchy({ knowledgeRoot, generation, ...(expectedLedgerDigest === undefined ? {} : { expectedLedgerDigest }), baselineGenerationDigest: previous?.state.generationDigest ?? null,
      baselineProposals: previous?.finalization.proposals ?? [] });
  const restore = async (run: CompletenessRun) => {
    const previous = await baseline(run.projectId);
    if ((previous === null ? null : digest(previous)) !== run.baselineAuthorityDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
    const { session } = await prepare(run.projectId, run.runId, previous, run.outputLanguage, run.authoringQuestions,
      run.schemaVersion === LEGACY_COMPLETENESS_RUN_VERSION ? 'legacy-v1' : 'persisted-v1', run.authoringMode);
    if (session.exchange.exchangeDigest !== run.exchangeDigest || session.exchange.snapshotDigest !== run.snapshotDigest) {
      throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
    }
    await replayKnowledgeCompletenessSession(session, run.state);
    const captured = await captureKnowledgeCompletenessSession(session);
    if ((captured.generation?.generationDigest ?? null) !== run.generationDigest) invalid();
    if (captured.generation !== null) {
      const bridge = await bridgeFor(captured.generation, previous, run.ledgerDigest ?? undefined);
      if (finalizeCompileRun(bridge.finalization, run.projectId, bridge.reviewedQuality).ledgerDigest !== run.ledgerDigest) {
        throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
      }
    }
    return { previous, session, ...captured };
  };
  const statusOf = async (run: CompletenessRun, session: KnowledgeCompletenessSessionV1 | null, role?: CompletenessRole,
    active = false): Promise<KnowledgeCompletenessWorkflowStatusV2> => {
    const result: KnowledgeCompletenessWorkflowStatusV2 = { schemaVersion: run.authoringMode === 'completeness-v2' ? 'buildlore.project-knowledge-workflow-status.v3' : 'buildlore.project-knowledge-workflow-status.v2',
      projectId: run.projectId, runId: run.runId, phase: run.phase, active, generationModel: 'project-knowledge-v1',
      authoringMode: run.authoringMode, stage: session === null ? null : await session.status(role),
      completenessAssessment: run.phase === 'completeness-failed' ? 'failed' : !['finalized', 'approved'].includes(run.phase)
        ? 'pending' : run.schemaVersion === LEGACY_COMPLETENESS_RUN_VERSION ? 'legacy-local-review' : 'verified',
      generationDigest: run.generationDigest, ledgerDigest: run.ledgerDigest, egress: 'none', processSpawned: false };
    completenessJson(result, COMPLETENESS_LIMITS.view); return result;
  };
  const service = {
    async handlesPurpose(projectId: string, path: string): Promise<boolean> {
      return [KNOWLEDGE_COMPLETENESS_PURPOSE_VERSION, KNOWLEDGE_CORRECTION_PURPOSE_VERSION].includes(String(record(await readInput(path, projectId)).schemaVersion));
    },
    async handlesRun(projectId: string, runId: string): Promise<boolean> {
      return [KNOWLEDGE_COMPLETENESS_RUN_VERSION, LEGACY_COMPLETENESS_RUN_VERSION, KNOWLEDGE_CORRECTION_RUN_VERSION].includes(await store.schema(projectId, runId));
    },
    async start(projectId: string, purposeFile: string): Promise<KnowledgeCompletenessWorkflowStatusV2> {
      const p = completenessJson(await readInput(purposeFile, projectId));
      keys(p, ['schemaVersion', 'projectId', 'generationModel', 'outputLanguage', 'authoringMode', 'authoringQuestions']);
      project(p.projectId, projectId);
      const correctionMode = p.schemaVersion === KNOWLEDGE_CORRECTION_PURPOSE_VERSION;
      const authoringMode = correctionMode ? 'completeness-v2' : 'completeness-v1';
      if ((!correctionMode && p.schemaVersion !== KNOWLEDGE_COMPLETENESS_PURPOSE_VERSION) || p.generationModel !== 'project-knowledge-v1' ||
        p.authoringMode !== authoringMode) invalid();
      const outputLanguage = text(p.outputLanguage, 35), authoringQuestions = parseKnowledgeAuthoringQuestions(p.authoringQuestions);
      const previous = await baseline(projectId), runId = `run-${randomBytes(32).toString('hex')}`;
      const { session } = await prepare(projectId, runId, previous, outputLanguage, authoringQuestions, 'persisted-v1', authoringMode);
      const { state } = await captureKnowledgeCompletenessSession(session);
      const run = freezeCompletenessRun({ schemaVersion: correctionMode ? KNOWLEDGE_CORRECTION_RUN_VERSION : KNOWLEDGE_COMPLETENESS_RUN_VERSION, projectId, runId, revision: 0, phase: state.phase,
        outputLanguage, authoringMode, authoringQuestions, snapshotDigest: session.exchange.snapshotDigest,
        exchangeDigest: session.exchange.exchangeDigest, baselineAuthorityDigest: previous === null ? null : digest(previous),
        state, generationDigest: null, ledgerDigest: null, approvedAuthorityDigest: null });
      const result = await statusOf(run, session); await store.create(run); return result;
    },
    async status(projectId: string, runId: string, role?: CompletenessRole): Promise<KnowledgeCompletenessWorkflowStatusV2> {
      const run = await store.read(projectId, runId), current = await baseline(projectId);
      if (run.phase === 'approved' && current !== null && digest(current) === run.approvedAuthorityDigest) {
        if (current.knowledgeGeneration?.generationDigest !== run.generationDigest) invalid();
        return statusOf(run, null, role, true);
      }
      return statusOf(run, (await restore(run)).session, role);
    },
    async inspect(projectId: string, runId: string, inputFile: string, expectExchange: KnowledgeDigest) {
      const run = await store.read(projectId, runId), restored = await restore(run);
      return restored.session.inspect(await readInput(inputFile, projectId), expectExchange);
    },
    async write(action: KnowledgeCompletenessAction, projectId: string, runId: string, inputFile: string,
      expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessWorkflowStatusV2> {
      const run = await store.read(projectId, runId), restored = await restore(run), input = await readInput(inputFile, projectId);
      const methods = { shadow: () => restored.session.submitShadowInventory(input, expectStage),
        inventory: () => restored.session.submitAuthorInventory(input, expectStage),
        'inventory-review': () => restored.session.submitInventoryReview(input, expectStage),
        reconcile: () => restored.session.reconcileInventory(input, expectStage),
        submit: () => restored.session.submitProse(input, expectStage),
        review: () => restored.session.submitCompletenessReview(input, expectStage),
        'source-review': () => restored.session.submitSourceReview(input, expectStage),
        correct: () => restored.session.correctProse(input, expectStage),
        'correct-inventory': () => restored.session.correctInventory(input, expectStage) };
      const actionName = choice(action, ['shadow', 'inventory', 'inventory-review', 'reconcile', 'submit', 'review', 'source-review', 'correct', 'correct-inventory']);
      const view = await methods[actionName]();
      const { state } = await captureKnowledgeCompletenessSession(restored.session);
      const { recordDigest, ...old } = run; void recordDigest;
      const next = freezeCompletenessRun({ ...old, revision: state.revision, phase: state.phase, state });
      const result = await statusOf(next, restored.session, view.role ?? undefined);
      await store.replace(run, next); return result;
    },
    async finalize(projectId: string, runId: string, inputFile: string, expectStage: KnowledgeDigest): Promise<KnowledgeCompletenessWorkflowStatusV2> {
      const run = await store.read(projectId, runId), restored = await restore(run);
      const generation = await restored.session.finalize(await readInput(inputFile, projectId), expectStage);
      const bridge = await bridgeFor(generation, restored.previous), ledger = finalizeCompileRun(bridge.finalization, projectId, bridge.reviewedQuality);
      const { state } = await captureKnowledgeCompletenessSession(restored.session), { recordDigest, ...old } = run; void recordDigest;
      const next = freezeCompletenessRun({ ...old, state, phase: 'finalized', revision: state.revision,
        generationDigest: generation.generationDigest, ledgerDigest: ledger.ledgerDigest });
      const result = await statusOf(next, restored.session); await store.replace(run, next); return result;
    },
    async approve(projectId: string, runId: string, expectLedger: KnowledgeDigest,
      explicitConfirmation: true): Promise<KnowledgeCompletenessWorkflowStatusV2> {
      const run = await store.read(projectId, runId);
      if (!['finalized', 'approved'].includes(run.phase) || explicitConfirmation !== true || expectLedger !== run.ledgerDigest) invalid();
      const restored = await restore(run), generation = restored.generation ?? invalid();
      const bridge = await bridgeFor(generation, restored.previous, expectLedger);
      const authority = await approveKnowledgeWikiHistoryAuthority({ generation, store: history, bridge,
        previousAuthority: restored.previous, explicitConfirmation: true });
      const { recordDigest, ...old } = run; void recordDigest;
      const next = run.phase === 'approved' ? run : freezeCompletenessRun({ ...old, phase: 'approved', revision: run.revision + 1,
        approvedAuthorityDigest: digest(authority) });
      if (next.approvedAuthorityDigest !== digest(authority)) invalid();
      const result = { ...await statusOf(next, restored.session), activationArgs: ['compile', 'activate', '--project', projectId,
        '--input', store.activationPath(projectId, runId), '--confirm-approval', authority.humanActivationApproval.approvalDigest] };
      completenessJson(result, COMPLETENESS_LIMITS.view);
      await store.replace(run, next, authority); return result;
    },
  };
  return Object.freeze(service);
}
export type ProjectKnowledgeCompletenessWorkflowService = ReturnType<typeof createProjectKnowledgeCompletenessWorkflow>;
