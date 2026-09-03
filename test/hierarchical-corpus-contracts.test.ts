import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_COMPILATION_LIMITS,
  HIERARCHICAL_COMPILATION_POLICY,
  HierarchyContractError,
  createCompilationPurpose,
  createCorpusSnapshot,
  createDocumentInterpretation,
  createTextUnit,
  digestHierarchyValue,
  evaluateSemanticQuality,
  hierarchySha256,
  parseCompilationPurpose,
  parseCorpusSnapshot,
  parseDocumentInterpretation,
  parseHierarchicalCompilationPolicy,
  parseTextUnit,
  type CompilationPurposeV1,
  type CorpusSnapshotSourceV1,
  type EvidencePackV1,
  type HierarchicalWikiProposalV1,
  type PageBlueprintV1,
  type SessionPlannedSource,
  type TextUnitV1,
  type WikiLinkReconciliationV1,
  type WikiOutlineV1,
} from '../src/compiler/index.js';
import { SESSION_COMPILE_LIMITS } from '../src/compiler/session/contracts.js';
import { createSessionTasksAndMerges } from '../src/compiler/session/planner-pure.js';
import { addProject, validateProjectId } from '../src/knowledge/index.js';
import { validatePortableSourceRef } from '../src/projector/index.js';
import { consumePreparedSource } from '../src/sanitizer/approval.js';
import {
  createProjectSecurityService,
  type ProjectSecurityService,
  type SanitizationReport,
} from '../src/sanitizer/index.js';
import { createApprovedAuthorityFixture } from './helpers/hierarchical-authority-fixture.js';

const HISTORICAL_PLANNER_COMMIT = '945e42507bdeaac8fe96bdfca3d05cca6401e8f2' as const;
const HISTORICAL_APPROVAL_COMMIT = '8b2d5c2bc2ea11d3b82289a94a4139711a283249' as const;
const HISTORICAL_PLAN_SCHEMA_VERSION = 'buildlore.compile-plan.v1' as const;
const HISTORICAL_ALGORITHM_VERSION = 'buildlore.session-planner.v1' as const;
const HISTORICAL_CONTRACT_DIGEST =
  'sha256:98607df63979a55c5756374ac3dc60c0525638ad004b82ff2924ed198a58aa39' as const;
const HISTORICAL_GLOBAL_MERGE_LIMIT = 512;
const ENTRY_SNAPSHOT_DIGEST =
  'sha256:6cb331cd3e723d76680bc5c5d879f44727941c372631be7d352f12162edfae74' as const;
const NEGATIVE_FIXTURE_FILE_DIGEST =
  'sha256:f6c11df4c44c314d3d034c4df8789c89d0a11fa9176581cd533df833b6027bbf';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GIT_SHA1_PATTERN = /^[a-f0-9]{40}$/u;

interface HistoricalSourceFile {
  readonly path: string;
  readonly gitBlobSha1: string;
  readonly sha256: `sha256:${string}`;
}

const HISTORICAL_PLANNER_FILES: readonly HistoricalSourceFile[] = Object.freeze([
  Object.freeze({
    path: 'src/compiler/session/contracts.ts',
    gitBlobSha1: 'eaa61c72b92a1b9fa8f9e09fb75cc522160c1cda',
    sha256: 'sha256:bb427bb9fccd85fe5ca988fe20586cb76d4f56a37b9901396628bb5e98301110',
  }),
  Object.freeze({
    path: 'src/compiler/session/planner-pure.ts',
    gitBlobSha1: '8ba65302e2257b8f309775e08696f94c785fcb78',
    sha256: 'sha256:23c2b0d20ec4b4e66e5e0b794e939647c13d86096d5fd60e26342861bb5fe090',
  }),
  Object.freeze({
    path: 'src/compiler/session/types.ts',
    gitBlobSha1: '197e150a4ab97fdbefa9963135d720a6d249635c',
    sha256: 'sha256:8465c9e0ad2dfcf67d755fd6bdf94a83ee2a062a06c6c970e2eddc1d35474f9a',
  }),
]);

const HISTORICAL_APPROVAL_FILES: readonly HistoricalSourceFile[] = Object.freeze([
  Object.freeze({
    path: 'src/compiler/backend.ts',
    gitBlobSha1: '817563aa6bed7bdbbf573612a38e9477cf8da44a',
    sha256: 'sha256:e3c8d1b552ddecb0d313702114002d8b50452891fad8e83e6c6f11889a39bf52',
  }),
  Object.freeze({
    path: 'src/compiler/check.ts',
    gitBlobSha1: '818b7bdfdef4706b2406fe025fb6fab0339d1769',
    sha256: 'sha256:cc0ae02a4179503cb2a59fecebae0679232d71ef2659b518d4428adcdcbb5dac',
  }),
  Object.freeze({
    path: 'src/compiler/session/review-service.ts',
    gitBlobSha1: '2c6c094c1e256b67bffd2e00a52c89715f83bf6f',
    sha256: 'sha256:4aa1e9f303de03c798508d37317f2d4f1658518bb39887a06794e491128e4f1b',
  }),
  Object.freeze({
    path: 'src/compiler/session/review-store.ts',
    gitBlobSha1: 'aea9db4ee0f0fc24bbde79d5a1ac1d16618b2ca9',
    sha256: 'sha256:18b18190e03427c1375395fe74e647e13be2b3009bbc4d5bab1d4c408adc6e4d',
  }),
]);

interface HistoricalPlannerFailure {
  readonly schemaVersion: 'buildlore.historical-planner-failure.v1';
  readonly candidateOrdinal: 513;
  readonly candidateCountBeforeFailure: 512;
  readonly error: Readonly<{
    readonly candidateRefs: readonly [];
    readonly code: 'SESSION_PLAN_DENIED';
    readonly message: 'Session compile input was rejected safely.';
    readonly projectId: string;
    readonly recoveryAction: 'check-config';
    readonly retryable: false;
    readonly sideEffectsPossible: false;
  }>;
}

interface ExpectedLegacyApprovalCheck {
  readonly schemaVersion: 'buildlore.historical-approve-check-expectation.v1';
  readonly claimId: 'entry.problem.approval-state-disconnect';
  readonly approvalOutcome: 'approved';
  readonly providerUsed: false;
  readonly sideEffectsPossible: false;
  readonly checkExitCode: 5;
  readonly gateCodes: readonly ['pending-changes', 'state-unhealthy'];
  readonly stateStatus: 'missing';
  readonly pendingChangesCount: 1;
  readonly sourceCount: 0;
  readonly errorCode: 'QUALITY_GATE_FAILED';
}

interface NegativeBaselineFixture {
  readonly schemaVersion: 'buildlore.hierarchical-corpus-negative-fixture.v1';
  readonly projectId: string;
  readonly sourceCount: number;
  readonly headingCount: number;
  readonly repeatedHeading: string;
  readonly repeatedHeadingSourceCount: number;
  readonly permutationSeed: number;
  readonly repeatedHeadingPairCount: number;
  readonly expectedPlanDigest: `sha256:${string}`;
  readonly provenance: {
    readonly schemaVersion: 'buildlore.historical-baseline-provenance.v1';
    readonly entrySnapshot: Readonly<{
      readonly path: 'plans/entries/buildlore-v0.2.2-hierarchical-semantic-wiki-compilation.md';
      readonly byteLength: 78917;
      readonly sha256: typeof ENTRY_SNAPSHOT_DIGEST;
      readonly claimIds: readonly [
        'entry.problem.approval-state-disconnect',
        'entry.problem.flat-projection',
        'entry.problem.merge-cap',
      ];
    }>;
    readonly plannerBaseline: Readonly<{
      readonly commitSha: typeof HISTORICAL_PLANNER_COMMIT;
      readonly treeSha: string;
      readonly planSchemaVersion: typeof HISTORICAL_PLAN_SCHEMA_VERSION;
      readonly algorithmVersion: typeof HISTORICAL_ALGORITHM_VERSION;
      readonly contractDigest: typeof HISTORICAL_CONTRACT_DIGEST;
      readonly maxMergeCandidates: 512;
      readonly sourceFiles: readonly HistoricalSourceFile[];
    }>;
    readonly approvalBaseline: Readonly<{
      readonly commitSha: typeof HISTORICAL_APPROVAL_COMMIT;
      readonly treeSha: string;
      readonly compilerDependencyVersion: 'llm-wiki-compiler@1.1.0';
      readonly sourceFiles: readonly HistoricalSourceFile[];
    }>;
  };
  readonly historicalPlannerFailure: HistoricalPlannerFailure;
  readonly observedProjection: Readonly<{
    readonly schemaVersion: 'buildlore.historical-projection-observation.v1';
    readonly claimId: 'entry.problem.flat-projection';
    readonly sourceCount: number;
    readonly headingCount: number;
    readonly pageCount: number;
    readonly oneLinePageCount: number;
    readonly uncategorizedPageCount: number;
    readonly bodyWikiLinkCount: number;
    readonly omittedHeadingCount: number;
  }>;
  readonly expectedShallowWiki: {
    readonly pageCount: number;
    readonly bodyWikiLinkCount: number;
    readonly uncategorizedPageCount: number;
    readonly templateBody: string;
    readonly qualityReasonCode: 'content-shallow';
  };
  readonly expectedLegacyApprovalCheck: ExpectedLegacyApprovalCheck;
}

