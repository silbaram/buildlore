import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_COMPILATION_POLICY,
  buildSparseRelationGraph,
  createCompilationPurpose,
  createCorpusSnapshot,
  createDocumentInterpretation,
  createDocumentInterpretationRule,
  createTextUnit,
  createWikiOutline,
  diffWikiOutlines,
  hierarchySha256,
  interpretDocumentFromRules,
  parseWikiOutline,
  reviewWikiOutline,
  type CompilationPurposeV1,
  type CorpusSnapshotV1,
  type DocumentInterpretationV1,
} from '../src/compiler/index.js';

const PROJECT_ID = 'fixture-project';
const SOURCE_IDS = [0, 1, 2, 3].map((index) =>
  `source-${hierarchySha256(`source-${String(index)}`).slice('sha256:'.length)}`);

function purpose(questionSuffix = ''): CompilationPurposeV1 {
  return createCompilationPurpose({
    projectId: PROJECT_ID,
    audience: ['Maintainers'],
    goals: ['Explain the product from verified evidence'],
    keyQuestions: [
      `How is source integrity preserved${questionSuffix}?`,
      'How is local retrieval performed?',
    ],
    scopeHints: ['Registered generic corpus'],
    excludedTopics: ['Hosted services'],
    outputLanguage: 'en',
    requestedPageRoles: ['architecture', 'overview'],
  });
}

function snapshot(compilationPurpose = purpose()): CorpusSnapshotV1 {
  const sources = SOURCE_IDS.map((sourceId, index) => {
    const sourceRevision = hierarchySha256(`revision-${String(index)}`);
    const sourceRef = `docs/source-${String(index)}.md`;
    return Object.freeze({
      sourceId,
      sourceRevision,
      sourceRef,
      sanitizedContentDigest: hierarchySha256(`sanitized-${String(index)}`),
    });
  });
  const textUnits = sources.map((source, index) => createTextUnit({
    projectId: PROJECT_ID,
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    sourceRef: source.sourceRef,
    kind: 'heading',
    ordinal: 0,
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 12 },
    contentDigest: hierarchySha256(index < 2 ? 'Source integrity' : 'Local retrieval'),
    topicLabel: index < 2 ? 'Source integrity' : 'Local retrieval',
  }));
  return createCorpusSnapshot({
    projectId: PROJECT_ID,
    purposeDigest: compilationPurpose.purposeDigest,
    interpretationRulesDigest: hierarchySha256('rules'),
    profileDigest: hierarchySha256('profile'),
    compilerContractDigest: hierarchySha256('compiler'),
    sanitizerPolicyDigest: hierarchySha256('sanitizer'),
    sourceManifestDigest: hierarchySha256('manifest'),
    policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
    sources,
    textUnits,
  });
}

function interpretations(corpus: CorpusSnapshotV1): readonly DocumentInterpretationV1[] {
  return Object.freeze(corpus.sources.map((source, index) => {
    const sourceTopicDigest = corpus.textUnits.find((unit) => unit.sourceId === source.sourceId)
      ?.contentDigest;
    const relatedSourceId = corpus.sources.find((candidate) =>
      corpus.textUnits.find((unit) => unit.sourceId === candidate.sourceId)?.contentDigest !==
        sourceTopicDigest)?.sourceId;
    return createDocumentInterpretation({
    projectId: PROJECT_ID,
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    role: index < 2 ? 'architecture' : 'guide',
    lifecycle: 'current',
    authority: index === 0 ? 'canonical' : 'supporting',
    synthesisEligibility: 'eligible',
    basis: ['explicit-metadata'],
    confidenceBasisPoints: 10_000,
    reasonCodes: [`fixture-${String(index)}`],
    relations: index === 0 && relatedSourceId !== undefined
      ? [{
          kind: 'related',
          sourceId: relatedSourceId,
        }]
      : [],
    });
  }));
}

