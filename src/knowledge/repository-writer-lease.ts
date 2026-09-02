import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { isNodeError, RepositoryWriterError } from './errors.js';
import { resolveGitCommonDirectory } from './git.js';

const LEASE_FILE_NAME = 'buildlore.repository-writer.lock';
const MAX_LEASE_BYTES = 1024;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const PHASE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

export type RepositoryWriterOperation =
  | 'commit'
  | 'hierarchical-activation'
  | 'parent-pin'
  | 'push'
  | 'semantic-index-activation';

export interface RepositoryWriterLease {
  readonly repositoryIdentityDigest: string;
  updatePhase(phase: string): Promise<void>;
}

export interface RepositoryWriterLeasePort {
  withLease<T>(
    repositoryRoot: string,
    operation: RepositoryWriterOperation,
    action: (lease: RepositoryWriterLease) => Promise<T> | T,
  ): Promise<T>;
}

export interface RepositoryWriterLeaseHooks {
  readonly afterAcquire?: () => Promise<void> | void;
  readonly beforeRelease?: () => Promise<void> | void;
}

interface LeaseIdentity {
  readonly device: number;
  readonly inode: number;
  readonly token: string;
}

interface LeaseRecord {
  readonly operation: RepositoryWriterOperation;
  readonly phase: string;
  readonly token: string;
}

function ownershipLost(): RepositoryWriterError {
  return new RepositoryWriterError(
    'REPOSITORY_OWNERSHIP_LOST',
    'Repository writer lease ownership was lost; the lease was preserved for inspection.',
  );
}

function releaseFailed(): RepositoryWriterError {
  return new RepositoryWriterError(
    'REPOSITORY_RELEASE_FAILED',
    'Repository writer lease could not be released safely.',
  );
}

