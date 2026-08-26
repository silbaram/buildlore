import { createHash } from 'node:crypto';
import { constants as fsConstants, type Dirent } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { TextDecoder } from 'node:util';

import { consumePreparedSource } from '../sanitizer/approval.js';
import {
  createProjectSecurityService,
  permitsEgress,
  readSecurityPolicy,
  SANITIZER_RULES_VERSION,
  type DataClassification,
  type SecuritySourceKind,
} from '../sanitizer/index.js';
import { parseSourceDocument, renderSourceDocument } from '../projector/source-document.js';
import {
  validateCollectionSourceIdentityBinding,
  validateP2aSourceIdentity,
} from '../projector/source-identity.js';
import { showProject } from '../knowledge/index.js';
import type { CompilerRequest, EgressCapability } from './types.js';

const MAX_PROVIDER_INPUT_FILES = 4_096;
const MAX_PROVIDER_INPUT_ENTRIES = 8_192;
const MAX_PROVIDER_INPUT_FILE_BYTES = 512 * 1024;
const MAX_PROVIDER_INPUT_TOTAL_BYTES = 32 * 1024 * 1024;
const PROVIDER_INPUT_MANIFEST_SCHEMA_VERSION = 'buildlore.provider-input-manifest.v1' as const;
const SAFE_GENERATED_EXTENSIONS = new Set(['.json', '.jsonl', '.md', '.yaml', '.yml']);
interface CompilerSecurityPermitBinding {
  capability: EgressCapability;
  manifestDigest: `sha256:${string}`;
  manifestSchemaVersion: typeof PROVIDER_INPUT_MANIFEST_SCHEMA_VERSION;
  policyDigest: `sha256:${string}`;
  projectId: string;
  rulesVersion: string;
}

const issuedPermits = new WeakMap<object, Readonly<CompilerSecurityPermitBinding & {
  consumed: boolean;
}>>();

interface ProviderInput {
  readonly body: string;
  readonly contentDigest: `sha256:${string}`;
  readonly scanBody: string;
  readonly scanDigest: `sha256:${string}`;
  readonly source: string;
  readonly sourceKind: SecuritySourceKind;
  readonly sourceRevisionOrContentSha256: `sha256:${string}`;
}

interface ProviderInputManifest {
  readonly capability: EgressCapability;
  readonly classifications: readonly DataClassification[];
  readonly digest: `sha256:${string}`;
  readonly manifestSchemaVersion: typeof PROVIDER_INPUT_MANIFEST_SCHEMA_VERSION;
  readonly policyDigest: `sha256:${string}`;
  readonly projectId: string;
  readonly rulesVersion: typeof SANITIZER_RULES_VERSION;
}

export interface CompilerSecurityPermit {
  readonly opaque: true;
}

/** Internal issuance seam; verification always rechecks the current manifest and rules version. */
export function issueCompilerSecurityPermit(
  binding: CompilerSecurityPermitBinding,
): CompilerSecurityPermit {
  const permit = Object.freeze({ opaque: true as const });
  issuedPermits.set(permit, { ...binding, consumed: false });
  return permit;
}

function denied(): never {
  throw new Error('Compiler egress security preflight failed.');
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isContained(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function readBoundedDirectory(path: string, maximum: number): Promise<readonly Dirent[]> {
  const entries: Dirent[] = [];
  let directory;
  try {
    directory = await opendir(path);
    for await (const entry of directory) {
      if (entries.length >= maximum) return denied();
      entries.push(entry);
    }
  } catch {
    return denied();
  } finally {
    await directory?.close().catch(() => undefined);
  }
  return entries;
}

async function readRegularUtf8(path: string, workspace: string): Promise<string> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    const canonical = await realpath(path);
    if (canonical !== path || !isContained(workspace, canonical)) return denied();
    status = await lstat(path);
  } catch {
    return denied();
  }
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_PROVIDER_INPUT_FILE_BYTES) {
    return denied();
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== status.dev || actual.ino !== status.ino ||
        actual.size > MAX_PROVIDER_INPUT_FILE_BYTES) return denied();
    const canonical = await realpath(path);
    if (canonical !== path || !isContained(workspace, canonical)) return denied();
    const bytes = await handle.readFile();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return denied();
    }
  } catch {
    return denied();
  } finally {
    await handle?.close();
  }
}

async function listFlatSources(workspace: string): Promise<readonly string[]> {
  const root = join(workspace, 'sources');
  let entries;
  try {
    const status = await lstat(root);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(root) !== root) return denied();
    entries = await readBoundedDirectory(root, MAX_PROVIDER_INPUT_FILES);
  } catch {
    return denied();
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || extname(entry.name) !== '.md') return denied();
    files.push(join(root, entry.name));
  }
  return files.sort();
}

