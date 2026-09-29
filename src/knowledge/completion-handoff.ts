import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { consumePreparedSource } from '../sanitizer/approval.js';
import { createProjectSecurityService } from '../sanitizer/index.js';
import type { SanitizationReport } from '../sanitizer/types.js';
import { syncDirectory } from './atomic-file.js';
import { resolveKnowledgeRoot, resolveProjectWorkspace } from './paths.js';
import { createRepositoryWriterLease } from './repository-writer-lease.js';
import { validateProjectId } from './validation.js';
import { parseJsonStrict } from './strict-json.js';

export const COMPLETION_HANDOFF_MAX_INPUT_BYTES = 1024 * 1024;
const MAX_STORED_BYTES = 2 * COMPLETION_HANDOFF_MAX_INPUT_BYTES;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COMPLETION_SCHEMA_SCALARS = new Set([
  'p2a.current_development_contract.v1',
  'p2a.decision_provenance_snapshot.v1',
  'p2a.run_index_snapshot.v1',
]);
type Digest = `sha256:${string}`;
type SourceRole = 'contract' | 'task' | 'verification' | 'decision' | 'note' | 'evidence';
type MediaType = 'application/json' | 'text/markdown' | 'text/plain';

export class CompletionHandoffError extends Error {
  constructor(readonly code: string, message = 'Completion handoff could not be validated or preserved safely.') {
    super(message);
    this.name = 'CompletionHandoffError';
  }
}

export interface CompletionHandoffInput {
  readonly schemaVersion: 'buildlore.completion-input.v1';
  readonly projectId: string;
  readonly workId: string;
  readonly workKind: 'iteration' | 'maintenance';
  readonly completedAt: string;
  readonly repository: { readonly id: string; readonly codeRevision: string | null; readonly contentDigest: Digest | null };
  readonly predecessor: { readonly handoffId: Digest; readonly baselineDigest: Digest } | null;
  readonly affectedAreas: readonly string[];
  readonly supersedes: readonly Digest[];
  readonly baseline: { readonly format: string; readonly body: string; readonly sourceDigest: Digest };
  readonly knowledge: { readonly summary: string; readonly decisions: readonly string[]; readonly lessons: readonly string[]; readonly remaining: readonly string[] };
  readonly sources: readonly { readonly ref: string; readonly role: SourceRole; readonly mediaType: MediaType; readonly body: string; readonly sourceDigest: Digest }[];
}

export interface CompletionHandoff extends Omit<CompletionHandoffInput, 'schemaVersion' | 'baseline' | 'sources'> {
  readonly schemaVersion: 'buildlore.completion-handoff.v1';
  readonly handoffId: Digest;
  readonly digest: Digest;
  readonly wikiStatus: 'pending';
  readonly cleanupEligible: false;
  readonly baseline: CompletionHandoffInput['baseline'] & { readonly bodyDigest: Digest };
  readonly sources: readonly (CompletionHandoffInput['sources'][number] & { readonly bodyDigest: Digest })[];
  readonly sanitation: { readonly policyDigest: Digest; readonly rulesVersion: string };
}

export interface CompletionHandoffReceipt {
  readonly schemaVersion: 'buildlore.completion-receipt.v1';
  readonly projectId: string;
  readonly workId: string;
  readonly handoffId: Digest;
  readonly digest: Digest;
  readonly relativePath: string;
  readonly commit: string | null;
  readonly storage: 'stored' | 'committed';
  readonly wikiStatus: 'pending';
  readonly cleanupEligible: false;
}

function fail(code = 'COMPLETION_HANDOFF_INPUT_INVALID'): never { throw new CompletionHandoffError(code); }
function sanitationFailed(stage: string, report: SanitizationReport): never {
  throw new CompletionHandoffError('COMPLETION_HANDOFF_SANITIZATION_FAILED',
    `Completion handoff sanitation rejected ${stage}; rules: ${report.summaries.map((summary) => summary.ruleId).join(', ') || 'binding'}.`);
}
function hash(body: string): Digest { return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`; }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail();
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && value.length === 0) || value.includes('\0')) fail();
  return value;
}
function label(value: unknown, max: number): string {
  const result = string(value, max);
  if ([...result].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail();
  return result;
}
function workId(value: unknown): string {
  const result = label(value, 128);
  if (!WORK_ID.test(result)) fail();
  return result;
}
function digest(value: unknown): Digest {
  if (typeof value !== 'string' || !SHA.test(value)) fail();
  return value as Digest;
}
function strings(value: unknown, max = 128): string[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value.map((entry) => string(entry, 16_384));
}
function sourceRef(value: unknown): string {
  const ref = label(value, 1024);
  if (ref.includes('\\') || ref.includes(':') || ref.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.git')) fail();
  return ref;
}
function parseJson(body: string): unknown {
  try { return parseJsonStrict(body); } catch { return fail(); }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = record(value);
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(',')}}`;
}

