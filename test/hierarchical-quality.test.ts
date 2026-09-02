import { describe, expect, it } from 'vitest';

import {
  SEMANTIC_QUALITY_POLICY,
  digestHierarchyValue,
  evaluateSemanticQuality,
  hierarchySha256,
  type EvidencePackV1,
  type HierarchicalWikiProposalV1,
  type PageBlueprintV1,
  type WikiLinkReconciliationV1,
  type WikiOutlineV1,
} from '../src/compiler/index.js';

const PROJECT_ID = 'quality-project';
const digest = (value: string) => hierarchySha256(value);
const pageId = (value: string) => `page-${digest(value).slice('sha256:'.length)}`;
const sourceId = (value: string) => `source-${digest(value).slice('sha256:'.length)}`;
const unitId = (value: string) => `unit-${digest(value).slice('sha256:'.length)}`;
const citationId = (value: string) => `citation-${digest(value).slice('sha256:'.length)}`;

const ROOT = pageId('root');
const LEAF_ALPHA = pageId('leaf-alpha');
const LEAF_BETA = pageId('leaf-beta');

interface QualityFixture {
  readonly outline: WikiOutlineV1;
  readonly proposals: readonly HierarchicalWikiProposalV1[];
  readonly packs: readonly EvidencePackV1[];
  readonly reconciliation: WikiLinkReconciliationV1;
}

function blueprint(
  id: string,
  role: string,
  parentPageId: string | null,
  childPageIds: readonly string[],
  relatedPageIds: readonly string[],
  generationOrder: number,
): PageBlueprintV1 {
  const candidate = Object.freeze({
    schemaVersion: 'buildlore.page-blueprint.v1',
    projectId: PROJECT_ID,
    pageId: id,
    stableKey: `quality.${String(generationOrder)}`,
    role,
    title: `Quality page ${String(generationOrder)}`,
    parentPageId,
    childPageIds: Object.freeze([...childPageIds].sort()),
    relatedPageIds: Object.freeze([...relatedPageIds].sort()),
    keyQuestions: Object.freeze(['How is this claim grounded?']),
    requiredSections: Object.freeze(['details', 'evidence', 'summary']),
    evidenceScope: Object.freeze({
      snapshotDigest: digest('snapshot'),
      taskSetDigest: digest('tasks'),
      relationSetDigest: digest('relations'),
      allowedUnitKinds: Object.freeze([
        'document', 'fenced-code', 'heading', 'list', 'paragraph', 'table',
      ] as const),
      sourceIds: Object.freeze([sourceId('a'), sourceId('b')].sort()),
    }),
    minimumDistinctSources: 2,
    generationOrder,
  });
  return Object.freeze({ ...candidate, blueprintDigest: digestHierarchyValue(candidate) });
}

function requiredLinks(page: PageBlueprintV1): readonly string[] {
  return Object.freeze([...new Set([
    ...(page.parentPageId === null ? [] : [page.parentPageId]),
    ...page.childPageIds,
    ...page.relatedPageIds,
  ])].sort());
}

const WORDS = [
  ['harbor', 'quartz', 'ledger', 'sanitizer', 'boundary', 'verifies', 'registered', 'bytes'],
  ['meadow', 'cobalt', 'retrieval', 'lexical', 'graph', 'connects', 'approved', 'knowledge'],
  ['ember', 'violet', 'hierarchy', 'overview', 'synthesizes', 'citations', 'across', 'sources'],
] as const;

function evidencePack(page: PageBlueprintV1, index: number): EvidencePackV1 {
  const units = [0, 1].map((sourceIndex) => {
    const id = unitId(`${page.pageId}-${String(sourceIndex)}`);
    const source = sourceId(sourceIndex === 0 ? 'a' : 'b');
    const content = `${WORDS[index]?.join(' ')} source${String(sourceIndex)} evidence statement.`;
    const range = Object.freeze({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: content.length,
    });
    const citationBasis = Object.freeze({
      sourceId: source,
      sourceRevision: digest(`revision-${source}`),
      sourceRef: `docs/${String(sourceIndex)}.md`,
      range,
      quoteDigest: digest(content),
    });
    return Object.freeze({
      unitId: id,
      sourceId: source,
      kind: 'paragraph' as const,
      range,
      content,
      contentDigest: digest(content),
      citation: Object.freeze({
        citationId: `citation-${digestHierarchyValue(citationBasis).slice('sha256:'.length)}`,
        ...citationBasis,
      }),
    });
  });
  const candidate = Object.freeze({
    schemaVersion: 'buildlore.evidence-pack.v1',
    projectId: PROJECT_ID,
    pageId: page.pageId,
    blueprintDigest: page.blueprintDigest,
    snapshotDigest: digest('snapshot'),
    sanitizerPolicyDigest: digest('sanitizer'),
    units: Object.freeze(units),
    conflicts: Object.freeze([]),
    gaps: Object.freeze([]),
    evidenceBytes: units.reduce((sum, unit) => sum + Buffer.byteLength(unit.content), 0),
  });
  return Object.freeze({ ...candidate, packDigest: digestHierarchyValue(candidate) });
}

