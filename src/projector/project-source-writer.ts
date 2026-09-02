import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';

import { syncDirectory } from '../knowledge/atomic-file.js';
import { generatedSourceFilenameKind } from '../sanitizer/index.js';
import { ProjectionError } from './errors.js';
import type {
  SourceDescriptorV1,
  SourceRangeMappingV1,
} from './source-contracts.js';
import type { ProjectionWriteStatus } from './planning-types.js';
import {
  createSourceDocument,
  parseSourceDocument,
  renderSourceDocument,
} from './source-document.js';

const MAX_TARGET_BYTES = 512 * 1024;
export type ProjectSourceProducer = 'buildlore' | 'p2a';
export type ProjectSourceKind = 'code' | 'execution' | 'markdown' | 'planning' | 'text';
export type CollectableProjectSourceKind = Exclude<ProjectSourceKind, 'execution'>;

export function isCollectableProjectSourceKind(
  value: ProjectSourceKind,
): value is CollectableProjectSourceKind {
  return value === 'code' || value === 'markdown' || value === 'planning' || value === 'text';
}

export interface ProjectSourceInput {
  readonly body: string;
  readonly descriptor?: SourceDescriptorV1;
  readonly ingestedAt: string;
  readonly originMappings?: readonly SourceRangeMappingV1[];
  /** Omitted only by legacy planning/execution callers, which remain P2A-owned. */
  readonly producer?: ProjectSourceProducer;
  readonly sourceRevision: `sha256:${string}`;
  readonly sourceKind: ProjectSourceKind;
  readonly sourceUri: string;
  readonly target: string;
  readonly title: string;
}

export interface ProjectSourceTargetSnapshot {
  readonly contentDigest: `sha256:${string}` | null;
  readonly writeStatus: ProjectionWriteStatus;
}

export interface ProjectSourceWriter {
  assertUnchanged(
    input: ProjectSourceInput,
    snapshot: ProjectSourceTargetSnapshot,
  ): Promise<void>;
  inspect(input: ProjectSourceInput): Promise<ProjectSourceTargetSnapshot>;
  write(
    input: ProjectSourceInput,
    markdown: string,
    snapshot: ProjectSourceTargetSnapshot,
  ): Promise<ProjectionWriteStatus>;
}

export interface ProjectSourceWriterFactory {
  create(workspace: string, projectId: string): Promise<ProjectSourceWriter>;
}

interface SourcesDirectory {
  readonly birthtimeNs: bigint;
  ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly path: string;
}

interface ExistingTarget {
  readonly content: string;
  readonly digest: `sha256:${string}`;
  readonly identity: { readonly dev: number; readonly ino: number };
}

function fail(
  code: ConstructorParameters<typeof ProjectionError>[0],
  message: string,
): never {
  throw new ProjectionError(code, message);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

export function projectSourceProducer(input: ProjectSourceInput): ProjectSourceProducer {
  const producer = input.producer ?? 'p2a';
  const compatible =
    (producer === 'buildlore' &&
      (input.sourceKind === 'code' || input.sourceKind === 'markdown' || input.sourceKind === 'text')) ||
    (producer === 'p2a' && (input.sourceKind === 'execution' || input.sourceKind === 'planning'));
  if (!compatible) {
    fail('PROJECTION_ARTIFACT_INVALID', 'The source producer and kind are incompatible.');
  }
  return producer;
}

function assertDerivedTarget(input: ProjectSourceInput): void {
  projectSourceProducer(input);
  const expectedTarget = `${input.sourceKind}--${
    sha256(input.sourceUri).slice('sha256:'.length)
  }.md`;
  const targetKind = generatedSourceFilenameKind(input.target);
  if (
    targetKind === null ||
    targetKind !== input.sourceKind ||
    basename(input.target) !== input.target ||
    input.target !== expectedTarget
  ) {
    fail('PROJECTION_PATH_UNSAFE', 'The source target is unsafe.');
  }
}

async function createSourcesDirectory(workspace: string): Promise<SourcesDirectory> {
  const sources = join(workspace, 'sources');
  try {
    const status = await lstat(sources, { bigint: true });
    const canonical = await realpath(sources);
    if (!status.isDirectory() || status.isSymbolicLink() || !isContained(workspace, canonical)) {
      return fail('PROJECTION_PATH_UNSAFE', 'The project sources directory is unsafe.');
    }
    return {
      birthtimeNs: status.birthtimeNs,
      ctimeNs: status.ctimeNs,
      dev: status.dev,
      ino: status.ino,
      path: canonical,
    };
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_PATH_UNSAFE', 'The project sources directory is unsafe.');
  }
}

async function assertDirectoryIdentity(sources: SourcesDirectory): Promise<void> {
  try {
    const status = await lstat(sources.path, { bigint: true });
    const canonical = await realpath(sources.path);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      status.birthtimeNs !== sources.birthtimeNs ||
      status.ctimeNs !== sources.ctimeNs ||
      status.dev !== sources.dev ||
      status.ino !== sources.ino ||
      canonical !== sources.path
    ) {
      fail('PROJECTION_PATH_UNSAFE', 'The project sources directory changed during persistence.');
    }
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    fail('PROJECTION_PATH_UNSAFE', 'The project sources directory changed during persistence.');
  }
}