const PROJECT_ID = 'fixture-project';
const DIGEST = hierarchySha256('fixture');
const SOURCE_ID = `source-${'1'.repeat(64)}`;

function purpose(): CompilationPurposeV1 {
  return createCompilationPurpose({
    projectId: PROJECT_ID,
    audience: ['Maintainers'],
    goals: ['Explain architecture from evidence'],
    keyQuestions: ['How does compilation preserve provenance?'],
    scopeHints: ['Registered corpus'],
    excludedTopics: ['Deployment'],
    outputLanguage: 'ko-KR',
    requestedPageRoles: ['architecture', 'overview'],
  });
}

function textUnit(overrides: Partial<Omit<TextUnitV1, 'schemaVersion' | 'unitId'>> = {}):
TextUnitV1 {
  return createTextUnit({
    projectId: PROJECT_ID,
    sourceId: SOURCE_ID,
    sourceRevision: DIGEST,
    sourceRef: 'docs/architecture.md',
    kind: 'heading',
    ordinal: 0,
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 14 },
    contentDigest: hierarchySha256('Architecture'),
    ...overrides,
  });
}

function unknownRecord(value: unknown, context: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} is invalid.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactFixtureKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length ||
      actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${context} fields are invalid.`);
  }
}

function fixtureInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} is invalid.`);
  }
  return value;
}

function fixtureString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new Error(`${context} is invalid.`);
  }
  return value;
}