function parseInput(value: unknown, expectedProjectId: string, checkSourceDigests = true): CompletionHandoffInput {
  const input = record(value);
  exact(input, ['schemaVersion', 'projectId', 'workId', 'workKind', 'completedAt', 'repository', 'predecessor', 'affectedAreas', 'supersedes', 'baseline', 'knowledge', 'sources']);
  if (input.schemaVersion !== 'buildlore.completion-input.v1' || input.projectId !== expectedProjectId ||
      (input.workKind !== 'iteration' && input.workKind !== 'maintenance')) fail();
  validateProjectId(expectedProjectId);
  const completedAt = string(input.completedAt, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(completedAt) || !Number.isFinite(Date.parse(completedAt))) fail();
  const repository = record(input.repository);
  exact(repository, ['id', 'codeRevision', 'contentDigest']);
  const codeRevision = repository.codeRevision === null ? null : string(repository.codeRevision, 64);
  if (codeRevision !== null && !OID.test(codeRevision)) fail();
  const baseline = record(input.baseline);
  exact(baseline, ['format', 'body', 'sourceDigest']);
  const baselineBody = string(baseline.body, COMPLETION_HANDOFF_MAX_INPUT_BYTES);
  record(parseJson(baselineBody));
  const baselineSourceDigest = digest(baseline.sourceDigest);
  if (checkSourceDigests && hash(baselineBody) !== baselineSourceDigest) fail('COMPLETION_HANDOFF_DIGEST_MISMATCH');
  const knowledge = record(input.knowledge);
  exact(knowledge, ['summary', 'decisions', 'lessons', 'remaining']);
  let predecessor: CompletionHandoffInput['predecessor'] = null;
  if (input.predecessor !== null) {
    const prior = record(input.predecessor);
    exact(prior, ['handoffId', 'baselineDigest']);
    predecessor = { handoffId: digest(prior.handoffId), baselineDigest: digest(prior.baselineDigest) };
  }
  if (!Array.isArray(input.sources) || input.sources.length > 256) fail();
  const sources = input.sources.map((value) => {
    const source = record(value);
    exact(source, ['ref', 'role', 'mediaType', 'body', 'sourceDigest']);
    if (!['contract', 'task', 'verification', 'decision', 'note', 'evidence'].includes(String(source.role)) ||
        !['application/json', 'text/markdown', 'text/plain'].includes(String(source.mediaType))) fail();
    const body = string(source.body, COMPLETION_HANDOFF_MAX_INPUT_BYTES, true);
    const sourceDigest = digest(source.sourceDigest);
    if (checkSourceDigests && hash(body) !== sourceDigest) fail('COMPLETION_HANDOFF_DIGEST_MISMATCH');
    if (source.mediaType === 'application/json') parseJson(body);
    return { ref: sourceRef(source.ref), role: source.role as SourceRole, mediaType: source.mediaType as MediaType, body, sourceDigest };
  });
  if (new Set(sources.map((source) => source.ref)).size !== sources.length) fail();
  return {
    schemaVersion: 'buildlore.completion-input.v1', projectId: expectedProjectId, workId: workId(input.workId),
    workKind: input.workKind, completedAt,
    repository: { id: label(repository.id, 1024), codeRevision, contentDigest: repository.contentDigest === null ? null : digest(repository.contentDigest) },
    predecessor, affectedAreas: strings(input.affectedAreas), supersedes: strings(input.supersedes).map(digest),
    baseline: { format: label(baseline.format, 128), body: baselineBody, sourceDigest: baselineSourceDigest },
    knowledge: { summary: string(knowledge.summary, 65_536), decisions: strings(knowledge.decisions), lessons: strings(knowledge.lessons), remaining: strings(knowledge.remaining) }, sources,
  };
}

