import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { HierarchyContractError } from './errors.js';
import {
  HIERARCHICAL_COMPILATION_LIMITS,
  HIERARCHICAL_COMPILATION_POLICY,
  digestHierarchyValue,
  parseCorpusSnapshot,
} from './contracts.js';
import {
  COMPILE_CONTINUATION_SCHEMA_VERSION,
  COMPILE_PARTITION_CURSOR_SCHEMA_VERSION,
  COMPILE_PARTITION_SCHEMA_VERSION,
  PLANNING_DISPOSITION_INVENTORY_SCHEMA_VERSION,
  SPARSE_RELATION_GRAPH_SCHEMA_VERSION,
  type CompileContinuationV2,
  type CompilePartitionCursorV2,
  type CompilePartitionV2,
  type CorpusSnapshotV1,
  type HierarchyPlanningTaskV1,
  type HierarchySha256Digest,
  type PlanningDispositionInventoryV1,
  type RelationDispositionV1,
  type SparseRelationCandidateV1,
  type SparseRelationGraphV1,
  type TaskDispositionV1,
} from './types.js';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TASK_ID_PATTERN = /^task-[a-f0-9]{64}$/u;
const RELATION_ID_PATTERN = /^relation-[a-f0-9]{64}$/u;
const MAX_FORWARD_NEIGHBORS = HIERARCHICAL_COMPILATION_LIMITS
  .maxRelationCandidatesPerTask / 2;

type UnknownRecord = Readonly<Record<string, unknown>>;

function invalid(projectId: string): never {
  throw new HierarchyContractError(projectId);
}

function record(value: unknown, projectId: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(projectId);
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  projectId: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) invalid(projectId);
}

function digest(value: unknown, projectId: string): HierarchySha256Digest {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) invalid(projectId);
  return value as HierarchySha256Digest;
}

function identifier(value: unknown, pattern: RegExp, projectId: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(projectId);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, projectId: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) invalid(projectId);
  return value;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function taskWithoutId(task: Omit<HierarchyPlanningTaskV1, 'taskId'>):
Readonly<Record<string, unknown>> {
  return {
    unitId: task.unitId,
    sourceId: task.sourceId,
    ordinal: task.ordinal,
    kind: task.kind,
    contentDigest: task.contentDigest,
  };
}

function relationWithoutId(
  relation: Omit<SparseRelationCandidateV1, 'relationId'>,
): Readonly<Record<string, unknown>> {
  return {
    leftTaskId: relation.leftTaskId,
    rightTaskId: relation.rightTaskId,
    ownerTaskId: relation.ownerTaskId,
    basis: relation.basis,
    sharedKeyDigest: relation.sharedKeyDigest,
  };
}

function graphWithoutDigest(
  graph: Omit<SparseRelationGraphV1, 'graphDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: graph.schemaVersion,
    projectId: graph.projectId,
    snapshotDigest: graph.snapshotDigest,
    policyDigest: graph.policyDigest,
    tasks: graph.tasks,
    relations: graph.relations,
    taskSetDigest: graph.taskSetDigest,
    relationSetDigest: graph.relationSetDigest,
  };
}

function compareTasks(left: HierarchyPlanningTaskV1, right: HierarchyPlanningTaskV1): number {
  if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0;
}

function compareRelations(
  left: SparseRelationCandidateV1,
  right: SparseRelationCandidateV1,
): number {
  if (left.leftTaskId !== right.leftTaskId) return left.leftTaskId < right.leftTaskId ? -1 : 1;
  return left.rightTaskId < right.rightTaskId ? -1 : left.rightTaskId > right.rightTaskId ? 1 : 0;
}

function compareRelationsByTaskOrder(
  taskOrder: ReadonlyMap<string, number>,
  left: SparseRelationCandidateV1,
  right: SparseRelationCandidateV1,
): number {
  const leftOrder = taskOrder.get(left.ownerTaskId);
  const rightOrder = taskOrder.get(right.ownerTaskId);
  if (leftOrder === undefined || rightOrder === undefined) return 0;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return compareRelations(left, right);
}

function createTask(unit: CorpusSnapshotV1['textUnits'][number]): HierarchyPlanningTaskV1 {
  const candidate = Object.freeze({
    unitId: unit.unitId,
    sourceId: unit.sourceId,
    ordinal: unit.ordinal,
    kind: unit.kind,
    contentDigest: unit.contentDigest,
  });
  return Object.freeze({
    taskId: `task-${digestHierarchyValue(taskWithoutId(candidate)).slice('sha256:'.length)}`,
    ...candidate,
  });
}

