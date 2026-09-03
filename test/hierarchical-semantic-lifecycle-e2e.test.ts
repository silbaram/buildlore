import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
  createHierarchicalWikiActivationService,
} from '../src/cli/index.js';
import {
  HIERARCHICAL_COMPILATION_POLICY,
  advanceCompileContinuation,
  buildSparseRelationGraph,
  checkAuthoritativeWikiState,
  createCompilationPurpose,
  createCompileCandidateReview,
  createCompileIntegrityReport,
  createCompileRelationReview,
  createCorpusSnapshot,
  createCurrentSessionGenerationService,
  createEvidencePack,
  createHumanActivationApproval,
  createIntegratedWikiCandidateReview,
  createIntegratedWikiReviewSurface,
  createPageOwnershipGraph,
  createProjectSessionCompiler,
  createTextUnit,
  digestHierarchyValue,
  finalizeCompileRun,
  finalizePlanningDispositionInventory,
  hierarchySha256,
  startCompileContinuation,
  verifyCompileRunApproval,
  type CompilePartitionV2,
  type CorpusSnapshotV1,
  type CurrentSessionGenerationExchangeV1,
  type CurrentSessionGenerationHandoffV1,
  type CurrentSessionProposalSubmissionV1,
  type EvidencePackV1,
  type FinalizeCompileRunInputV1,
  type HierarchicalWikiProposalV1,
  type SanitizedEvidenceSourceV1,
  type SessionCompilePlanV1,
  type WikiOutlineV1,
} from '../src/compiler/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { createRepositoryWriterLease } from '../src/knowledge/repository-writer-lease.js';
import {
  createProjectSyncService,
  createSourceManagement,
  initializeSingleProjectQuickstart,
} from '../src/projector/index.js';
import {
  APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION,
  createLocalWikiOperator,
  LocalWikiRetrievalError,
  type ApprovedWikiAuthorityV1,
} from '../src/retrieval/index.js';
import {
  bindLocalModel,
  createEmbeddingIdentityV2,
  inspectLocalModelBinding,
  MULTILINGUAL_E5_SMALL_PROFILE,
  type EmbeddingIdentityV2,
  type EmbeddingProviderPort,
  type LocalModelBindingPort,
} from '../src/retrieval/embedding/index.js';
import { verifyLocalModelBindingForTest } from '../src/retrieval/embedding/model-binding.js';
import { createProjectSecurityService, readSecurityPolicy } from '../src/sanitizer/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = 'hierarchical-lifecycle';
const MODEL_PROFILE_ID = 'multilingual-e5-small';
const temporaryRoots: string[] = [];

function lifecyclePageId(stableKey: string): string {
  return `page-${digestHierarchyValue({
    projectId: PROJECT_ID,
    purposeDigest: lifecyclePurpose().purposeDigest,
    stableKey,
  }).slice('sha256:'.length)}`;
}

const ROOT_PAGE = lifecyclePageId('lifecycle.root');
const AFFECTED_PAGE = lifecyclePageId('lifecycle.affected');
const UNAFFECTED_PAGE = lifecyclePageId('lifecycle.unaffected');

const AFFECTED_V1 =
  'Ambercycle workflow rotates local index artifacts while preserving reviewed approval lineage.';
const AFFECTED_V2 =
  'Novacycle workflow rebuilds local index artifacts after synchronized source revision.';
const UNAFFECTED_LEAF =
  'Cobaltstable operations remain active when another source revision changes.';
const UNAFFECTED_ROOT =
  'Violet overview connects reviewed child pages without owning the changed source.';

// There is not yet one product orchestration API from a synchronized session plan to a
// hierarchical authority bundle. This test composes the existing contract functions so it can
// exercise the persisted handoffs; it is not evidence for a user-facing hierarchical compile CLI.

interface LifecycleAuthority {
  readonly authority: ApprovedWikiAuthorityV1;
  readonly affectedSourceId: string;
}

interface LifecycleFixture {
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly sourceRoot: string;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const commitEnvironment = args[0] === 'commit'
    ? {
        GIT_AUTHOR_DATE: '2026-08-31T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-08-31T00:00:00Z',
      }
    : {};
  await execFileAsync('git', [...args], {
    cwd,
    env: { ...process.env, ...commitEnvironment, LC_ALL: 'C' },
  });
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
}

function stableSourceId(sourceRef: string): string {
  // Session plan source IDs include the revision. Hierarchical selective staleness instead needs
  // a stable document identity, so this seam binds that identity to the declared portable ref.
  return `source-${hierarchySha256(`${PROJECT_ID}:${sourceRef}`).slice('sha256:'.length)}`;
}