function decodedSecurityBody(input: CompletionHandoffInput): string {
  const decodedParts: string[] = [];
  const structured = [parseJson(input.baseline.body),
    ...input.sources.filter((source) => source.mediaType === 'application/json').map((source) => parseJson(source.body))];
  // A key and its value must also be scanned together. Scanning only decoded
  // scalars loses credential assignments when a JSON key uses Unicode escapes.
  for (const value of structured) decodedParts.push(JSON.stringify(value));
  const pending: unknown[] = [input, ...structured];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string') decodedParts.push(item);
    else if (Array.isArray(item)) { for (const child of item as unknown[]) pending.push(child); }
    else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) pending.push(key, child);
    }
  }
  return decodedParts.join('\n');
}

async function prepare(inputValue: unknown, root: string, projectId: string): Promise<CompletionHandoff> {
  let encoded: string;
  try { encoded = JSON.stringify(inputValue); } catch { return fail(); }
  if (encoded === undefined || Buffer.byteLength(encoded) > COMPLETION_HANDOFF_MAX_INPUT_BYTES) fail('COMPLETION_HANDOFF_INPUT_LIMIT');
  const input = parseInput(parseJson(encoded), projectId);
  const service = createProjectSecurityService({ knowledgeRoot: root });
  // Scan decoded scalar values too: JSON escapes must never hide secret boundaries.
  const preflightBody = decodedSecurityBody(input);
  const preflightDigest = hash(preflightBody);
  const preflight = await service.prepareSource({ body: preflightBody, bodyDigest: preflightDigest, projectId, source: 'completion-decoded.txt', sourceKind: 'text', sourceRevisionOrContentSha256: preflightDigest });
  const suspicious = (summaries: typeof preflight.report.summaries, checkEntropy = true) => summaries.some((summary) => summary.count > summary.overriddenCount && (summary.ruleId.startsWith('credential.') || (checkEntropy && summary.ruleId === 'entropy.candidate') || summary.ruleId === 'suspicion.jwt'));
  // Aggregates retain credential/block checks. Entropy warnings are evaluated
  // on each scalar below, where an exact known schema value can be identified
  // without weakening the shared sanitizer or ignoring a neighboring secret.
  if (!preflight.ok || suspicious(preflight.report.summaries, false)) sanitationFailed('decoded input', preflight.report);
  if (consumePreparedSource(preflight.prepared) === null) fail('COMPLETION_HANDOFF_SANITIZATION_FAILED');
  // Sanitize scalar values before JSON encoding. Redacting serialized JSON can
  // consume escaped quote boundaries and corrupt a valid structured contract.
  const sanitizeText = async (body: string): Promise<string> => {
    const inputDigest = hash(body);
    const result = await service.prepareSource({ body, bodyDigest: inputDigest, projectId, source: 'completion-handoff.json', sourceKind: 'text', sourceRevisionOrContentSha256: inputDigest });
    if (!result.ok || suspicious(result.report.summaries, !COMPLETION_SCHEMA_SCALARS.has(body))) sanitationFailed('scalar input', result.report);
    const binding = consumePreparedSource(result.prepared);
    if (binding === null || binding.projectId !== projectId || binding.inputBodyDigest !== inputDigest || binding.policyDigest !== preflight.report.policyDigest) fail('COMPLETION_HANDOFF_SANITIZATION_FAILED');
    return binding.approvedBody;
  };
  const sanitizeValue = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') return sanitizeText(value);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value as unknown[]) result.push(await sanitizeValue(item));
      return result;
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (await sanitizeText(key) !== key) fail('COMPLETION_HANDOFF_SANITIZATION_FAILED');
        result[key] = await sanitizeValue(item);
      }
      return result;
    }
    return value;
  };
  const sanitizeJsonBody = async (body: string): Promise<string> => {
    const parsed = parseJson(body);
    const sanitized = await sanitizeValue(parsed);
    return canonical(parsed) === canonical(sanitized) ? body : canonical(sanitized);
  };
  const baselineBody = await sanitizeJsonBody(input.baseline.body);
  const sourceBodies: string[] = [];
  for (const source of input.sources) sourceBodies.push(source.mediaType === 'application/json' ? await sanitizeJsonBody(source.body) : await sanitizeText(source.body));
  const metadata = await sanitizeValue({ ...input, baseline: { ...input.baseline, body: '' }, sources: input.sources.map((source) => ({ ...source, body: '' })) });
  const sanitizedMetadata = record(metadata);
  record(sanitizedMetadata.baseline).body = baselineBody;
  if (!Array.isArray(sanitizedMetadata.sources)) fail();
  for (let index = 0; index < sanitizedMetadata.sources.length; index++) record(sanitizedMetadata.sources[index]).body = sourceBodies[index];
  const sanitized = parseInput(sanitizedMetadata, projectId, false);
  const finalDecoded = decodedSecurityBody(sanitized);
  const finalDigest = hash(finalDecoded);
  const finalCheck = await service.prepareSource({ body: finalDecoded, bodyDigest: finalDigest, projectId, source: 'completion-decoded.txt', sourceKind: 'text', sourceRevisionOrContentSha256: finalDigest });
  // If encoded nested JSON still hides a path or credential requiring redaction,
  // refuse instead of persisting unsanitized bytes or rewriting contract semantics.
  if (!finalCheck.ok || suspicious(finalCheck.report.summaries, false) || finalCheck.report.summaries.some((summary) => summary.action === 'redact')) sanitationFailed('stored decoded input', finalCheck.report);
  if (consumePreparedSource(finalCheck.prepared) === null) fail('COMPLETION_HANDOFF_SANITIZATION_FAILED');
  const payload = {
    ...sanitized, schemaVersion: 'buildlore.completion-handoff.v1' as const,
    wikiStatus: 'pending' as const, cleanupEligible: false as const,
    baseline: { ...sanitized.baseline, bodyDigest: hash(sanitized.baseline.body) },
    sources: sanitized.sources.map((source) => ({ ...source, bodyDigest: hash(source.body) })),
    sanitation: { policyDigest: preflight.report.policyDigest, rulesVersion: preflight.report.rulesVersion },
  };
  const handoffId = hash(canonical(payload));
  return { ...payload, handoffId, digest: handoffId };
}

