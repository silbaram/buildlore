import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';

import { ProjectionError } from './errors.js';
import type {
  CanonicalTaskLineage,
  ExecutionArtifactBinding,
  ExecutionAttempt,
  ExecutionCandidate,
  ExecutionProjectionPlanEntry,
  ExecutionQuarantineReason,
  ObservedP2aRun,
  P2aExecutionArtifactAdapter,
  P2aExecutionSelection,
  P2aRunIndexEntry,
} from './execution-types.js';
import { EXECUTION_INCLUSION_POLICY_VERSION } from './execution-types.js';
import {
  canonicalExecutionJson,
  decodeP2aRun,
  decodeP2aRunIndex,
  decodeP2aTaskGraph,
  isP2aExecutionRecord,
  resolveTaskLineage,
} from './p2a-execution-codecs.js';
import {
  applyExecutionInclusionPolicy,
  compareExecutionAttempts,
  filterDurableExecutionChanges,
} from './p2a-execution-policy.js';
import { renderP2aExecutionKnowledge } from './p2a-execution-render.js';

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_URI_LENGTH = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_FILE_PATTERN = /^run-[A-Za-z0-9._-]+\.json$/u;
const RUN_SIDECAR_SUFFIXES = [
  '.acceptance-review.json',
  '.memory-recall.json',
  '.monitor-gate.json',
  '.monitor-verdict.json',
  '.orchestration-runtime.json',
  '.orchestration.json',
  '.style-verdict.json',
  '.visual-review.json',
] as const;

interface SafeArtifact {
  readonly bytes: Buffer;
  readonly relativePath: string;
  readonly revision: `sha256:${string}`;
}

interface CurrentSpec {
  readonly closed: ReadonlyMap<string, Readonly<{
    artifactHashes: Readonly<Record<string, unknown>>;
    record: Readonly<Record<string, unknown>>;
    specRef: string;
    taskGraphRef: string;
  }>>;
}

interface VerifiedRun {
  readonly attempt: ExecutionAttempt;
  readonly lineage: CanonicalTaskLineage;
}

interface RunInventory {
  readonly canonicalRunRefs: readonly string[];
  readonly revision: `sha256:${string}`;
  readonly unsafe: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(
  code: ConstructorParameters<typeof ProjectionError>[0],
  message: string,
): never {
  throw new ProjectionError(code, message);
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

function safeRelativePath(value: string): boolean {
  return ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  }) && !value.includes('\\') && !value.startsWith('/') &&
    !/^[A-Za-z]:\//u.test(value) && posix.normalize(value) === value &&
    value !== '..' && !value.startsWith('../');
}

function isCanonicalRunFileName(value: string): boolean {
  return value !== 'run-index.json' && RUN_FILE_PATTERN.test(value) &&
    !RUN_SIDECAR_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

async function canonicalRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    const status = await lstat(absolute);
    const canonical = await realpath(absolute);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== absolute) {
      return fail('PROJECTION_PATH_UNSAFE', 'The execution artifact root is unsafe.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_PATH_UNSAFE', 'The execution artifact root is unavailable.');
  }
}

async function scanRunInventory(root: string): Promise<RunInventory> {
  const runsRoot = join(root, 'runs');
  let entries;
  try {
    const status = await lstat(runsRoot);
    const canonical = await realpath(runsRoot);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== runsRoot) {
      return fail('PROJECTION_PATH_UNSAFE', 'The execution run inventory is unsafe.');
    }
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_PATH_UNSAFE', 'The execution run inventory is unavailable.');
  }
  const canonicalRunRefs: string[] = [];
  let unsafe = false;
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (isCanonicalRunFileName(entry.name)) {
      if (entry.isFile()) canonicalRunRefs.push(entry.name);
      else unsafe = true;
      continue;
    }
    if (!entry.isDirectory()) continue;
    let children;
    try {
      children = await readdir(join(runsRoot, entry.name), { withFileTypes: true });
    } catch {
      unsafe = true;
      continue;
    }
    for (const child of children.sort((left, right) => compareText(left.name, right.name))) {
      if (!isCanonicalRunFileName(child.name)) continue;
      if (child.isFile()) canonicalRunRefs.push(`${entry.name}/${child.name}`);
      else unsafe = true;
    }
  }
  canonicalRunRefs.sort(compareText);
  return {
    canonicalRunRefs,
    revision: sha256(canonicalExecutionJson(canonicalRunRefs)),
    unsafe,
  };
}