function canonicalProposal(
  value: Omit<HierarchicalWikiProposalV1, 'proposalDigest'> & {
    readonly proposalDigest?: HierarchicalWikiProposalV1['proposalDigest'];
  },
): HierarchicalWikiProposalV1 {
  const claims = Object.freeze(value.claims.map((claim) => {
    const basis = Object.freeze({
      text: claim.text,
      evidenceUnitIds: claim.evidenceUnitIds,
      citationIds: claim.citationIds,
    });
    return Object.freeze({
      claimId: `claim-${digestHierarchyValue(basis).slice('sha256:'.length)}`,
      ...basis,
    });
  }));
  const candidate = Object.freeze({
    schemaVersion: value.schemaVersion,
    projectId: value.projectId,
    pageId: value.pageId,
    blueprintDigest: value.blueprintDigest,
    evidencePackDigest: value.evidencePackDigest,
    requestDigest: value.requestDigest,
    title: value.title,
    summary: value.summary,
    sections: value.sections,
    claims,
    wikilinks: value.wikilinks,
    citationIds: value.citationIds,
    lifecycle: value.lifecycle,
  });
  return Object.freeze({ ...candidate, proposalDigest: digestHierarchyValue(candidate) });
}

function canonicalPack(
  value: Omit<EvidencePackV1, 'packDigest'> & {
    readonly packDigest?: EvidencePackV1['packDigest'];
  },
): EvidencePackV1 {
  const conflicts = Object.freeze(value.conflicts.map((conflict) => {
    const basis = Object.freeze({
      kind: conflict.kind,
      unitIds: conflict.unitIds,
      status: conflict.status,
    });
    return Object.freeze({
      conflictId: `conflict-${digestHierarchyValue(basis).slice('sha256:'.length)}`,
      ...basis,
    });
  }));
  const candidate = Object.freeze({
    schemaVersion: value.schemaVersion,
    projectId: value.projectId,
    pageId: value.pageId,
    blueprintDigest: value.blueprintDigest,
    snapshotDigest: value.snapshotDigest,
    sanitizerPolicyDigest: value.sanitizerPolicyDigest,
    units: value.units,
    conflicts,
    gaps: value.gaps,
    evidenceBytes: value.evidenceBytes,
  });
  return Object.freeze({ ...candidate, packDigest: digestHierarchyValue(candidate) });
}

function proposal(
  page: PageBlueprintV1,
  pack: EvidencePackV1,
): HierarchicalWikiProposalV1 {
  const first = pack.units[0] as EvidencePackV1['units'][number];
  const second = pack.units[1] as EvidencePackV1['units'][number];
  const details = `This claim is grounded by ${first.content}`;
  const evidence = `${first.content} ${second.content}`;
  const summary = `This grounded claim explains ${second.content}`;
  const firstMarker = `[^${first.citation.citationId}]`;
  const secondMarker = `[^${second.citation.citationId}]`;
  const linkMarkers = requiredLinks(page).map((id) => `[[${id}]]`).join(' ');
  return canonicalProposal({
    schemaVersion: 'buildlore.hierarchical-wiki-proposal.v1',
    projectId: PROJECT_ID,
    pageId: page.pageId,
    blueprintDigest: page.blueprintDigest,
    evidencePackDigest: pack.packDigest,
    requestDigest: digest(`request-${page.pageId}`),
    title: page.title,
    summary,
    sections: Object.freeze([
      { sectionId: 'details', body: `${details} ${firstMarker} ${linkMarkers}` },
      { sectionId: 'evidence', body: `${evidence} ${firstMarker} ${secondMarker}` },
      { sectionId: 'summary', body: `${summary} ${secondMarker}` },
    ]),
    claims: Object.freeze([
      {
        claimId: '' as `claim-${string}`,
        text: details,
        evidenceUnitIds: Object.freeze([first.unitId]),
        citationIds: Object.freeze([first.citation.citationId]),
      },
      {
        claimId: '' as `claim-${string}`,
        text: evidence,
        evidenceUnitIds: Object.freeze([first.unitId, second.unitId].sort()),
        citationIds: Object.freeze([
          first.citation.citationId,
          second.citation.citationId,
        ].sort()),
      },
      {
        claimId: '' as `claim-${string}`,
        text: summary,
        evidenceUnitIds: Object.freeze([second.unitId]),
        citationIds: Object.freeze([second.citation.citationId]),
      },
    ]),
    wikilinks: requiredLinks(page),
    citationIds: Object.freeze([
      first.citation.citationId,
      second.citation.citationId,
    ].sort()),
    lifecycle: 'candidate',
  });
}

