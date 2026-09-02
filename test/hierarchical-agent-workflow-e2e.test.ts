import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type CurrentSessionGenerationExchangeV1,
  type CurrentSessionProposalSubmissionV1,
} from '../src/compiler/index.js';
import { runCli, type CliEnvelopeV1, type CliIo } from '../src/cli/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  createSourceManagement,
  initializeSingleProjectQuickstart,
} from '../src/projector/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = 'hierarchy-cycle';
const roots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], {
    cwd,
    env: { ...process.env, LC_ALL: 'C' },
  });
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
}

async function fixture(): Promise<Readonly<{ readonly hubRoot: string }>> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-hierarchy-agent-cycle-'));
  roots.push(root);
  const origin = join(root, 'knowledge.git');
  const seed = join(root, 'knowledge-seed');
  const sourceRoot = join(root, 'source');
  const hubRoot = join(root, 'hub');
  await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', origin, seed]);
  await configureIdentity(seed);
  await writeFile(join(seed, 'README.md'), '# Knowledge\n', 'utf8');
  await git(seed, ['add', 'README.md']);
  await git(seed, ['commit', '-m', 'seed knowledge']);
  await git(seed, ['push', 'origin', 'main']);
  await Promise.all([mkdir(sourceRoot), mkdir(hubRoot)]);
  await git(sourceRoot, ['init', '--initial-branch=main']);
  await configureIdentity(sourceRoot);
  await mkdir(join(sourceRoot, 'docs'));
  await Promise.all([
    writeFile(
      join(sourceRoot, 'docs/leaf.md'),
      'Leaf evidence explains that sanitized local source bytes remain bound to exact ' +
        'citation anchors before any reviewed Wiki candidate can advance.\n',
      'utf8',
    ),
    writeFile(
      join(sourceRoot, 'docs/root.md'),
      'Root evidence explains that explicit child review, integrated quality inspection, ' +
        'human approval, and activation remain separate local steps.\n',
      'utf8',
    ),
    writeFile(
      join(sourceRoot, 'docs/operations.txt'),
      'Operational text evidence explains that a restarted local command must replay the ' +
        'same sanitized corpus identity before it accepts a proposal or changes Wiki authority.\n',
      'utf8',
    ),
    writeFile(
      join(sourceRoot, 'docs/authority.ts'),
      '/** Code evidence keeps review and activation as distinct explicit authority steps. */\n' +
        'export function mayActivate(reviewAccepted: boolean, humanApproved: boolean): boolean {\n' +
        '  return reviewAccepted && humanApproved;\n' +
        '}\n',
      'utf8',
    ),
  ]);
  await git(sourceRoot, ['add', '.']);
  await git(sourceRoot, ['commit', '-m', 'seed hierarchy sources']);
  await initializeSingleProjectQuickstart(hubRoot, {
    branch: 'main',
    knowledgeRepository: '../knowledge.git',
    projectId: PROJECT_ID,
    sourceRepository: `https://example.test/${PROJECT_ID}.git`,
    sourceRoot,
  });
  await writeSecurityPolicy(join(hubRoot, 'knowledge'), PROJECT_ID, {
    capabilities: ['compile'],
  });
  const sources = createSourceManagement({ hubRoot });
  await sources.add({
    id: 'leaf',
    kind: 'markdown',
    path: 'docs/leaf.md',
    projectId: PROJECT_ID,
  });
  await sources.add({
    id: 'root',
    kind: 'markdown',
    path: 'docs/root.md',
    projectId: PROJECT_ID,
  });
  await sources.add({
    id: 'operations',
    kind: 'text',
    path: 'docs/operations.txt',
    projectId: PROJECT_ID,
  });
  await sources.add({
    id: 'authority-code',
    kind: 'code',
    path: 'docs/authority.ts',
    projectId: PROJECT_ID,
  });
  await mkdir(join(hubRoot, 'handoffs'));
  return Object.freeze({ hubRoot });
}

interface Invocation {
  readonly envelope: CliEnvelopeV1;
  readonly exitCode: number;
  readonly raw: string;
}

async function invoke(hubRoot: string, args: readonly string[]): Promise<Invocation> {
  let stderr = '';
  let stdout = '';
  const io: CliIo = {
    stderr: (message) => { stderr += message; },
    stdout: (message) => { stdout += message; },
  };
  // A fresh runtime object deliberately models a new CLI process for every lifecycle step.
  const exitCode = await runCli([...args, '--json'], io, { cwd: hubRoot });
  const raw = exitCode === 0 ? stdout : stderr;
  return Object.freeze({
    envelope: JSON.parse(raw) as CliEnvelopeV1,
    exitCode,
    raw,
  });
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Missing ${label}.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: unknown, key: string): string {
  const item = record(value, key)[key];
  if (typeof item !== 'string') throw new Error(`Missing ${key}.`);
  return item;
}

