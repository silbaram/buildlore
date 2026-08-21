import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import {
  serializeCanonicalJson,
  writeJsonAtomic,
  type AtomicWriteHooks,
} from '../knowledge/atomic-file.js';
import { isNodeError, KnowledgeError } from '../knowledge/errors.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { decodeUtf8Strict, parseJsonStrict } from '../knowledge/strict-json.js';

export const EMBEDDING_MARKER_SCHEMA_VERSION =
  'buildlore.embedding-index-identity.v1' as const;
export const EMBEDDING_MARKER_FILENAME = 'buildlore-embedding-identity.json' as const;

export interface EmbeddingIdentity {
  readonly compatibilityDigest: `sha256:${string}`;
  readonly compilerVersion: '1.1.0';
  readonly dimensions?: number;
  readonly modelId: string;
  readonly modelRevision?: string;
  readonly providerId: 'ollama' | 'openai' | 'voyage';
}

export interface EmbeddingCompatibilityInspection {
  readonly currentIdentity: EmbeddingIdentity;
  readonly reasonCode: 'embedding-identity-mismatch' | 'embedding-marker-invalid' |
    'embedding-marker-missing' | null;
  readonly rebuildRequired: boolean;
  readonly state: 'compatible' | 'missing' | 'outdated';
}

export interface ProjectEmbeddingCompatibilityPort {
  inspect(
    projectId: string,
    currentIdentity: EmbeddingIdentity,
  ): Promise<EmbeddingCompatibilityInspection>;
}

export interface ProjectEmbeddingIdentityPort extends ProjectEmbeddingCompatibilityPort {
  record(projectId: string, identity: EmbeddingIdentity): Promise<void>;
}

export interface EmbeddingIdentityOverrides {
  readonly dimensions?: number;
  readonly modelRevision?: string;
}

interface EmbeddingMarker {
  readonly embeddingIdentity: EmbeddingIdentity;
  readonly projectId: string;
  readonly schemaVersion: typeof EMBEDDING_MARKER_SCHEMA_VERSION;
}

const MAX_MARKER_BYTES = 64 * 1024;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SAFE_MODEL_REVISION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const SAFE_PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SECRET_LABEL = /(?:^|[-_.])(?:api[-_]?key|auth|bearer|credential|password|secret|token)(?:$|[-_.])/iu;
const KNOWN_CREDENTIAL = /(?:\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,255}\b|\bgithub_pat_[A-Za-z0-9_]{20,255}\b|\bnpm_[A-Za-z0-9]{20,255}\b|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,255}\b|\bAIza[A-Za-z0-9_-]{32,64}\b|\bxox[baprs]-[A-Za-z0-9-]{10,255}\b)/u;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

function identityWithoutDigest(
  providerId: EmbeddingIdentity['providerId'],
  modelId: string,
  overrides: EmbeddingIdentityOverrides,
): Omit<EmbeddingIdentity, 'compatibilityDigest'> {
  return {
    compilerVersion: '1.1.0',
    ...(overrides.dimensions === undefined ? {} : { dimensions: overrides.dimensions }),
    modelId,
    ...(overrides.modelRevision === undefined ? {} : { modelRevision: overrides.modelRevision }),
    providerId,
  };
}

function safeIdentityValue(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !SECRET_LABEL.test(value) && !KNOWN_CREDENTIAL.test(value) &&
    !value.includes('..') &&
    !/^https?:/iu.test(value) && !/^file:/iu.test(value) && !/^[a-zA-Z]:/u.test(value) &&
    !value.startsWith('/') && !value.startsWith('~') && !value.includes('\\');
}

function createIdentity(
  providerId: EmbeddingIdentity['providerId'],
  modelId: string,
  overrides: EmbeddingIdentityOverrides,
): EmbeddingIdentity | null {
  if (!safeIdentityValue(modelId, SAFE_MODEL_ID) ||
      (overrides.modelRevision !== undefined &&
        !safeIdentityValue(overrides.modelRevision, SAFE_MODEL_REVISION)) ||
      (overrides.dimensions !== undefined && (!Number.isSafeInteger(overrides.dimensions) ||
        overrides.dimensions <= 0 || overrides.dimensions > 65_536))) return null;
  const base = identityWithoutDigest(providerId, modelId, overrides);
  return Object.freeze({
    ...base,
    compatibilityDigest: sha256(serializeCanonicalJson(base)),
  });
}

export function resolveConfiguredEmbeddingIdentity(
  environment: Readonly<NodeJS.ProcessEnv>,
  overrides: EmbeddingIdentityOverrides = {},
): EmbeddingIdentity | null {
  const provider = environment.LLMWIKI_PROVIDER ?? 'anthropic';
  switch (provider) {
    case 'anthropic':
    case 'claude-agent':
      return createIdentity('voyage', 'voyage-3-lite', overrides);
    case 'openai':
      return createIdentity(
        'openai',
        environment.LLMWIKI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
        overrides,
      );
    case 'ollama':
      return createIdentity(
        'ollama',
        environment.LLMWIKI_EMBEDDING_MODEL ?? 'nomic-embed-text',
        overrides,
      );
    default:
      return null;
  }
}