function embeddingIdentity(): EmbeddingIdentityV2 {
  const dynamic = `sha256:${'1'.repeat(64)}` as const;
  return createEmbeddingIdentityV2(MULTILINGUAL_E5_SMALL_PROFILE, [
    { basename: 'config.json', bytes: 512, role: 'model-config', sha256: dynamic },
    {
      basename: 'onnx/model.onnx',
      bytes: 1024,
      role: 'model',
      sha256: 'sha256:ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
    },
    {
      basename: 'tokenizer.json',
      bytes: 1024,
      role: 'tokenizer',
      sha256: 'sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    },
    {
      basename: 'tokenizer_config.json',
      bytes: 256,
      role: 'tokenizer-config',
      sha256: dynamic,
    },
  ]);
}

function vectorFor(text: string): Float32Array {
  const hash = createHash('sha256').update(text, 'utf8').digest();
  const vector = new Float32Array(384);
  for (const [index, byte] of hash.entries()) {
    const component = (byte + index) % vector.length;
    vector[component] = (vector[component] ?? 0) + (byte + 1) / 256;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}

function deterministicProvider(calls: string[]): EmbeddingProviderPort {
  const identity = embeddingIdentity();
  return Object.freeze({
    activeIdentity: () => identity,
    countDocumentTokens(texts: readonly string[]) {
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity,
        maximumTokens: 512 as const,
        providerUsed: 'local-in-process' as const,
        tokenCounts: Object.freeze(texts.map((text) => Math.max(1, Array.from(text).length))),
      }));
    },
    embedDocuments(texts: readonly string[]) {
      calls.push('documents');
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity,
        providerUsed: 'local-in-process' as const,
        truncated: Object.freeze(texts.map(() => false)),
        vectors: Object.freeze(texts.map(vectorFor)),
      }));
    },
    embedQuery(text: string) {
      calls.push('query');
      return Promise.resolve(Object.freeze({
        egress: 'none' as const,
        identity,
        providerUsed: 'local-in-process' as const,
        truncated: Object.freeze([false]),
        vectors: Object.freeze([vectorFor(text)]),
      }));
    },
    inspectCapabilities: () => Object.freeze({
      adapterKind: 'transformers-js' as const,
      device: 'cpu' as const,
      egress: 'none' as const,
      maximumBatchSize: 32 as const,
      maximumQueryUtf8Bytes: 4096 as const,
      networkAllowed: false as const,
      providerUsed: 'local-in-process' as const,
    }),
    readiness: () => Object.freeze({ activeIdentity: identity, state: 'ready' as const }),
  });
}

async function fixture(): Promise<LifecycleFixture> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-hierarchical-lifecycle-'));
  temporaryRoots.push(root);
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
    writeFile(join(sourceRoot, 'docs/affected.md'), `${AFFECTED_V1}\n`, 'utf8'),
    writeFile(
      join(sourceRoot, 'docs/unaffected.md'),
      `${UNAFFECTED_LEAF}\n${UNAFFECTED_ROOT}\n`,
      'utf8',
    ),
  ]);
  await git(sourceRoot, ['add', '.']);
  await git(sourceRoot, ['commit', '-m', 'seed generic lifecycle sources']);
  await initializeSingleProjectQuickstart(hubRoot, {
    branch: 'main',
    knowledgeRepository: '../knowledge.git',
    projectId: PROJECT_ID,
    sourceRepository: `https://example.test/${PROJECT_ID}.git`,
    sourceRoot,
  });
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await writeSecurityPolicy(knowledgeRoot, PROJECT_ID, { capabilities: ['compile'] });
  return Object.freeze({ hubRoot, knowledgeRoot, sourceRoot });
}

function pageBlueprint(input: Readonly<{
  readonly childPageIds: readonly string[];
  readonly generationOrder: number;
  readonly graph: ReturnType<typeof buildSparseRelationGraph>;
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly snapshot: CorpusSnapshotV1;
  readonly sourceIds: readonly string[];
  readonly stableKey: string;
  readonly title: string;
}>): WikiOutlineV1['blueprints'][number] {
  const candidate = Object.freeze({
    schemaVersion: 'buildlore.page-blueprint.v2' as const,
    projectId: PROJECT_ID,
    pageId: input.pageId,
    stableKey: input.stableKey,
    role: input.parentPageId === null ? 'overview' as const : 'topic' as const,
    title: input.title,
    parentPageId: input.parentPageId,
    childPageIds: Object.freeze([...input.childPageIds].sort()),
    relatedPageIds: Object.freeze([]),
    keyQuestions: Object.freeze(['How does the reviewed local Wiki lifecycle remain current?']),
    requiredSections: Object.freeze(['evidence']),
    evidenceScope: Object.freeze({
      snapshotDigest: input.snapshot.snapshotDigest,
      taskSetDigest: input.graph.taskSetDigest,
      relationSetDigest: input.graph.relationSetDigest,
      allowedUnitKinds: Object.freeze([
        'document', 'fenced-code', 'heading', 'list', 'paragraph', 'table',
      ] as const),
      sourceIds: Object.freeze([...input.sourceIds].sort()),
      preferredUnitIds: Object.freeze([]),
    }),
    minimumDistinctSources: 1,
    generationOrder: input.generationOrder,
  });
  return Object.freeze({
    ...candidate,
    blueprintDigest: digestHierarchyValue(candidate),
  });
}

