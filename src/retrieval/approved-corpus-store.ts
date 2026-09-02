import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  checkAuthoritativeWikiState,
  verifyCompileRunApproval,
  type AuthoritativeWikiCheckV1,
  type AuthoritativeWikiStateV1,
  type CompileRunLedgerV1,
  type CorpusSnapshotV1,
  type CurrentSessionGenerationExchangeV1,
  type FinalizeCompileRunInputV1,
  type HumanActivationApprovalV1,
  type PageOwnershipGraphV1,
} from '../compiler/index.js';
import { serializeCanonicalJson, syncDirectory, writeJsonAtomic } from '../knowledge/atomic-file.js';
import { isNodeError } from '../knowledge/errors.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { decodeUtf8Strict, parseJsonStrict } from '../knowledge/strict-json.js';
import {
  createApprovedWikiRetrieval,
  projectApprovedWikiForRetrieval,
  type ApprovedWikiRetrievalCorpusV1,
  type ProjectApprovedWikiInputV1,
} from './hierarchical.js';

export const APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION =
  'buildlore.approved-wiki-retrieval-projection.v1' as const;
export const APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION =
  'buildlore.approved-wiki-authority.v1' as const;
export const APPROVED_WIKI_AUTHORITY_RECORD_SCHEMA_VERSION =
  'buildlore.approved-wiki-authority-record.v1' as const;

const STORE_DIRECTORY = 'buildlore-hierarchy';
const STORE_FILENAME = 'approved-authority.json';
const STORE_LOCK_FILENAME = 'approved-authority.json.lock';
const MAXIMUM_AUTHORITY_BYTES = 64 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const AUTHORITY_PROPERTIES = Object.freeze([
  'authorityCheck',
  'currentState',
  'finalization',
  'humanActivationApproval',
  'ledger',
  'liveSnapshot',
  'ownershipGraph',
  'projectId',
  'schemaVersion',
  'state',
] as const);

export type ApprovedWikiProjectionErrorCode =
  | 'APPROVED_WIKI_PROJECTION_INVALID'
  | 'APPROVED_WIKI_PROJECTION_PROJECT_MISMATCH'
  | 'APPROVED_WIKI_PROJECTION_UNAVAILABLE'
  | 'APPROVED_WIKI_PROJECTION_WRITE_FAILED';

export class ApprovedWikiProjectionError extends Error {
  readonly code: ApprovedWikiProjectionErrorCode;
  readonly retryable: boolean;

  constructor(code: ApprovedWikiProjectionErrorCode) {
    super(code === 'APPROVED_WIKI_PROJECTION_UNAVAILABLE'
      ? 'Approved hierarchical Wiki authority is unavailable.'
      : code === 'APPROVED_WIKI_PROJECTION_PROJECT_MISMATCH'
        ? 'Approved hierarchical Wiki authority project does not match.'
        : code === 'APPROVED_WIKI_PROJECTION_WRITE_FAILED'
          ? 'Approved hierarchical Wiki authority could not be stored safely.'
          : 'Approved hierarchical Wiki authority is invalid.');
    this.name = 'ApprovedWikiProjectionError';
    this.code = code;
    this.retryable = code === 'APPROVED_WIKI_PROJECTION_UNAVAILABLE' ||
      code === 'APPROVED_WIKI_PROJECTION_WRITE_FAILED';
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({ code: this.code, message: this.message, retryable: this.retryable });
  }
}

/** Complete tracked authority; retrieval is always re-derived from this value. */
export interface ApprovedWikiAuthorityV1 {
  readonly schemaVersion: typeof APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION;
  readonly projectId: string;
  readonly currentState: AuthoritativeWikiStateV1 | null;
  readonly finalization: FinalizeCompileRunInputV1;
  readonly humanActivationApproval: HumanActivationApprovalV1;
  readonly ledger: CompileRunLedgerV1;
  readonly liveSnapshot: CorpusSnapshotV1;
  readonly ownershipGraph: PageOwnershipGraphV1;
  readonly state: AuthoritativeWikiStateV1;
  readonly authorityCheck: AuthoritativeWikiCheckV1;
}

