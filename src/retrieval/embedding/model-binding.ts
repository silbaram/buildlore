import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';

import {
  serializeCanonicalJson,
  syncDirectory,
  writeJsonAtomic,
  type AtomicWriteHooks,
} from '../../knowledge/atomic-file.js';
import { isNodeError } from '../../knowledge/errors.js';
import { resolveGitCommonDirectory } from '../../knowledge/git.js';
import { decodeUtf8Strict, parseJsonStrict } from '../../knowledge/strict-json.js';
import {
  MULTILINGUAL_E5_SMALL_PROFILE_ID,
  createEmbeddingIdentityV2,
  localEmbeddingProfile,
  parseEmbeddingIdentityV2,
  type LocalEmbeddingArtifactProfileV1,
  type LocalEmbeddingProfileV1,
} from './profile.js';
import {
  LOCAL_MODEL_BINDING_SCHEMA_VERSION,
  LocalEmbeddingError,
  type EmbeddingArtifactIdentityV2,
  type EmbeddingIdentityV2,
  type LocalModelBindingRegistryV1,
  type LocalModelBindingV1,
  type LocalModelBindingViewV1,
} from './types.js';

const REGISTRY_SCHEMA_VERSION = 'buildlore.local-model-bindings.v1' as const;
const STATE_DIRECTORY = '.buildlore';
const MODELS_DIRECTORY = 'models';
const REGISTRY_FILENAME = 'model-bindings.json';
const LOCK_FILENAME = 'model-bindings.json.lock';
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_EXCLUDE_BYTES = 256 * 1024;
const EXCLUDE_RULES = Object.freeze([
  '/.buildlore/models/',
  '/.buildlore/model-bindings.json',
  '/.buildlore/model-bindings.json.lock',
  '/.buildlore/.model-bindings.json.*.tmp',
]);
const SAFE_PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface LocalModelBindingHooks extends AtomicWriteHooks {
  readonly afterLockOpen?: () => Promise<void> | void;
}

/** @internal Source-only deterministic seam; intentionally absent from the package export map. */
export interface LocalModelBindingTestHooks extends LocalModelBindingHooks {
  readonly verifyArtifacts?: (
    directory: string,
    profile: LocalEmbeddingProfileV1,
  ) => Promise<EmbeddingIdentityV2>;
}

export interface BindLocalModelInputV1 {
  readonly directory?: string;
  readonly profileId: string;
}

export interface BindLocalModelResultV1 {
  readonly outcome: 'created' | 'replaced' | 'unchanged';
  readonly profileId: string;
  readonly state: 'ready' | 'unavailable';
}

export interface LocalModelBindingPort {
  bind(input: BindLocalModelInputV1): Promise<BindLocalModelResultV1>;
  inspect(profileId: string): Promise<LocalModelBindingViewV1>;
  verify(profileId: string): Promise<LocalModelBindingViewV1>;
}

interface LocalModelDirectoryLease {
  readonly directory: string;
  readonly verifyCurrent: () => Promise<EmbeddingIdentityV2>;
}

const MODEL_DIRECTORY_LEASES = new WeakMap<LocalModelDirectoryHandle, LocalModelDirectoryLease>();

export class LocalModelDirectoryHandle {
  readonly identity: EmbeddingIdentityV2;
  readonly profileId: string;

  /** @internal Construct through resolveVerifiedLocalModelBinding in production. */
  constructor(
    profileId: string,
    directory: string,
    identity: EmbeddingIdentityV2,
    verifyCurrent: () => Promise<EmbeddingIdentityV2> = () => Promise.resolve(identity),
  ) {
    this.profileId = profileId;
    this.identity = identity;
    MODEL_DIRECTORY_LEASES.set(this, Object.freeze({ directory, verifyCurrent }));
    Object.freeze(this);
  }

  toJSON(): Readonly<{ readonly identity: EmbeddingIdentityV2; readonly profileId: string }> {
    return Object.freeze({ identity: this.identity, profileId: this.profileId });
  }
}