function createRelation(
  first: HierarchyPlanningTaskV1,
  second: HierarchyPlanningTaskV1,
): SparseRelationCandidateV1 {
  const [left, right] = first.taskId < second.taskId ? [first, second] : [second, first];
  const candidate = Object.freeze({
    leftTaskId: left.taskId,
    rightTaskId: right.taskId,
    ownerTaskId: left.taskId,
    basis: 'matching-content-digest' as const,
    sharedKeyDigest: left.contentDigest,
  });
  return Object.freeze({
    relationId: `relation-${digestHierarchyValue(relationWithoutId(candidate))
      .slice('sha256:'.length)}`,
    ...candidate,
  });
}

function relationPairs(
  cluster: readonly HierarchyPlanningTaskV1[],
  projectId: string,
): readonly SparseRelationCandidateV1[] {
  if (cluster.length > HIERARCHICAL_COMPILATION_LIMITS.maxClusterMembers) invalid(projectId);
  if (cluster.length < 2) return Object.freeze([]);
  const relations = new Map<string, SparseRelationCandidateV1>();
  if (cluster.length <= HIERARCHICAL_COMPILATION_LIMITS.maxRelationCandidatesPerTask + 1) {
    for (let left = 0; left < cluster.length; left += 1) {
      for (let right = left + 1; right < cluster.length; right += 1) {
        const first = cluster[left];
        const second = cluster[right];
        if (first === undefined || second === undefined) invalid(projectId);
        const relation = createRelation(first, second);
        relations.set(relation.relationId, relation);
      }
    }
  } else {
    for (let index = 0; index < cluster.length; index += 1) {
      const first = cluster[index];
      if (first === undefined) invalid(projectId);
      for (let distance = 1; distance <= MAX_FORWARD_NEIGHBORS; distance += 1) {
        const second = cluster[(index + distance) % cluster.length];
        if (second === undefined) invalid(projectId);
        const relation = createRelation(first, second);
        relations.set(relation.relationId, relation);
      }
    }
  }
  return Object.freeze([...relations.values()].sort(compareRelations));
}

export function buildSparseRelationGraph(
  snapshotValue: CorpusSnapshotV1,
  expectedProjectId: string,
): SparseRelationGraphV1 {
  const snapshot = parseCorpusSnapshot(snapshotValue, expectedProjectId);
  const tasks = Object.freeze(snapshot.textUnits.map(createTask).sort(compareTasks));
  const taskOrder = new Map(tasks.map((task, index) => [task.taskId, index]));
  const headingIndex = new Map<HierarchySha256Digest, HierarchyPlanningTaskV1[]>();
  for (const task of tasks) {
    if (task.kind !== 'heading') continue;
    const cluster = headingIndex.get(task.contentDigest) ?? [];
    cluster.push(task);
    headingIndex.set(task.contentDigest, cluster);
  }
  const relations = Object.freeze([...headingIndex.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([, cluster]) => relationPairs(
      Object.freeze([...cluster].sort((left, right) =>
        left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0)),
      snapshot.projectId,
    ))
    .sort((left, right) => compareRelationsByTaskOrder(taskOrder, left, right)));
  const degree = new Map<string, number>();
  for (const relation of relations) {
    degree.set(relation.leftTaskId, (degree.get(relation.leftTaskId) ?? 0) + 1);
    degree.set(relation.rightTaskId, (degree.get(relation.rightTaskId) ?? 0) + 1);
  }
  if ([...degree.values()].some((count) =>
    count > HIERARCHICAL_COMPILATION_LIMITS.maxRelationCandidatesPerTask)) {
    invalid(snapshot.projectId);
  }
  const taskSetDigest = digestHierarchyValue(tasks.map((task) => task.taskId));
  const relationSetDigest = digestHierarchyValue(relations.map((relation) => relation.relationId));
  const candidate = Object.freeze({
    schemaVersion: SPARSE_RELATION_GRAPH_SCHEMA_VERSION,
    projectId: snapshot.projectId,
    snapshotDigest: snapshot.snapshotDigest,
    policyDigest: snapshot.policyDigest,
    tasks,
    relations,
    taskSetDigest,
    relationSetDigest,
  });
  const graph = Object.freeze({
    ...candidate,
    graphDigest: digestHierarchyValue(graphWithoutDigest(candidate)),
  });
  if (
    Buffer.byteLength(serializeCanonicalJson(graph), 'utf8') >
    HIERARCHICAL_COMPILATION_LIMITS.maxPlanBytes
  ) invalid(snapshot.projectId);
  return parseSparseRelationGraph(graph, snapshot.projectId);
}