async function refreshDirectoryIdentity(sources: SourcesDirectory): Promise<void> {
  try {
    const status = await lstat(sources.path, { bigint: true });
    const canonical = await realpath(sources.path);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      status.birthtimeNs !== sources.birthtimeNs ||
      status.dev !== sources.dev ||
      status.ino !== sources.ino ||
      canonical !== sources.path
    ) {
      fail('PROJECTION_PATH_UNSAFE', 'The project sources directory changed during persistence.');
    }
    sources.ctimeNs = status.ctimeNs;
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    fail('PROJECTION_PATH_UNSAFE', 'The project sources directory changed during persistence.');
  }
}

async function readExistingTarget(
  sources: SourcesDirectory,
  input: ProjectSourceInput,
  projectId: string,
): Promise<ExistingTarget | null> {
  assertDerivedTarget(input);
  const producer = projectSourceProducer(input);
  await assertDirectoryIdentity(sources);
  const path = join(sources.path, input.target);
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    return fail('PROJECTION_PATH_UNSAFE', 'A source target is unavailable.');
  }
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_TARGET_BYTES) {
    return fail('PROJECTION_PATH_UNSAFE', 'A source target is unsafe.');
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.dev !== status.dev ||
      actual.ino !== status.ino ||
      actual.size > MAX_TARGET_BYTES
    ) {
      return fail('PROJECTION_PATH_UNSAFE', 'A source target changed during validation.');
    }
    const content = await handle.readFile('utf8');
    let parsed;
    try {
      parsed = parseSourceDocument(content);
    } catch {
      return fail('PROJECTION_SOURCE_COLLISION', 'A source target has an incompatible identity.');
    }
    if (
      parsed.source !== input.sourceUri ||
      parsed.sourceType !== 'file' ||
      parsed.buildlore.producer !== producer ||
      parsed.buildlore.projectId !== projectId ||
      parsed.buildlore.sourceKind !== input.sourceKind
    ) {
      return fail('PROJECTION_SOURCE_COLLISION', 'A source target has an incompatible identity.');
    }
    return {
      content,
      digest: sha256(content),
      identity: { dev: actual.dev, ino: actual.ino },
    };
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    return fail('PROJECTION_PATH_UNSAFE', 'A source target is unreadable.');
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the safe read failure.
    }
  }
}

export function renderExpectedProjectSource(input: ProjectSourceInput, projectId: string): string {
  const producer = projectSourceProducer(input);
  return renderSourceDocument(createSourceDocument({
    body: input.body,
    ...(input.descriptor === undefined ? {} : { descriptor: input.descriptor }),
    ingestedAt: input.ingestedAt,
    ...(input.originMappings === undefined ? {} : { originMappings: input.originMappings }),
    producer,
    projectId,
    source: input.sourceUri,
    sourceKind: input.sourceKind,
    sourceRevision: input.sourceRevision,
    sourceType: 'file',
    title: input.title,
  }));
}

