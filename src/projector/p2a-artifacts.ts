import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { ProjectionError } from './errors.js';
import {
  type PlanningDocumentKind,
  type PlanningProjectionInput,
  type ProjectionPlanEntry,
  type ProjectionReasonCode,
  type RevisionTimestampPort,
  type TimestampSource,
} from './planning-types.js';
import {
  renderP2aArchive,
  renderP2aImplementation,
  renderP2aIntake,
  renderP2aProduct,
} from './p2a-render.js';
import { matchingP2aApproval, parseP2aDecisionLedger } from './p2a-decision-ledger.js';
import {
  asP2aRecord,
  isP2aRecord,
  requireP2aString,
  validP2aTaskStatusCounts,
  validateP2aClosedIteration,
  validateP2aCurrentSpec,
  validateP2aIntake,
  validateP2aIteration,
  validateP2aSpec,
} from './p2a-codecs.js';
import type { ProjectSourceInput } from './project-source-writer.js';
import { normalizeSourceBody } from './source-document.js';
import { normalizeRfc3339Instant } from './timestamp.js';

const MAX_CANONICAL_ARTIFACT_BYTES = 8 * 1024 * 1024;
const ITERATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface SafeArtifact {
  readonly bytes: Buffer;
  readonly digest: `sha256:${string}`;
  readonly relativePath: string;
}

interface TimestampCandidate {
  readonly source: Exclude<TimestampSource, 'explicit' | 'revision'>;
  readonly value: unknown;
}

export interface P2aPlanningCandidate extends ProjectSourceInput {
  readonly documentKind: PlanningDocumentKind;
  readonly sourceArtifact: string;
  readonly timestampSource: TimestampSource;
}

export interface P2aArtifactBinding {
  readonly sourceArtifact: string;
  readonly sourceRevision: `sha256:${string}`;
}

export interface P2aPlanningSelection {
  readonly artifactRoot: string;
  readonly bindings: readonly P2aArtifactBinding[];
  readonly candidates: readonly P2aPlanningCandidate[];
  readonly entries: readonly ProjectionPlanEntry[];
  readonly scannedFiles: readonly string[];
}

export interface P2aArtifactAdapter {
  read(
    input: PlanningProjectionInput,
    repository: string,
  ): Promise<P2aPlanningSelection>;
  verify(
    artifactRoot: string,
    bindings: readonly P2aArtifactBinding[],
    scannedFiles: readonly string[],
  ): Promise<void>;
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

async function canonicalArtifactRoot(path: string): Promise<string> {
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      return fail('PROJECTION_PATH_UNSAFE', 'The artifact root is unsafe.');
    }
    return await realpath(path);
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_PATH_UNSAFE', 'The artifact root is unavailable.');
  }
}

async function listArtifactFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    try {
      const status = await lstat(directory);
      const canonical = await realpath(directory);
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        canonical !== directory ||
        !isContained(root, canonical)
      ) {
        return fail('PROJECTION_PATH_UNSAFE', 'The artifact tree contains an unsafe directory.');
      }
    } catch (error) {
      if (error instanceof ProjectionError) throw error;
      return fail('PROJECTION_PATH_UNSAFE', 'The artifact tree is unreadable.');
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return fail('PROJECTION_PATH_UNSAFE', 'The artifact tree is unreadable.');
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (
        entry.name.includes('\\') ||
        !isContained(root, path) ||
        posix.normalize(relativePath) !== relativePath ||
        entry.isSymbolicLink()
      ) {
        fail('PROJECTION_PATH_UNSAFE', 'The artifact tree contains an unsafe path.');
      }
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relativePath);
      else fail('PROJECTION_PATH_UNSAFE', 'The artifact tree contains an unsafe file type.');
    }
  };
  await visit(root);
  return files;
}