function serializeLease(record: LeaseRecord): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      operation: record.operation,
      phase: record.phase,
      token: record.token,
    })}\n`,
    'utf8',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLease(value: Buffer): LeaseRecord {
  if (
    value.byteLength === 0 ||
    value.byteLength > MAX_LEASE_BYTES ||
    value[value.byteLength - 1] !== 0x0a ||
    value.subarray(0, value.byteLength - 1).includes(0x0a)
  ) {
    throw ownershipLost();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value.toString('utf8')) as unknown;
  } catch {
    throw ownershipLost();
  }
  if (!isRecord(decoded)) throw ownershipLost();
  const keys = Object.keys(decoded);
  if (
    keys.length !== 3 ||
    keys[0] !== 'operation' ||
    keys[1] !== 'phase' ||
    keys[2] !== 'token' ||
    (decoded.operation !== 'commit' &&
      decoded.operation !== 'hierarchical-activation' &&
      decoded.operation !== 'parent-pin' &&
      decoded.operation !== 'push' &&
      decoded.operation !== 'semantic-index-activation') ||
    typeof decoded.phase !== 'string' ||
    !PHASE_PATTERN.test(decoded.phase) ||
    typeof decoded.token !== 'string' ||
    !TOKEN_PATTERN.test(decoded.token)
  ) {
    throw ownershipLost();
  }
  return {
    operation: decoded.operation,
    phase: decoded.phase,
    token: decoded.token,
  };
}

async function writeLeaseRecord(handle: FileHandle, record: LeaseRecord): Promise<void> {
  const encoded = serializeLease(record);
  if (encoded.byteLength > MAX_LEASE_BYTES) throw releaseFailed();
  await handle.truncate(0);
  const { bytesWritten } = await handle.write(encoded, 0, encoded.byteLength, 0);
  if (bytesWritten !== encoded.byteLength) throw releaseFailed();
  await handle.sync();
}

async function assertLeaseOwnership(path: string, expected: LeaseIdentity): Promise<LeaseRecord> {
  let pathStatus: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStatus = await lstat(path);
  } catch {
    throw ownershipLost();
  }
  if (
    pathStatus.isSymbolicLink() ||
    !pathStatus.isFile() ||
    pathStatus.dev !== expected.device ||
    pathStatus.ino !== expected.inode ||
    pathStatus.size > MAX_LEASE_BYTES
  ) {
    throw ownershipLost();
  }

  let handle: FileHandle | undefined;
  let record: LeaseRecord | undefined;
  let ownershipError: RepositoryWriterError | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStatus = await handle.stat();
    if (
      !handleStatus.isFile() ||
      handleStatus.dev !== expected.device ||
      handleStatus.ino !== expected.inode ||
      handleStatus.size > MAX_LEASE_BYTES
    ) {
      throw ownershipLost();
    }
    record = parseLease(await handle.readFile());
    if (record.token !== expected.token) throw ownershipLost();
  } catch (error) {
    ownershipError = error instanceof RepositoryWriterError ? error : ownershipLost();
  }
  try {
    await handle?.close();
  } catch {
    throw releaseFailed();
  }
  if (ownershipError !== undefined) throw ownershipError;
  if (record === undefined) throw ownershipLost();
  return record;
}

async function releaseLease(
  path: string,
  handle: FileHandle,
  expected: LeaseIdentity,
): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw releaseFailed();
  }
  await assertLeaseOwnership(path, expected);
  let finalStatus: Awaited<ReturnType<typeof lstat>>;
  try {
    finalStatus = await lstat(path);
  } catch {
    throw ownershipLost();
  }
  if (
    finalStatus.isSymbolicLink() ||
    !finalStatus.isFile() ||
    finalStatus.dev !== expected.device ||
    finalStatus.ino !== expected.inode
  ) {
    throw ownershipLost();
  }
  try {
    await unlink(path);
  } catch {
    throw releaseFailed();
  }
}

async function cleanupFailedAcquisition(
  path: string,
  handle: FileHandle | undefined,
  identity: Omit<LeaseIdentity, 'token'> | undefined,
): Promise<void> {
  try {
    await handle?.close();
  } catch {
    throw releaseFailed();
  }
  if (identity === undefined) return;
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw releaseFailed();
  }
  if (status.dev !== identity.device || status.ino !== identity.inode) {
    throw ownershipLost();
  }
  try {
    await unlink(path);
  } catch {
    throw releaseFailed();
  }
}

export class RepositoryWriterLeaseManager implements RepositoryWriterLeasePort {
  readonly #hooks: RepositoryWriterLeaseHooks;

  constructor(hooks: RepositoryWriterLeaseHooks = {}) {
    this.#hooks = hooks;
  }

  async withLease<T>(
    repositoryRoot: string,
    operation: RepositoryWriterOperation,
    action: (lease: RepositoryWriterLease) => Promise<T> | T,
  ): Promise<T> {
    if (operation !== 'commit' && operation !== 'hierarchical-activation' &&
        operation !== 'parent-pin' && operation !== 'push' &&
        operation !== 'semantic-index-activation') {
      throw new RepositoryWriterError(
        'REPOSITORY_ACQUIRE_FAILED',
        'Repository writer operation is invalid.',
      );
    }
    let commonDirectory: string;
    try {
      commonDirectory = await resolveGitCommonDirectory(repositoryRoot);
    } catch {
      throw new RepositoryWriterError(
        'REPOSITORY_ACQUIRE_FAILED',
        'Repository writer identity could not be resolved.',
      );
    }
    const leasePath = join(commonDirectory, LEASE_FILE_NAME);
    let token: string;
    try {
      token = randomBytes(32).toString('hex');
    } catch {
      throw new RepositoryWriterError(
        'REPOSITORY_ACQUIRE_FAILED',
        'Repository writer ownership token could not be created.',
      );
    }
    let handle: FileHandle | undefined;
    let identityWithoutToken: Omit<LeaseIdentity, 'token'> | undefined;
    try {
      handle = await open(leasePath, 'wx+', 0o600);
      const status = await handle.stat();
      if (!status.isFile()) throw releaseFailed();
      identityWithoutToken = { device: status.dev, inode: status.ino };
      await handle.chmod(0o600);
      await writeLeaseRecord(handle, { operation, phase: 'acquired', token });
      await this.#hooks.afterAcquire?.();
    } catch (error) {
      if (handle !== undefined) {
        await cleanupFailedAcquisition(leasePath, handle, identityWithoutToken);
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new RepositoryWriterError(
          'REPOSITORY_BUSY',
          'Repository Git mutation is already in progress.',
        );
      }
      if (error instanceof RepositoryWriterError) throw error;
      throw new RepositoryWriterError(
        'REPOSITORY_ACQUIRE_FAILED',
        'Repository writer lease could not be acquired.',
      );
    }

    const acquiredHandle = handle;
    const identity: LeaseIdentity = {
      device: identityWithoutToken.device,
      inode: identityWithoutToken.inode,
      token,
    };
    const repositoryIdentityDigest = createHash('sha256').update(commonDirectory).digest('hex');
    const lease: RepositoryWriterLease = {
      repositoryIdentityDigest,
      updatePhase: async (phase: string): Promise<void> => {
        if (!PHASE_PATTERN.test(phase)) {
          throw new RepositoryWriterError(
            'REPOSITORY_ACQUIRE_FAILED',
            'Repository writer phase is invalid.',
          );
        }
        const current = await assertLeaseOwnership(leasePath, identity);
        if (current.operation !== operation) throw ownershipLost();
        await writeLeaseRecord(acquiredHandle, { operation, phase, token });
      },
    };

    const outcome = await Promise.resolve().then(() => action(lease)).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    try {
      await this.#hooks.beforeRelease?.();
    } catch {
      try {
        await acquiredHandle.close();
      } catch {
        // The stable release failure below remains authoritative.
      }
      throw releaseFailed();
    }
    await releaseLease(leasePath, acquiredHandle, identity);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}

export function createRepositoryWriterLease(
  hooks: RepositoryWriterLeaseHooks = {},
): RepositoryWriterLeasePort {
  return new RepositoryWriterLeaseManager(hooks);
}