function fixtureDigest(value: unknown, context: string): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${context} is invalid.`);
  }
  return value as `sha256:${string}`;
}

function assertStaticFixtureSafe(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      const allowedOpaqueIdentifier = DIGEST_PATTERN.test(candidate) ||
        GIT_SHA1_PATTERN.test(candidate) ||
        /^(?:candidate-)?[a-f0-9]{64}$/u.test(candidate) ||
        candidate.startsWith('buildlore.') || candidate.startsWith('entry.') ||
        (/^[a-z0-9._/-]+$/u.test(candidate) && candidate.includes('/'));
      const unsafe = /ghp_[A-Za-z0-9]{20,}/u.test(candidate) ||
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(candidate) ||
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(candidate) ||
        /(?:^|[\s"'])(?:\/home\/|\/Users\/|\/private\/|\/tmp\/)/u.test(candidate) ||
        /(?:^|[\s"'])[A-Za-z]:\\/u.test(candidate) ||
        /(?:^|[\s"'])\\\\[^\\\s]+\\[^\\\s]+/u.test(candidate) ||
        (!allowedOpaqueIdentifier && /[A-Za-z0-9+/_=-]{40,}/u.test(candidate));
      if (unsafe) throw new Error('Negative baseline static metadata is unsafe.');
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate === 'object' && candidate !== null) {
      Object.values(candidate).forEach(visit);
    }
  };
  visit(value);
}

function parseHistoricalSourceFiles(
  value: unknown,
  expected: readonly HistoricalSourceFile[],
): readonly HistoricalSourceFile[] {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error('Historical source provenance is invalid.');
  }
  return expected;
}

function historicalContractDigest(): `sha256:${string}` {
  const historicalLimits = {
    maxCitationsPerPage: 512,
    maxLinksPerPage: 256,
    maxMergeCandidates: 512,
    maxPageBytes: 524288,
    maxPlanBytes: 33554432,
    maxProposalBytes: 524288,
    maxProposals: 50,
    maxQuoteCodeUnits: 512,
    maxSourceBytes: 524288,
    maxSources: 4096,
    maxTasks: 8192,
  } as const;
  return hierarchySha256(`${JSON.stringify({
    algorithmVersion: HISTORICAL_ALGORITHM_VERSION,
    applyResultSchemaVersion: 'buildlore.compile-apply-result.v1',
    limits: historicalLimits,
    planSchemaVersion: HISTORICAL_PLAN_SCHEMA_VERSION,
    proposalSchemaVersion: 'buildlore.compile-proposal.v1',
    provenanceSchemaVersion: 'buildlore.session-compile-provenance.v1',
  }, null, 2)}\n`);
}

function parseHistoricalPlannerFailure(
  value: unknown,
  projectId: string,
): HistoricalPlannerFailure {
  const failure = unknownRecord(value, 'Historical planner failure');
  exactFixtureKeys(failure, [
    'candidateCountBeforeFailure', 'candidateOrdinal', 'error', 'schemaVersion',
  ], 'Historical planner failure');
  const error = unknownRecord(failure.error, 'Historical planner error');
  exactFixtureKeys(error, [
    'candidateRefs', 'code', 'message', 'projectId', 'recoveryAction', 'retryable',
    'sideEffectsPossible',
  ], 'Historical planner error');
  if (failure.schemaVersion !== 'buildlore.historical-planner-failure.v1' ||
      failure.candidateOrdinal !== 513 || failure.candidateCountBeforeFailure !== 512 ||
      !Array.isArray(error.candidateRefs) || error.candidateRefs.length !== 0 ||
      error.code !== 'SESSION_PLAN_DENIED' ||
      error.message !== 'Session compile input was rejected safely.' ||
      error.projectId !== projectId || error.recoveryAction !== 'check-config' ||
      error.retryable !== false || error.sideEffectsPossible !== false) {
    throw new Error('Historical planner failure binding is invalid.');
  }
  return Object.freeze({
    schemaVersion: failure.schemaVersion,
    candidateOrdinal: failure.candidateOrdinal,
    candidateCountBeforeFailure: failure.candidateCountBeforeFailure,
    error: Object.freeze({
      candidateRefs: Object.freeze([] as const),
      code: error.code,
      message: error.message,
      projectId,
      recoveryAction: error.recoveryAction,
      retryable: error.retryable,
      sideEffectsPossible: error.sideEffectsPossible,
    }),
  });
}

function parseExpectedLegacyApprovalCheck(value: unknown): ExpectedLegacyApprovalCheck {
  const expected = unknownRecord(value, 'Historical approval check expectation');
  exactFixtureKeys(expected, [
    'approvalOutcome', 'checkExitCode', 'claimId', 'errorCode', 'gateCodes',
    'pendingChangesCount', 'providerUsed', 'schemaVersion', 'sideEffectsPossible',
    'sourceCount', 'stateStatus',
  ], 'Historical approval check expectation');
  if (expected.schemaVersion !== 'buildlore.historical-approve-check-expectation.v1' ||
      expected.claimId !== 'entry.problem.approval-state-disconnect' ||
      expected.approvalOutcome !== 'approved' || expected.providerUsed !== false ||
      expected.sideEffectsPossible !== false || expected.checkExitCode !== 5 ||
      JSON.stringify(expected.gateCodes) !==
        JSON.stringify(['pending-changes', 'state-unhealthy']) ||
      expected.stateStatus !== 'missing' || expected.pendingChangesCount !== 1 ||
      expected.sourceCount !== 0 || expected.errorCode !== 'QUALITY_GATE_FAILED') {
    throw new Error('Historical approval check expectation is invalid.');
  }
  return Object.freeze({
    schemaVersion: expected.schemaVersion,
    claimId: expected.claimId,
    approvalOutcome: expected.approvalOutcome,
    providerUsed: expected.providerUsed,
    sideEffectsPossible: expected.sideEffectsPossible,
    checkExitCode: expected.checkExitCode,
    gateCodes: Object.freeze(['pending-changes', 'state-unhealthy'] as const),
    stateStatus: expected.stateStatus,
    pendingChangesCount: expected.pendingChangesCount,
    sourceCount: expected.sourceCount,
    errorCode: expected.errorCode,
  });
}

function parseNegativeFixture(value: unknown): NegativeBaselineFixture {
  const fixture = unknownRecord(value, 'Negative baseline fixture');
  exactFixtureKeys(fixture, [
    'expectedPlanDigest', 'expectedShallowWiki', 'headingCount',
    'expectedLegacyApprovalCheck', 'historicalPlannerFailure', 'observedProjection',
    'permutationSeed', 'projectId', 'provenance',
    'repeatedHeading', 'repeatedHeadingPairCount', 'repeatedHeadingSourceCount',
    'schemaVersion', 'sourceCount',
  ], 'Negative baseline fixture');
  if (fixture.schemaVersion !== 'buildlore.hierarchical-corpus-negative-fixture.v1') {
    throw new Error('Negative baseline fixture identity is invalid.');
  }
  assertStaticFixtureSafe(fixture);
  const projectId = fixtureString(fixture.projectId, 'Negative baseline project');
  if (validateProjectId(projectId) !== projectId) {
    throw new Error('Negative baseline project is invalid.');
  }
  const provenance = unknownRecord(fixture.provenance, 'Negative baseline provenance');
  exactFixtureKeys(provenance, [
    'approvalBaseline', 'entrySnapshot', 'plannerBaseline', 'schemaVersion',
  ], 'Negative baseline provenance');
  const entry = unknownRecord(provenance.entrySnapshot, 'Negative baseline entry');
  exactFixtureKeys(entry, ['byteLength', 'claimIds', 'path', 'sha256'], 'Negative baseline entry');
  const planner = unknownRecord(provenance.plannerBaseline, 'Historical planner provenance');
  exactFixtureKeys(planner, [
    'algorithmVersion', 'commitSha', 'contractDigest', 'maxMergeCandidates',
    'planSchemaVersion', 'sourceFiles', 'treeSha',
  ], 'Historical planner provenance');
  const approvalBaseline = unknownRecord(
    provenance.approvalBaseline,
    'Historical approval provenance',
  );
  exactFixtureKeys(approvalBaseline, [
    'commitSha', 'compilerDependencyVersion', 'sourceFiles', 'treeSha',
  ], 'Historical approval provenance');
  const claimIds = [
    'entry.problem.approval-state-disconnect',
    'entry.problem.flat-projection',
    'entry.problem.merge-cap',
  ] as const;
  if (provenance.schemaVersion !== 'buildlore.historical-baseline-provenance.v1' ||
      entry.path !== 'plans/entries/buildlore-v0.2.2-hierarchical-semantic-wiki-compilation.md' ||
      entry.byteLength !== 78917 || entry.sha256 !== ENTRY_SNAPSHOT_DIGEST ||
      JSON.stringify(entry.claimIds) !== JSON.stringify(claimIds) ||
      planner.commitSha !== HISTORICAL_PLANNER_COMMIT ||
      planner.treeSha !== '56ad7568fdbf3c962bdef7423c9b1bca5c271d88' ||
      planner.planSchemaVersion !== HISTORICAL_PLAN_SCHEMA_VERSION ||
      planner.algorithmVersion !== HISTORICAL_ALGORITHM_VERSION ||
      planner.contractDigest !== historicalContractDigest() ||
      planner.contractDigest !== HISTORICAL_CONTRACT_DIGEST ||
      planner.maxMergeCandidates !== HISTORICAL_GLOBAL_MERGE_LIMIT ||
      approvalBaseline.commitSha !== HISTORICAL_APPROVAL_COMMIT ||
      approvalBaseline.treeSha !== '0cc16761a885d4d4b4c885527d8db58c068ef17b' ||
      approvalBaseline.compilerDependencyVersion !== 'llm-wiki-compiler@1.1.0') {
    throw new Error('Negative baseline provenance identity is invalid.');
  }
  const plannerSourceFiles = parseHistoricalSourceFiles(
    planner.sourceFiles,
    HISTORICAL_PLANNER_FILES,
  );
  const approvalSourceFiles = parseHistoricalSourceFiles(
    approvalBaseline.sourceFiles,
    HISTORICAL_APPROVAL_FILES,
  );
  const shallow = unknownRecord(fixture.expectedShallowWiki, 'Negative shallow Wiki baseline');
  exactFixtureKeys(shallow, [
    'bodyWikiLinkCount', 'pageCount', 'qualityReasonCode', 'templateBody',
    'uncategorizedPageCount',
  ], 'Negative shallow Wiki baseline');
  if (shallow.qualityReasonCode !== 'content-shallow') {
    throw new Error('Negative shallow Wiki quality identity is invalid.');
  }
  const sourceCount = fixtureInteger(fixture.sourceCount, 'Negative baseline source count');
  const headingCount = fixtureInteger(fixture.headingCount, 'Negative baseline heading count');
  const repeatedHeadingSourceCount = fixtureInteger(
    fixture.repeatedHeadingSourceCount,
    'Negative repeated heading source count',
  );
  const repeatedHeadingPairCount = fixtureInteger(
    fixture.repeatedHeadingPairCount,
    'Negative repeated heading pair count',
  );
  const pageCount = fixtureInteger(shallow.pageCount, 'Negative shallow page count');
  const uncategorizedPageCount = fixtureInteger(
    shallow.uncategorizedPageCount,
    'Negative uncategorized page count',
  );
  if (
    sourceCount < 1 ||
    headingCount < sourceCount ||
    repeatedHeadingSourceCount < 2 ||
    repeatedHeadingSourceCount > sourceCount ||
    repeatedHeadingPairCount !==
      repeatedHeadingSourceCount * (repeatedHeadingSourceCount - 1) / 2 ||
    pageCount !== sourceCount ||
    uncategorizedPageCount !== pageCount ||
    fixtureInteger(shallow.bodyWikiLinkCount, 'Negative Wiki link count') !== 0
  ) throw new Error('Negative baseline cross-field binding is invalid.');
  const projection = unknownRecord(fixture.observedProjection, 'Historical projection');
  exactFixtureKeys(projection, [
    'bodyWikiLinkCount', 'claimId', 'headingCount', 'omittedHeadingCount',
    'oneLinePageCount', 'pageCount', 'schemaVersion', 'sourceCount',
    'uncategorizedPageCount',
  ], 'Historical projection');
  if (projection.schemaVersion !== 'buildlore.historical-projection-observation.v1' ||
      projection.claimId !== 'entry.problem.flat-projection' ||
      projection.sourceCount !== sourceCount || projection.headingCount !== headingCount ||
      projection.pageCount !== sourceCount || projection.oneLinePageCount !== sourceCount ||
      projection.uncategorizedPageCount !== sourceCount || projection.bodyWikiLinkCount !== 0 ||
      projection.omittedHeadingCount !== headingCount - sourceCount) {
    throw new Error('Historical projection binding is invalid.');
  }
  return Object.freeze({
    schemaVersion: fixture.schemaVersion,
    projectId,
    sourceCount,
    headingCount,
    repeatedHeading: fixtureString(fixture.repeatedHeading, 'Negative repeated heading'),
    repeatedHeadingSourceCount,
    permutationSeed: (() => {
      const seed = fixtureInteger(fixture.permutationSeed, 'Negative permutation seed');
      if (seed < 1 || seed > 0xffff_ffff) {
        throw new Error('Negative permutation seed is invalid.');
      }
      return seed;
    })(),
    repeatedHeadingPairCount,
    expectedPlanDigest: fixtureDigest(fixture.expectedPlanDigest, 'Negative plan digest'),
    provenance: Object.freeze({
      schemaVersion: provenance.schemaVersion,
      entrySnapshot: Object.freeze({
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        claimIds: Object.freeze(claimIds),
      }),
      plannerBaseline: Object.freeze({
        commitSha: planner.commitSha,
        treeSha: String(planner.treeSha),
        planSchemaVersion: planner.planSchemaVersion,
        algorithmVersion: planner.algorithmVersion,
        contractDigest: planner.contractDigest,
        maxMergeCandidates: planner.maxMergeCandidates,
        sourceFiles: plannerSourceFiles,
      }),
      approvalBaseline: Object.freeze({
        commitSha: approvalBaseline.commitSha,
        treeSha: String(approvalBaseline.treeSha),
        compilerDependencyVersion: approvalBaseline.compilerDependencyVersion,
        sourceFiles: approvalSourceFiles,
      }),
    }),
    historicalPlannerFailure: parseHistoricalPlannerFailure(
      fixture.historicalPlannerFailure,
      projectId,
    ),
    observedProjection: Object.freeze({
      schemaVersion: projection.schemaVersion,
      claimId: projection.claimId,
      sourceCount,
      headingCount,
      pageCount: sourceCount,
      oneLinePageCount: sourceCount,
      uncategorizedPageCount: sourceCount,
      bodyWikiLinkCount: 0,
      omittedHeadingCount: headingCount - sourceCount,
    }),
    expectedShallowWiki: Object.freeze({
      pageCount,
      bodyWikiLinkCount: 0,
      uncategorizedPageCount,
      templateBody: fixtureString(shallow.templateBody, 'Negative shallow template'),
      qualityReasonCode: shallow.qualityReasonCode,
    }),
    expectedLegacyApprovalCheck: parseExpectedLegacyApprovalCheck(
      fixture.expectedLegacyApprovalCheck,
    ),
  });
}

async function negativeFixture(): Promise<NegativeBaselineFixture> {
  const raw = await readFile(
    new URL('./fixtures/hierarchical-corpus-negative.json', import.meta.url),
    'utf8',
  );
  if (hierarchySha256(raw) !== NEGATIVE_FIXTURE_FILE_DIGEST) {
    throw new Error('Negative baseline fixture provenance digest is invalid.');
  }
  const value: unknown = JSON.parse(raw);
  return parseNegativeFixture(value);
}

function seededPermutation<T>(values: readonly T[], seed: number): readonly T[] {
  let state = seed >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = next() % (index + 1);
    const current = result[index];
    const replacement = result[swapIndex];
    if (current === undefined || replacement === undefined) throw new Error('invalid permutation');
    result[index] = replacement;
    result[swapIndex] = current;
  }
  return Object.freeze(result);
}

/** Exact test-only replay of the merge loop in 945e425 planner-pure.ts. */
function replayHistoricalPlannerFailureForTest(
  sources: readonly SessionPlannedSource[],
  projectId: string,
): HistoricalPlannerFailure | null {
  const drafts = sources.flatMap((source) => source.sanitizedBody.split('\n').flatMap((line) => {
    const heading = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(line)?.[1]?.trim();
    if (heading === undefined || heading.length === 0) return [];
    const tokens = [...new Set(heading.normalize('NFC').toLowerCase().normalize('NFC')
      .match(/[\p{L}\p{N}]+/gu) ?? [])].sort();
    return [{ headingKey: tokens.join('-') || 'document', sourceId: source.sourceId, tokens }];
  }));
  let candidateCount = 0;
  for (let leftIndex = 0; leftIndex < drafts.length; leftIndex += 1) {
    const left = drafts[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < drafts.length; rightIndex += 1) {
      const right = drafts[rightIndex];
      if (right === undefined || left.sourceId === right.sourceId ||
          left.tokens.length === 0 || right.tokens.length === 0) continue;
      const rightTokens = new Set(right.tokens);
      const sharedTokens = left.tokens.filter((token) => rightTokens.has(token));
      const union = new Set([...left.tokens, ...right.tokens]).size;
      const scoreBasisPoints = union === 0 ? 0 : Math.floor(sharedTokens.length * 10_000 / union);
      if (left.headingKey !== right.headingKey &&
          (sharedTokens.length < 2 || scoreBasisPoints < 5_000)) continue;
      if (candidateCount >= HISTORICAL_GLOBAL_MERGE_LIMIT) {
        return Object.freeze({
          schemaVersion: 'buildlore.historical-planner-failure.v1',
          candidateOrdinal: 513,
          candidateCountBeforeFailure: candidateCount as 512,
          error: Object.freeze({
            candidateRefs: Object.freeze([] as const),
            code: 'SESSION_PLAN_DENIED',
            message: 'Session compile input was rejected safely.',
            projectId,
            recoveryAction: 'check-config',
            retryable: false,
            sideEffectsPossible: false,
          }),
        });
      }
      candidateCount += 1;
    }
  }
  return null;
}

function pageIdentifier(sourceId: string): string {
  return `page-${hierarchySha256(`page:${sourceId}`).slice('sha256:'.length)}`;
}

function unitIdentifier(sourceId: string): string {
  return `unit-${hierarchySha256(`unit:${sourceId}`).slice('sha256:'.length)}`;
}

function shallowQualityInput(
  sources: readonly SessionPlannedSource[],
  fixture: NegativeBaselineFixture,
  content: SanitizedFixtureContent,
): Readonly<{
  readonly evidencePacks: readonly EvidencePackV1[];
  readonly outline: WikiOutlineV1;
  readonly proposals: readonly HierarchicalWikiProposalV1[];
  readonly reconciliation: WikiLinkReconciliationV1;
}> {
  const pageIds = sources.map((source) => pageIdentifier(source.sourceId));
  const rootPageId = pageIds.at(-1);
  if (rootPageId === undefined) throw new Error('negative baseline requires pages');
  const snapshotDigest = hierarchySha256('negative-baseline-snapshot');
  const blueprints: readonly PageBlueprintV1[] = Object.freeze(sources.map((source, index) => {
    const pageId = pageIds[index];
    if (pageId === undefined) throw new Error('missing negative baseline page');
    const isRoot = pageId === rootPageId;
    const candidate = Object.freeze({
      schemaVersion: 'buildlore.page-blueprint.v2' as const,
      projectId: fixture.projectId,
      pageId,
      stableKey: `negative-baseline.${String(index).padStart(3, '0')}`,
      role: 'Uncategorized',
      title: source.title,
      parentPageId: isRoot ? null : rootPageId,
      childPageIds: Object.freeze(isRoot ? pageIds.slice(0, -1).sort() : []),
      relatedPageIds: Object.freeze([]),
      keyQuestions: Object.freeze([]),
      requiredSections: Object.freeze(['summary']),
      evidenceScope: Object.freeze({
        snapshotDigest,
        taskSetDigest: hierarchySha256('negative-baseline-tasks'),
        relationSetDigest: hierarchySha256('negative-baseline-relations'),
        allowedUnitKinds: Object.freeze([
          'document', 'fenced-code', 'heading', 'list', 'paragraph', 'table',
        ] as const),
        sourceIds: Object.freeze([source.sourceId]),
        preferredUnitIds: Object.freeze([]),
      }),
      minimumDistinctSources: 1,
      generationOrder: index,
    });
    return Object.freeze({ ...candidate, blueprintDigest: digestHierarchyValue(candidate) });
  }));
  const outlineCandidate = Object.freeze({
    schemaVersion: 'buildlore.wiki-outline.v2' as const,
    projectId: fixture.projectId,
    snapshotDigest,
    graphDigest: hierarchySha256('negative-baseline-graph'),
    interpretationSetDigest: hierarchySha256('negative-baseline-interpretations'),
    purposeDigest: hierarchySha256('negative-baseline-purpose'),
    policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
    activationState: 'candidate' as const,
    rootPageId,
    blueprints,
    reviewNotes: Object.freeze([]),
  });
  const outline: WikiOutlineV1 = Object.freeze({
    ...outlineCandidate,
    outlineDigest: digestHierarchyValue(outlineCandidate),
  });
  const evidencePacks: readonly EvidencePackV1[] = Object.freeze(blueprints.map(
    (blueprint, index) => {
      const source = sources[index];
      if (source === undefined) throw new Error('missing negative baseline source');
      const content = source.sanitizedBody;
      const contentDigest = hierarchySha256(content);
      const unitId = unitIdentifier(source.sourceId);
      const lines = content.trimEnd().split('\n');
      const range = Object.freeze({
        startLine: 1,
        startColumn: 1,
        endLine: lines.length,
        endColumn: Array.from(lines.at(-1) ?? '').length,
      });
      const citationBasis = Object.freeze({
        sourceId: source.sourceId,
        sourceRevision: source.revision,
        sourceRef: source.sourceRef,
        range,
        quoteDigest: contentDigest,
      });
      const citationId = `citation-${digestHierarchyValue(citationBasis).slice('sha256:'.length)}`;
      const packCandidate = Object.freeze({
        schemaVersion: 'buildlore.evidence-pack.v1' as const,
        projectId: fixture.projectId,
        pageId: blueprint.pageId,
        blueprintDigest: blueprint.blueprintDigest,
        snapshotDigest,
        sanitizerPolicyDigest: hierarchySha256('negative-baseline-sanitizer'),
        units: Object.freeze([Object.freeze({
          unitId,
          sourceId: source.sourceId,
          kind: 'document' as const,
          range,
          content,
          contentDigest,
          citation: Object.freeze({ citationId, ...citationBasis }),
        })]),
        conflicts: Object.freeze([]),
        gaps: Object.freeze([]),
        evidenceBytes: Buffer.byteLength(content),
      });
      return Object.freeze({ ...packCandidate, packDigest: digestHierarchyValue(packCandidate) });
    },
  ));
  const packByPageId = new Map(evidencePacks.map((pack) => [pack.pageId, pack]));
  const proposals: readonly HierarchicalWikiProposalV1[] = Object.freeze(blueprints.map(
    (blueprint) => {
      const pack = packByPageId.get(blueprint.pageId);
      const unit = pack?.units[0];
      if (pack === undefined || unit === undefined) throw new Error('missing negative evidence');
      const body = [
        content.templateBody,
        `[^${unit.citation.citationId}]`,
      ].join(' ');
      const claimBasis = Object.freeze({
        text: content.templateBody,
        evidenceUnitIds: Object.freeze([unit.unitId]),
        citationIds: Object.freeze([unit.citation.citationId]),
      });
      const proposalCandidate = Object.freeze({
        schemaVersion: 'buildlore.hierarchical-wiki-proposal.v2' as const,
        projectId: fixture.projectId,
        pageId: blueprint.pageId,
        blueprintDigest: blueprint.blueprintDigest,
        evidencePackDigest: pack.packDigest,
        requestDigest: hierarchySha256(`negative-request:${blueprint.pageId}`),
        title: blueprint.title,
        summary: content.templateBody,
        sections: Object.freeze([Object.freeze({ sectionId: 'summary', body })]),
        claims: Object.freeze([Object.freeze({
          claimId: `claim-${digestHierarchyValue(claimBasis).slice('sha256:'.length)}`,
          ...claimBasis,
        })]),
        wikilinks: Object.freeze([]),
        citationIds: Object.freeze([unit.citation.citationId]),
        lifecycle: 'candidate' as const,
      });
      return Object.freeze({
        ...proposalCandidate,
        proposalDigest: digestHierarchyValue(proposalCandidate),
      });
    },
  ));
  const reconciliationCandidate = Object.freeze({
    schemaVersion: 'buildlore.wiki-link-reconciliation.v1' as const,
    projectId: fixture.projectId,
    outlineDigest: outline.outlineDigest,
    entries: Object.freeze(blueprints.map((blueprint) => Object.freeze({
      pageId: blueprint.pageId,
      requiredLinkPageIds: Object.freeze([...new Set([
        ...(blueprint.parentPageId === null ? [] : [blueprint.parentPageId]),
        ...blueprint.childPageIds,
        ...blueprint.relatedPageIds,
      ])].sort()),
    })).sort((left, right) => left.pageId < right.pageId ? -1 : 1)),
    complete: true as const,
  });
  const reconciliation: WikiLinkReconciliationV1 = Object.freeze({
    ...reconciliationCandidate,
    reconciliationDigest: digestHierarchyValue(reconciliationCandidate),
  });
  return Object.freeze({ evidencePacks, outline, proposals, reconciliation });
}

interface SanitizedFixtureContent {
  readonly repeatedHeading: string;
  readonly templateBody: string;
}

function negativeSources(
  fixture: NegativeBaselineFixture,
  content: SanitizedFixtureContent,
): readonly SessionPlannedSource[] {
  const baseHeadingCount = Math.floor(fixture.headingCount / fixture.sourceCount);
  const remainder = fixture.headingCount % fixture.sourceCount;
  const sources = Array.from({ length: fixture.sourceCount }, (_, sourceIndex) => {
    const headingsForSource = baseHeadingCount + (sourceIndex < remainder ? 1 : 0);
    const headings = Array.from({ length: headingsForSource }, (_, headingIndex) => {
      if (sourceIndex < fixture.repeatedHeadingSourceCount && headingIndex === 0) {
        return `# ${content.repeatedHeading}`;
      }
      return `# unique${String(sourceIndex).padStart(3, '0')}heading${String(headingIndex)
        .padStart(3, '0')}`;
    });
    const sanitizedBody = `${headings.join('\nEvidence line\n')}\nEvidence line\n`;
    const digest = hierarchySha256(sanitizedBody);
    const sourceId = `source-${hierarchySha256(`source-${String(sourceIndex)}`)
      .slice('sha256:'.length)}`;
    const sourceRef = validatePortableSourceRef(
      `docs/source-${String(sourceIndex).padStart(3, '0')}.md`,
    );
    return Object.freeze({
      citationAnchors: Object.freeze([]),
      compilerSourceContentDigest: digest,
      compilerSourceId: `markdown--${digest.slice('sha256:'.length)}.md`,
      originalContentDigest: digest,
      revision: digest,
      sanitizedBody,
      sanitizedContentDigest: digest,
      sourceId,
      sourceKind: 'markdown' as const,
      sourceRef,
      title: `Source ${String(sourceIndex)}`,
    });
  });
  expect(sources.reduce(
    (count, source) => count + source.sanitizedBody.split('\n')
      .filter((line) => line.startsWith('# ')).length,
    0,
  )).toBe(fixture.headingCount);
  return Object.freeze(sources);
}

