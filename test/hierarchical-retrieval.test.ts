import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  digestHierarchyValue,
  type AuthoritativeWikiCheckV1,
  type AuthoritativeWikiStateV1,
  type EvidencePackV1,
  type HierarchicalWikiProposalV1,
  type HierarchySha256Digest,
  type PageOwnershipGraphV1,
} from '../src/compiler/index.js';
import {
  HierarchicalRetrievalError,
  createApprovedWikiRetrieval,
  evaluateHierarchicalRetrievalGold,
  projectApprovedWikiForRetrieval,
  type HierarchicalRetrievalGoldV1,
} from '../src/retrieval/index.js';

const PROJECT_ID = 'buildlore-fixture';

async function fixture(): Promise<HierarchicalRetrievalGoldV1> {
  return JSON.parse(await readFile(
    new URL('./fixtures/retrieval/v2/hierarchical-gold.json', import.meta.url),
    'utf8',
  )) as HierarchicalRetrievalGoldV1;
}

function digest(character: string): HierarchySha256Digest {
  return `sha256:${character.repeat(64)}`;
}

function authorityCheck(
  state: AuthoritativeWikiStateV1,
  unaffectedPageIds: readonly string[],
  stalePageIds: readonly string[] = [],
): AuthoritativeWikiCheckV1 {
  const candidate = Object.freeze({
    schemaVersion: 'buildlore.authoritative-wiki-check.v1' as const,
    projectId: state.projectId,
    generationDigest: state.generationDigest,
    humanActivationApprovalDigest: state.humanActivationApprovalDigest,
    receiptSetDigest: state.receiptSetDigest,
    reviewSurfaceDigest: state.reviewSurfaceDigest,
    integratedReviewSetDigest: state.integratedReviewSetDigest,
    childSynthesisReviewSetDigest: state.childSynthesisReviewSetDigest,
    liveSnapshotDigest: digest('f'),
    status: stalePageIds.length === 0 ? 'clean' as const : 'stale' as const,
    changedSourceIds: Object.freeze(stalePageIds.length === 0 ? [] : ['source-one']),
    configurationDriftReasonCodes: Object.freeze([]),
    directlyStalePageIds: Object.freeze([...stalePageIds]),
    stalePageIds: Object.freeze([...stalePageIds]),
    retrievalStalePageIds: Object.freeze([...stalePageIds]),
    unaffectedPageIds: Object.freeze([...unaffectedPageIds]),
  });
  return Object.freeze({ ...candidate, checkDigest: digestHierarchyValue(candidate) });
}

