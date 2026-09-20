import { inspectKnowledgeWorkspace } from '../knowledge/knowledge-workspace.js';
import { sameRepository, containsPath } from '../knowledge/repository-paths.js';
import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { containsCredentialMaterial } from '../sanitizer/service.js';
import { initializeModeAWorkspace } from '../knowledge/initialization.js';
import { showProject } from '../knowledge/workspace.js';
import { isNodeError } from '../knowledge/errors.js';
import { parseAnySourceCollectionManifest } from '../projector/source-manifest.js';
import { configDirectory, ensureDirectory, readConfig, replaceConfig, safeDirectory, withRegistryLock } from './io.js';
import { gitRead, sourceIdentity, worktreeRoot } from './git-read.js';
import { ConnectionError, emptyRegistry, fail, hash, locator, parseConnection, parseRegistry, projectId,
  absolute, record, valueDigest, type Digest, type HubBinding, type ReadBinding, type ReadRegistry, type SharedConnection } from './contracts.js';

function identityDigest(value: unknown): Digest {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, ordered(x)])) : v;
  return valueDigest(ordered(value));
}

const MAX_REGISTRY = 1024 * 1024;
const MAX_CONNECTION = 16 * 1024;
const sharedPath = (root: string): string => join(root, '.buildlore', 'connection.json');
export interface ConnectionOptions { readonly configDir?: string }
export interface ConnectionHooks { readonly afterSharedWrite?: () => Promise<void> }
export interface HubInspection {
  readonly hub: HubBinding;
  readonly knowledgeRevision: string;
  readonly pin: 'matched' | 'mismatched' | 'conflicted' | 'not_applicable';
  readonly dirty: 'clean' | 'dirty' | 'unknown';
}
// Only this module can issue capabilities. Neither paths nor mutable registry data serialize.
const capabilities = new WeakMap<ConnectionContext, { root: string; binding: ReadBinding; inspection: HubInspection; config: string }>();
export class ConnectionContext {
  private constructor(readonly projectId: string, readonly knowledgeRepositoryDigest: Digest, readonly connectionDigest: Digest) { Object.freeze(this); }
  static issue(token: symbol, project: string, knowledge: Digest, connection: Digest): ConnectionContext {
    if (token !== issueToken) fail();
    return new ConnectionContext(project, knowledge, connection);
  }
}
const issueToken = Symbol('validated-connection');
const connectionOutcomes = new WeakMap<ConnectionContext, 'created' | 'unchanged'>();
export function connectionOutcome(context: ConnectionContext): 'created' | 'unchanged' { return connectionOutcomes.get(context) ?? fail(); }
export function connectionPaths(context: ConnectionContext): Readonly<{ hubRoot: string; knowledgeRoot: string; sourceRoot: string; knowledgeRevision: string; pin: HubInspection['pin']; dirty: HubInspection['dirty'] }> {
  const c = capabilities.get(context) ?? fail();
  return { hubRoot: c.inspection.hub.hubRoot, knowledgeRoot: bindingKnowledgeRoot(c.inspection.hub), sourceRoot: c.root,
    knowledgeRevision: c.inspection.knowledgeRevision, pin: c.inspection.pin, dirty: c.inspection.dirty };
}
function bindingKnowledgeRoot(hub: HubBinding): string {
  return hub.mode === 'knowledge' ? hub.hubRoot : join(hub.hubRoot, 'knowledge');
}
async function inspectBinding(path: string, expected?: HubBinding, selectedProject?: string, direct = expected?.mode === 'knowledge'): Promise<HubInspection> {
  if (!direct) return inspectHub(path, expected, selectedProject);
  const root = resolve(path);
  const marker = await inspectKnowledgeWorkspace(root);
  const hub: HubBinding = { mode: 'knowledge', hubRoot: root, knowledgeRepository: marker.knowledgeRepository,
    knowledgeRepositoryDigest: hash(marker.knowledgeRepository) };
  if (expected && identityDigest(expected) !== identityDigest(hub)) fail('KNOWLEDGE_IDENTITY_MISMATCH');
  const revision = (await gitRead(root, ['rev-parse', '--verify', 'HEAD^{commit}']))?.trim();
  if (!revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)) fail('KNOWLEDGE_INVALID');
  const status = await gitRead(root, ['status', '--porcelain=v1', '--untracked-files=normal',
    ...(selectedProject === undefined ? [] : ['--', `projects/${projectId(selectedProject)}`])]);
  return { hub, knowledgeRevision: revision, pin: 'not_applicable', dirty: status?.trim() ? 'dirty' : 'clean' };
}
async function registry(config: string): Promise<{ data: ReadRegistry; digest: Digest | null }> {
  const f = await readConfig(join(config, 'connections.json'), MAX_REGISTRY);
  return { data: f ? parseRegistry(f.value) : emptyRegistry(), digest: f?.digest ?? null };
}
export async function inspectHub(path: string, expected?: HubBinding, selectedProject?: string, metadataOnly = false): Promise<HubInspection> {
  let root: string;
  try {
    root = await realpath(path);
    await safeDirectory(path);
    if (await worktreeRoot(root) !== root) fail('HUB_UNAVAILABLE');
    const gm = join(root, '.gitmodules'), before = await lstat(gm);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 256 * 1024) fail('KNOWLEDGE_IDENTITY_MISMATCH');
    const get = async (key: string): Promise<string> => (await gitRead(root, ['config', '--file', '.gitmodules', '--get', key]))?.trimEnd() ?? fail();
    if (await get('submodule.knowledge.path') !== 'knowledge') fail('KNOWLEDGE_IDENTITY_MISMATCH');
    const repository = locator(await get('submodule.knowledge.url'));
    const after = await lstat(gm);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) fail('CONNECTION_CONFLICT');
    const hub: HubBinding = { hubRoot: root, knowledgeRepository: repository, knowledgeRepositoryDigest: hash(repository) };
    if (expected && (expected.hubRoot !== root || expected.knowledgeRepository !== repository || expected.knowledgeRepositoryDigest !== hash(repository))) fail('KNOWLEDGE_IDENTITY_MISMATCH');
    const knowledge = join(root, 'knowledge');
    const initialized = await lstat(join(knowledge, '.git')).catch(() => null);
    if (!initialized) fail('KNOWLEDGE_UNINITIALIZED');
    if (initialized.isSymbolicLink()) fail('READ_BOUNDARY_VIOLATION');
    await safeDirectory(knowledge);
    if (await worktreeRoot(knowledge) !== knowledge) fail('KNOWLEDGE_IDENTITY_MISMATCH');
    const origin = (await gitRead(knowledge, ['config', '--local', '--get', 'remote.origin.url'], true))?.trimEnd();
    if (!origin || !await sameRepository(repository, root, origin, knowledge)) fail('KNOWLEDGE_IDENTITY_MISMATCH');
    const revision = (await gitRead(knowledge, ['rev-parse', '--verify', 'HEAD^{commit}']))?.trim();
    if (!revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)) fail('KNOWLEDGE_INVALID');
    const index = await gitRead(root, ['ls-files', '--stage', '--', 'knowledge']);
    const lines = (index ?? '').trim().split('\n');
    const entry = /^160000 ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\tknowledge$/u.exec(lines[0] ?? '');
    const pin = lines.length !== 1 || entry?.[2] !== '0' ? 'conflicted' : entry[1] === revision ? 'matched' : 'mismatched';
    const dirty = metadataOnly ? null : await gitRead(knowledge, ['status', '--porcelain=v1', '--untracked-files=normal',
      ...(selectedProject === undefined ? [] : ['--', `projects/${projectId(selectedProject)}`])]);
    return { hub, knowledgeRevision: revision, pin, dirty: metadataOnly ? 'unknown' : dirty?.trim() ? 'dirty' : 'clean' };
  } catch (e) {
    if (e instanceof ConnectionError) throw e;
    return fail('HUB_UNAVAILABLE');
  }
}
async function validateSource(root: string, hub: HubBinding, id: string, declared?: string): Promise<string> {
  const project = await showProject(bindingKnowledgeRoot(hub), id).catch(() => fail('PROJECT_MISMATCH'));
  const repository = locator(project.entry.sourceRepository);
  const f = await readConfig(join(root, '.buildlore', 'sources.json'), 64 * 1024);
  if (f) {
    const manifest = parseAnySourceCollectionManifest(f.value);
    if (manifest.projectId !== id || manifest.sourceRepository !== repository) fail('SOURCE_IDENTITY_MISMATCH');
  }
  const origin = (await gitRead(root, ['config', '--local', '--get', 'remote.origin.url'], true))?.trimEnd();
  if (origin) {
    if (!await sameRepository(repository, hub.hubRoot, origin, root)) fail('SOURCE_IDENTITY_MISMATCH');
  } else if (declared !== repository) fail('SOURCE_IDENTITY_MISMATCH');
  if (declared !== undefined && locator(declared) !== repository) fail('SOURCE_IDENTITY_MISMATCH');
  return repository;
}
export async function resolveConnection(cwd: string, options: ConnectionOptions = {}): Promise<ConnectionContext | null> {
  const root = await worktreeRoot(cwd);
  const config = absolute(options.configDir ?? configDirectory());
  const r = await registry(config);
  const binding = r.data.bindings.find(b => b.sourceRoot === root);
  const f = await readConfig(sharedPath(root), MAX_CONNECTION);
  if (!f && !binding) return null;
  if (!f || !binding) fail('CONNECTION_INCOMPLETE');
  const shared = parseConnection(f.value);
  if (f.digest !== binding.connectionDigest || shared.projectId !== binding.projectId || shared.knowledgeRepositoryDigest !== binding.knowledgeRepositoryDigest) fail('CONNECTION_CONFLICT');
  const hub = r.data.hubs.find(h => h.knowledgeRepositoryDigest === binding.knowledgeRepositoryDigest) ?? fail('CONNECTION_INCOMPLETE');
  if (shared.mode !== hub.mode) fail('KNOWLEDGE_IDENTITY_MISMATCH');
  const inspection = await inspectBinding(hub.hubRoot, hub, binding.projectId);
  const project = await showProject(bindingKnowledgeRoot(hub), binding.projectId).catch(() => fail('PROJECT_MISMATCH'));
  const repository = await validateSource(root, hub, binding.projectId, project.entry.sourceRepository);
  if (hash(repository) !== binding.sourceRepositoryDigest || identityDigest(await sourceIdentity(root)) !== identityDigest(binding.sourceIdentity)) fail('SOURCE_IDENTITY_MISMATCH');
  const context = ConnectionContext.issue(issueToken, shared.projectId, shared.knowledgeRepositoryDigest, f.digest);
  capabilities.set(context, { root, binding, inspection, config });
  return context;
}
export async function assertConnectionCurrent(context: ConnectionContext): Promise<ConnectionContext> {
  const c = capabilities.get(context) ?? fail();
  const current = await resolveConnection(c.root, { configDir: c.config });
  if (!current || current.projectId !== context.projectId || current.connectionDigest !== context.connectionDigest ||
      current.knowledgeRepositoryDigest !== context.knowledgeRepositoryDigest) fail('CONNECTION_CONFLICT');
  const refreshed = capabilities.get(current) ?? fail();
  if (identityDigest(refreshed.binding) !== identityDigest(c.binding) ||
      identityDigest(refreshed.inspection.hub) !== identityDigest(c.inspection.hub)) fail('CONNECTION_CONFLICT');
  return current;
}
async function saveRegistry(config: string, data: ReadRegistry, expected: Digest | null, validate?: () => Promise<void>): Promise<void> {
  const normalized = parseRegistry({ ...data, schemaVersion: data.schemaVersion === 'buildlore.read-connections.v2' || data.hubs.some(h => h.mode === 'knowledge') ? 'buildlore.read-connections.v2' : 'buildlore.read-connections.v1', hubs: [...data.hubs].sort((a, b) => a.knowledgeRepositoryDigest.localeCompare(b.knowledgeRepositoryDigest)),
    bindings: [...data.bindings].sort((a, b) => a.sourceRoot.localeCompare(b.sourceRoot)) });
  await replaceConfig(join(config, 'connections.json'), normalized, expected, MAX_REGISTRY, validate);
}

