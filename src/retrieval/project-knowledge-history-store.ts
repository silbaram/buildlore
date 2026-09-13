import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { parseKnowledgeGenerationChain, replayKnowledgeGeneration } from '../compiler/project-knowledge/generation.js';
import { screenRetainedKnowledgeHistory } from '../compiler/project-knowledge/history-security.js';
import { syncDirectory } from '../knowledge/atomic-file.js';
import { isNodeError } from '../knowledge/errors.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { hash, invalid, ProjectKnowledgeError, sha256 } from '../knowledge/project-knowledge/guards.js';
import { appendKnowledgeHistoryReference, createKnowledgeGenerationRecord, MAX_KNOWLEDGE_HISTORY_RECORD_BYTES,
  parseKnowledgeGenerationRecord, parseKnowledgeHistoryReference,
  type KnowledgeHistoryReferenceV1, type ParsedKnowledgeGenerationRecordV1 } from '../knowledge/project-knowledge/history.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from '../knowledge/project-knowledge/types.js';
import { consumePreparedSource } from '../sanitizer/approval.js';
import { createProjectSecurityService, readSecurityPolicy, SANITIZER_RULES_VERSION } from '../sanitizer/index.js';

export class KnowledgeHistoryError extends Error {
  constructor(readonly code: 'KNOWLEDGE_HISTORY_INVALID' | 'KNOWLEDGE_HISTORY_UNAVAILABLE'
    | 'KNOWLEDGE_HISTORY_DRIFT' | 'KNOWLEDGE_HISTORY_CANCELLED' | 'KNOWLEDGE_HISTORY_WRITE_FAILED') {
    super('Knowledge history operation could not be completed safely.');
    this.name = 'KnowledgeHistoryError';
  }
}

/** Only instances minted by a complete, current-policy store verification are trusted. */
export interface VerifiedKnowledgeHistory {
  readonly reference: KnowledgeHistoryReferenceV1;
  readonly latest: KnowledgeGenerationV1;
  readonly policyDigest: KnowledgeDigest;
  readonly bytesFingerprint: KnowledgeDigest;
}

const capabilities = new WeakMap<VerifiedKnowledgeHistory, string>();

export function requireVerifiedKnowledgeHistory(value: VerifiedKnowledgeHistory,
  projectId: string, policyDigest?: KnowledgeDigest): VerifiedKnowledgeHistory {
  if (!capabilities.has(value) || value.reference.projectId !== projectId ||
      (policyDigest !== undefined && value.policyDigest !== policyDigest)) invalid();
  return value;
}

interface OperationOptions { readonly signal?: AbortSignal }
interface AppendInput extends OperationOptions {
  readonly projectId: string;
  readonly baseline: VerifiedKnowledgeHistory | null;
  readonly generation: KnowledgeGenerationV1;
}
export interface KnowledgeGenerationHistoryStorePort {
  verify(reference: unknown, projectId: string, options?: OperationOptions): Promise<VerifiedKnowledgeHistory>;
  stageAppend(input: AppendInput): Promise<VerifiedKnowledgeHistory>;
  /** Staging is inert. The publication owner separately archives and commits the authority. */
  stageLegacy(generations: unknown, projectId: string, options?: OperationOptions): Promise<VerifiedKnowledgeHistory>;
}

/** @internal Deterministic boundary hooks; never an alternate reader or security provider. */
export interface KnowledgeHistoryLiveWindow {
  /** Strong references owned by the verifier, excluding caller-owned inputs. */
  readonly parsedRecordGraphs: number;
  readonly replayGenerationGraphs: number;
  readonly recordBufferBytes: number;
  readonly spoolFrameBytes: number;
}

export interface KnowledgeHistoryStoreTestHooks {
  readonly onLiveWindow?: (window: KnowledgeHistoryLiveWindow) => void;
  readonly beforeRead?: (generationDigest: KnowledgeDigest) => Promise<void> | void;
  readonly beforeObjectOpen?: () => Promise<void> | void;
  readonly beforeStage?: () => Promise<void> | void;
  readonly beforeReplay?: () => Promise<void> | void;
  readonly onVisit?: (phase: 'walk' | 'replay', generationDigest: KnowledgeDigest) => void;
}