export interface ApprovedWikiRetrievalProjectionV1 {
  readonly schemaVersion: typeof APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly sanitizerPolicyDigest: `sha256:${string}`;
  readonly corpus: ApprovedWikiRetrievalCorpusV1;
  readonly projectionDigest: `sha256:${string}`;
}

/** Verified, path-free authority identity shared by publication and derived views. */
export interface ApprovedWikiPublicationSnapshotV1 {
  readonly authority: ApprovedWikiAuthorityV1;
  readonly authorityDigest: `sha256:${string}`;
  readonly projection: ApprovedWikiRetrievalProjectionV1;
  readonly recordDigest: `sha256:${string}`;
}

interface ApprovedWikiAuthorityRecordV1 {
  readonly schemaVersion: typeof APPROVED_WIKI_AUTHORITY_RECORD_SCHEMA_VERSION;
  readonly projectId: string;
  readonly authority: ApprovedWikiAuthorityV1;
  readonly authorityDigest: `sha256:${string}`;
  readonly recordDigest: `sha256:${string}`;
}

export type ApprovedWikiProjectionStatusV1 =
  | Readonly<{ readonly projectId: string; readonly state: 'none' }>
  | Readonly<{
      readonly corpusDigest: `sha256:${string}`;
      readonly generationDigest: `sha256:${string}`;
      readonly pageCount: number;
      readonly projectId: string;
      readonly projectionDigest: `sha256:${string}`;
      readonly sanitizerPolicyDigest: `sha256:${string}`;
      readonly state: 'ready';
    }>
  | Readonly<{ readonly projectId: string; readonly state: 'invalid' }>;

export interface ApprovedWikiProjectionStorePort {
  publish(input: Readonly<{
    readonly authority: ApprovedWikiAuthorityV1;
    readonly projectId: string;
  }>): Promise<ApprovedWikiRetrievalProjectionV1>;
  read(projectId: string): Promise<ApprovedWikiRetrievalProjectionV1>;
  readAuthority(projectId: string): Promise<ApprovedWikiAuthorityV1>;
  status(projectId: string): Promise<ApprovedWikiProjectionStatusV1>;
}