function evidencePack(
  page: WikiOutlineV1['blueprints'][number],
  snapshot: CorpusSnapshotV1,
  sources: readonly SanitizedEvidenceSourceV1[],
  unitOrdinal: number,
): EvidencePackV1 {
  const sourceId = page.evidenceScope.sourceIds[0];
  if (sourceId === undefined) throw new Error('Lifecycle evidence source is missing.');
  const unit = snapshot.textUnits.find((candidate) =>
    candidate.sourceId === sourceId && candidate.ordinal === unitOrdinal);
  if (unit === undefined) throw new Error('Lifecycle evidence is missing.');
  return createEvidencePack({
    blueprint: page,
    snapshot,
    sources,
    selectedUnitIds: [unit.unitId],
    conflicts: Object.freeze([]),
    gaps: Object.freeze([]),
  }, PROJECT_ID);
}

function proposalSubmission(
  page: WikiOutlineV1['blueprints'][number],
  pack: EvidencePackV1,
  exchange: CurrentSessionGenerationExchangeV1,
): CurrentSessionProposalSubmissionV1 {
  const unit = pack.units[0];
  if (unit === undefined) throw new Error('Lifecycle proposal evidence is missing.');
  const claim = Object.freeze({
    text: unit.content,
    evidenceUnitIds: Object.freeze([unit.unitId]),
    citationIds: Object.freeze([unit.citation.citationId]),
  });
  const wikilinks = Object.freeze([
    ...(page.parentPageId === null ? [] : [page.parentPageId]),
    ...page.childPageIds,
  ].sort());
  const childSynthesis = exchange.request.approvedChildSummaries.map((summary) =>
    `${summary.summary} ${summary.citationIds.map((citationId) =>
      `[^${citationId}]`).join(' ')}`).join(' ');
  const candidate = Object.freeze({
    schemaVersion: 'buildlore.current-session-proposal-submission.v2' as const,
    projectId: PROJECT_ID,
    pageId: page.pageId,
    exchangeDigest: exchange.exchangeDigest,
    requestDigest: exchange.requestDigest,
    title: page.title,
    summary: unit.content,
    sections: Object.freeze([Object.freeze({
      sectionId: 'evidence',
      body: `How does the reviewed local Wiki lifecycle remain current? ${unit.content} ` +
        `[^${unit.citation.citationId}] ${childSynthesis} ` +
        wikilinks.map((id) => `[[${id}]]`).join(' '),
    })]),
    claims: Object.freeze([claim]),
    wikilinks,
  });
  return candidate;
}

const snapshotSourceInputs = new WeakMap<CorpusSnapshotV1, ReadonlyMap<string, Readonly<{
  readonly body: string;
  readonly sourceKind: 'code' | 'markdown' | 'planning' | 'text';
}>>>();

function lifecyclePurpose() {
  return createCompilationPurpose({
    audience: ['Maintainers'],
    excludedTopics: ['Hosted services'],
    goals: ['Validate one reviewed local Wiki lifecycle'],
    keyQuestions: ['How does the reviewed local Wiki lifecycle remain current?'],
    outputLanguage: 'en',
    projectId: PROJECT_ID,
    requestedPageRoles: ['overview'],
    scopeHints: ['Explicit generic source declarations'],
  });
}

function snapshotFromPlan(
  plan: SessionCompilePlanV1,
  sanitizerPolicyDigest: `sha256:${string}`,
): CorpusSnapshotV1 {
  const purpose = lifecyclePurpose();
  const planned = [...plan.sources].sort((left, right) =>
    left.sourceRef < right.sourceRef ? -1 : left.sourceRef > right.sourceRef ? 1 : 0);
  const sources = planned.map((source) => Object.freeze({
    sourceId: stableSourceId(source.sourceRef),
    sourceRevision: source.revision,
    sourceRef: source.sourceRef,
    sanitizedContentDigest: source.sanitizedContentDigest,
  }));
  const sourceInputs = new Map<string, Readonly<{
    readonly body: string;
    readonly sourceKind: 'code' | 'markdown' | 'planning' | 'text';
  }>>();
  const textUnits = planned.flatMap((source) => {
    const sourceId = stableSourceId(source.sourceRef);
    sourceInputs.set(sourceId, Object.freeze({
      body: source.sanitizedBody,
      sourceKind: source.sourceKind,
    }));
    return source.sanitizedBody.trimEnd().split('\n').map((content, ordinal) => {
      return createTextUnit({
        contentDigest: hierarchySha256(content),
        kind: 'paragraph',
        ordinal,
        projectId: PROJECT_ID,
        range: {
          endColumn: Array.from(content).length,
          endLine: ordinal + 1,
          startColumn: 1,
          startLine: ordinal + 1,
        },
        sourceId,
        sourceRef: source.sourceRef,
        sourceRevision: source.revision,
      });
    });
  });
  const snapshot = createCorpusSnapshot({
    compilerContractDigest: plan.contractDigest,
    interpretationRulesDigest: hierarchySha256('lifecycle-interpretation-rules'),
    policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
    profileDigest: plan.profileDigest,
    projectId: PROJECT_ID,
    purposeDigest: purpose.purposeDigest,
    sanitizerPolicyDigest,
    sourceManifestDigest: plan.sourceManifestDigest,
    sources,
    textUnits,
  });
  snapshotSourceInputs.set(snapshot, sourceInputs);
  return snapshot;
}

