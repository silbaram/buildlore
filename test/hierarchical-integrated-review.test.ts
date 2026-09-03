import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addProject } from '../src/knowledge/index.js';
import { issuePreparedSource } from '../src/sanitizer/approval.js';
import { readSecurityPolicy, SANITIZER_RULES_VERSION } from '../src/sanitizer/index.js';
import {
  BASELINE_PAGE_REMOVAL_REVIEW_REASON_CODE,
  HIERARCHICAL_COMPILATION_POLICY,
  HierarchyContractError,
  advanceCompileContinuation,
  approveChildSummaryForSynthesis,
  buildSparseRelationGraph,
  createCompilationPurpose,
  createCompileCandidateReview,
  createCorpusSnapshot,
  createCurrentSessionGenerationService,
  createEvidencePack,
  createIntegratedWikiCandidateReview,
  createIntegratedWikiReviewSurface,
  createTextUnit,
  digestHierarchyValue,
  finalizePlanningDispositionInventory,
  hierarchySha256,
  reconcileWikiProposalLinks,
  startCompileContinuation,
  verifyIntegratedWikiReviewSurface,
  type CompilePartitionV2,
  type CreateIntegratedWikiReviewSurfaceInputV1,
  type CurrentSessionGenerationExchangeV1,
  type CurrentSessionGenerationHandoffV1,
  type CurrentSessionProposalSubmissionV1,
  type HierarchicalWikiProposalV1,
  type PageBlueprintV1,
  type SanitizedEvidenceSourceV1,
  type WikiOutlineV1,
} from '../src/compiler/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const PROJECT_ID = 'integrated-review';
const QUESTION = 'How does local sanitizer boundary preserve trusted wiki evidence?';
const temporaryRoots: string[] = [];

interface IntegratedFixture {
  readonly input: CreateIntegratedWikiReviewSurfaceInputV1;
  readonly generations: readonly CurrentSessionGenerationHandoffV1[];
}

function pageId(purposeDigest: string, stableKey: string): string {
  return `page-${digestHierarchyValue({
    projectId: PROJECT_ID,
    purposeDigest,
    stableKey,
  }).slice('sha256:'.length)}`;
}