interface DirectoryIdentity { readonly path: string; readonly dev: number; readonly ino: number }
interface StorePaths { readonly identities: readonly DirectoryIdentity[]; readonly root: string; readonly objects: string }

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new KnowledgeHistoryError('KNOWLEDGE_HISTORY_CANCELLED');
}

function freezeDescendants(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeDescendants(child);
  Object.freeze(value);
}

async function assertDirectories(paths: StorePaths): Promise<void> {
  for (const identity of paths.identities) {
    const status = await lstat(identity.path);
    if (!status.isDirectory() || status.isSymbolicLink() || status.dev !== identity.dev ||
        status.ino !== identity.ino || await realpath(identity.path) !== identity.path) {
      throw new KnowledgeHistoryError('KNOWLEDGE_HISTORY_DRIFT');
    }
  }
}

async function storePaths(knowledgeRoot: string, projectId: string, create: boolean): Promise<StorePaths> {
  const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
  const paths: string[] = [workspace];
  for (const name of ['.llmwiki', 'buildlore-hierarchy', 'knowledge-history', 'objects']) {
    paths.push(join(paths.at(-1) ?? invalid(), name));
  }
  const identities: DirectoryIdentity[] = [];
  for (const path of paths) {
    await assertDirectories({ identities, root: workspace, objects: workspace });
    if (create && path !== workspace) {
      try {
        await mkdir(path, { mode: 0o700 });
        // A synced object is not durable if a newly created ancestor can vanish.
        await syncDirectory(identities.at(-1)?.path ?? invalid());
      }
      catch (error) { if (!isNodeError(error) || error.code !== 'EEXIST') throw error; }
    }
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(path) !== path) {
      throw new KnowledgeHistoryError('KNOWLEDGE_HISTORY_INVALID');
    }
    identities.push({ path, dev: status.dev, ino: status.ino });
  }
  return { identities, root: paths[3] ?? invalid(), objects: paths[4] ?? invalid() };
}

function objectPath(paths: StorePaths, generationDigest: KnowledgeDigest): string {
  return join(paths.objects, `${hash(generationDigest).slice(7)}.json`);
}

async function readRecord(paths: StorePaths, projectId: string, generationDigest: KnowledgeDigest,
  signal?: AbortSignal, beforeOpen?: () => Promise<void> | void, onBuffer?: (bytes: number) => void): Promise<Readonly<{ record: ParsedKnowledgeGenerationRecordV1; bytesDigest: KnowledgeDigest }>> {
  checkCancellation(signal);
  await assertDirectories(paths);
  const path = objectPath(paths, generationDigest);
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size < 2 ||
      status.size > MAX_KNOWLEDGE_HISTORY_RECORD_BYTES || await realpath(path) !== path) invalid();
  await beforeOpen?.();
  // If a checked regular file is replaced by a FIFO, open must not wait for a
  // writer before the opened-handle identity/type checks can reject it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino || opened.size !== status.size) invalid();
    // Fixed admission before allocation, and no unbounded readFile race with a growing file.
    const bytes = Buffer.alloc(status.size);
    onBuffer?.(bytes.length);
    let offset = 0;
    while (offset < bytes.length) {
      checkCancellation(signal);
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) invalid();
      offset += result.bytesRead;
    }
    const [after, named] = await Promise.all([handle.stat(), lstat(path)]);
    await assertDirectories(paths);
    if (after.size !== status.size || after.mtimeMs !== status.mtimeMs || after.ctimeMs !== status.ctimeMs ||
        named.dev !== status.dev || named.ino !== status.ino || named.nlink !== 1 || await realpath(path) !== path) invalid();
    return { record: parseKnowledgeGenerationRecord(bytes, projectId, generationDigest),
      bytesDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  } finally { onBuffer?.(0); await handle.close(); }
}

async function removeOwnedFile(paths: StorePaths, path: string, dev: number, ino: number): Promise<void> {
  try {
    await assertDirectories(paths);
    const status = await lstat(path);
    if (status.isFile() && !status.isSymbolicLink() && status.dev === dev && status.ino === ino) await unlink(path);
  } catch { /* Never delete a replaced path or conceal an earlier operation error. */ }
}