async function readArtifact(root: string, relativePath: string): Promise<SafeArtifact> {
  if (!safeRelativePath(relativePath)) {
    return fail('PROJECTION_PATH_UNSAFE', 'An execution artifact path is unsafe.');
  }
  const path = join(root, ...relativePath.split('/'));
  let expected: Awaited<ReturnType<typeof lstat>>;
  try {
    expected = await lstat(path);
    const canonical = await realpath(path);
    if (
      !expected.isFile() || expected.isSymbolicLink() ||
      expected.size > MAX_ARTIFACT_BYTES || canonical !== path || !isContained(root, canonical)
    ) return fail('PROJECTION_PATH_UNSAFE', 'An execution artifact is unsafe.');
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_PATH_UNSAFE', 'An execution artifact is unavailable.');
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (
      !actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
      actual.size > MAX_ARTIFACT_BYTES
    ) return fail('PROJECTION_PATH_UNSAFE', 'An execution artifact changed while being read.');
    const bytes = await handle.readFile();
    return { bytes, relativePath, revision: sha256(bytes) };
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_ARTIFACT_INVALID', 'An execution artifact is unreadable.');
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the safe read failure.
    }
  }
}

function parseJson(artifact: SafeArtifact): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function decodeCurrentSpec(value: unknown, projectId: string): CurrentSpec | null {
  if (!isP2aExecutionRecord(value) || value.schema_version !== 'p2a.current_spec.v1' ||
    value.project_id !== projectId || !Array.isArray(value.closed_iterations)) return null;
  const closed = new Map<string, {
    artifactHashes: Readonly<Record<string, unknown>>;
    record: Readonly<Record<string, unknown>>;
    specRef: string;
    taskGraphRef: string;
  }>();
  for (const item of value.closed_iterations) {
    if (!isP2aExecutionRecord(item) || item.status !== 'archived' ||
      typeof item.iteration_id !== 'string' || typeof item.task_graph_ref !== 'string' ||
      typeof item.spec_ref !== 'string' ||
      !isP2aExecutionRecord(item.artifact_hashes)) return null;
    if (closed.has(item.iteration_id)) return null;
    closed.set(item.iteration_id, {
      artifactHashes: item.artifact_hashes,
      record: item,
      specRef: item.spec_ref,
      taskGraphRef: item.task_graph_ref,
    });
  }
  return { closed };
}

function recordedArtifactHash(value: unknown): string | null {
  if (!isP2aExecutionRecord(value) ||
    Object.keys(value).sort().join(',') !== 'present,sha256' ||
    value.present !== true || typeof value.sha256 !== 'string' ||
    !SHA256_PATTERN.test(value.sha256)) return null;
  return value.sha256;
}

function quarantineEntry(
  summary: P2aRunIndexEntry,
  reasonCode: ExecutionQuarantineReason,
  revision?: `sha256:${string}`,
): ExecutionProjectionPlanEntry {
  return {
    attempts: revision === undefined ? [] : [{
      runId: summary.runId,
      runRef: summary.runRef,
      runRevision: revision,
      status: summary.status,
    }],
    decision: 'quarantine',
    reasonCode,
  };
}

function excludeStarted(
  summary: P2aRunIndexEntry,
  revision: `sha256:${string}`,
): ExecutionProjectionPlanEntry {
  return {
    attempts: [{
      runId: summary.runId,
      runRef: summary.runRef,
      runRevision: revision,
      status: summary.status,
    }],
    decision: 'exclude',
    reasonCode: 'started',
  };
}

function exactIndexMatch(summary: P2aRunIndexEntry, run: ObservedP2aRun): boolean {
  return summary.runId === run.runId && summary.taskId === run.taskId &&
    summary.iterationId === run.iterationId && summary.status === run.status &&
    summary.startedAt === run.startedAt && summary.finishedAt === run.finishedAt;
}

