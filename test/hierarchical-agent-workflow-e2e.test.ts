import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseCurrentSessionProposalSubmission,
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

const MARKDOWN_SOURCES = Object.freeze([
  Object.freeze({
    id: 'payments',
    path: 'docs/payments.md',
    title: 'Payment Processing',
    topic: 'Payment Requests',
    focus: 'idempotent payment request validation and durable authorization state',
  }),
  Object.freeze({
    id: 'incidents',
    path: 'docs/incidents.md',
    title: 'Incident Response',
    topic: 'Outage Rollback',
    focus: 'isolated outage rollback checkpoints and observable recovery decisions',
  }),
  Object.freeze({
    id: 'security',
    path: 'docs/security.md',
    title: 'Security Boundaries',
    topic: 'Sanitized Evidence',
    focus: 'sanitizer-approved evidence and value-free rejection boundaries',
  }),
  Object.freeze({
    id: 'retrieval',
    path: 'docs/retrieval.md',
    title: 'Local Retrieval',
    topic: 'Semantic Index',
    focus: 'local lexical graph and derived semantic index retrieval',
  }),
  Object.freeze({
    id: 'lifecycle',
    path: 'docs/lifecycle.md',
    title: 'Review Lifecycle',
    topic: 'Approval and Activation',
    focus: 'separate review finalize human approval and activation transitions',
  }),
]);

function markdownSourceBody(source: typeof MARKDOWN_SOURCES[number]): string {
  return [
    `# ${source.title}`,
    '',
    `## ${source.topic}`,
    '',
    ...Array.from({ length: 12 }, (_, index) => [
      `${source.topic} evidence ${String(index + 1)} explains ${source.focus} while keeping ` +
        'the synchronized local source, review lineage, and explicit Wiki activation verifiable.',
      '',
    ]).flat(),
  ].join('\n');
}

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