async function stageRecord(paths: StorePaths, generation: KnowledgeGenerationV1): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(createKnowledgeGenerationRecord(generation)));
  const expectedBytesDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const target = objectPath(paths, generation.generationDigest);
  await assertDirectories(paths);
  const temporary = join(paths.objects, `.stage-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const status = await handle.stat();
  try {
    await assertDirectories(paths);
    if (!status.isFile() || await realpath(temporary) !== temporary) invalid();
    await handle.writeFile(bytes);
    await handle.sync();
    await assertDirectories(paths);
    // link is an exclusive, atomic publish of complete immutable bytes. Never overwrite an object.
    try { await link(temporary, target); }
    catch (error) { if (!isNodeError(error) || error.code !== 'EEXIST') throw error; }
  } finally {
    await handle.close();
    await removeOwnedFile(paths, temporary, status.dev, status.ino);
  }
  await syncDirectory(paths.objects);
  const stored = await readRecord(paths, generation.projectId, generation.generationDigest);
  if (stored.bytesDigest !== expectedBytesDigest) throw new KnowledgeHistoryError('KNOWLEDGE_HISTORY_DRIFT');
}

/** No aggregate history quota or array. Disk/time grow with history; the live
 * traversal state is a record, a predecessor, and fixed-width digest frames.
 */
export function createKnowledgeGenerationHistoryStore(options: Readonly<{
  knowledgeRoot: string; testHooks?: KnowledgeHistoryStoreTestHooks;
}>): KnowledgeGenerationHistoryStorePort {
  const security = createProjectSecurityService(options);
  let cached: VerifiedKnowledgeHistory | null = null;
  const screen = async (generation: KnowledgeGenerationV1, policyDigest: KnowledgeDigest,
    signal?: AbortSignal): Promise<void> => {
    await screenRetainedKnowledgeHistory([generation], async body => {
      checkCancellation(signal);
      const result = await security.prepareSource({ projectId: generation.projectId,
        source: 'project-knowledge-history.md', sourceKind: 'markdown', body, bodyDigest: sha256(body),
        sourceRevisionOrContentSha256: sha256(body) });
      const prepared = result.ok ? consumePreparedSource(result.prepared) : null;
      if (!prepared || prepared.policyDigest !== policyDigest || prepared.approvedBody !== body ||
          prepared.approvedBodyDigest !== sha256(body)) throw new ProjectKnowledgeError('KNOWLEDGE_SECURITY_BLOCKED');
      checkCancellation(signal);
    });
  };
  const guarded = async <T>(operation: () => Promise<T>, writing = false): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      cached = null;
      if (error instanceof KnowledgeHistoryError || error instanceof ProjectKnowledgeError) throw error;
      throw new KnowledgeHistoryError(isNodeError(error) && error.code === 'ENOENT'
        ? 'KNOWLEDGE_HISTORY_UNAVAILABLE' : writing ? 'KNOWLEDGE_HISTORY_WRITE_FAILED' : 'KNOWLEDGE_HISTORY_INVALID');
    }
  };
  const verify = async (value: unknown, projectId: string, operation: OperationOptions = {}): Promise<VerifiedKnowledgeHistory> => guarded(async () => {
    checkCancellation(operation.signal);
    const reference = parseKnowledgeHistoryReference(value, projectId);
    const policy = await readSecurityPolicy(options.knowledgeRoot, projectId);
    const paths = await storePaths(options.knowledgeRoot, projectId, false);
    await assertDirectories(paths);
    const spoolPath = join(paths.root, `.verify-${randomUUID()}.tmp`);
    const spool = await open(spoolPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const spoolStatus = await spool.stat();
    try {
      await assertDirectories(paths);
      if (!spoolStatus.isFile() || await realpath(spoolPath) !== spoolPath) invalid();
      let parsedRecordGraphs = 0;
      let replayGenerationGraphs = cached === null ? 0 : 1;
      let recordBufferBytes = 0;
      const reportWindow = (): void => options.testHooks?.onLiveWindow?.(Object.freeze({
        parsedRecordGraphs, replayGenerationGraphs, recordBufferBytes, spoolFrameBytes: 64 }));
      const visitRecord = async <T>(id: KnowledgeDigest,
        visit: (item: Awaited<ReturnType<typeof readRecord>>) => Promise<T>): Promise<T> => {
        const item = await readRecord(paths, projectId, id, operation.signal, options.testHooks?.beforeObjectOpen,
          bytes => { recordBufferBytes = bytes; reportWindow(); });
        parsedRecordGraphs += 1;
        reportWindow();
        try { return await visit(item); }
        finally { parsedRecordGraphs -= 1; reportWindow(); }
      };
      const fingerprint = createHash('sha256');
      const predecessorFingerprint = createHash('sha256');
      let headParent: KnowledgeDigest | null = null;
      let current: KnowledgeDigest | null = reference.headGenerationDigest;
      let anchor: KnowledgeDigest | null = current;
      let power = 1n;
      let distance = 0n;
      let count = 0n;
      let genesis: KnowledgeDigest | null = null;
      const declaredCount = BigInt(reference.generationCount);
      // Head-first path walk: Brent cycle detection needs no history-sized Set.
      while (current !== null) {
        checkCancellation(operation.signal);
        if (count >= declaredCount) invalid();
        await options.testHooks?.beforeRead?.(current);
        const id: KnowledgeDigest = current;
        const parent = await visitRecord(id, async item => {
          options.testHooks?.onVisit?.('walk', id);
          const frame = Buffer.from(id.slice(7) + item.bytesDigest.slice(7), 'hex');
          fingerprint.update(frame);
          if (count > 0n) predecessorFingerprint.update(frame);
          else headParent = item.record.parentGenerationDigest;
          await writeFrame(spool, frame);
          return item.record.parentGenerationDigest;
        });
        count += 1n;
        genesis = id;
        current = parent;
        distance += 1n;
        if (current !== null && current === anchor) invalid();
        if (distance === power) { anchor = current; power *= 2n; distance = 0n; }
      }
      if (count !== declaredCount || genesis !== reference.genesisGenerationDigest) invalid();
      const bytesFingerprint: KnowledgeDigest = `sha256:${fingerprint.digest('hex')}`;
      let latest: KnowledgeGenerationV1 | null = null;
      if (cached !== null && capabilities.get(cached) === paths.root &&
          cached.reference.historyDigest === reference.historyDigest && cached.policyDigest === policy.digest &&
          cached.bytesFingerprint === bytesFingerprint) {
        // All actual referenced bytes and paths were just reread, even on a cache hit.
        latest = cached.latest;
      } else {
        // A one-generation append may reuse its already replayed predecessor only
        // after this walk has reread EVERY predecessor byte/path under the same policy.
        // No prefix flags, reference-only cache, growing map or fake genesis is used.
        const canReusePredecessor = cached !== null && capabilities.get(cached) === paths.root &&
          cached.policyDigest === policy.digest && cached.reference.headGenerationDigest === headParent &&
          cached.reference.genesisGenerationDigest === reference.genesisGenerationDigest &&
          BigInt(cached.reference.generationCount) + 1n === count &&
          cached.bytesFingerprint === `sha256:${predecessorFingerprint.digest('hex')}`;
        if (canReusePredecessor && cached !== null) latest = cached.latest;
        cached = null;
        replayGenerationGraphs = latest === null ? 0 : 1;
        reportWindow();
        await options.testHooks?.beforeReplay?.();
        const frame = Buffer.alloc(64);
        for (let index = canReusePredecessor ? 0n : count - 1n; index >= 0n; index -= 1n) {
          checkCancellation(operation.signal);
          await readFrame(spool, frame, index * 64n);
          const generationDigest = hash(`sha256:${frame.subarray(0, 32).toString('hex')}`);
          const expectedBytes = `sha256:${frame.subarray(32).toString('hex')}`;
          latest = await visitRecord(generationDigest, async item => {
            if (item.bytesDigest !== expectedBytes) throw new KnowledgeHistoryError('KNOWLEDGE_HISTORY_DRIFT');
            const next = replayKnowledgeGeneration(item.record.generation, projectId, latest);
            replayGenerationGraphs = latest === null ? 1 : 2;
            reportWindow();
            await screen(next, policy.digest, operation.signal);
            options.testHooks?.onVisit?.('replay', generationDigest);
            return next;
          });
          replayGenerationGraphs = 1;
          reportWindow();
        }
      }
      if (latest === null || latest.generationDigest !== reference.headGenerationDigest) invalid();
      checkCancellation(operation.signal);
      if ((await readSecurityPolicy(options.knowledgeRoot, projectId)).digest !== policy.digest) {
        throw new KnowledgeHistoryError('KNOWLEDGE_HISTORY_DRIFT');
      }
      freezeDescendants(latest);
      const result = Object.freeze({ reference, latest, policyDigest: policy.digest, bytesFingerprint });
      capabilities.set(result, paths.root);
      cached = result;
      return result;
    } finally {
      await spool.close();
      await removeOwnedFile(paths, spoolPath, spoolStatus.dev, spoolStatus.ino);
    }
  });
  return Object.freeze({ verify,
    stageAppend: async (input: AppendInput) => guarded(async () => {
      checkCancellation(input.signal);
      const baseline = input.baseline === null ? null : requireVerifiedKnowledgeHistory(input.baseline, input.projectId);
      const previous = baseline === null ? null : await verify(baseline.reference, input.projectId, input);
      const policy = await readSecurityPolicy(options.knowledgeRoot, input.projectId);
      const generation = replayKnowledgeGeneration(input.generation, input.projectId, previous?.latest ?? null);
      if (generation.snapshot.sanitizerPolicyDigest !== policy.digest ||
          generation.snapshot.sanitizerRulesVersion !== SANITIZER_RULES_VERSION) throw new KnowledgeHistoryError('KNOWLEDGE_HISTORY_DRIFT');
      await screen(generation, policy.digest, input.signal);
      const paths = await storePaths(options.knowledgeRoot, input.projectId, true);
      if (baseline !== null && capabilities.get(baseline) !== paths.root) invalid();
      await options.testHooks?.beforeStage?.();
      checkCancellation(input.signal);
      if ((await readSecurityPolicy(options.knowledgeRoot, input.projectId)).digest !== policy.digest) throw new KnowledgeHistoryError('KNOWLEDGE_HISTORY_DRIFT');
      await stageRecord(paths, generation);
      return verify(appendKnowledgeHistoryReference(previous?.reference ?? null, generation.generationDigest, input.projectId), input.projectId, input);
    }, true),
    stageLegacy: async (value: unknown, projectId: string, operation: OperationOptions = {}) => guarded(async () => {
      checkCancellation(operation.signal);
      const generations = parseKnowledgeGenerationChain(value, projectId);
      const policy = await readSecurityPolicy(options.knowledgeRoot, projectId);
      const paths = await storePaths(options.knowledgeRoot, projectId, true);
      let reference: KnowledgeHistoryReferenceV1 | null = null;
      for (const generation of generations) {
        await screen(generation, policy.digest, operation.signal);
        await options.testHooks?.beforeStage?.();
        checkCancellation(operation.signal);
        if ((await readSecurityPolicy(options.knowledgeRoot, projectId)).digest !== policy.digest) throw new KnowledgeHistoryError('KNOWLEDGE_HISTORY_DRIFT');
        await stageRecord(paths, generation);
        reference = appendKnowledgeHistoryReference(reference, generation.generationDigest, projectId);
      }
      return verify(reference, projectId, operation);
    }, true),
  });
}

async function writeFrame(handle: FileHandle, frame: Buffer): Promise<void> {
  let offset = 0;
  while (offset < frame.length) {
    const { bytesWritten } = await handle.write(frame, offset, frame.length - offset);
    if (bytesWritten === 0) invalid();
    offset += bytesWritten;
  }
}

async function readFrame(handle: FileHandle, frame: Buffer, position: bigint): Promise<void> {
  let offset = 0;
  while (offset < frame.length) {
    const { bytesRead } = await handle.read(frame, offset, frame.length - offset, position + BigInt(offset));
    if (bytesRead === 0) invalid();
    offset += bytesRead;
  }
}