async function listGeneratedFiles(workspace: string, directory: '.llmwiki' | 'wiki'): Promise<readonly string[]> {
  const root = join(workspace, directory);
  try {
    const status = await lstat(root);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(root) !== root) {
      return denied();
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    return denied();
  }
  const files: string[] = [];
  const pending = [root];
  let visitedEntries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    let entries;
    try {
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink() ||
          await realpath(current) !== current || !isContained(workspace, current)) return denied();
      entries = await readBoundedDirectory(
        current,
        MAX_PROVIDER_INPUT_ENTRIES - visitedEntries,
      );
    } catch {
      return denied();
    }
    visitedEntries += entries.length;
    if (visitedEntries > MAX_PROVIDER_INPUT_ENTRIES) return denied();
    for (const entry of [...entries].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      if (entry.isSymbolicLink()) return denied();
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && SAFE_GENERATED_EXTENSIONS.has(extname(entry.name))) files.push(path);
      else if (!entry.isFile()) return denied();
      if (files.length > MAX_PROVIDER_INPUT_FILES) return denied();
    }
  }
  return files.sort();
}

function requestText(request: CompilerRequest & { readonly capability: EgressCapability }): string | null {
  switch (request.capability) {
    case 'context':
      return request.prompt;
    case 'query':
    case 'search':
      return request.question;
    case 'compile':
    case 'eval-full':
      return null;
  }
}

async function providerInputs(
  workspace: string,
  repository: string,
  request: CompilerRequest & { readonly capability: EgressCapability },
): Promise<readonly ProviderInput[]> {
  const sourcePaths = await listFlatSources(workspace);
  const generatedPaths = [
    ...(await listGeneratedFiles(workspace, 'wiki')),
    ...(await listGeneratedFiles(workspace, '.llmwiki')),
  ];
  const paths = [...sourcePaths, ...generatedPaths];
  if (paths.length > MAX_PROVIDER_INPUT_FILES) return denied();
  const inputs: ProviderInput[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const body = await readRegularUtf8(path, workspace);
    totalBytes += Buffer.byteLength(body, 'utf8');
    if (totalBytes > MAX_PROVIDER_INPUT_TOTAL_BYTES) return denied();
    if (path.startsWith(join(workspace, 'sources'))) {
      let document;
      try {
        document = parseSourceDocument(body);
        if (renderSourceDocument(document) !== body) return denied();
      } catch {
        return denied();
      }
      const sourceKind = document.buildlore.sourceKind;
      if ((sourceKind !== 'markdown' && sourceKind !== 'planning' && sourceKind !== 'execution') ||
          document.buildlore.projectId !== request.projectId ||
          basename(path) !== `${sourceKind}--${sha256(document.source).slice('sha256:'.length)}.md`) {
        return denied();
      }
      const sourceIdentity = document.buildlore.producer === 'buildlore' && sourceKind === 'markdown'
        ? validateCollectionSourceIdentityBinding({
            documentKind: 'markdown',
            projectId: request.projectId,
            repository,
          }, document.source)
        : document.buildlore.producer === 'p2a' &&
            (sourceKind === 'planning' || sourceKind === 'execution')
          ? validateP2aSourceIdentity({
              projectId: request.projectId,
              repository,
              source: document.source,
              sourceKind,
            })
          : null;
      if (sourceIdentity === null) return denied();
      const scanBody = [document.title, document.body].join('\n');
      inputs.push({
        body,
        contentDigest: sha256(body),
        scanBody,
        scanDigest: sha256(scanBody),
        source: document.source,
        sourceKind,
        sourceRevisionOrContentSha256: document.buildlore.sourceRevision,
      });
      continue;
    }
    const kind: SecuritySourceKind = path.startsWith(join(workspace, 'wiki'))
      ? 'wiki'
      : 'compiler-cache';
    const pathIdentity = sha256(relative(workspace, path)).slice('sha256:'.length);
    const contentDigest = sha256(body);
    inputs.push({
      body,
      contentDigest,
      scanBody: body,
      scanDigest: contentDigest,
      source: `buildlore://${kind}/${pathIdentity}`,
      sourceKind: kind,
      sourceRevisionOrContentSha256: contentDigest,
    });
  }
  const text = requestText(request);
  if (text !== null) {
    const contentDigest = sha256(text);
    inputs.push({
      body: text,
      contentDigest,
      scanBody: text,
      scanDigest: contentDigest,
      source: `buildlore://provider-request/${request.capability}`,
      sourceKind: 'provider-request',
      sourceRevisionOrContentSha256: contentDigest,
    });
  }
  return inputs;
}