export function parseSparseRelationGraph(
  value: unknown,
  expectedProjectId: string,
): SparseRelationGraphV1 {
  const graph = record(value, expectedProjectId);
  exactKeys(graph, [
    'graphDigest',
    'policyDigest',
    'projectId',
    'relationSetDigest',
    'relations',
    'schemaVersion',
    'snapshotDigest',
    'taskSetDigest',
    'tasks',
  ], expectedProjectId);
  if (
    graph.schemaVersion !== SPARSE_RELATION_GRAPH_SCHEMA_VERSION ||
    graph.projectId !== expectedProjectId ||
    graph.policyDigest !== HIERARCHICAL_COMPILATION_POLICY.policyDigest ||
    !Array.isArray(graph.tasks) ||
    graph.tasks.length < 1 ||
    graph.tasks.length > HIERARCHICAL_COMPILATION_LIMITS.maxTasks ||
    !Array.isArray(graph.relations)
  ) invalid(expectedProjectId);
  const tasks = graph.tasks.map((item) => {
    const task = record(item, expectedProjectId);
    exactKeys(task, [
      'contentDigest', 'kind', 'ordinal', 'sourceId', 'taskId', 'unitId',
    ], expectedProjectId);
    const parsed = Object.freeze({
      taskId: identifier(task.taskId, TASK_ID_PATTERN, expectedProjectId),
      unitId: identifier(task.unitId, /^unit-[a-f0-9]{64}$/u, expectedProjectId),
      sourceId: identifier(task.sourceId, /^source-[a-f0-9]{64}$/u, expectedProjectId),
      ordinal: integer(task.ordinal, 0, HIERARCHICAL_COMPILATION_LIMITS.maxTasks - 1,
        expectedProjectId),
      kind: task.kind,
      contentDigest: digest(task.contentDigest, expectedProjectId),
    });
    if (
      typeof parsed.kind !== 'string' ||
      !['document', 'fenced-code', 'heading', 'list', 'paragraph', 'table']
        .includes(parsed.kind) ||
      parsed.taskId !==
        `task-${digestHierarchyValue(taskWithoutId(parsed as HierarchyPlanningTaskV1))
          .slice('sha256:'.length)}`
    ) invalid(expectedProjectId);
    return parsed as HierarchyPlanningTaskV1;
  });
  if (
    new Set(tasks.map((task) => task.taskId)).size !== tasks.length ||
    tasks.some((task, index) => {
      const previous = tasks[index - 1];
      return previous !== undefined && compareTasks(previous, task) >= 0;
    })
  ) invalid(expectedProjectId);
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const taskOrder = new Map(tasks.map((task, index) => [task.taskId, index]));
  const expectedHeadingIndex = new Map<HierarchySha256Digest, HierarchyPlanningTaskV1[]>();
  for (const task of tasks) {
    if (task.kind !== 'heading') continue;
    const cluster = expectedHeadingIndex.get(task.contentDigest) ?? [];
    cluster.push(task);
    expectedHeadingIndex.set(task.contentDigest, cluster);
  }
  const expectedRelations = [...expectedHeadingIndex.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([, cluster]) => relationPairs(
      Object.freeze([...cluster].sort((left, right) =>
        left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0)),
      expectedProjectId,
    ))
    .sort((left, right) => compareRelationsByTaskOrder(taskOrder, left, right));
  const relations = graph.relations.map((item) => {
    const relation = record(item, expectedProjectId);
    exactKeys(relation, [
      'basis', 'leftTaskId', 'ownerTaskId', 'relationId', 'rightTaskId',
      'sharedKeyDigest',
    ], expectedProjectId);
    const parsed = Object.freeze({
      relationId: identifier(relation.relationId, RELATION_ID_PATTERN, expectedProjectId),
      leftTaskId: identifier(relation.leftTaskId, TASK_ID_PATTERN, expectedProjectId),
      rightTaskId: identifier(relation.rightTaskId, TASK_ID_PATTERN, expectedProjectId),
      ownerTaskId: identifier(relation.ownerTaskId, TASK_ID_PATTERN, expectedProjectId),
      basis: relation.basis,
      sharedKeyDigest: digest(relation.sharedKeyDigest, expectedProjectId),
    });
    const left = taskById.get(parsed.leftTaskId);
    const right = taskById.get(parsed.rightTaskId);
    if (
      parsed.basis !== 'matching-content-digest' ||
      parsed.leftTaskId >= parsed.rightTaskId ||
      parsed.ownerTaskId !== parsed.leftTaskId ||
      left === undefined ||
      right === undefined ||
      left.kind !== 'heading' ||
      right.kind !== 'heading' ||
      left.contentDigest !== right.contentDigest ||
      left.contentDigest !== parsed.sharedKeyDigest ||
      parsed.relationId !==
        `relation-${digestHierarchyValue(relationWithoutId(
          parsed as SparseRelationCandidateV1,
        )).slice('sha256:'.length)}`
    ) invalid(expectedProjectId);
    return parsed as SparseRelationCandidateV1;
  });
  const degree = new Map<string, number>();
  for (const relation of relations) {
    degree.set(relation.leftTaskId, (degree.get(relation.leftTaskId) ?? 0) + 1);
    degree.set(relation.rightTaskId, (degree.get(relation.rightTaskId) ?? 0) + 1);
  }
  if (
    new Set(relations.map((relation) => relation.relationId)).size !== relations.length ||
    !sameArray(
      relations.map((relation) => relation.relationId),
      expectedRelations.map((relation) => relation.relationId),
    ) ||
    relations.some((relation, index) => {
      const previous = relations[index - 1];
      return previous !== undefined &&
        compareRelationsByTaskOrder(taskOrder, previous, relation) >= 0;
    }) ||
    [...degree.values()].some((count) =>
      count > HIERARCHICAL_COMPILATION_LIMITS.maxRelationCandidatesPerTask)
  ) invalid(expectedProjectId);
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: SPARSE_RELATION_GRAPH_SCHEMA_VERSION,
    projectId: expectedProjectId,
    snapshotDigest: digest(graph.snapshotDigest, expectedProjectId),
    policyDigest: digest(graph.policyDigest, expectedProjectId),
    tasks: Object.freeze(tasks),
    relations: Object.freeze(relations),
    taskSetDigest: digest(graph.taskSetDigest, expectedProjectId),
    relationSetDigest: digest(graph.relationSetDigest, expectedProjectId),
  });
  if (
    parsedWithoutDigest.taskSetDigest !==
      digestHierarchyValue(tasks.map((task) => task.taskId)) ||
    parsedWithoutDigest.relationSetDigest !==
      digestHierarchyValue(relations.map((relation) => relation.relationId))
  ) invalid(expectedProjectId);
  const graphDigest = digest(graph.graphDigest, expectedProjectId);
  if (graphDigest !== digestHierarchyValue(graphWithoutDigest(parsedWithoutDigest))) {
    invalid(expectedProjectId);
  }
  return Object.freeze({ ...parsedWithoutDigest, graphDigest });
}