describe('approved hierarchical Wiki retrieval', () => {
  it('[RQ-V-08][RQ-SC-10] replays 79 legacy pages and all 423 citation locators', () => {
    const rootPageId = 'baseline/page-000';
    const pageIds = Array.from({ length: 79 }, (_, index) =>
      `baseline/page-${String(index).padStart(3, '0')}`);
    const pages = pageIds.map((pageId, pageIndex) => {
      const citationCount = pageIndex < 28 ? 6 : 5;
      const citationLocators = Array.from({ length: citationCount }, (_, citationIndex) => {
        const suffix = `${String(pageIndex).padStart(3, '0')}-` +
          String(citationIndex).padStart(2, '0');
        return Object.freeze({
          citationId: `citation-${suffix}`,
          sourceId: `source-${suffix}`,
        });
      });
      const body = citationLocators.map((locator) =>
        `Grounded baseline claim ${locator.citationId}. [^${locator.citationId}]`).join('\n\n');
      return Object.freeze({
        childPageIds: pageIndex === 0 ? Object.freeze(pageIds.slice(1)) : Object.freeze([]),
        pageId,
        parentPageId: pageIndex === 0 ? null : rootPageId,
        proposalDigest: digestHierarchyValue({ pageId, pageIndex }),
        relationPageIds: Object.freeze([]),
        sections: Object.freeze([Object.freeze({
          body,
          citationLocators: Object.freeze(citationLocators),
          sectionId: 'evidence',
        })]),
        status: 'active' as const,
        summary: `Approved baseline page ${pageIndex}.`,
        title: `Baseline page ${pageIndex}`,
      });
    });
    const basis = Object.freeze({
      generationDigest: digestHierarchyValue('79-page-baseline-generation'),
      pages: Object.freeze(pages),
      projectId: PROJECT_ID,
      schemaVersion: 'buildlore.approved-wiki-retrieval-corpus.v1' as const,
    });
    const corpus = Object.freeze({ ...basis, corpusDigest: digestHierarchyValue(basis) });
    const retrieval = createApprovedWikiRetrieval(corpus, PROJECT_ID);
    const listed = retrieval.list(PROJECT_ID);
    const listedIds = new Set(listed.map((page) => page.pageId));
    const replayed = listed.map((page) => {
      const value = retrieval.read(PROJECT_ID, page.pageId);
      if (value === undefined) throw new Error('Approved baseline page could not be replayed.');
      return value;
    });
    const citationCount = replayed.reduce((sum, page) => sum + page.sections.reduce(
      (sectionSum, section) => sectionSum + section.citationLocators.length,
      0,
    ), 0);
    const orphanPageIds = listed.filter((page) =>
      page.parentPageId !== null && !listedIds.has(page.parentPageId)).map((page) => page.pageId);

    expect(listed).toHaveLength(79);
    expect(citationCount).toBe(423);
    expect(orphanPageIds).toEqual([]);
    expect(replayed).toEqual(corpus.pages);
  });

  it('[HSW-V-07][HSW-V-08] records at least 15 positive lexical/graph gold questions', async () => {
    const gold = await fixture();
    const first = evaluateHierarchicalRetrievalGold(gold);
    const second = evaluateHierarchicalRetrievalGold(gold);

    expect(first).toEqual(second);
    expect(gold.questions).toHaveLength(17);
    expect(gold.questions.filter((question) => question.expected.length > 0)).toHaveLength(15);
    expect(new Set(gold.questions.map((question) => question.language))).toEqual(
      new Set(['code', 'en', 'ko']),
    );
    expect(new Set(gold.questions.map((question) => question.kind))).toEqual(
      new Set(['global', 'local', 'multi-hop', 'zero-result']),
    );
    expect(first).toMatchObject({
      overallPassed: true,
      modeExecutionCount: 34,
      queryCount: 17,
      thresholds: {
        minimumAnswerEvidenceCompleteness: 0.85,
        minimumAnswerEvidenceCorrectness: 0.8,
        minimumCitationPrecision: 0.8,
        minimumCitationRecall: 0.8,
        minimumMrr: 0.7,
        minimumRecallAt5: 0.85,
      },
    });
    expect(first.metrics).toEqual([
      {
        answerEvidenceCompleteness: 0.973333,
        answerEvidenceCorrectness: 1,
        channelPassed: true,
        citationPrecision: 0.933333,
        citationRecall: 0.9,
        mrr: 1,
        nDcgAt10: 0.984964,
        positiveQueryCount: 15,
        recallAt5: 0.973333,
        requestedMode: 'lexical',
        zeroResultPassed: 2,
        zeroResultQueryCount: 2,
      },
      {
        answerEvidenceCompleteness: 1,
        answerEvidenceCorrectness: 1,
        channelPassed: true,
        citationPrecision: 0.733333,
        citationRecall: 0.7,
        mrr: 0.9,
        nDcgAt10: 0.908634,
        positiveQueryCount: 15,
        recallAt5: 1,
        requestedMode: 'graph',
        zeroResultPassed: 2,
        zeroResultQueryCount: 2,
      },
      {
        answerEvidenceCompleteness: 0.986667,
        answerEvidenceCorrectness: 1,
        channelPassed: true,
        citationPrecision: 0.833333,
        citationRecall: 0.8,
        mrr: 0.95,
        nDcgAt10: 0.946799,
        positiveQueryCount: 30,
        recallAt5: 0.986667,
        requestedMode: 'all',
        zeroResultPassed: 4,
        zeroResultQueryCount: 4,
      },
    ]);
    for (const question of gold.questions) {
      expect(first.queryResults.filter((result) => result.queryId === question.queryId)
        .map((result) => result.requestedMode).sort()).toEqual(['graph', 'lexical']);
    }
    expect(first.queryResults.every((result) => result.locators.every((locator) =>
      locator.projectId === PROJECT_ID && locator.pageId !== '' && locator.sectionId !== '' &&
      locator.sourceIds.length > 0 && locator.citationIds.length > 0))).toBe(true);

    const degradedCorpusBasis = Object.freeze({
      generationDigest: gold.corpus.generationDigest,
      pages: Object.freeze(gold.corpus.pages.map((page) => Object.freeze({
        ...page,
        sections: Object.freeze(page.sections.map((section) => Object.freeze({
          ...section,
          citationLocators: Object.freeze([
            ...section.citationLocators,
            { citationId: 'citation-unexpected', sourceId: 'source-unexpected' },
          ]),
        }))),
      }))),
      projectId: gold.corpus.projectId,
      schemaVersion: gold.corpus.schemaVersion,
    });
    const degraded = evaluateHierarchicalRetrievalGold({
      ...gold,
      corpus: Object.freeze({
        ...degradedCorpusBasis,
        corpusDigest: digestHierarchyValue(degradedCorpusBasis),
      }),
    });
    const baselineOverall = first.metrics.find((metric) => metric.requestedMode === 'all');
    const degradedOverall = degraded.metrics.find((metric) => metric.requestedMode === 'all');
    expect(degradedOverall).toMatchObject({
      mrr: baselineOverall?.mrr,
      recallAt5: baselineOverall?.recallAt5,
    });
    expect(degradedOverall?.citationPrecision).toBeLessThan(0.8);
    expect(degradedOverall?.answerEvidenceCorrectness).toBe(1);
    expect(degraded.overallPassed).toBe(false);
  });

  it('[HSW-A-08] supports list/read/citations and relation expansion without a model or provider', async () => {
    const gold = await fixture();
    const retrieval = createApprovedWikiRetrieval(gold.corpus, PROJECT_ID);

    expect(retrieval.list(PROJECT_ID)).toHaveLength(7);
    expect(retrieval.read(PROJECT_ID, 'reference/api')).toMatchObject({
      pageId: 'reference/api',
      status: 'active',
      title: 'Hierarchical retrieval API',
    });
    expect(retrieval.citations(PROJECT_ID, 'reference/api', 'typescript-entrypoint')).toEqual([
      { citationId: 'citation-api', sourceId: 'source-api' },
    ]);
    const result = retrieval.search({
      mode: 'graph',
      projectId: PROJECT_ID,
      query: 'public entrypoint relation graph search',
    });
    expect(result).toMatchObject({
      effectiveMode: 'graph',
      fallback: null,
      modelUsed: false,
      providerUsed: false,
      requestedMode: 'graph',
    });
    expect(result.hits.map((hit) => hit.locator.pageId)).toEqual(expect.arrayContaining([
      'concepts/retrieval',
      'reference/api',
    ]));
    expect(result.hits.some((hit) => hit.channels.some((channel) =>
      channel.channel === 'graph' && channel.rank > 0 && channel.score > 0))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('public entrypoint relation graph search');
  });

  it('[HSW-MP-02][HSW-EC-14] rejects cross-project access and invalid corpus value-free', async () => {
    const gold = await fixture();
    const retrieval = createApprovedWikiRetrieval(gold.corpus, PROJECT_ID);
    for (const operation of [
      () => retrieval.list('private-other-project'),
      () => retrieval.read('private-other-project', 'reference/api'),
      () => retrieval.citations('private-other-project', 'reference/api'),
      () => retrieval.search({
        mode: 'lexical' as const,
        projectId: 'private-other-project',
        query: 'retrieval',
      }),
    ]) {
      expect(operation).toThrow(HierarchicalRetrievalError);
      try {
        operation();
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain('private-other-project');
      }
    }
    expect(() => createApprovedWikiRetrieval({
      ...gold.corpus,
      corpusDigest: digest('0'),
    }, PROJECT_ID)).toThrow(HierarchicalRetrievalError);
    expect(() => retrieval.search({
      mode: 'lexical',
      projectId: PROJECT_ID,
      query: 'unsafe\nquery',
    })).toThrow(HierarchicalRetrievalError);
  });

  it('projects only atomic active authority and its citation ownership into retrieval', () => {
    const pageId = 'page-one';
    const snapshotDigest = digest('1');
    const packDigest = digest('2');
    const proposalDigest = digest('3');
    const ownershipDigest = digest('4');
    const graphDigest = digest('5');
    const proposal: HierarchicalWikiProposalV1 = {
      schemaVersion: 'buildlore.hierarchical-wiki-proposal.v2',
      projectId: PROJECT_ID,
      pageId,
      blueprintDigest: digest('6'),
      evidencePackDigest: packDigest,
      requestDigest: digest('7'),
      title: 'Approved page',
      summary: 'Approved summary',
      sections: [
        { sectionId: 'main', body: 'Grounded approved claim. [^citation-one]' },
        { sectionId: 'uncited', body: 'Grounded approved claim. Repeated without a marker.' },
      ],
      claims: [{
        claimId: 'claim-one',
        text: 'Grounded approved claim.',
        evidenceUnitIds: ['unit-one'],
        citationIds: ['citation-one'],
      }],
      wikilinks: [],
      citationIds: ['citation-one'],
      lifecycle: 'candidate',
      proposalDigest,
    };
    const pack: EvidencePackV1 = {
      schemaVersion: 'buildlore.evidence-pack.v1',
      projectId: PROJECT_ID,
      pageId,
      blueprintDigest: proposal.blueprintDigest,
      snapshotDigest,
      sanitizerPolicyDigest: digest('8'),
      units: [{
        unitId: 'unit-one',
        sourceId: 'source-one',
        kind: 'paragraph',
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 24 },
        content: 'Grounded approved claim.',
        contentDigest: digest('9'),
        citation: {
          citationId: 'citation-one',
          sourceId: 'source-one',
          sourceRevision: digest('a'),
          sourceRef: 'docs/source.md',
          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 24 },
          quoteDigest: digest('b'),
        },
      }],
      conflicts: [],
      gaps: [],
      evidenceBytes: 24,
      packDigest,
    };
    const ownershipGraph: PageOwnershipGraphV1 = {
      schemaVersion: 'buildlore.page-ownership-graph.v1',
      projectId: PROJECT_ID,
      snapshotDigest,
      outlineDigest: digest('c'),
      ledgerDigest: digest('d'),
      receiptSetDigest: digest('1'),
      reviewSurfaceDigest: digest('2'),
      integratedReviewSetDigest: digest('3'),
      childSynthesisReviewSetDigest: digest('4'),
      purposeDigest: digest('purpose'),
      interpretationRulesDigest: digest('rules'),
      profileDigest: digest('profile'),
      compilerContractDigest: digest('compiler'),
      sanitizerPolicyDigest: digest('sanitizer'),
      sourceManifestDigest: digest('manifest'),
      policyDigest: digest('policy'),
      corpusSourceSetDigest: digest('source-set'),
      pages: [{
        pageId,
        proposalDigest,
        parentPageId: null,
        childPageIds: [],
        ancestorPageIds: [],
        taskIds: ['task-one'],
        textUnitIds: ['unit-one'],
        sectionIds: ['main', 'uncited'],
        sourceRevisions: [{ sourceId: 'source-one', sourceRevision: digest('a') }],
        ownershipDigest,
      }],
      graphDigest,
    };
    const state: AuthoritativeWikiStateV1 = {
      schemaVersion: 'buildlore.authoritative-wiki-state.v1',
      projectId: PROJECT_ID,
      snapshotDigest,
      ledgerDigest: digest('d'),
      ownershipGraphDigest: graphDigest,
      receiptSetDigest: ownershipGraph.receiptSetDigest,
      reviewSurfaceDigest: ownershipGraph.reviewSurfaceDigest,
      integratedReviewSetDigest: ownershipGraph.integratedReviewSetDigest,
      childSynthesisReviewSetDigest: ownershipGraph.childSynthesisReviewSetDigest,
      humanActivationApprovalDigest: digest('6'),
      previousGenerationDigest: null,
      activePages: [{ pageId, proposalDigest, ownershipDigest, status: 'active' }],
      status: 'active',
      generationDigest: digest('e'),
    };

    const corpus = projectApprovedWikiForRetrieval({
      authorityCheck: authorityCheck(state, [pageId]),
      evidencePacks: [pack],
      ownershipGraph,
      proposals: [proposal],
      state,
    }, PROJECT_ID);
    expect(corpus.schemaVersion).toBe('buildlore.approved-wiki-retrieval-corpus.v2');
    expect(corpus.pages[0]).toMatchObject({
      pageId,
      sections: [
        {
          body: 'Grounded approved claim. [^citation-one]',
          citationLocators: [{ citationId: 'citation-one', sourceId: 'source-one' }],
          sectionId: 'main',
          semanticText: 'Grounded approved claim.',
        },
      ],
      status: 'active',
    });
    expect(corpus.pages[0]?.sections[0]?.exclusionSummary).toMatchObject({
      excludedKinds: ['citation-marker'],
    });
    expect(corpus.pages[0]?.sections[0]?.meaningSignals?.[0]).toMatchObject({
      authority: 'unknown',
      lifecycle: 'unknown',
      origin: 'legacy-default',
      sourceId: 'source-one',
    });
    expect(createApprovedWikiRetrieval(corpus, PROJECT_ID).search({
      projectId: PROJECT_ID,
      query: 'Grounded claim',
    }).hits[0]?.locator).toEqual({
      citationIds: ['citation-one'],
      pageId,
      projectId: PROJECT_ID,
      sectionId: 'main',
      sourceIds: ['source-one'],
    });

    const secondPageId = 'page-two';
    const secondPackDigest = digest('0');
    const secondProposalDigest = digest('1');
    const secondOwnershipDigest = digest('2');
    const secondProposal: HierarchicalWikiProposalV1 = {
      ...proposal,
      pageId: secondPageId,
      evidencePackDigest: secondPackDigest,
      title: 'Unaffected page',
      summary: 'Unaffected approved summary',
      sections: [{
        sectionId: 'details',
        body: 'Unaffected grounded claim. [^citation-two]',
      }],
      claims: [{
        claimId: 'claim-two',
        text: 'Unaffected grounded claim.',
        evidenceUnitIds: ['unit-two'],
        citationIds: ['citation-two'],
      }],
      wikilinks: [pageId],
      citationIds: ['citation-two'],
      proposalDigest: secondProposalDigest,
    };
    const secondPack: EvidencePackV1 = {
      ...pack,
      pageId: secondPageId,
      packDigest: secondPackDigest,
      units: [{
        ...pack.units[0] as EvidencePackV1['units'][number],
        unitId: 'unit-two',
        sourceId: 'source-two',
        content: 'Unaffected grounded claim.',
        citation: {
          ...pack.units[0]?.citation,
          citationId: 'citation-two',
          sourceId: 'source-two',
        } as EvidencePackV1['units'][number]['citation'],
      }],
    };
    const linkedGraph: PageOwnershipGraphV1 = {
      ...ownershipGraph,
      pages: [{
        ...ownershipGraph.pages[0] as PageOwnershipGraphV1['pages'][number],
        childPageIds: [secondPageId],
      }, {
        pageId: secondPageId,
        proposalDigest: secondProposalDigest,
        parentPageId: pageId,
        childPageIds: [],
        ancestorPageIds: [pageId],
        taskIds: ['task-two'],
        textUnitIds: ['unit-two'],
        sectionIds: ['details'],
        sourceRevisions: [{ sourceId: 'source-two', sourceRevision: digest('3') }],
        ownershipDigest: secondOwnershipDigest,
      }],
      graphDigest: digest('4'),
    };
    const linkedState: AuthoritativeWikiStateV1 = {
      ...state,
      ownershipGraphDigest: linkedGraph.graphDigest,
      activePages: [
        ...state.activePages,
        {
          pageId: secondPageId,
          proposalDigest: secondProposalDigest,
          ownershipDigest: secondOwnershipDigest,
          status: 'active',
        },
      ],
      generationDigest: digest('5'),
    };
    const parentWithInheritedCitation: HierarchicalWikiProposalV1 = {
      ...proposal,
      sections: [{
        sectionId: 'main',
        body: 'Grounded approved claim. [^citation-one] ' +
          'Unaffected approved summary. [^citation-two]',
      }],
      wikilinks: [secondPageId],
      citationIds: ['citation-one', 'citation-two'],
    };
    const inheritedCorpus = projectApprovedWikiForRetrieval({
      authorityCheck: authorityCheck(linkedState, [pageId, secondPageId]),
      evidencePacks: [pack, secondPack],
      inheritedCitationAuthorizations: [
        { pageId, citationIds: ['citation-two'] },
        { pageId: secondPageId, citationIds: [] },
      ],
      ownershipGraph: linkedGraph,
      proposals: [parentWithInheritedCitation, secondProposal],
      state: linkedState,
    }, PROJECT_ID);
    expect(inheritedCorpus.pages.find((page) => page.pageId === pageId)?.sections[0])
      .toMatchObject({
        citationLocators: [
          { citationId: 'citation-one', sourceId: 'source-one' },
          { citationId: 'citation-two', sourceId: 'source-two' },
        ],
      });

    expect(() => projectApprovedWikiForRetrieval({
      authorityCheck: authorityCheck(linkedState, [pageId, secondPageId]),
      evidencePacks: [pack, secondPack],
      inheritedCitationAuthorizations: [
        { pageId, citationIds: ['citation-one'] },
        { pageId: secondPageId, citationIds: [] },
      ],
      ownershipGraph: linkedGraph,
      proposals: [parentWithInheritedCitation, secondProposal],
      state: linkedState,
    }, PROJECT_ID)).toThrow(HierarchicalRetrievalError);

    const childWithAncestorCitation: HierarchicalWikiProposalV1 = {
      ...secondProposal,
      sections: [{
        sectionId: 'details',
        body: 'Unaffected grounded claim. [^citation-two] ' +
          'Ancestor evidence is not an inherited child summary. [^citation-one]',
      }],
      citationIds: ['citation-one', 'citation-two'],
    };
    expect(() => projectApprovedWikiForRetrieval({
      authorityCheck: authorityCheck(linkedState, [pageId, secondPageId]),
      evidencePacks: [pack, secondPack],
      inheritedCitationAuthorizations: [
        { pageId, citationIds: [] },
        { pageId: secondPageId, citationIds: ['citation-one'] },
      ],
      ownershipGraph: linkedGraph,
      proposals: [proposal, childWithAncestorCitation],
      state: linkedState,
    }, PROJECT_ID)).toThrow(HierarchicalRetrievalError);

    expect(() => projectApprovedWikiForRetrieval({
      authorityCheck: authorityCheck(linkedState, [pageId, secondPageId]),
      evidencePacks: [pack, {
        ...secondPack,
        units: [{
          ...secondPack.units[0] as EvidencePackV1['units'][number],
          citation: {
            ...secondPack.units[0]?.citation,
            citationId: 'citation-one',
            sourceId: 'source-two',
          } as EvidencePackV1['units'][number]['citation'],
        }],
      }],
      ownershipGraph: linkedGraph,
      proposals: [proposal, secondProposal],
      state: linkedState,
    }, PROJECT_ID)).toThrow(HierarchicalRetrievalError);

    const unaffectedCorpus = projectApprovedWikiForRetrieval({
      authorityCheck: authorityCheck(linkedState, [secondPageId], [pageId]),
      evidencePacks: [pack, secondPack],
      ownershipGraph: linkedGraph,
      proposals: [{ ...proposal, wikilinks: [secondPageId] }, secondProposal],
      state: linkedState,
    }, PROJECT_ID);
    expect(unaffectedCorpus.pages).toEqual([expect.objectContaining({
      childPageIds: [],
      pageId: secondPageId,
      parentPageId: null,
      relationPageIds: [],
    })]);

    expect(() => projectApprovedWikiForRetrieval({
      authorityCheck: authorityCheck(state, [], [pageId]),
      evidencePacks: [pack],
      ownershipGraph,
      proposals: [proposal],
      state,
    }, PROJECT_ID)).toThrow(HierarchicalRetrievalError);
    const cleanCheck = authorityCheck(state, [pageId]);
    expect(() => projectApprovedWikiForRetrieval({
      authorityCheck: { ...cleanCheck, unaffectedPageIds: [] },
      evidencePacks: [pack],
      ownershipGraph,
      proposals: [proposal],
      state,
    }, PROJECT_ID)).toThrow(HierarchicalRetrievalError);
    expect(() => projectApprovedWikiForRetrieval({
      authorityCheck: cleanCheck,
      evidencePacks: [pack],
      ownershipGraph,
      proposals: [{ ...proposal, proposalDigest: digest('f') }],
      state,
    }, PROJECT_ID)).toThrow(HierarchicalRetrievalError);
  });
});