function parseStored(value: unknown, projectId: string, id: string): CompletionHandoff {
  const obj = record(value);
  exact(obj, ['schemaVersion', 'projectId', 'workId', 'workKind', 'completedAt', 'repository', 'predecessor', 'affectedAreas', 'supersedes', 'baseline', 'knowledge', 'sources', 'wikiStatus', 'cleanupEligible', 'sanitation', 'handoffId', 'digest']);
  if (obj.schemaVersion !== 'buildlore.completion-handoff.v1' || obj.wikiStatus !== 'pending' || obj.cleanupEligible !== false || obj.handoffId !== id || obj.digest !== id) fail('COMPLETION_HANDOFF_CORRUPT');
  const payload = { ...obj };
  delete payload.handoffId;
  delete payload.digest;
  if (hash(canonical(payload)) !== id) fail('COMPLETION_HANDOFF_CORRUPT');
  const baseline = record(obj.baseline);
  exact(baseline, ['format', 'body', 'sourceDigest', 'bodyDigest']);
  if (hash(string(baseline.body, MAX_STORED_BYTES)) !== digest(baseline.bodyDigest)) fail('COMPLETION_HANDOFF_CORRUPT');
  if (!Array.isArray(obj.sources)) fail('COMPLETION_HANDOFF_CORRUPT');
  const sources = obj.sources.map((entry) => {
    const source = record(entry);
    exact(source, ['ref', 'role', 'mediaType', 'body', 'sourceDigest', 'bodyDigest']);
    if (hash(string(source.body, MAX_STORED_BYTES, true)) !== digest(source.bodyDigest)) fail('COMPLETION_HANDOFF_CORRUPT');
    const original = { ...source };
    delete original.bodyDigest;
    return original;
  });
  const sanitation = record(obj.sanitation);
  exact(sanitation, ['policyDigest', 'rulesVersion']);
  digest(sanitation.policyDigest);
  label(sanitation.rulesVersion, 128);
  const originalBaseline = { ...baseline };
  delete originalBaseline.bodyDigest;
  parseInput({ schemaVersion: 'buildlore.completion-input.v1', projectId: obj.projectId, workId: obj.workId,
    workKind: obj.workKind, completedAt: obj.completedAt, repository: obj.repository, predecessor: obj.predecessor,
    affectedAreas: obj.affectedAreas, supersedes: obj.supersedes, baseline: originalBaseline, knowledge: obj.knowledge, sources }, projectId, false);
  return obj as unknown as CompletionHandoff;
}