function cursorWithoutDigest(
  cursor: Omit<CompilePartitionCursorV2, 'cursorDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: cursor.schemaVersion,
    projectId: cursor.projectId,
    snapshotDigest: cursor.snapshotDigest,
    graphDigest: cursor.graphDigest,
    policyDigest: cursor.policyDigest,
    partitionSize: cursor.partitionSize,
    taskOffset: cursor.taskOffset,
  };
}

function createCursor(
  graph: SparseRelationGraphV1,
  partitionSize: number,
  taskOffset: number,
): CompilePartitionCursorV2 {
  const candidate = Object.freeze({
    schemaVersion: COMPILE_PARTITION_CURSOR_SCHEMA_VERSION,
    projectId: graph.projectId,
    snapshotDigest: graph.snapshotDigest,
    graphDigest: graph.graphDigest,
    policyDigest: graph.policyDigest,
    partitionSize,
    taskOffset,
  });
  return Object.freeze({
    ...candidate,
    cursorDigest: digestHierarchyValue(cursorWithoutDigest(candidate)),
  });
}

function parseCursor(
  value: unknown,
  graph: SparseRelationGraphV1,
): CompilePartitionCursorV2 {
  const cursor = record(value, graph.projectId);
  exactKeys(cursor, [
    'cursorDigest', 'graphDigest', 'partitionSize', 'policyDigest', 'projectId',
    'schemaVersion', 'snapshotDigest', 'taskOffset',
  ], graph.projectId);
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: cursor.schemaVersion,
    projectId: cursor.projectId,
    snapshotDigest: digest(cursor.snapshotDigest, graph.projectId),
    graphDigest: digest(cursor.graphDigest, graph.projectId),
    policyDigest: digest(cursor.policyDigest, graph.projectId),
    partitionSize: integer(cursor.partitionSize, 1,
      HIERARCHICAL_COMPILATION_LIMITS.maxPartitionTasks, graph.projectId),
    taskOffset: integer(cursor.taskOffset, 0, graph.tasks.length, graph.projectId),
  });
  if (
    parsedWithoutDigest.schemaVersion !== COMPILE_PARTITION_CURSOR_SCHEMA_VERSION ||
    parsedWithoutDigest.projectId !== graph.projectId ||
    parsedWithoutDigest.snapshotDigest !== graph.snapshotDigest ||
    parsedWithoutDigest.graphDigest !== graph.graphDigest ||
    parsedWithoutDigest.policyDigest !== graph.policyDigest ||
    parsedWithoutDigest.taskOffset >= graph.tasks.length
  ) invalid(graph.projectId);
  const cursorDigest = digest(cursor.cursorDigest, graph.projectId);
  if (cursorDigest !== digestHierarchyValue(cursorWithoutDigest(
    parsedWithoutDigest as Omit<CompilePartitionCursorV2, 'cursorDigest'>,
  ))) invalid(graph.projectId);
  return Object.freeze({
    ...(parsedWithoutDigest as Omit<CompilePartitionCursorV2, 'cursorDigest'>),
    cursorDigest,
  });
}

