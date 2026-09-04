import { lstat, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCompilationPurpose,
} from '../src/compiler/index.js';
import {
  createHierarchicalWorkflowRunRecord,
  createHierarchicalWorkflowRunStore,
  type CreateHierarchicalWorkflowRunRecordInputV1,
  type HierarchicalWorkflowRunRecordV1,
} from '../src/cli/hierarchical-run-store.js';
import {
  HIERARCHICAL_WORKFLOW_CHILD_REVIEW_INPUT_SCHEMA_VERSION,
  HIERARCHICAL_WORKFLOW_FINALIZE_INPUT_SCHEMA_VERSION,
  HIERARCHICAL_WORKFLOW_PURPOSE_INPUT_SCHEMA_VERSION,
  HierarchicalWorkflowError,
} from '../src/cli/hierarchical-workflow.js';
import type { ApprovedWikiAuthorityV1 } from '../src/retrieval/index.js';
import {
  authorHierarchicalWorkflowProposal,
  createHierarchicalWorkflowTestFixture,
  type HierarchicalWorkflowTestFixtureV1,
} from './helpers/hierarchical-workflow-fixture.js';

const fixtures: HierarchicalWorkflowTestFixtureV1[] = [];

function reviseRecord(
  record: HierarchicalWorkflowRunRecordV1,
  overrides: Partial<CreateHierarchicalWorkflowRunRecordInputV1> = {},
): HierarchicalWorkflowRunRecordV1 {
  return createHierarchicalWorkflowRunRecord({
    projectId: record.projectId,
    runId: record.runId,
    revision: record.revision + 1,
    phase: record.phase,
    purpose: record.purpose,
    baselineAuthorityDigest: record.baselineAuthorityDigest,
    baselineState: record.baselineState,
    baselineProposals: record.baselineProposals,
    startDigests: record.startDigests,
    submissions: record.submissions,
    resubmissions: record.resubmissions,
    childDecisions: record.childDecisions,
    integratedDecisions: record.integratedDecisions,
    relationDecisions: record.relationDecisions,
    rejection: record.rejection,
    approvalDecision: record.approvalDecision,
    pendingExchangeDigest: record.pendingExchangeDigest,
    pendingChildReviewDigest: record.pendingChildReviewDigest,
    pendingReviewDigest: record.pendingReviewDigest,
    pendingLedgerDigest: record.pendingLedgerDigest,
    ...overrides,
  });
}

function runDirectory(current: HierarchicalWorkflowTestFixtureV1, runId: string): string {
  return join(current.hubRoot, '.buildlore', 'hierarchy-runs', current.projectId, runId);
}

async function storedRecord(
  current: HierarchicalWorkflowTestFixtureV1,
  runId: string,
): Promise<HierarchicalWorkflowRunRecordV1> {
  return createHierarchicalWorkflowRunStore(current.hubRoot).read(current.projectId, runId);
}

