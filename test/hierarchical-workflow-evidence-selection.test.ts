import { describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_COMPILATION_POLICY,
  HierarchicalWorkflowEvidenceInsufficientError,
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
  sourceKind: SanitizedHierarchyEvidenceSourceV1['sourceKind'] = 'markdown',
): SanitizedHierarchyEvidenceSourceV1 {
  return Object.freeze({
    body,
    sourceId: `source-${digit.repeat(64)}`,
    sourceKind,
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
    expect(units.find((candidate) => candidate.kind === 'document')?.topicLabel)
      .toBe('Architecture 🧭');
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

  it('splits JSON list and table blocks at pointer boundaries without assigning one to the virtual document', () => {
    const listBody = [
      '1. "alpha component architecture"',
      '2. "beta retrieval pipeline"',
    ].join('\n');
    const listSource = Object.freeze({
      ...source('1', 'data/components.json', listBody, 'json'),
      jsonPointers: Object.freeze([
        Object.freeze({ jsonPointer: '/components/0', line: 1 }),
        Object.freeze({ jsonPointer: '/components/1', line: 2 }),
      ]),
    });
    const tableBody = [
      '| name |',
      '| --- |',
      '| alpha component |',
    ].join('\n');
    const tableSource = Object.freeze({
      ...source('2', 'data/rows.json', tableBody, 'json'),
      jsonPointers: Object.freeze([
        Object.freeze({ jsonPointer: '/rows', line: 1 }),
        Object.freeze({ jsonPointer: '/rows', line: 2 }),
        Object.freeze({ jsonPointer: '/rows/0', line: 3 }),
      ]),
    });

    const units = createSubstantiveHierarchyTextUnits(
      [listSource, tableSource],
      PROJECT_ID,
    );
    const listUnits = units.filter((unit) => unit.sourceId === listSource.sourceId);
    const tableUnits = units.filter((unit) => unit.sourceId === tableSource.sourceId);
    expect(listUnits.map((unit) => [unit.kind, unit.jsonPointer, unit.range])).toEqual([
      ['document', undefined, { endColumn: 1, endLine: 1, startColumn: 1, startLine: 1 }],
      ['list', '/components/0', { endColumn: 33, endLine: 1, startColumn: 1, startLine: 1 }],
      ['list', '/components/1', { endColumn: 28, endLine: 2, startColumn: 1, startLine: 2 }],
    ]);
    expect(tableUnits.map((unit) => [unit.kind, unit.jsonPointer, unit.range])).toEqual([
      ['document', undefined, { endColumn: 1, endLine: 1, startColumn: 1, startLine: 1 }],
      ['table', '/rows', { endColumn: 7, endLine: 2, startColumn: 1, startLine: 1 }],
      ['table', '/rows/0', { endColumn: 19, endLine: 3, startColumn: 1, startLine: 3 }],
    ]);
    expect(listUnits.slice(1).map((unit) => extractHierarchyTextUnitContent(
      listBody,
      unit.range,
      PROJECT_ID,
    ))).toEqual([
      '1. "alpha component architecture"',
      '2. "beta retrieval pipeline"',
    ]);
  });

  it('keeps JSON heading ranges aligned with heading content after pointer binding', () => {
    const body = [
      '## Attempts',
      'Status: finished with verified architecture evidence',
    ].join('\n');
    const jsonSource = Object.freeze({
      ...source('3', 'data/run.json', body, 'json'),
      jsonPointers: Object.freeze([
        Object.freeze({ jsonPointer: '', line: 1 }),
        Object.freeze({ jsonPointer: '/status', line: 2 }),
      ]),
    });

    const heading = createSubstantiveHierarchyTextUnits([jsonSource], PROJECT_ID)
      .find((unit) => unit.kind === 'heading');
    expect(heading?.range).toEqual({
      endColumn: 11,
      endLine: 1,
      startColumn: 4,
      startLine: 1,
    });
    if (heading === undefined) throw new Error('Missing JSON heading unit.');
    const extracted = extractHierarchyTextUnitContent(body, heading.range, PROJECT_ID);
    expect(extracted).toBe('Attempts');
    expect(heading.contentDigest).toBe(hierarchySha256(extracted));
  });

  it('keeps a custom multi-input JSON line bound to its actual file and raw range', () => {
    const body = 'Changed: src/projector/json-source-adapter.ts';
    const actualRange = Object.freeze({
      endColumn: 58,
      endLine: 7,
      startColumn: 18,
      startLine: 7,
    });
    const virtualSource = Object.freeze({
      ...source('3', 'adapter/combined.json', body, 'json'),
      jsonOrigins: Object.freeze([Object.freeze({
        jsonPointer: '/changedFiles/0',
        line: 1,
        range: actualRange,
        sourceRef: 'runs/attempt-a.json',
      })]),
    });

    const unit = createSubstantiveHierarchyTextUnits([virtualSource], PROJECT_ID)
      .find((candidate) => candidate.kind === 'paragraph');
    expect(unit).toMatchObject({
      jsonPointer: '/changedFiles/0',
      origin: {
        range: actualRange,
        sourceRef: 'runs/attempt-a.json',
      },
      sourceRef: 'adapter/combined.json',
    });
    expect(unit?.contentDigest).toBe(hierarchySha256(body));
  });

  it('selects heading-scoped units in document order before lexical fallback', () => {
    const sources = [
      source('1', 'docs/payments.md', '# Payments\n\n## Payment requests\n\n' +
        Array.from({ length: 10 }, (_, index) =>
          `Payment request evidence paragraph ${String(index + 1)} describes verified behavior.`)
          .join('\n\n') + '\n'),
      source('2', 'docs/fulfillment.md', '# Fulfillment\n\n## Delivery\n\n' +
        'Delivery evidence describes a separate operational workflow in detail.\n'),
    ];
    const value = hierarchy(sources);
    const payments = value.outline.blueprints.find((item) =>
      item.evidenceScope.sourceIds.length === 1 &&
      item.evidenceScope.sourceIds[0] === sources[0]?.sourceId);
    if (payments === undefined) throw new Error('Missing payment blueprint.');
    const paymentIds = selectRelevantHierarchyEvidenceUnitIds(
      payments, value.snapshot, sources, PROJECT_ID,
    );
    expect(selectRelevantHierarchyEvidenceUnitIds(
      payments, value.snapshot, sources, PROJECT_ID,
    )).toEqual(paymentIds);
    expect(paymentIds).toHaveLength(8);
    const selectedUnits = value.snapshot.textUnits.filter((unit) =>
      paymentIds.includes(unit.unitId));
    expect(selectedUnits.every((unit) => unit.sourceId === sources[0]?.sourceId)).toBe(true);
    expect(selectedUnits.every((unit) => unit.kind !== 'document')).toBe(true);
    expect(selectedUnits[0]?.kind).toBe('heading');
    expect(selectedUnits.every((unit) => unit.range.startLine >= 3)).toBe(true);
    expect(selectedContents(paymentIds, sources, value.snapshot)[0]).toBe('Payment requests');
  });

  it('uses the 64 total, 8-source, and 8-unit-per-source evidence budget', () => {
    const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a'];
    const sources = digits.map((digit, sourceIndex) => source(
      digit,
      `docs/service-${String(sourceIndex + 1)}.md`,
      `# Service ${String(sourceIndex + 1)}\n\n## Runtime behavior\n\n` +
        Array.from({ length: 12 }, (_, paragraphIndex) =>
          `Runtime behavior paragraph ${String(paragraphIndex + 1)} for service ` +
          `${String(sourceIndex + 1)} contains grounded operational evidence.`).join('\n\n') + '\n',
    ));
    const value = hierarchy(sources);
    const selections = value.outline.blueprints.map((blueprint) => ({
      blueprint,
      ids: selectRelevantHierarchyEvidenceUnitIds(
        blueprint, value.snapshot, sources, PROJECT_ID,
      ),
    }));
    const rootSelection = selections.find(({ blueprint }) =>
      blueprint.pageId === value.outline.rootPageId);
    expect(rootSelection?.ids).toHaveLength(64);
    const selectedRootUnits = value.snapshot.textUnits.filter((unit) =>
      rootSelection?.ids.includes(unit.unitId) === true);
    expect(new Set(selectedRootUnits.map((unit) => unit.sourceId)).size).toBe(8);
    const counts = new Map<string, number>();
    for (const unit of selectedRootUnits) {
      counts.set(unit.sourceId, (counts.get(unit.sourceId) ?? 0) + 1);
    }
    expect([...counts.values()].every((count) => count <= 8)).toBe(true);
    const average = selections.reduce((sum, item) => sum + item.ids.length, 0) /
      selections.length;
    expect(average).toBeGreaterThanOrEqual(12);
  });

  it('reports a dedicated value-free failure when primary evidence is insufficient', () => {
    const sources = [
      source('1', 'docs/security.md',
        '# Security\n\nSecurity evidence protects local persistence boundaries.\n'),
      source('2', 'docs/architecture.md',
        '# Architecture\n\nArchitecture evidence keeps compilation deterministic.\n'),
    ];
    const value = hierarchy(sources);
    const root = value.outline.blueprints.find((item) =>
      item.pageId === value.outline.rootPageId);
    if (root === undefined) throw new Error('Missing root blueprint.');
    const unrelated = Object.freeze({
      ...root,
      role: 'custom',
      title: 'Quantum orchard',
      minimumDistinctSources: 2,
    });
    let failure: unknown;
    try {
      selectRelevantHierarchyEvidenceUnitIds(
        unrelated, value.snapshot, sources, PROJECT_ID,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HierarchicalWorkflowEvidenceInsufficientError);
    expect(failure).toMatchObject({
      code: 'HIERARCHICAL_WORKFLOW_EVIDENCE_INSUFFICIENT',
      pageId: unrelated.pageId,
      pageTitle: 'Quantum orchard',
      primaryTokens: ['custom', 'orchard', 'quantum'],
    });
    expect(String(failure)).not.toContain(sources[0]?.body);
  });

  it('does not treat a role-bearing source path as substantive page evidence', () => {
    const sources = [
      source('1', 'iterations/local-cli-workflow/README.md',
        '# Local CLI workflow\n\nThis directory contains approved intake artifacts, exports, indexes, baselines, manifests, snapshots, templates, and historical records.\n'),
      source('2', 'docs/generation.md',
        '# Generation\n\nThe workflow keeps local Wiki generation inside architecture boundaries, accepts a cited candidate, and pauses for human review.\n'),
      source('3', 'docs/activation.md',
        '# Lifecycle\n\nA workflow uses security boundaries to protect local Wiki generation before activation updates the knowledge pointer.\n'),
    ];
    const value = hierarchy(sources);
    const root = value.outline.blueprints.find((item) =>
      item.pageId === value.outline.rootPageId);
    if (root === undefined) throw new Error('Missing root blueprint.');
    const workflow = Object.freeze({ ...root, role: 'workflow', title: 'Workflow' });
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

  it('retains the first two blocks below each H2 and splits code at declarations', () => {
    const markdownBody = '# Operations\n\n' + Array.from({ length: 5 }, (_, headingIndex) =>
      `## Topic ${String(headingIndex + 1)}\n\n` +
      Array.from({ length: 12 }, (_, paragraphIndex) =>
        `Representative topic ${String(headingIndex + 1)} paragraph ` +
        `${String(paragraphIndex + 1)} contains enough substantive evidence.`).join('\n\n'))
      .join('\n\n') + '\n';
    const markdown = source('1', 'docs/operations.md', markdownBody);
    const codeBody = [
      'export function alphaFeature() {',
      '  return "alpha feature evidence";',
      '}',
      'export function betaFeature() {',
      '  return "beta feature evidence";',
      '}',
      'export class GammaFeature {',
      '  readonly value = "gamma feature evidence";',
      '}',
    ].join('\n');
    const code = source('2', 'src/features.ts', codeBody, 'code');
    const units = createSubstantiveHierarchyTextUnits([markdown, code], PROJECT_ID);
    const markdownContents = selectedContents(
      units.filter((unit) => unit.sourceId === markdown.sourceId)
        .map((unit) => unit.unitId),
      [markdown, code],
      hierarchy([markdown, code]).snapshot,
    );
    for (let headingIndex = 1; headingIndex <= 5; headingIndex += 1) {
      expect(markdownContents).toContain(
        `Representative topic ${String(headingIndex)} paragraph 1 contains enough substantive evidence.`,
      );
      expect(markdownContents).toContain(
        `Representative topic ${String(headingIndex)} paragraph 2 contains enough substantive evidence.`,
      );
    }
    const codeUnits = units.filter((unit) =>
      unit.sourceId === code.sourceId && unit.kind === 'fenced-code');
    expect(codeUnits).toHaveLength(3);
    expect(codeUnits.map((unit) => extractHierarchyTextUnitContent(
      code.body, unit.range, PROJECT_ID,
    ))).toEqual([
      'export function alphaFeature() {\n  return "alpha feature evidence";\n}',
      'export function betaFeature() {\n  return "beta feature evidence";\n}',
      'export class GammaFeature {\n  readonly value = "gamma feature evidence";\n}',
    ]);
  });
});