async function fixture(): Promise<Readonly<{
  readonly hubRoot: string;
  readonly sourceCount: number;
}>> {
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
    ...MARKDOWN_SOURCES.map((source) => writeFile(
      join(sourceRoot, source.path),
      markdownSourceBody(source),
      'utf8',
    )),
    writeFile(
      join(sourceRoot, 'docs/authority.ts'),
      Array.from({ length: 10 }, (_, index) => [
        `export function authorityStep${String(index + 1)}(reviewed: boolean): boolean {`,
        `  // Authority step ${String(index + 1)} preserves explicit local review and activation.`,
        '  return reviewed;',
        '}',
      ].join('\n')).join('\n\n') + '\n',
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
  for (const source of MARKDOWN_SOURCES) {
    await sources.add({
      id: source.id,
      kind: 'markdown',
      path: source.path,
      projectId: PROJECT_ID,
    });
  }
  await sources.add({
    id: 'authority-code',
    kind: 'code',
    path: 'docs/authority.ts',
    projectId: PROJECT_ID,
  });
  await mkdir(join(hubRoot, 'handoffs'));
  return Object.freeze({ hubRoot, sourceCount: MARKDOWN_SOURCES.length + 1 });
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
  const primaryCitation = `[^${firstUnit.citation.citationId}]`;
  const childText = exchange.request.approvedChildSummaries.map((summary) =>
    `${exchange.writingBrief.title} incorporates ${summary.summary} ${summary.citationIds.map((citationId) =>
      `[^${citationId}]`).join(' ')}`).join(' ');
  const linkText = exchange.request.requiredLinkPageIds.map((pageId) =>
    `[[${pageId}]]`).join(' ');
  const questions = exchange.writingBrief.keyQuestions.join(' ');
  const claimedSourceIds = new Set<string>();
  const claimedUnits = exchange.evidencePack.units.filter((unit) => {
    if (exchange.writingBrief.role === 'topic') return true;
    if (claimedSourceIds.has(unit.sourceId)) return false;
    claimedSourceIds.add(unit.sourceId);
    return true;
  });
  const claims = claimedUnits.map((unit) => Object.freeze({
    text: `${unit.content.replace(/\s+/gu, ' ').trim()} — ${exchange.writingBrief.title}`,
    evidenceUnitIds: Object.freeze([unit.unitId]),
    citationIds: Object.freeze([unit.citation.citationId]),
  }));
  const renderedClaims = claims.map((claim) =>
    `${claim.text} [^${claim.citationIds[0]}]`).join('\n\n');
  const sections = exchange.request.requiredSections.map((sectionId, index) => ({
    sectionId,
    body: index === 0
      ? [
          `The ${exchange.writingBrief.title} ${sectionId} section answers ${questions} ` +
            `through ${roleVocabulary}. ` +
            `${primaryCitation} ${linkText}`,
          childText,
          renderedClaims,
        ].filter((part) => part.length > 0).join('\n\n')
      : `The ${exchange.writingBrief.title} ${sectionId} view connects reviewed ` +
          `${roleVocabulary} to ${questions} ` +
          `without changing the approved evidence boundary. ${primaryCitation}`,
  }));
  return Object.freeze({
    schemaVersion: 'buildlore.current-session-proposal-submission.v2',
    projectId: exchange.projectId,
    pageId: exchange.pageId,
    exchangeDigest: exchange.exchangeDigest,
    requestDigest: exchange.requestDigest,
    title: exchange.writingBrief.title,
    summary: `Summary: ${claims[0]?.text ?? ''}`,
    sections: Object.freeze(sections.map((section) => Object.freeze(section))),
    claims: Object.freeze(claims),
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
    expect(synchronized.envelope.data).toMatchObject({
      appliedCount: current.sourceCount,
      projectId: PROJECT_ID,
    });

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
      wikiTitle: 'BuildLore Operations Wiki',
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
    const firstExchanges = new Map<string, CurrentSessionGenerationExchangeV1>();
    const resubmittedPageIds = new Set<string>();
    while (status.nextAction === 'submit-proposal' ||
        status.nextAction === 'resubmit-proposal' || status.nextAction === 'review-child') {
      step += 1;
      if (step > 30) throw new Error('Hierarchy workflow did not converge.');
      if (status.nextAction === 'submit-proposal' ||
          status.nextAction === 'resubmit-proposal') {
        const exchange = exchangeFromStatus(status);
        if (!firstExchanges.has(exchange.pageId)) firstExchanges.set(exchange.pageId, exchange);
        if (status.nextAction === 'resubmit-proposal') resubmittedPageIds.add(exchange.pageId);
        expect(Buffer.byteLength(serializeCanonicalJson(exchange), 'utf8'))
          .toBeLessThanOrEqual(512 * 1024);
        expect(exchange.evidencePack.units.length).toBeLessThanOrEqual(64);
        const exchangeSourceCounts = new Map<string, number>();
        for (const unit of exchange.evidencePack.units) {
          exchangeSourceCounts.set(unit.sourceId, (exchangeSourceCounts.get(unit.sourceId) ?? 0) + 1);
        }
        expect(exchangeSourceCounts.size).toBeLessThanOrEqual(8);
        expect([...exchangeSourceCounts.values()].every((count) => count <= 8)).toBe(true);
        expect(exchange.boundary).toEqual({
          buildloreInitiatedEgress: 'none',
          disclosureScope: 'sanitized-evidence-only',
          generationActor: 'current-agent-session',
          processSpawned: false,
          providerUsed: null,
        });
        const proposal = authorProposal(exchange);
        expect(() => parseCurrentSessionProposalSubmission(proposal, {
          projectId: exchange.projectId,
          pageId: exchange.pageId,
          exchangeDigest: exchange.exchangeDigest,
          requestDigest: exchange.requestDigest,
        })).not.toThrow();
        const proposalPath = await writeHandoff(
          current.hubRoot,
          `proposal-${String(step).padStart(2, '0')}`,
          proposal,
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
        const submitted = await invoke(current.hubRoot, status.nextAction === 'submit-proposal'
          ? [
              'compile', 'hierarchy', 'submit', '--project', PROJECT_ID, '--run', runId,
              '--input', proposalPath, '--expect-exchange', exchange.exchangeDigest,
            ]
          : [
              'compile', 'hierarchy', 'resubmit', '--project', PROJECT_ID, '--run', runId,
              '--page', exchange.pageId, '--input', proposalPath,
              '--expect-exchange', exchange.exchangeDigest,
            ]);
        expect(submitted.exitCode, submitted.raw).toBe(0);
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
    expect(status, JSON.stringify(status)).toMatchObject({
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
    expect(candidates.length / current.sourceCount).toBeGreaterThanOrEqual(1);
    expect(firstExchanges.size).toBe(candidates.length);
    expect((candidates.length - resubmittedPageIds.size) / candidates.length)
      .toBeGreaterThanOrEqual(0.8);
    const evidenceCounts = [...firstExchanges.values()].map((exchange) =>
      exchange.evidencePack.units.length);
    expect(evidenceCounts.reduce((sum, count) => sum + count, 0) / evidenceCounts.length)
      .toBeGreaterThanOrEqual(12);
    let selectedUnitCount = 0;
    let inScopeUnitCount = 0;
    let identicalSummaryCount = 0;
    for (const candidateValue of candidates) {
      const candidate = record(candidateValue, 'quality candidate');
      const blueprint = record(candidate.blueprint, 'quality blueprint');
      const proposal = record(candidate.proposal, 'quality proposal');
      const quality = record(candidate.pageQualityReport, 'page quality report');
      expect(quality.hardQualityPassed).toBe(true);
      const pageId = stringField(candidate, 'pageId');
      const exchange = firstExchanges.get(pageId);
      if (exchange === undefined) throw new Error('Missing first exchange.');
      const scope = record(blueprint.evidenceScope, 'evidence scope');
      const preferred = new Set(Array.isArray(scope.preferredUnitIds)
        ? scope.preferredUnitIds.filter((unitId): unitId is string => typeof unitId === 'string')
        : []);
      const scopedSources = new Set(Array.isArray(scope.sourceIds)
        ? scope.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === 'string')
        : []);
      selectedUnitCount += exchange.evidencePack.units.length;
      inScopeUnitCount += exchange.evidencePack.units.filter((unit) =>
        preferred.size > 0 ? preferred.has(unit.unitId) : scopedSources.has(unit.sourceId)).length;
      const claims = proposal.claims;
      const summary = proposal.summary;
      if (Array.isArray(claims) && typeof summary === 'string' && claims.some((claim) =>
        record(claim, 'quality claim').text === summary)) identicalSummaryCount += 1;
      expect([stringField(blueprint, 'title')]).not.toEqual(['overview']);
      expect(stringField(blueprint, 'title')).not.toBe('topic');
    }
    expect(inScopeUnitCount / selectedUnitCount).toBeGreaterThanOrEqual(0.8);
    expect(identicalSummaryCount / candidates.length).toBeLessThanOrEqual(0.2);
    const paymentExchange = [...firstExchanges.values()].find((exchange) =>
      exchange.writingBrief.title.includes('Payment Requests'));
    expect(paymentExchange?.evidencePack.units[0]?.citation.sourceRef).toBe('docs/payments.md');
    expect(paymentExchange?.evidencePack.units.every((unit) =>
      unit.citation.sourceRef !== 'docs/incidents.md')).toBe(true);
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
    expect(activeStatus.exitCode, activeStatus.raw).toBe(0);
    expect(activeStatus.envelope.data, activeStatus.raw).toMatchObject({
      activationState: 'active',
      authorityCheckStatus: 'clean',
      nextAction: 'none',
      phase: 'approved',
    });
    const markdownRoot = join(
      current.hubRoot,
      'knowledge',
      'projects',
      PROJECT_ID,
      'wiki',
      'buildlore-hierarchy',
    );
    const manifest = record(
      JSON.parse(await readFile(join(markdownRoot, 'manifest.json'), 'utf8')) as unknown,
      'Markdown manifest',
    );
    expect(manifest).toMatchObject({
      pageCount: candidates.length,
      schemaVersion: 'buildlore.hierarchical-markdown-materialization-manifest.v2',
    });
    const manifestFiles = manifest.files;
    if (!Array.isArray(manifestFiles)) throw new Error('Markdown files are unavailable.');
    const pageFiles = manifestFiles.filter((file) => record(file, 'manifest file').kind === 'page');
    expect(pageFiles).toHaveLength(candidates.length);
    const candidateByPageId = new Map(candidates.map((candidate) => {
      const value = record(candidate, 'quality candidate');
      return [stringField(value, 'pageId'), value] as const;
    }));
    const sectionTitles: Readonly<Record<string, string>> = Object.freeze({
      evidence: 'Evidence',
      goals: 'Goals',
      'related-topics': 'Related topics',
      summary: 'Summary',
      'topic-map': 'Topic map',
    });
    for (const fileValue of pageFiles) {
      const file = record(fileValue, 'page manifest file');
      const citationMap = file.citationMap;
      if (!Array.isArray(citationMap)) throw new Error('Citation map is unavailable.');
      expect(citationMap.map((entry) => record(entry, 'citation map entry').number))
        .toEqual(Array.from({ length: citationMap.length }, (_, index) => index + 1));
      const body = await readFile(join(markdownRoot, stringField(file, 'path')), 'utf8');
      expect(body).toContain('[^1]');
      const candidate = candidateByPageId.get(stringField(file, 'pageId'));
      if (candidate === undefined) throw new Error('Rendered candidate is unavailable.');
      const blueprint = record(candidate.blueprint, 'rendered blueprint');
      const requiredSections = blueprint.requiredSections;
      if (!Array.isArray(requiredSections)) throw new Error('Required sections are unavailable.');
      const offsets = requiredSections.map((sectionId) => {
        if (typeof sectionId !== 'string') throw new Error('Section id is unavailable.');
        const title = sectionTitles[sectionId];
        if (title === undefined) throw new Error('Localized section title is unavailable.');
        return body.indexOf(`## ${title}`);
      });
      expect(offsets.every((offset) => offset >= 0)).toBe(true);
      expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    }
    expect((await readdir(markdownRoot)).sort()).toEqual([
      'index.md',
      'manifest.json',
      ...pageFiles.map((file) => stringField(file, 'path')),
    ].sort());

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