describe('explicit-rule-first document interpretation', () => {
  it('lets explicit meaning override matching rules including relations', () => {
    const rule = createDocumentInterpretationRule({
      ruleId: 'docs-current',
      priority: 100,
      sourceRefPrefix: 'docs/',
      sourceRefSuffix: '.md',
      meaning: {
        role: 'guide',
        lifecycle: 'current',
        authority: 'supporting',
        synthesisEligibility: 'eligible',
        relations: [{ kind: 'supersedes', sourceId: SOURCE_IDS[1] as string }],
      },
    });
    const interpreted = interpretDocumentFromRules({
      projectId: PROJECT_ID,
      sourceId: SOURCE_IDS[0] as string,
      sourceRevision: hierarchySha256('revision-0'),
      sourceRef: 'docs/source-0.md',
      explicitMeaning: {
        authority: 'canonical',
        relations: [{ kind: 'related', sourceId: SOURCE_IDS[2] as string }],
      },
      rules: [rule],
    });
    expect(interpreted).toMatchObject({
      role: 'guide',
      lifecycle: 'current',
      authority: 'canonical',
      synthesisEligibility: 'eligible',
      relations: [{ kind: 'related', sourceId: SOURCE_IDS[2] }],
    });
    expect(interpreted.basis).toEqual(['explicit-metadata', 'rule.docs-current']);
  });

  it('preserves unknown/review for missing or conflicting meaning', () => {
    const withoutRules = interpretDocumentFromRules({
      projectId: PROJECT_ID,
      sourceId: SOURCE_IDS[0] as string,
      sourceRevision: hierarchySha256('revision-0'),
      sourceRef: 'docs/source-0.md',
      explicitMeaning: {},
      rules: [],
    });
    expect(withoutRules).toMatchObject({
      role: 'unknown',
      lifecycle: 'unknown',
      authority: 'unknown',
      synthesisEligibility: 'review',
      confidenceBasisPoints: 0,
    });

    const conflictingRules = ['current', 'deprecated'].map((lifecycle, index) =>
      createDocumentInterpretationRule({
        ruleId: `lifecycle-${String(index)}`,
        priority: 100,
        sourceRefPrefix: 'docs/',
        sourceRefSuffix: '.md',
        meaning: {
          role: 'guide',
          lifecycle: lifecycle as 'current' | 'deprecated',
          authority: 'supporting',
          synthesisEligibility: 'eligible',
        },
      }));
    const conflict = interpretDocumentFromRules({
      projectId: PROJECT_ID,
      sourceId: SOURCE_IDS[0] as string,
      sourceRevision: hierarchySha256('revision-0'),
      sourceRef: 'docs/source-0.md',
      explicitMeaning: {},
      rules: conflictingRules,
    });
    expect(conflict).toMatchObject({
      lifecycle: 'unknown',
      synthesisEligibility: 'review',
      confidenceBasisPoints: 0,
    });
    expect(conflict.reasonCodes).toContain('rule-conflict');
  });
});