function assertWritableMarkdown(
  input: ProjectSourceInput,
  projectId: string,
  markdown: string,
): void {
  const producer = projectSourceProducer(input);
  let parsed;
  try {
    parsed = parseSourceDocument(markdown);
  } catch {
    return fail('PROJECTION_SOURCE_COLLISION', 'A source write has incompatible content.');
  }
  if (
    renderSourceDocument(parsed) !== markdown ||
    parsed.ingestedAt !== input.ingestedAt ||
    parsed.source !== input.sourceUri ||
    parsed.sourceType !== 'file' ||
    parsed.title !== input.title ||
    parsed.buildlore.producer !== producer ||
    parsed.buildlore.projectId !== projectId ||
    parsed.buildlore.sourceKind !== input.sourceKind ||
    parsed.buildlore.sourceRevision !== input.sourceRevision
  ) {
    fail('PROJECTION_SOURCE_COLLISION', 'A source write has incompatible content.');
  }
}

async function assertTargetIdentity(
  path: string,
  expected: ExistingTarget['identity'] | null,
): Promise<void> {
  try {
    const current = await lstat(path);
    if (
      expected === null ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      fail('PROJECTION_SOURCE_COLLISION', 'A source target changed during persistence.');
    }
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    if (expected !== null || !isRecord(error) || error.code !== 'ENOENT') {
      fail('PROJECTION_SOURCE_COLLISION', 'A source target changed during persistence.');
    }
  }
}

export async function createProjectSourceWriter(
  workspace: string,
  projectId: string,
): Promise<ProjectSourceWriter> {
  const sources = await createSourcesDirectory(workspace);
  return {
    async assertUnchanged(input, snapshot): Promise<void> {
      const current = await readExistingTarget(sources, input, projectId);
      if ((current?.digest ?? null) !== snapshot.contentDigest) {
        fail('PROJECTION_ARTIFACT_CHANGED', 'A source target changed after planning.');
      }
    },

    async inspect(input): Promise<ProjectSourceTargetSnapshot> {
      assertDerivedTarget(input);
      const expected = renderExpectedProjectSource(input, projectId);
      const existing = await readExistingTarget(sources, input, projectId);
      if (existing === null) return { contentDigest: null, writeStatus: 'create' };
      return {
        contentDigest: existing.digest,
        writeStatus: existing.content === expected
          ? 'unchanged'
          : 'update',
      };
    },

    async write(input, markdown, snapshot): Promise<ProjectionWriteStatus> {
      assertWritableMarkdown(input, projectId, markdown);
      const existing = await readExistingTarget(sources, input, projectId);
      if ((existing?.digest ?? null) !== snapshot.contentDigest) {
        return fail('PROJECTION_ARTIFACT_CHANGED', 'A source target changed after planning.');
      }
      if (existing?.content === markdown) return 'unchanged';
      const path = join(sources.path, input.target);
      const temporaryPath = join(sources.path, `.${input.target}.${randomUUID()}.tmp`);
      let handle;
      let published = false;
      try {
        handle = await open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(markdown, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await refreshDirectoryIdentity(sources);
        await assertTargetIdentity(path, existing?.identity ?? null);
        if (existing === null) {
          await link(temporaryPath, path);
          await unlink(temporaryPath);
        } else {
          await rename(temporaryPath, path);
        }
        published = true;
        await refreshDirectoryIdentity(sources);
        await syncDirectory(sources.path);
        return existing === null ? 'create' : 'update';
      } catch (error) {
        if (error instanceof ProjectionError) throw error;
        return fail('PROJECTION_WRITE_FAILED', 'Atomic source persistence failed.');
      } finally {
        try {
          await handle?.close();
        } catch {
          // Preserve the safe write failure.
        }
        if (!published) {
          try {
            await unlink(temporaryPath);
          } catch {
            // Never replace the primary failure with cleanup detail.
          }
        }
      }
    },
  };
}