function qualityFixture(betaRole = 'architecture'): QualityFixture {
  const pages = [
    blueprint(LEAF_ALPHA, 'topic', ROOT, [], [LEAF_BETA], 0),
    blueprint(LEAF_BETA, betaRole, ROOT, [], [LEAF_ALPHA], 1),
    blueprint(ROOT, 'overview', null, [LEAF_ALPHA, LEAF_BETA], [], 2),
  ];
  const packs = pages.map(evidencePack);
  const proposals = pages.map((page, index) => proposal(
    page,
    packs[index] as EvidencePackV1,
  ));
  const outlineCandidate = Object.freeze({
    schemaVersion: 'buildlore.wiki-outline.v1',
    projectId: PROJECT_ID,
    snapshotDigest: digest('snapshot'),
    graphDigest: digest('graph'),
    interpretationSetDigest: digest('interpretations'),
    purposeDigest: digest('purpose'),
    policyDigest: digest('policy'),
    activationState: 'candidate',
    rootPageId: ROOT,
    blueprints: Object.freeze(pages),
  });
  const outline: WikiOutlineV1 = Object.freeze({
    ...outlineCandidate,
    outlineDigest: digestHierarchyValue(outlineCandidate),
  });
  const reconciliationCandidate = Object.freeze({
    schemaVersion: 'buildlore.wiki-link-reconciliation.v1',
    projectId: PROJECT_ID,
    outlineDigest: outline.outlineDigest,
    entries: Object.freeze(pages.map((page) => ({
      pageId: page.pageId,
      requiredLinkPageIds: requiredLinks(page),
    })).sort((left, right) => left.pageId < right.pageId ? -1 : 1)),
    complete: true,
  });
  const reconciliation: WikiLinkReconciliationV1 = Object.freeze({
    ...reconciliationCandidate,
    reconciliationDigest: digestHierarchyValue(reconciliationCandidate),
  });
  return { outline, proposals, packs, reconciliation };
}