function expectedHeadingRanges(
  sources: readonly SessionPlannedSource[],
): readonly string[] {
  return Object.freeze(sources.flatMap((source) => {
    const lines = source.sanitizedBody.split('\n');
    const starts = lines.flatMap((line, index) =>
      /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.test(line) ? [index + 1] : []);
    return starts.map((startLine, index) => {
      const endLine = Math.max(startLine, (starts[index + 1] ?? lines.length + 1) - 1);
      return `${source.sourceId}:${String(startLine)}:${String(endLine)}`;
    });
  }).sort());
}

async function securityServiceFixture(
  projectId: string,
): Promise<Readonly<{
  readonly root: string;
  readonly service: ProjectSecurityService;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-negative-corpus-'));
  const knowledgeRoot = join(root, 'knowledge');
  await mkdir(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: 'Negative corpus',
    projectId,
    sourceRepository: 'https://example.test/negative-corpus.git',
  });
  return Object.freeze({
    root,
    service: createProjectSecurityService({
      homePath: '/Users/synthetic-owner',
      knowledgeRoot,
    }),
  });
}

type BaselineAdmissionResult =
  | Readonly<{ readonly ok: true }>
  | Readonly<{
      readonly errorCode: 'NEGATIVE_BASELINE_SOURCE_REJECTED';
      readonly ok: false;
      readonly report?: SanitizationReport;
    }>;