/** @internal Executes path-only runtimes inside a fail-closed before/after artifact lease. */
export async function withVerifiedLocalModelDirectory<T>(
  handle: LocalModelDirectoryHandle,
  action: (directory: string) => Promise<T>,
): Promise<T> {
  const lease = MODEL_DIRECTORY_LEASES.get(handle);
  if (lease === undefined) incompatible('binding-stale');
  const before = await lease.verifyCurrent();
  if (before.identityDigest !== handle.identity.identityDigest) incompatible('binding-stale');
  const result = await action(lease.directory);
  const after = await lease.verifyCurrent();
  if (after.identityDigest !== handle.identity.identityDigest) incompatible('binding-stale');
  return result;
}

function configInvalid(): never {
  throw new LocalEmbeddingError('LOCAL_EMBEDDING_CONFIG_INVALID');
}

function unavailable(reasonCode: ConstructorParameters<typeof LocalEmbeddingError>[1]): never {
  throw new LocalEmbeddingError('LOCAL_EMBEDDING_UNAVAILABLE', reasonCode);
}

function incompatible(reasonCode: ConstructorParameters<typeof LocalEmbeddingError>[1]): never {
  throw new LocalEmbeddingError('LOCAL_EMBEDDING_INCOMPATIBLE', reasonCode);
}

function writeFailed(): never {
  throw new LocalEmbeddingError('LOCAL_EMBEDDING_WRITE_FAILED');
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) =>
    key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnerOnlyPermissions(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

function profile(profileId: string): LocalEmbeddingProfileV1 {
  if (!SAFE_PROFILE_ID.test(profileId) || profileId.length > 64) configInvalid();
  const selected = localEmbeddingProfile(profileId);
  if (selected === null) configInvalid();
  return selected;
}

async function canonicalHubRoot(hubRoot: string): Promise<string> {
  if (!isAbsolute(hubRoot) || normalize(hubRoot) !== hubRoot) configInvalid();
  try {
    const [status, canonical] = await Promise.all([lstat(hubRoot), realpath(hubRoot)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== hubRoot) configInvalid();
    return canonical;
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    return configInvalid();
  }
}

async function prepareStateDirectory(hubRoot: string): Promise<string> {
  const directory = join(hubRoot, STATE_DIRECTORY);
  try {
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(hubRoot);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') writeFailed();
  }
  try {
    let status = await lstat(directory);
    const canonical = await realpath(directory);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== directory) writeFailed();
    if (process.platform !== 'win32') {
      await chmod(directory, 0o700);
      status = await lstat(directory);
      if (!hasOwnerOnlyPermissions(status.mode)) writeFailed();
    }
    return directory;
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    return writeFailed();
  }
}

async function prepareModelsDirectory(hubRoot: string): Promise<string> {
  const stateDirectory = await prepareStateDirectory(hubRoot);
  const modelsDirectory = join(stateDirectory, MODELS_DIRECTORY);
  try {
    await mkdir(modelsDirectory, { mode: 0o700 });
    await syncDirectory(stateDirectory);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') writeFailed();
  }
  try {
    let status = await lstat(modelsDirectory);
    const canonical = await realpath(modelsDirectory);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== modelsDirectory) {
      writeFailed();
    }
    if (process.platform !== 'win32') {
      await chmod(modelsDirectory, 0o700);
      status = await lstat(modelsDirectory);
      if (!hasOwnerOnlyPermissions(status.mode)) writeFailed();
    }
    return modelsDirectory;
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    return writeFailed();
  }
}

