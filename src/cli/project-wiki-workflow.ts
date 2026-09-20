import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { parseJsonStrict } from '../knowledge/strict-json.js';
import { boundedJson, choice, digest, hash, invalid, keys, project, record, ProjectKnowledgeError } from '../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from '../knowledge/project-knowledge/types.js';
import { readConfinedSessionUtf8 } from '../compiler/session/safe-io.js';
import { preparePlannedKnowledgeSession } from '../compiler/project-knowledge/planned-sources.js';
import { createKnowledgeWikiSession, type KnowledgeWikiState } from '../compiler/project-knowledge/wiki-session.js';
import { parseKnowledgeWikiPurpose } from '../compiler/project-knowledge/wiki-contracts.js';
import { bridgeKnowledgeToHierarchy } from '../compiler/project-knowledge/hierarchy-bridge.js';
import { finalizeCompileRun } from '../compiler/hierarchy/index.js';
import { createApprovedWikiProjectionStore, type CurrentApprovedWikiAuthority } from '../retrieval/approved-corpus-store.js';
import { createKnowledgeGenerationHistoryStore } from '../retrieval/project-knowledge-history-store.js';
import { approveKnowledgeWikiHistoryAuthority, knowledgeAuthorityHistory } from '../retrieval/project-knowledge-authority.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from '../projector/json-knowledge-adapter.js';
import { createHierarchyPayloadStore } from './hierarchical-run-store.js';