describe('deterministic semantic quality gate', () => {
  it('passes a grounded multi-source hierarchy with full root reachability', () => {
    const value = qualityFixture();
    const result = evaluateSemanticQuality({
      outline: value.outline,
      proposals: value.proposals,
      evidencePacks: value.packs,
      reconciliation: value.reconciliation,
    }, PROJECT_ID);
    expect(result.corpus).toMatchObject({
      hardQualityPassed: true,
      eligibleForApproval: true,
      reachablePageCount: 3,
      orphanPageIds: [],
      orphanBasisPoints: 0,
      uncategorizedPageCount: 0,
      deterministicChecksOnly: true,
      llmJudgeCanOverride: false,
      embeddingSimilarityCanOverride: false,
      canonicalMutationAuthorized: false,
    });
    expect(result.pages.every((page) => page.hardQualityPassed)).toBe(true);
    expect(result.pages.every((page) => page.observedDistinctSources === 2)).toBe(true);
    expect(result.pages.every((page) => page.claimGroundingBasisPoints === 10_000))
      .toBe(true);
    expect(result.pages.every((page) => page.claimEvidenceSupportBasisPoints === 10_000))
      .toBe(true);
    expect(result.pages.every((page) => page.titleGrounded && page.summaryGrounded)).toBe(true);
  });

  it('rejects canonically re-digested claims, titles and summaries unsupported by evidence', () => {
    const value = qualityFixture();
    const first = value.proposals[0] as HierarchicalWikiProposalV1;
    const falseClaim = 'Orbital dragons authorize an unrelated planetary deployment policy.';
    const falseSummary = 'Imaginary satellites guarantee a fictional release outcome.';
    const hallucinated = canonicalProposal({
      ...first,
      title: 'Invented operational doctrine',
      summary: falseSummary,
      sections: Object.freeze(first.sections.map((section) => {
        if (section.sectionId === 'details') {
          return Object.freeze({ ...section, body: section.body.replace(
            first.claims[0]?.text ?? '',
            falseClaim,
          ) });
        }
        if (section.sectionId === 'summary') {
          return Object.freeze({ ...section, body: section.body.replace(first.summary, falseSummary) });
        }
        return section;
      })),
      claims: Object.freeze(first.claims.map((claim, index) => {
        if (index === 0) return Object.freeze({ ...claim, text: falseClaim });
        if (index === first.claims.length - 1) {
          return Object.freeze({ ...claim, text: falseSummary });
        }
        return claim;
      })),
    });
    const result = evaluateSemanticQuality({
      outline: value.outline,
      proposals: [hallucinated, ...value.proposals.slice(1)],
      evidencePacks: value.packs,
      reconciliation: value.reconciliation,
    }, PROJECT_ID);
    const report = result.pages.find((page) => page.pageId === hallucinated.pageId);
    expect(report?.reasonCodes).toContain('claim-evidence-unsupported');
    expect(report?.reasonCodes).toContain('title-grounding-insufficient');
    expect(report?.reasonCodes).toContain('summary-grounding-insufficient');
    expect(report?.eligibleForApproval).toBe(false);
    expect(result.corpus.eligibleForApproval).toBe(false);
  });

  it('fails one-line boilerplate and citation-only near duplicates despite valid shape', () => {
    const value = qualityFixture();
    const shallow = value.proposals.map((item, index) => canonicalProposal({
      ...item,
      sections: Object.freeze(item.sections.map((section) => ({
        ...section,
        body: `Source file is documented with citation-${String(index).padStart(64, '0')}.`,
      }))),
      claims: Object.freeze(item.claims.map((claim) => ({
        ...claim,
        text: `Source file is documented with citation-${String(index).padStart(64, '0')}.`,
      }))),
    }));
    const result = evaluateSemanticQuality({
      outline: value.outline,
      proposals: shallow,
      evidencePacks: value.packs,
      reconciliation: value.reconciliation,
    }, PROJECT_ID);
    expect(result.corpus.hardQualityPassed).toBe(false);
    expect(result.pages.every((page) => page.hardQualityPassed === false)).toBe(true);
    expect(result.pages.some((page) => page.reasonCodes.includes('near-duplicate'))).toBe(true);
    expect(result.pages.some((page) => page.reasonCodes.includes('boilerplate-repetition')))
      .toBe(true);
    expect(result.pages.some((page) => page.reasonCodes.includes('key-question-unanswered')))
      .toBe(true);
  });

  it('fails filename listings, unsupported claims and unresolved conflicts separately', () => {
    const value = qualityFixture();
    const first = value.proposals[0] as HierarchicalWikiProposalV1;
    const filenameBody = 'docs/alpha.md\ndocs/beta.md\ndocs/gamma.md';
    const filenameProposal = canonicalProposal({
      ...first,
      sections: Object.freeze(first.sections.map((section) => ({
        ...section,
        body: filenameBody,
      }))),
      claims: Object.freeze(first.claims.map((claim) => ({ ...claim, text: 'docs/alpha.md' }))),
    });
    const unsupported = canonicalProposal({
      ...(value.proposals[1] as HierarchicalWikiProposalV1),
      claims: Object.freeze((value.proposals[1] as HierarchicalWikiProposalV1).claims.map(
        (claim) => ({ ...claim, citationIds: Object.freeze([citationId('missing')]) }),
      )),
    });
    const conflictedPack = canonicalPack({
      ...(value.packs[2] as EvidencePackV1),
      conflicts: Object.freeze([{
        conflictId: `conflict-${digest('placeholder').slice('sha256:'.length)}`,
        kind: 'authority',
        unitIds: Object.freeze((value.packs[2] as EvidencePackV1).units.map((unit) => unit.unitId)),
        status: 'unresolved' as const,
      }]),
    });
    const root = canonicalProposal({
      ...(value.proposals[2] as HierarchicalWikiProposalV1),
      evidencePackDigest: conflictedPack.packDigest,
    });
    const result = evaluateSemanticQuality({
      outline: value.outline,
      proposals: [filenameProposal, unsupported, root],
      evidencePacks: [value.packs[0] as EvidencePackV1, value.packs[1] as EvidencePackV1,
        conflictedPack],
      reconciliation: value.reconciliation,
    }, PROJECT_ID);
    const byId = new Map(result.pages.map((page) => [page.pageId, page]));
    expect(byId.get(first.pageId)?.reasonCodes).toContain('filename-listing');
    expect(byId.get(unsupported.pageId)?.reasonCodes).toContain('claim-grounding-insufficient');
    expect(byId.get(root.pageId)?.reasonCodes).toContain('unresolved-conflict');
    expect(result.corpus.eligibleForApproval).toBe(false);
  });

  it('blocks incomplete, orphaned and Uncategorized corpora even with an intentional exception', () => {
    const value = qualityFixture();
    const incomplete = evaluateSemanticQuality({
      outline: value.outline,
      proposals: value.proposals.slice(0, 2),
      evidencePacks: value.packs.slice(0, 2),
      reconciliation: null,
    }, PROJECT_ID);
    expect(incomplete.corpus.reasonCodes).toContain('candidate-set-incomplete');
    expect(incomplete.corpus.reasonCodes).toContain('link-reconciliation-incomplete');

    const orphanProposals = value.proposals.map((item) => canonicalProposal({
      ...item,
      wikilinks: item.pageId === ROOT ? Object.freeze([LEAF_ALPHA]) : Object.freeze([ROOT]),
    }));
    const orphaned = evaluateSemanticQuality({
      outline: value.outline,
      proposals: orphanProposals,
      evidencePacks: value.packs,
      reconciliation: value.reconciliation,
      intentionalOrphanPageIds: [LEAF_BETA],
    }, PROJECT_ID);
    expect(orphaned.corpus.orphanPageIds).toEqual([LEAF_BETA]);
    expect(orphaned.corpus.intentionalOrphanPageIds).toEqual([LEAF_BETA]);
    expect(orphaned.corpus.reasonCodes).toContain('orphan-threshold-exceeded');
    expect(orphaned.corpus.eligibleForApproval).toBe(false);

    const uncategorized = qualityFixture('uncategorized');
    const categorizedResult = evaluateSemanticQuality({
      outline: uncategorized.outline,
      proposals: uncategorized.proposals,
      evidencePacks: uncategorized.packs,
      reconciliation: uncategorized.reconciliation,
    }, PROJECT_ID);
    expect(categorizedResult.corpus.reasonCodes).toContain('uncategorized-page-present');
    expect(categorizedResult.corpus.eligibleForApproval).toBe(false);
  });

  it('rejects a mutated artifact whose declared digest was not canonically recomputed', () => {
    const value = qualityFixture();
    const first = value.proposals[0] as HierarchicalWikiProposalV1;
    const tampered = Object.freeze({ ...first, summary: `${first.summary} tampered` });
    expect(() => evaluateSemanticQuality({
      outline: value.outline,
      proposals: [tampered, ...value.proposals.slice(1)],
      evidencePacks: value.packs,
      reconciliation: value.reconciliation,
    }, PROJECT_ID)).toThrow();
  });

  it('fails undeclared substantive prose even when declared claims remain grounded', () => {
    const value = qualityFixture();
    const first = value.proposals[0] as HierarchicalWikiProposalV1;
    const unsupported = canonicalProposal({
      ...first,
      sections: Object.freeze(first.sections.map((section, index) => index === 0
        ? Object.freeze({
            ...section,
            body: `${section.body}\nThis additional assertion has no evidence claim or citation mapping.`,
          })
        : section)),
    });
    const result = evaluateSemanticQuality({
      outline: value.outline,
      proposals: [unsupported, ...value.proposals.slice(1)],
      evidencePacks: value.packs,
      reconciliation: value.reconciliation,
    }, PROJECT_ID);
    expect(result.pages.find((page) => page.pageId === unsupported.pageId)?.reasonCodes)
      .toContain('unsupported-section-content');
    expect(result.corpus.eligibleForApproval).toBe(false);
  });

  it('binds every deterministic threshold into the policy digest', () => {
    expect(SEMANTIC_QUALITY_POLICY).toMatchObject({
      schemaVersion: 'buildlore.semantic-quality-policy.v1',
      thresholds: {
        minimumSectionCoverageBasisPoints: 10_000,
        minimumQuestionCoverageBasisPoints: 10_000,
        minimumClaimGroundingBasisPoints: 10_000,
        minimumClaimEvidenceSupportBasisPoints: 10_000,
        maximumNearDuplicateBasisPoints: 8_500,
        maximumOrphanBasisPoints: 500,
        maximumUncategorizedPages: 0,
      },
    });
  });
});