async function buildManifest(
  knowledgeRoot: string,
  workspace: string,
  request: CompilerRequest & { readonly capability: EgressCapability },
): Promise<ProviderInputManifest> {
  const loaded = await readSecurityPolicy(knowledgeRoot, request.projectId);
  if (loaded.workspace !== workspace) return denied();
  const project = await showProject(knowledgeRoot, request.projectId);
  const service = createProjectSecurityService({ knowledgeRoot });
  const inputs = await providerInputs(workspace, project.descriptor.sourceRepository, request);
  const classifications = new Set<DataClassification>();
  const bindings: string[] = [];
  for (const input of inputs) {
    const result = await service.prepareSource({
      body: input.scanBody,
      bodyDigest: input.scanDigest,
      projectId: request.projectId,
      source: input.source,
      sourceKind: input.sourceKind,
      sourceRevisionOrContentSha256: input.sourceRevisionOrContentSha256,
    });
    if (!result.ok || result.report.inputDigest !== input.scanDigest ||
        result.report.outputDigest !== input.scanDigest ||
        result.report.policyDigest !== loaded.digest ||
        result.report.projectId !== request.projectId ||
        result.report.rulesVersion !== SANITIZER_RULES_VERSION) return denied();
    const prepared = consumePreparedSource(result.prepared);
    if (prepared === null || prepared.approvedBody !== input.scanBody ||
        prepared.approvedBodyDigest !== input.scanDigest ||
        prepared.classification !== result.report.classification ||
        prepared.inputBodyDigest !== input.scanDigest ||
        prepared.policyDigest !== loaded.digest ||
        prepared.projectId !== request.projectId ||
        prepared.rulesVersion !== SANITIZER_RULES_VERSION ||
        prepared.source !== input.source || prepared.sourceKind !== input.sourceKind ||
        prepared.sourceRevisionOrContentSha256 !== input.sourceRevisionOrContentSha256 ||
        prepared.untrustedData !== result.report.summaries.some((summary) =>
          summary.action === 'quarantine' && summary.count > 0)) return denied();
    classifications.add(result.report.classification);
    bindings.push([
      result.report.sourceIdentitySha256,
      input.contentDigest,
      result.report.classification,
      prepared.untrustedData ? 'untrusted-data' : 'ordinary-data',
    ].join(':'));
  }
  if (classifications.size === 0) classifications.add(loaded.policy.defaultClassification);
  if (!permitsEgress(loaded.policy, request.capability, classifications)) return denied();
  const orderedClassifications = [...classifications].sort();
  const manifestSchemaVersion = PROVIDER_INPUT_MANIFEST_SCHEMA_VERSION;
  const rulesVersion = SANITIZER_RULES_VERSION;
  return {
    capability: request.capability,
    classifications: orderedClassifications,
    digest: sha256(JSON.stringify({
      bindings: bindings.sort(),
      capability: request.capability,
      classifications: orderedClassifications,
      manifestSchemaVersion,
      policyDigest: loaded.digest,
      projectId: request.projectId,
      rulesVersion,
    })),
    manifestSchemaVersion,
    policyDigest: loaded.digest,
    projectId: request.projectId,
    rulesVersion,
  };
}

export async function prepareCompilerEgress(
  knowledgeRoot: string,
  workspace: string,
  request: CompilerRequest & { readonly capability: EgressCapability },
): Promise<CompilerSecurityPermit> {
  const stableRequest = Object.freeze({ ...request });
  const manifest = await buildManifest(knowledgeRoot, workspace, stableRequest);
  return issueCompilerSecurityPermit({
    capability: manifest.capability,
    manifestDigest: manifest.digest,
    manifestSchemaVersion: manifest.manifestSchemaVersion,
    policyDigest: manifest.policyDigest,
    projectId: manifest.projectId,
    rulesVersion: manifest.rulesVersion,
  });
}

export async function verifyAndConsumeCompilerEgress(
  permit: CompilerSecurityPermit,
  knowledgeRoot: string,
  workspace: string,
  request: CompilerRequest & { readonly capability: EgressCapability },
): Promise<void> {
  const stableRequest = Object.freeze({ ...request });
  const binding = issuedPermits.get(permit);
  if (binding === undefined || binding.consumed || binding.projectId !== stableRequest.projectId ||
      binding.capability !== stableRequest.capability ||
      binding.manifestSchemaVersion !== PROVIDER_INPUT_MANIFEST_SCHEMA_VERSION ||
      binding.rulesVersion !== SANITIZER_RULES_VERSION) return denied();
  issuedPermits.set(permit, { ...binding, consumed: true });
  const current = await buildManifest(knowledgeRoot, workspace, stableRequest);
  if (current.digest !== binding.manifestDigest || current.policyDigest !== binding.policyDigest ||
      current.manifestSchemaVersion !== binding.manifestSchemaVersion ||
      current.rulesVersion !== binding.rulesVersion) {
    return denied();
  }
}
