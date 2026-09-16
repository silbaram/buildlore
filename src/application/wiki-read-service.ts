import { LookupBatchError, validateLookupBatch } from '../compiler/project-knowledge/lookup-batch.js';
import { measureRead, type ReadObserver } from '../retrieval/read-observer.js';
import { TaskMemoryError } from '../compiler/project-knowledge/task-memory.js';
import { ProgressiveMemoryError } from '../compiler/project-knowledge/progressive-memory.js';
import { SecurityOperationError } from '../sanitizer/errors.js';
import { readSecurityPolicy } from '../sanitizer/policy.js';
import { join } from 'node:path';
import { openKnowledgeReadSession } from '../retrieval/project-knowledge-reader.js';
import { createLocalWikiOperator } from '../retrieval/local-wiki-operator.js';
import { latestKnowledgeGeneration } from '../retrieval/project-knowledge-authority.js';
import type { ApprovedWikiProjectionStorePort } from '../retrieval/approved-corpus-store.js';
import { ConnectionError, digest, fail, type Digest } from '../connection/contracts.js';
import { connectionPaths, assertConnectionCurrent, type ConnectionContext } from '../connection/service.js';
import { gitRead } from '../connection/git-read.js';
import type { LocalWikiRetrievalIntent, LocalWikiRetrievalMode } from '../retrieval/hybrid-types.js';

export interface WikiReadRequest {
  readonly operation: 'list' | 'search' | 'read' | 'memory' | 'lookup' | 'citations';
  readonly expectedGeneration?: string;
  readonly page?: string;
  readonly query?: string;
  readonly mode?: string;
  readonly intent?: string;
  readonly view?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly task?: string;
  readonly maxBytes?: number;
  readonly progressive?: boolean;
  readonly kind?: 'evidence' | 'fact';
  readonly id?: string;
  readonly ids?: readonly string[];
}
export interface ReadContextMetadata {
  readonly knowledgeRepositoryDigest: Digest;
  readonly format: 'project-knowledge' | 'hierarchical';
  readonly generation: Digest;
  readonly readPolicy: 'connected-approved';
}
export interface WikiReadResult { readonly data: unknown; readonly readContext: ReadContextMetadata; readonly knowledgeRevision: string }
export interface ReadServiceHooks { readonly afterSnapshot?: () => Promise<void>; readonly observer?: ReadObserver }
function required(value: string | undefined): string { return value ?? fail(); }
function expected(request: WikiReadRequest, policy: 'connected-approved' | 'hub-compatible'): Digest | undefined {
  if (request.expectedGeneration !== undefined) return digest(request.expectedGeneration);
  if (policy === 'connected-approved' && ['read', 'lookup', 'citations'].includes(request.operation)) fail('GENERATION_REQUIRED');
  return undefined;
}
function searchOptions(request: WikiReadRequest, policy: 'connected-approved' | 'hub-compatible'):
  Readonly<{ mode: LocalWikiRetrievalMode; intent: LocalWikiRetrievalIntent }> {
  const mode = request.mode ?? (policy === 'connected-approved' ? 'lexical' : 'hybrid');
  const intent = request.intent ?? 'auto';
  if (mode !== 'lexical' && mode !== 'graph' && mode !== 'hybrid' && mode !== 'semantic') fail();
  if (intent !== 'auto' && intent !== 'current' && intent !== 'historical' && intent !== 'neutral') fail();
  if (policy === 'connected-approved' && (mode !== 'lexical' ||
      (request.intent !== undefined && intent !== 'neutral'))) fail('FORMAT_UNSUPPORTED');
  return { mode, intent };
}