function definitelyDeadPid(): number {
  for (const candidate of [2_147_483_647, 999_999_937, 99_999_937]) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('Unable to identify a definitely absent local PID.');
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<HierarchicalWorkflowTestFixtureV1> {
  const current = await createHierarchicalWorkflowTestFixture();
  fixtures.push(current);
  return current;
}

async function start(current: HierarchicalWorkflowTestFixtureV1) {
  const purposeFile = await current.writeJson('purpose.json', {
    schemaVersion: HIERARCHICAL_WORKFLOW_PURPOSE_INPUT_SCHEMA_VERSION,
    projectId: current.projectId,
    audience: ['Maintainers'],
    goals: ['Explain restart safe local Wiki approval'],
    keyQuestions: ['How does local evidence remain reviewable before Wiki activation?'],
    scopeHints: ['Receipt bound local workflow'],
    excludedTopics: ['Hosted agents'],
    outputLanguage: 'en',
    requestedPageRoles: ['overview'],
  });
  return current.createService().start(current.projectId, purposeFile);
}

async function advanceToIntegratedReview(
  current: HierarchicalWorkflowTestFixtureV1,
  mutate: (submission: ReturnType<typeof authorHierarchicalWorkflowProposal>, index: number) =>
    ReturnType<typeof authorHierarchicalWorkflowProposal> = (submission) => submission,
) {
  const started = await start(current);
  let status = started.status;
  let index = 0;
  while (status.currentExchange !== null) {
    const exchange = status.currentExchange;
    const submission = mutate(authorHierarchicalWorkflowProposal(exchange), index);
    const input = await current.writeJson(`advance-${String(index)}.json`, submission);
    status = (await (status.nextAction === 'resubmit-proposal'
      ? current.createService().resubmit(
          current.projectId,
          started.runId,
          exchange.pageId,
          input,
          exchange.exchangeDigest,
        )
      : current.createService().submit(
          current.projectId,
          started.runId,
          input,
          exchange.exchangeDigest,
        ))).status;
    if (status.childReview !== null) {
      const child = status.childReview;
      const decision = await current.writeJson(`advance-child-${String(index)}.json`, {
        schemaVersion: HIERARCHICAL_WORKFLOW_CHILD_REVIEW_INPUT_SCHEMA_VERSION,
        projectId: current.projectId,
        runId: started.runId,
        pageId: child.pageId,
        reviewViewDigest: child.reviewViewDigest,
        decision: 'accepted',
        reasonCodes: [],
      });
      status = (await current.createService().childReview(
        current.projectId,
        started.runId,
        decision,
        child.reviewViewDigest,
      )).status;
    }
    index += 1;
  }
  return Object.freeze({
    runId: started.runId,
    review: await current.createService().review(current.projectId, started.runId),
  });
}

async function finalizeAccepted(current: HierarchicalWorkflowTestFixtureV1) {
  const { runId, review } = await advanceToIntegratedReview(current);
  const input = await current.writeJson('accepted-finalization.json', {
    schemaVersion: HIERARCHICAL_WORKFLOW_FINALIZE_INPUT_SCHEMA_VERSION,
    projectId: current.projectId,
    runId,
    reviewDigest: review.reviewDigest,
    surfaceDigest: review.surface.surfaceDigest,
    candidateDecisions: review.surface.candidates.map((candidate) => ({
      decision: 'accepted',
      pageId: candidate.pageId,
      reasonCodes: [],
    })).sort((left, right) => left.pageId < right.pageId ? -1 : 1),
    relationDecisions: review.relationCandidates.map((relation) => ({
      decision: 'accepted',
      relationId: relation.relationId,
    })).sort((left, right) => left.relationId < right.relationId ? -1 : 1),
  });
  const finalized = await current.createService().finalize(
    current.projectId,
    runId,
    input,
    review.reviewDigest,
  );
  if (finalized.ledger === null) throw new Error('Expected an accepted finalized ledger.');
  return Object.freeze({ runId, ledger: finalized.ledger });
}

describe('restart-safe hierarchical workflow service', () => {
  it('accepts distinct P2A projections derived from the same selected artifact', async () => {
    const current = await createHierarchicalWorkflowTestFixture(
      'hierarchy-shared-artifact',
      (plan) => {
        const first = plan.sources[0];
        const second = plan.sources[1];
        if (first === undefined || second === undefined) {
          throw new Error('Expected two planned sources.');
        }
        return Object.freeze({
          ...plan,
          sources: Object.freeze([
            first,
            Object.freeze({ ...second, sourceRef: first.sourceRef }),
          ]),
        });
      },
    );
    fixtures.push(current);

    const started = await start(current);

    expect(started.status.currentExchange).not.toBeNull();
    expect(current.plannerCalls).toEqual([current.projectId]);
  });

  it('packs substantive body passages with exact diverse citations instead of title headings',
    async () => {
      const current = await fixture();
      const started = await start(current);
      const exchange = started.status.currentExchange;
      if (exchange === null) throw new Error('Expected exchange.');
      const units = exchange.evidencePack.units;
      expect(new Set(units.map((unit) => unit.sourceId)).size).toBe(1);
      expect(units.length).toBeGreaterThanOrEqual(1);
      for (const unit of units) {
        expect(unit.content).not.toMatch(/^#/u);
        expect(unit.content.length).toBeGreaterThan(24);
        expect(unit.range).toEqual(unit.citation.range);
        expect(unit.range).toMatchObject({
          endLine: 3,
          startColumn: 1,
          startLine: 3,
        });
        expect(unit.range.endColumn).toBe([...unit.content].length);
        expect(unit.contentDigest).toBe(unit.citation.quoteDigest);
        expect(unit.citation.sourceRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);
      }
    });

  it('restarts for every explicit agent and human step through a clean activated authority',
    async () => {
      const current = await fixture();
      let started = await start(current);
      expect(started.runId).toMatch(/^run-[0-9a-f]{64}$/u);
      expect(started.status).toMatchObject({
        activationState: 'not-approved',
        nextAction: 'submit-proposal',
        phase: 'awaiting-proposal',
        providerUsed: null,
        processSpawned: false,
      });
      const runId = started.runId;
      while (started.status.currentExchange !== null) {
        const exchange = started.status.currentExchange;
        const submissionFile = await current.writeJson(
          `submission-${exchange.pageId}.json`,
          authorHierarchicalWorkflowProposal(exchange),
        );
        const beforeMismatch = current.plannerCalls.length;
        await expect(current.createService().submit(
          current.projectId,
          runId,
          'missing.json',
          `sha256:${'f'.repeat(64)}`,
        )).rejects.toMatchObject({
          code: 'HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH',
        });
        expect(current.plannerCalls).toHaveLength(beforeMismatch);
        const submitted = await current.createService().submit(
          current.projectId,
          runId,
          submissionFile,
          exchange.exchangeDigest,
        );
        started = { ...started, status: submitted.status };
        if (started.status.childReview !== null) {
          const child = started.status.childReview;
          const decisionFile = await current.writeJson(`child-${child.pageId}.json`, {
            schemaVersion: HIERARCHICAL_WORKFLOW_CHILD_REVIEW_INPUT_SCHEMA_VERSION,
            projectId: current.projectId,
            runId,
            pageId: child.pageId,
            reviewViewDigest: child.reviewViewDigest,
            decision: 'accepted',
            reasonCodes: [],
          });
          const reviewed = await current.createService().childReview(
            current.projectId,
            runId,
            decisionFile,
            child.reviewViewDigest,
          );
          started = { ...started, status: reviewed.status };
        }
      }
      expect(started.status.phase).toBe('review-ready');
      const review = await current.createService().review(current.projectId, runId);
      expect({
        corpus: review.surface.reasonCodes,
        pages: review.surface.candidates.map((candidate) => ({
          pageId: candidate.pageId,
          reasons: candidate.pageQualityReport.reasonCodes,
        })),
      }).toEqual({ corpus: [], pages: review.surface.candidates.map((candidate) => ({
        pageId: candidate.pageId, reasons: [],
      })) });
      expect(review.surface).toMatchObject({
        hardQualityPassed: true,
        eligibleForHumanAcceptance: true,
      });
      const finalizeFile = await current.writeJson('finalize.json', {
        schemaVersion: HIERARCHICAL_WORKFLOW_FINALIZE_INPUT_SCHEMA_VERSION,
        projectId: current.projectId,
        runId,
        reviewDigest: review.reviewDigest,
        surfaceDigest: review.surface.surfaceDigest,
        candidateDecisions: review.surface.candidates.map((candidate) => ({
          decision: 'accepted',
          pageId: candidate.pageId,
          reasonCodes: [],
        })).sort((left, right) => left.pageId < right.pageId ? -1 : 1),
        relationDecisions: review.relationCandidates.map((relation) => ({
          decision: 'accepted',
          relationId: relation.relationId,
        })).sort((left, right) => left.relationId < right.relationId ? -1 : 1),
      });
      const finalized = await current.createService().finalize(
        current.projectId,
        runId,
        finalizeFile,
        review.reviewDigest,
      );
      expect(finalized).toMatchObject({
        phase: 'finalized',
        ledger: { eligibleForApproval: true, status: 'finalized' },
      });
      const ledger = finalized.ledger;
      if (ledger === null) throw new Error('Expected finalized ledger.');
      const approved = await current.createService().approve(
        current.projectId,
        runId,
        ledger.ledgerDigest,
        true,
      );
      expect(approved).toMatchObject({
        egress: 'none',
        projectId: current.projectId,
        providerUsed: null,
        processSpawned: false,
      });
      expect(approved.activationBundlePath).toBe(
        `.buildlore/hierarchy-runs/${current.projectId}/${runId}/approved-wiki.json`,
      );
      expect(approved.activationArgs).toEqual([
        'compile', 'activate', '--project', current.projectId, '--input',
        approved.activationBundlePath, '--confirm-approval', approved.approvalDigest,
      ]);
      const bundle = JSON.parse(await readFile(
        join(current.hubRoot, approved.activationBundlePath),
        'utf8',
      )) as { readonly authority: ApprovedWikiAuthorityV1 };
      await current.corpusStore.publish({ authority: bundle.authority, projectId: current.projectId });
      await expect(current.createService().status(current.projectId, runId)).resolves.toMatchObject({
        activationState: 'active',
        authorityCheckStatus: 'clean',
        phase: 'approved',
      });
    });

  it('fails preflight on absolute paths without planning or mutating the run', async () => {
    const current = await fixture();
    const started = await start(current);
    const exchange = started.status.currentExchange;
    if (exchange === null) throw new Error('Expected exchange.');
    const relativeInput = await current.writeJson(
      'existing-absolute-submission.json',
      authorHierarchicalWorkflowProposal(exchange),
    );
    const calls = current.plannerCalls.length;
    await expect(current.createService().submit(
      current.projectId,
      started.runId,
      join(current.hubRoot, relativeInput),
      exchange.exchangeDigest,
    )).rejects.toBeInstanceOf(HierarchicalWorkflowError);
    expect(current.plannerCalls).toHaveLength(calls);
    await expect(current.createService().status(current.projectId, started.runId))
      .resolves.toMatchObject({ phase: 'awaiting-proposal', revision: 0 });
  });

  it('records an explicit child rejection as terminal without auto-reviewing it', async () => {
    const current = await fixture();
    const started = await start(current);
    const exchange = started.status.currentExchange;
    if (exchange === null) throw new Error('Expected exchange.');
    const submissionFile = await current.writeJson(
      'child-rejection-submission.json',
      authorHierarchicalWorkflowProposal(exchange),
    );
    const submitted = await current.createService().submit(
      current.projectId,
      started.runId,
      submissionFile,
      exchange.exchangeDigest,
    );
    const child = submitted.status.childReview;
    if (child === null) throw new Error('Expected child review.');
    const decisionFile = await current.writeJson('child-rejection.json', {
      schemaVersion: HIERARCHICAL_WORKFLOW_CHILD_REVIEW_INPUT_SCHEMA_VERSION,
      projectId: current.projectId,
      runId: started.runId,
      pageId: child.pageId,
      reviewViewDigest: child.reviewViewDigest,
      decision: 'rejected',
      reasonCodes: ['human-rejected'],
    });
    const rejected = await current.createService().childReview(
      current.projectId,
      started.runId,
      decisionFile,
      child.reviewViewDigest,
    );
    expect(rejected.status).toMatchObject({
      phase: 'rejected',
      nextAction: 'none',
      currentExchange: null,
      childReview: null,
      ledger: null,
      rejection: { kind: 'child-review-rejected', reasonCodes: ['human-rejected'] },
    });
    await expect(current.createService().status(current.projectId, started.runId))
      .resolves.toMatchObject({ phase: 'rejected', nextAction: 'none' });
  });

  it('re-sanitizes a digest-valid persisted purpose before replay without leaking it', async () => {
    const current = await fixture();
    const started = await start(current);
    const record = await storedRecord(current, started.runId);
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890AB';
    const unsafePurpose = createCompilationPurpose({
      audience: record.purpose.audience,
      excludedTopics: record.purpose.excludedTopics,
      goals: Object.freeze([`Recover ${secret}`]),
      keyQuestions: record.purpose.keyQuestions,
      outputLanguage: record.purpose.outputLanguage,
      projectId: record.projectId,
      requestedPageRoles: record.purpose.requestedPageRoles,
      scopeHints: record.purpose.scopeHints,
    });
    const tampered = reviseRecord(record, { purpose: unsafePurpose, revision: record.revision });
    await writeFile(
      join(runDirectory(current, started.runId), 'run.json'),
      `${JSON.stringify(tampered, null, 2)}\n`,
      { mode: 0o600 },
    );
    const plannerCalls = current.plannerCalls.length;
    let caught: unknown;
    try {
      await current.createService().status(current.projectId, started.runId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_INPUT_INVALID' });
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(current.plannerCalls).toHaveLength(plannerCalls);
  });

  it('rejects a symlinked run record before planning', async () => {
    const current = await fixture();
    const started = await start(current);
    const runPath = runDirectory(current, started.runId);
    const recordPath = join(runPath, 'run.json');
    const target = join(runPath, 'record-target.json');
    await writeFile(target, await readFile(recordPath), { mode: 0o600 });
    await unlink(recordPath);
    await symlink(target, recordPath);
    const plannerCalls = current.plannerCalls.length;
    await expect(current.createService().status(current.projectId, started.runId))
      .rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_INVALID' });
    expect(current.plannerCalls).toHaveLength(plannerCalls);
  });

  it('recovers only a canonical dead-local-PID lock and removes it after mutation', async () => {
    const current = await fixture();
    const started = await start(current);
    const record = await storedRecord(current, started.runId);
    const next = reviseRecord(record, {
      pendingExchangeDigest: `sha256:${'a'.repeat(64)}`,
    });
    const lockPath = join(runDirectory(current, started.runId), 'run.lock');
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 'buildlore.hierarchical-workflow-run-lock.v1',
      hostname: hostname(),
      pid: definitelyDeadPid(),
      token: 'b'.repeat(64),
    }, null, 2)}\n`, { mode: 0o600 });
    const store = createHierarchicalWorkflowRunStore(current.hubRoot);
    await store.replace({
      expectedRecordDigest: record.recordDigest,
      expectedRevision: record.revision,
      next,
      projectId: current.projectId,
      runId: started.runId,
    });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.read(current.projectId, started.runId)).resolves.toEqual(next);
  });

  it('snapshots CAS scalars before awaiting and refuses a concurrent revision overwrite',
    async () => {
      const current = await fixture();
      const started = await start(current);
      const record = await storedRecord(current, started.runId);
      const nextA = reviseRecord(record, {
        pendingExchangeDigest: `sha256:${'a'.repeat(64)}`,
      });
      const nextB = reviseRecord(record, {
        pendingExchangeDigest: `sha256:${'b'.repeat(64)}`,
      });
      let enterLock: () => void = () => {};
      let releaseLock: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enterLock = resolve; });
      const released = new Promise<void>((resolve) => { releaseLock = resolve; });
      const pausedStore = createHierarchicalWorkflowRunStore(current.hubRoot, {
        beforeLockOpen() {
          enterLock();
          return released;
        },
      });
      const otherStore = createHierarchicalWorkflowRunStore(current.hubRoot);
      const mutableInput = {
        expectedRecordDigest: record.recordDigest,
        expectedRevision: record.revision,
        next: nextA,
        projectId: current.projectId,
        runId: started.runId,
      };
      const pausedWrite = pausedStore.replace(mutableInput);
      await entered;
      await otherStore.replace({
        expectedRecordDigest: record.recordDigest,
        expectedRevision: record.revision,
        next: nextB,
        projectId: current.projectId,
        runId: started.runId,
      });
      mutableInput.expectedRecordDigest = nextB.recordDigest;
      mutableInput.expectedRevision = nextB.revision;
      releaseLock();
      await expect(pausedWrite).rejects.toMatchObject({
        code: 'HIERARCHICAL_WORKFLOW_RUN_CONFLICT',
      });
      await expect(otherStore.read(current.projectId, started.runId)).resolves.toEqual(nextB);
    });

  it('keeps live, foreign-host, and malformed locks busy without changing the run', async () => {
    const current = await fixture();
    const started = await start(current);
    const record = await storedRecord(current, started.runId);
    const next = reviseRecord(record, {
      pendingExchangeDigest: `sha256:${'c'.repeat(64)}`,
    });
    const lockPath = join(runDirectory(current, started.runId), 'run.lock');
    const store = createHierarchicalWorkflowRunStore(current.hubRoot);
    const lockBodies = [
      `${JSON.stringify({
        schemaVersion: 'buildlore.hierarchical-workflow-run-lock.v1',
        hostname: hostname(),
        pid: process.pid,
        token: 'c'.repeat(64),
      }, null, 2)}\n`,
      `${JSON.stringify({
        schemaVersion: 'buildlore.hierarchical-workflow-run-lock.v1',
        hostname: `foreign-${hostname()}`,
        pid: definitelyDeadPid(),
        token: 'd'.repeat(64),
      }, null, 2)}\n`,
      'not-json\n',
    ];
    for (const body of lockBodies) {
      await writeFile(lockPath, body, { flag: 'wx', mode: 0o600 });
      await expect(store.replace({
        expectedRecordDigest: record.recordDigest,
        expectedRevision: record.revision,
        next,
        projectId: current.projectId,
        runId: started.runId,
      })).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_RUN_BUSY' });
      await expect(store.read(current.projectId, started.runId)).resolves.toEqual(record);
      await unlink(lockPath);
    }
  });

  it('recovers an approved record whose activation bundle commit failed and retries exactly',
    async () => {
      const current = await fixture();
      const { runId, ledger } = await finalizeAccepted(current);
      let failBundleCommit = true;
      const faultingStore = createHierarchicalWorkflowRunStore(current.hubRoot, {
        beforeActivationBundleCommit() {
          if (!failBundleCommit) return;
          failBundleCommit = false;
          throw new Error('simulated activation bundle interruption');
        },
      });
      await expect(current.createService(faultingStore).approve(
        current.projectId,
        runId,
        ledger.ledgerDigest,
        true,
      )).rejects.toThrow('simulated activation bundle interruption');
      const bundlePath = join(runDirectory(current, runId), 'approved-wiki.json');
      await expect(lstat(bundlePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(current.createService().status(current.projectId, runId))
        .resolves.toMatchObject({
          activationState: 'not-approved',
          nextAction: 'approve-activation',
          phase: 'approved',
        });
      const committed = await storedRecord(current, runId);
      expect(committed.phase).toBe('approved');
      expect(Number.isSafeInteger(committed.revision)).toBe(true);
      const retried = await current.createService().approve(
        current.projectId,
        runId,
        ledger.ledgerDigest,
        true,
      );
      expect((await lstat(bundlePath)).isFile()).toBe(true);
      await expect(current.createService().status(current.projectId, runId))
        .resolves.toMatchObject({
          activationState: 'awaiting-activation',
          nextAction: 'activate-approved-wiki',
          phase: 'approved',
        });
      expect(retried.activationBundleDigest).toBe(
        committed.approvalDecision?.activationBundleDigest,
      );
    });

  it('finalizes an explicit integrated rejection as ineligible and refuses approval', async () => {
    const current = await fixture();
    const { runId, review } = await advanceToIntegratedReview(current);
    expect(review.surface.hardQualityPassed).toBe(true);
    const decisions = review.surface.candidates.map((candidate, index) => ({
      decision: index === 0 ? 'rejected' as const : 'accepted' as const,
      pageId: candidate.pageId,
      reasonCodes: index === 0 ? ['human-rejected'] : [],
    })).sort((left, right) => left.pageId < right.pageId ? -1 : 1);
    const input = await current.writeJson('integrated-rejected.json', {
      schemaVersion: HIERARCHICAL_WORKFLOW_FINALIZE_INPUT_SCHEMA_VERSION,
      projectId: current.projectId,
      runId,
      reviewDigest: review.reviewDigest,
      surfaceDigest: review.surface.surfaceDigest,
      candidateDecisions: decisions,
      relationDecisions: review.relationCandidates.map((relation) => ({
        decision: 'accepted', relationId: relation.relationId,
      })).sort((left, right) => left.relationId < right.relationId ? -1 : 1),
    });
    const finalized = await current.createService().finalize(
      current.projectId,
      runId,
      input,
      review.reviewDigest,
    );
    expect(finalized).toMatchObject({
      phase: 'finalized', ledger: { eligibleForApproval: false }, rejection: null,
    });
    const ledger = finalized.ledger;
    if (ledger === null) throw new Error('Expected ineligible ledger.');
    await expect(current.createService().approve(
      current.projectId,
      runId,
      ledger.ledgerDigest,
      true,
    )).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_INELIGIBLE' });
    await expect(current.createService().status(current.projectId, runId)).resolves.toMatchObject({
      phase: 'finalized', ledger: { eligibleForApproval: false }, nextAction: 'none',
    });
  });

  it('resubmits only the failed page and replays the corrected proposal byte-identically',
    async () => {
      const current = await fixture();
      const started = await start(current);
      const initialExchange = started.status.currentExchange;
      if (initialExchange === null) throw new Error('Expected exchange.');
      const failedFile = await current.writeJson('failed-page.json', {
        ...authorHierarchicalWorkflowProposal(initialExchange),
        title: 'Deliberately ungrounded title',
      });
      const failed = await current.createService().submit(
        current.projectId,
        started.runId,
        failedFile,
        initialExchange.exchangeDigest,
      );
      const retryExchange = failed.status.currentExchange;
      if (retryExchange === null) throw new Error('Expected retry exchange.');
      expect(failed.status).toMatchObject({
        phase: 'hard-quality-failed', nextAction: 'resubmit-proposal',
      });
      expect(retryExchange).toMatchObject({
        pageId: initialExchange.pageId,
        request: { generationAttempt: 1 },
      });
      const correctedFile = await current.writeJson(
        'corrected-page.json',
        authorHierarchicalWorkflowProposal(retryExchange),
      );
      const corrected = await current.createService().resubmit(
        current.projectId,
        started.runId,
        retryExchange.pageId,
        correctedFile,
        retryExchange.exchangeDigest,
      );
      expect(corrected.status).toMatchObject({
        phase: 'awaiting-child-review', nextAction: 'review-child', rejection: null,
      });
      const persisted = await storedRecord(current, started.runId);
      expect(persisted.submissions).toHaveLength(1);
      expect(persisted.resubmissions).toHaveLength(1);
      expect(persisted.resubmissions[0]).toMatchObject({
        attempt: 1,
        outcome: {
          kind: 'accepted',
          reasonCodes: [],
        },
        pageId: initialExchange.pageId,
        proposalDigest: corrected.proposalDigest,
      });
      expect(persisted.resubmissions[0]?.outcome.pageQualityReportDigest)
        .toMatch(/^sha256:[0-9a-f]{64}$/u);
      const replayed = await current.createService().status(current.projectId, started.runId);
      expect(replayed).toEqual(corrected.status);

      const altered = reviseRecord(persisted, {
        resubmissions: Object.freeze(persisted.resubmissions.map((entry) => Object.freeze({
          ...entry,
          outcome: Object.freeze({
            ...entry.outcome,
            pageQualityReportDigest: entry.expectedExchangeDigest,
          }),
        }))),
      });
      const store = createHierarchicalWorkflowRunStore(current.hubRoot);
      await store.replace({
        expectedRecordDigest: persisted.recordDigest,
        expectedRevision: persisted.revision,
        next: altered,
        projectId: current.projectId,
        runId: started.runId,
      });
      await expect(current.createService().status(current.projectId, started.runId))
        .rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_REPLAY_MISMATCH' });
    });

  it('keeps hard-quality attempts append-only and rejects after three resubmissions', async () => {
    const current = await fixture();
    const started = await start(current);
    const initialExchange = started.status.currentExchange;
    if (initialExchange === null) throw new Error('Expected exchange.');
    const invalidSubmission = (exchange: typeof initialExchange) => Object.freeze({
      ...authorHierarchicalWorkflowProposal(exchange),
      title: 'Deliberately ungrounded title',
    });
    const initialFile = await current.writeJson(
      'hard-quality-initial.json',
      invalidSubmission(initialExchange),
    );
    let status = (await current.createService().submit(
      current.projectId,
      started.runId,
      initialFile,
      initialExchange.exchangeDigest,
    )).status;
    expect(status).toMatchObject({
      phase: 'hard-quality-failed', nextAction: 'resubmit-proposal',
      rejection: { kind: 'hard-quality-failed', surfaceDigest: null },
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const exchange = status.currentExchange;
      if (exchange === null) throw new Error('Expected retry exchange.');
      expect(exchange.request.generationAttempt).toBe(attempt);
      const file = await current.writeJson(
        `hard-quality-retry-${String(attempt)}.json`,
        invalidSubmission(exchange),
      );
      status = (await current.createService().resubmit(
        current.projectId,
        started.runId,
        exchange.pageId,
        file,
        exchange.exchangeDigest,
      )).status;
    }
    expect(status).toMatchObject({
      phase: 'rejected', nextAction: 'none', currentExchange: null,
      rejection: { kind: 'hard-quality-failed', surfaceDigest: null },
    });
    const record = await storedRecord(current, started.runId);
    expect(record.submissions).toHaveLength(1);
    expect(record.resubmissions.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
    expect(record.resubmissions.map((entry) => entry.outcome.kind)).toEqual([
      'hard-quality-failed', 'hard-quality-failed', 'hard-quality-failed',
    ]);
    await expect(current.createService().status(current.projectId, started.runId))
      .resolves.toMatchObject({ phase: 'rejected', nextAction: 'none' });
    await expect(current.createService().resubmit(
      current.projectId,
      started.runId,
      initialExchange.pageId,
      initialFile,
      initialExchange.exchangeDigest,
    )).rejects.toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_PHASE_MISMATCH' });
  });

  it('rejects resubmission audit history that moves backward between pages', async () => {
    const current = await fixture();
    const { runId } = await advanceToIntegratedReview(current, (submission, index) =>
      index % 2 === 0
        ? Object.freeze({ ...submission, title: 'Deliberately ungrounded title' })
        : submission);
    const record = await storedRecord(current, runId);
    expect(record.resubmissions.length).toBeGreaterThan(1);

    expect(() => reviseRecord(record, {
      resubmissions: Object.freeze([...record.resubmissions].reverse()),
    })).toThrow(expect.objectContaining({ code: 'HIERARCHICAL_WORKFLOW_RUN_INVALID' }));
  });

  it('hard-fails a suspected secret in purpose without persisting the value', async () => {
    const current = await fixture();
    const secret = 'ghp_123456789012345678901234567890123456';
    const purposeFile = await current.writeJson('secret-purpose.json', {
      schemaVersion: HIERARCHICAL_WORKFLOW_PURPOSE_INPUT_SCHEMA_VERSION,
      projectId: current.projectId,
      audience: ['Maintainers'],
      goals: [`Document ${secret}`],
      keyQuestions: ['How is local evidence reviewed?'],
      scopeHints: [],
      excludedTopics: ['Hosted agents'],
      outputLanguage: 'en',
      requestedPageRoles: ['overview'],
    });
    let caught: unknown;
    try {
      await current.createService().start(current.projectId, purposeFile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'HIERARCHICAL_WORKFLOW_INPUT_INVALID' });
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(current.plannerCalls).toEqual([]);
  });
});