function continuationWithoutDigest(
  continuation: Omit<CompileContinuationV2, 'continuationDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: continuation.schemaVersion,
    projectId: continuation.projectId,
    snapshotDigest: continuation.snapshotDigest,
    graphDigest: continuation.graphDigest,
    policyDigest: continuation.policyDigest,
    partitionSize: continuation.partitionSize,
    nextTaskOffset: continuation.nextTaskOffset,
    nextCursor: continuation.nextCursor,
    acceptedPartitionDigests: continuation.acceptedPartitionDigests,
    complete: continuation.complete,
  };
}

function createContinuation(
  graph: SparseRelationGraphV1,
  partitionSize: number,
  nextTaskOffset: number,
  acceptedPartitionDigests: readonly HierarchySha256Digest[],
): CompileContinuationV2 {
  const complete = nextTaskOffset === graph.tasks.length;
  const candidate = Object.freeze({
    schemaVersion: COMPILE_CONTINUATION_SCHEMA_VERSION,
    projectId: graph.projectId,
    snapshotDigest: graph.snapshotDigest,
    graphDigest: graph.graphDigest,
    policyDigest: graph.policyDigest,
    partitionSize,
    nextTaskOffset,
    nextCursor: complete ? null : createCursor(graph, partitionSize, nextTaskOffset),
    acceptedPartitionDigests: Object.freeze([...acceptedPartitionDigests]),
    complete,
  });
  return Object.freeze({
    ...candidate,
    continuationDigest: digestHierarchyValue(continuationWithoutDigest(candidate)),
  });
}

export function startCompileContinuation(
  graphValue: SparseRelationGraphV1,
  partitionSize: number,
  expectedProjectId: string,
): CompileContinuationV2 {
  const graph = parseSparseRelationGraph(graphValue, expectedProjectId);
  integer(partitionSize, 1, HIERARCHICAL_COMPILATION_LIMITS.maxPartitionTasks,
    expectedProjectId);
  return createContinuation(graph, partitionSize, 0, []);
}

export function parseCompileContinuation(
  value: unknown,
  graphValue: SparseRelationGraphV1,
  expectedProjectId: string,
): CompileContinuationV2 {
  const graph = parseSparseRelationGraph(graphValue, expectedProjectId);
  const continuation = record(value, expectedProjectId);
  exactKeys(continuation, [
    'acceptedPartitionDigests', 'complete', 'continuationDigest', 'graphDigest',
    'nextCursor', 'nextTaskOffset', 'partitionSize', 'policyDigest', 'projectId',
    'schemaVersion', 'snapshotDigest',
  ], expectedProjectId);
  if (!Array.isArray(continuation.acceptedPartitionDigests)) invalid(expectedProjectId);
  const partitionSize = integer(continuation.partitionSize, 1,
    HIERARCHICAL_COMPILATION_LIMITS.maxPartitionTasks, expectedProjectId);
  const nextTaskOffset = integer(continuation.nextTaskOffset, 0, graph.tasks.length,
    expectedProjectId);
  const acceptedPartitionDigests = Object.freeze(continuation.acceptedPartitionDigests
    .map((item) => digest(item, expectedProjectId)));
  const complete = continuation.complete === true;
  const expectedPartitionCount = Math.ceil(nextTaskOffset / partitionSize);
  if (
    continuation.schemaVersion !== COMPILE_CONTINUATION_SCHEMA_VERSION ||
    continuation.projectId !== graph.projectId ||
    continuation.snapshotDigest !== graph.snapshotDigest ||
    continuation.graphDigest !== graph.graphDigest ||
    continuation.policyDigest !== graph.policyDigest ||
    acceptedPartitionDigests.length !== expectedPartitionCount ||
    complete !== (nextTaskOffset === graph.tasks.length) ||
    (!complete && nextTaskOffset !== acceptedPartitionDigests.length * partitionSize) ||
    (complete && nextTaskOffset === 0)
  ) invalid(expectedProjectId);
  let nextCursor: CompilePartitionCursorV2 | null;
  if (complete) {
    if (continuation.nextCursor !== null) invalid(expectedProjectId);
    nextCursor = null;
  } else {
    nextCursor = parseCursor(continuation.nextCursor, graph);
    if (
      nextCursor.partitionSize !== partitionSize ||
      nextCursor.taskOffset !== nextTaskOffset
    ) invalid(expectedProjectId);
  }
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: COMPILE_CONTINUATION_SCHEMA_VERSION,
    projectId: graph.projectId,
    snapshotDigest: graph.snapshotDigest,
    graphDigest: graph.graphDigest,
    policyDigest: graph.policyDigest,
    partitionSize,
    nextTaskOffset,
    nextCursor,
    acceptedPartitionDigests,
    complete,
  });
  const continuationDigest = digest(continuation.continuationDigest, expectedProjectId);
  if (continuationDigest !== digestHierarchyValue(continuationWithoutDigest(
    parsedWithoutDigest,
  ))) invalid(expectedProjectId);
  return Object.freeze({ ...parsedWithoutDigest, continuationDigest });
}