/** Shared application projection; compatibility callers keep their legacy fallback outside this strict branch. */
export async function readApprovedWiki(hubRoot: string, projectId: string, request: WikiReadRequest,
  policy: 'connected-approved' | 'hub-compatible' = 'connected-approved', hooks: ReadServiceHooks = {},
): Promise<Readonly<{ data: unknown; format: ReadContextMetadata['format']; generation: Digest }>> {
  const wanted = expected(request, policy);
  const search = searchOptions(request, policy);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  try {
    const session = await openKnowledgeReadSession(knowledgeRoot, projectId, { hubRoot,
      ...(hooks.observer ? { observer: hooks.observer } : {}) });
    if (!session) fail('APPROVAL_MISSING');
    const generation = session.generationDigest ?? session.publication.projection.corpus.generationDigest;
    const format = session.generationDigest ? 'project-knowledge' : 'hierarchical';
    if (wanted !== undefined && generation !== wanted) fail('GENERATION_CHANGED');
    if (request.operation === 'lookup') {
      if ((request.id === undefined) === (request.ids === undefined) || request.id !== undefined && request.maxBytes !== undefined) fail();
      if (request.ids !== undefined) validateLookupBatch(request.kind ?? fail(), request.ids.map(id => digest(id)),
        request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes });
    }
    await hooks.afterSnapshot?.();
    let data: unknown;
    if (format === 'project-knowledge') {
      const reader = session.reader;
      switch (request.operation) {
        case 'list': data = await reader.list(projectId, { ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.limit === undefined ? {} : { limit: request.limit }) }); break;
        case 'read': data = request.view === 'reader' ? await reader.readContext(projectId, required(request.page)) : await reader.read(projectId, required(request.page)); break;
        case 'citations': data = await reader.citations(projectId, required(request.page)); break;
        case 'search': data = await reader.search(projectId, required(request.query), search.mode, search.intent); break;
        case 'lookup': data = request.ids === undefined
          ? await reader.lookup(projectId, generation, request.kind ?? fail(), digest(request.id))
          : await reader.lookupBatch(projectId, generation, request.kind ?? fail(), request.ids.map(id => digest(id)),
            request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }); break;
        case 'memory': {
          if (request.task === undefined) {
            if (request.maxBytes !== undefined || request.progressive || request.cursor !== undefined) fail();
            data = await reader.readMemory(projectId);
          } else {
            const memory = { task: request.task, ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }) };
            if (request.progressive) data = await reader.readProgressiveMemory(projectId, { ...memory, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) });
            else { if (request.cursor !== undefined) fail(); data = await reader.readTaskMemory(projectId, memory); }
          }
          break;
        }
      }
    } else {
      if (request.operation === 'memory' || request.operation === 'lookup' || request.view === 'reader') fail('FORMAT_UNSUPPORTED');
      const match = (id: string): void => { if (id !== projectId) fail('PROJECT_MISMATCH'); };
      const corpusStore: ApprovedWikiProjectionStorePort = {
        publish: () => Promise.reject(new ConnectionError('READ_BOUNDARY_VIOLATION')),
        read: id => { match(id); return Promise.resolve(session.publication.projection); },
        readAuthority: id => { match(id); return Promise.resolve(session.publication.authority); },
        status: () => Promise.reject(new ConnectionError('READ_BOUNDARY_VIOLATION')),
      };
      const reader = createLocalWikiOperator({ hubRoot, knowledgeRoot, corpusStore });
      switch (request.operation) {
        case 'list': data = await reader.listPages({ projectId, ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.limit === undefined ? {} : { limit: request.limit }) }); break;
        case 'read': data = await reader.readPage({ projectId, pageId: required(request.page) }); break;
        case 'citations': data = await reader.pageCitations({ projectId, pageId: required(request.page) }); break;
        case 'search': data = await reader.search({ projectId, query: required(request.query), ...search }); break;
      }
    }
    if (data === null || data === undefined) fail('KNOWLEDGE_INVALID');
    return { data, format, generation };
  } catch (e) {
    if (policy === 'hub-compatible') throw e;
    if (e instanceof ConnectionError || e instanceof LookupBatchError || e instanceof TaskMemoryError || e instanceof ProgressiveMemoryError || e instanceof SecurityOperationError) throw e;
    return fail('KNOWLEDGE_INVALID');
  }
}
export async function readConnectedWiki(context: ConnectionContext, request: WikiReadRequest, hooks: ReadServiceHooks = {}): Promise<WikiReadResult> {
  expected(request, 'connected-approved');
  const current = await measureRead(hooks.observer, 'connection', () => assertConnectionCurrent(context));
  const paths = connectionPaths(current);
  if (paths.pin !== 'matched') fail('KNOWLEDGE_PIN_MISMATCH');
  const result = await readApprovedWiki(paths.hubRoot, context.projectId, request, 'connected-approved', {
    ...(hooks.observer ? { observer: hooks.observer } : {}), afterSnapshot: async () => {
    if ((await gitRead(paths.knowledgeRoot, ['rev-parse', '--verify', 'HEAD^{commit}']))?.trim() !== paths.knowledgeRevision) fail('CONNECTION_CONFLICT');
    await hooks.afterSnapshot?.();
  } });
  return { data: result.data, knowledgeRevision: paths.knowledgeRevision,
    readContext: { knowledgeRepositoryDigest: context.knowledgeRepositoryDigest, format: result.format, generation: result.generation, readPolicy: 'connected-approved' } };
}
export async function connectionStatus(context: ConnectionContext): Promise<Readonly<Record<string, unknown>>> {
  const paths = connectionPaths(await assertConnectionCurrent(context));
  let approval = 'ready', generation: Digest | null = null, format: ReadContextMetadata['format'] | null = null;
  let sourceRevisionComparison: 'match' | 'different' | 'unknown' = 'unknown';
  try {
    const session = await openKnowledgeReadSession(paths.knowledgeRoot, context.projectId, { hubRoot: paths.hubRoot });
    if (!session) approval = 'missing';
    else {
      const policy = await readSecurityPolicy(paths.knowledgeRoot, context.projectId);
      if (policy.digest !== session.publication.projection.sanitizerPolicyDigest) fail('KNOWLEDGE_INVALID');
      if (session.generationDigest && !await session.reader.list(context.projectId)) fail('KNOWLEDGE_INVALID');
      generation = session.generationDigest ?? session.publication.projection.corpus.generationDigest;
      format = session.generationDigest ? 'project-knowledge' : 'hierarchical';
      const extension = session.publication.authority.knowledgeGeneration;
      const selected = extension ? latestKnowledgeGeneration(extension) : null;
      const sources = selected?.snapshot.sources ?? [];
      const revisions = sources.map(s => s.repositoryRevision ?? s.sourceRevision)
        .filter((v): v is string => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v));
      const head = (await gitRead(paths.sourceRoot, ['rev-parse', '--verify', 'HEAD'], true))?.trim();
      if (head && revisions.length) sourceRevisionComparison = revisions.some(r => r !== head) ? 'different' : revisions.length === sources.length ? 'match' : 'unknown';
    }
  } catch { approval = 'invalid'; }
  return { schemaVersion: 'buildlore.connection-status.v1', connected: true, readable: approval === 'ready' && paths.pin === 'matched',
    projectId: context.projectId, connectionDigest: context.connectionDigest, hubState: 'ready', knowledgeRevision: paths.knowledgeRevision,
    pin: paths.pin, dirty: paths.dirty, approval, generation, format, readPolicy: 'connected-approved', remote: 'not_checked', sourceRevisionComparison,
    recoveryCommands: approval === 'ready' && paths.pin === 'matched' ? [] : [['knowledge', 'status'], ['project', 'show', '--project', context.projectId]] };
}

export function unavailableConnectionStatus(error: unknown): Readonly<Record<string, unknown>> {
  const code = error instanceof ConnectionError ? error.code : 'CONNECTION_INVALID';
  return { schemaVersion: 'buildlore.connection-status.v1', connected: false, readable: false,
    projectId: null, connectionDigest: null, hubState: code === 'KNOWLEDGE_IDENTITY_MISMATCH' ? 'identity_mismatch' : 'unavailable',
    knowledgeRevision: null, pin: code === 'KNOWLEDGE_UNINITIALIZED' ? 'uninitialized' : 'unknown', dirty: 'unknown', approval: ['CONNECTION_MISSING', 'CONNECTION_INCOMPLETE', 'HUB_UNAVAILABLE', 'KNOWLEDGE_UNINITIALIZED'].includes(code) ? 'missing' : 'invalid', generation: null, format: null,
    readPolicy: 'connected-approved', remote: 'not_checked', sourceRevisionComparison: 'unknown', recoveryCommands: [['--help']] };
}
