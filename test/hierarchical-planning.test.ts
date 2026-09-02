import { describe, expect, it } from 'vitest';

import {
  HIERARCHICAL_COMPILATION_POLICY,
  HierarchyContractError,
  advanceCompileContinuation,
  buildSparseRelationGraph,
  createCorpusSnapshot,
  createTextUnit,
  digestHierarchyValue,
  finalizePlanningDispositionInventory,
  hierarchySha256,
  startCompileContinuation,
  type CompilePartitionCursorV2,
  type CompilePartitionV2,
  type CorpusSnapshotSourceV1,
  type CorpusSnapshotV1,
  type PlanningDispositionInventoryV1,
} from '../src/compiler/index.js';

const PROJECT_ID = 'fixture-project';
const SOURCE_COUNT = 117;
const TASK_COUNT = 473;
const REPEATED_HEADING_COUNT = 33;

function sourceId(index: number): string {
  return `source-${hierarchySha256(`source-${String(index)}`).slice('sha256:'.length)}`;
}

function corpus(options: {
  readonly sourceCount?: number;
  readonly taskCount?: number;
  readonly repeatedHeadingCount?: number;
} = {}): CorpusSnapshotV1 {
  const sourceCount = options.sourceCount ?? SOURCE_COUNT;
  const taskCount = options.taskCount ?? TASK_COUNT;
  const repeatedHeadingCount = options.repeatedHeadingCount ?? REPEATED_HEADING_COUNT;
  const baseUnitCount = Math.floor(taskCount / sourceCount);
  const remainder = taskCount % sourceCount;
  const sources: CorpusSnapshotSourceV1[] = [];
  const textUnits = [];
  for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
    const id = sourceId(sourceIndex);
    const revision = hierarchySha256(`revision-${String(sourceIndex)}`);
    const sourceRef = `docs/source-${String(sourceIndex).padStart(3, '0')}.md`;
    sources.push(Object.freeze({
      sourceId: id,
      sourceRevision: revision,
      sourceRef,
      sanitizedContentDigest: hierarchySha256(`sanitized-${String(sourceIndex)}`),
    }));
    const unitCount = baseUnitCount + (sourceIndex < remainder ? 1 : 0);
    for (let ordinal = 0; ordinal < unitCount; ordinal += 1) {
      const isRepeated = sourceIndex < repeatedHeadingCount && ordinal === 0;
      textUnits.push(createTextUnit({
        projectId: PROJECT_ID,
        sourceId: id,
        sourceRevision: revision,
        sourceRef,
        kind: 'heading',
        ordinal,
        range: {
          startLine: ordinal * 2 + 1,
          startColumn: 1,
          endLine: ordinal * 2 + 1,
          endColumn: 16,
        },
        contentDigest: isRepeated
          ? hierarchySha256('Shared overview')
          : hierarchySha256(`heading-${String(sourceIndex)}-${String(ordinal)}`),
      }));
    }
  }
  return createCorpusSnapshot({
    projectId: PROJECT_ID,
    purposeDigest: hierarchySha256('purpose'),
    interpretationRulesDigest: hierarchySha256('interpretation-rules'),
    profileDigest: hierarchySha256('profile'),
    compilerContractDigest: hierarchySha256('compiler'),
    sanitizerPolicyDigest: hierarchySha256('sanitizer'),
    sourceManifestDigest: hierarchySha256('manifest'),
    policyDigest: HIERARCHICAL_COMPILATION_POLICY.policyDigest,
    sources,
    textUnits,
  });
}

function compileAll(
  snapshot: CorpusSnapshotV1,
  partitionSize: number,
): {
  readonly inventory: PlanningDispositionInventoryV1;
  readonly partitions: readonly CompilePartitionV2[];
} {
  const graph = buildSparseRelationGraph(snapshot, PROJECT_ID);
  let continuation = startCompileContinuation(graph, partitionSize, PROJECT_ID);
  const partitions: CompilePartitionV2[] = [];
  while (!continuation.complete) {
    const cursor = continuation.nextCursor;
    if (cursor === null) throw new Error('expected a continuation cursor');
    const advanced = advanceCompileContinuation(graph, continuation, cursor, PROJECT_ID);
    partitions.push(advanced.partition);
    continuation = advanced.continuation;
  }
  return {
    inventory: finalizePlanningDispositionInventory(
      graph,
      continuation,
      partitions,
      PROJECT_ID,
    ),
    partitions,
  };
}

