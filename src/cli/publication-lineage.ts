import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { createLlmWikiCompilerBackend } from '../compiler/backend.js';
import { resolveConfiguredEmbeddingIdentity } from '../compiler/embedding-identity.js';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import {
  createGitPublicationInspector,
  type PublicationInspectionPort,
} from '../knowledge/publication-inspection.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { resolveProjectProfileBinding } from '../knowledge/validation.js';
import { showProject } from '../knowledge/workspace.js';
import {
  createProfileBindingPreflight,
  type ProfileBindingPreflight,
} from '../profile/preflight.js';
import { CliPublicationIdentityError } from './error-map.js';
import type { CliPublicationLineagePort } from './run-cli.js';

const MAX_EXPORTED_PAGES = 4_096;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SECRET_LABEL = /(?:^|[-_.])(?:api[-_]?key|auth|bearer|credential|password|secret|token)(?:$|[-_.])/iu;
const UNSAFE_LOCATION = /(?:https?:|file:|[\\/~]|\.\.)/iu;

interface PublicationExportPort {
  exportProject(workspaceRoot: string, projectId: string): Promise<unknown>;
}

export interface CliPublicationLineageResolverOptions {
  readonly compilerExport?: PublicationExportPort;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly inspector?: PublicationInspectionPort;
  readonly profilePreflight?: ProfileBindingPreflight;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function safeIdentity(value: unknown): string | null {
  return typeof value === 'string' && SAFE_IDENTITY.test(value) && !SECRET_LABEL.test(value) &&
    !UNSAFE_LOCATION.test(value)
    ? value
    : null;
}

function stampedIdentityDigests(
  raw: unknown,
  projectId: string,
): Readonly<{
  modelCompatibilityDigest: `sha256:${string}`;
  promptDigest: `sha256:${string}`;
}> {
  const document = record(raw);
  if (document === null || document.schemaVersion !== 1 || document.projectId !== projectId ||
      !Array.isArray(document.pages) || document.pages.length === 0 ||
      document.pages.length > MAX_EXPORTED_PAGES || document.pageCount !== document.pages.length ||
      (document.warnings !== undefined &&
        (!Array.isArray(document.warnings) || document.warnings.length !== 0))) {
    throw new CliPublicationIdentityError();
  }
  const models = new Set<string>();
  const prompts = new Set<string>();
  for (const rawPage of document.pages) {
    const page = record(rawPage);
    const model = page === null ? null : safeIdentity(page.modelId);
    const prompt = page === null ? null : safeIdentity(page.promptVersion);
    if (model === null || prompt === null) throw new CliPublicationIdentityError();
    models.add(model);
    prompts.add(prompt);
  }
  if (models.size === 0 || prompts.size === 0) throw new CliPublicationIdentityError();
  return Object.freeze({
    modelCompatibilityDigest: sha256(serializeCanonicalJson({
      identities: [...models].sort(),
      kind: 'compile-time-model-set',
      schemaVersion: 1,
    })),
    promptDigest: sha256(serializeCanonicalJson({
      identities: [...prompts].sort(),
      kind: 'compile-time-prompt-set',
      schemaVersion: 1,
    })),
  });
}

export function createCliPublicationLineageResolver(
  parentRoot: string,
  options: CliPublicationLineageResolverOptions = {},
): CliPublicationLineagePort {
  const knowledgeRoot = join(parentRoot, 'knowledge');
  const compilerExport = options.compilerExport ?? createLlmWikiCompilerBackend();
  const environment = options.environment ?? process.env;
  const inspector = options.inspector ?? createGitPublicationInspector();
  const profilePreflight = options.profilePreflight ?? createProfileBindingPreflight(knowledgeRoot);
  return {
    async resolve(projectId) {
      try {
        const [parent, recordValue, profile] = await Promise.all([
          inspector.inspectRepository(parentRoot),
          showProject(knowledgeRoot, projectId),
          profilePreflight.resolve(projectId),
        ]);
        const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, {
          mustExist: true,
        });
        if (profile.workspace !== workspace) throw new CliPublicationIdentityError();
        const embedding = resolveConfiguredEmbeddingIdentity(environment);
        if (embedding === null) throw new CliPublicationIdentityError();
        const stamps = stampedIdentityDigests(
          await compilerExport.exportProject(workspace, projectId),
          projectId,
        );
        return Object.freeze({
          codeRevision: parent.baseRevision,
          embeddingCompatibilityDigest: embedding.compatibilityDigest,
          modelCompatibilityDigest: stamps.modelCompatibilityDigest,
          profileDigest: sha256(serializeCanonicalJson(
            resolveProjectProfileBinding(recordValue.descriptor),
          )),
          promptDigest: stamps.promptDigest,
        });
      } catch (error) {
        if (error instanceof CliPublicationIdentityError) throw error;
        throw new CliPublicationIdentityError();
      }
    },
  };
}
