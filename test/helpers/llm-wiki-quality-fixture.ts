import { digestHierarchyValue } from '../../src/compiler/index.js';
import {
  LLM_WIKI_QUALITY_CASES_V3,
  projectApprovedWikiSemanticText,
  type ApprovedWikiMeaningSignalV1,
  type ApprovedWikiRetrievalCorpusV1,
  type ApprovedWikiRetrievalPageV1,
} from '../../src/retrieval/index.js';

export interface LlmWikiQualityExpectedLocator {
  readonly citationId: string;
  readonly pageId: string;
  readonly sectionId: string;
  readonly sourceId: string;
  readonly title: string;
}

export interface LlmWikiQualityFixture {
  readonly corpus: ApprovedWikiRetrievalCorpusV1;
  readonly expectedByQuery: ReadonlyMap<string, LlmWikiQualityExpectedLocator>;
}

/** Shared fixed-query corpus used by both report-contract and actual retrieval lifecycle tests. */
export function llmWikiQualityFixture(): LlmWikiQualityFixture {
  const expectedByQuery = new Map<string, LlmWikiQualityExpectedLocator>();
  const pages: ApprovedWikiRetrievalPageV1[] = [];
  for (const [index, qualityCase] of LLM_WIKI_QUALITY_CASES_V3.entries()) {
    const pageId = `quality/${qualityCase.queryId}`;
    const title = `${qualityCase.expectedPageLabels.join(' ')} evidence`;
    const expectedCitationId = `citation-${qualityCase.queryId}-expected`;
    const expectedSourceId = `source-${qualityCase.queryId}-expected`;
    const expectedBody = `${qualityCase.text} ${qualityCase.expectedPageLabels.join(' ')} ` +
      `approved evidence. [^${expectedCitationId}]`;
    const expectedSemantic = projectApprovedWikiSemanticText(expectedBody, title);
    const expectedMeaning: ApprovedWikiMeaningSignalV1 = Object.freeze({
      authority: qualityCase.intent === 'historical' ? 'historical' : 'canonical',
      evidenceKind: qualityCase.expectedEvidenceKinds[0] ?? 'other',
      iterationGroup: qualityCase.intent === 'historical' ? 'v12' : null,
      lifecycle: qualityCase.intent === 'historical' ? 'superseded' : 'current',
      origin: 'manifest',
      revisionOrdinal: qualityCase.intent === 'historical' ? 12 : 25,
      sourceId: expectedSourceId,
      topicGroup: qualityCase.expectedPageLabels[0] ?? null,
    });
    const decoys = Array.from({ length: 3 }, (_, decoyIndex) => {
      const suffix = String(decoyIndex + 1).padStart(2, '0');
      const citationId = `citation-${qualityCase.queryId}-decoy-${suffix}`;
      const sourceId = `source-${qualityCase.queryId}-decoy-${suffix}`;
      const body = `${qualityCase.text} unrelated ranking noise. [^${citationId}]\n\n` +
        `source_digest: sha256:${String(index).padStart(2, '0').repeat(32)}\n` +
        `proposal_digest: sha256:${suffix.repeat(32)}`;
      const semantic = projectApprovedWikiSemanticText(body, title);
      const meaning: ApprovedWikiMeaningSignalV1 = Object.freeze({
        authority: 'unknown',
        evidenceKind: 'other',
        iterationGroup: null,
        lifecycle: 'unknown',
        origin: 'legacy-default',
        revisionOrdinal: 0,
        sourceId,
        topicGroup: null,
      });
      return Object.freeze({ body, citationId, meaning, semantic, sourceId, suffix });
    });
    const sectionId = 'expected';
    pages.push(Object.freeze({
      childPageIds: Object.freeze([]),
      meaningSignals: Object.freeze([...decoys.map((decoy) => decoy.meaning), expectedMeaning]
        .sort((left, right) =>
        left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0)),
      pageId,
      parentPageId: null,
      proposalDigest: digestHierarchyValue({ index, pageId }),
      relationPageIds: Object.freeze([]),
      sections: Object.freeze([
        ...decoys.map((decoy) => Object.freeze({
          body: decoy.body,
          citationLocators: Object.freeze([Object.freeze({
            citationId: decoy.citationId,
            sourceId: decoy.sourceId,
          })]),
          exclusionSummary: decoy.semantic.exclusionSummary,
          meaningSignals: Object.freeze([decoy.meaning]),
          semanticContentDigest: decoy.semantic.semanticContentDigest,
          semanticText: decoy.semantic.semanticText,
          sectionId: `decoy-${decoy.suffix}`,
        })),
        Object.freeze({
          body: expectedBody,
          citationLocators: Object.freeze([Object.freeze({
            citationId: expectedCitationId,
            sourceId: expectedSourceId,
          })]),
          exclusionSummary: expectedSemantic.exclusionSummary,
          meaningSignals: Object.freeze([expectedMeaning]),
          semanticContentDigest: expectedSemantic.semanticContentDigest,
          semanticText: expectedSemantic.semanticText,
          sectionId,
        }),
      ]),
      status: 'active',
      summary: `Grounded ${title}.`,
      title,
    }));
    expectedByQuery.set(qualityCase.queryId, Object.freeze({
      citationId: expectedCitationId,
      pageId,
      sectionId,
      sourceId: expectedSourceId,
      title,
    }));
  }
  const basis = Object.freeze({
    generationDigest: digestHierarchyValue('quality-generation'),
    pages: Object.freeze(pages.sort((left, right) => left.pageId < right.pageId ? -1 : 1)),
    projectId: 'quality-fixture',
    schemaVersion: 'buildlore.approved-wiki-retrieval-corpus.v2' as const,
  });
  return Object.freeze({
    corpus: Object.freeze({ ...basis, corpusDigest: digestHierarchyValue(basis) }),
    expectedByQuery,
  });
}