function resolveReference(graphRef: string, reference: string): string | null {
  if (reference.includes('\\') || reference.startsWith('/') || /^[A-Za-z]:\//u.test(reference)) {
    return null;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(graphRef), reference));
  return safeRelativePath(resolved) ? resolved : null;
}

function normalizedAttempt(
  summary: P2aRunIndexEntry,
  run: ObservedP2aRun,
  runRevision: `sha256:${string}`,
  sourceGateRefs: ExecutionAttempt['sourceGateRefs'],
): ExecutionAttempt {
  const verification = new Map<string, ObservedP2aRun['verification'][number]>();
  for (const item of run.verification) {
    verification.set(canonicalExecutionJson(item), item);
  }
  return {
    changedFiles: [...new Set(filterDurableExecutionChanges(run.changedFiles))].sort(compareText),
    ...(run.failureClass === undefined ? {} : { failureClass: run.failureClass }),
    finishedAt: run.finishedAt,
    fixSummaries: run.fixSummaries,
    guardChecks: run.guardChecks,
    guardNotes: run.guardNotes,
    localizationFiles: [...new Set(run.localizationFiles)].sort(compareText),
    localizationFindings: run.localizationFindings,
    reproductionSteps: run.reproductionSteps,
    runId: run.runId,
    runRef: summary.runRef,
    runRevision,
    sourceGateRefs,
    startedAt: run.startedAt,
    status: run.status,
    verification: [...verification.values()].sort((left, right) => {
      const byStart = compareText(left.startedAt ?? '', right.startedAt ?? '');
      if (byStart !== 0) return byStart;
      const byType = compareText(left.type, right.type);
      return byType !== 0 ? byType : compareText(left.command, right.command);
    }),
  };
}

function logicalKey(lineage: CanonicalTaskLineage): string {
  return canonicalExecutionJson({
    graphRef: lineage.graphRef,
    iterationId: lineage.iterationId,
    taskContractSha256: lineage.taskContractSha256,
    taskId: lineage.taskId,
  });
}

function portableSourceUri(
  repository: string,
  projectId: string,
  lineage: CanonicalTaskLineage,
): string {
  return [
    'buildlore+p2a:',
    encodeURIComponent(repository),
    encodeURIComponent(projectId),
    encodeURIComponent(lineage.iterationId),
    'execution-task',
    encodeURIComponent(lineage.graphRef),
    encodeURIComponent(lineage.taskId),
    lineage.taskContractSha256,
  ].join('/');
}

function planAttempts(attempts: readonly ExecutionAttempt[]): ExecutionProjectionPlanEntry['attempts'] {
  return attempts.map((attempt) => ({
    runId: attempt.runId,
    runRef: attempt.runRef,
    runRevision: attempt.runRevision,
    status: attempt.status,
  }));
}