function blueprint(input: Readonly<{
  readonly childPageIds: readonly string[];
  readonly generationOrder: number;
  readonly graph: ReturnType<typeof buildSparseRelationGraph>;
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly role: string;
  readonly snapshotDigest: `sha256:${string}`;
  readonly sourceIds: readonly string[];
  readonly stableKey: string;
  readonly title: string;
}>): PageBlueprintV1 {
  const candidate = Object.freeze({
    schemaVersion: 'buildlore.page-blueprint.v2' as const,
    projectId: PROJECT_ID,
    pageId: input.pageId,
    stableKey: input.stableKey,
    role: input.role,
    title: input.title,
    parentPageId: input.parentPageId,
    childPageIds: Object.freeze([...input.childPageIds].sort()),
    relatedPageIds: Object.freeze([]),
    keyQuestions: Object.freeze([QUESTION]),
    requiredSections: Object.freeze(['evidence']),
    evidenceScope: Object.freeze({
      snapshotDigest: input.snapshotDigest,
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

function submission(
  exchange: CurrentSessionGenerationExchangeV1,
  badTitle: boolean,
): CurrentSessionProposalSubmissionV1 {
  const unit = exchange.evidencePack.units[0];
  if (unit === undefined) throw new Error('expected generation evidence');
  const childText = exchange.request.approvedChildSummaries.flatMap((summary) => [
    summary.summary,
    ...summary.citationIds.map((citationId) => `[^${citationId}]`),
  ]).join(' ');
  const body = [
    unit.content,
    `[^${unit.citation.citationId}]`,
    childText,
    ...exchange.request.requiredLinkPageIds.map((id) => `[[${id}]]`),
  ].filter((value) => value.length > 0).join(' ');
  return Object.freeze({
    schemaVersion: 'buildlore.current-session-proposal-submission.v2' as const,
    projectId: exchange.projectId,
    pageId: exchange.pageId,
    exchangeDigest: exchange.exchangeDigest,
    requestDigest: exchange.requestDigest,
    title: badTitle ? 'Invented title outside the reviewed blueprint' : exchange.writingBrief.title,
    summary: unit.content,
    sections: Object.freeze([Object.freeze({ sectionId: 'evidence', body })]),
    claims: Object.freeze([Object.freeze({
      text: unit.content,
      evidenceUnitIds: Object.freeze([unit.unitId]),
      citationIds: Object.freeze([unit.citation.citationId]),
    })]),
    wikilinks: exchange.request.requiredLinkPageIds,
  });
}

async function integratedFixture(badLeafTitle = false): Promise<IntegratedFixture> {
  const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-integrated-review-'));
  temporaryRoots.push(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: 'Integrated Review Fixture',
    projectId: PROJECT_ID,
    sourceRepository: 'https://example.test/integrated-review.git',
  });
  await writeSecurityPolicy(knowledgeRoot, PROJECT_ID, { capabilities: [] });
  const policy = await readSecurityPolicy(knowledgeRoot, PROJECT_ID);
  const purpose = createCompilationPurpose({
    projectId: PROJECT_ID,
    audience: ['Maintainers'],
    goals: ['Review one complete local hierarchical Wiki generation'],
    keyQuestions: [QUESTION],
    scopeHints: ['Registered sanitized sources'],
    excludedTopics: ['Hosted agents'],
    outputLanguage: 'en',
    requestedPageRoles: ['topic', 'overview'],
  });
  const sourceInputs = [
    {
      sourceRef: 'docs/leaf.md',
      content: 'Local sanitizer boundary preserves trusted wiki evidence with exact citations, ' +
        'stable source anchors, deterministic checks, and offline review for maintainers.',
    },
    {
      sourceRef: 'docs/root.md',
      content: 'Local sanitizer boundary preserves trusted wiki evidence while hierarchical ' +
        'synthesis connects approved child summaries, explicit links, and reviewable lineage.',
    },
  ].map((value) => Object.freeze({
    ...value,
    sourceId: `source-${hierarchySha256(value.sourceRef).slice('sha256:'.length)}`,
    sourceRevision: hierarchySha256(value.content),
  })).sort((left, right) => left.sourceId < right.sourceId ? -1 : 1);
  const sources: SanitizedEvidenceSourceV1[] = [];
  const snapshotSources = [];
  const units = [];
  for (const source of sourceInputs) {
    const contentDigest = hierarchySha256(source.content);
    sources.push(Object.freeze({
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      sourceRef: source.sourceRef,
      preparedSource: issuePreparedSource({
        approvedBody: source.content,
        approvedBodyDigest: contentDigest,
        classification: 'internal',
        inputBodyDigest: contentDigest,
        policyDigest: policy.digest,
        projectId: PROJECT_ID,
        rulesVersion: SANITIZER_RULES_VERSION,
        source: source.sourceRef,
        sourceKind: 'markdown',
        sourceRevisionOrContentSha256: source.sourceRevision,
        untrustedData: false,
      }),
    }));
    snapshotSources.push(Object.freeze({
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      sourceRef: source.sourceRef,
      sanitizedContentDigest: contentDigest,
    }));
    units.push(createTextUnit({
      projectId: PROJECT_ID,
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      sourceRef: source.sourceRef,
      kind: 'paragraph',
      ordinal: 0,
      range: {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: Array.from(source.content).length,
      },
      contentDigest,
    }));
  }
  const snapshot = createCorpusSnapshot({
    projectId: PROJECT_ID,
    purposeDigest: purpose.purposeDigest,
    interpretationRulesDigest: hierarchySha256('integrated-rules'),
    profileDigest: hierarchySha256('integrated-profile'),
    compilerContractDigest: hierarchySha256('integrated-compiler'),
    sanitizerPolicyDigest: policy.digest,
    sourceManifestDigest: hierarchySha256('integrated-manifest'),
    policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
    sources: snapshotSources,
    textUnits: units,
  });
  const graph = buildSparseRelationGraph(snapshot, PROJECT_ID);
  const leafStableKey = 'integrated.leaf';
  const rootStableKey = 'integrated.root';
  const leafPageId = pageId(purpose.purposeDigest, leafStableKey);
  const rootPageId = pageId(purpose.purposeDigest, rootStableKey);
  const leafSource = sourceInputs.find((source) => source.sourceRef === 'docs/leaf.md');
  const rootSource = sourceInputs.find((source) => source.sourceRef === 'docs/root.md');
  if (leafSource === undefined || rootSource === undefined) throw new Error('missing sources');
  const pages = Object.freeze([
    blueprint({
      childPageIds: [],
      generationOrder: 0,
      graph,
      pageId: leafPageId,
      parentPageId: rootPageId,
      role: 'topic',
      snapshotDigest: snapshot.snapshotDigest,
      sourceIds: [leafSource.sourceId, rootSource.sourceId],
      stableKey: leafStableKey,
      title: 'Sanitizer evidence boundary',
    }),
    blueprint({
      childPageIds: [leafPageId],
      generationOrder: 1,
      graph,
      pageId: rootPageId,
      parentPageId: null,
      role: 'overview',
      snapshotDigest: snapshot.snapshotDigest,
      sourceIds: [leafSource.sourceId, rootSource.sourceId],
      stableKey: rootStableKey,
      title: 'Integrated Wiki review',
    }),
  ]);
  const outlineCandidate = Object.freeze({
    schemaVersion: 'buildlore.wiki-outline.v2' as const,
    projectId: PROJECT_ID,
    snapshotDigest: snapshot.snapshotDigest,
    graphDigest: graph.graphDigest,
    interpretationSetDigest: hierarchySha256('integrated-interpretations'),
    purposeDigest: purpose.purposeDigest,
    policyDigest: snapshot.policyDigest,
    activationState: 'candidate' as const,
    rootPageId,
    blueprints: pages,
    reviewNotes: Object.freeze([]),
  });
  const outline: WikiOutlineV1 = Object.freeze({
    ...outlineCandidate,
    outlineDigest: digestHierarchyValue(outlineCandidate),
  });
  let continuation = startCompileContinuation(graph, 256, PROJECT_ID);
  const partitions: CompilePartitionV2[] = [];
  while (!continuation.complete) {
    const cursor = continuation.nextCursor;
    if (cursor === null) throw new Error('expected planning cursor');
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
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const packFor = (page: PageBlueprintV1, sourceId: string) => createEvidencePack({
    blueprint: page,
    snapshot,
    sources: [sourceById.get(sourceId) as SanitizedEvidenceSourceV1],
    selectedUnitIds: snapshot.textUnits.filter((unit) => unit.sourceId === sourceId)
      .map((unit) => unit.unitId),
    conflicts: [],
    gaps: [],
  }, PROJECT_ID);
  const service = createCurrentSessionGenerationService({ knowledgeRoot });
  const leafSession = await service.prepare({
    purpose,
    blueprint: pages[0] as PageBlueprintV1,
    evidencePack: packFor(pages[0] as PageBlueprintV1, leafSource.sourceId),
    approvedChildSummaries: [],
  }, PROJECT_ID);
  const leafExchange = JSON.parse(JSON.stringify(leafSession.exchange)) as
    CurrentSessionGenerationExchangeV1;
  const leafResult = await leafSession.submit(submission(leafExchange, badLeafTitle));
  const childSummary = approveChildSummaryForSynthesis(
    leafResult.proposal,
    createCompileCandidateReview(leafResult.proposal, 'accepted', PROJECT_ID),
    PROJECT_ID,
  );
  const rootSession = await service.prepare({
    purpose,
    blueprint: pages[1] as PageBlueprintV1,
    evidencePack: packFor(pages[1] as PageBlueprintV1, rootSource.sourceId),
    approvedChildSummaries: [childSummary],
  }, PROJECT_ID);
  const rootExchange = JSON.parse(JSON.stringify(rootSession.exchange)) as
    CurrentSessionGenerationExchangeV1;
  const rootResult = await rootSession.submit(submission(rootExchange, false));
  const generations = Object.freeze([
    Object.freeze({
      exchange: leafExchange,
      result: JSON.parse(JSON.stringify(leafResult)) as unknown,
    }),
    Object.freeze({
      exchange: rootExchange,
      result: JSON.parse(JSON.stringify(rootResult)) as unknown,
    }),
  ]);
  const reconciliation = reconcileWikiProposalLinks(
    outline,
    [leafResult.proposal, rootResult.proposal],
    PROJECT_ID,
  );
  return Object.freeze({
    generations,
    input: Object.freeze({
      graph,
      outline,
      planningInventory,
      generations,
      reconciliation,
      baselineGenerationDigest: null,
      baselineProposals: Object.freeze([]),
    }),
  });
}

function redigestProposal(
  proposal: HierarchicalWikiProposalV1,
  patch: Readonly<Record<string, unknown>>,
): HierarchicalWikiProposalV1 {
  const candidate = {
    ...proposal,
    ...patch,
  } as Record<string, unknown>;
  delete candidate.proposalDigest;
  return Object.freeze({
    ...candidate,
    proposalDigest: digestHierarchyValue(candidate),
  }) as unknown as HierarchicalWikiProposalV1;
}

function redigestBlueprint(
  value: PageBlueprintV1,
  patch: Readonly<Record<string, unknown>>,
): PageBlueprintV1 {
  const candidate = { ...value, ...patch } as Record<string, unknown>;
  delete candidate.blueprintDigest;
  return Object.freeze({
    ...candidate,
    blueprintDigest: digestHierarchyValue(candidate),
  }) as unknown as PageBlueprintV1;
}

function redigestOutline(
  value: WikiOutlineV1,
  blueprints: readonly PageBlueprintV1[],
): WikiOutlineV1 {
  const candidate = { ...value, blueprints } as Record<string, unknown>;
  delete candidate.outlineDigest;
  return Object.freeze({
    ...candidate,
    outlineDigest: digestHierarchyValue(candidate),
  }) as unknown as WikiOutlineV1;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('integrated current-session Wiki review surface', () => {
  it('is deterministic, JSON-verifiable, and binds accepted review to every digest', async () => {
    const fixture = await integratedFixture();
    const surface = createIntegratedWikiReviewSurface(fixture.input, PROJECT_ID);
    expect(surface).toMatchObject({
      hardQualityPassed: true,
      eligibleForHumanAcceptance: true,
      canonicalMutationAuthorized: false,
      runCoverage: {
        complete: true,
        generationReceiptCoverageBasisPoints: 10_000,
        pageQualityReportCoverageBasisPoints: 10_000,
      },
    });
    expect(surface.candidates.every((candidate) =>
      candidate.contentDiff.changeKind === 'added')).toBe(true);
    expect(surface.candidates.every((candidate) =>
      candidate.generationReceipt.generationActor === 'current-agent-session' &&
      candidate.generationReceipt.egress === 'none' &&
      candidate.generationReceipt.providerUsed === null &&
      candidate.generationReceipt.processSpawned === false)).toBe(true);
    const reordered = createIntegratedWikiReviewSurface({
      ...fixture.input,
      generations: [...fixture.generations].reverse(),
    }, PROJECT_ID);
    expect(reordered).toEqual(surface);

    const json = JSON.parse(JSON.stringify(surface)) as unknown;
    expect(() => createIntegratedWikiCandidateReview(
      json as typeof surface,
      surface.candidates[0]?.pageId as string,
      'accepted',
      [],
      PROJECT_ID,
    )).toThrow(HierarchyContractError);
    const verified = verifyIntegratedWikiReviewSurface(json, fixture.input, PROJECT_ID);
    const page = verified.candidates[0];
    if (page === undefined) throw new Error('expected review candidate');
    const review = createIntegratedWikiCandidateReview(
      verified,
      page.pageId,
      'accepted',
      [],
      PROJECT_ID,
    );
    expect(review).toMatchObject({
      reviewSurfaceDigest: verified.surfaceDigest,
      proposalDigest: page.proposal.proposalDigest,
      generationReceiptDigest: page.generationReceipt.receiptDigest,
      contentDiffDigest: page.contentDiff.diffDigest,
      pageQualityReportDigest: page.pageQualityReport.reportDigest,
      corpusQualityReportDigest: verified.corpusQualityReport.reportDigest,
      planningInventoryDigest: verified.planningInventoryDigest,
      decision: 'accepted',
      canonicalMutationAuthorized: false,
    });
  });

  it('reports an exact prefix as incomplete and rejects missing, duplicate, swapped or skipped work', async () => {
    const fixture = await integratedFixture();
    const partialInput: CreateIntegratedWikiReviewSurfaceInputV1 = {
      ...fixture.input,
      generations: fixture.generations.slice(0, 1),
      reconciliation: null,
    };
    const partial = createIntegratedWikiReviewSurface(partialInput, PROJECT_ID);
    expect(partial.runCoverage.complete).toBe(false);
    expect(partial.runCoverage.observedCandidateCount).toBe(1);
    expect(partial.reasonCodes).toContain('run-coverage-incomplete');
    const partialPage = partial.candidates[0];
    if (partialPage === undefined) throw new Error('expected partial candidate');
    expect(() => createIntegratedWikiCandidateReview(
      partial,
      partialPage.pageId,
      'accepted',
      [],
      PROJECT_ID,
    )).toThrow(HierarchyContractError);
    expect(createIntegratedWikiCandidateReview(
      partial,
      partialPage.pageId,
      'rejected',
      ['run-incomplete'],
      PROJECT_ID,
    ).decision).toBe('rejected');

    const empty = createIntegratedWikiReviewSurface({
      ...fixture.input,
      generations: [],
      reconciliation: null,
    }, PROJECT_ID);
    expect(empty.runCoverage).toMatchObject({
      complete: false,
      observedCandidateCount: 0,
      observedGenerationReceiptCount: 0,
    });
    expect(empty.reasonCodes).toContain('run-coverage-incomplete');

    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      generations: [fixture.generations[1] as CurrentSessionGenerationHandoffV1],
      reconciliation: null,
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      generations: [
        fixture.generations[0] as CurrentSessionGenerationHandoffV1,
        fixture.generations[0] as CurrentSessionGenerationHandoffV1,
      ],
      reconciliation: null,
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      generations: [{
        exchange: fixture.generations[0]?.exchange,
        result: fixture.generations[1]?.result,
      }],
      reconciliation: null,
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    const missingReceipt = JSON.parse(JSON.stringify(fixture.generations[0])) as {
      readonly exchange: unknown;
      readonly result: Record<string, unknown>;
    };
    delete missingReceipt.result.receipt;
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      generations: [missingReceipt],
      reconciliation: null,
    }, PROJECT_ID)).toThrow(HierarchyContractError);
  });

  it('shows unchanged, modified and removed baseline content without auto-accepting deletion', async () => {
    const fixture = await integratedFixture();
    const currentProposals = fixture.generations.map((generation) =>
      (generation.result as { readonly proposal: HierarchicalWikiProposalV1 }).proposal);
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      baselineProposals: [currentProposals[0] as HierarchicalWikiProposalV1],
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      baselineGenerationDigest: hierarchySha256('unexpected-empty-baseline'),
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      baselineGenerationDigest: hierarchySha256('invalid-baseline-contract'),
      baselineProposals: [redigestProposal(
        currentProposals[0] as HierarchicalWikiProposalV1,
        { requestDigest: 'invalid-digest' },
      )],
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    const unchanged = createIntegratedWikiReviewSurface({
      ...fixture.input,
      baselineGenerationDigest: hierarchySha256('authoritative-generation-one'),
      baselineProposals: currentProposals,
    }, PROJECT_ID);
    expect(unchanged.candidates.every((candidate) =>
      candidate.contentDiff.changeKind === 'unchanged')).toBe(true);
    expect(unchanged.eligibleForHumanAcceptance).toBe(true);

    const legacyBaselines = currentProposals.map((proposal) => redigestProposal(proposal, {
      schemaVersion: 'buildlore.hierarchical-wiki-proposal.v1',
      sections: proposal.sections.map((section) => Object.freeze({
        sectionId: section.sectionId,
        body: section.body,
      })),
    }));
    const legacy = createIntegratedWikiReviewSurface({
      ...fixture.input,
      baselineGenerationDigest: hierarchySha256('authoritative-generation-v1'),
      baselineProposals: legacyBaselines,
    }, PROJECT_ID);
    expect(legacy.candidates.every((candidate) =>
      (candidate.baselineProposal?.schemaVersion as string | undefined) ===
        'buildlore.hierarchical-wiki-proposal.v1')).toBe(true);
    expect(legacy.removedBaselinePages).toHaveLength(0);
    expect(legacy.eligibleForHumanAcceptance).toBe(true);

    const leaf = currentProposals[0] as HierarchicalWikiProposalV1;
    const changedSections = leaf.sections.map((section) => Object.freeze({
      ...section,
      body: `${section.body} Prior wording.`,
    }));
    const modifiedBaseline = redigestProposal(leaf, { sections: changedSections });
    const removedBaseline = redigestProposal(leaf, {
      pageId: `page-${hierarchySha256('removed-page').slice('sha256:'.length)}`,
    });
    const changed = createIntegratedWikiReviewSurface({
      ...fixture.input,
      baselineGenerationDigest: hierarchySha256('authoritative-generation-two'),
      baselineProposals: [removedBaseline, modifiedBaseline],
    }, PROJECT_ID);
    expect(changed.candidates.find((candidate) => candidate.pageId === leaf.pageId)
      ?.contentDiff.changeKind).toBe('modified');
    expect(changed.candidates.some((candidate) =>
      candidate.contentDiff.changeKind === 'added')).toBe(true);
    expect(changed.removedBaselinePages).toHaveLength(1);
    expect(changed.removedBaselinePages[0]?.baselineProposal).toEqual(removedBaseline);
    expect(changed.reasonCodes).toContain('baseline-page-removal-requires-review');
    expect(changed.eligibleForHumanAcceptance).toBe(false);
    const changedCandidate = changed.candidates[0];
    if (changedCandidate === undefined) throw new Error('expected changed candidate');
    expect(() => createIntegratedWikiCandidateReview(
      changed,
      changedCandidate.pageId,
      'accepted',
      [],
      PROJECT_ID,
    )).toThrow(HierarchyContractError);
    expect(createIntegratedWikiCandidateReview(
      changed,
      changedCandidate.pageId,
      'accepted',
      [BASELINE_PAGE_REMOVAL_REVIEW_REASON_CODE],
      PROJECT_ID,
    )).toMatchObject({
      decision: 'accepted',
      reasonCodes: [BASELINE_PAGE_REMOVAL_REVIEW_REASON_CODE],
    });
    expect(() => createIntegratedWikiCandidateReview(
      unchanged,
      unchanged.candidates[0]?.pageId as string,
      'accepted',
      [BASELINE_PAGE_REMOVAL_REVIEW_REASON_CODE],
      PROJECT_ID,
    )).toThrow(HierarchyContractError);
  });

  it('cross-binds the actual outline and rejects non-canonical nested blueprint scope', async () => {
    const fixture = await integratedFixture();
    const leaf = fixture.input.outline.blueprints[0];
    const root = fixture.input.outline.blueprints[1];
    if (leaf === undefined || root === undefined) throw new Error('expected outline pages');

    for (const patch of [
      { title: `${leaf.title} altered after generation` },
      { role: 'architecture' },
      { keyQuestions: Object.freeze(['What changed after the reviewed generation?']) },
      { requiredSections: Object.freeze(['architecture']) },
      { minimumDistinctSources: 2 },
    ]) {
      const mismatch = redigestBlueprint(leaf, patch);
      expect(() => createIntegratedWikiReviewSurface({
        ...fixture.input,
        outline: redigestOutline(fixture.input.outline, [mismatch, root]),
      }, PROJECT_ID)).toThrow(HierarchyContractError);
    }

    const nonDeterministicPageId = redigestBlueprint(leaf, {
      stableKey: 'integrated.renamed-leaf',
    });
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      outline: redigestOutline(fixture.input.outline, [nonDeterministicPageId, root]),
      generations: [],
      reconciliation: null,
    }, PROJECT_ID)).toThrow(HierarchyContractError);

    const firstSourceId = root.evidenceScope.sourceIds[0];
    if (firstSourceId === undefined) throw new Error('expected source scope');
    const duplicateScope = Object.freeze({
      ...root.evidenceScope,
      sourceIds: Object.freeze([firstSourceId, firstSourceId]),
    });
    const duplicateSourceBlueprint = redigestBlueprint(root, {
      evidenceScope: duplicateScope,
    });
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      outline: redigestOutline(fixture.input.outline, [leaf, duplicateSourceBlueprint]),
      generations: [],
      reconciliation: null,
    }, PROJECT_ID)).toThrow(HierarchyContractError);

    const reorderedKindsBlueprint = redigestBlueprint(root, {
      evidenceScope: Object.freeze({
        ...root.evidenceScope,
        allowedUnitKinds: Object.freeze([...root.evidenceScope.allowedUnitKinds].reverse()),
      }),
    });
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      outline: redigestOutline(fixture.input.outline, [leaf, reorderedKindsBlueprint]),
      generations: [],
      reconciliation: null,
    }, PROJECT_ID)).toThrow(HierarchyContractError);

    const incompleteLeafScope = redigestBlueprint(leaf, {
      evidenceScope: Object.freeze({
        ...leaf.evidenceScope,
        sourceIds: Object.freeze([firstSourceId]),
      }),
    });
    expect(() => createIntegratedWikiReviewSurface({
      ...fixture.input,
      outline: redigestOutline(fixture.input.outline, [incompleteLeafScope, root]),
      generations: [],
      reconciliation: null,
    }, PROJECT_ID)).toThrow(HierarchyContractError);
  });

  it('keeps quality failure visible, blocks acceptance, and never leaks hostile values', async () => {
    const fixture = await integratedFixture(true);
    const surface = createIntegratedWikiReviewSurface(fixture.input, PROJECT_ID);
    expect(surface.hardQualityPassed).toBe(false);
    expect(surface.eligibleForHumanAcceptance).toBe(false);
    expect(surface.reasonCodes).toContain('page-quality-failed');
    const failed = surface.candidates.find((candidate) =>
      !candidate.pageQualityReport.hardQualityPassed);
    if (failed === undefined) throw new Error('expected failed page quality');
    expect(() => createIntegratedWikiCandidateReview(
      surface,
      failed.pageId,
      'accepted',
      [],
      PROJECT_ID,
    )).toThrow(HierarchyContractError);

    const secret = ['sk-', 'integrated-review-secret-', 'must-not-leak'].join('');
    const hostileGeneration = JSON.parse(JSON.stringify(fixture.generations[0])) as {
      readonly exchange: unknown;
      readonly result: Record<string, unknown>;
    };
    hostileGeneration.result.undeclared = secret;
    let failure: unknown;
    try {
      createIntegratedWikiReviewSurface({
        ...fixture.input,
        generations: [hostileGeneration],
        reconciliation: null,
      }, PROJECT_ID);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HierarchyContractError);
    expect(String(failure)).not.toContain(secret);

    const tampered = JSON.parse(JSON.stringify(surface)) as Record<string, unknown>;
    tampered.eligibleForHumanAcceptance = true;
    delete tampered.surfaceDigest;
    tampered.surfaceDigest = digestHierarchyValue(tampered);
    expect(() => verifyIntegratedWikiReviewSurface(
      tampered,
      fixture.input,
      PROJECT_ID,
    )).toThrow(HierarchyContractError);
  });
});