async function approvedAuthority(
  snapshot: CorpusSnapshotV1,
  currentAuthority: ApprovedWikiAuthorityV1 | null,
  knowledgeRoot: string,
): Promise<LifecycleAuthority> {
  const currentState = currentAuthority?.state ?? null;
  const graph = buildSparseRelationGraph(snapshot, PROJECT_ID);
  const affectedSourceId = stableSourceId('docs/affected.md');
  const unaffectedSourceId = stableSourceId('docs/unaffected.md');
  const blueprints = Object.freeze([
    pageBlueprint({
      childPageIds: [],
      generationOrder: 0,
      graph,
      pageId: AFFECTED_PAGE,
      parentPageId: ROOT_PAGE,
      snapshot,
      sourceIds: [affectedSourceId],
      stableKey: 'lifecycle.affected',
      title: 'Affected lifecycle',
    }),
    pageBlueprint({
      childPageIds: [],
      generationOrder: 1,
      graph,
      pageId: UNAFFECTED_PAGE,
      parentPageId: ROOT_PAGE,
      snapshot,
      sourceIds: [unaffectedSourceId],
      stableKey: 'lifecycle.unaffected',
      title: 'Unaffected lifecycle',
    }),
    pageBlueprint({
      childPageIds: [AFFECTED_PAGE, UNAFFECTED_PAGE],
      generationOrder: 2,
      graph,
      pageId: ROOT_PAGE,
      parentPageId: null,
      snapshot,
      sourceIds: [affectedSourceId, unaffectedSourceId],
      stableKey: 'lifecycle.root',
      title: 'Lifecycle overview',
    }),
  ]);
  const outlineBasis = Object.freeze({
    schemaVersion: 'buildlore.wiki-outline.v2' as const,
    projectId: PROJECT_ID,
    snapshotDigest: snapshot.snapshotDigest,
    graphDigest: graph.graphDigest,
    interpretationSetDigest: hierarchySha256('lifecycle-interpretations'),
    purposeDigest: snapshot.purposeDigest,
    policyDigest: snapshot.policyDigest,
    activationState: 'candidate' as const,
    rootPageId: ROOT_PAGE,
    blueprints,
    reviewNotes: Object.freeze([]),
  });
  const outline: WikiOutlineV1 = Object.freeze({
    ...outlineBasis,
    outlineDigest: digestHierarchyValue(outlineBasis),
  });
  let continuation = startCompileContinuation(graph, 256, PROJECT_ID);
  const partitions: CompilePartitionV2[] = [];
  while (!continuation.complete) {
    const cursor = continuation.nextCursor;
    if (cursor === null) throw new Error('Lifecycle planning continuation is incomplete.');
    const advanced = advanceCompileContinuation(graph, continuation, cursor, PROJECT_ID);
    partitions.push(advanced.partition);
    continuation = advanced.continuation;
  }
  const planningInventory = finalizePlanningDispositionInventory(
    graph,
    continuation,
    partitions,
    PROJECT_ID,
  );
  const sourceInputById = snapshotSourceInputs.get(snapshot);
  if (sourceInputById === undefined) throw new Error('Lifecycle source inputs are missing.');
  const security = createProjectSecurityService({ knowledgeRoot });
  const evidenceSources: SanitizedEvidenceSourceV1[] = [];
  for (const source of snapshot.sources) {
    const sourceInput = sourceInputById.get(source.sourceId);
    if (sourceInput === undefined) throw new Error('Lifecycle source input is missing.');
    const prepared = await security.prepareSource({
      body: sourceInput.body,
      bodyDigest: hierarchySha256(sourceInput.body),
      projectId: PROJECT_ID,
      source: source.sourceRef,
      sourceKind: sourceInput.sourceKind,
      sourceRevisionOrContentSha256: source.sourceRevision,
    });
    if (!prepared.ok || prepared.report.outputDigest !== source.sanitizedContentDigest) {
      throw new Error('Lifecycle source sanitizer replay failed.');
    }
    evidenceSources.push(Object.freeze({
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      sourceRef: source.sourceRef,
      preparedSource: prepared.prepared,
    }));
  }
  const packs = Object.freeze([
    evidencePack(
      blueprints[0] as WikiOutlineV1['blueprints'][number],
      snapshot,
      evidenceSources,
      0,
    ),
    evidencePack(
      blueprints[1] as WikiOutlineV1['blueprints'][number],
      snapshot,
      evidenceSources,
      0,
    ),
    evidencePack(
      blueprints[2] as WikiOutlineV1['blueprints'][number],
      snapshot,
      evidenceSources,
      1,
    ),
  ]);
  const generationService = createCurrentSessionGenerationService({ knowledgeRoot });
  const generationHandoffs: CurrentSessionGenerationHandoffV1[] = [];
  const childSynthesisReviews: ReturnType<typeof createCompileCandidateReview>[] = [];
  for (const [index, page] of blueprints.entries()) {
    const approvedChildSummaries = Object.freeze(page.childPageIds.map((childPageId) => {
      const child = generationHandoffs.find((handoff) =>
        (handoff.exchange as CurrentSessionGenerationExchangeV1).pageId === childPageId);
      const result = child?.result as
        { readonly proposal: HierarchicalWikiProposalV1 } | undefined;
      const review = childSynthesisReviews.find((item) => item.pageId === childPageId);
      if (result === undefined || review === undefined) {
        throw new Error('Lifecycle child synthesis handoff is missing.');
      }
      return Object.freeze({
        pageId: childPageId,
        proposalDigest: result.proposal.proposalDigest,
        reviewDigest: review.reviewDigest,
        summary: result.proposal.summary,
        citationIds: result.proposal.citationIds,
        synthesisApproved: true as const,
      });
    }));
    const session = await generationService.prepare({
      purpose: lifecyclePurpose(),
      blueprint: page,
      evidencePack: packs[index] as EvidencePackV1,
      approvedChildSummaries,
    }, PROJECT_ID);
    const result = await session.submit(proposalSubmission(
      page,
      packs[index] as EvidencePackV1,
      session.exchange,
    ));
    generationHandoffs.push(Object.freeze({ exchange: session.exchange, result }));
    if (page.parentPageId !== null) {
      childSynthesisReviews.push(createCompileCandidateReview(
        result.proposal,
        'accepted',
        PROJECT_ID,
      ));
    }
  }
  const proposals = Object.freeze(generationHandoffs.map((handoff) =>
    (handoff.result as { readonly proposal: HierarchicalWikiProposalV1 }).proposal));
  const reconciliationBasis = Object.freeze({
    schemaVersion: 'buildlore.wiki-link-reconciliation.v1' as const,
    projectId: PROJECT_ID,
    outlineDigest: outline.outlineDigest,
    entries: Object.freeze(blueprints.map((page) => Object.freeze({
      pageId: page.pageId,
      requiredLinkPageIds: Object.freeze([
        ...(page.parentPageId === null ? [] : [page.parentPageId]),
        ...page.childPageIds,
      ].sort()),
    })).sort((left, right) => left.pageId < right.pageId ? -1 : 1)),
    complete: true as const,
  });
  const reconciliation = Object.freeze({
    ...reconciliationBasis,
    reconciliationDigest: digestHierarchyValue(reconciliationBasis),
  });
  const baselineGenerationDigest = currentAuthority?.state.generationDigest ?? null;
  const baselineProposals = currentAuthority?.finalization.proposals ?? Object.freeze([]);
  const integratedReviewSurface = createIntegratedWikiReviewSurface({
    graph,
    outline,
    planningInventory,
    generations: Object.freeze(generationHandoffs),
    reconciliation,
    baselineGenerationDigest,
    baselineProposals,
  }, PROJECT_ID);
  const integratedReviews = Object.freeze(integratedReviewSurface.candidates.map((candidate) =>
    createIntegratedWikiCandidateReview(
      integratedReviewSurface,
      candidate.pageId,
      'accepted',
      [],
      PROJECT_ID,
    )));
  const quality = Object.freeze({
    corpus: integratedReviewSurface.corpusQualityReport,
    pages: Object.freeze(integratedReviewSurface.candidates.map((candidate) =>
      candidate.pageQualityReport)),
  });
  const integrityInput = Object.freeze({
    baselineGenerationDigest,
    baselineProposals,
    childSynthesisReviews: Object.freeze(childSynthesisReviews),
    corpusQualityReport: quality.corpus,
    evidencePacks: packs,
    graph,
    generationHandoffs: Object.freeze(generationHandoffs),
    integratedReviews,
    integratedReviewSurface,
    outline,
    pageQualityReports: quality.pages,
    partitions: Object.freeze(partitions),
    planningInventory,
    proposals,
    reconciliation,
    relationReviews: Object.freeze(graph.relations.map((relation) =>
      createCompileRelationReview(relation.relationId, 'accepted', PROJECT_ID))),
  });
  const finalization: FinalizeCompileRunInputV1 = Object.freeze({
    ...integrityInput,
    integrityReport: createCompileIntegrityReport(integrityInput, PROJECT_ID),
  });
  const ledger = finalizeCompileRun(finalization, PROJECT_ID);
  const ownershipGraph = createPageOwnershipGraph(
    snapshot,
    outline,
    ledger,
    proposals,
    packs,
    PROJECT_ID,
  );
  const humanActivationApproval = createHumanActivationApproval({
    ledger,
    ownershipGraph,
    currentState,
    decision: 'approved',
    explicitConfirmation: true,
  }, PROJECT_ID);
  const state = verifyCompileRunApproval({
    currentState,
    finalization,
    humanActivationApproval,
    ledger,
    liveSnapshot: snapshot,
    ownershipGraph,
  }, PROJECT_ID);
  const authorityCheck = checkAuthoritativeWikiState(
    state,
    ownershipGraph,
    snapshot,
    humanActivationApproval,
    PROJECT_ID,
  );
  return Object.freeze({
    affectedSourceId,
    authority: Object.freeze({
      authorityCheck,
      currentState,
      finalization,
      humanActivationApproval,
      ledger,
      liveSnapshot: snapshot,
      ownershipGraph,
      projectId: PROJECT_ID,
      schemaVersion: APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION,
      state,
    }),
  });
}