/** @internal Deterministic filesystem fault injection for store boundary tests. */
export interface ApprovedWikiProjectionStoreTestHooks {
  readonly beforeCommit?: () => Promise<void> | void;
  readonly beforeLockOpen?: () => Promise<void> | void;
  readonly beforeLockRelease?: () => Promise<void> | void;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: ApprovedWikiProjectionErrorCode): never {
  throw new ApprovedWikiProjectionError(code);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function snapshotAuthority(
  value: ApprovedWikiAuthorityV1,
): ApprovedWikiAuthorityV1 {
  try {
    const parsed = parseJsonStrict(serializeCanonicalJson(value));
    if (!isRecord(parsed)) fail('APPROVED_WIKI_PROJECTION_INVALID');
    return parsed as unknown as ApprovedWikiAuthorityV1;
  } catch (error) {
    if (error instanceof ApprovedWikiProjectionError) throw error;
    fail('APPROVED_WIKI_PROJECTION_INVALID');
  }
}

function verifyAuthority(
  value: ApprovedWikiAuthorityV1,
  expectedProjectId: string,
): ProjectApprovedWikiInputV1 {
  if (!isRecord(value) ||
      Object.keys(value).sort().join('\0') !== [...AUTHORITY_PROPERTIES].sort().join('\0') ||
      value.schemaVersion !== APPROVED_WIKI_AUTHORITY_SCHEMA_VERSION ||
      value.projectId !== expectedProjectId) {
    fail(value.projectId === expectedProjectId
      ? 'APPROVED_WIKI_PROJECTION_INVALID'
      : 'APPROVED_WIKI_PROJECTION_PROJECT_MISMATCH');
  }
  try {
    const expectedState = verifyCompileRunApproval({
      currentState: value.currentState,
      finalization: value.finalization,
      humanActivationApproval: value.humanActivationApproval,
      ledger: value.ledger,
      liveSnapshot: value.liveSnapshot,
      ownershipGraph: value.ownershipGraph,
    }, expectedProjectId);
    if (!sameValue(expectedState, value.state)) fail('APPROVED_WIKI_PROJECTION_INVALID');
    const expectedCheck = checkAuthoritativeWikiState(
      expectedState,
      value.ownershipGraph,
      value.liveSnapshot,
      value.humanActivationApproval,
      expectedProjectId,
    );
    if (!sameValue(expectedCheck, value.authorityCheck) || expectedCheck.status !== 'clean' ||
        expectedCheck.retrievalStalePageIds.length !== 0) {
      fail('APPROVED_WIKI_PROJECTION_INVALID');
    }
    return Object.freeze({
      authorityCheck: expectedCheck,
      evidencePacks: value.finalization.evidencePacks,
      inheritedCitationAuthorizations: Object.freeze(value.finalization.generationHandoffs
        .map((handoff) => handoff.exchange as CurrentSessionGenerationExchangeV1)
        .map((exchange) => Object.freeze({
          pageId: exchange.pageId,
          citationIds: Object.freeze([...new Set(exchange.request.approvedChildSummaries
            .flatMap((summary) => [...summary.citationIds]))].sort()),
        }))
        .sort((left, right) => left.pageId < right.pageId ? -1 : 1)),
      ownershipGraph: value.ownershipGraph,
      proposals: value.finalization.proposals,
      state: expectedState,
    });
  } catch (error) {
    if (error instanceof ApprovedWikiProjectionError) throw error;
    fail('APPROVED_WIKI_PROJECTION_INVALID');
  }
}

/** Replays all receipt-, review-, ledger-, ownership-, and human-approval authority bindings. */
export function verifyApprovedWikiAuthority(
  value: ApprovedWikiAuthorityV1,
  expectedProjectId: string,
): void {
  verifyAuthority(value, expectedProjectId);
}

function projectAuthority(
  authority: ApprovedWikiAuthorityV1,
  projectId: string,
): ApprovedWikiRetrievalProjectionV1 {
  const approvedWiki = verifyAuthority(authority, projectId);
  let corpus: ApprovedWikiRetrievalCorpusV1;
  try {
    corpus = projectApprovedWikiForRetrieval(approvedWiki, projectId);
    createApprovedWikiRetrieval(corpus, projectId);
  } catch (error) {
    if (error instanceof ApprovedWikiProjectionError) throw error;
    fail('APPROVED_WIKI_PROJECTION_INVALID');
  }
  const basis = Object.freeze({
    corpus,
    projectId,
    sanitizerPolicyDigest: authority.liveSnapshot.sanitizerPolicyDigest,
    schemaVersion: APPROVED_WIKI_RETRIEVAL_PROJECTION_SCHEMA_VERSION,
  });
  return Object.freeze({ ...basis, projectionDigest: digest(basis) });
}

/** Creates one immutable authority/projection snapshot without persisting it. */
export function prepareApprovedWikiPublication(
  value: ApprovedWikiAuthorityV1,
  projectId: string,
): ApprovedWikiPublicationSnapshotV1 {
  const authority = snapshotAuthority(value);
  if (authority.projectId !== projectId) {
    fail('APPROVED_WIKI_PROJECTION_PROJECT_MISMATCH');
  }
  const projection = projectAuthority(authority, projectId);
  const authorityDigest = digest(authority);
  const basis = Object.freeze({
    authority,
    authorityDigest,
    projectId,
    schemaVersion: APPROVED_WIKI_AUTHORITY_RECORD_SCHEMA_VERSION,
  });
  return Object.freeze({
    authority,
    authorityDigest,
    projection,
    recordDigest: digest(basis),
  });
}

async function safeDirectory(path: string): Promise<void> {
  try {
    const [status, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== resolve(path)) {
      fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
    }
  } catch (error) {
    if (error instanceof ApprovedWikiProjectionError) throw error;
    fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
  }
}

async function ensureStoreDirectory(workspace: string): Promise<string> {
  const compilerRoot = join(workspace, '.llmwiki');
  const storeRoot = join(compilerRoot, STORE_DIRECTORY);
  for (const directory of [compilerRoot, storeRoot]) {
    try {
      await mkdir(directory, { mode: 0o700 });
      await syncDirectory(resolve(directory, '..'));
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
      }
    }
    await safeDirectory(directory);
  }
  return storeRoot;
}

interface StoreDirectoryIdentity {
  readonly storeRoot: Readonly<{
    readonly device: number;
    readonly inode: number;
    readonly path: string;
  }>;
  readonly workspace: Readonly<{
    readonly device: number;
    readonly inode: number;
    readonly path: string;
  }>;
}