async function readArtifact(
  root: string,
  relativePath: string,
  knownFiles?: ReadonlySet<string>,
): Promise<SafeArtifact> {
  if (
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    /^[A-Za-z]:\//u.test(relativePath) ||
    posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith('../') ||
    (knownFiles !== undefined && !knownFiles.has(relativePath))
  ) {
    return fail('PROJECTION_PATH_UNSAFE', 'An artifact path is unsafe.');
  }
  const path = join(root, ...relativePath.split('/'));
  try {
    const canonical = await realpath(path);
    if (canonical !== path || !isContained(root, canonical)) {
      return fail('PROJECTION_PATH_UNSAFE', 'A planning artifact path is unsafe.');
    }
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_PATH_UNSAFE', 'A planning artifact is unavailable.');
  }
  let expected: Awaited<ReturnType<typeof lstat>>;
  try {
    expected = await lstat(path);
  } catch {
    return fail('PROJECTION_PATH_UNSAFE', 'A planning artifact is unavailable.');
  }
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.size > MAX_CANONICAL_ARTIFACT_BYTES
  ) {
    return fail('PROJECTION_PATH_UNSAFE', 'A planning artifact is unsafe.');
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.size > MAX_CANONICAL_ARTIFACT_BYTES
    ) {
      return fail('PROJECTION_PATH_UNSAFE', 'A planning artifact changed while being read.');
    }
    const bytes = await handle.readFile();
    return { bytes, digest: sha256(bytes), relativePath };
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_ARTIFACT_INVALID', 'A planning artifact is unreadable.');
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the safe read failure.
    }
  }
}

function parseJson(artifact: SafeArtifact): Record<string, unknown> {
  try {
    return asP2aRecord(JSON.parse(artifact.bytes.toString('utf8')) as unknown);
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_ARTIFACT_INVALID', 'A planning artifact is not valid JSON.');
  }
}

function portableSourceUri(
  repository: string,
  projectId: string,
  iterationId: string,
  documentKind: PlanningDocumentKind,
  artifactPath: string,
): string {
  return [
    'buildlore+p2a:',
    encodeURIComponent(repository),
    encodeURIComponent(projectId),
    encodeURIComponent(iterationId),
    encodeURIComponent(documentKind),
    encodeURIComponent(artifactPath),
  ].join('/');
}

function createCandidate(
  repository: string,
  projectId: string,
  iterationId: string,
  documentKind: PlanningDocumentKind,
  artifact: SafeArtifact,
  timestamp: { readonly source: TimestampSource; readonly value: string },
  title: string,
  body: string,
): P2aPlanningCandidate {
  const sourceUri = portableSourceUri(
    repository,
    projectId,
    iterationId,
    documentKind,
    artifact.relativePath,
  );
  if (sourceUri.length > 4096 || title.length > 500) {
    return fail('PROJECTION_ARTIFACT_INVALID', 'A planning source identity is invalid.');
  }
  let normalizedBody: string;
  try {
    normalizedBody = normalizeSourceBody(body);
  } catch {
    return fail('PROJECTION_ARTIFACT_INVALID', 'A planning document body is invalid.');
  }
  return {
    body: normalizedBody,
    documentKind,
    ingestedAt: timestamp.value,
    sourceArtifact: artifact.relativePath,
    sourceRevision: artifact.digest,
    sourceKind: 'planning',
    sourceUri,
    target: `planning--${sha256(sourceUri).slice('sha256:'.length)}.md`,
    timestampSource: timestamp.source,
    title,
  };
}

function classifyExcluded(path: string): ProjectionReasonCode {
  if (path.startsWith('iterations/maintenance/')) return 'maintenance';
  if (path.startsWith('runs/') || path.includes('/gate-c-task-graph/')) return 'task_or_run';
  if (path.endsWith('.md') && /(?:product-spec|implementation-plan|intake)\.md$/u.test(path)) {
    return 'duplicate_copy';
  }
  if (path.includes('/baseline/') || /(?:README|status)\.md$/u.test(path)) {
    return 'generated_artifact';
  }
  if (/^iterations\/[^/]+\/iteration\.json$/u.test(path)) return 'pending_iteration';
  if (/(?:evidence|review|experience)/u.test(path)) return 'evidence_or_review';
  return 'generated_artifact';
}