function createChainSelection(
  repository: string,
  projectId: string,
  lineage: CanonicalTaskLineage,
  attempts: readonly ExecutionAttempt[],
): Readonly<{
  candidate?: ExecutionCandidate;
  entries: readonly ExecutionProjectionPlanEntry[];
}> {
  const policy = applyExecutionInclusionPolicy(attempts);
  const entries: ExecutionProjectionPlanEntry[] = policy.excluded.map((item) => ({
    attempts: planAttempts([item.attempt]),
    decision: 'exclude',
    lineage,
    reasonCode: item.reasonCode,
  }));
  if (policy.reasonCode === undefined || policy.included.length === 0) return { entries };
  const sourceUri = portableSourceUri(repository, projectId, lineage);
  if (sourceUri.length > MAX_SOURCE_URI_LENGTH) return {
    entries: [...entries, {
      attempts: planAttempts(policy.included),
      decision: 'quarantine',
      lineage,
      reasonCode: 'path_unsafe',
    }],
  };
  const taskStableId = sha256(sourceUri).slice('sha256:'.length);
  const sourceRevision = sha256(canonicalExecutionJson({
    attempts: policy.included.map((attempt) => ({
      runId: attempt.runId,
      runRef: attempt.runRef,
      runRevision: attempt.runRevision,
    })),
    lineage: {
      graphRef: lineage.graphRef,
      graphRevision: lineage.graphRevision,
      iterationId: lineage.iterationId,
      sourceSpecRef: lineage.sourceSpecRef,
      sourceSpecRevision: lineage.sourceSpecRevision,
      taskContractSha256: lineage.taskContractSha256,
      taskId: lineage.taskId,
    },
    policyVersion: EXECUTION_INCLUSION_POLICY_VERSION,
    schemaVersion: 'buildlore.execution-source-revision.v1',
  }));
  const ingestedAt = policy.included
    .map((attempt) => attempt.finishedAt)
    .filter((value): value is string => value !== null)
    .sort(compareText)
    .at(-1);
  if (ingestedAt === undefined) return {
    entries: [...entries, {
      attempts: planAttempts(policy.included),
      decision: 'quarantine',
      lineage,
      reasonCode: 'timestamp_invalid',
    }],
  };
  const candidate: ExecutionCandidate = {
    attempts: policy.included,
    body: renderP2aExecutionKnowledge(lineage, policy.included),
    ingestedAt,
    lineage,
    reasonCode: policy.reasonCode,
    sourceRevision,
    sourceUri,
    target: `execution--${taskStableId}.md`,
    taskStableId,
    title: `${lineage.taskTitle} execution knowledge`,
  };
  entries.push({
    attempts: planAttempts(policy.included),
    decision: 'include',
    lineage,
    reasonCode: policy.reasonCode,
    sourceRevision,
    sourceUri,
    target: candidate.target,
    taskStableId,
  });
  return { candidate, entries };
}