async function admitBaselineSourceForTest(
  service: ProjectSecurityService,
  input: Readonly<{
    readonly body: string;
    readonly projectId: string;
    readonly sourceId: string;
    readonly sourceRef: string;
  }>,
  downstream: (approvedBody: string) => void,
): Promise<BaselineAdmissionResult> {
  try {
    validatePortableSourceRef(input.sourceRef);
  } catch {
    return Object.freeze({ errorCode: 'NEGATIVE_BASELINE_SOURCE_REJECTED', ok: false });
  }
  const result = await service.prepareSource({
    body: input.body,
    bodyDigest: hierarchySha256(input.body),
    projectId: input.projectId,
    source: `buildlore://negative-baseline/${input.sourceId}`,
    sourceKind: 'markdown',
    sourceRevisionOrContentSha256: hierarchySha256(input.body),
  });
  if (!result.ok || result.report.summaries.length > 0) {
    return Object.freeze({
      errorCode: 'NEGATIVE_BASELINE_SOURCE_REJECTED',
      ok: false,
      report: result.report,
    });
  }
  const prepared = consumePreparedSource(result.prepared);
  if (prepared === null) {
    return Object.freeze({
      errorCode: 'NEGATIVE_BASELINE_SOURCE_REJECTED',
      ok: false,
      report: result.report,
    });
  }
  downstream(prepared.approvedBody);
  return Object.freeze({ ok: true });
}

