import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  normalize,
  relative,
} from 'node:path';

import {
  serializeCanonicalJson,
  syncDirectory,
  type AtomicWriteHooks,
  writeJsonAtomic,
} from './atomic-file.js';
import { isNodeError, KnowledgeError } from './errors.js';
import { resolveGitCommonDirectory, resolveGitWorktreeRoot } from './git.js';
import { decodeUtf8Strict, parseJsonStrict } from './strict-json.js';
import { validateProjectId, validateRepositoryLocator } from './validation.js';

export const LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION = 'buildlore.local-projects.v1' as const;
export const MAX_LOCAL_PROJECT_REGISTRY_BYTES = 1024 * 1024;

const LOCAL_STATE_DIRECTORY = '.buildlore';
const LOCAL_REGISTRY_FILENAME = 'local-projects.json';
const LOCAL_REGISTRY_LOCK_FILENAME = 'local-projects.json.lock';
const LOCAL_REGISTRY_GIT_EXCLUDE_RULES = Object.freeze([
  '/.buildlore/local-projects.json',
  '/.buildlore/local-projects.json.lock',
  '/.buildlore/.local-projects.json.*.tmp',
]);
const MAX_GIT_EXCLUDE_BYTES = 256 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type Sha256Digest = `sha256:${string}`;

export interface LocalProjectBindingRecord {
  readonly projectId: string;
  readonly sourceRepositoryDigest: Sha256Digest;
  readonly sourceRoot: string;
}

export interface LocalProjectRegistry {
  readonly bindings: readonly LocalProjectBindingRecord[];
  readonly schemaVersion: typeof LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION;
}

export interface BindLocalProjectInput {
  readonly expectedBindingDigest?: Sha256Digest | null;
  readonly projectId: string;
  readonly sourceRepository: string;
  readonly sourceRoot: string;
}

export interface BindLocalProjectResult {
  readonly bindingDigest: Sha256Digest;
  readonly outcome: 'created' | 'replaced' | 'unchanged';
  readonly projectId: string;
}

export interface InitializeLocalProjectRegistryResult {
  readonly bindingCount: number;
  readonly outcome: 'created' | 'existing';
  readonly schemaVersion: typeof LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION;
}

export interface InspectLocalProjectBindingCandidateInput {
  readonly allowReplacement: boolean;
  readonly projectId: string;
  readonly sourceRepository: string;
  readonly sourceRoot: string;
}

export interface InspectedLocalProjectBindingCandidate {
  readonly checkout: SourceCheckoutHandle;
  readonly currentBindingDigest: Sha256Digest | null;
  readonly proposedBindingDigest: Sha256Digest;
  readonly projectId: string;
  readonly sourceRepositoryDigest: Sha256Digest;
}

export interface ResolvedLocalProjectBinding {
  readonly bindingDigest: Sha256Digest;
  readonly checkout: SourceCheckoutHandle;
  readonly projectId: string;
  readonly sourceRepositoryDigest: Sha256Digest;
}

/** Package-internal fault seams used to prove atomicity and lock behavior. */
export interface LocalProjectRegistryHooks extends AtomicWriteHooks {
  readonly afterLockOpen?: () => Promise<void> | void;
  readonly beforeRegistryWrite?: () => Promise<void> | void;
}

interface SourceRootIdentity {
  readonly device: number;
  readonly inode: number;
  readonly root: string;
}

/**
 * Opaque capability for a validated checkout. Its absolute root is a private
 * slot, so JSON serialization and ordinary inspection expose safe identity only.
 */
export class SourceCheckoutHandle {
  readonly projectId: string;
  readonly sourceRepositoryDigest: Sha256Digest;
  readonly #sourceRoot: string;

  /** @internal Construct handles only after local registry validation. */
  constructor(projectId: string, sourceRepositoryDigest: Sha256Digest, sourceRoot: string) {
    this.projectId = projectId;
    this.sourceRepositoryDigest = sourceRepositoryDigest;
    this.#sourceRoot = sourceRoot;
    Object.freeze(this);
  }

  /** @internal Source readers use this only after receiving the opaque handle. */
  resolveRootForInternalUse(): string {
    return this.#sourceRoot;
  }