export function parseEmbeddingIdentity(value: unknown): EmbeddingIdentity | null {
  if (!isRecord(value)) return null;
  const optional = [
    ...(value.dimensions === undefined ? [] : ['dimensions']),
    ...(value.modelRevision === undefined ? [] : ['modelRevision']),
  ];
  if (!exactKeys(value, [
    'compatibilityDigest',
    'compilerVersion',
    'modelId',
    'providerId',
    ...optional,
  ])) return null;
  if (value.compilerVersion !== '1.1.0' ||
      (value.providerId !== 'voyage' && value.providerId !== 'openai' &&
        value.providerId !== 'ollama') ||
      typeof value.modelId !== 'string' || !safeIdentityValue(value.modelId, SAFE_MODEL_ID) ||
      typeof value.compatibilityDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.compatibilityDigest) ||
      (value.modelRevision !== undefined &&
        (typeof value.modelRevision !== 'string' ||
          !safeIdentityValue(value.modelRevision, SAFE_MODEL_REVISION))) ||
      (value.dimensions !== undefined &&
        (typeof value.dimensions !== 'number' || !Number.isSafeInteger(value.dimensions) ||
          value.dimensions <= 0 || value.dimensions > 65_536))) return null;
  const candidate = value as unknown as EmbeddingIdentity;
  const base = identityWithoutDigest(candidate.providerId, candidate.modelId, {
    ...(candidate.dimensions === undefined ? {} : { dimensions: candidate.dimensions }),
    ...(candidate.modelRevision === undefined ? {} : { modelRevision: candidate.modelRevision }),
  });
  if (candidate.compatibilityDigest !== sha256(serializeCanonicalJson(base))) return null;
  return Object.freeze({ ...candidate });
}

function parseMarker(raw: string): EmbeddingMarker | null {
  let value: unknown;
  try {
    value = parseJsonStrict(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !exactKeys(value, [
    'embeddingIdentity',
    'projectId',
    'schemaVersion',
  ]) || value.schemaVersion !== EMBEDDING_MARKER_SCHEMA_VERSION ||
      typeof value.projectId !== 'string' || value.projectId.length > 64 ||
      !SAFE_PROJECT_ID.test(value.projectId)) return null;
  const embeddingIdentity = parseEmbeddingIdentity(value.embeddingIdentity);
  if (embeddingIdentity === null) return null;
  const marker: EmbeddingMarker = {
    embeddingIdentity,
    projectId: value.projectId,
    schemaVersion: EMBEDDING_MARKER_SCHEMA_VERSION,
  };
  return raw === serializeCanonicalJson(marker) ? marker : null;
}

async function readMarker(workspace: string): Promise<EmbeddingMarker | 'invalid' | 'missing'> {
  const path = join(workspace, '.llmwiki', EMBEDDING_MARKER_FILENAME);
  let expected: Awaited<ReturnType<typeof lstat>>;
  try {
    expected = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return 'missing';
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Embedding marker is unreadable.');
  }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > MAX_MARKER_BYTES) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Embedding marker is unsafe.');
  }
  let actualPath: string;
  try {
    actualPath = await realpath(path);
  } catch {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Embedding marker is unsafe.');
  }
  if (!isContained(workspace, actualPath)) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Embedding marker escapes the project.');
  }
  let handle;
  try {
    handle = await open(path, 'r');
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
        actual.size > MAX_MARKER_BYTES) {
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Embedding marker changed during read.');
    }
    return parseMarker(decodeUtf8Strict(await handle.readFile())) ?? 'invalid';
  } finally {
    await handle?.close();
  }
}

export function createProjectEmbeddingIdentityStore(
  knowledgeRoot: string,
  options: {
    readonly writeHooks?: Omit<AtomicWriteHooks, 'confinementRoot'>;
  } = {},
): ProjectEmbeddingIdentityPort {
  return {
    async inspect(projectId, currentIdentity) {
      const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
      const marker = await readMarker(workspace);
      if (marker === 'missing') {
        return {
          currentIdentity,
          reasonCode: 'embedding-marker-missing',
          rebuildRequired: true,
          state: 'missing',
        };
      }
      if (marker === 'invalid') {
        return {
          currentIdentity,
          reasonCode: 'embedding-marker-invalid',
          rebuildRequired: true,
          state: 'outdated',
        };
      }
      if (marker.projectId !== projectId) {
        throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Embedding marker is unsafe.');
      }
      if (marker.embeddingIdentity.compatibilityDigest !== currentIdentity.compatibilityDigest) {
        return {
          currentIdentity,
          reasonCode: 'embedding-identity-mismatch',
          rebuildRequired: true,
          state: 'outdated',
        };
      }
      return {
        currentIdentity,
        reasonCode: null,
        rebuildRequired: false,
        state: 'compatible',
      };
    },
    async record(projectId, identity) {
      const validatedIdentity = parseEmbeddingIdentity(identity);
      if (validatedIdentity === null) {
        throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Embedding identity is invalid.');
      }
      const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
      const directory = join(workspace, '.llmwiki');
      let directoryStatus: Awaited<ReturnType<typeof lstat>>;
      try {
        directoryStatus = await lstat(directory);
      } catch {
        throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Compiler state directory is missing.');
      }
      if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
        throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Compiler state directory is unsafe.');
      }
      await writeJsonAtomic(join(directory, EMBEDDING_MARKER_FILENAME), {
        embeddingIdentity: validatedIdentity,
        projectId,
        schemaVersion: EMBEDDING_MARKER_SCHEMA_VERSION,
      }, {
        ...options.writeHooks,
        confinementRoot: workspace,
      });
      const recorded = await readMarker(workspace);
      if (recorded === 'missing' || recorded === 'invalid' || recorded.projectId !== projectId ||
          recorded.embeddingIdentity.compatibilityDigest !==
            validatedIdentity.compatibilityDigest) {
        throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Embedding identity could not be verified.');
      }
    },
  };
}