async function sanitizeFixtureContentForTest(
  service: ProjectSecurityService,
  fixture: NegativeBaselineFixture,
  downstream: (content: SanitizedFixtureContent) => void,
): Promise<BaselineAdmissionResult> {
  const body = `# ${fixture.repeatedHeading}\n${fixture.expectedShallowWiki.templateBody}\n`;
  let approvedBody: string | undefined;
  const admission = await admitBaselineSourceForTest(service, {
    body,
    projectId: fixture.projectId,
    sourceId: `source-${hierarchySha256('fixture-content').slice('sha256:'.length)}`,
    sourceRef: 'docs/fixture-content.md',
  }, (approved) => { approvedBody = approved; });
  if (!admission.ok || approvedBody === undefined) return admission;
  try {
    const lines = approvedBody.trimEnd().split('\n');
    const heading = /^# (.+)$/u.exec(lines[0] ?? '')?.[1];
    const templateBody = lines[1];
    if (heading === undefined || templateBody === undefined || lines.length !== 2) {
      throw new Error('Sanitized negative fixture content is invalid.');
    }
    const content = Object.freeze({ repeatedHeading: heading, templateBody });
    assertStaticFixtureSafe(content);
    downstream(content);
    return Object.freeze({ ok: true });
  } catch {
    return Object.freeze({ errorCode: 'NEGATIVE_BASELINE_SOURCE_REJECTED', ok: false });
  }
}

async function cleanFixtureRuntime(
  fixture: NegativeBaselineFixture,
): Promise<Readonly<{
  readonly content: SanitizedFixtureContent;
  readonly sources: readonly SessionPlannedSource[];
}>> {
  const security = await securityServiceFixture(fixture.projectId);
  try {
    let content: SanitizedFixtureContent | undefined;
    const result = await sanitizeFixtureContentForTest(
      security.service,
      fixture,
      (approved) => { content = approved; },
    );
    if (!result.ok || content === undefined) {
      throw new Error('Clean negative fixture content was rejected.');
    }
    return Object.freeze({ content, sources: negativeSources(fixture, content) });
  } finally {
    await rm(security.root, { force: true, recursive: true });
  }
}