interface WikiRun {
  readonly schemaVersion: 'buildlore.wiki-workflow-run.v1';
  readonly projectId: string;
  readonly runId: string;
  readonly revision: number;
  readonly phase: 'writing' | 'finalized' | 'approved';
  readonly baselineAuthorityDigest: KnowledgeDigest | null;
  readonly state: KnowledgeWikiState;
  readonly ledgerDigest: KnowledgeDigest | null;
  readonly generationDigest: KnowledgeDigest | null;
  readonly approvedAuthorityDigest: KnowledgeDigest | null;
  readonly recordDigest: KnowledgeDigest;
}
function freezeRun(basis: Omit<WikiRun, 'recordDigest'>): WikiRun {
  if (Buffer.byteLength(JSON.stringify(basis)) > 9 * 1024 * 1024) invalid();
  return Object.freeze({ ...basis, recordDigest: digest(basis) });
}
function parseRun(value: unknown, projectId: string, runId: string): WikiRun {
  const r = record(boundedJson(value));
  keys(r, ['schemaVersion', 'projectId', 'runId', 'revision', 'phase', 'baselineAuthorityDigest', 'state', 'ledgerDigest',
    'generationDigest', 'approvedAuthorityDigest', 'recordDigest']);
  if (r.schemaVersion !== 'buildlore.wiki-workflow-run.v1' || r.runId !== runId || !/^run-[a-f0-9]{64}$/u.test(runId) ||
    typeof r.revision !== 'number' || !Number.isSafeInteger(r.revision) || r.revision < 0) invalid();
  const phase = choice(r.phase, ['writing', 'finalized', 'approved']);
  if ((phase === 'writing') !== (r.ledgerDigest === null) || (phase === 'writing') !== (r.generationDigest === null) ||
    (phase === 'approved') !== (r.approvedAuthorityDigest !== null)) invalid();
  const state = record(r.state);
  if (state.projectId !== projectId || state.runId !== runId) invalid();
  // Source-bound semantic replay follows immediately after the confined store read.
  const next = freezeRun({ schemaVersion: 'buildlore.wiki-workflow-run.v1', projectId: project(r.projectId, projectId), runId,
    revision: r.revision, phase, baselineAuthorityDigest: r.baselineAuthorityDigest === null ? null : hash(r.baselineAuthorityDigest),
    state: state as unknown as KnowledgeWikiState, ledgerDigest: r.ledgerDigest === null ? null : hash(r.ledgerDigest),
    generationDigest: r.generationDigest === null ? null : hash(r.generationDigest),
    approvedAuthorityDigest: r.approvedAuthorityDigest === null ? null : hash(r.approvedAuthorityDigest) });
  if (digest(r) !== digest(next)) invalid();
  return next;
}
function nextRun(run: WikiRun, updates: Partial<WikiRun>): WikiRun {
  const { recordDigest: _, ...basis } = run; void _;
  return freezeRun({ ...basis, ...updates, revision: run.revision + 1 });
}
function authorityDigest(authority: CurrentApprovedWikiAuthority): KnowledgeDigest {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(authority)).digest('hex')}`;
}

/** Generic writing uses the same confined source planner, history and publication authority. */
export function createProjectWikiWorkflow(options: Readonly<{ hubRoot: string; knowledgeRoot: string;
  jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[] }>) {
  const hubRoot = resolve(options.hubRoot), knowledgeRoot = resolve(options.knowledgeRoot);
  const store = createHierarchyPayloadStore(hubRoot, parseRun), corpus = createApprovedWikiProjectionStore(knowledgeRoot);
  const historyStore = createKnowledgeGenerationHistoryStore({ knowledgeRoot });
  const readInput = async (path: string, projectId: string): Promise<unknown> =>
    parseJsonStrict(await readConfinedSessionUtf8(resolve(hubRoot, path), hubRoot, 8 * 1024 * 1024, projectId));
  const baseline = async (projectId: string): Promise<CurrentApprovedWikiAuthority | null> => {
    const status = await corpus.status(projectId);
    if (status.state === 'invalid') invalid();
    return status.state === 'none' ? null : corpus.readAuthority(projectId);
  };
  const prepare = async (projectId: string, purposeValue: unknown, runId: string, previous: CurrentApprovedWikiAuthority | null, saved?: unknown) => {
    const purpose = parseKnowledgeWikiPurpose(purposeValue, projectId);
    const { session: base } = await preparePlannedKnowledgeSession({ ...options, hubRoot, knowledgeRoot, projectId,
      outputLanguage: purpose.outputLanguage, rendererVersion: 'knowledge-markdown-v3', authoringMode: 'wiki-v1',
      ...(previous?.knowledgeGeneration?.schemaVersion === 'buildlore.knowledge-authority-extension.v2'
        ? { previousHistory: knowledgeAuthorityHistory(previous.knowledgeGeneration) }
        : { previousGenerations: previous?.knowledgeGeneration?.generations ?? [] }) });
    const session = await createKnowledgeWikiSession(base, purpose, runId, saved);
    return { session, instructions: [...base.exchange.instructions,
      ...(purpose.template === 'development' ? ['Selected development template: consider purpose, usage, design, decisions and verification where supported by the sources. Page names and count remain author-selected.'] : [])] };
  };
  const restore = async (run: WikiRun) => {
    const previous = await baseline(run.projectId);
    if ((previous === null ? null : authorityDigest(previous)) !== run.baselineAuthorityDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
    return { previous, ...await prepare(run.projectId, run.state.purpose, run.runId, previous, run.state) };
  };
  const view = (run: WikiRun, session: Awaited<ReturnType<typeof prepare>>['session']) => ({
    schemaVersion: 'buildlore.wiki-workflow-status.v1', projectId: run.projectId, runId: run.runId, revision: run.revision,
    phase: run.phase === 'writing' ? session.view().phase : run.phase, stage: session.view(),
    generationDigest: run.generationDigest, ledgerDigest: run.ledgerDigest, active: false, egress: 'none', processSpawned: false });
  const bridgeFor = (generation: KnowledgeGenerationV1, previous: CurrentApprovedWikiAuthority | null) =>
    bridgeKnowledgeToHierarchy({ knowledgeRoot, generation, baselineGenerationDigest: previous?.state.generationDigest ?? null,
      baselineProposals: previous?.finalization.proposals ?? [] });
  const expect = (run: WikiRun, stage: KnowledgeDigest): void => {
    if (stage !== run.state.stateDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
  };
  return Object.freeze({
    async start(projectId: string, purposeFile: string) {
      const previous = await baseline(projectId), runId = `run-${randomBytes(32).toString('hex')}`;
      const { session, instructions } = await prepare(projectId, await readInput(purposeFile, projectId), runId, previous);
      const run = freezeRun({ schemaVersion: 'buildlore.wiki-workflow-run.v1', projectId, runId, revision: 0, phase: 'writing',
        baselineAuthorityDigest: previous === null ? null : authorityDigest(previous), state: session.state(),
        ledgerDigest: null, generationDigest: null, approvedAuthorityDigest: null });
      await store.create(run);
      return { ...view(run, session), instructions };
    },
    async status(projectId: string, runId: string) {
      const run = await store.read(projectId, runId), current = await baseline(projectId);
      if (run.phase === 'approved' && current !== null && authorityDigest(current) === run.approvedAuthorityDigest) return {
        schemaVersion: 'buildlore.wiki-workflow-status.v1', projectId, runId, revision: run.revision, phase: 'approved',
        generationDigest: run.generationDigest, ledgerDigest: run.ledgerDigest, active: true, egress: 'none', processSpawned: false };
      const { session, instructions } = await restore(run);
      return { ...view(run, session), instructions };
    },
    async inspect(projectId: string, runId: string, inputFile: string, stage: KnowledgeDigest) {
      const run = await store.read(projectId, runId); expect(run, stage);
      const { session } = await restore(run);
      return session.inspect(await readInput(inputFile, projectId), stage);
    },
    async submit(projectId: string, runId: string, inputFile: string, stage: KnowledgeDigest, revise = false) {
      const run = await store.read(projectId, runId); expect(run, stage);
      if (run.phase !== 'writing' || revise !== (run.state.revisions.length > 0)) invalid();
      const { session } = await restore(run), input = await readInput(inputFile, projectId);
      if (revise) {
        const r = record(input); keys(r, ['schemaVersion', 'projectId', 'draft', 'resolutions']);
        if (r.schemaVersion !== 'buildlore.wiki-revision.v1') invalid();
        project(r.projectId, projectId);
        await session.submit(r.draft, r.resolutions, stage);
      } else await session.submit(input, [], stage);
      const next = nextRun(run, { state: session.state() });
      await store.replace(run, next); return view(next, session);
    },
    async review(projectId: string, runId: string, inputFile: string, stage: KnowledgeDigest) {
      const run = await store.read(projectId, runId); expect(run, stage);
      if (run.phase !== 'writing') invalid();
      const { session } = await restore(run);
      await session.review(await readInput(inputFile, projectId), stage);
      const next = nextRun(run, { state: session.state() });
      await store.replace(run, next); return view(next, session);
    },
    async finalize(projectId: string, runId: string, stage: KnowledgeDigest) {
      const run = await store.read(projectId, runId); expect(run, stage);
      if (run.phase === 'approved') invalid();
      const { session, previous } = await restore(run), generation = await session.finalize(stage);
      const bridge = await bridgeFor(generation, previous), ledger = finalizeCompileRun(bridge.finalization, projectId, bridge.reviewedQuality);
      if (run.phase === 'finalized') {
        if (run.ledgerDigest !== ledger.ledgerDigest || run.generationDigest !== generation.generationDigest) invalid();
        return view(run, session);
      }
      const next = nextRun(run, { phase: 'finalized', generationDigest: generation.generationDigest, ledgerDigest: ledger.ledgerDigest });
      await store.replace(run, next); return view(next, session);
    },
    async approve(projectId: string, runId: string, expectedLedger: KnowledgeDigest, confirmed: boolean) {
      const run = await store.read(projectId, runId);
      if (confirmed !== true || run.phase === 'writing' || run.ledgerDigest !== expectedLedger) invalid();
      const { session, previous } = await restore(run), generation = await session.finalize(run.state.stateDigest);
      const bridge = await bridgeFor(generation, previous), ledger = finalizeCompileRun(bridge.finalization, projectId, bridge.reviewedQuality);
      if (ledger.ledgerDigest !== expectedLedger || generation.generationDigest !== run.generationDigest) throw new ProjectKnowledgeError('KNOWLEDGE_DRIFT');
      const authority = await approveKnowledgeWikiHistoryAuthority({ generation, store: historyStore, bridge, previousAuthority: previous, explicitConfirmation: true });
      const next = run.phase === 'approved' ? run : nextRun(run, { phase: 'approved', approvedAuthorityDigest: authorityDigest(authority) });
      if (next.approvedAuthorityDigest !== authorityDigest(authority)) invalid();
      await store.replace(run, next, authority);
      return { ...view(next, session), activationArgs: ['compile', 'activate', '--project', projectId, '--input', store.activationPath(projectId, runId),
        '--confirm-approval', authority.humanActivationApproval.approvalDigest] };
    },
  });
}