export function createP2aExecutionArtifactAdapter(): P2aExecutionArtifactAdapter {
  const inventories = new WeakMap<P2aExecutionSelection, RunInventory>();
  const bindInventory = (
    selection: P2aExecutionSelection,
    inventory: RunInventory,
  ): P2aExecutionSelection => {
    inventories.set(selection, inventory);
    return selection;
  };
  return {
    async read(input, repository): Promise<P2aExecutionSelection> {
      const root = await canonicalRoot(input.artifactRoot);
      const inventory = await scanRunInventory(root);
      const bindings = new Map<string, ExecutionArtifactBinding>();
      const bind = (artifact: SafeArtifact): void => {
        bindings.set(artifact.relativePath, {
          relativePath: artifact.relativePath,
          revision: artifact.revision,
        });
      };
      const indexArtifact = await readArtifact(root, 'runs/run-index.json');
      bind(indexArtifact);
      const decodedIndex = decodeP2aRunIndex(parseJson(indexArtifact), input.projectId);
      if (!decodedIndex.ok) return bindInventory({
        artifactRoot: root,
        bindings: [...bindings.values()],
        candidates: [],
        entries: [{ attempts: [], decision: 'quarantine', reasonCode: decodedIndex.reasonCode }],
      }, inventory);
      const currentArtifact = await readArtifact(root, 'current-spec.json');
      bind(currentArtifact);
      const current = decodeCurrentSpec(parseJson(currentArtifact), input.projectId);
      if (current === null) return bindInventory({
        artifactRoot: root,
        bindings: [...bindings.values()],
        candidates: [],
        entries: [{ attempts: [], decision: 'quarantine', reasonCode: 'lineage_missing' }],
      }, inventory);

      const entries: ExecutionProjectionPlanEntry[] = [];
      if (inventory.unsafe) {
        entries.push({ attempts: [], decision: 'quarantine', reasonCode: 'path_unsafe' });
      }
      const indexedRunRefs = new Set(decodedIndex.value.runs.map((run) => run.runRef));
      if (inventory.canonicalRunRefs.some((runRef) => !indexedRunRefs.has(runRef))) {
        entries.push({
          attempts: [],
          decision: 'quarantine',
          reasonCode: 'run_reference_invalid',
        });
      }
      const verified: VerifiedRun[] = [];
      const lineageCache = new Map<string, Readonly<{
        graph: ReturnType<typeof decodeP2aTaskGraph>;
        graphArtifact: SafeArtifact;
      }> | null>();
      for (const summary of decodedIndex.value.runs) {
        let runArtifact: SafeArtifact;
        try {
          runArtifact = await readArtifact(root, `runs/${summary.runRef}`);
        } catch {
          entries.push(quarantineEntry(summary, 'path_unsafe'));
          continue;
        }
        bind(runArtifact);
        const decodedRun = decodeP2aRun(parseJson(runArtifact), input.projectId);
        if (!decodedRun.ok) {
          entries.push(quarantineEntry(summary, decodedRun.reasonCode, runArtifact.revision));
          continue;
        }
        if (!exactIndexMatch(summary, decodedRun.value)) {
          entries.push(quarantineEntry(summary, 'run_hash_mismatch', runArtifact.revision));
          continue;
        }
        if (decodedRun.value.status === 'started') {
          entries.push(excludeStarted(summary, runArtifact.revision));
          continue;
        }

        const graphRef = `iterations/${decodedRun.value.iterationId}/gate-c-task-graph/task-graph.json`;
        let cached = lineageCache.get(decodedRun.value.iterationId);
        if (cached === undefined) {
          const closed = current.closed.get(decodedRun.value.iterationId);
          if (closed === undefined || closed.taskGraphRef !== graphRef) {
            cached = null;
          } else {
            try {
              const graphArtifact = await readArtifact(root, graphRef);
              const iterationArtifact = await readArtifact(
                root,
                `iterations/${decodedRun.value.iterationId}/iteration.json`,
              );
              bind(graphArtifact);
              bind(iterationArtifact);
              const iteration = parseJson(iterationArtifact);
              const expectedGraphHash = recordedArtifactHash(closed.artifactHashes[graphRef]);
              if (!isP2aExecutionRecord(iteration) || iteration.status !== 'archived' ||
                iteration.schema_version !== 'p2a.iteration_metadata.v1' ||
                iteration.project_id !== input.projectId ||
                iteration.iteration_id !== decodedRun.value.iterationId ||
                !isP2aExecutionRecord(iteration.close) ||
                canonicalExecutionJson(iteration.close) !== canonicalExecutionJson(closed.record) ||
                expectedGraphHash === null ||
                graphArtifact.revision !== `sha256:${expectedGraphHash}`) {
                cached = null;
              } else {
                cached = {
                  graph: decodeP2aTaskGraph(parseJson(graphArtifact), input.projectId),
                  graphArtifact,
                };
              }
            } catch {
              cached = null;
            }
          }
          lineageCache.set(decodedRun.value.iterationId, cached);
        }
        if (cached === null) {
          entries.push(quarantineEntry(summary, 'lineage_missing', runArtifact.revision));
          continue;
        }
        if (!cached.graph.ok) {
          entries.push(quarantineEntry(summary, cached.graph.reasonCode, runArtifact.revision));
          continue;
        }
        if (cached.graph.value.version !== decodedRun.value.iterationId) {
          entries.push(quarantineEntry(summary, 'lineage_mismatch', runArtifact.revision));
          continue;
        }
        const sourceSpecRef = resolveReference(graphRef, decodedRun.value.sourceSpecRef);
        if (sourceSpecRef === null || sourceSpecRef !==
          resolveReference(graphRef, cached.graph.value.sourceSpec) ||
          sourceSpecRef !== current.closed.get(decodedRun.value.iterationId)?.specRef) {
          entries.push(quarantineEntry(summary, 'lineage_mismatch', runArtifact.revision));
          continue;
        }
        let sourceSpecArtifact: SafeArtifact;
        try {
          sourceSpecArtifact = await readArtifact(root, sourceSpecRef);
          bind(sourceSpecArtifact);
          const expectedSpecHash = recordedArtifactHash(
            current.closed.get(decodedRun.value.iterationId)?.artifactHashes[sourceSpecRef],
          );
          if (expectedSpecHash === null ||
            sourceSpecArtifact.revision !== `sha256:${expectedSpecHash}`) {
            entries.push(quarantineEntry(summary, 'lineage_mismatch', runArtifact.revision));
            continue;
          }
        } catch {
          entries.push(quarantineEntry(summary, 'lineage_missing', runArtifact.revision));
          continue;
        }
        const lineage = resolveTaskLineage(
          cached.graph.value,
          graphRef,
          cached.graphArtifact.revision,
          sourceSpecRef,
          sourceSpecArtifact.revision,
          decodedRun.value,
        );
        if (!lineage.ok) {
          entries.push(quarantineEntry(summary, lineage.reasonCode, runArtifact.revision));
          continue;
        }
        const sourceGateRefs: Array<{
          relativePath: string;
          revision: `sha256:${string}`;
        }> = [];
        let gateRefsValid = true;
        for (const gateRef of decodedRun.value.sourceGateRefs) {
          const resolved = resolveReference(graphRef, gateRef.path);
          if (resolved === null ||
            !resolved.startsWith(`iterations/${decodedRun.value.iterationId}/`)) {
            gateRefsValid = false;
            break;
          }
          sourceGateRefs.push({
            relativePath: resolved,
            revision: `sha256:${gateRef.sha256}`,
          });
        }
        if (!gateRefsValid) {
          entries.push(quarantineEntry(summary, 'lineage_mismatch', runArtifact.revision));
          continue;
        }
        verified.push({
          attempt: normalizedAttempt(
            summary,
            decodedRun.value,
            runArtifact.revision,
            sourceGateRefs.sort((left, right) => compareText(
              `${left.relativePath}\u0000${left.revision}`,
              `${right.relativePath}\u0000${right.revision}`,
            )),
          ),
          lineage: lineage.value,
        });
      }

      const grouped = new Map<string, VerifiedRun[]>();
      for (const item of verified) {
        const key = logicalKey(item.lineage);
        const existing = grouped.get(key) ?? [];
        existing.push(item);
        grouped.set(key, existing);
      }
      const candidates: ExecutionCandidate[] = [];
      const firstLineage = (group: readonly VerifiedRun[]): CanonicalTaskLineage => {
        const first = group[0];
        return first === undefined
          ? fail('PROJECTION_ARTIFACT_INVALID', 'Execution lineage is unavailable.')
          : first.lineage;
      };
      for (const group of [...grouped.values()].sort((left, right) =>
        compareText(logicalKey(firstLineage(left)), logicalKey(firstLineage(right))))) {
        const first = group[0];
        if (first === undefined) continue;
        const selection = createChainSelection(
          repository,
          input.projectId,
          first.lineage,
          group.map((item) => item.attempt).sort(compareExecutionAttempts),
        );
        entries.push(...selection.entries);
        if (selection.candidate !== undefined) candidates.push(selection.candidate);
      }
      return bindInventory({
        artifactRoot: root,
        bindings: [...bindings.values()].sort((left, right) =>
          compareText(left.relativePath, right.relativePath)),
        candidates: candidates.sort((left, right) => compareText(left.sourceUri, right.sourceUri)),
        entries: entries.sort((left, right) => compareText(
          left.attempts[0]?.runRef ?? left.sourceUri ?? '',
          right.attempts[0]?.runRef ?? right.sourceUri ?? '',
        )),
      }, inventory);
    },

    async verify(selection): Promise<void> {
      try {
        const root = await canonicalRoot(selection.artifactRoot);
        const expectedInventory = inventories.get(selection);
        const inventory = await scanRunInventory(root);
        if (expectedInventory === undefined || inventory.unsafe ||
          inventory.revision !== expectedInventory.revision) {
          fail('PROJECTION_ARTIFACT_CHANGED', 'Execution artifacts changed after planning.');
        }
        for (const binding of selection.bindings) {
          const artifact = await readArtifact(root, binding.relativePath);
          if (artifact.revision !== binding.revision) {
            fail('PROJECTION_ARTIFACT_CHANGED', 'Execution artifacts changed after planning.');
          }
        }
      } catch {
        fail('PROJECTION_ARTIFACT_CHANGED', 'Execution artifacts changed after planning.');
      }
    },
  };
}