function partitionWithoutDigest(
  partition: Omit<CompilePartitionV2, 'partitionDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: partition.schemaVersion,
    projectId: partition.projectId,
    snapshotDigest: partition.snapshotDigest,
    graphDigest: partition.graphDigest,
    policyDigest: partition.policyDigest,
    taskOffset: partition.taskOffset,
    taskDispositions: partition.taskDispositions,
    relationDispositions: partition.relationDispositions,
    complete: partition.complete,
    nextCursor: partition.nextCursor,
  };
}

export interface CompileContinuationAdvanceV2 {
  readonly partition: CompilePartitionV2;
  readonly continuation: CompileContinuationV2;
}

export function advanceCompileContinuation(
  graphValue: SparseRelationGraphV1,
  continuationValue: CompileContinuationV2,
  cursorValue: CompilePartitionCursorV2,
  expectedProjectId: string,
): CompileContinuationAdvanceV2 {
  const graph = parseSparseRelationGraph(graphValue, expectedProjectId);
  const continuation = parseCompileContinuation(
    continuationValue,
    graph,
    expectedProjectId,
  );
  if (continuation.complete || continuation.nextCursor === null) invalid(expectedProjectId);
  const cursor = parseCursor(cursorValue, graph);
  if (cursor.cursorDigest !== continuation.nextCursor.cursorDigest) invalid(expectedProjectId);
  const end = Math.min(cursor.taskOffset + cursor.partitionSize, graph.tasks.length);
  const selectedTasks = graph.tasks.slice(cursor.taskOffset, end);
  const selectedTaskIds = new Set(selectedTasks.map((task) => task.taskId));
  const taskDispositions = Object.freeze(selectedTasks.map((task): TaskDispositionV1 =>
    Object.freeze({ taskId: task.taskId, disposition: 'planned' })));
  const relationDispositions = Object.freeze(graph.relations
    .filter((relation) => selectedTaskIds.has(relation.ownerTaskId))
    .map((relation): RelationDispositionV1 => Object.freeze({
      relationId: relation.relationId,
      disposition: 'candidate',
    })));
  const complete = end === graph.tasks.length;
  const nextCursor = complete ? null : createCursor(graph, cursor.partitionSize, end);
  const partitionCandidate = Object.freeze({
    schemaVersion: COMPILE_PARTITION_SCHEMA_VERSION,
    projectId: graph.projectId,
    snapshotDigest: graph.snapshotDigest,
    graphDigest: graph.graphDigest,
    policyDigest: graph.policyDigest,
    taskOffset: cursor.taskOffset,
    taskDispositions,
    relationDispositions,
    complete,
    nextCursor,
  });
  const partition = Object.freeze({
    ...partitionCandidate,
    partitionDigest: digestHierarchyValue(partitionWithoutDigest(partitionCandidate)),
  });
  const nextContinuation = createContinuation(
    graph,
    cursor.partitionSize,
    end,
    [...continuation.acceptedPartitionDigests, partition.partitionDigest],
  );
  return Object.freeze({ partition, continuation: nextContinuation });
}

function parseTaskDispositions(
  value: unknown,
  projectId: string,
): readonly TaskDispositionV1[] {
  if (!Array.isArray(value) || value.length < 1 ||
      value.length > HIERARCHICAL_COMPILATION_LIMITS.maxPartitionTasks) invalid(projectId);
  return Object.freeze(value.map((item) => {
    const disposition = record(item, projectId);
    exactKeys(disposition, ['disposition', 'taskId'], projectId);
    if (disposition.disposition !== 'planned') invalid(projectId);
    return Object.freeze({
      taskId: identifier(disposition.taskId, TASK_ID_PATTERN, projectId),
      disposition: 'planned' as const,
    });
  }));
}

function parseRelationDispositions(
  value: unknown,
  projectId: string,
): readonly RelationDispositionV1[] {
  if (!Array.isArray(value)) invalid(projectId);
  return Object.freeze(value.map((item) => {
    const disposition = record(item, projectId);
    exactKeys(disposition, ['disposition', 'relationId'], projectId);
    if (disposition.disposition !== 'candidate') invalid(projectId);
    return Object.freeze({
      relationId: identifier(disposition.relationId, RELATION_ID_PATTERN, projectId),
      disposition: 'candidate' as const,
    });
  }));
}