function exchangeFromStatus(value: unknown): CurrentSessionGenerationExchangeV1 {
  const status = record(value, 'status');
  const exchange = status.currentExchange;
  if (typeof exchange !== 'object' || exchange === null || Array.isArray(exchange)) {
    throw new Error('Missing current exchange.');
  }
  return exchange as CurrentSessionGenerationExchangeV1;
}

function authorProposal(
  exchange: CurrentSessionGenerationExchangeV1,
): CurrentSessionProposalSubmissionV1 {
  const firstUnit = exchange.evidencePack.units[0];
  if (firstUnit === undefined) throw new Error('Exchange has no bounded evidence unit.');
  const roleVocabulary = exchange.writingBrief.role === 'overview'
    ? 'landscape navigation governance sequence synthesis portfolio orientation'
    : 'focused detail implementation trace inspection verification mechanics boundary';
  const evidenceText = exchange.evidencePack.units.map((unit) =>
    `${unit.content} [^${unit.citation.citationId}]`).join(' ');
  const childText = exchange.request.approvedChildSummaries.map((summary) =>
    `${summary.summary} ${summary.citationIds.map((citationId) =>
      `[^${citationId}]`).join(' ')}`).join(' ');
  const linkText = exchange.request.requiredLinkPageIds.map((pageId) =>
    `[[${pageId}]]`).join(' ');
  const questions = exchange.writingBrief.keyQuestions.join(' ');
  const sections = exchange.request.requiredSections.map((sectionId, index) => ({
    sectionId,
    body: [
      questions,
      `The reviewed ${sectionId} section provides ${roleVocabulary} grounded in exact local claims:`,
      evidenceText,
      index === 0 ? childText : '',
      index === 0 ? linkText : '',
    ].filter((part) => part.length > 0).join(' '),
  }));
  return Object.freeze({
    schemaVersion: 'buildlore.current-session-proposal-submission.v1',
    projectId: exchange.projectId,
    pageId: exchange.pageId,
    exchangeDigest: exchange.exchangeDigest,
    requestDigest: exchange.requestDigest,
    title: exchange.writingBrief.title,
    summary: firstUnit.content,
    sections: Object.freeze(sections.map((section) => Object.freeze(section))),
    claims: Object.freeze(exchange.evidencePack.units.map((unit) => Object.freeze({
      text: unit.content,
      evidenceUnitIds: Object.freeze([unit.unitId]),
      citationIds: Object.freeze([unit.citation.citationId]),
    }))),
    wikilinks: exchange.request.requiredLinkPageIds,
  });
}