function reasonForProjectionError(error: ProjectionError): ProjectionReasonCode {
  switch (error.code) {
    case 'PROJECTION_APPROVAL_INVALID':
      return 'approval_invalid';
    case 'PROJECTION_PATH_UNSAFE':
      return 'path_unsafe';
    case 'PROJECTION_PROJECT_MISMATCH':
      return 'project_mismatch';
    case 'PROJECTION_SOURCE_COLLISION':
      return 'source_collision';
    case 'PROJECTION_TIMESTAMP_UNAVAILABLE':
      return 'timestamp_unavailable';
    case 'PROJECTION_ARTIFACT_CHANGED':
    case 'PROJECTION_ARTIFACT_INVALID':
    case 'PROJECTION_SANITIZATION_FAILED':
    case 'PROJECTION_WRITE_FAILED':
      return 'unsupported_schema';
  }
}

function artifactHashMatches(
  closed: Readonly<Record<string, unknown>>,
  path: string,
  artifact: SafeArtifact,
): boolean {
  const hashes = closed.artifact_hashes;
  if (!isP2aRecord(hashes)) return false;
  const expected = hashes[path];
  return (
    isP2aRecord(expected) &&
    expected.present === true &&
    expected.sha256 === artifact.digest.slice('sha256:'.length)
  );
}

async function resolveTimestamp(
  artifactRoot: string,
  artifact: SafeArtifact,
  primary: readonly TimestampCandidate[],
  explicitTimestamp: string | undefined,
  revisionClock: RevisionTimestampPort | undefined,
): Promise<{ readonly source: TimestampSource; readonly value: string } | null> {
  for (const item of primary) {
    const timestamp = normalizeRfc3339Instant(item.value);
    if (timestamp !== null) return { source: item.source, value: timestamp };
  }
  if (revisionClock !== undefined) {
    try {
      const resolution = await revisionClock.resolveTimestamp({
        artifactRoot,
        sourceArtifact: artifact.relativePath,
        sourceRevision: artifact.digest,
      });
      const timestamp = normalizeRfc3339Instant(resolution?.timestamp);
      if (resolution?.sourceRevision === artifact.digest && timestamp !== null) {
        return { source: 'revision', value: timestamp };
      }
    } catch {
      // A revision clock failure remains a visible missing-timestamp outcome.
    }
  }
  const explicit = normalizeRfc3339Instant(explicitTimestamp);
  return explicit === null ? null : { source: 'explicit', value: explicit };
}