export function parseCompilePartition(
  value: unknown,
  graphValue: SparseRelationGraphV1,
  expectedProjectId: string,
): CompilePartitionV2 {
  const graph = parseSparseRelationGraph(graphValue, expectedProjectId);
  const partition = record(value, expectedProjectId);
  exactKeys(partition, [
    'complete', 'graphDigest', 'nextCursor', 'partitionDigest', 'policyDigest',
    'projectId', 'relationDispositions', 'schemaVersion', 'snapshotDigest',
    'taskDispositions', 'taskOffset',
  ], expectedProjectId);
  const taskDispositions = parseTaskDispositions(partition.taskDispositions, expectedProjectId);
  const relationDispositions = parseRelationDispositions(
    partition.relationDispositions,
    expectedProjectId,
  );
  const complete = partition.complete === true;
  let nextCursor: CompilePartitionCursorV2 | null;
  if (complete) {
    if (partition.nextCursor !== null) invalid(expectedProjectId);
    nextCursor = null;
  } else {
    nextCursor = parseCursor(partition.nextCursor, graph);
  }
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: partition.schemaVersion,
    projectId: partition.projectId,
    snapshotDigest: partition.snapshotDigest,
    graphDigest: partition.graphDigest,
    policyDigest: partition.policyDigest,
    taskOffset: integer(partition.taskOffset, 0, graph.tasks.length - 1, expectedProjectId),
    taskDispositions,
    relationDispositions,
    complete,
    nextCursor,
  });
  if (
    parsedWithoutDigest.schemaVersion !== COMPILE_PARTITION_SCHEMA_VERSION ||
    parsedWithoutDigest.projectId !== graph.projectId ||
    parsedWithoutDigest.snapshotDigest !== graph.snapshotDigest ||
    parsedWithoutDigest.graphDigest !== graph.graphDigest ||
    parsedWithoutDigest.policyDigest !== graph.policyDigest
  ) invalid(expectedProjectId);
  const partitionDigest = digest(partition.partitionDigest, expectedProjectId);
  if (partitionDigest !== digestHierarchyValue(partitionWithoutDigest(
    parsedWithoutDigest as Omit<CompilePartitionV2, 'partitionDigest'>,
  ))) invalid(expectedProjectId);
  return Object.freeze({
    ...(parsedWithoutDigest as Omit<CompilePartitionV2, 'partitionDigest'>),
    partitionDigest,
  });
}

function inventoryWithoutDigest(
  inventory: Omit<PlanningDispositionInventoryV1, 'inventoryDigest'>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: inventory.schemaVersion,
    projectId: inventory.projectId,
    snapshotDigest: inventory.snapshotDigest,
    graphDigest: inventory.graphDigest,
    policyDigest: inventory.policyDigest,
    taskCount: inventory.taskCount,
    relationCount: inventory.relationCount,
    taskDispositionDigest: inventory.taskDispositionDigest,
    relationDispositionDigest: inventory.relationDispositionDigest,
    dispositionDigest: inventory.dispositionDigest,
    complete: inventory.complete,
  };
}

export function finalizePlanningDispositionInventory(
  graphValue: SparseRelationGraphV1,
  continuationValue: CompileContinuationV2,
  partitionValues: readonly CompilePartitionV2[],
  expectedProjectId: string,
): PlanningDispositionInventoryV1 {
  const graph = parseSparseRelationGraph(graphValue, expectedProjectId);
  const continuation = parseCompileContinuation(
    continuationValue,
    graph,
    expectedProjectId,
  );
  if (!continuation.complete || partitionValues.length !==
      continuation.acceptedPartitionDigests.length) invalid(expectedProjectId);
  const taskDispositions: TaskDispositionV1[] = [];
  const relationDispositions: RelationDispositionV1[] = [];
  for (let index = 0; index < partitionValues.length; index += 1) {
    const partitionValue = partitionValues[index];
    if (partitionValue === undefined) invalid(expectedProjectId);
    const partition = parseCompilePartition(partitionValue, graph, expectedProjectId);
    const expectedOffset = index * continuation.partitionSize;
    const expectedTasks = graph.tasks.slice(
      expectedOffset,
      Math.min(expectedOffset + continuation.partitionSize, graph.tasks.length),
    );
    const expectedTaskIds = expectedTasks.map((task) => task.taskId);
    const expectedTaskIdSet = new Set(expectedTaskIds);
    const expectedRelationIds = graph.relations
      .filter((relation) => expectedTaskIdSet.has(relation.ownerTaskId))
      .map((relation) => relation.relationId);
    if (
      partition.partitionDigest !== continuation.acceptedPartitionDigests[index] ||
      partition.taskOffset !== expectedOffset ||
      !sameArray(partition.taskDispositions.map((item) => item.taskId), expectedTaskIds) ||
      !sameArray(
        partition.relationDispositions.map((item) => item.relationId),
        expectedRelationIds,
      ) ||
      partition.complete !== (index === partitionValues.length - 1) ||
      (partition.nextCursor?.taskOffset ?? graph.tasks.length) !==
        Math.min(expectedOffset + continuation.partitionSize, graph.tasks.length)
    ) invalid(expectedProjectId);
    taskDispositions.push(...partition.taskDispositions);
    relationDispositions.push(...partition.relationDispositions);
  }
  const expectedTaskIds = graph.tasks.map((task) => task.taskId);
  const expectedRelationIds = graph.relations.map((relation) => relation.relationId);
  if (
    !sameArray(taskDispositions.map((item) => item.taskId), expectedTaskIds) ||
    !sameArray(relationDispositions.map((item) => item.relationId), expectedRelationIds) ||
    new Set(taskDispositions.map((item) => item.taskId)).size !== expectedTaskIds.length ||
    new Set(relationDispositions.map((item) => item.relationId)).size !==
      expectedRelationIds.length
  ) invalid(expectedProjectId);
  const taskDispositionDigest = digestHierarchyValue(taskDispositions);
  const relationDispositionDigest = digestHierarchyValue(relationDispositions);
  const dispositionDigest = digestHierarchyValue({
    taskDispositionDigest,
    relationDispositionDigest,
  });
  const candidate = Object.freeze({
    schemaVersion: PLANNING_DISPOSITION_INVENTORY_SCHEMA_VERSION,
    projectId: graph.projectId,
    snapshotDigest: graph.snapshotDigest,
    graphDigest: graph.graphDigest,
    policyDigest: graph.policyDigest,
    taskCount: taskDispositions.length,
    relationCount: relationDispositions.length,
    taskDispositionDigest,
    relationDispositionDigest,
    dispositionDigest,
    complete: true as const,
  });
  return parsePlanningDispositionInventory(Object.freeze({
    ...candidate,
    inventoryDigest: digestHierarchyValue(inventoryWithoutDigest(candidate)),
  }), graph, expectedProjectId);
}