async function directory(root: string, projectId: string, create: boolean): Promise<string | null> {
  const project = await resolveProjectWorkspace(root, projectId, { mustExist: true });
  for (const path of [join(project, 'handoffs'), join(project, 'handoffs', 'objects')]) {
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    let status;
    try { status = await lstat(path); } catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(path) !== path) fail('COMPLETION_HANDOFF_UNSAFE_PATH');
  }
  return join(project, 'handoffs', 'objects');
}

async function safeRead(path: string): Promise<string> {
  let handle;
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size > MAX_STORED_BYTES) fail('COMPLETION_HANDOFF_UNSAFE_PATH');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== status.dev || opened.ino !== status.ino || opened.size > MAX_STORED_BYTES) fail('COMPLETION_HANDOFF_UNSAFE_PATH');
    const buffer = Buffer.alloc(MAX_STORED_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_STORED_BYTES) fail('COMPLETION_HANDOFF_INPUT_LIMIT');
    const body = buffer.subarray(0, offset);
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    if (error instanceof CompletionHandoffError) throw error;
    return fail('COMPLETION_HANDOFF_UNREADABLE');
  } finally { await handle?.close(); }
}

function relativePath(projectId: string, id: string): string { return `projects/${projectId}/handoffs/objects/${id.slice(7)}.json`; }
interface ReadOptions { readonly knowledgeRoot: string; readonly projectId: string; readonly id: string }

export async function readCompletionHandoff(options: ReadOptions): Promise<CompletionHandoff> {
  validateProjectId(options.projectId);
  digest(options.id);
  const root = await resolveKnowledgeRoot(options.knowledgeRoot);
  const dir = await directory(root, options.projectId, false);
  if (dir === null) fail('COMPLETION_HANDOFF_NOT_FOUND');
  const body = await safeRead(join(dir, `${options.id.slice(7)}.json`));
  await directory(root, options.projectId, false);
  return parseStored(parseJson(body), options.projectId, options.id);
}

// Plumbing only: no filters, hooks, network, or caller-provided Git environment.
function git(root: string, args: readonly string[], input?: string, index?: string): Promise<{ code: number; output: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=BuildLore', '-c', 'user.email=buildlore@local.invalid', ...args], {
      cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', ...(index === undefined ? {} : { GIT_INDEX_FILE: index }) }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_STORED_BYTES + 4096) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.on('error', () => { clearTimeout(timer); reject(new CompletionHandoffError('COMPLETION_HANDOFF_GIT_FAILED')); });
    child.on('close', (code) => { clearTimeout(timer); if (code === null || size > MAX_STORED_BYTES + 4096) reject(new CompletionHandoffError('COMPLETION_HANDOFF_GIT_FAILED')); else resolveResult({ code, output: Buffer.concat(chunks).toString('utf8') }); });
    child.stdin.on('error', () => { /* Close reports the bounded command failure. */ });
    child.stdin.end(input);
  });
}
async function gitOk(root: string, args: readonly string[], input?: string, index?: string): Promise<string> {
  const result = await git(root, args, input, index);
  if (result.code !== 0) fail('COMPLETION_HANDOFF_GIT_FAILED');
  return result.output;
}
async function committedAtHead(root: string, path: string, bytes: string): Promise<string | null> {
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || resolve(top.output.trim()) !== root) return null;
  const head = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const oid = head.output.trim();
  if (head.code !== 0 || !OID.test(oid)) return null;
  const tree = await git(root, ['ls-tree', oid, '--', path]);
  if (tree.code !== 0 || !tree.output.startsWith('100644 blob ')) return null;
  const blob = await git(root, ['show', `${oid}:${path}`]);
  if (blob.code !== 0 || blob.output !== bytes) return null;
  return oid;
}
function receipt(bundle: CompletionHandoff, commit: string | null): CompletionHandoffReceipt {
  return { schemaVersion: 'buildlore.completion-receipt.v1', projectId: bundle.projectId, workId: bundle.workId,
    handoffId: bundle.handoffId, digest: bundle.digest, relativePath: relativePath(bundle.projectId, bundle.handoffId),
    commit, storage: commit === null ? 'stored' : 'committed', wikiStatus: 'pending', cleanupEligible: false };
}