export async function ensureLocalModelsIgnored(hubRoot: string): Promise<void> {
  const root = await canonicalHubRoot(hubRoot);
  const commonGitDirectory = await resolveGitCommonDirectory(root).catch(() => writeFailed());
  const infoDirectory = join(commonGitDirectory, 'info');
  try {
    const [status, canonical] = await Promise.all([lstat(infoDirectory), realpath(infoDirectory)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== infoDirectory) {
      writeFailed();
    }
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    writeFailed();
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
    if (!before.isFile() || before.size > MAX_EXCLUDE_BYTES) writeFailed();
    const bytes = await handle.readFile();
    const lines = new Set(bytes.toString('utf8').split(/\r?\n/u));
    const missing = EXCLUDE_RULES.filter((rule) => !lines.has(rule));
    if (missing.length === 0) return;
    const addition = Buffer.from(
      `${bytes.byteLength > 0 && bytes.at(-1) !== 0x0a ? '\n' : ''}${missing.join('\n')}\n`,
      'utf8',
    );
    if (bytes.byteLength + addition.byteLength > MAX_EXCLUDE_BYTES) writeFailed();
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino ||
        current.size !== before.size) writeFailed();
    const written = await handle.write(addition, 0, addition.byteLength, null);
    if (written.bytesWritten !== addition.byteLength) writeFailed();
    await handle.sync();
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    writeFailed();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await syncDirectory(infoDirectory);
}

function parseBinding(value: unknown): LocalModelBindingV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'directory', 'profileId', 'schemaVersion', 'verifiedIdentity',
  ]) || value.schemaVersion !== LOCAL_MODEL_BINDING_SCHEMA_VERSION ||
      typeof value.profileId !== 'string' || localEmbeddingProfile(value.profileId) === null ||
      typeof value.directory !== 'string' || !isAbsolute(value.directory) ||
      normalize(value.directory) !== value.directory) configInvalid();
  const identity = value.verifiedIdentity === null
    ? null
    : parseEmbeddingIdentityV2(value.verifiedIdentity);
  if (value.verifiedIdentity !== null && identity === null) configInvalid();
  return Object.freeze({
    directory: value.directory,
    profileId: value.profileId,
    schemaVersion: LOCAL_MODEL_BINDING_SCHEMA_VERSION,
    verifiedIdentity: identity,
  });
}

function emptyRegistry(): LocalModelBindingRegistryV1 {
  return Object.freeze({ bindings: Object.freeze([]), schemaVersion: REGISTRY_SCHEMA_VERSION });
}

function parseRegistry(value: unknown): LocalModelBindingRegistryV1 {
  if (!isRecord(value) || !exactKeys(value, ['bindings', 'schemaVersion']) ||
      value.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(value.bindings)) {
    configInvalid();
  }
  const bindings = value.bindings.map(parseBinding).sort((left, right) =>
    left.profileId < right.profileId ? -1 : left.profileId > right.profileId ? 1 : 0);
  if (bindings.length > 64 || new Set(bindings.map((binding) => binding.profileId)).size !==
      bindings.length) configInvalid();
  return Object.freeze({ bindings: Object.freeze(bindings), schemaVersion: REGISTRY_SCHEMA_VERSION });
}

async function readRegistry(hubRoot: string, allowMissing: boolean):
Promise<LocalModelBindingRegistryV1> {
  const path = join(hubRoot, STATE_DIRECTORY, REGISTRY_FILENAME);
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(path);
  } catch (error) {
    if (allowMissing && isNodeError(error) && error.code === 'ENOENT') return emptyRegistry();
    return unavailable('binding-missing');
  }
  if (!status.isFile() || status.isSymbolicLink() || !hasOwnerOnlyPermissions(status.mode) ||
      status.size > MAX_REGISTRY_BYTES) configInvalid();
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== status.dev || current.ino !== status.ino ||
        current.size !== status.size || !hasOwnerOnlyPermissions(current.mode)) configInvalid();
    const raw = decodeUtf8Strict(await handle.readFile());
    const registry = parseRegistry(parseJsonStrict(raw));
    if (raw !== serializeCanonicalJson(registry)) configInvalid();
    return registry;
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    return configInvalid();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeRegistry(
  hubRoot: string,
  registry: LocalModelBindingRegistryV1,
  hooks: LocalModelBindingHooks,
): Promise<void> {
  const stateDirectory = await prepareStateDirectory(hubRoot);
  const canonical = parseRegistry(registry);
  if (Buffer.byteLength(serializeCanonicalJson(canonical), 'utf8') > MAX_REGISTRY_BYTES) {
    configInvalid();
  }
  try {
    await writeJsonAtomic(join(stateDirectory, REGISTRY_FILENAME), canonical, {
      ...hooks,
      confinementRoot: stateDirectory,
    });
  } catch {
    writeFailed();
  }
}

