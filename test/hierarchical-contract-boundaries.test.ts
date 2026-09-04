import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_PACK_SCHEMA_VERSION,
  HIERARCHICAL_COMPILATION_LIMITS,
  HIERARCHICAL_COMPILATION_POLICY,
  PAGE_BLUEPRINT_SCHEMA_VERSION,
  SPARSE_RELATION_GRAPH_SCHEMA_VERSION,
  HierarchyContractError,
  createCompilationPurpose,
  createCorpusSnapshot,
  createCurrentSessionGenerationRequest,
  createDocumentInterpretation,
  createEvidencePack,
  createTextUnit,
  digestHierarchyValue,
  hierarchySha256,
  parseHierarchicalCompilationPolicy,
  parseSparseRelationGraph,
  type CorpusSnapshotSourceV1,
  type EvidencePackV1,
  type EvidenceUnitV1,
  type PageBlueprintV1,
  type SanitizedEvidenceSourceV1,
  type TextUnitV1,
} from '../src/compiler/index.js';
import {
  SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
  sourceRetrievalMeaningFromDescriptor,
  validatePortableSourceRef,
} from '../src/projector/index.js';
import { inspectPreparedSource, issuePreparedSource } from '../src/sanitizer/approval.js';
import { SANITIZER_RULES_VERSION } from '../src/sanitizer/index.js';
import {
  SESSION_COMPILE_LIMITS,
  finalizeSessionCompilePlan,
} from '../src/compiler/session/contracts.js';
import { digestSessionValue, sessionSha256 } from '../src/compiler/session/canonical.js';
import { SessionCompileError } from '../src/compiler/session/errors.js';
import {
  SESSION_COMPILE_ALGORITHM_VERSION,
  SESSION_COMPILE_PLAN_SCHEMA_VERSION,
  type SessionPlannedSource,
} from '../src/compiler/session/types.js';

const PROJECT_ID = 'boundary-project';
const DIGEST = hierarchySha256('boundary');
const PAGE_ID = `page-${'a'.repeat(64)}`;

function source(seed: string): CorpusSnapshotSourceV1 {
  return Object.freeze({
    sourceId: `source-${hierarchySha256(seed).slice('sha256:'.length)}`,
    sourceRevision: DIGEST,
    sourceRef: `docs/${seed}.md`,
    sanitizedContentDigest: DIGEST,
  });
}

function unitFor(
  snapshotSource: CorpusSnapshotSourceV1,
  topicLabel = 'Boundary',
): TextUnitV1 {
  return createTextUnit({
    projectId: PROJECT_ID,
    sourceId: snapshotSource.sourceId,
    sourceRevision: snapshotSource.sourceRevision,
    sourceRef: snapshotSource.sourceRef,
    kind: 'heading',
    ordinal: 0,
    range: Object.freeze({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }),
    contentDigest: hierarchySha256(topicLabel),
    topicLabel,
  });
}

function snapshotInput(
  sources: readonly CorpusSnapshotSourceV1[],
  textUnits: readonly TextUnitV1[],
): Parameters<typeof createCorpusSnapshot>[0] {
  return Object.freeze({
    projectId: PROJECT_ID,
    purposeDigest: DIGEST,
    interpretationRulesDigest: DIGEST,
    profileDigest: DIGEST,
    compilerContractDigest: DIGEST,
    sanitizerPolicyDigest: DIGEST,
    sourceManifestDigest: DIGEST,
    policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
    sources,
    textUnits,
  });
}

function blueprintFor(snapshotDigest: typeof DIGEST, sourceId: string): PageBlueprintV1 {
  return Object.freeze({
    schemaVersion: PAGE_BLUEPRINT_SCHEMA_VERSION,
    projectId: PROJECT_ID,
    pageId: PAGE_ID,
    stableKey: 'boundary',
    role: 'overview',
    title: 'Boundary',
    parentPageId: null,
    childPageIds: Object.freeze([]),
    relatedPageIds: Object.freeze([]),
    keyQuestions: Object.freeze([]),
    requiredSections: Object.freeze([]),
    evidenceScope: Object.freeze({
      snapshotDigest,
      taskSetDigest: DIGEST,
      relationSetDigest: DIGEST,
      allowedUnitKinds: Object.freeze(['heading'] as const),
      sourceIds: Object.freeze([sourceId]),
      preferredUnitIds: Object.freeze([]),
    }),
    minimumDistinctSources: 1,
    generationOrder: 0,
    blueprintDigest: DIGEST,
  });
}

function observedOverLimitArray<T>(
  maximum: number,
  first: T,
  observe: () => void,
): readonly T[] {
  const values = new Array<T>(maximum + 1);
  Object.defineProperty(values, 0, {
    enumerable: true,
    get: () => {
      observe();
      return first;
    },
  });
  return Object.freeze(values);
}