interface StoreLockIdentity {
  readonly device: number;
  readonly inode: number;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function captureStoreDirectoryIdentity(
  workspace: string,
  storeRoot: string,
): Promise<StoreDirectoryIdentity> {
  try {
    const workspacePath = resolve(workspace);
    const storeRootPath = resolve(storeRoot);
    const [workspaceStatus, storeRootStatus, canonicalWorkspace, canonicalStoreRoot] =
      await Promise.all([
        lstat(workspacePath),
        lstat(storeRootPath),
        realpath(workspacePath),
        realpath(storeRootPath),
      ]);
    if (
      !workspaceStatus.isDirectory() || workspaceStatus.isSymbolicLink() ||
      !storeRootStatus.isDirectory() || storeRootStatus.isSymbolicLink() ||
      canonicalWorkspace !== workspacePath || canonicalStoreRoot !== storeRootPath ||
      storeRootPath !== resolve(workspacePath, '.llmwiki', STORE_DIRECTORY) ||
      !isContained(workspacePath, storeRootPath)
    ) fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
    return Object.freeze({
      storeRoot: Object.freeze({
        device: storeRootStatus.dev,
        inode: storeRootStatus.ino,
        path: storeRootPath,
      }),
      workspace: Object.freeze({
        device: workspaceStatus.dev,
        inode: workspaceStatus.ino,
        path: workspacePath,
      }),
    });
  } catch (error) {
    if (error instanceof ApprovedWikiProjectionError) throw error;
    fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
  }
}

async function matchesStoreDirectoryIdentity(identity: StoreDirectoryIdentity): Promise<boolean> {
  try {
    const [workspaceStatus, storeRootStatus, canonicalWorkspace, canonicalStoreRoot] =
      await Promise.all([
        lstat(identity.workspace.path),
        lstat(identity.storeRoot.path),
        realpath(identity.workspace.path),
        realpath(identity.storeRoot.path),
      ]);
    return workspaceStatus.isDirectory() && !workspaceStatus.isSymbolicLink() &&
      workspaceStatus.dev === identity.workspace.device &&
      workspaceStatus.ino === identity.workspace.inode &&
      canonicalWorkspace === identity.workspace.path &&
      storeRootStatus.isDirectory() && !storeRootStatus.isSymbolicLink() &&
      storeRootStatus.dev === identity.storeRoot.device &&
      storeRootStatus.ino === identity.storeRoot.inode &&
      canonicalStoreRoot === identity.storeRoot.path &&
      isContained(identity.workspace.path, identity.storeRoot.path);
  } catch {
    return false;
  }
}

async function assertStoreDirectoryIdentity(identity: StoreDirectoryIdentity): Promise<void> {
  if (!await matchesStoreDirectoryIdentity(identity)) {
    fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
  }
}

function exactLockPath(identity: StoreDirectoryIdentity): string {
  const lockPath = resolve(identity.storeRoot.path, STORE_LOCK_FILENAME);
  if (lockPath !== join(identity.storeRoot.path, STORE_LOCK_FILENAME) ||
      !isContained(identity.storeRoot.path, lockPath)) {
    fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
  }
  return lockPath;
}

function parseAuthorityRecord(
  value: unknown,
  expectedProjectId: string,
): ApprovedWikiAuthorityRecordV1 {
  if (!isRecord(value) || Object.keys(value).sort().join('\0') !== [
    'authority',
    'authorityDigest',
    'projectId',
    'recordDigest',
    'schemaVersion',
  ].sort().join('\0') ||
      value.schemaVersion !== APPROVED_WIKI_AUTHORITY_RECORD_SCHEMA_VERSION ||
      typeof value.projectId !== 'string' ||
      typeof value.authorityDigest !== 'string' ||
      typeof value.recordDigest !== 'string' ||
      !DIGEST_PATTERN.test(value.authorityDigest) ||
      !DIGEST_PATTERN.test(value.recordDigest) ||
      !isRecord(value.authority)) {
    fail('APPROVED_WIKI_PROJECTION_INVALID');
  }
  if (value.projectId !== expectedProjectId || value.authority.projectId !== expectedProjectId) {
    fail('APPROVED_WIKI_PROJECTION_PROJECT_MISMATCH');
  }
  const authority = value.authority as unknown as ApprovedWikiAuthorityV1;
  const basis = Object.freeze({
    authority,
    authorityDigest: value.authorityDigest,
    projectId: value.projectId,
    schemaVersion: value.schemaVersion,
  });
  if (value.authorityDigest !== digest(authority) || value.recordDigest !== digest(basis)) {
    fail('APPROVED_WIKI_PROJECTION_INVALID');
  }
  verifyAuthority(authority, expectedProjectId);
  return Object.freeze({ ...basis, recordDigest: value.recordDigest }) as
    ApprovedWikiAuthorityRecordV1;
}

async function readAuthorityRecord(
  knowledgeRoot: string,
  projectId: string,
): Promise<ApprovedWikiAuthorityRecordV1> {
  const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
  const path = join(workspace, '.llmwiki', STORE_DIRECTORY, STORE_FILENAME);
  const record = await readAuthorityRecordAtPath(path, projectId);
  if (record === null) fail('APPROVED_WIKI_PROJECTION_UNAVAILABLE');
  return record;
}

/** Reads and replays the exact persisted authority record and its derived projection. */
export async function readApprovedWikiPublicationSnapshot(
  knowledgeRoot: string,
  projectId: string,
): Promise<ApprovedWikiPublicationSnapshotV1> {
  const record = await readAuthorityRecord(knowledgeRoot, projectId);
  return Object.freeze({
    authority: record.authority,
    authorityDigest: record.authorityDigest,
    projection: projectAuthority(record.authority, projectId),
    recordDigest: record.recordDigest,
  });
}

async function readAuthorityRecordAtPath(
  path: string,
  projectId: string,
): Promise<ApprovedWikiAuthorityRecordV1 | null> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size < 2 ||
        status.size > MAXIMUM_AUTHORITY_BYTES || await realpath(path) !== resolve(path)) {
      fail('APPROVED_WIKI_PROJECTION_INVALID');
    }
    return parseAuthorityRecord(parseJsonStrict(decodeUtf8Strict(await readFile(path))), projectId);
  } catch (error) {
    if (error instanceof ApprovedWikiProjectionError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    fail('APPROVED_WIKI_PROJECTION_INVALID');
  }
}