describe('purpose-aware reviewable Wiki outline', () => {
  it('creates a deterministic leaf-first hierarchy independent of source page count', () => {
    const compilationPurpose = purpose();
    const corpus = snapshot(compilationPurpose);
    const graph = buildSparseRelationGraph(corpus, PROJECT_ID);
    const documentInterpretations = interpretations(corpus);
    const first = createWikiOutline(
      compilationPurpose,
      corpus,
      graph,
      documentInterpretations,
      PROJECT_ID,
    );
    const second = createWikiOutline(
      compilationPurpose,
      corpus,
      graph,
      documentInterpretations,
      PROJECT_ID,
    );
    expect(second).toEqual(first);
    expect(createWikiOutline(
      compilationPurpose,
      corpus,
      graph,
      [...documentInterpretations].reverse(),
      PROJECT_ID,
    )).toEqual(first);
    expect(parseWikiOutline(
      first,
      compilationPurpose,
      corpus,
      graph,
      documentInterpretations,
      PROJECT_ID,
    )).toEqual(first);
    expect(first.activationState).toBe('candidate');
    expect(first.blueprints).toHaveLength(3);
    expect(first.blueprints).not.toHaveLength(corpus.sources.length);
    const root = first.blueprints.find((page) => page.pageId === first.rootPageId);
    const leaves = first.blueprints.filter((page) => page.pageId !== first.rootPageId);
    expect(root).toMatchObject({
      role: 'overview',
      generationOrder: 2,
      minimumDistinctSources: 2,
    });
    expect(root?.childPageIds).toHaveLength(2);
    expect(leaves.every((page) => page.parentPageId === first.rootPageId)).toBe(true);
    expect(leaves.every((page) => page.generationOrder < (root?.generationOrder ?? 0)))
      .toBe(true);
    expect(leaves.every((page) => page.keyQuestions.length > 0)).toBe(true);
    expect(leaves.every((page) => page.requiredSections.includes('evidence'))).toBe(true);
    expect(leaves.map((page) => page.title).sort()).toEqual(['Local retrieval', 'Source integrity']);
    expect(leaves.every((page) => page.evidenceScope.sourceIds.length === 2)).toBe(true);
    expect(new Set(leaves.flatMap((page) => page.evidenceScope.sourceIds))).toEqual(
      new Set(SOURCE_IDS),
    );
    expect(leaves.every((page) => page.relatedPageIds.length > 0)).toBe(true);

    const original = documentInterpretations[0] as DocumentInterpretationV1;
    const changedInterpretation = createDocumentInterpretation({
      projectId: original.projectId,
      sourceId: original.sourceId,
      sourceRevision: original.sourceRevision,
      role: original.role,
      lifecycle: original.lifecycle,
      authority: original.authority === 'canonical' ? 'supporting' : 'canonical',
      synthesisEligibility: original.synthesisEligibility,
      basis: original.basis,
      confidenceBasisPoints: original.confidenceBasisPoints,
      reasonCodes: original.reasonCodes,
      relations: original.relations,
    });
    const changed = createWikiOutline(
      compilationPurpose,
      corpus,
      graph,
      [changedInterpretation, ...documentInterpretations.slice(1)],
      PROJECT_ID,
    );
    expect(changed.interpretationSetDigest).not.toBe(first.interpretationSetDigest);
    expect(changed.outlineDigest).not.toBe(first.outlineDigest);
  });

  it('coalesces more than 96 distinct topics into a bounded multi-level hierarchy', () => {
    const compilationPurpose = purpose();
    const sources = Array.from({ length: 117 }, (_, index) => Object.freeze({
      sourceId: `source-${hierarchySha256(`large-source-${String(index)}`)
        .slice('sha256:'.length)}`,
      sourceRevision: hierarchySha256(`large-revision-${String(index)}`),
      sourceRef: `docs/large-${String(index).padStart(3, '0')}.md`,
      sanitizedContentDigest: hierarchySha256(`large-content-${String(index)}`),
    }));
    const textUnits = sources.map((source, index) => {
      const topicLabel = `Distinct topic ${String(index).padStart(3, '0')}`;
      return createTextUnit({
        projectId: PROJECT_ID,
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        sourceRef: source.sourceRef,
        kind: 'heading',
        ordinal: 0,
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 16 },
        contentDigest: hierarchySha256(topicLabel),
        topicLabel,
      });
    });
    const corpus = createCorpusSnapshot({
      projectId: PROJECT_ID,
      purposeDigest: compilationPurpose.purposeDigest,
      interpretationRulesDigest: hierarchySha256('large-rules'),
      profileDigest: hierarchySha256('large-profile'),
      compilerContractDigest: hierarchySha256('large-compiler'),
      sanitizerPolicyDigest: hierarchySha256('large-sanitizer'),
      sourceManifestDigest: hierarchySha256('large-manifest'),
      policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
      sources,
      textUnits,
    });
    const graph = buildSparseRelationGraph(corpus, PROJECT_ID);
    const documentInterpretations = Object.freeze(sources.map((source, index) =>
      createDocumentInterpretation({
        projectId: PROJECT_ID,
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        role: 'guide',
        lifecycle: 'current',
        authority: 'supporting',
        synthesisEligibility: 'eligible',
        basis: ['explicit-metadata'],
        confidenceBasisPoints: 10_000,
        reasonCodes: [`large-fixture-${String(index)}`],
        relations: [],
      })));
    const outline = createWikiOutline(
      compilationPurpose,
      corpus,
      graph,
      documentInterpretations,
      PROJECT_ID,
    );
    expect(createWikiOutline(
      compilationPurpose,
      corpus,
      graph,
      [...documentInterpretations].reverse(),
      PROJECT_ID,
    )).toEqual(outline);
    expect(outline.blueprints.length).toBeLessThanOrEqual(97);
    const root = outline.blueprints.find((page) => page.pageId === outline.rootPageId);
    const groups = outline.blueprints.filter((page) => page.role === 'topic-group');
    const leaves = outline.blueprints.filter((page) => page.childPageIds.length === 0);
    expect(groups.length).toBeGreaterThan(0);
    expect(root?.childPageIds).toHaveLength(groups.length);
    expect(groups.every((group) => group.childPageIds.length > 0 &&
      group.childPageIds.length <= 12)).toBe(true);
    expect(leaves.every((leaf) => leaf.parentPageId !== outline.rootPageId)).toBe(true);
    expect(new Set(leaves.flatMap((leaf) => leaf.evidenceScope.sourceIds))).toEqual(
      new Set(sources.map((source) => source.sourceId)),
    );
  });

  it('supports read/diff/review before any activation authorization', () => {
    const beforePurpose = purpose();
    const beforeSnapshot = snapshot(beforePurpose);
    const beforeGraph = buildSparseRelationGraph(beforeSnapshot, PROJECT_ID);
    const beforeInterpretations = interpretations(beforeSnapshot);
    const before = createWikiOutline(
      beforePurpose,
      beforeSnapshot,
      beforeGraph,
      beforeInterpretations,
      PROJECT_ID,
    );
    const afterPurpose = purpose(' across revisions');
    const afterSnapshot = snapshot(afterPurpose);
    const afterGraph = buildSparseRelationGraph(afterSnapshot, PROJECT_ID);
    const after = createWikiOutline(
      afterPurpose,
      afterSnapshot,
      afterGraph,
      interpretations(afterSnapshot),
      PROJECT_ID,
    );
    expect(diffWikiOutlines(before, before, PROJECT_ID)).toMatchObject({
      identical: true,
      addedPageIds: [],
      removedPageIds: [],
      changedPageIds: [],
    });
    const changed = diffWikiOutlines(before, after, PROJECT_ID);
    expect(changed.identical).toBe(false);
    expect(changed.addedPageIds.length).toBeGreaterThan(0);
    expect(changed.removedPageIds.length).toBeGreaterThan(0);
    expect(reviewWikiOutline(
      before,
      'approved',
      ['human-outline-reviewed'],
      PROJECT_ID,
    )).toMatchObject({
      decision: 'approved',
      activationAuthorized: false,
      outlineDigest: before.outlineDigest,
    });
  });

  it('keeps the generic hierarchy core free of compatibility-adapter imports', async () => {
    const sources = await Promise.all([
      '../src/compiler/hierarchy/contracts.ts',
      '../src/compiler/hierarchy/interpretation.ts',
      '../src/compiler/hierarchy/outline.ts',
      '../src/compiler/hierarchy/planning.ts',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
    expect(sources.join('\n')).not.toMatch(/p2a|plan2agent/iu);
  });
});