export async function verifyCompletionHandoff(options: ReadOptions): Promise<CompletionHandoffReceipt> {
  const bundle = await readCompletionHandoff(options);
  const root = await resolveKnowledgeRoot(options.knowledgeRoot);
  const path = relativePath(options.projectId, options.id);
  const bytes = await safeRead(join(root, path));
  if (canonical(parseStored(parseJson(bytes), options.projectId, options.id)) !== canonical(bundle)) fail('COMPLETION_HANDOFF_CORRUPT');
  return receipt(bundle, await committedAtHead(root, path, bytes));
}

async function commitObject(root: string, bundle: CompletionHandoff, bytes: string): Promise<string> {
  const path = relativePath(bundle.projectId, bundle.handoffId);
  const existing = await committedAtHead(root, path, bytes);
  if (existing !== null) return existing;
  const top = (await gitOk(root, ['rev-parse', '--show-toplevel'])).trim();
  if (resolve(top) !== root) fail('COMPLETION_HANDOFF_UNSAFE_PATH');
  const parent = (await gitOk(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const branch = (await gitOk(root, ['symbolic-ref', '-q', 'HEAD'])).trim();
  if (!OID.test(parent) || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch)) fail('COMPLETION_HANDOFF_GIT_FAILED');
  const previous = await git(root, ['ls-tree', parent, '--', path]);
  if (previous.code !== 0 || previous.output !== '') fail('COMPLETION_HANDOFF_CORRUPT');
  const staged = await gitOk(root, ['ls-files', '--stage', '--', path]);
  if (staged !== '') fail('COMPLETION_HANDOFF_TARGET_STAGED');
  const temporary = await mkdtemp(join(tmpdir(), 'buildlore-handoff-index-'));
  let indexLock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath: string | undefined;
  try {
    const index = join(temporary, 'index');
    await gitOk(root, ['read-tree', parent], undefined, index);
    const blob = (await gitOk(root, ['hash-object', '-w', '--stdin'], bytes)).trim();
    if (!OID.test(blob)) fail('COMPLETION_HANDOFF_GIT_FAILED');
    const indexRecord = `100644 ${blob}\t${path}\0`;
    await gitOk(root, ['update-index', '-z', '--index-info'], indexRecord, index);
    const tree = (await gitOk(root, ['write-tree'], undefined, index)).trim();
    if (!OID.test(tree)) fail('COMPLETION_HANDOFF_GIT_FAILED');
    const commit = (await gitOk(root, ['commit-tree', tree, '-p', parent, '-F', '-'], 'Preserve completion handoff\n')).trim();
    if (!OID.test(commit)) fail('COMPLETION_HANDOFF_GIT_FAILED');
    const changed = await gitOk(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', parent, commit]);
    if (changed !== `${path}\0` || await gitOk(root, ['show', `${commit}:${path}`]) !== bytes) fail('COMPLETION_HANDOFF_GIT_FAILED');
    const current = await readCompletionHandoff({ knowledgeRoot: root, projectId: bundle.projectId, id: bundle.handoffId });
    if (canonical(current) !== canonical(bundle)) fail('COMPLETION_HANDOFF_CORRUPT');
    const rawIndex = (await gitOk(root, ['rev-parse', '--git-path', 'index'])).trim();
    const realIndex = resolve(root, rawIndex);
    lockPath = `${realIndex}.lock`;
    // Respect Git's native writer lock; build a replacement index without changing
    // caller entries. A failed CAS leaves their complete original index untouched.
    indexLock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const replacementIndex = join(temporary, 'caller-index');
    try {
      const status = await lstat(realIndex);
      if (!status.isFile() || status.isSymbolicLink()) fail('COMPLETION_HANDOFF_UNSAFE_PATH');
      await copyFile(realIndex, replacementIndex);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await gitOk(root, ['read-tree', '--empty'], undefined, replacementIndex);
    }
    if (await gitOk(root, ['ls-files', '--stage', '--', path], undefined, replacementIndex) !== staged) fail('COMPLETION_HANDOFF_TARGET_STAGED');
    await gitOk(root, ['update-index', '-z', '--index-info'], indexRecord, replacementIndex);
    if ((await gitOk(root, ['symbolic-ref', '-q', 'HEAD'])).trim() !== branch) fail('COMPLETION_HANDOFF_GIT_FAILED');
    await gitOk(root, ['update-ref', '--no-deref', branch, commit, parent]);
    try {
      // Copy into the locked file before same-filesystem atomic index promotion.
      await copyFile(replacementIndex, lockPath);
      await indexLock.sync();
      await rename(lockPath, realIndex);
      lockPath = undefined;
    } catch {
      await gitOk(root, ['update-ref', '--no-deref', branch, parent, commit]);
      fail('COMPLETION_HANDOFF_GIT_FAILED');
    }
    if (await committedAtHead(root, path, bytes) !== commit) fail('COMPLETION_HANDOFF_GIT_FAILED');
    return commit;
  } finally {
    await indexLock?.close();
    if (indexLock !== undefined && lockPath !== undefined) await unlink(lockPath);
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function preserveCompletionHandoff(options: {
  readonly knowledgeRoot: string; readonly projectId: string; readonly input: unknown; readonly commit?: boolean;
}): Promise<CompletionHandoffReceipt> {
  validateProjectId(options.projectId);
  const root = await resolveKnowledgeRoot(options.knowledgeRoot);
  // Nothing is persisted until all fields (not only source bodies) pass the sanitizer.
  const bundle = await prepare(options.input, root, options.projectId);
  const bytes = `${canonical(bundle)}\n`;
  if (Buffer.byteLength(bytes) > MAX_STORED_BYTES) fail('COMPLETION_HANDOFF_INPUT_LIMIT');
  return createRepositoryWriterLease().withLease(root, 'commit', async () => {
    const dir = await directory(root, options.projectId, true);
    if (dir === null) fail('COMPLETION_HANDOFF_UNSAFE_PATH');
    const target = join(dir, `${bundle.handoffId.slice(7)}.json`);
    let present = false;
    try { await lstat(target); present = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!present) {
      const temporary = join(dir, `.${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(bytes, 'utf8');
        await handle.sync();
        await directory(root, options.projectId, false);
        await link(temporary, target); // Atomic no-replace promotion.
      } finally { await handle.close(); await unlink(temporary); }
      await syncDirectory(dir);
    }
    const saved = await readCompletionHandoff({ knowledgeRoot: root, projectId: options.projectId, id: bundle.handoffId });
    if (canonical(saved) !== canonical(bundle)) fail('COMPLETION_HANDOFF_CORRUPT');
    const commit = options.commit === true ? await commitObject(root, bundle, bytes) : await committedAtHead(root, relativePath(options.projectId, bundle.handoffId), bytes);
    return receipt(bundle, commit);
  });
}

export async function listCompletionHandoffs(options: {
  readonly knowledgeRoot: string; readonly projectId: string; readonly workId?: string; readonly limit?: number;
}): Promise<readonly CompletionHandoffReceipt[]> {
  validateProjectId(options.projectId);
  if (options.workId !== undefined) workId(options.workId);
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail();
  const root = await resolveKnowledgeRoot(options.knowledgeRoot);
  const dir = await directory(root, options.projectId, false);
  if (dir === null) return [];
  const names = await readdir(dir);
  if (names.length > 10_000) fail('COMPLETION_HANDOFF_LIST_LIMIT');
  const matches: { handoffId: string; completedAt: string }[] = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) fail('COMPLETION_HANDOFF_UNSAFE_PATH');
    const bundle = await readCompletionHandoff({ ...options, id: `sha256:${name.slice(0, -5)}` });
    if (options.workId === undefined || bundle.workId === options.workId) matches.push({ handoffId: bundle.handoffId, completedAt: bundle.completedAt });
  }
  matches.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || a.handoffId.localeCompare(b.handoffId));
  const receipts: CompletionHandoffReceipt[] = [];
  for (const bundle of matches.slice(0, limit)) receipts.push(await verifyCompletionHandoff({ ...options, id: bundle.handoffId }));
  return receipts;
}