async function writeHandoff(hubRoot: string, name: string, value: unknown): Promise<string> {
  const relativePath = `handoffs/${name}.json`;
  await writeFile(join(hubRoot, relativePath), serializeCanonicalJson(value), 'utf8');
  return relativePath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('current-agent hierarchical Wiki product cycle', () => {
  it('runs sync through explicit activation and active Wiki reads across restart-safe CLI steps', async () => {
    const current = await fixture();
    const synchronized = await invoke(current.hubRoot, ['sync', '--project', PROJECT_ID]);
    expect(synchronized.exitCode).toBe(0);
    expect(synchronized.envelope.data).toMatchObject({ appliedCount: 4, projectId: PROJECT_ID });

    const purposePath = await writeHandoff(current.hubRoot, 'purpose', {
      schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v1',
      projectId: PROJECT_ID,
      audience: ['Maintainers'],
      goals: ['Create a reviewable local hierarchy from synchronized evidence'],
      keyQuestions: ['How does local evidence remain bound through explicit Wiki activation?'],
      scopeHints: ['Sanitized local evidence and deterministic review lineage'],
      excludedTopics: ['Hosted agents and automatic approval'],
      outputLanguage: 'en',
      requestedPageRoles: ['overview', 'topic'],
    });
    const started = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'start', '--project', PROJECT_ID, '--purpose', purposePath,
    ]);
    expect(started.exitCode, started.raw).toBe(0);
    const runId = stringField(started.envelope.data, 'runId');
    expect(runId).toMatch(/^run-[0-9a-f]{64}$/u);
    let status = record(record(started.envelope.data, 'start result').status, 'start status');
    let step = 0;
    let wrongExchangeChecked = false;
    while (status.nextAction === 'submit-proposal' || status.nextAction === 'review-child') {
      step += 1;
      if (step > 20) throw new Error('Hierarchy workflow did not converge.');
      if (status.nextAction === 'submit-proposal') {
        const exchange = exchangeFromStatus(status);
        expect(exchange.boundary).toEqual({
          buildloreInitiatedEgress: 'none',
          disclosureScope: 'sanitized-evidence-only',
          generationActor: 'current-agent-session',
          processSpawned: false,
          providerUsed: null,
        });
        const proposalPath = await writeHandoff(
          current.hubRoot,
          `proposal-${String(step).padStart(2, '0')}`,
          authorProposal(exchange),
        );
        if (!wrongExchangeChecked) {
          const before = status.revision;
          const mismatch = await invoke(current.hubRoot, [
            'compile', 'hierarchy', 'submit', '--project', PROJECT_ID, '--run', runId,
            '--input', proposalPath, '--expect-exchange', `sha256:${'0'.repeat(64)}`,
          ]);
          expect(mismatch.exitCode).toBe(3);
          const unchanged = await invoke(current.hubRoot, [
            'compile', 'hierarchy', 'status', '--project', PROJECT_ID, '--run', runId,
          ]);
          expect(unchanged.exitCode, unchanged.raw).toBe(0);
          expect(record(unchanged.envelope.data, 'unchanged status').revision).toBe(before);
          wrongExchangeChecked = true;
        }
        const submitted = await invoke(current.hubRoot, [
          'compile', 'hierarchy', 'submit', '--project', PROJECT_ID, '--run', runId,
          '--input', proposalPath, '--expect-exchange', exchange.exchangeDigest,
        ]);
        expect(submitted.exitCode).toBe(0);
        status = record(record(submitted.envelope.data, 'submit result').status, 'submit status');
      } else {
        const childReview = record(status.childReview, 'child review');
        const reviewPath = await writeHandoff(current.hubRoot, `child-review-${step}`, {
          schemaVersion: 'buildlore.hierarchical-workflow-child-review-input.v1',
          projectId: PROJECT_ID,
          runId,
          pageId: stringField(childReview, 'pageId'),
          reviewViewDigest: stringField(childReview, 'reviewViewDigest'),
          decision: 'accepted',
          reasonCodes: [],
        });
        const reviewed = await invoke(current.hubRoot, [
          'compile', 'hierarchy', 'child-review', '--project', PROJECT_ID, '--run', runId,
          '--input', reviewPath, '--expect-review', stringField(childReview, 'reviewViewDigest'),
        ]);
        expect(reviewed.exitCode).toBe(0);
        status = record(record(reviewed.envelope.data, 'child result').status, 'child status');
      }
    }
    expect(status).toMatchObject({
      nextAction: 'review-integrated-wiki',
      phase: 'review-ready',
      processSpawned: false,
      providerUsed: null,
    });

    const reviewResult = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'review', '--project', PROJECT_ID, '--run', runId,
    ]);
    expect(reviewResult.exitCode).toBe(0);
    const review = record(reviewResult.envelope.data, 'integrated review');
    const surface = record(review.surface, 'integrated surface');
    expect(surface.hardQualityPassed, JSON.stringify(surface)).toBe(true);
    const candidates = surface.candidates;
    const relations = review.relationCandidates;
    if (!Array.isArray(candidates) || !Array.isArray(relations)) {
      throw new Error('Integrated review candidates are unavailable.');
    }
    const finalReviewPath = await writeHandoff(current.hubRoot, 'final-review', {
      schemaVersion: 'buildlore.hierarchical-workflow-finalize-input.v1',
      projectId: PROJECT_ID,
      runId,
      reviewDigest: stringField(review, 'reviewDigest'),
      surfaceDigest: stringField(surface, 'surfaceDigest'),
      candidateDecisions: candidates.map((candidate) => ({
        decision: 'accepted',
        pageId: stringField(candidate, 'pageId'),
        reasonCodes: [],
      })).sort((left, right) => left.pageId.localeCompare(right.pageId)),
      relationDecisions: relations.map((relation) => ({
        decision: 'accepted',
        relationId: stringField(relation, 'relationId'),
      })).sort((left, right) => left.relationId.localeCompare(right.relationId)),
    });
    const finalized = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'finalize', '--project', PROJECT_ID, '--run', runId,
      '--input', finalReviewPath, '--expect-review', stringField(review, 'reviewDigest'),
    ]);
    expect(finalized.exitCode).toBe(0);
    const ledger = record(record(finalized.envelope.data, 'finalized result').ledger, 'ledger');
    expect(ledger.eligibleForApproval).toBe(true);
    const ledgerDigest = stringField(ledger, 'ledgerDigest');

    const beforeWrongApproval = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'status', '--project', PROJECT_ID, '--run', runId,
    ]);
    const wrongApproval = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'approve', '--project', PROJECT_ID, '--run', runId,
      '--expect-ledger', `sha256:${'0'.repeat(64)}`, '--confirm-approval',
    ]);
    expect(wrongApproval.exitCode).toBe(3);
    expect(wrongApproval.envelope.errors).toMatchObject([
      { code: 'HIERARCHICAL_WORKFLOW_EXPECTATION_MISMATCH' },
    ]);
    expect(wrongApproval.raw).not.toContain(ledgerDigest);
    const afterWrongApproval = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'status', '--project', PROJECT_ID, '--run', runId,
    ]);
    expect(record(afterWrongApproval.envelope.data, 'status').revision).toBe(
      record(beforeWrongApproval.envelope.data, 'status').revision,
    );
    const missingConfirmation = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'approve', '--project', PROJECT_ID, '--run', runId,
      '--expect-ledger', ledgerDigest,
    ]);
    expect(missingConfirmation.exitCode).toBe(2);

    const approved = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'approve', '--project', PROJECT_ID, '--run', runId,
      '--expect-ledger', ledgerDigest, '--confirm-approval',
    ]);
    expect(approved.exitCode).toBe(0);
    const approval = record(approved.envelope.data, 'approval');
    expect(approval).toMatchObject({
      egress: 'none',
      processSpawned: false,
      providerUsed: null,
    });
    const beforeActivation = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'status', '--project', PROJECT_ID, '--run', runId,
    ]);
    expect(beforeActivation.envelope.data).toMatchObject({
      activationState: 'awaiting-activation',
      nextAction: 'activate-approved-wiki',
    });

    const wrongActivation = await invoke(current.hubRoot, [
      'compile', 'activate', '--project', PROJECT_ID,
      '--input', stringField(approval, 'activationBundlePath'),
      '--confirm-approval', `sha256:${'0'.repeat(64)}`,
    ]);
    expect(wrongActivation.exitCode).toBe(3);
    const stillAwaiting = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'status', '--project', PROJECT_ID, '--run', runId,
    ]);
    expect(stillAwaiting.envelope.data).toMatchObject({
      activationState: 'awaiting-activation',
      nextAction: 'activate-approved-wiki',
    });

    const activated = await invoke(current.hubRoot, [
      'compile', 'activate', '--project', PROJECT_ID,
      '--input', stringField(approval, 'activationBundlePath'),
      '--confirm-approval', stringField(approval, 'approvalDigest'),
    ]);
    expect(activated.exitCode).toBe(0);
    expect(record(activated.envelope.data, 'activation result')).toMatchObject({
      egress: 'none',
      projectId: PROJECT_ID,
      providerUsed: 'none',
    });
    const activeStatus = await invoke(current.hubRoot, [
      'compile', 'hierarchy', 'status', '--project', PROJECT_ID, '--run', runId,
    ]);
    expect(activeStatus.envelope.data).toMatchObject({
      activationState: 'active',
      authorityCheckStatus: 'clean',
      nextAction: 'none',
      phase: 'approved',
    });

    const listed = await invoke(current.hubRoot, ['wiki', 'list', '--project', PROJECT_ID]);
    expect(listed.exitCode).toBe(0);
    const pages = record(listed.envelope.data, 'page list').pages;
    if (!Array.isArray(pages) || pages.length < 1) throw new Error('Active pages are unavailable.');
    const activePageIds = pages.map((page) => stringField(page, 'pageId'));
    const pageId = stringField(pages[0], 'pageId');
    const read = await invoke(current.hubRoot, [
      'wiki', 'read', '--project', PROJECT_ID, '--page', pageId,
    ]);
    const citations = await invoke(current.hubRoot, [
      'wiki', 'citations', '--project', PROJECT_ID, '--page', pageId,
    ]);
    expect(read.exitCode).toBe(0);
    expect(citations.exitCode).toBe(0);
    expect(read.envelope.data).toMatchObject({ pageId, projectId: PROJECT_ID, status: 'active' });
    expect(citations.envelope.data).toMatchObject({ pageId, projectId: PROJECT_ID });
    const citationItems = record(citations.envelope.data, 'citations').citations;
    if (!Array.isArray(citationItems) || citationItems.length < 1) {
      throw new Error('Active page citations are unavailable.');
    }
    expect(citationItems.every((citation) =>
      typeof record(citation, 'citation').citationId === 'string')).toBe(true);
    for (const mode of ['lexical', 'graph'] as const) {
      const searched = await invoke(current.hubRoot, [
        'search', '--project', PROJECT_ID,
        '--query', 'explicit reviewed local activation evidence', '--mode', mode,
      ]);
      expect(searched.exitCode).toBe(0);
      expect(searched.envelope.data).toMatchObject({
        egress: 'none',
        projectId: PROJECT_ID,
        providerUsed: 'none',
        requestedMode: mode,
      });
      const hits = record(searched.envelope.data, `${mode} search`).hits;
      if (!Array.isArray(hits)) throw new Error(`${mode} search hits are unavailable.`);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((hit) => activePageIds.includes(
        stringField(record(hit, 'search hit').locator, 'pageId'),
      ))).toBe(true);
    }
  }, 120_000);
});