async function withRegistryLock<T>(
  hubRoot: string,
  action: () => Promise<T>,
  hooks: LocalModelBindingHooks,
): Promise<T> {
  const stateDirectory = await prepareStateDirectory(hubRoot);
  const lockPath = join(stateDirectory, LOCK_FILENAME);
  let handle;
  let opened = false;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    opened = true;
    await hooks.afterLockOpen?.();
    await handle.writeFile('buildlore local model binding mutation\n', 'utf8');
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (opened) await unlink(lockPath).catch(() => undefined);
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new LocalEmbeddingError('LOCAL_EMBEDDING_BUSY');
    }
    writeFailed();
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
  if (cleanupFailed) writeFailed();
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function canonicalModelDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory) || normalize(directory) !== directory) configInvalid();
  try {
    const [status, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
    if (!status.isDirectory() || status.isSymbolicLink() || canonical !== directory) {
      unavailable('model-directory-unavailable');
    }
    return canonical;
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    return unavailable('model-directory-unavailable');
  }
}

async function inspectArtifact(
  directory: string,
  artifact: LocalEmbeddingArtifactProfileV1,
): Promise<EmbeddingArtifactIdentityV2> {
  const path = join(directory, ...artifact.basename.split('/'));
  if (!isContained(directory, path)) incompatible('artifact-config-incompatible');
  let expected: Awaited<ReturnType<typeof lstat>>;
  try {
    expected = await lstat(path);
  } catch {
    return unavailable('artifact-missing');
  }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size < 1 ||
      expected.size > artifact.maximumBytes) incompatible('artifact-config-incompatible');
  let handle;
  try {
    const canonical = await realpath(path);
    if (canonical !== path || !isContained(directory, canonical)) {
      incompatible('artifact-config-incompatible');
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
        actual.size !== expected.size) incompatible('artifact-config-incompatible');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < actual.size) {
      const length = Math.min(buffer.byteLength, actual.size - position);
      const read = await handle.read(buffer, 0, length, position);
      if (read.bytesRead !== length) incompatible('artifact-config-incompatible');
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !==
        actual.ctimeMs) incompatible('artifact-config-incompatible');
    const sha256 = `sha256:${hash.digest('hex')}` as const;
    if (artifact.requiredSha256 !== null && sha256 !== artifact.requiredSha256) {
      incompatible('artifact-checksum-mismatch');
    }
    return Object.freeze({
      basename: artifact.basename,
      bytes: actual.size,
      role: artifact.role,
      sha256,
    });
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    return incompatible('artifact-config-incompatible');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedJsonArtifact(
  directory: string,
  basename: string,
  maximumBytes: number,
  expectedSha256: EmbeddingArtifactIdentityV2['sha256'],
): Promise<Readonly<Record<string, unknown>>> {
  const path = join(directory, ...basename.split('/'));
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = await handle.stat();
    if (!status.isFile() || status.size < 1 || status.size > maximumBytes ||
        await realpath(path) !== path) incompatible('artifact-config-incompatible');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (
      after.dev !== status.dev || after.ino !== status.ino || after.size !== status.size ||
      after.mtimeMs !== status.mtimeMs || after.ctimeMs !== status.ctimeMs ||
      sha256 !== expectedSha256
    ) incompatible('artifact-config-incompatible');
    const parsed = parseJsonStrict(decodeUtf8Strict(bytes));
    if (!isRecord(parsed)) incompatible('artifact-config-incompatible');
    return parsed;
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    return incompatible('artifact-config-incompatible');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function verifyAuxiliaryArtifactContracts(
  config: Readonly<Record<string, unknown>>,
  tokenizer: Readonly<Record<string, unknown>>,
): void {
  if (config.model_type !== 'bert' || config.hidden_size !== 384 ||
      config.max_position_embeddings !== 512 ||
      config.tokenizer_class !== 'XLMRobertaTokenizer' ||
      tokenizer.model_max_length !== 512 ||
      tokenizer.tokenizer_class !== 'XLMRobertaTokenizer') {
    incompatible('artifact-config-incompatible');
  }
}

/** @internal Source-only regression seam for the pinned model's auxiliary contracts. */
export function verifyAuxiliaryArtifactContractsForTest(
  config: unknown,
  tokenizer: unknown,
): void {
  if (!isRecord(config) || !isRecord(tokenizer)) {
    incompatible('artifact-config-incompatible');
  }
  verifyAuxiliaryArtifactContracts(config, tokenizer);
}

async function verifyDirectoryArtifacts(
  directory: string,
  selectedProfile: LocalEmbeddingProfileV1,
): Promise<EmbeddingIdentityV2> {
  const artifacts: EmbeddingArtifactIdentityV2[] = [];
  for (const artifact of selectedProfile.artifacts) {
    artifacts.push(await inspectArtifact(directory, artifact));
  }
  const configIdentity = artifacts.find((artifact) => artifact.basename === 'config.json');
  const tokenizerIdentity = artifacts.find((artifact) =>
    artifact.basename === 'tokenizer_config.json');
  if (configIdentity === undefined || tokenizerIdentity === undefined) {
    incompatible('artifact-config-incompatible');
  }
  const config = await readBoundedJsonArtifact(
    directory,
    'config.json',
    1024 * 1024,
    configIdentity.sha256,
  );
  const tokenizer = await readBoundedJsonArtifact(
    directory,
    'tokenizer_config.json',
    1024 * 1024,
    tokenizerIdentity.sha256,
  );
  verifyAuxiliaryArtifactContracts(config, tokenizer);
  return createEmbeddingIdentityV2(selectedProfile, artifacts);
}

function view(
  profileId: string,
  state: LocalModelBindingViewV1['state'],
  identity: EmbeddingIdentityV2 | null,
  reasonCode: LocalModelBindingViewV1['reasonCode'],
): LocalModelBindingViewV1 {
  const recoveryAction = reasonCode === null
    ? null
    : reasonCode === 'binding-missing' || reasonCode === 'model-directory-unavailable'
      ? Object.freeze(['model', 'bind', '--profile', profileId] as const)
      : Object.freeze(['model', 'verify', '--profile', profileId] as const);
  return Object.freeze({ activeIdentity: identity, profileId, reasonCode, recoveryAction, state });
}

export async function bindLocalModel(
  hubRoot: string,
  input: BindLocalModelInputV1,
  hooks: LocalModelBindingHooks = {},
): Promise<BindLocalModelResultV1> {
  const root = await canonicalHubRoot(hubRoot);
  const selectedProfile = profile(input.profileId);
  await ensureLocalModelsIgnored(root);
  const modelsDirectory = await prepareModelsDirectory(root);
  const requested = input.directory === undefined
    ? join(modelsDirectory, selectedProfile.profileId)
    : resolve(root, input.directory);
  const directory = await canonicalModelDirectory(requested);
  return withRegistryLock(root, async () => {
    const registry = await readRegistry(root, true);
    const previous = registry.bindings.find((binding) =>
      binding.profileId === selectedProfile.profileId);
    const outcome = previous === undefined
      ? 'created' as const
      : previous.directory === directory
        ? 'unchanged' as const
        : 'replaced' as const;
    if (outcome !== 'unchanged') {
      const bindings = registry.bindings.filter((binding) =>
        binding.profileId !== selectedProfile.profileId);
      bindings.push(Object.freeze({
        directory,
        profileId: selectedProfile.profileId,
        schemaVersion: LOCAL_MODEL_BINDING_SCHEMA_VERSION,
        verifiedIdentity: null,
      }));
      await writeRegistry(root, {
        bindings,
        schemaVersion: REGISTRY_SCHEMA_VERSION,
      }, hooks);
    }
    const state = outcome === 'unchanged' && previous?.verifiedIdentity !== null
      ? 'ready' as const
      : 'unavailable' as const;
    return Object.freeze({ outcome, profileId: selectedProfile.profileId, state });
  }, hooks);
}

export async function inspectLocalModelBinding(
  hubRoot: string,
  profileId: string,
): Promise<LocalModelBindingViewV1> {
  const root = await canonicalHubRoot(hubRoot);
  profile(profileId);
  const registry = await readRegistry(root, true);
  const binding = registry.bindings.find((item) => item.profileId === profileId);
  if (binding === undefined) return view(profileId, 'none', null, 'binding-missing');
  try {
    await canonicalModelDirectory(binding.directory);
  } catch (error) {
    if (error instanceof LocalEmbeddingError &&
        error.reasonCode === 'model-directory-unavailable') {
      return view(profileId, 'unavailable', null, 'model-directory-unavailable');
    }
    throw error;
  }
  if (binding.verifiedIdentity === null) {
    return view(profileId, 'unavailable', null, 'binding-stale');
  }
  return view(profileId, 'ready', binding.verifiedIdentity, null);
}

export async function verifyLocalModelBinding(
  hubRoot: string,
  profileId: string,
  hooks: LocalModelBindingHooks = {},
): Promise<LocalModelBindingViewV1> {
  return verifyLocalModelBindingInternal(hubRoot, profileId, hooks);
}

/** @internal Source-only deterministic seam; intentionally absent from the package export map. */
export async function verifyLocalModelBindingForTest(
  hubRoot: string,
  profileId: string,
  hooks: LocalModelBindingTestHooks,
): Promise<LocalModelBindingViewV1> {
  return verifyLocalModelBindingInternal(hubRoot, profileId, hooks);
}

async function verifyLocalModelBindingInternal(
  hubRoot: string,
  profileId: string,
  hooks: LocalModelBindingTestHooks,
): Promise<LocalModelBindingViewV1> {
  const root = await canonicalHubRoot(hubRoot);
  const selectedProfile = profile(profileId);
  return withRegistryLock(root, async () => {
    const registry = await readRegistry(root, false);
    const binding = registry.bindings.find((item) => item.profileId === profileId);
    if (binding === undefined) unavailable('binding-missing');
    const directory = await canonicalModelDirectory(binding.directory);
    const identity = hooks.verifyArtifacts === undefined
      ? await verifyDirectoryArtifacts(directory, selectedProfile)
      : await hooks.verifyArtifacts(directory, selectedProfile);
    const bindings = registry.bindings.filter((item) => item.profileId !== profileId);
    bindings.push(Object.freeze({ ...binding, verifiedIdentity: identity }));
    await writeRegistry(root, { bindings, schemaVersion: REGISTRY_SCHEMA_VERSION }, hooks);
    return view(profileId, 'ready', identity, null);
  }, hooks);
}

export async function resolveVerifiedLocalModelBinding(
  hubRoot: string,
  profileId: string = MULTILINGUAL_E5_SMALL_PROFILE_ID,
): Promise<LocalModelDirectoryHandle> {
  const root = await canonicalHubRoot(hubRoot);
  const registry = await readRegistry(root, false);
  const binding = registry.bindings.find((item) => item.profileId === profileId);
  if (binding === undefined) unavailable('binding-missing');
  if (binding.verifiedIdentity === null) unavailable('binding-stale');
  const directory = await canonicalModelDirectory(binding.directory);
  const currentIdentity = await verifyDirectoryArtifacts(directory, profile(profileId));
  if (currentIdentity.identityDigest !== binding.verifiedIdentity.identityDigest) {
    incompatible('binding-stale');
  }
  return new LocalModelDirectoryHandle(
    profileId,
    directory,
    currentIdentity,
    () => verifyDirectoryArtifacts(directory, profile(profileId)),
  );
}

export function createLocalModelBindingService(hubRoot: string): LocalModelBindingPort {
  return Object.freeze({
    bind(input: BindLocalModelInputV1): Promise<BindLocalModelResultV1> {
      return bindLocalModel(hubRoot, input);
    },
    inspect(profileId: string): Promise<LocalModelBindingViewV1> {
      return inspectLocalModelBinding(hubRoot, profileId);
    },
    verify(profileId: string): Promise<LocalModelBindingViewV1> {
      return verifyLocalModelBinding(hubRoot, profileId);
    },
  });
}