async function lockPathMatches(
  directoryIdentity: StoreDirectoryIdentity,
  lockPath: string,
  lockIdentity: StoreLockIdentity,
): Promise<boolean> {
  if (!await matchesStoreDirectoryIdentity(directoryIdentity) ||
      lockPath !== exactLockPath(directoryIdentity)) return false;
  try {
    const status = await lstat(lockPath);
    return status.isFile() && !status.isSymbolicLink() &&
      status.dev === lockIdentity.device && status.ino === lockIdentity.inode &&
      await realpath(lockPath) === lockPath;
  } catch {
    return false;
  }
}

async function assertStoreLockIdentity(
  directoryIdentity: StoreDirectoryIdentity,
  lockPath: string,
  lockIdentity: StoreLockIdentity,
): Promise<void> {
  if (!await lockPathMatches(directoryIdentity, lockPath, lockIdentity)) {
    fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
  }
}

async function withStoreLock<T>(
  directoryIdentity: StoreDirectoryIdentity,
  hooks: ApprovedWikiProjectionStoreTestHooks,
  action: (assertLockOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lockPath = exactLockPath(directoryIdentity);
  let handle: FileHandle | undefined;
  let lockIdentity: StoreLockIdentity | undefined;
  try {
    await assertStoreDirectoryIdentity(directoryIdentity);
    await hooks.beforeLockOpen?.();
    await assertStoreDirectoryIdentity(directoryIdentity);
    handle = await open(lockPath, 'wx', 0o600);
    const status = await handle.stat();
    if (!status.isFile()) fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
    lockIdentity = Object.freeze({ device: status.dev, inode: status.ino });
    await assertStoreLockIdentity(directoryIdentity, lockPath, lockIdentity);
    await handle.writeFile('buildlore approved authority mutation\n', 'utf8');
    await handle.sync();
    await assertStoreLockIdentity(directoryIdentity, lockPath, lockIdentity);
  } catch {
    if (handle !== undefined && lockIdentity !== undefined) {
      await releaseStoreLock(
        directoryIdentity,
        lockPath,
        handle,
        lockIdentity,
      ).catch(() => false);
    } else {
      await handle?.close().catch(() => undefined);
    }
    fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
  }
  const assertLockOwned = () => assertStoreLockIdentity(
    directoryIdentity,
    lockPath,
    lockIdentity,
  );
  const outcome = await Promise.resolve().then(assertLockOwned).then(() =>
    action(assertLockOwned)).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  try {
    await hooks.beforeLockRelease?.();
  } catch {
    // Cleanup hooks cannot change the already committed outcome.
  }
  const released = await releaseStoreLock(
    directoryIdentity,
    lockPath,
    handle,
    lockIdentity,
  );
  if (!outcome.ok) {
    if (!released) fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
    throw outcome.error;
  }
  // Atomic authority replacement is the commit point. A later cleanup failure must not
  // report failure while the new authority is already durable; an unowned replacement
  // lock is deliberately preserved and safely blocks the next writer.
  return outcome.value;
}

async function releaseStoreLock(
  directoryIdentity: StoreDirectoryIdentity,
  lockPath: string,
  handle: FileHandle,
  lockIdentity: StoreLockIdentity,
): Promise<boolean> {
  try {
    await handle.close();
    if (!await lockPathMatches(directoryIdentity, lockPath, lockIdentity)) return false;
    await unlink(lockPath);
    await syncDirectory(directoryIdentity.storeRoot.path);
    return true;
  } catch {
    return false;
  }
}

export function createApprovedWikiProjectionStore(
  knowledgeRoot: string,
  hooks: ApprovedWikiProjectionStoreTestHooks = {},
): ApprovedWikiProjectionStorePort {
  const store: ApprovedWikiProjectionStorePort = {
    async publish(input) {
      const projectId = input.projectId;
      const prepared = prepareApprovedWikiPublication(input.authority, projectId);
      const { authority, authorityDigest, projection, recordDigest } = prepared;
      const basis = Object.freeze({
        authority,
        authorityDigest,
        projectId,
        schemaVersion: APPROVED_WIKI_AUTHORITY_RECORD_SCHEMA_VERSION,
      });
      const record = Object.freeze({ ...basis, recordDigest });
      const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, {
        mustExist: true,
      });
      const storeRoot = await ensureStoreDirectory(workspace);
      const directoryIdentity = await captureStoreDirectoryIdentity(workspace, storeRoot);
      await withStoreLock(directoryIdentity, hooks, async (assertLockOwned) => {
        const path = join(storeRoot, STORE_FILENAME);
        const previous = await readAuthorityRecordAtPath(path, projectId);
        if (
          (previous === null && authority.currentState !== null) ||
          (previous !== null && (authority.currentState === null ||
            !sameValue(authority.currentState, previous.authority.state)))
        ) {
          fail('APPROVED_WIKI_PROJECTION_INVALID');
        }
        try {
          await assertLockOwned();
          await hooks.beforeCommit?.();
          await assertLockOwned();
          await writeJsonAtomic(path, record, { confinementRoot: workspace });
        } catch {
          fail('APPROVED_WIKI_PROJECTION_WRITE_FAILED');
        }
      });
      return projection;
    },
    async read(projectId) {
      const record = await readAuthorityRecord(knowledgeRoot, projectId);
      return projectAuthority(record.authority, projectId);
    },
    async readAuthority(projectId) {
      return (await readAuthorityRecord(knowledgeRoot, projectId)).authority;
    },
    async status(projectId) {
      try {
        const projection = await store.read(projectId);
        return Object.freeze({
          corpusDigest: projection.corpus.corpusDigest,
          generationDigest: projection.corpus.generationDigest,
          pageCount: projection.corpus.pages.length,
          projectId,
          projectionDigest: projection.projectionDigest,
          sanitizerPolicyDigest: projection.sanitizerPolicyDigest,
          state: 'ready' as const,
        });
      } catch (error) {
        if (error instanceof ApprovedWikiProjectionError &&
            error.code === 'APPROVED_WIKI_PROJECTION_UNAVAILABLE') {
          return Object.freeze({ projectId, state: 'none' as const });
        }
        return Object.freeze({ projectId, state: 'invalid' as const });
      }
    },
  };
  return Object.freeze(store);
}