  toJSON(): Readonly<{ projectId: string; sourceRepositoryDigest: Sha256Digest }> {
    return Object.freeze({
      projectId: this.projectId,
      sourceRepositoryDigest: this.sourceRepositoryDigest,
    });
  }
}

function invalid(message: string): never {
  throw new KnowledgeError('SOURCE_BINDING_INVALID', message, {
    recoveryCommand: ['project', 'bind'],
  });
}

function conflict(message: string): never {
  throw new KnowledgeError('SOURCE_BINDING_CONFLICT', message, {
    recoveryCommand: ['project', 'bind'],
  });
}

function writeFailed(message: string): never {
  throw new KnowledgeError('SOURCE_BINDING_WRITE_FAILED', message, {
    recoveryCommand: ['project', 'bind'],
  });
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${label} contains missing or unsupported fields.`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  return value;
}

function validateLocalProjectId(value: unknown): string {
  const projectId = requireString(value, 'projectId');
  try {
    return validateProjectId(projectId);
  } catch {
    return invalid('projectId binding field is invalid.');
  }
}

function validateDigest(value: unknown, label: string): Sha256Digest {
  const digest = requireString(value, label);
  if (!SHA256_PATTERN.test(digest)) invalid(`${label} binding field is invalid.`);
  return digest as Sha256Digest;
}

function validateStoredSourceRoot(value: unknown): string {
  const sourceRoot = requireString(value, 'sourceRoot');
  if (
    !isAbsolute(sourceRoot) ||
    normalize(sourceRoot) !== sourceRoot ||
    containsControlCharacter(sourceRoot)
  ) {
    invalid('sourceRoot binding field must be a canonical absolute path.');
  }
  return sourceRoot;
}

function parseBinding(value: unknown): LocalProjectBindingRecord {
  const record = asRecord(value, 'Local project binding');
  requireExactKeys(
    record,
    ['projectId', 'sourceRepositoryDigest', 'sourceRoot'],
    'Local project binding',
  );
  return Object.freeze({
    projectId: validateLocalProjectId(record.projectId),
    sourceRepositoryDigest: validateDigest(
      record.sourceRepositoryDigest,
      'sourceRepositoryDigest',
    ),
    sourceRoot: validateStoredSourceRoot(record.sourceRoot),
  });
}

export function emptyLocalProjectRegistry(): LocalProjectRegistry {
  return Object.freeze({
    bindings: Object.freeze([]),
    schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
  });
}

export function parseLocalProjectRegistry(value: unknown): LocalProjectRegistry {
  const record = asRecord(value, 'Local project registry');
  requireExactKeys(record, ['bindings', 'schemaVersion'], 'Local project registry');
  if (
    record.schemaVersion !== LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION ||
    !Array.isArray(record.bindings)
  ) {
    invalid('Local project registry schema is unsupported.');
  }
  const bindings = record.bindings.map(parseBinding);
  const projectIds = new Set<string>();
  const sourceRoots = new Set<string>();
  for (const binding of bindings) {
    if (projectIds.has(binding.projectId)) {
      invalid('Local project registry contains a duplicate projectId.');
    }
    if (sourceRoots.has(binding.sourceRoot)) {
      invalid('Local project registry contains a duplicate sourceRoot binding field.');
    }
    projectIds.add(binding.projectId);
    sourceRoots.add(binding.sourceRoot);
  }
  return Object.freeze({
    bindings: Object.freeze(
      [...bindings].sort((left, right) =>
        left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0,
      ),
    ),
    schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
  });
}

export function sourceRepositoryDigestFor(sourceRepository: string): Sha256Digest {
  let portableRepository: string;
  try {
    portableRepository = validateRepositoryLocator(sourceRepository);
  } catch {
    return invalid('sourceRepository binding field is invalid.');
  }
  return `sha256:${createHash('sha256').update(portableRepository, 'utf8').digest('hex')}`;
}

function bindingDigestFor(binding: LocalProjectBindingRecord): Sha256Digest {
  return `sha256:${createHash('sha256')
    .update(serializeCanonicalJson(binding), 'utf8')
    .digest('hex')}`;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

function rootsOverlap(left: string, right: string): boolean {
  return isContained(left, right) || isContained(right, left);
}

function hasOwnerOnlyPermissions(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0;
}

async function resolveHubRoot(hubRoot: string): Promise<string> {
  if (!isAbsolute(hubRoot) || normalize(hubRoot) !== hubRoot) {
    return invalid('Hub root must be a canonical absolute directory.');
  }
  try {
    const [status, canonical] = await Promise.all([lstat(hubRoot), realpath(hubRoot)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== hubRoot) {
      return invalid('Hub root must be a canonical non-symlink directory.');
    }
    return canonical;
  } catch {
    return invalid('Hub root is missing or inaccessible.');
  }
}

async function inspectLocalStateDirectory(
  hubRoot: string,
  allowMissing: boolean,
): Promise<string | null> {
  const stateDirectory = join(hubRoot, LOCAL_STATE_DIRECTORY);
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(stateDirectory);
  } catch (error) {
    if (allowMissing && isNodeError(error) && error.code === 'ENOENT') return null;
    return invalid('Hub local-state directory is missing or inaccessible.');
  }
  try {
    const canonical = await realpath(stateDirectory);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      canonical !== stateDirectory ||
      !hasOwnerOnlyPermissions(status.mode)
    ) {
      return invalid('Hub local-state directory is unsafe.');
    }
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    return invalid('Hub local-state directory is unsafe.');
  }
  return stateDirectory;
}

async function prepareLocalStateDirectory(hubRoot: string): Promise<string> {
  const stateDirectory = join(hubRoot, LOCAL_STATE_DIRECTORY);
  try {
    await mkdir(stateDirectory, { mode: 0o700 });
    await syncDirectory(hubRoot);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      return writeFailed('Hub local-state directory could not be prepared.');
    }
  }
  let status: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    [status, canonical] = await Promise.all([lstat(stateDirectory), realpath(stateDirectory)]);
  } catch {
    return writeFailed('Hub local-state directory could not be verified.');
  }
  if (!status.isDirectory() || status.isSymbolicLink() || canonical !== stateDirectory) {
    return writeFailed('Hub local-state directory is unsafe.');
  }
  if (process.platform !== 'win32') {
    try {
      await chmod(stateDirectory, 0o700);
      status = await lstat(stateDirectory);
    } catch {
      return writeFailed('Hub local-state permissions could not be secured.');
    }
    if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      return writeFailed('Hub local-state permissions are unsafe.');
    }
  }
  return stateDirectory;
}

/** Ensure machine-local registry files stay outside the parent hub Git index. */
export async function ensureLocalProjectRegistryIgnored(hubRoot: string): Promise<void> {
  const root = await resolveHubRoot(hubRoot);
  let commonGitDirectory: string;
  try {
    commonGitDirectory = await resolveGitCommonDirectory(root);
  } catch {
    return writeFailed('Hub local project registry ignore policy is unavailable.');
  }
  const infoDirectory = join(commonGitDirectory, 'info');
  try {
    const [status, canonical] = await Promise.all([
      lstat(infoDirectory),
      realpath(infoDirectory),
    ]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== infoDirectory) {
      return writeFailed('Hub local project registry ignore policy is unsafe.');
    }
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    return writeFailed('Hub local project registry ignore policy is unavailable.');
  }

  const excludePath = join(infoDirectory, 'exclude');
  let handle;
  try {
    handle = await open(
      excludePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR,
      0o600,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_GIT_EXCLUDE_BYTES) {
      return writeFailed('Hub local project registry ignore policy is unsafe.');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_GIT_EXCLUDE_BYTES) {
      return writeFailed('Hub local project registry ignore policy is unsafe.');
    }
    const existingLines = new Set(bytes.toString('utf8').split(/\r?\n/u));
    const missing = LOCAL_REGISTRY_GIT_EXCLUDE_RULES.filter((rule) =>
      !existingLines.has(rule));
    if (missing.length === 0) return;
    const addition = Buffer.from(
      `${bytes.byteLength > 0 && bytes.at(-1) !== 0x0a ? '\n' : ''}${missing.join('\n')}\n`,
      'utf8',
    );
    if (bytes.byteLength + addition.byteLength > MAX_GIT_EXCLUDE_BYTES) {
      return writeFailed('Hub local project registry ignore policy is unsafe.');
    }
    const current = await handle.stat();
    if (
      !current.isFile() || current.dev !== before.dev || current.ino !== before.ino ||
      current.size !== before.size
    ) {
      return writeFailed('Hub local project registry ignore policy changed during update.');
    }
    const write = await handle.write(addition, 0, addition.byteLength, null);
    if (write.bytesWritten !== addition.byteLength) {
      return writeFailed('Hub local project registry ignore policy update was incomplete.');
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    return writeFailed('Hub local project registry ignore policy could not be updated.');
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the safe ignore-policy failure.
    }
  }
  await syncDirectory(infoDirectory);
}

async function readVerifiedRegistryFile(
  registryPath: string,
  expected: Awaited<ReturnType<typeof lstat>>,
): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(registryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      !hasOwnerOnlyPermissions(actual.mode) ||
      actual.size > MAX_LOCAL_PROJECT_REGISTRY_BYTES
    ) {
      return invalid('Hub local project registry file is unsafe.');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_LOCAL_PROJECT_REGISTRY_BYTES) {
      return invalid('Hub local project registry exceeds its size limit.');
    }
    return bytes;
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    return invalid('Hub local project registry could not be read safely.');
  } finally {
    try {
      await handle?.close();
    } catch {
      // The safe structured failure from the read remains authoritative.
    }
  }
}

export async function readLocalProjectRegistry(
  hubRoot: string,
  options: { readonly allowMissing?: boolean } = {},
): Promise<LocalProjectRegistry> {
  const root = await resolveHubRoot(hubRoot);
  const allowMissing = options.allowMissing === true;
  const stateDirectory = await inspectLocalStateDirectory(root, allowMissing);
  if (stateDirectory === null) return emptyLocalProjectRegistry();
  const registryPath = join(stateDirectory, LOCAL_REGISTRY_FILENAME);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(registryPath);
  } catch (error) {
    if (allowMissing && isNodeError(error) && error.code === 'ENOENT') {
      return emptyLocalProjectRegistry();
    }
    throw new KnowledgeError('SOURCE_BINDING_REQUIRED', 'Local source binding is required.', {
      recoveryCommand: ['project', 'bind'],
    });
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !hasOwnerOnlyPermissions(metadata.mode) ||
    metadata.size > MAX_LOCAL_PROJECT_REGISTRY_BYTES
  ) {
    return invalid('Hub local project registry file is unsafe.');
  }
  try {
    const decoded = decodeUtf8Strict(await readVerifiedRegistryFile(registryPath, metadata));
    const registry = parseLocalProjectRegistry(parseJsonStrict(decoded));
    if (serializeCanonicalJson(registry) !== decoded) {
      return invalid('Hub local project registry must use canonical JSON ordering.');
    }
    return registry;
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    return invalid('Hub local project registry is invalid JSON.');
  }
}

async function validateSourceRoot(
  hubRoot: string,
  sourceRoot: string,
): Promise<SourceRootIdentity> {
  validateStoredSourceRoot(sourceRoot);
  let status: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    [status, canonical] = await Promise.all([lstat(sourceRoot), realpath(sourceRoot)]);
  } catch {
    return invalid('sourceRoot binding field is missing or inaccessible.');
  }
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    canonical !== sourceRoot ||
    rootsOverlap(hubRoot, canonical)
  ) {
    return invalid('sourceRoot binding field is not a confined canonical checkout root.');
  }
  let gitRoot: string | null;
  try {
    gitRoot = await resolveGitWorktreeRoot(canonical);
  } catch {
    return invalid('sourceRoot binding field is not a valid Git checkout root.');
  }
  if (gitRoot !== canonical) {
    return invalid('sourceRoot binding field must equal the Git worktree root.');
  }
  return { device: status.dev, inode: status.ino, root: canonical };
}

async function assertSourceIdentityUnchanged(
  hubRoot: string,
  expected: SourceRootIdentity,
): Promise<void> {
  const actual = await validateSourceRoot(hubRoot, expected.root);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    invalid('sourceRoot binding field changed during validation.');
  }
}

async function writeLocalProjectRegistry(
  hubRoot: string,
  registry: LocalProjectRegistry,
  hooks: LocalProjectRegistryHooks,
): Promise<void> {
  const stateDirectory = await prepareLocalStateDirectory(hubRoot);
  const canonical = parseLocalProjectRegistry(registry);
  if (
    Buffer.byteLength(serializeCanonicalJson(canonical), 'utf8') >
    MAX_LOCAL_PROJECT_REGISTRY_BYTES
  ) {
    return invalid('Hub local project registry exceeds its size limit.');
  }
  try {
    await writeJsonAtomic(join(stateDirectory, LOCAL_REGISTRY_FILENAME), canonical, {
      ...hooks,
      confinementRoot: stateDirectory,
    });
  } catch {
    return writeFailed('Hub local project registry replacement failed safely.');
  }
}

export async function initializeLocalProjectRegistry(
  hubRoot: string,
  hooks: LocalProjectRegistryHooks = {},
): Promise<InitializeLocalProjectRegistryResult> {
  const root = await resolveHubRoot(hubRoot);
  return withLocalRegistryLock(root, async () => {
    const stateDirectory = await inspectLocalStateDirectory(root, false);
    if (stateDirectory === null) {
      return writeFailed('Hub local-state directory could not be prepared.');
    }
    const registryPath = join(stateDirectory, LOCAL_REGISTRY_FILENAME);
    let exists: boolean;
    try {
      await lstat(registryPath);
      exists = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        return invalid('Hub local project registry could not be inspected safely.');
      }
      exists = false;
    }

    if (exists) {
      const registry = await readLocalProjectRegistry(root);
      return Object.freeze({
        bindingCount: registry.bindings.length,
        outcome: 'existing' as const,
        schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
      });
    }

    await writeLocalProjectRegistry(root, emptyLocalProjectRegistry(), hooks);
    return Object.freeze({
      bindingCount: 0,
      outcome: 'created' as const,
      schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
    });
  }, hooks);
}

async function withLocalRegistryLock<T>(
  hubRoot: string,
  action: () => Promise<T>,
  hooks: LocalProjectRegistryHooks,
): Promise<T> {
  const stateDirectory = await prepareLocalStateDirectory(hubRoot);
  const lockPath = join(stateDirectory, LOCAL_REGISTRY_LOCK_FILENAME);
  let handle;
  let opened = false;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    opened = true;
    await hooks.afterLockOpen?.();
    await handle.writeFile('buildlore local registry mutation\n', 'utf8');
    await handle.sync();
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // The acquisition failure remains authoritative.
    }
    if (opened) {
      try {
        await unlink(lockPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
          return writeFailed('Hub local project registry lock cleanup failed.');
        }
      }
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new KnowledgeError('SOURCE_BINDING_BUSY', 'Local source binding registry is busy.', {
        recoveryCommand: ['project', 'bind'],
      });
    }
    return writeFailed('Hub local project registry lock could not be acquired.');
  }

  const outcome = await Promise.resolve().then(action).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  let cleanupFailed = false;
  try {
    await handle.close();
  } catch {
    cleanupFailed = true;
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') cleanupFailed = true;
  }
  if (cleanupFailed) return writeFailed('Hub local project registry lock release failed.');
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export async function bindLocalProject(
  hubRoot: string,
  input: BindLocalProjectInput,
  hooks: LocalProjectRegistryHooks = {},
): Promise<BindLocalProjectResult> {
  const root = await resolveHubRoot(hubRoot);
  const projectId = validateLocalProjectId(input.projectId);
  const sourceRepositoryDigest = sourceRepositoryDigestFor(input.sourceRepository);
  const sourceIdentity = await validateSourceRoot(root, input.sourceRoot);
  const expectedBindingDigest = input.expectedBindingDigest === undefined ||
      input.expectedBindingDigest === null
    ? input.expectedBindingDigest
    : validateDigest(input.expectedBindingDigest, 'expectedBindingDigest');

  return withLocalRegistryLock(root, async () => {
    await assertSourceIdentityUnchanged(root, sourceIdentity);
    const registry = await readLocalProjectRegistry(root, { allowMissing: true });
    const existing = registry.bindings.find((binding) => binding.projectId === projectId);
    const proposed = Object.freeze({
      projectId,
      sourceRepositoryDigest,
      sourceRoot: sourceIdentity.root,
    });
    const proposedDigest = bindingDigestFor(proposed);

    if (existing !== undefined) {
      const existingDigest = bindingDigestFor(existing);
      const unchanged = existing.sourceRepositoryDigest === sourceRepositoryDigest &&
        existing.sourceRoot === sourceIdentity.root;
      if (expectedBindingDigest === null) {
        return conflict('Existing source binding conflicts with project registration.');
      }
      if (unchanged) {
        if (
          expectedBindingDigest !== undefined &&
          expectedBindingDigest !== existingDigest
        ) {
          return conflict('expectedBindingDigest binding field does not match current state.');
        }
        return Object.freeze({
          bindingDigest: existingDigest,
          outcome: 'unchanged' as const,
          projectId,
        });
      }
      if (expectedBindingDigest === undefined || expectedBindingDigest !== existingDigest) {
        return conflict('Existing source binding requires an exact replacement digest.');
      }
    } else if (expectedBindingDigest !== undefined && expectedBindingDigest !== null) {
      return conflict('expectedBindingDigest binding field has no current binding.');
    }

    if (
      registry.bindings.some(
        (binding) =>
          binding.projectId !== projectId && binding.sourceRoot === sourceIdentity.root,
      )
    ) {
      return conflict('sourceRoot binding field is already assigned to another project.');
    }

    const bindings = registry.bindings.filter((binding) => binding.projectId !== projectId);
    await hooks.beforeRegistryWrite?.();
    await writeLocalProjectRegistry(
      root,
      {
        bindings: [...bindings, proposed],
        schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
      },
      hooks,
    );
    return Object.freeze({
      bindingDigest: proposedDigest,
      outcome: existing === undefined ? 'created' as const : 'replaced' as const,
      projectId,
    });
  }, hooks);
}

export async function inspectLocalProjectBindingCandidate(
  hubRoot: string,
  input: InspectLocalProjectBindingCandidateInput,
): Promise<InspectedLocalProjectBindingCandidate> {
  const root = await resolveHubRoot(hubRoot);
  const projectId = validateLocalProjectId(input.projectId);
  const sourceRepositoryDigest = sourceRepositoryDigestFor(input.sourceRepository);
  const sourceIdentity = await validateSourceRoot(root, input.sourceRoot);
  const registry = await readLocalProjectRegistry(root, { allowMissing: true });
  const existing = registry.bindings.find((binding) => binding.projectId === projectId);

  if (existing !== undefined && !input.allowReplacement) {
    return conflict('Existing source binding conflicts with project registration.');
  }
  if (
    registry.bindings.some(
      (binding) =>
        binding.projectId !== projectId && binding.sourceRoot === sourceIdentity.root,
    )
  ) {
    return conflict('sourceRoot binding field is already assigned to another project.');
  }

  const proposed = Object.freeze({
    projectId,
    sourceRepositoryDigest,
    sourceRoot: sourceIdentity.root,
  });
  return Object.freeze({
    checkout: new SourceCheckoutHandle(projectId, sourceRepositoryDigest, sourceIdentity.root),
    currentBindingDigest: existing === undefined ? null : bindingDigestFor(existing),
    proposedBindingDigest: bindingDigestFor(proposed),
    projectId,
    sourceRepositoryDigest,
  });
}

export async function resolveLocalProjectBinding(
  hubRoot: string,
  projectIdInput: string,
  expectedSourceRepository?: string,
): Promise<ResolvedLocalProjectBinding> {
  const root = await resolveHubRoot(hubRoot);
  const projectId = validateLocalProjectId(projectIdInput);
  const registry = await readLocalProjectRegistry(root, { allowMissing: true });
  const binding = registry.bindings.find((candidate) => candidate.projectId === projectId);
  if (binding === undefined) {
    throw new KnowledgeError('SOURCE_BINDING_REQUIRED', 'Local source binding is required.', {
      recoveryCommand: ['project', 'bind'],
    });
  }
  if (
    expectedSourceRepository !== undefined &&
    sourceRepositoryDigestFor(expectedSourceRepository) !== binding.sourceRepositoryDigest
  ) {
    return invalid('sourceRepository binding field does not match portable project identity.');
  }
  const sourceIdentity = await validateSourceRoot(root, binding.sourceRoot);
  const checkout = new SourceCheckoutHandle(
    projectId,
    binding.sourceRepositoryDigest,
    sourceIdentity.root,
  );
  return Object.freeze({
    bindingDigest: bindingDigestFor(binding),
    checkout,
    projectId,
    sourceRepositoryDigest: binding.sourceRepositoryDigest,
  });
}