async function activate(
  fixtureValue: LifecycleFixture,
  authority: ApprovedWikiAuthorityV1,
) {
  await writeFile(
    join(fixtureValue.hubRoot, '.buildlore/approved-wiki.json'),
    serializeCanonicalJson({
      authority,
      projectId: PROJECT_ID,
      schemaVersion: HIERARCHICAL_WIKI_ACTIVATION_INPUT_SCHEMA_VERSION,
    }),
    'utf8',
  );
  const activated = await createHierarchicalWikiActivationService({
    hubRoot: fixtureValue.hubRoot,
    knowledgeRoot: fixtureValue.knowledgeRoot,
  }).activate({
    confirmationDigest: authority.humanActivationApproval.approvalDigest,
    projectId: PROJECT_ID,
  });
  expect(activated).toMatchObject({
    egress: 'none',
    materialization: {
      fileCount: authority.state.activePages.length + 1,
      pageCount: authority.state.activePages.length,
      state: 'ready',
    },
    pageCount: 3,
    projectId: PROJECT_ID,
    providerUsed: 'none',
  });
  const namespace = join(
    fixtureValue.knowledgeRoot,
    'projects',
    PROJECT_ID,
    'wiki',
    'buildlore-hierarchy',
  );
  const manifest = JSON.parse(await readFile(join(namespace, 'manifest.json'), 'utf8')) as {
    files: Array<{ path: string }>;
    generationDigest: string;
    materializationDigest: string;
  };
  expect(manifest).toMatchObject({
    generationDigest: authority.state.generationDigest,
    materializationDigest: activated.materialization.materializationDigest,
  });
  expect((await readdir(namespace)).sort()).toEqual([
    'index.md',
    'manifest.json',
    ...authority.state.activePages.map((page) => `${page.pageId}.md`),
  ].sort());
  expect(manifest.files.map((file) => file.path).sort()).toEqual([
    'index.md',
    ...authority.state.activePages.map((page) => `${page.pageId}.md`),
  ].sort());
  const index = await readFile(join(namespace, 'index.md'), 'utf8');
  for (const proposal of authority.finalization.proposals) {
    expect(index).toContain(`./${proposal.pageId}.md`);
    const page = await readFile(join(namespace, `${proposal.pageId}.md`), 'utf8');
    expect(page).toContain(`# ${proposal.title}`);
    expect(page).toContain(proposal.summary);
    expect(page).toContain('## Navigation');
  }
  return activated;
}