export function parsePlanningDispositionInventory(
  value: unknown,
  graphValue: SparseRelationGraphV1,
  expectedProjectId: string,
): PlanningDispositionInventoryV1 {
  const graph = parseSparseRelationGraph(graphValue, expectedProjectId);
  const inventory = record(value, expectedProjectId);
  exactKeys(inventory, [
    'complete', 'dispositionDigest', 'graphDigest', 'inventoryDigest', 'policyDigest',
    'projectId', 'relationCount', 'relationDispositionDigest', 'schemaVersion',
    'snapshotDigest', 'taskCount', 'taskDispositionDigest',
  ], expectedProjectId);
  const taskCount = integer(inventory.taskCount, 1,
    HIERARCHICAL_COMPILATION_LIMITS.maxTasks, expectedProjectId);
  const relationCount = integer(inventory.relationCount, 0,
    Number.MAX_SAFE_INTEGER, expectedProjectId);
  const taskDispositionDigest = digest(inventory.taskDispositionDigest, expectedProjectId);
  const relationDispositionDigest = digest(
    inventory.relationDispositionDigest,
    expectedProjectId,
  );
  const dispositionDigest = digest(inventory.dispositionDigest, expectedProjectId);
  const parsedWithoutDigest = Object.freeze({
    schemaVersion: inventory.schemaVersion,
    projectId: inventory.projectId,
    snapshotDigest: inventory.snapshotDigest,
    graphDigest: inventory.graphDigest,
    policyDigest: inventory.policyDigest,
    taskCount,
    relationCount,
    taskDispositionDigest,
    relationDispositionDigest,
    dispositionDigest,
    complete: inventory.complete,
  });
  const expectedTaskDispositions = graph.tasks.map((task): TaskDispositionV1 => ({
    taskId: task.taskId,
    disposition: 'planned',
  }));
  const expectedRelationDispositions = graph.relations.map(
    (relation): RelationDispositionV1 => ({
      relationId: relation.relationId,
      disposition: 'candidate',
    }),
  );
  if (
    parsedWithoutDigest.schemaVersion !==
      PLANNING_DISPOSITION_INVENTORY_SCHEMA_VERSION ||
    parsedWithoutDigest.projectId !== graph.projectId ||
    parsedWithoutDigest.snapshotDigest !== graph.snapshotDigest ||
    parsedWithoutDigest.graphDigest !== graph.graphDigest ||
    parsedWithoutDigest.policyDigest !== graph.policyDigest ||
    parsedWithoutDigest.complete !== true ||
    taskCount !== graph.tasks.length ||
    relationCount !== graph.relations.length ||
    taskDispositionDigest !== digestHierarchyValue(expectedTaskDispositions) ||
    relationDispositionDigest !== digestHierarchyValue(expectedRelationDispositions) ||
    dispositionDigest !== digestHierarchyValue({
      taskDispositionDigest,
      relationDispositionDigest,
    })
  ) invalid(expectedProjectId);
  const inventoryDigest = digest(inventory.inventoryDigest, expectedProjectId);
  if (inventoryDigest !== digestHierarchyValue(inventoryWithoutDigest(
    parsedWithoutDigest as Omit<PlanningDispositionInventoryV1, 'inventoryDigest'>,
  ))) invalid(expectedProjectId);
  return Object.freeze({
    ...(parsedWithoutDigest as Omit<PlanningDispositionInventoryV1, 'inventoryDigest'>),
    inventoryDigest,
  });
}
