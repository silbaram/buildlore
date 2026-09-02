import { describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_COMPILATION_POLICY,
  buildSparseRelationGraph,
  createCompilationPurpose,
  createCorpusSnapshot,
  createDocumentInterpretation,
  createSubstantiveHierarchyTextUnits,
  createWikiOutline,
  extractHierarchyTextUnitContent,
  hierarchySha256,
  selectRelevantHierarchyEvidenceUnitIds,
  type SanitizedHierarchyEvidenceSourceV1,
} from '../src/compiler/index.js';

const PROJECT_ID = 'workflow-evidence';

function source(
  digit: string,
  sourceRef: string,
  body: string,
): SanitizedHierarchyEvidenceSourceV1 {
  return Object.freeze({
    body,
    sourceId: `source-${digit.repeat(64)}`,
    sourceKind: 'markdown',
    sourceRef,
    sourceRevision: hierarchySha256(body),
  });
}

function hierarchy(sources: readonly SanitizedHierarchyEvidenceSourceV1[]) {
  const purpose = createCompilationPurpose({
    audience: ['Maintainers'],
    excludedTopics: ['Hosted services'],
    goals: ['Explain the local BuildLore system'],
    keyQuestions: ['How do architecture and security boundaries protect local Wiki generation?'],
    outputLanguage: 'en',
    projectId: PROJECT_ID,
    requestedPageRoles: ['overview', 'architecture', 'workflow', 'security', 'operations'],
    scopeHints: ['Local evidence'],
  });
  const textUnits = createSubstantiveHierarchyTextUnits(sources, PROJECT_ID);
  const snapshot = createCorpusSnapshot({
    compilerContractDigest: hierarchySha256('compiler'),
    interpretationRulesDigest: hierarchySha256('interpretation'),
    policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
    profileDigest: hierarchySha256('profile'),
    projectId: PROJECT_ID,
    purposeDigest: purpose.purposeDigest,
    sanitizerPolicyDigest: hierarchySha256('sanitizer'),
    sourceManifestDigest: hierarchySha256('manifest'),
    sources: sources.map((item) => Object.freeze({
      sanitizedContentDigest: hierarchySha256(item.body),
      sourceId: item.sourceId,
      sourceRef: item.sourceRef,
      sourceRevision: item.sourceRevision,
    })),
    textUnits,
  });
  const graph = buildSparseRelationGraph(snapshot, PROJECT_ID);
  const interpretations = snapshot.sources.map((item) => createDocumentInterpretation({
    authority: 'supporting',
    basis: ['workflow-default'],
    confidenceBasisPoints: 10_000,
    lifecycle: 'current',
    projectId: PROJECT_ID,
    reasonCodes: ['workflow-default'],
    relations: [],
    role: 'topic',
    sourceId: item.sourceId,
    sourceRevision: item.sourceRevision,
    synthesisEligibility: 'eligible',
  }));
  return Object.freeze({
    outline: createWikiOutline(
      purpose,
      snapshot,
      graph,
      interpretations,
      PROJECT_ID,
    ),
    snapshot,
  });
}

function selectedContents(
  unitIds: readonly string[],
  sources: readonly SanitizedHierarchyEvidenceSourceV1[],
  snapshot: ReturnType<typeof hierarchy>['snapshot'],
): readonly string[] {
  const sourceById = new Map(sources.map((item) => [item.sourceId, item]));
  return snapshot.textUnits.filter((unit) => unitIds.includes(unit.unitId)).map((unit) => {
    const selectedSource = sourceById.get(unit.sourceId);
    if (selectedSource === undefined) throw new Error('Missing source.');
    return extractHierarchyTextUnitContent(selectedSource.body, unit.range, PROJECT_ID);
  });
}