describe('hierarchical corpus contracts', () => {
  it('binds current and next-phase limits into one canonical policy digest', () => {
    expect(HIERARCHICAL_COMPILATION_LIMITS).toMatchObject({
      maxSources: 4096,
      maxSourceBytes: 524288,
      maxTasks: 8192,
      maxPlanBytes: 33554432,
      maxRelationCandidatesPerTask: 32,
      maxClusterMembers: 256,
      maxPartitionTasks: 256,
      maxEvidenceUnits: 64,
      maxEvidenceBytes: 262144,
      maxEvidenceSourcesPerPage: 8,
      maxEvidenceUnitsPerSource: 8,
    });
    expect(HIERARCHICAL_COMPILATION_LIMITS.maxSources)
      .toBe(SESSION_COMPILE_LIMITS.maxSources);
    expect(HIERARCHICAL_COMPILATION_LIMITS.maxSourceBytes)
      .toBe(SESSION_COMPILE_LIMITS.maxSourceBytes);
    expect(HIERARCHICAL_COMPILATION_LIMITS.maxTasks)
      .toBe(SESSION_COMPILE_LIMITS.maxTasks);
    expect(HIERARCHICAL_COMPILATION_LIMITS.maxPlanBytes)
      .toBe(SESSION_COMPILE_LIMITS.maxPlanBytes);
    expect(HIERARCHICAL_COMPILATION_POLICY.policyDigest).toBe(digestHierarchyValue({
      schemaVersion: HIERARCHICAL_COMPILATION_POLICY.schemaVersion,
      limits: HIERARCHICAL_COMPILATION_LIMITS,
    }));
    expect(parseHierarchicalCompilationPolicy(HIERARCHICAL_COMPILATION_POLICY))
      .toBe(HIERARCHICAL_COMPILATION_POLICY);
    expect(() => parseHierarchicalCompilationPolicy({
      ...HIERARCHICAL_COMPILATION_POLICY,
      limits: { ...HIERARCHICAL_COMPILATION_LIMITS, maxPartitionTasks: 257 },
    })).toThrow(HierarchyContractError);
  });

  it('creates a language-neutral purpose with a verified stable digest', () => {
    const created = purpose();
    expect(parseCompilationPurpose(created, PROJECT_ID)).toEqual(created);
    expect(createCompilationPurpose({
      projectId: PROJECT_ID,
      audience: ['Maintainers'],
      goals: ['Explain architecture from evidence'],
      keyQuestions: ['How does compilation preserve provenance?'],
      scopeHints: ['Registered corpus'],
      excludedTopics: ['Deployment'],
      outputLanguage: 'ko-KR',
      requestedPageRoles: ['architecture', 'overview'],
    })).toEqual(created);
    expect(() => parseCompilationPurpose({ ...created, purposeDigest: DIGEST }, PROJECT_ID))
      .toThrow(HierarchyContractError);
    expect(() => parseCompilationPurpose({ ...created, gate: 'hidden' }, PROJECT_ID))
      .toThrow(HierarchyContractError);
  });

  it('binds each text unit to a project, source revision, exact range and content digest', () => {
    const created = textUnit();
    expect(parseTextUnit(created, PROJECT_ID)).toEqual(created);
    expect(textUnit()).toEqual(created);
    expect(() => parseTextUnit({
      ...created,
      range: { ...created.range, endColumn: 0 },
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    expect(() => parseTextUnit({
      ...created,
      sourceRef: '/private/source.md',
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    const labeled = textUnit({
      contentDigest: hierarchySha256('Verified topic'),
      topicLabel: 'Verified topic',
    });
    expect(labeled.topicLabel).toBe('Verified topic');
    expect(() => textUnit({
      contentDigest: hierarchySha256('Different bytes'),
      topicLabel: 'Unverified topic',
    })).toThrow(HierarchyContractError);
  });

  it('preserves unknown document meaning instead of inventing authority', () => {
    const created = createDocumentInterpretation({
      projectId: PROJECT_ID,
      sourceId: SOURCE_ID,
      sourceRevision: DIGEST,
      role: 'reference',
      lifecycle: 'unknown',
      authority: 'unknown',
      synthesisEligibility: 'review',
      basis: ['explicit-metadata', 'path-rule'],
      confidenceBasisPoints: 2500,
      reasonCodes: ['authority-unknown'],
      relations: [],
    });
    expect(parseDocumentInterpretation(created, PROJECT_ID)).toEqual(created);
    expect(created).toMatchObject({
      authority: 'unknown',
      lifecycle: 'unknown',
      synthesisEligibility: 'review',
    });
    expect(() => parseDocumentInterpretation({
      ...created,
      basis: ['path-rule', 'explicit-metadata'],
    }, PROJECT_ID)).toThrow(HierarchyContractError);
  });

  it('creates an immutable cross-checked corpus snapshot', () => {
    const source: CorpusSnapshotSourceV1 = Object.freeze({
      sourceId: SOURCE_ID,
      sourceRevision: DIGEST,
      sourceRef: 'docs/architecture.md',
      sanitizedContentDigest: DIGEST,
    });
    const unit = textUnit();
    const created = createCorpusSnapshot({
      projectId: PROJECT_ID,
      purposeDigest: purpose().purposeDigest,
      interpretationRulesDigest: hierarchySha256('interpretation-rules'),
      profileDigest: hierarchySha256('profile'),
      compilerContractDigest: hierarchySha256('compiler'),
      sanitizerPolicyDigest: hierarchySha256('sanitizer'),
      sourceManifestDigest: hierarchySha256('manifest'),
      policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
      sources: [source],
      textUnits: [unit],
    });
    expect(parseCorpusSnapshot(created, PROJECT_ID)).toEqual(created);
    expect(() => parseCorpusSnapshot({
      ...created,
      textUnits: [{ ...unit, sourceRevision: hierarchySha256('other') }],
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    expect(() => parseCorpusSnapshot({ ...created, policyDigest: DIGEST }, PROJECT_ID))
      .toThrow(HierarchyContractError);
  });

  it('strictly parses and provenance-binds the complete negative fixture', async () => {
    const fixtureUrl = new URL('./fixtures/hierarchical-corpus-negative.json', import.meta.url);
    const fixtureText = await readFile(fixtureUrl, 'utf8');
    const fixture = await negativeFixture();

    expect(hierarchySha256(fixtureText)).toBe(NEGATIVE_FIXTURE_FILE_DIGEST);
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(() => parseNegativeFixture({ ...fixture, extraField: true })).toThrow(
      'Negative baseline fixture fields are invalid.',
    );
    expect(() => parseNegativeFixture({ ...fixture, sourceCount: 116 })).toThrow(
      'Negative baseline cross-field binding is invalid.',
    );
    expect(() => parseNegativeFixture({
      ...fixture,
      expectedLegacyApprovalCheck: {
        ...fixture.expectedLegacyApprovalCheck,
        pendingChangesCount: 0,
      },
    })).toThrow('Historical approval check expectation is invalid.');
    expect(fixture.provenance.plannerBaseline).toMatchObject({
      algorithmVersion: HISTORICAL_ALGORITHM_VERSION,
      commitSha: HISTORICAL_PLANNER_COMMIT,
      contractDigest: historicalContractDigest(),
      planSchemaVersion: HISTORICAL_PLAN_SCHEMA_VERSION,
    });
    expect(fixture.provenance.approvalBaseline.commitSha).toBe(HISTORICAL_APPROVAL_COMMIT);
  });

  it('replays the sanitized negative baseline and proves the corrected planner is complete', async () => {
    const fixture = await negativeFixture();
    expect(fixture).toMatchObject({
      schemaVersion: 'buildlore.hierarchical-corpus-negative-fixture.v1',
      sourceCount: 117,
      headingCount: 473,
      repeatedHeadingSourceCount: 33,
      repeatedHeadingPairCount: 528,
    });
    expect(fixture.repeatedHeadingSourceCount * (fixture.repeatedHeadingSourceCount - 1) / 2)
      .toBe(fixture.repeatedHeadingPairCount);
    const { sources } = await cleanFixtureRuntime(fixture);
    const historicalFailure = replayHistoricalPlannerFailureForTest(sources, fixture.projectId);
    expect(historicalFailure).toEqual(fixture.historicalPlannerFailure);
    expect(fixture.observedProjection).toMatchObject({
      claimId: 'entry.problem.flat-projection',
      bodyWikiLinkCount: 0,
      headingCount: 473,
      omittedHeadingCount: 356,
      oneLinePageCount: 117,
      pageCount: 117,
      sourceCount: 117,
      uncategorizedPageCount: 117,
    });

    const planned = createSessionTasksAndMerges(sources, 'default', fixture.projectId);
    const permuted = createSessionTasksAndMerges(
      seededPermutation(sources, fixture.permutationSeed),
      'default',
      fixture.projectId,
    );
    expect(permuted).toEqual(planned);
    expect(planned.tasks).toHaveLength(fixture.headingCount);
    expect(planned.mergeCandidates).toHaveLength(fixture.repeatedHeadingPairCount);
    expect(digestHierarchyValue(planned)).toBe(fixture.expectedPlanDigest);
    const expectedRanges = expectedHeadingRanges(sources);
    const actualRanges = planned.tasks.map((task) =>
      `${task.sourceId}:${String(task.startLine)}:${String(task.endLine)}`).sort();
    expect(new Set(actualRanges).size).toBe(fixture.headingCount);
    expect(actualRanges).toEqual(expectedRanges);
    const relationCounts = new Map<string, number>();
    for (const candidate of planned.mergeCandidates) {
      for (const taskId of candidate.memberTaskIds) {
        relationCounts.set(taskId, (relationCounts.get(taskId) ?? 0) + 1);
      }
    }
    expect(Math.max(...relationCounts.values())).toBeLessThanOrEqual(
      SESSION_COMPILE_LIMITS.maxRelationCandidatesPerTask,
    );
  });

  it('rejects all 117 one-line pages in the real semantic quality gate', async () => {
    const fixture = await negativeFixture();
    const { content, sources } = await cleanFixtureRuntime(fixture);
    const shallow = shallowQualityInput(sources, fixture, content);
    const quality = evaluateSemanticQuality(shallow, fixture.projectId);

    expect(shallow.proposals).toHaveLength(fixture.expectedShallowWiki.pageCount);
    expect(shallow.proposals.every((proposal) => proposal.sections.length === 1 &&
      proposal.sections[0]?.body.split('\n').length === 1)).toBe(true);
    expect(shallow.proposals.flatMap((proposal) => proposal.wikilinks)).toHaveLength(
      fixture.expectedShallowWiki.bodyWikiLinkCount,
    );
    expect(quality.corpus).toMatchObject({
      candidateCount: fixture.expectedShallowWiki.pageCount,
      eligibleForApproval: false,
      hardQualityPassed: false,
      uncategorizedPageCount: fixture.expectedShallowWiki.uncategorizedPageCount,
    });
    expect(quality.pages).toHaveLength(fixture.expectedShallowWiki.pageCount);
    expect(quality.pages.every((page) =>
      page.reasonCodes.includes(fixture.expectedShallowWiki.qualityReasonCode))).toBe(true);
  });

  it('binds the observed legacy mismatch while the authoritative path stays clean', async () => {
    const fixture = await negativeFixture();
    const clean = createApprovedAuthorityFixture(
      fixture.projectId,
      hierarchySha256('negative-baseline-sanitizer'),
    );
    expect(fixture.expectedLegacyApprovalCheck).toEqual({
      schemaVersion: 'buildlore.historical-approve-check-expectation.v1',
      claimId: 'entry.problem.approval-state-disconnect',
      approvalOutcome: 'approved',
      providerUsed: false,
      sideEffectsPossible: false,
      checkExitCode: 5,
      gateCodes: ['pending-changes', 'state-unhealthy'],
      stateStatus: 'missing',
      pendingChangesCount: 1,
      sourceCount: 0,
      errorCode: 'QUALITY_GATE_FAILED',
    });
    expect(clean.state.status).toBe('active');
    expect(clean.humanActivationApproval).toMatchObject({
      decision: 'approved',
      explicitConfirmation: true,
      receiptSetDigest: clean.ledger.receiptSetDigest,
      reviewSurfaceDigest: clean.ledger.reviewSurfaceDigest,
    });
    expect(clean.authorityCheck).toMatchObject({
      generationDigest: clean.state.generationDigest,
      humanActivationApprovalDigest: clean.humanActivationApproval.approvalDigest,
      status: 'clean',
      stalePageIds: [],
    });
  });

  it('keeps the complete fixture and runtime observations free of secrets and personal paths',
    async () => {
      const fixtureUrl = new URL('./fixtures/hierarchical-corpus-negative.json', import.meta.url);
      const fixtureText = await readFile(fixtureUrl, 'utf8');
      const fixture = await negativeFixture();
      const { content, sources } = await cleanFixtureRuntime(fixture);
      const planned = createSessionTasksAndMerges(sources, 'default', fixture.projectId);
      const legacy = replayHistoricalPlannerFailureForTest(sources, fixture.projectId);
      const shallow = shallowQualityInput(sources, fixture, content);
      const quality = evaluateSemanticQuality(shallow, fixture.projectId);
      const clean = createApprovedAuthorityFixture(
        fixture.projectId,
        hierarchySha256('negative-baseline-sanitizer'),
      );
      const completeEvidence = JSON.stringify({
        clean,
        fixture,
        fixtureText,
        legacy,
        planned,
        quality,
        shallow,
        sources,
      });

      expect(completeEvidence).not.toMatch(
        /(?:\/home\/|\/Users\/|\/private\/|\/tmp\/|[A-Za-z]:\\|\\\\[^\\]+\\)/u,
      );
      expect(completeEvidence).not.toMatch(
        /(?:ghp_|eyJ[^.]+\.[^.]+\.|PRIVATE KEY|api[-_]?key|access[-_]?token|password|secret(?:s)?\s*[=:])/iu,
      );
  });

  it('admits the clean baseline through real source and sanitizer boundaries fail-closed',
    async () => {
      const fixture = await negativeFixture();
      const security = await securityServiceFixture(fixture.projectId);
      try {
        let sanitizedContent: SanitizedFixtureContent | undefined;
        const contentAdmission = await sanitizeFixtureContentForTest(
          security.service,
          fixture,
          (content) => { sanitizedContent = content; },
        );
        expect(contentAdmission).toEqual({ ok: true });
        if (sanitizedContent === undefined) throw new Error('missing sanitized fixture content');
        const sources = negativeSources(fixture, sanitizedContent);
        let cleanDownstreamCalls = 0;
        for (const source of sources) {
          const result = await admitBaselineSourceForTest(security.service, {
            body: source.sanitizedBody,
            projectId: fixture.projectId,
            sourceId: source.sourceId,
            sourceRef: source.sourceRef,
          }, (approvedBody) => {
            expect(approvedBody).toBe(source.sanitizedBody);
            cleanDownstreamCalls += 1;
          });
          expect(result).toEqual({ ok: true });
        }
        expect(cleanDownstreamCalls).toBe(fixture.sourceCount);

        const sentinels = Object.freeze([
          ['gh', 'p_', 'A1b2C3d4E5f6G7h8J9k0LmNoPq'].join(''),
          ['eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJmaXh0dXJlIn0', '.',
            'MDEyMzQ1Njc4OUFCQ0RFRg'].join(''),
          ['-----BEGIN ', 'PRIVATE KEY-----\n', 'fixture-key-material',
            '\n-----END PRIVATE KEY-----'].join(''),
          ['high-entropy-', 'Q7w9E2r4T6y8U1i3O5p7A9s2D4f6G8h0J2k4L6m8'].join(''),
          '/home/synthetic-owner/wiki.md',
          '/Users/synthetic-owner/wiki.md',
          '/private/synthetic/wiki.md',
          '/tmp/synthetic/wiki.md',
          '\\\\synthetic-server\\private-share\\wiki.md',
          'C:\\Users\\synthetic-owner\\wiki.md',
        ]);
        let proposalDownstreamCalls = 0;
        let qualityDownstreamCalls = 0;
        const failures: BaselineAdmissionResult[] = [];
        for (const [sentinelIndex, sentinel] of sentinels.entries()) {
          for (const field of ['repeatedHeading', 'templateBody'] as const) {
            const unsafeFixture: NegativeBaselineFixture = {
              ...fixture,
              repeatedHeading: field === 'repeatedHeading' ? sentinel : fixture.repeatedHeading,
              expectedShallowWiki: {
                ...fixture.expectedShallowWiki,
                templateBody: field === 'templateBody'
                  ? sentinel
                  : fixture.expectedShallowWiki.templateBody,
              },
            };
            const failure = await sanitizeFixtureContentForTest(
              security.service,
              unsafeFixture,
              (content) => {
                proposalDownstreamCalls += 1;
                const unsafeSources = negativeSources(unsafeFixture, content);
                const shallow = shallowQualityInput(unsafeSources, unsafeFixture, content);
                qualityDownstreamCalls += 1;
                evaluateSemanticQuality(shallow, unsafeFixture.projectId);
              },
            );
            failures.push(failure);
            expect(failure, `sentinel category ${String(sentinelIndex)} in ${field}`).toMatchObject({
              errorCode: 'NEGATIVE_BASELINE_SOURCE_REJECTED',
              ok: false,
            });
            expect(JSON.stringify(failure)).not.toContain(sentinel);
          }
          const unsafeMetadata = {
            ...fixture,
            provenance: {
              ...fixture.provenance,
              entrySnapshot: { ...fixture.provenance.entrySnapshot, path: sentinel },
            },
          };
          let staticError: unknown;
          try {
            parseNegativeFixture(unsafeMetadata);
          } catch (error) {
            staticError = error;
          }
          expect(staticError).toBeInstanceOf(Error);
          expect(String(staticError)).not.toContain(sentinel);
        }
        expect(failures).toHaveLength(sentinels.length * 2);
        expect(proposalDownstreamCalls).toBe(0);
        expect(qualityDownstreamCalls).toBe(0);

        const sourceRefSentinel = '/Users/synthetic-owner/private/wiki.md';
        let sourceRefDownstreamCalls = 0;
        const sourceRefFailure = await admitBaselineSourceForTest(security.service, {
          body: 'Safe relative documentation.',
          projectId: fixture.projectId,
          sourceId: sources[0]?.sourceId ?? SOURCE_ID,
          sourceRef: sourceRefSentinel,
        }, () => { sourceRefDownstreamCalls += 1; });
        expect(sourceRefFailure).toEqual({
          errorCode: 'NEGATIVE_BASELINE_SOURCE_REJECTED',
          ok: false,
        });
        expect(sourceRefDownstreamCalls).toBe(0);
        expect(JSON.stringify(sourceRefFailure)).not.toContain(sourceRefSentinel);
      } finally {
        await rm(security.root, { force: true, recursive: true });
      }
    });

  it('publishes one closed language-neutral JSON Schema family', async () => {
    const schema = JSON.parse(await readFile(
      new URL('../schemas/hierarchical-corpus.schema.json', import.meta.url),
      'utf8',
    )) as {
      readonly oneOf: readonly unknown[];
      readonly $defs: Readonly<Record<string, unknown>>;
    };
    expect(schema.oneOf).toHaveLength(34);
    expect(Object.keys(schema.$defs)).toEqual(expect.arrayContaining([
      'compilationPurpose',
      'textUnit',
      'documentInterpretation',
      'corpusSnapshot',
      'hierarchicalCompilationPolicy',
      'sparseRelationGraph',
      'compilePartitionCursor',
      'compileContinuation',
      'compilePartition',
      'planningDispositionInventory',
      'documentInterpretationRule',
      'pageBlueprint',
      'wikiOutline',
      'wikiOutlineDiff',
      'wikiOutlineReview',
      'evidencePack',
      'currentSessionGenerationRequest',
      'hierarchicalWikiProposal',
      'wikiLinkReconciliation',
      'externalGenerationAuthorization',
      'semanticQualityPolicy',
      'pageQualityReport',
      'corpusQualityReport',
      'currentSessionGenerationReceiptContract',
      'wikiSectionContentDiff',
      'wikiContentDiff',
      'removedBaselineWikiPage',
      'integratedWikiReviewCoverage',
      'integratedWikiReviewCandidate',
      'integratedWikiReviewSurface',
      'integratedWikiCandidateReview',
      'childSynthesisReview',
      'compileIntegrityReport',
      'compileRunLedger',
      'pageOwnershipGraph',
      'authoritativeWikiState',
      'humanActivationApproval',
      'authoritativeWikiCheck',
      'legacyWikiMigration',
      'legacyWikiMigrationReview',
    ]));
    const closedDigestContracts = Object.freeze([
      ['currentSessionGenerationReceiptContract', 'receiptDigest'],
      ['wikiContentDiff', 'diffDigest'],
      ['removedBaselineWikiPage', 'removalDigest'],
      ['integratedWikiReviewCoverage', 'coverageDigest'],
      ['integratedWikiReviewCandidate', 'candidateDigest'],
      ['integratedWikiReviewSurface', 'surfaceDigest'],
      ['integratedWikiCandidateReview', 'reviewDigest'],
      ['childSynthesisReview', 'reviewDigest'],
      ['compileIntegrityReport', 'reportDigest'],
      ['compileRunLedger', 'ledgerDigest'],
      ['pageOwnershipGraph', 'graphDigest'],
      ['authoritativeWikiState', 'generationDigest'],
      ['humanActivationApproval', 'approvalDigest'],
      ['authoritativeWikiCheck', 'checkDigest'],
    ] as const);
    for (const [definitionName, digestField] of closedDigestContracts) {
      const definition = schema.$defs[definitionName] as Readonly<{
        readonly additionalProperties?: unknown;
        readonly 'x-buildlore-digestExcludes'?: unknown;
      }>;
      expect(definition.additionalProperties).toBe(false);
      expect(definition['x-buildlore-digestExcludes']).toEqual([digestField]);
    }
    expect((schema.$defs.wikiSectionContentDiff as Readonly<{
      readonly additionalProperties?: unknown;
    }>).additionalProperties).toBe(false);
    const childSynthesisReview = schema.$defs.childSynthesisReview as Readonly<{
      readonly required?: readonly string[];
      readonly properties?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    }>;
    expect(childSynthesisReview.required).toEqual([
      'pageId', 'proposalDigest', 'reviewDigest', 'decision',
    ]);
    expect(childSynthesisReview.properties?.decision).toEqual({ const: 'accepted' });
    const integratedReview = schema.$defs.integratedWikiCandidateReview as Readonly<{
      readonly allOf?: readonly unknown[];
      readonly properties?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    }>;
    expect(integratedReview.properties?.decision).toEqual({
      enum: ['accepted', 'rejected'],
    });
    expect(integratedReview.allOf).toEqual([{
      if: { properties: { decision: { const: 'rejected' } } },
      then: { properties: { reasonCodes: { minItems: 1 } } },
    }]);
    const candidateDisposition = schema.$defs.compileCandidateDisposition as Readonly<{
      readonly additionalProperties?: unknown;
      readonly properties?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    }>;
    expect(candidateDisposition.additionalProperties).toBe(false);
    expect(candidateDisposition.properties?.decision).toEqual({
      enum: ['accepted', 'rejected'],
    });
    expect(JSON.stringify(schema)).toContain('unicode-scalar-inclusive');
    expect(JSON.stringify(schema)).not.toMatch(/plan2agent|(?:^|[^a-z])p2a(?:[^a-z]|$)/iu);
  });
});
