import { join } from 'node:path';

import { KnowledgeError } from '../knowledge/errors.js';
import { serializeCanonicalJson, writeJsonAtomic } from '../knowledge/atomic-file.js';
import { validateKnowledgeBranch } from '../knowledge/git.js';
import { initializeModeAWorkspace } from '../knowledge/initialization.js';
import {
  bindLocalProject,
  ensureLocalProjectRegistryIgnored,
  initializeLocalProjectRegistry,
  inspectLocalProjectBindingCandidate,
  resolveLocalProjectBinding,
  type LocalProjectRegistryHooks,
} from '../knowledge/local-project-registry.js';
import { addProject, showProject } from '../knowledge/workspace.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import {
  validateDisplayName,
  validateRepositoryLocator,
} from '../knowledge/validation.js';
import {
  createBuiltInProfileBinding,
  parseProfileBinding,
} from '../profile/bindings.js';
import { readConfinedText } from '../profile/io.js';
import {
  initializeSourceManifest,
  inspectSourceManifestInitialization,
} from './source-management.js';

export const QUICKSTART_SCHEMA_VERSION = 'buildlore.quickstart.v1' as const;

export interface QuickstartInput {
  readonly branch?: string;
  readonly displayName?: string;
  readonly knowledgeRepository?: string;
  readonly projectId: string;
  readonly sourceRepository: string;
  readonly sourceRoot: string;
}

export interface QuickstartResultV1 {
  readonly binding: 'created' | 'existing' | 'replaced' | 'unchanged';
  readonly gitRepository: 'created' | 'existing';
  readonly knowledge: 'ready';
  readonly manifest: 'created' | 'existing';
  readonly project: 'created' | 'existing';
  readonly profileBinding: 'created' | 'existing';
  readonly projectId: string;
  readonly schemaVersion: typeof QUICKSTART_SCHEMA_VERSION;
  readonly sourceManifest: 'created' | 'existing';
}

export interface QuickstartOptions {
  readonly localProjectRegistryHooks?: LocalProjectRegistryHooks;
}

async function initializeGeneralProfileBinding(
  knowledgeRoot: string,
  projectId: string,
): Promise<'created' | 'existing'> {
  const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
  const path = join(workspace, 'profile-binding.json');
  const binding = createBuiltInProfileBinding('general');
  const source = await readConfinedText(workspace, path, projectId, {
    maximumBytes: 16 * 1024,
    optional: true,
  });
  if (source !== null) {
    try {
      const parsed = parseProfileBinding(JSON.parse(source) as unknown);
      if (source !== serializeCanonicalJson(parsed) ||
          serializeCanonicalJson(parsed) !== serializeCanonicalJson(binding)) {
        throw new KnowledgeError('MANIFEST_INVALID', 'Profile binding is incompatible.');
      }
      return 'existing';
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('MANIFEST_INVALID', 'Profile binding could not be read.');
    }
  }
  await writeJsonAtomic(path, binding, { confinementRoot: knowledgeRoot });
  return 'created';
}

export async function initializeSingleProjectQuickstart(
  hubRoot: string,
  input: QuickstartInput,
  options: QuickstartOptions = {},
): Promise<QuickstartResultV1> {
  if (input.branch !== undefined) validateKnowledgeBranch(input.branch);
  if (input.knowledgeRepository !== undefined) {
    validateRepositoryLocator(input.knowledgeRepository);
  }
  if (input.displayName !== undefined) validateDisplayName(input.displayName);
  const candidate = await inspectLocalProjectBindingCandidate(hubRoot, {
    allowReplacement: true,
    projectId: input.projectId,
    sourceRepository: input.sourceRepository,
    sourceRoot: input.sourceRoot,
  });
  await inspectSourceManifestInitialization(
    candidate.checkout,
    input.projectId,
    input.sourceRepository,
  );
  const modeA = await initializeModeAWorkspace(hubRoot, {
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.knowledgeRepository === undefined
      ? {}
      : { repository: input.knowledgeRepository }),
  });
  await ensureLocalProjectRegistryIgnored(hubRoot);
  await initializeLocalProjectRegistry(hubRoot);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  let projectOutcome: 'created' | 'existing' = 'created';
  let bindingOutcome: 'created' | 'existing' | 'replaced' | 'unchanged';
  try {
    const existing = await showProject(knowledgeRoot, input.projectId);
    if (existing.entry.sourceRepository !== input.sourceRepository) {
      throw new KnowledgeError('PROJECT_EXISTS', 'Existing project binding is incompatible.');
    }
    projectOutcome = 'existing';
    if (candidate.currentBindingDigest !== null) {
      if (candidate.currentBindingDigest !== candidate.proposedBindingDigest) {
        throw new KnowledgeError(
          'SOURCE_BINDING_CONFLICT',
          'Existing source binding requires an explicit replacement.',
        );
      }
      const currentBinding = await resolveLocalProjectBinding(
        hubRoot,
        input.projectId,
        input.sourceRepository,
      );
      if (currentBinding.bindingDigest !== candidate.proposedBindingDigest ||
          currentBinding.checkout.resolveRootForInternalUse() !==
            candidate.checkout.resolveRootForInternalUse()) {
        throw new KnowledgeError('SOURCE_BINDING_CONFLICT', 'Existing source binding changed.');
      }
      bindingOutcome = 'existing';
    } else {
      const binding = await bindLocalProject(hubRoot, {
        expectedBindingDigest: null,
        projectId: input.projectId,
        sourceRepository: input.sourceRepository,
        sourceRoot: input.sourceRoot,
      }, options.localProjectRegistryHooks);
      bindingOutcome = binding.outcome;
    }
  } catch (error) {
    if (!(error instanceof KnowledgeError) || error.code !== 'PROJECT_NOT_FOUND') throw error;
    let binding: Awaited<ReturnType<typeof bindLocalProject>> | undefined;
    await addProject(knowledgeRoot, {
      displayName: input.displayName ?? input.projectId,
      projectId: input.projectId,
      sourceRepository: input.sourceRepository,
    }, {
      afterRegistration: async () => {
        binding = await bindLocalProject(hubRoot, {
          expectedBindingDigest: candidate.currentBindingDigest,
          projectId: input.projectId,
          sourceRepository: input.sourceRepository,
          sourceRoot: input.sourceRoot,
        }, options.localProjectRegistryHooks);
      },
    });
    if (binding === undefined) {
      throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Quickstart binding did not complete.');
    }
    bindingOutcome = binding.outcome;
  }
  if (modeA.knowledge.state !== 'ready') {
    throw new KnowledgeError('SUBMODULE_MISMATCH', 'Quickstart knowledge state is not ready.');
  }
  const resolvedBinding = await resolveLocalProjectBinding(
    hubRoot,
    input.projectId,
    input.sourceRepository,
  );
  const sourceManifest = await initializeSourceManifest(
    resolvedBinding.checkout,
    input.projectId,
    input.sourceRepository,
  );
  const profileBinding = await initializeGeneralProfileBinding(knowledgeRoot, input.projectId);
  return Object.freeze({
    binding: bindingOutcome,
    gitRepository: modeA.gitRepository,
    knowledge: 'ready',
    manifest: modeA.manifest,
    project: projectOutcome,
    profileBinding,
    projectId: input.projectId,
    schemaVersion: QUICKSTART_SCHEMA_VERSION,
    sourceManifest: sourceManifest.outcome,
  });
}