describe('hierarchical workflow evidence selection', () => {
  it('extracts exact Unicode-scalar body ranges and rejects heading-only sources', () => {
    const body = '# Architecture 🧭\n\n' +
      'The local architecture preserves sanitizer-first evidence boundaries 🚀.\n';
    const sources = [source('1', 'docs/architecture.md', body)];
    const units = createSubstantiveHierarchyTextUnits(sources, PROJECT_ID);
    expect(units).toHaveLength(2);
    const unit = units.find((candidate) => candidate.kind === 'paragraph');
    if (unit === undefined) throw new Error('Missing unit.');
    expect(unit.range).toEqual({
      endColumn: [...'The local architecture preserves sanitizer-first evidence boundaries 🚀.'].length,
      endLine: 3,
      startColumn: 1,
      startLine: 3,
    });
    expect(extractHierarchyTextUnitContent(body, unit.range, PROJECT_ID))
      .toBe('The local architecture preserves sanitizer-first evidence boundaries 🚀.');
    expect(() => createSubstantiveHierarchyTextUnits([
      source('2', 'docs/title-only.md', '# Title only\n'),
    ], PROJECT_ID)).toThrowError('Hierarchical corpus contract is invalid.');
  });

  it('selects deterministic page-relevant units from the required distinct sources', () => {
    const sources = [
      source('1', 'docs/architecture-boundary.md',
        '# Architecture\n\nThe architecture keeps projector sanitizer compiler boundaries explicit.\n'),
      source('2', 'docs/architecture-storage.md',
        '# Storage\n\nLocal architecture stores canonical knowledge in project-confined Git history.\n'),
      source('3', 'docs/security-policy.md',
        '# Secrets\n\nSecurity rejects suspected secrets before compilation or persistence.\n'),
      source('4', 'docs/security-isolation.md',
        '# Isolation\n\nProject security prevents cross-project reads and unauthorized Wiki writes.\n'),
      source('5', 'docs/local-runbook.md',
        '# Runtime\n\nEach operation은 local state를 확인하고 명시적 승인 전에는 중단된다.\n'),
      source('6', 'docs/compiler-lifecycle.md',
        '# Lifecycle\n\nCompilerOperationError keeps operational recovery bounded and reviewable.\n'),
    ];
    const value = hierarchy(sources);
    const architecture = value.outline.blueprints.find((item) => item.role === 'architecture');
    const security = value.outline.blueprints.find((item) => item.role === 'security');
    const operations = value.outline.blueprints.find((item) => item.role === 'operations');
    if (architecture === undefined || security === undefined || operations === undefined) {
      throw new Error('Missing blueprint.');
    }
    const architectureIds = selectRelevantHierarchyEvidenceUnitIds(
      architecture,
      value.snapshot,
      sources,
      PROJECT_ID,
    );
    const securityIds = selectRelevantHierarchyEvidenceUnitIds(
      security,
      value.snapshot,
      sources,
      PROJECT_ID,
    );
    const operationsIds = selectRelevantHierarchyEvidenceUnitIds(
      operations,
      value.snapshot,
      sources,
      PROJECT_ID,
    );
    expect(selectRelevantHierarchyEvidenceUnitIds(
      architecture,
      value.snapshot,
      sources,
      PROJECT_ID,
    )).toEqual(architectureIds);
    expect(selectedContents(architectureIds, sources, value.snapshot)
      .every((content) => /architecture/u.test(content))).toBe(true);
    expect(selectedContents(securityIds, sources, value.snapshot)
      .every((content) => /security/iu.test(content))).toBe(true);
    expect(selectedContents(operationsIds, sources, value.snapshot)
      .every((content) => /operat/iu.test(content))).toBe(true);
    for (const [blueprint, ids] of [
      [architecture, architectureIds],
      [security, securityIds],
      [operations, operationsIds],
    ] as const) {
      const sourceIds = value.snapshot.textUnits.filter((unit) => ids.includes(unit.unitId))
        .map((unit) => unit.sourceId);
      expect(new Set(sourceIds).size).toBe(blueprint.minimumDistinctSources);
    }
  });

  it('fails closed when a page lacks enough distinct primary evidence sources', () => {
    const sources = [
      source('1', 'docs/security-only.md',
        'Security rejects unsafe evidence before any local persistence occurs.\n'),
      source('2', 'docs/architecture.md',
        'Architecture keeps compilation boundaries deterministic and reviewable.\n'),
    ];
    const value = hierarchy(sources);
    const security = value.outline.blueprints.find((item) => item.role === 'security');
    if (security === undefined) throw new Error('Missing security blueprint.');
    expect(security.minimumDistinctSources).toBe(2);
    expect(() => selectRelevantHierarchyEvidenceUnitIds(
      security,
      value.snapshot,
      sources,
      PROJECT_ID,
    )).toThrowError('Hierarchical corpus contract is invalid.');
  });

  it('does not treat a role-bearing source path as substantive page evidence', () => {
    const sources = [
      source('1', 'iterations/local-cli-workflow/README.md',
        '# Local CLI workflow\n\nThis workflow directory contains numerous approved intake artifacts, exports, indexes, baselines, manifests, snapshots, templates, and historical records for the iteration.\n'),
      source('2', 'docs/generation.md',
        '# Generation\n\nThe workflow keeps local Wiki generation inside architecture boundaries, accepts a cited candidate, and pauses for human review.\n'),
      source('3', 'docs/activation.md',
        '# Lifecycle\n\nA workflow uses security boundaries to protect local Wiki generation before activation updates the knowledge pointer.\n'),
    ];
    const value = hierarchy(sources);
    const workflow = value.outline.blueprints.find((item) => item.role === 'workflow');
    if (workflow === undefined) throw new Error('Missing workflow blueprint.');
    const ids = selectRelevantHierarchyEvidenceUnitIds(
      workflow,
      value.snapshot,
      sources,
      PROJECT_ID,
    );
    const selected = selectedContents(ids, sources, value.snapshot);
    expect(selected).toHaveLength(2);
    expect(selected.every((content) => /workflow/iu.test(content))).toBe(true);
    expect(selected).not.toContain(
      'This workflow directory contains numerous approved intake artifacts, exports, indexes, baselines, manifests, snapshots, templates, and historical records for the iteration.',
    );
  });
});
