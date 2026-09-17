import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { parseJsonStrict, decodeUtf8Strict } from '../knowledge/strict-json.js';
import { validateProjectId, validateRepositoryLocator } from '../knowledge/validation.js';
import { containsCredentialMaterial } from '../sanitizer/service.js';

export type Digest = `sha256:${string}`;
export type ConnectionErrorCode = 'CONNECTION_MISSING' | 'CONNECTION_INCOMPLETE' | 'CONNECTION_INVALID' |
  'CONNECTION_CONFLICT' | 'CONNECTION_BUSY' | 'CONNECTION_WRITE_FAILED' | 'HUB_UNAVAILABLE' |
  'KNOWLEDGE_IDENTITY_MISMATCH' | 'PROJECT_MISMATCH' | 'SOURCE_IDENTITY_MISMATCH' |
  'APPROVAL_MISSING' | 'FORMAT_UNSUPPORTED' | 'GENERATION_REQUIRED' | 'GENERATION_CHANGED' |
  'KNOWLEDGE_INVALID' | 'READ_BOUNDARY_VIOLATION' | 'KNOWLEDGE_PIN_MISMATCH' | 'KNOWLEDGE_UNINITIALIZED';
export class ConnectionError extends Error {
  constructor(readonly code: ConnectionErrorCode) { super(code); this.name = 'ConnectionError'; }
}
export function fail(code: ConnectionErrorCode = 'CONNECTION_INVALID'): never { throw new ConnectionError(code); }
export function hash(bytes: string | Uint8Array): Digest { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
export function valueDigest(value: unknown): Digest { return hash(serializeCanonicalJson(value)); }
export function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) fail();
  return r;
}
export function text(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || !v.isWellFormed() || [...v].some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159))) fail();
  return v;
}
export function digest(v: unknown): Digest {
  if (typeof v !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(v)) fail();
  return v as Digest;
}
export function locator(v: unknown): string {
  const t = text(v);
  if (containsCredentialMaterial(t)) fail();
  try { return validateRepositoryLocator(t); } catch { return fail(); }
}
export function projectId(v: unknown): string {
  try {
    const value = text(v);
    if (containsCredentialMaterial(value)) fail('PROJECT_MISMATCH');
    return validateProjectId(value);
  } catch { return fail('PROJECT_MISMATCH'); }
}
export function absolute(v: unknown): string {
  const t = text(v);
  if (!isAbsolute(t) || normalize(t) !== t) fail();
  return t;
}
export interface SharedConnection {
  readonly schemaVersion: 'buildlore.connection.v1' | 'buildlore.connection.v2';
  readonly mode?: 'knowledge';
  readonly knowledgeRepository: string;
  readonly knowledgeRepositoryDigest: Digest;
  readonly projectId: string;
}
export interface HubBinding {
  readonly mode?: 'knowledge';
  readonly knowledgeRepository: string;
  readonly knowledgeRepositoryDigest: Digest;
  readonly hubRoot: string;
}
export interface SourceIdentity { readonly device: string; readonly inode: string; readonly gitCommonDir: string }
export interface ReadBinding {
  readonly sourceRoot: string;
  readonly sourceRepositoryDigest: Digest;
  readonly knowledgeRepositoryDigest: Digest;
  readonly projectId: string;
  readonly connectionDigest: Digest;
  readonly sourceIdentity: SourceIdentity;
}
export interface ReadRegistry {
  readonly schemaVersion: 'buildlore.read-connections.v1' | 'buildlore.read-connections.v2';
  readonly hubs: readonly HubBinding[];
  readonly bindings: readonly ReadBinding[];
}
export function parseConnection(v: unknown): SharedConnection {
  const direct = typeof v === 'object' && v !== null && 'schemaVersion' in v && v.schemaVersion === 'buildlore.connection.v2';
  const r = record(v, ['schemaVersion', 'knowledgeRepository', 'knowledgeRepositoryDigest', 'projectId', ...(direct ? ['mode'] : [])]);
  if (direct ? r.mode !== 'knowledge' : r.schemaVersion !== 'buildlore.connection.v1') fail();
  const repository = locator(r.knowledgeRepository);
  if (repository !== r.knowledgeRepository || hash(repository) !== digest(r.knowledgeRepositoryDigest)) fail();
  return Object.freeze({ schemaVersion: direct ? 'buildlore.connection.v2' : 'buildlore.connection.v1', ...(direct ? { mode: 'knowledge' as const } : {}), knowledgeRepository: repository,
    knowledgeRepositoryDigest: digest(r.knowledgeRepositoryDigest), projectId: projectId(r.projectId) });
}
export function parseRegistry(v: unknown): ReadRegistry {
  const r = record(v, ['schemaVersion', 'hubs', 'bindings']);
  if ((r.schemaVersion !== 'buildlore.read-connections.v1' && r.schemaVersion !== 'buildlore.read-connections.v2') || !Array.isArray(r.hubs) || !Array.isArray(r.bindings)) fail();
  const hubs = r.hubs.map((v: unknown): HubBinding => {
    const direct = r.schemaVersion === 'buildlore.read-connections.v2' && typeof v === 'object' && v !== null && Object.hasOwn(v, 'mode');
    const h = record(v, ['knowledgeRepository', 'knowledgeRepositoryDigest', 'hubRoot', ...(direct ? ['mode'] : [])]);
    if (direct && h.mode !== 'knowledge') fail();
    const repository = locator(h.knowledgeRepository);
    if (repository !== h.knowledgeRepository || hash(repository) !== digest(h.knowledgeRepositoryDigest)) fail();
    return Object.freeze({ ...(direct ? { mode: 'knowledge' as const } : {}), knowledgeRepository: repository, knowledgeRepositoryDigest: digest(h.knowledgeRepositoryDigest), hubRoot: absolute(h.hubRoot) });
  });
  const bindings = r.bindings.map((v: unknown): ReadBinding => {
    const b = record(v, ['sourceRoot', 'sourceRepositoryDigest', 'knowledgeRepositoryDigest', 'projectId', 'connectionDigest', 'sourceIdentity']);
    const i = record(b.sourceIdentity, ['device', 'inode', 'gitCommonDir']);
    const device = text(i.device), inode = text(i.inode);
    if (!/^\d+$/u.test(device) || !/^\d+$/u.test(inode)) fail();
    return Object.freeze({ sourceRoot: absolute(b.sourceRoot), sourceRepositoryDigest: digest(b.sourceRepositoryDigest),
      knowledgeRepositoryDigest: digest(b.knowledgeRepositoryDigest), projectId: projectId(b.projectId), connectionDigest: digest(b.connectionDigest),
      sourceIdentity: Object.freeze({ device, inode, gitCommonDir: absolute(i.gitCommonDir) }) });
  });
  if (new Set(hubs.map(h => h.knowledgeRepositoryDigest)).size !== hubs.length ||
      new Set(hubs.map(h => h.hubRoot)).size !== hubs.length || new Set(bindings.map(b => b.sourceRoot)).size !== bindings.length ||
      bindings.some(b => !hubs.some(h => h.knowledgeRepositoryDigest === b.knowledgeRepositoryDigest))) fail('CONNECTION_CONFLICT');
  return Object.freeze({ schemaVersion: r.schemaVersion, hubs: Object.freeze(hubs), bindings: Object.freeze(bindings) });
}
export function decodeConfig(bytes: Uint8Array, maxBytes: number): unknown {
  if (bytes.byteLength > maxBytes) fail();
  try { return parseJsonStrict(decodeUtf8Strict(bytes)); } catch { return fail(); }
}
export function emptyRegistry(): ReadRegistry { return { schemaVersion: 'buildlore.read-connections.v1', hubs: [], bindings: [] }; }