export function createP2aArtifactAdapter(
  revisionClock?: RevisionTimestampPort,
): P2aArtifactAdapter {
  return {
    async read(input, repository): Promise<P2aPlanningSelection> {
      const root = await canonicalArtifactRoot(input.artifactRoot);
      const files = await listArtifactFiles(root);
      const knownFiles = new Set(files);
      const artifacts = new Map<string, SafeArtifact>();
      const bindingMap = new Map<string, P2aArtifactBinding>();
      const read = async (path: string): Promise<SafeArtifact> => {
        const cached = artifacts.get(path);
        if (cached !== undefined) return cached;
        const artifact = await readArtifact(root, path, knownFiles);
        artifacts.set(path, artifact);
        bindingMap.set(path, {
          sourceArtifact: path,
          sourceRevision: artifact.digest,
        });
        return artifact;
      };

      if (!knownFiles.has('current-spec.json') || !knownFiles.has('decisions.jsonl')) {
        return fail('PROJECTION_ARTIFACT_INVALID', 'Required P2A planning artifacts are missing.');
      }
      const current = parseJson(await read('current-spec.json'));
      if (current.project_id !== input.projectId) {
        return fail('PROJECTION_PROJECT_MISMATCH', 'P2A artifacts do not match the selected project.');
      }
      validateP2aCurrentSpec(current, input.projectId);
      const decisions = parseP2aDecisionLedger((await read('decisions.jsonl')).bytes);
      const closedRecords = new Map<string, Record<string, unknown>>();
      for (const value of current.closed_iterations) {
        const closed = asP2aRecord(value);
        validateP2aClosedIteration(closed);
        const iterationId = requireP2aString(closed, 'iteration_id');
        if (closedRecords.has(iterationId)) {
          return fail('PROJECTION_ARTIFACT_INVALID', 'The P2A current specification is invalid.');
        }
        closedRecords.set(iterationId, closed);
      }

      const selected = new Map<string, ProjectionPlanEntry[]>();
      const candidates: P2aPlanningCandidate[] = [];
      const iterationIds = [...new Set(files.flatMap((path) => {
        const match = /^iterations\/([^/]+)\/iteration\.json$/u.exec(path);
        return match?.[1] === undefined ? [] : [match[1]];
      }))].sort(compareText);
      const iterationIdSet = new Set(iterationIds);
      if ([...closedRecords.keys()].some((iterationId) => !iterationIdSet.has(iterationId))) {
        return fail(
          'PROJECTION_ARTIFACT_INVALID',
          'The current specification references a missing iteration.',
        );
      }
      if (
        current.active_iteration !== undefined &&
        current.active_iteration !== null &&
        (typeof current.active_iteration !== 'string' ||
          !iterationIdSet.has(current.active_iteration))
      ) {
        return fail(
          'PROJECTION_ARTIFACT_INVALID',
          'The current specification references a missing active iteration.',
        );
      }

      for (const iterationId of iterationIds) {
        const iterationPath = `iterations/${iterationId}/iteration.json`;
        if (iterationId === 'maintenance') continue;
        if (iterationId.length > 120 || !ITERATION_ID_PATTERN.test(iterationId)) {
          selected.set(iterationPath, [{
            decision: 'error',
            reasonCode: 'unsupported_schema',
            sourceArtifact: iterationPath,
          }]);
          continue;
        }
        const specPath = `iterations/${iterationId}/gate-b-spec/spec.json`;
        const intakePath = `iterations/${iterationId}/gate-a-intake/intake.json`;
        if (!knownFiles.has(specPath) || !knownFiles.has(intakePath)) {
          selected.set(iterationPath, [{
            decision: 'error',
            reasonCode: 'lineage_invalid',
            sourceArtifact: iterationPath,
          }]);
          if (knownFiles.has(specPath)) {
            selected.set(specPath, [{
              decision: 'error',
              reasonCode: 'lineage_invalid',
              sourceArtifact: specPath,
            }]);
          }
          continue;
        }
        try {
          const iterationArtifact = await read(iterationPath);
          const specArtifact = await read(specPath);
          const intakeArtifact = await read(intakePath);
          const iteration = parseJson(iterationArtifact);
          const spec = parseJson(specArtifact);
          const intake = parseJson(intakeArtifact);
          validateP2aIteration(iteration, input.projectId, iterationId);
          if (
            spec.schema_version !== 'p2a.spec.v1' ||
            spec.project_id !== input.projectId
          ) {
            fail('PROJECTION_ARTIFACT_INVALID', 'A P2A specification is invalid.');
          }
          if (
            spec.approval !== 'approved' ||
            !Array.isArray(spec.open_decisions) ||
            spec.open_decisions.length > 0 ||
            (iteration.status !== 'archived' && iteration.status !== 'gate_b_approved')
          ) {
            selected.set(specPath, [{
              decision: 'exclude',
              reasonCode: 'draft',
              sourceArtifact: specPath,
            }]);
            continue;
          }
          const views = validateP2aSpec(spec, input.projectId);
          const specApproval = matchingP2aApproval(decisions, specPath, specArtifact.digest);
          const intakeApproval = matchingP2aApproval(decisions, intakePath, intakeArtifact.digest);
          if (specApproval === null) {
            selected.set(specPath, [{
              decision: 'error',
              reasonCode: 'approval_invalid',
              sourceArtifact: specPath,
            }]);
            continue;
          }
          let intakeEligible = true;
          try {
            validateP2aIntake(intake);
          } catch {
            intakeEligible = false;
            selected.set(intakePath, [{
              decision: 'error',
              reasonCode: 'unsupported_schema',
              sourceArtifact: intakePath,
            }]);
          }
          if (intakeApproval === null) {
            intakeEligible = false;
            selected.set(intakePath, [{
              decision: 'error',
              reasonCode: 'approval_invalid',
              sourceArtifact: intakePath,
            }]);
          } else if (
            spec.source_intake !== '../gate-a-intake/intake.json' ||
            spec.source_intake_sha256 !== intakeArtifact.digest.slice('sha256:'.length)
          ) {
            intakeEligible = false;
            selected.set(intakePath, [{
              decision: 'error',
              reasonCode: 'lineage_invalid',
              sourceArtifact: intakePath,
            }]);
          }

          const closed = closedRecords.get(iterationId);
          const isArchived = iteration.status === 'archived';
          const isActive =
            iteration.status === 'gate_b_approved' && current.active_iteration === iterationId;
          if (!isArchived && closed !== undefined) {
            selected.set(iterationPath, [{
              decision: 'error',
              reasonCode: 'lineage_invalid',
              sourceArtifact: iterationPath,
            }]);
          }
          if (!isArchived && !isActive) {
            selected.set(specPath, [{
              decision: 'exclude',
              reasonCode: 'draft',
              sourceArtifact: specPath,
            }]);
            continue;
          }

          let archive: {
            readonly closed: Record<string, unknown>;
            readonly timestamp: { readonly source: TimestampSource; readonly value: string };
          } | null = null;
          if (isArchived) {
            if (closed === undefined) {
              selected.set(iterationPath, [{
                decision: 'error',
                reasonCode: 'lineage_invalid',
                sourceArtifact: iterationPath,
              }]);
            } else {
              try {
                const taskPath = requireP2aString(closed, 'task_graph_ref');
                const expectedTaskPath =
                  `iterations/${iterationId}/gate-c-task-graph/task-graph.json`;
                if (taskPath !== expectedTaskPath || !knownFiles.has(taskPath)) {
                  fail('PROJECTION_ARTIFACT_INVALID', 'The archive lineage is incomplete.');
                }
                const taskArtifact = await read(taskPath);
                if (
                  closed.status !== 'archived' ||
                  closed.spec_ref !== specPath ||
                  iteration.closed_at !== closed.closed_at ||
                  !isDeepStrictEqual(iteration.close, closed) ||
                  !validP2aTaskStatusCounts(closed.task_status_counts) ||
                  !artifactHashMatches(closed, specPath, specArtifact) ||
                  !artifactHashMatches(closed, intakePath, intakeArtifact) ||
                  !artifactHashMatches(closed, taskPath, taskArtifact)
                ) {
                  fail('PROJECTION_ARTIFACT_INVALID', 'The archive lineage is invalid.');
                }
                const timestamp = await resolveTimestamp(
                  root,
                  iterationArtifact,
                  [{ source: 'close', value: closed.closed_at }],
                  input.explicitTimestamp,
                  revisionClock,
                );
                if (timestamp === null) {
                  selected.set(iterationPath, [{
                    decision: 'error',
                    reasonCode: 'timestamp_unavailable',
                    sourceArtifact: iterationPath,
                  }]);
                } else {
                  archive = { closed, timestamp };
                }
              } catch (error) {
                if (!(error instanceof ProjectionError)) throw error;
                selected.set(iterationPath, [{
                  decision: 'error',
                  reasonCode: error.code === 'PROJECTION_PATH_UNSAFE'
                    ? 'path_unsafe'
                    : 'lineage_invalid',
                  sourceArtifact: iterationPath,
                }]);
              }
            }
          }

          const specTimestamp = await resolveTimestamp(
            root,
            specArtifact,
            [
              { source: 'approval', value: specApproval.at },
              { source: 'promotion', value: iteration.promoted_at },
            ],
            input.explicitTimestamp,
            revisionClock,
          );
          const intakeTimestamp = intakeEligible && intakeApproval !== null
            ? await resolveTimestamp(
              root,
              intakeArtifact,
              [{ source: 'approval', value: intakeApproval.at }],
              input.explicitTimestamp,
              revisionClock,
            )
            : null;
          if (specTimestamp === null) {
            selected.set(specPath, [{
              decision: 'error',
              reasonCode: 'timestamp_unavailable',
              sourceArtifact: specPath,
            }]);
          }
          if (intakeEligible && intakeTimestamp === null) {
            selected.set(intakePath, [{
              decision: 'error',
              reasonCode: 'timestamp_unavailable',
              sourceArtifact: intakePath,
            }]);
          }

          if (specTimestamp !== null) {
            candidates.push(
              createCandidate(
              repository,
              input.projectId,
              iterationId,
              'product-spec',
              specArtifact,
              specTimestamp,
              `제품 명세 — ${iterationId}`,
              renderP2aProduct(views, iterationId),
            ),
              createCandidate(
              repository,
              input.projectId,
              iterationId,
              'implementation-plan',
              specArtifact,
              specTimestamp,
              `구현 계획 — ${iterationId}`,
              renderP2aImplementation(views, iterationId),
            ),
            );
          }
          if (intakeEligible && intakeTimestamp !== null) {
            candidates.push(createCandidate(
              repository,
              input.projectId,
              iterationId,
              'intake',
              intakeArtifact,
              intakeTimestamp,
              `승인된 인테이크 — ${iterationId}`,
              renderP2aIntake(intake, iterationId),
            ));
          }
          if (archive !== null) {
            candidates.push(createCandidate(
              repository,
              input.projectId,
              iterationId,
              'archived-iteration',
              iterationArtifact,
              archive.timestamp,
              `보관된 반복 — ${iterationId}`,
              renderP2aArchive({
                ...iteration,
                idea: typeof iteration.idea === 'string'
                  ? iteration.idea
                  : views.product.problem,
              }, archive.closed),
            ));
          }
        } catch (error) {
          if (error instanceof ProjectionError) {
            selected.set(specPath, [{
              decision: 'error',
              reasonCode: reasonForProjectionError(error),
              sourceArtifact: specPath,
            }]);
            continue;
          }
          throw error;
        }
      }

      const candidatePaths = new Set(candidates.map((value) => value.sourceArtifact));
      const entries: ProjectionPlanEntry[] = [];
      for (const path of files) {
        const explicit = selected.get(path);
        if (explicit !== undefined) entries.push(...explicit);
        else if (!candidatePaths.has(path)) {
          entries.push({
            decision: 'exclude',
            reasonCode: classifyExcluded(path),
            sourceArtifact: path,
          });
        }
      }
      return {
        artifactRoot: root,
        bindings: [...bindingMap.values()].sort((left, right) =>
          compareText(left.sourceArtifact, right.sourceArtifact)),
        candidates,
        entries,
        scannedFiles: files,
      };
    },

    async verify(artifactRoot, bindings, scannedFiles): Promise<void> {
      const root = await canonicalArtifactRoot(artifactRoot);
      if (root !== artifactRoot) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'The artifact root changed after planning.');
      }
      const currentFiles = await listArtifactFiles(root);
      if (
        currentFiles.length !== scannedFiles.length ||
        currentFiles.some((path, index) => path !== scannedFiles[index])
      ) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'The artifact file set changed after planning.');
      }
      for (const binding of bindings) {
        const artifact = await readArtifact(root, binding.sourceArtifact);
        if (artifact.digest !== binding.sourceRevision) {
          return fail('PROJECTION_ARTIFACT_CHANGED', 'A planning artifact changed after planning.');
        }
      }
    },
  };
}