describe('hierarchical contract boundaries', () => {
  it('rejects source and unit cardinality before item reads, sorting, or hashing', () => {
    const firstSource = source('first');
    const firstUnit = unitFor(firstSource);
    let sourceReads = 0;
    const tooManySources = observedOverLimitArray(
      HIERARCHICAL_COMPILATION_LIMITS.maxSources,
      firstSource,
      () => { sourceReads += 1; },
    );
    expect(() => createCorpusSnapshot(snapshotInput(tooManySources, [firstUnit])))
      .toThrow(HierarchyContractError);
    expect(sourceReads).toBe(0);

    let unitReads = 0;
    const tooManyUnits = observedOverLimitArray(
      HIERARCHICAL_COMPILATION_LIMITS.maxTasks,
      firstUnit,
      () => { unitReads += 1; },
    );
    expect(() => createCorpusSnapshot(snapshotInput([firstSource], tooManyUnits)))
      .toThrow(HierarchyContractError);
    expect(unitReads).toBe(0);
  });

  it('canonicalizes a snapshot without mutating its deeply frozen input arrays', () => {
    const firstSource = source('a');
    const secondSource = source('b');
    const firstUnit = unitFor(firstSource, 'First');
    const secondUnit = unitFor(secondSource, 'Second');
    const inputSources = Object.freeze([secondSource, firstSource]);
    const inputUnits = Object.freeze([secondUnit, firstUnit]);
    const input = snapshotInput(inputSources, inputUnits);

    const snapshot = createCorpusSnapshot(input);

    expect(input.sources).toEqual([secondSource, firstSource]);
    expect(input.textUnits).toEqual([secondUnit, firstUnit]);
    expect(snapshot.sources.map((item) => item.sourceId)).toEqual(
      [firstSource.sourceId, secondSource.sourceId].sort(),
    );
    expect(snapshot.textUnits.map((item) => item.sourceId)).toEqual(
      [firstUnit.sourceId, secondUnit.sourceId].sort(),
    );
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(inputSources)).toBe(true);
    expect(Object.isFrozen(inputUnits)).toBe(true);
  });

  it('binds explicit retrieval meaning and its origin into the snapshot digest', () => {
    const legacy = source('meaning');
    const withMeaning: CorpusSnapshotSourceV1 = Object.freeze({
      ...legacy,
      retrievalMeaning: Object.freeze({
        authority: 'canonical',
        evidenceKind: 'architecture',
        iterationGroup: null,
        lifecycle: 'current',
        revisionOrdinal: 3,
        schemaVersion: SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
        supersededBySourceRefs: Object.freeze([]),
        supersedesSourceRefs: Object.freeze([]),
        topicGroup: 'project-structure',
      }),
      retrievalMeaningOrigin: 'manifest',
    });
    const snapshot = createCorpusSnapshot(snapshotInput(
      Object.freeze([withMeaning]),
      Object.freeze([unitFor(withMeaning)]),
    ));

    expect(snapshot.sources[0]?.retrievalMeaning).toEqual(withMeaning.retrievalMeaning);
    expect(snapshot.sources[0]?.retrievalMeaningOrigin).toBe('manifest');
    expect(snapshot.snapshotDigest).not.toBe(createCorpusSnapshot(snapshotInput(
      Object.freeze([legacy]),
      Object.freeze([unitFor(legacy)]),
    )).snapshotDigest);
  });

  it('fails closed on inconsistent and cyclic supersession metadata', () => {
    const bind = (
      base: CorpusSnapshotSourceV1,
      supersedesSourceRefs: readonly string[],
      supersededBySourceRefs: readonly string[],
      lifecycle: 'current' | 'superseded' = 'current',
      revisionOrdinal = 1,
    ): CorpusSnapshotSourceV1 => Object.freeze({
      ...base,
      retrievalMeaning: Object.freeze({
        authority: 'canonical' as const,
        evidenceKind: 'decision' as const,
        iterationGroup: null,
        lifecycle,
        revisionOrdinal,
        schemaVersion: SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
        supersededBySourceRefs: Object.freeze([...supersededBySourceRefs].sort()),
        supersedesSourceRefs: Object.freeze([...supersedesSourceRefs].sort()),
        topicGroup: 'supersession',
      }),
      retrievalMeaningOrigin: 'manifest',
    });
    const first = source('cycle-a');
    const second = source('cycle-b');
    const third = source('cycle-c');
    const inconsistent = [
      bind(first, [second.sourceRef], []),
      bind(second, [], []),
    ];
    expect(() => createCorpusSnapshot(snapshotInput(
      inconsistent,
      inconsistent.map((item) => unitFor(item)),
    ))).toThrow(HierarchyContractError);

    const cycle = [
      bind(first, [second.sourceRef], [third.sourceRef]),
      bind(second, [third.sourceRef], [first.sourceRef]),
      bind(third, [first.sourceRef], [second.sourceRef]),
    ];
    expect(() => createCorpusSnapshot(snapshotInput(
      cycle,
      cycle.map((item) => unitFor(item)),
    ))).toThrow(HierarchyContractError);

    const valid = [
      bind(first, [second.sourceRef], [], 'current', 2),
      bind(second, [], [first.sourceRef], 'superseded', 1),
    ];
    expect(() => createCorpusSnapshot(snapshotInput(
      valid,
      valid.map((item) => unitFor(item)),
    ))).not.toThrow();

    const unordered = [
      bind(first, [second.sourceRef], [], 'current', 1),
      bind(second, [], [first.sourceRef], 'superseded', 1),
    ];
    expect(() => createCorpusSnapshot(snapshotInput(
      unordered,
      unordered.map((item) => unitFor(item)),
    ))).toThrow(HierarchyContractError);

    const lifecycleConflict = [
      bind(first, [second.sourceRef], [], 'current', 2),
      bind(second, [], [first.sourceRef], 'current', 1),
    ];
    expect(() => createCorpusSnapshot(snapshotInput(
      lifecycleConflict,
      lifecycleConflict.map((item) => unitFor(item)),
    ))).toThrow(HierarchyContractError);
  });

  it('rejects interpretation collection bounds before spread, map, or sort reads', () => {
    const snapshotSource = source('interpretation');
    const base = Object.freeze({
      projectId: PROJECT_ID,
      sourceId: snapshotSource.sourceId,
      sourceRevision: snapshotSource.sourceRevision,
      role: 'reference',
      lifecycle: 'current' as const,
      authority: 'canonical' as const,
      synthesisEligibility: 'eligible' as const,
      confidenceBasisPoints: 10_000,
    });

    let basisReads = 0;
    const oversizedBasis = observedOverLimitArray(64, 'basis', () => { basisReads += 1; });
    expect(() => createDocumentInterpretation({
      ...base,
      basis: oversizedBasis,
      reasonCodes: Object.freeze([]),
      relations: Object.freeze([]),
    })).toThrow(HierarchyContractError);
    expect(basisReads).toBe(0);

    let reasonReads = 0;
    const oversizedReasons = observedOverLimitArray(64, 'reason', () => { reasonReads += 1; });
    expect(() => createDocumentInterpretation({
      ...base,
      basis: Object.freeze(['explicit-metadata']),
      reasonCodes: oversizedReasons,
      relations: Object.freeze([]),
    })).toThrow(HierarchyContractError);
    expect(reasonReads).toBe(0);

    let relationReads = 0;
    const oversizedRelations = observedOverLimitArray(64, Object.freeze({
      kind: 'related' as const,
      sourceId: source('related').sourceId,
    }), () => { relationReads += 1; });
    expect(() => createDocumentInterpretation({
      ...base,
      basis: Object.freeze(['explicit-metadata']),
      reasonCodes: Object.freeze([]),
      relations: oversizedRelations,
    })).toThrow(HierarchyContractError);
    expect(relationReads).toBe(0);
  });

  it('uses safe-integer ranges and Unicode scalar string lengths in runtime and schema', async () => {
    const snapshotSource = source('unicode');
    const maximumScalarLabel = '😀'.repeat(1_000);
    const maximumRange = createTextUnit({
      projectId: PROJECT_ID,
      sourceId: snapshotSource.sourceId,
      sourceRevision: snapshotSource.sourceRevision,
      sourceRef: snapshotSource.sourceRef,
      kind: 'heading',
      ordinal: 0,
      range: {
        startLine: Number.MAX_SAFE_INTEGER,
        startColumn: Number.MAX_SAFE_INTEGER,
        endLine: Number.MAX_SAFE_INTEGER,
        endColumn: Number.MAX_SAFE_INTEGER,
      },
      contentDigest: hierarchySha256(maximumScalarLabel),
      topicLabel: maximumScalarLabel,
    });
    expect([...maximumRange.topicLabel ?? '']).toHaveLength(1_000);
    expect(() => unitFor(snapshotSource, '😀'.repeat(1_001)))
      .toThrow(HierarchyContractError);
    expect(() => createTextUnit({
      projectId: PROJECT_ID,
      sourceId: snapshotSource.sourceId,
      sourceRevision: snapshotSource.sourceRevision,
      sourceRef: snapshotSource.sourceRef,
      kind: 'heading',
      ordinal: 0,
      range: {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: Number.MAX_SAFE_INTEGER + 1,
      },
      contentDigest: DIGEST,
    })).toThrow(HierarchyContractError);

    const schema = JSON.parse(await readFile(
      new URL('../schemas/hierarchical-corpus.schema.json', import.meta.url),
      'utf8',
    )) as {
      readonly 'x-buildlore-stringLengthUnit': string;
      readonly 'x-buildlore-digestSerialization': Readonly<Record<string, unknown>>;
      readonly $defs: Readonly<Record<string, unknown>>;
    };
    const range = schema.$defs.range as {
      readonly properties: Readonly<Record<string, { readonly maximum: number }>>;
    };
    expect(schema['x-buildlore-stringLengthUnit']).toBe('unicode-scalar-values');
    expect(schema['x-buildlore-digestSerialization']).toEqual({
      hashAlgorithm: 'sha-256',
      inputEncoding: 'utf-8',
      jsonObjectMemberOrder: 'schema-properties-order',
      arrayElementOrder: 'input-order-unless-field-canonical-order-is-declared',
      indentSpaces: 2,
      lineEnding: 'lf',
      terminalLf: true,
      stringEscaping: {
        standard: 'rfc-8259',
        quote: 'backslash-quote',
        reverseSolidus: 'double-reverse-solidus',
        shortControlEscapes: [
          'U+0008=\\b', 'U+0009=\\t', 'U+000A=\\n', 'U+000C=\\f', 'U+000D=\\r',
        ],
        otherC0Controls: 'lowercase-u00xx',
      },
      nonAscii: 'literal-unescaped-utf-8',
      solidus: 'literal-unescaped',
      allOtherCharacters: 'literal-unescaped',
      safeIntegerRepresentation:
        'base-10-no-leading-zero-no-decimal-no-exponent-negative-zero-as-zero',
    });
    expect(Object.keys(range.properties)).toEqual([
      'endColumn', 'endLine', 'startColumn', 'startLine',
    ]);
    expect(Object.values(range.properties).map((property) => property.maximum))
      .toEqual(Array.from({ length: 4 }, () => Number.MAX_SAFE_INTEGER));
  });

  it('keeps JSON Schema source, project, and printable-text constraints aligned with runtime', async () => {
    const schema = JSON.parse(await readFile(
      new URL('../schemas/hierarchical-corpus.schema.json', import.meta.url),
      'utf8',
    )) as {
      readonly $defs: Readonly<Record<string, unknown>>;
    };
    const projectId = schema.$defs.projectId as {
      readonly pattern: string;
      readonly not: { readonly enum: readonly string[] };
    };
    const sourceRef = schema.$defs.sourceRef as {
      readonly maxLength: number;
      readonly pattern: string;
      readonly 'x-buildlore-maxSegments': number;
      readonly 'x-buildlore-normalization': string;
    };
    const purposeText = schema.$defs.purposeText as {
      readonly pattern: string;
      readonly 'x-buildlore-normalization': string;
    };
    const textUnit = schema.$defs.textUnit as {
      readonly properties: {
        readonly topicLabel: {
          readonly oneOf: readonly [{
            readonly pattern: string;
            readonly 'x-buildlore-normalization': string;
          }, { readonly type: 'null' }];
        };
      };
    };
    const projectIdPattern = new RegExp(projectId.pattern, 'u');
    const sourceRefPattern = new RegExp(sourceRef.pattern, 'u');
    const purposeTextPattern = new RegExp(purposeText.pattern, 'u');
    const topicLabelPattern = new RegExp(textUnit.properties.topicLabel.oneOf[0].pattern, 'u');
    const unicodeSource = source('unicode-source-ref');
    const unicodeUnit = createTextUnit({
      projectId: PROJECT_ID,
      sourceId: unicodeSource.sourceId,
      sourceRevision: unicodeSource.sourceRevision,
      sourceRef: '문서/설계.md',
      kind: 'heading',
      ordinal: 0,
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
      contentDigest: hierarchySha256('설계'),
      topicLabel: '설계',
    });
    expect(sourceRefPattern.test(unicodeUnit.sourceRef)).toBe(true);
    const maximumScalarSourceRef = `docs/${'😀'.repeat(504)}.md`;
    expect([...maximumScalarSourceRef]).toHaveLength(512);
    expect(validatePortableSourceRef(maximumScalarSourceRef)).toBe(maximumScalarSourceRef);
    expect(sourceRefPattern.test(maximumScalarSourceRef)).toBe(true);
    expect(() => validatePortableSourceRef(`docs/${'😀'.repeat(505)}.md`)).toThrow();

    const sixtyFourSegments = Array.from({ length: 64 }, (_, index) => `s${String(index)}`)
      .join('/');
    const sixtyFiveSegments = `${sixtyFourSegments}/overflow`;
    expect(validatePortableSourceRef(sixtyFourSegments)).toBe(sixtyFourSegments);
    expect(sourceRefPattern.test(sixtyFourSegments)).toBe(true);
    expect(() => validatePortableSourceRef(sixtyFiveSegments)).toThrow();
    expect(sourceRefPattern.test(sixtyFiveSegments)).toBe(false);

    const nfdSourceRef = 'docs/e\u0301.md';
    expect(() => validatePortableSourceRef(nfdSourceRef)).toThrow();
    expect(sourceRef['x-buildlore-normalization']).toBe('NFC');
    expect(sourceRef['x-buildlore-maxSegments']).toBe(64);
    expect(sourceRef.maxLength).toBe(512);

    for (const reservedProjectId of ['knowledge', 'manifest', 'projects', 'shared']) {
      expect(() => createCompilationPurpose({
        projectId: reservedProjectId,
        audience: ['Maintainers'],
        goals: ['Document boundaries'],
        keyQuestions: ['What is bounded?'],
        scopeHints: [],
        excludedTopics: [],
        outputLanguage: 'en',
        requestedPageRoles: ['overview'],
      })).toThrow(HierarchyContractError);
      expect(projectIdPattern.test(reservedProjectId)).toBe(true);
      expect(projectId.not.enum).toContain(reservedProjectId);
    }

    expect(() => createCompilationPurpose({
      projectId: PROJECT_ID,
      audience: ['Maintainers'],
      goals: ['unsafe\u0000goal'],
      keyQuestions: ['What is bounded?'],
      scopeHints: [],
      excludedTopics: [],
      outputLanguage: 'en',
      requestedPageRoles: ['overview'],
    })).toThrow(HierarchyContractError);
    expect(purposeTextPattern.test('unsafe\u0000goal')).toBe(false);
    expect(() => createCompilationPurpose({
      projectId: PROJECT_ID,
      audience: ['Maintainers'],
      goals: ['e\u0301'],
      keyQuestions: ['What is bounded?'],
      scopeHints: [],
      excludedTopics: [],
      outputLanguage: 'en',
      requestedPageRoles: ['overview'],
    })).toThrow(HierarchyContractError);
    expect(() => unitFor(unicodeSource, 'unsafe\u0000topic')).toThrow(HierarchyContractError);
    expect(topicLabelPattern.test('unsafe\u0000topic')).toBe(false);
    expect(() => unitFor(unicodeSource, 'e\u0301')).toThrow(HierarchyContractError);
    expect(textUnit.properties.topicLabel.oneOf[0]['x-buildlore-normalization']).toBe('NFC');
    expect(purposeText['x-buildlore-normalization']).toBe('NFC');

    const rejectedSourceRefs = [
      '/absolute.md',
      '../traversal.md',
      'docs\\backslash.md',
      'docs/%2e%2e.md',
      'docs/.git/config',
      'knowledge/page.md',
      'docs/control\u0000.md',
      'docs/format\u200b.md',
      'docs/API_KEY.md',
      'docs/Password.txt',
    ];
    for (const rejectedSourceRef of rejectedSourceRefs) {
      expect(() => createTextUnit({
        ...unicodeUnit,
        sourceRef: rejectedSourceRef,
      })).toThrow();
      expect(sourceRefPattern.test(rejectedSourceRef)).toBe(false);
    }
  });

  it('pins every compilation limit into one golden policy digest', () => {
    const referencePolicyBytes = [
      '{',
      '  "schemaVersion": "buildlore.hierarchical-compilation-policy.v1",',
      '  "limits": {',
      '    "maxClusterMembers": 256,',
      '    "maxEvidenceBytes": 262144,',
      '    "maxEvidenceSourcesPerPage": 8,',
      '    "maxEvidenceUnits": 64,',
      '    "maxEvidenceUnitsPerSource": 8,',
      '    "maxPartitionTasks": 256,',
      '    "maxPlanBytes": 33554432,',
      '    "maxRelationCandidatesPerTask": 32,',
      '    "maxSourceBytes": 524288,',
      '    "maxSources": 4096,',
      '    "maxTasks": 8192',
      '  }',
      '}',
      '',
    ].join('\n');
    const referenceDigest = `sha256:${createHash('sha256')
      .update(Buffer.from(referencePolicyBytes, 'utf8')).digest('hex')}`;
    expect(referenceDigest).toBe(
      'sha256:cea5fe21b26f87798cef265d52152acb6aa9a19e0c541bc2e8076b063981edb2',
    );
    expect(HIERARCHICAL_COMPILATION_POLICY.policyDigest).toBe(
      referenceDigest,
    );
    const escapingReferenceValue = Object.freeze({
      unicode: '설계',
      escaped: 'quote=" reverse-solidus=\\ solidus=/ html=<>& newline=\n tab=\t control=\u0001',
      safeIntegers: Object.freeze([-Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER]),
    });
    const escapingReferenceBytes = [
      '{',
      '  "unicode": "설계",',
      '  "escaped": "quote=\\" reverse-solidus=\\\\ solidus=/ html=<>& newline=\\n tab=\\t control=\\u0001",',
      '  "safeIntegers": [',
      '    -9007199254740991,',
      '    0,',
      '    9007199254740991',
      '  ]',
      '}',
      '',
    ].join('\n');
    const escapingReferenceDigest = `sha256:${createHash('sha256')
      .update(Buffer.from(escapingReferenceBytes, 'utf8')).digest('hex')}`;
    expect(escapingReferenceDigest).toBe(
      'sha256:c034e75126377263419ad7241b8ff1cb5bba3847a0c440ed2dda1531a18f71bb',
    );
    expect(digestHierarchyValue(escapingReferenceValue)).toBe(escapingReferenceDigest);
    expect(Object.keys(HIERARCHICAL_COMPILATION_POLICY.limits)).toEqual([
      'maxClusterMembers',
      'maxEvidenceBytes',
      'maxEvidenceSourcesPerPage',
      'maxEvidenceUnits',
      'maxEvidenceUnitsPerSource',
      'maxPartitionTasks',
      'maxPlanBytes',
      'maxRelationCandidatesPerTask',
      'maxSourceBytes',
      'maxSources',
      'maxTasks',
    ]);
    for (const key of Object.keys(HIERARCHICAL_COMPILATION_POLICY.limits)) {
      expect(() => parseHierarchicalCompilationPolicy({
        ...HIERARCHICAL_COMPILATION_POLICY,
        limits: {
          ...HIERARCHICAL_COMPILATION_POLICY.limits,
          [key]: HIERARCHICAL_COMPILATION_POLICY.limits[
            key as keyof typeof HIERARCHICAL_COMPILATION_POLICY.limits
          ] + 1,
        },
      })).toThrow(HierarchyContractError);
    }
  });

  it('rejects maxEvidenceBytes plus one from a sanitizer-backed bounded source', () => {
    const evidenceBody = `${'가'.repeat(87_381)}é`;
    expect(Buffer.byteLength(evidenceBody, 'utf8')).toBe(
      HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceBytes + 1,
    );
    expect(Buffer.byteLength(evidenceBody, 'utf8')).toBeLessThanOrEqual(
      HIERARCHICAL_COMPILATION_LIMITS.maxSourceBytes,
    );
    const snapshotSource = Object.freeze({
      ...source('evidence-bytes'),
      sanitizedContentDigest: hierarchySha256(evidenceBody),
    });
    const evidenceUnit = createTextUnit({
      projectId: PROJECT_ID,
      sourceId: snapshotSource.sourceId,
      sourceRevision: snapshotSource.sourceRevision,
      sourceRef: snapshotSource.sourceRef,
      kind: 'heading',
      ordinal: 0,
      range: Object.freeze({
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: [...evidenceBody].length,
      }),
      contentDigest: hierarchySha256(evidenceBody),
    });
    const snapshot = createCorpusSnapshot(snapshotInput(
      Object.freeze([snapshotSource]),
      Object.freeze([evidenceUnit]),
    ));
    const preparedSource = issuePreparedSource({
      approvedBody: evidenceBody,
      approvedBodyDigest: snapshotSource.sanitizedContentDigest,
      classification: 'internal',
      inputBodyDigest: snapshotSource.sanitizedContentDigest,
      policyDigest: snapshot.sanitizerPolicyDigest,
      projectId: PROJECT_ID,
      rulesVersion: SANITIZER_RULES_VERSION,
      source: snapshotSource.sourceRef,
      sourceKind: 'markdown',
      sourceRevisionOrContentSha256: snapshotSource.sourceRevision,
      untrustedData: false,
    });
    const sanitizedSource: SanitizedEvidenceSourceV1 = Object.freeze({
      sourceId: snapshotSource.sourceId,
      sourceRevision: snapshotSource.sourceRevision,
      sourceRef: snapshotSource.sourceRef,
      preparedSource,
    });
    const sources = Object.freeze([sanitizedSource]);
    const selectedUnitIds = Object.freeze([evidenceUnit.unitId]);
    const input = Object.freeze({
      blueprint: blueprintFor(snapshot.snapshotDigest, snapshotSource.sourceId),
      snapshot,
      sources,
      selectedUnitIds,
      conflicts: Object.freeze([]),
      gaps: Object.freeze([]),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => createEvidencePack(input, PROJECT_ID)).toThrow(HierarchyContractError);
    }
    expect(input.sources).toBe(sources);
    expect(input.selectedUnitIds).toBe(selectedUnitIds);
    expect(input.sources[0]).toBe(sanitizedSource);
    expect(sanitizedSource.preparedSource).toBe(preparedSource);
    expect(inspectPreparedSource(preparedSource)).not.toBeNull();
    expect(selectedUnitIds).toEqual([evidenceUnit.unitId]);
    expect([...evidenceBody].length).toBeLessThan(
      HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceBytes,
    );
  });

  it('fails public task, plan, and evidence validators without consuming bounded items', () => {
    const firstSource = source('validator');
    const firstUnit = unitFor(firstSource);
    let taskReads = 0;
    const tooManyTasks = observedOverLimitArray(
      HIERARCHICAL_COMPILATION_LIMITS.maxTasks,
      Object.freeze({}),
      () => { taskReads += 1; },
    );
    const graph = Object.freeze({
      schemaVersion: SPARSE_RELATION_GRAPH_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      snapshotDigest: DIGEST,
      policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
      tasks: tooManyTasks,
      relations: Object.freeze([]),
      taskSetDigest: DIGEST,
      relationSetDigest: DIGEST,
      graphDigest: DIGEST,
    });
    expect(() => parseSparseRelationGraph(graph, PROJECT_ID)).toThrow(HierarchyContractError);
    expect(taskReads).toBe(0);

    const oversizedSourceBody = '가'.repeat(174_763);
    expect([...oversizedSourceBody]).toHaveLength(174_763);
    expect(Buffer.byteLength(oversizedSourceBody, 'utf8')).toBe(
      HIERARCHICAL_COMPILATION_LIMITS.maxSourceBytes + 1,
    );
    const oversizedSourceDigest = hierarchySha256(oversizedSourceBody);
    const oversizedSnapshotSource = Object.freeze({
      ...firstSource,
      sanitizedContentDigest: oversizedSourceDigest,
    });
    const oversizedSourceUnit = createTextUnit({
      projectId: PROJECT_ID,
      sourceId: oversizedSnapshotSource.sourceId,
      sourceRevision: oversizedSnapshotSource.sourceRevision,
      sourceRef: oversizedSnapshotSource.sourceRef,
      kind: 'heading',
      ordinal: 0,
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      contentDigest: hierarchySha256('가'),
    });
    const oversizedSourceSnapshot = createCorpusSnapshot(snapshotInput(
      Object.freeze([oversizedSnapshotSource]),
      Object.freeze([oversizedSourceUnit]),
    ));
    const preparedEvidenceSource: SanitizedEvidenceSourceV1 = Object.freeze({
      sourceId: oversizedSnapshotSource.sourceId,
      sourceRevision: oversizedSnapshotSource.sourceRevision,
      sourceRef: oversizedSnapshotSource.sourceRef,
      preparedSource: issuePreparedSource({
        approvedBody: oversizedSourceBody,
        approvedBodyDigest: oversizedSourceDigest,
        classification: 'internal',
        inputBodyDigest: oversizedSourceDigest,
        policyDigest: oversizedSourceSnapshot.sanitizerPolicyDigest,
        projectId: PROJECT_ID,
        rulesVersion: SANITIZER_RULES_VERSION,
        source: oversizedSnapshotSource.sourceRef,
        sourceKind: 'markdown',
        sourceRevisionOrContentSha256: oversizedSnapshotSource.sourceRevision,
        untrustedData: false,
      }),
    });
    expect(() => createEvidencePack({
      blueprint: blueprintFor(
        oversizedSourceSnapshot.snapshotDigest,
        oversizedSnapshotSource.sourceId,
      ),
      snapshot: oversizedSourceSnapshot,
      sources: Object.freeze([preparedEvidenceSource]),
      selectedUnitIds: Object.freeze([oversizedSourceUnit.unitId]),
      conflicts: Object.freeze([]),
      gaps: Object.freeze([]),
    }, PROJECT_ID)).toThrow(HierarchyContractError);
    expect(preparedEvidenceSource.sourceRef).toBe(firstSource.sourceRef);
    expect(inspectPreparedSource(preparedEvidenceSource.preparedSource)).not.toBeNull();

    const maximumSourceBody = 'p'.repeat(SESSION_COMPILE_LIMITS.maxSourceBytes);
    const maximumSourceBodyDigest = sessionSha256(maximumSourceBody);
    const planSourceCount = Math.ceil(
      SESSION_COMPILE_LIMITS.maxPlanBytes / SESSION_COMPILE_LIMITS.maxSourceBytes,
    ) + 1;
    const planSources: readonly SessionPlannedSource[] = Object.freeze(Array.from(
      { length: planSourceCount },
      (_, index): SessionPlannedSource => {
        const suffix = String(index).padStart(3, '0');
        const sourceRef = `docs/plan-${suffix}.md`;
        const revision = sessionSha256(`revision-${suffix}`);
        const sourceId = `source-${digestSessionValue({
          projectId: PROJECT_ID,
          revision,
          sanitizedContentDigest: maximumSourceBodyDigest,
          sourceKind: 'markdown',
          sourceRef,
        }).slice('sha256:'.length)}`;
        const sourceUri = `buildlore+source:/https%3A%2F%2Fexample.test%2Fboundary.git/${suffix}`;
        return Object.freeze({
          citationAnchors: Object.freeze([]),
          compilerSourceContentDigest: maximumSourceBodyDigest,
          compilerSourceId: `markdown--${sessionSha256(sourceUri)
            .slice('sha256:'.length)}.md`,
          originalContentDigest: maximumSourceBodyDigest,
          revision,
          retrievalMeaning: sourceRetrievalMeaningFromDescriptor(undefined),
          sanitizedBody: maximumSourceBody,
          sanitizedContentDigest: maximumSourceBodyDigest,
          sourceId,
          sourceKind: 'markdown',
          sourceRef,
          title: `Plan source ${suffix}`,
        });
      },
    ));
    expect(planSources).toHaveLength(65);
    expect(planSources.every((item) =>
      Buffer.byteLength(item.sanitizedBody, 'utf8') <= SESSION_COMPILE_LIMITS.maxSourceBytes))
      .toBe(true);
    expect(planSources.reduce((sum, item) =>
      sum + Buffer.byteLength(item.sanitizedBody, 'utf8'), 0))
      .toBeGreaterThan(SESSION_COMPILE_LIMITS.maxPlanBytes);
    const plan = Object.freeze({
      schemaVersion: SESSION_COMPILE_PLAN_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      contractDigest: DIGEST,
      profileDigest: DIGEST,
      policyDigest: DIGEST,
      selectionDigest: DIGEST,
      sourceManifestDigest: DIGEST,
      existingKnowledgeDigest: DIGEST,
      algorithmVersion: SESSION_COMPILE_ALGORITHM_VERSION,
      limits: SESSION_COMPILE_LIMITS,
      sources: planSources,
      tasks: Object.freeze([]),
      mergeCandidates: Object.freeze([]),
      allowedLinkTargets: Object.freeze([]),
    });
    expect(() => finalizeSessionCompilePlan(plan)).toThrowError(SessionCompileError);
    expect(plan.sources).toBe(planSources);
    expect(plan.sources[0]?.sanitizedBody).toBe(maximumSourceBody);

    const evidenceUnit: EvidenceUnitV1 = Object.freeze({
      unitId: firstUnit.unitId,
      sourceId: firstSource.sourceId,
      kind: firstUnit.kind,
      range: firstUnit.range,
      content: 'Boundary',
      contentDigest: firstUnit.contentDigest,
      citation: Object.freeze({
        citationId: `citation-${'a'.repeat(64)}`,
        sourceId: firstSource.sourceId,
        sourceRevision: firstSource.sourceRevision,
        sourceRef: firstSource.sourceRef,
        range: firstUnit.range,
        quoteDigest: firstUnit.contentDigest,
      }),
    });
    let evidenceReads = 0;
    const tooManyEvidenceUnits = observedOverLimitArray(
      HIERARCHICAL_COMPILATION_LIMITS.maxEvidenceUnits,
      evidenceUnit,
      () => { evidenceReads += 1; },
    );
    const blueprint = blueprintFor(DIGEST, firstSource.sourceId);
    const evidencePack: EvidencePackV1 = Object.freeze({
      schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      pageId: PAGE_ID,
      blueprintDigest: DIGEST,
      snapshotDigest: DIGEST,
      sanitizerPolicyDigest: DIGEST,
      units: tooManyEvidenceUnits,
      conflicts: Object.freeze([]),
      gaps: Object.freeze([]),
      evidenceBytes: 1,
      packDigest: DIGEST,
    });
    expect(() => createCurrentSessionGenerationRequest(
      blueprint,
      evidencePack,
      Object.freeze([]),
      PROJECT_ID,
    )).toThrow(HierarchyContractError);
    expect(evidenceReads).toBe(0);
  });
});