describe('hierarchical full-corpus planning', () => {
  it('completes the 117-source/473-task repeated-heading corpus without truncation', () => {
    const snapshot = corpus();
    const graph = buildSparseRelationGraph(snapshot, PROJECT_ID);
    expect(graph.tasks).toHaveLength(TASK_COUNT);
    expect(graph.relations).toHaveLength(528);
    const degrees = new Map<string, number>();
    for (const relation of graph.relations) {
      degrees.set(relation.leftTaskId, (degrees.get(relation.leftTaskId) ?? 0) + 1);
      degrees.set(relation.rightTaskId, (degrees.get(relation.rightTaskId) ?? 0) + 1);
    }
    expect(Math.max(...degrees.values())).toBe(32);

    const result = compileAll(snapshot, 50);
    expect(result.partitions).toHaveLength(10);
    expect(result.inventory).toMatchObject({
      complete: true,
      taskCount: TASK_COUNT,
      relationCount: 528,
    });
    expect(result.partitions.flatMap((partition) => partition.taskDispositions))
      .toHaveLength(TASK_COUNT);
    expect(result.partitions.flatMap((partition) => partition.relationDispositions))
      .toHaveLength(528);
  });

  it('produces byte-identical final disposition identities across partition sizes', () => {
    const snapshot = corpus();
    const results = [17, 50, 256].map((partitionSize) =>
      compileAll(snapshot, partitionSize).inventory);
    expect(new Set(results.map((result) => result.taskDispositionDigest)).size).toBe(1);
    expect(new Set(results.map((result) => result.relationDispositionDigest)).size).toBe(1);
    expect(new Set(results.map((result) => result.dispositionDigest)).size).toBe(1);
    expect(new Set(results.map((result) => result.inventoryDigest)).size).toBe(1);
  });

  it('rejects repeated, stale and configuration-drift cursors without mutating state', () => {
    const snapshot = corpus();
    const graph = buildSparseRelationGraph(snapshot, PROJECT_ID);
    const initial = startCompileContinuation(graph, 17, PROJECT_ID);
    const cursor = initial.nextCursor;
    if (cursor === null) throw new Error('expected initial cursor');
    const advanced = advanceCompileContinuation(graph, initial, cursor, PROJECT_ID);
    const before = JSON.stringify(advanced.continuation);

    expect(() => advanceCompileContinuation(
      graph,
      advanced.continuation,
      cursor,
      PROJECT_ID,
    )).toThrow(HierarchyContractError);

    const staleWithoutDigest = {
      ...cursor,
      snapshotDigest: hierarchySha256('another-snapshot'),
    };
    const stale: CompilePartitionCursorV2 = {
      ...staleWithoutDigest,
      cursorDigest: digestHierarchyValue({
        schemaVersion: staleWithoutDigest.schemaVersion,
        projectId: staleWithoutDigest.projectId,
        snapshotDigest: staleWithoutDigest.snapshotDigest,
        graphDigest: staleWithoutDigest.graphDigest,
        policyDigest: staleWithoutDigest.policyDigest,
        partitionSize: staleWithoutDigest.partitionSize,
        taskOffset: staleWithoutDigest.taskOffset,
      }),
    };
    expect(() => advanceCompileContinuation(graph, initial, stale, PROJECT_ID))
      .toThrow(HierarchyContractError);

    const driftWithoutDigest = { ...cursor, partitionSize: 18 };
    const drift: CompilePartitionCursorV2 = {
      ...driftWithoutDigest,
      cursorDigest: digestHierarchyValue({
        schemaVersion: driftWithoutDigest.schemaVersion,
        projectId: driftWithoutDigest.projectId,
        snapshotDigest: driftWithoutDigest.snapshotDigest,
        graphDigest: driftWithoutDigest.graphDigest,
        policyDigest: driftWithoutDigest.policyDigest,
        partitionSize: driftWithoutDigest.partitionSize,
        taskOffset: driftWithoutDigest.taskOffset,
      }),
    };
    expect(() => advanceCompileContinuation(graph, initial, drift, PROJECT_ID))
      .toThrow(HierarchyContractError);
    expect(JSON.stringify(advanced.continuation)).toBe(before);
  });

  it('rejects omitted and duplicated partitions and relation explosions fail closed', () => {
    const snapshot = corpus();
    const graph = buildSparseRelationGraph(snapshot, PROJECT_ID);
    let continuation = startCompileContinuation(graph, 256, PROJECT_ID);
    const partitions: CompilePartitionV2[] = [];
    while (!continuation.complete) {
      const cursor = continuation.nextCursor;
      if (cursor === null) throw new Error('expected continuation cursor');
      const advanced = advanceCompileContinuation(graph, continuation, cursor, PROJECT_ID);
      partitions.push(advanced.partition);
      continuation = advanced.continuation;
    }
    expect(() => finalizePlanningDispositionInventory(
      graph,
      continuation,
      partitions.slice(1),
      PROJECT_ID,
    )).toThrow(HierarchyContractError);
    expect(() => finalizePlanningDispositionInventory(
      graph,
      continuation,
      [partitions[0] as CompilePartitionV2, partitions[0] as CompilePartitionV2],
      PROJECT_ID,
    )).toThrow(HierarchyContractError);

    const explodingSnapshot = corpus({
      sourceCount: 257,
      taskCount: 257,
      repeatedHeadingCount: 257,
    });
    const before = JSON.stringify(explodingSnapshot);
    expect(() => buildSparseRelationGraph(explodingSnapshot, PROJECT_ID))
      .toThrow(HierarchyContractError);
    expect(JSON.stringify(explodingSnapshot)).toBe(before);
  });
});