function logicalHits(result: Awaited<ReturnType<ReturnType<typeof createLocalWikiOperator>['search']>>) {
  return result.hits.map((hit) => Object.freeze({
    channels: hit.channels,
    locator: hit.locator,
    score: hit.score,
    scoreKind: hit.scoreKind,
  }));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('hierarchical semantic lifecycle handoff integration', () => {
  it('carries one synced workspace through approval, staleness and offline rebuild', async () => {
    const current = await fixture();
    const sources = createSourceManagement({ hubRoot: current.hubRoot });
    await sources.add({
      id: 'affected',
      kind: 'markdown',
      path: 'docs/affected.md',
      projectId: PROJECT_ID,
    });
    await sources.add({
      id: 'unaffected',
      kind: 'markdown',
      path: 'docs/unaffected.md',
      projectId: PROJECT_ID,
    });
    await expect(sources.list(PROJECT_ID)).resolves.toMatchObject({ declarationCount: 2 });
    const firstSync = await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: PROJECT_ID,
    });
    expect(firstSync).toMatchObject({ appliedCount: 2, remainingCount: 0 });
    expect(firstSync.writes.every((write) => write.writeStatus === 'create')).toBe(true);

    const compiler = createProjectSessionCompiler({
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
    });
    const firstPlan = await compiler.plan({ projectId: PROJECT_ID });
    expect(firstPlan.sources.map((source) => source.sourceRef).sort())
      .toEqual(['docs/affected.md', 'docs/unaffected.md']);
    expect(firstPlan.sources.every((source) =>
      source.sanitizedBody.endsWith('\n') &&
      hierarchySha256(source.sanitizedBody) === source.sanitizedContentDigest)).toBe(true);
    const policy = await readSecurityPolicy(current.knowledgeRoot, PROJECT_ID);
    const firstSnapshot = snapshotFromPlan(firstPlan, policy.digest);
    const first = await approvedAuthority(firstSnapshot, null, current.knowledgeRoot);
    expect(first.authority.authorityCheck).toMatchObject({
      status: 'clean',
      stalePageIds: [],
    });
    const firstActivation = await activate(current, first.authority);

    const modelDirectory = join(current.hubRoot, '.buildlore/models', MODEL_PROFILE_ID);
    await mkdir(modelDirectory, { recursive: true });
    await expect(bindLocalModel(current.hubRoot, { profileId: MODEL_PROFILE_ID }))
      .resolves.toMatchObject({ outcome: 'created', state: 'unavailable' });
    const modelView = await verifyLocalModelBindingForTest(
      current.hubRoot,
      MODEL_PROFILE_ID,
      { verifyArtifacts: () => Promise.resolve(embeddingIdentity()) },
    );
    // The registry/binding path is real; only artifact inference is deterministic here. The
    // opt-in actual-model test owns the pinned ONNX runtime and numerical inference evidence.
    expect(modelView).toMatchObject({
      activeIdentity: { modelId: 'intfloat/multilingual-e5-small' },
      reasonCode: null,
      state: 'ready',
    });
    expect(JSON.stringify(modelView)).not.toContain(current.hubRoot);
    const bindingChecks: string[] = [];
    const localModels: LocalModelBindingPort = Object.freeze({
      bind: (input: Parameters<LocalModelBindingPort['bind']>[0]) =>
        bindLocalModel(current.hubRoot, input),
      inspect: (profileId: string) => inspectLocalModelBinding(current.hubRoot, profileId),
      verify(profileId: string) {
        bindingChecks.push(profileId);
        return inspectLocalModelBinding(current.hubRoot, profileId);
      },
    });
    const providerCalls: string[] = [];
    const operator = createLocalWikiOperator({
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      localModels,
      provider: deterministicProvider(providerCalls),
      repositoryLease: createRepositoryWriterLease(),
    });

    await expect(operator.indexStatus(PROJECT_ID)).resolves.toMatchObject({
      materialization: { state: 'ready' },
      reasonCode: 'semantic-index-unavailable',
      semanticUsable: false,
    });
    await expect(operator.search({
      mode: 'hybrid',
      projectId: PROJECT_ID,
      query: 'Ambercycle',
    })).resolves.toMatchObject({
      effectiveMode: 'lexical-graph',
      fallback: { reasonCode: 'semantic-index-unavailable' },
      providerUsed: 'none',
    });
    expect(providerCalls).toEqual([]);
    try {
      await operator.search({ mode: 'semantic', projectId: PROJECT_ID, query: 'Ambercycle' });
      throw new Error('Expected semantic search to require an index.');
    } catch (error) {
      expect(error).toBeInstanceOf(LocalWikiRetrievalError);
      expect(error).toMatchObject({ reasonCode: 'semantic-index-unavailable' });
      expect(JSON.stringify(error)).not.toContain(current.hubRoot);
    }

    await expect(operator.rebuildIndex({ projectId: PROJECT_ID })).resolves.toMatchObject({
      requestedMode: 'incremental',
      result: {
        ledger: { effectiveMode: 'full', egress: 'none', providerUsed: 'local-in-process' },
        outcome: 'activated',
      },
    });
    expect(bindingChecks).toEqual([MODEL_PROFILE_ID, MODEL_PROFILE_ID]);
    expect(providerCalls).toEqual(['documents']);
    const semantic = await operator.search({
      mode: 'semantic',
      projectId: PROJECT_ID,
      query: 'Ambercycle',
      topK: 20,
    });
    expect(semantic).toMatchObject({
      effectiveMode: 'semantic',
      fallback: null,
      providerUsed: 'local-in-process',
    });
    expect(semantic.hits.map((hit) => hit.locator.pageId)).toContain(AFFECTED_PAGE);
    const firstHybrid = await operator.search({
      mode: 'hybrid',
      projectId: PROJECT_ID,
      query: 'Ambercycle',
      topK: 20,
    });
    expect(firstHybrid).toMatchObject({
      effectiveChannels: ['lexical', 'graph', 'semantic'],
      effectiveMode: 'hybrid',
      fallback: null,
    });
    expect(firstHybrid.hits.map((hit) => hit.locator.pageId)).toContain(AFFECTED_PAGE);

    await writeFile(join(current.sourceRoot, 'docs/affected.md'), `${AFFECTED_V2}\n`, 'utf8');
    await git(current.sourceRoot, ['add', 'docs/affected.md']);
    await git(current.sourceRoot, ['commit', '-m', 'revise affected lifecycle source']);
    const secondSync = await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: PROJECT_ID,
    });
    expect(secondSync).toMatchObject({ appliedCount: 1, remainingCount: 0 });
    expect(secondSync.writes.map((write) => write.writeStatus).sort())
      .toEqual(['unchanged', 'update']);
    const secondPlan = await compiler.plan({ projectId: PROJECT_ID }).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error &&
        typeof error.code === 'string' ? error.code : 'unknown';
      const recoveryAction = typeof error === 'object' && error !== null &&
        'recoveryAction' in error && typeof error.recoveryAction === 'string'
        ? error.recoveryAction
        : 'none';
      throw new Error(`Second session plan failed (${code}; ${recoveryAction}).`);
    });
    expect(secondPlan.sourceManifestDigest).toBe(firstPlan.sourceManifestDigest);
    expect(secondPlan.sources.every((source) =>
      source.sanitizedBody.endsWith('\n') &&
      hierarchySha256(source.sanitizedBody) === source.sanitizedContentDigest)).toBe(true);
    const secondSnapshot = snapshotFromPlan(secondPlan, policy.digest);
    const stale = checkAuthoritativeWikiState(
      first.authority.state,
      first.authority.ownershipGraph,
      secondSnapshot,
      first.authority.humanActivationApproval,
      PROJECT_ID,
    );
    expect(stale).toMatchObject({
      changedSourceIds: [first.affectedSourceId],
      directlyStalePageIds: [AFFECTED_PAGE],
      status: 'stale',
    });
    expect(stale.stalePageIds).toEqual([AFFECTED_PAGE, ROOT_PAGE].sort());
    expect(stale.retrievalStalePageIds).toEqual(stale.stalePageIds);
    expect(stale.unaffectedPageIds).toEqual([UNAFFECTED_PAGE]);

    // LocalWikiOperator is projection-scoped and does not watch the source checkout. Its old
    // index remains usable until the newly approved authority is explicitly activated below.
    await expect(operator.indexStatus(PROJECT_ID)).resolves.toMatchObject({
      reasonCode: null,
      semanticUsable: true,
    });

    const second = await approvedAuthority(
      secondSnapshot,
      first.authority,
      current.knowledgeRoot,
    );
    expect(second.authority.state.previousGenerationDigest)
      .toBe(first.authority.state.generationDigest);
    expect(second.authority.state.activePages.find((page) => page.pageId === UNAFFECTED_PAGE))
      .toMatchObject({ pageId: UNAFFECTED_PAGE, status: 'active' });
    const secondActivation = await activate(current, second.authority);
    expect(secondActivation.materialization.materializationDigest)
      .not.toBe(firstActivation.materialization.materializationDigest);
    await expect(operator.indexStatus(PROJECT_ID)).resolves.toMatchObject({
      materialization: { state: 'ready' },
      reasonCode: 'semantic-index-stale',
      semanticUsable: false,
    });
    await expect(operator.search({
      mode: 'hybrid',
      projectId: PROJECT_ID,
      query: 'Novacycle',
    })).resolves.toMatchObject({
      effectiveMode: 'lexical-graph',
      fallback: { reasonCode: 'semantic-index-stale' },
    });

    await expect(operator.rebuildIndex({ full: true, projectId: PROJECT_ID }))
      .resolves.toMatchObject({
        requestedMode: 'full',
        result: { ledger: { effectiveMode: 'full', egress: 'none' }, outcome: 'activated' },
      });
    const updated = await operator.search({
      mode: 'hybrid',
      projectId: PROJECT_ID,
      query: 'Novacycle',
      topK: 20,
    });
    expect(updated).toMatchObject({ effectiveMode: 'hybrid', fallback: null });
    expect(updated.hits.map((hit) => hit.locator.pageId)).toContain(AFFECTED_PAGE);
    expect(updated.hits.map((hit) => hit.locator.pageId)).toContain(UNAFFECTED_PAGE);

    await rm(join(
      current.knowledgeRoot,
      'projects',
      PROJECT_ID,
      '.buildlore',
      'indexes',
      'semantic',
    ), { force: true, recursive: true });
    await expect(operator.indexStatus(PROJECT_ID)).resolves.toMatchObject({
      reasonCode: 'semantic-index-unavailable',
      semanticUsable: false,
    });
    await operator.rebuildIndex({ full: true, projectId: PROJECT_ID });
    const regenerated = await operator.search({
      mode: 'hybrid',
      projectId: PROJECT_ID,
      query: 'Novacycle',
      topK: 20,
    });
    expect(logicalHits(regenerated)).toEqual(logicalHits(updated));
    expect(bindingChecks).toEqual(Array.from({ length: 6 }, () => MODEL_PROFILE_ID));
    expect(deterministicProvider([]).inspectCapabilities()).toMatchObject({
      egress: 'none',
      networkAllowed: false,
      providerUsed: 'local-in-process',
    });
  }, 120_000);
});