export interface HubRelocationInput {
  readonly from: string;
  readonly to: string;
  readonly knowledgeRepository: string;
  readonly apply?: boolean;
  readonly expectedPlan?: Digest;
}
export interface HubRelocationPlan {
  readonly schemaVersion: 'buildlore.hub-relocation-plan.v1';
  readonly knowledgeRepositoryDigest: Digest;
  readonly affectedBindings: number;
  readonly changed: boolean;
  readonly applied: boolean;
  readonly planDigest: Digest;
}
interface RelocationHooks {
  readonly beforeReplace?: () => Promise<void>;
  readonly afterReplace?: () => Promise<void>;
}

/** Rebind a known logical repository; never move or repair Git data. */
export async function relocateHub(input: HubRelocationInput, options: ConnectionOptions = {}, hooks: RelocationHooks = {}): Promise<HubRelocationPlan> {
  const from = absolute(input.from), to = absolute(input.to);
  const repository = locator(input.knowledgeRepository), repositoryDigest = hash(repository);
  const config = absolute(options.configDir ?? configDirectory());
  if ([from, to, config].some(containsCredentialMaterial)) fail();
  if (input.apply !== undefined && typeof input.apply !== 'boolean') fail();
  if (Boolean(input.apply) !== (input.expectedPlan !== undefined) ||
      (input.expectedPlan !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(input.expectedPlan))) fail();
  const inspect = async (): Promise<{ data: ReadRegistry; digest: Digest | null; plan: HubRelocationPlan }> => {
    const r = await registry(config);
    const old = r.data.hubs.find(h => h.knowledgeRepositoryDigest === repositoryDigest);
    if (!old) fail('CONNECTION_MISSING');
    if (old.knowledgeRepository !== repository || (old.hubRoot !== from && old.hubRoot !== to)) fail('CONNECTION_CONFLICT');
    if (r.data.hubs.some(h => h.hubRoot === to && h.knowledgeRepositoryDigest !== repositoryDigest)) fail('CONNECTION_CONFLICT');
    if (r.data.bindings.some(b => containsPath(to, b.sourceRoot) || containsPath(b.sourceRoot, to))) fail('READ_BOUNDARY_VIOLATION');
    const inspected = old.mode === 'knowledge' ? await inspectBinding(to, undefined, undefined, true) : await inspectHub(to, undefined, undefined, true);
    if (inspected.hub.hubRoot !== to) fail('READ_BOUNDARY_VIOLATION');
    if (inspected.hub.knowledgeRepository !== repository) fail('KNOWLEDGE_IDENTITY_MISMATCH');
    if (inspected.pin !== 'matched' && inspected.pin !== 'not_applicable') fail('KNOWLEDGE_PIN_MISMATCH');
    const hubIdentity = await sourceIdentity(to), knowledgeIdentity = await sourceIdentity(bindingKnowledgeRoot(inspected.hub));
    const identities = await Promise.all([hubIdentity.gitCommonDir, knowledgeIdentity.gitCommonDir, join(to, old.mode === 'knowledge' ? '.buildlore/workspace.json' : '.gitmodules')].map(async path => {
      const stat = await lstat(path, { bigint: true });
      if (stat.isSymbolicLink()) fail('READ_BOUNDARY_VIOLATION');
      return { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), modified: String(stat.mtimeNs) };
    }));
    const modules = old.mode === 'knowledge' ? JSON.stringify(await inspectKnowledgeWorkspace(to)) : await gitRead(to, ['config', '--file', '.gitmodules', '--null', '--list']);
    const planDigest = valueDigest({ operation: 'relocate-hub', from, to, repository, registry: r.digest,
      hub: inspected, hubIdentity, knowledgeIdentity, identities, modulesDigest: hash(modules ?? '') });
    return { ...r, plan: { schemaVersion: 'buildlore.hub-relocation-plan.v1', knowledgeRepositoryDigest: repositoryDigest,
      affectedBindings: r.data.bindings.filter(b => b.knowledgeRepositoryDigest === repositoryDigest).length,
      changed: old.hubRoot !== to, applied: false, planDigest } };
  };
  const initial = await inspect();
  if (!input.apply) return initial.plan;
  if (initial.plan.planDigest !== input.expectedPlan) fail('CONNECTION_CONFLICT');
  if (!initial.plan.changed) return { ...initial.plan, applied: true };
  try {
    return await withRegistryLock(config, to, async () => {
      const current = await inspect();
      if (current.plan.planDigest !== input.expectedPlan) fail('CONNECTION_CONFLICT');
      await hooks.beforeReplace?.();
      await saveRegistry(config, { ...current.data, hubs: current.data.hubs.map(h => h.knowledgeRepositoryDigest === repositoryDigest ? { ...h, hubRoot: to } : h) }, current.digest, async () => {
        if ((await inspect()).plan.planDigest !== input.expectedPlan) fail('CONNECTION_CONFLICT');
      });
      await hooks.afterReplace?.();
      return { ...current.plan, applied: true };
    });
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    if (error instanceof Error && error.cause instanceof ConnectionError) throw error.cause;
    return fail('CONNECTION_WRITE_FAILED');
  }
}
export async function setupHub(path: string, repository: string, options: ConnectionOptions = {}): Promise<Readonly<{ outcome: 'created' | 'existing' | 'unchanged'; projectId: null; connectionDigest: null; readable: false }>> {
  const requested = locator(repository);
  const root = resolve(path), config = absolute(options.configDir ?? configDirectory());
  await ensureDirectory(root);
  let existing = false, unchanged = false;
  await withRegistryLock(config, root, async () => {
    const registered = (await registry(config)).data.hubs.find(h => h.knowledgeRepositoryDigest === hash(requested) || h.hubRoot === root);
    if (registered && registered.hubRoot !== root) fail('CONNECTION_CONFLICT');
    if (registered && registered.knowledgeRepository !== requested) fail('KNOWLEDGE_IDENTITY_MISMATCH');
    unchanged = registered !== undefined;
    const recoveryPath = join(config, 'setup', `${hash(root).slice(7)}.json`);
    const marker = await readConfig(recoveryPath, MAX_CONNECTION);
    if (marker) {
      const m = record(marker.value, ['schemaVersion', 'hubRoot', 'knowledgeRepository', 'device', 'inode']);
      const st = await lstat(root, { bigint: true });
      if (m.schemaVersion !== 'buildlore.setup-recovery.v1' || m.hubRoot !== root || m.knowledgeRepository !== requested ||
          m.device !== st.dev.toString() || m.inode !== st.ino.toString()) fail('CONNECTION_CONFLICT');
    }
    try { await lstat(join(root, '.gitmodules')); existing = true; }
    catch (e) { if (!isNodeError(e) || e.code !== 'ENOENT') throw e; }
    if (existing && !marker) {
      if ((await inspectHub(root)).hub.knowledgeRepository !== requested) fail('KNOWLEDGE_IDENTITY_MISMATCH');
    } else {
      if (!marker) {
        if ((await readdir(root)).length !== 0 || await gitRead(root, ['rev-parse', '--show-toplevel'], true) !== null) fail('CONNECTION_CONFLICT');
        await ensureDirectory(join(config, 'setup'));
        const st = await lstat(root, { bigint: true });
        await replaceConfig(recoveryPath, { schemaVersion: 'buildlore.setup-recovery.v1', hubRoot: root, knowledgeRepository: requested,
          device: st.dev.toString(), inode: st.ino.toString() }, null, MAX_CONNECTION);
      }
      await initializeModeAWorkspace(root, { repository: requested });
    }
    const inspection = await inspectHub(root);
    if (inspection.hub.knowledgeRepository !== requested) fail('KNOWLEDGE_IDENTITY_MISMATCH');
    const r = await registry(config);
    const old = r.data.hubs.find(h => h.knowledgeRepositoryDigest === inspection.hub.knowledgeRepositoryDigest || h.hubRoot === root);
    if (old && identityDigest(old) !== identityDigest(inspection.hub)) fail('CONNECTION_CONFLICT');
    if (!old) await saveRegistry(config, { ...r.data, hubs: [...r.data.hubs, inspection.hub] }, r.digest);
    const recovery = await readConfig(recoveryPath, MAX_CONNECTION);
    if (recovery) await unlink(recoveryPath);
  });
  return { outcome: unchanged ? 'unchanged' : existing ? 'existing' : 'created', projectId: null, connectionDigest: null, readable: false };
}
export interface ConnectionInput { readonly hub?: string; readonly workspace?: string; readonly projectId: string; readonly sourceRepository?: string }
async function prepareConnection(cwd: string, input: ConnectionInput, options: ConnectionOptions) {
  const root = await worktreeRoot(cwd), config = absolute(options.configDir ?? configDirectory());
  if ((input.hub === undefined) === (input.workspace === undefined)) fail();
  const target = input.workspace ?? input.hub ?? fail();
  const id = projectId(input.projectId), inspection = await inspectBinding(resolve(target), undefined, id, input.workspace !== undefined);
  if (containsPath(inspection.hub.hubRoot, root)) fail('READ_BOUNDARY_VIOLATION');
  const repository = await validateSource(root, inspection.hub, id, input.sourceRepository);
  const identity = await sourceIdentity(root);
  const shared: SharedConnection = { schemaVersion: input.workspace === undefined ? 'buildlore.connection.v1' : 'buildlore.connection.v2',
    ...(input.workspace === undefined ? {} : { mode: 'knowledge' as const }), knowledgeRepository: inspection.hub.knowledgeRepository,
    knowledgeRepositoryDigest: inspection.hub.knowledgeRepositoryDigest, projectId: id };
  return { root, config, id, inspection, repository, identity, shared };
}
async function inspectRegistration(p: Awaited<ReturnType<typeof prepareConnection>>) {
  const { root, config, id, inspection, repository, identity, shared } = p;
  const r = await registry(config);
  const hub = r.data.hubs.find(h => h.knowledgeRepositoryDigest === shared.knowledgeRepositoryDigest || h.hubRoot === inspection.hub.hubRoot);
  if (hub && identityDigest(hub) !== identityDigest(inspection.hub)) fail('CONNECTION_CONFLICT');
  const previous = await readConfig(sharedPath(root), MAX_CONNECTION);
  if (previous && identityDigest(parseConnection(previous.value)) !== identityDigest(shared)) fail('CONNECTION_CONFLICT');
  const connectionDigest = previous?.digest ?? valueDigest(shared);
  const binding: ReadBinding = { sourceRoot: root, sourceIdentity: identity, sourceRepositoryDigest: hash(repository), projectId: id,
    knowledgeRepositoryDigest: shared.knowledgeRepositoryDigest, connectionDigest };
  const old = r.data.bindings.find(b => b.sourceRoot === root);
  if (old && identityDigest(old) !== identityDigest(binding)) fail('CONNECTION_CONFLICT');
  return { r, hub, previous, binding, unchanged: Boolean(old && previous) };
}
/** Internal preflight metadata, not a read capability or a client apply plan. */
export interface ConnectionPreview { readonly sourceRoot: string; readonly projectId: string; readonly connectionDigest: string; readonly unchanged: boolean }
export async function previewConnection(cwd: string, input: ConnectionInput, options: ConnectionOptions = {}): Promise<ConnectionPreview> {
  const p = await prepareConnection(cwd, input, options);
  const current = await inspectRegistration(p);
  return { sourceRoot: p.root, projectId: p.id, connectionDigest: current.binding.connectionDigest, unchanged: current.unchanged };
}
export async function connectProject(cwd: string, input: ConnectionInput, options: ConnectionOptions = {}, hooks: ConnectionHooks = {}): Promise<ConnectionContext> {
  const p = await prepareConnection(cwd, input, options);
  const { root, config, inspection, shared } = p;
  let outcome: 'created' | 'unchanged' = 'created';
  await withRegistryLock(config, root, async () => {
    const { r, hub, previous, binding, unchanged } = await inspectRegistration(p);
    if (unchanged) { outcome = 'unchanged'; return; }
    await ensureDirectory(join(root, '.buildlore'));
    if (!previous) await replaceConfig(sharedPath(root), shared, null, MAX_CONNECTION);
    await hooks.afterSharedWrite?.();
    await saveRegistry(config, { ...r.data, hubs: hub ? r.data.hubs : [...r.data.hubs, inspection.hub],
      bindings: [...r.data.bindings.filter(b => b.sourceRoot !== root), binding] }, r.digest);
  });
  const context = await resolveConnection(root, { configDir: config }) ?? fail('CONNECTION_INCOMPLETE');
  connectionOutcomes.set(context, outcome);
  return context;
}
export async function disconnectProject(cwd: string, removeShared = false, options: ConnectionOptions = {}): Promise<Readonly<{ outcome: 'disconnected' | 'unchanged'; projectId: string | null; connectionDigest: Digest | null; readable: false }>> {
  const root = await worktreeRoot(cwd), config = absolute(options.configDir ?? configDirectory());
  const initial = await registry(config), binding = initial.data.bindings.find(b => b.sourceRoot === root);
  if (!binding && !removeShared) return { outcome: 'unchanged', projectId: null, connectionDigest: null, readable: false };
  return withRegistryLock(config, root, async () => {
    const r = await registry(config);
    if (r.digest !== initial.digest) fail('CONNECTION_CONFLICT');
    const f = await readConfig(sharedPath(root), MAX_CONNECTION);
    if (removeShared && f) {
      parseConnection(f.value);
      if (binding && f.digest !== binding.connectionDigest) fail('CONNECTION_CONFLICT');
      if ((await readConfig(sharedPath(root), MAX_CONNECTION))?.digest !== f.digest) fail('CONNECTION_CONFLICT');
      await unlink(sharedPath(root));
    }
    if (binding) await saveRegistry(config, { ...r.data, bindings: r.data.bindings.filter(b => b.sourceRoot !== root) }, r.digest);
    return { outcome: 'disconnected', projectId: binding?.projectId ?? null, connectionDigest: f?.digest ?? null, readable: false };
  });
}
