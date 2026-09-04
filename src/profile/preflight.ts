import { join } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { PROJECT_SCHEMA_VERSION } from '../knowledge/types.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { showProject } from '../knowledge/workspace.js';
import {
  PROFILE_BINDING_V2_SCHEMA_VERSION,
  profileBindingForLegacyResolution,
  registerProfileBinding,
  type RegisteredProfileBinding,
} from './bindings.js';
import type { SourceAdapterDefinitionV1 } from '../projector/source-adapter-registry.js';
import { parseLifecycleProfile } from './codec.js';
import { ProfileOperationError } from './errors.js';
import { readConfinedText } from './io.js';
import { materializeLifecycleProfile, sha256 } from './materializer.js';
import type { ProfileBinding } from './types.js';

export interface ProfileBindingPreflight {
  resolve(projectId: string): Promise<ProfileBinding>;
}

export type ResolvedRegisteredProfileBinding = RegisteredProfileBinding & Readonly<{
  readonly bindingDigest: `sha256:${string}`;
  readonly workspace: string;
}>;

export type ResolvedRegisteredProfileBindingV1 = ResolvedRegisteredProfileBinding;

export interface ResolveRegisteredProfileBindingOptions {
  readonly registrations?: readonly SourceAdapterDefinitionV1[];
}

async function resolveLegacyBinding(
  knowledgeRoot: string,
  projectId: string,
): Promise<ProfileBinding> {
  const record = await showProject(knowledgeRoot, projectId);
  const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
  const source = await readConfinedText(
    workspace,
    join(workspace, 'profile.json'),
    projectId,
    { optional: true },
  );
  const profileBytes = await readConfinedText(
    workspace,
    join(workspace, '.llmwiki', 'profile.json'),
    projectId,
    { optional: true },
  );
  const configBytes = await readConfinedText(
    workspace,
    join(workspace, '.llmwiki', 'config.json'),
    projectId,
    { optional: true },
  );
  if (record.descriptor.schemaVersion === PROJECT_SCHEMA_VERSION) {
    if (source !== null || profileBytes !== null) {
      throw new ProfileOperationError('PROFILE_DRIFT', { projectId });
    }
    return { mode: 'default', outputLanguage: 'en', workspace };
  }
  if (source === null || profileBytes === null) {
    throw new ProfileOperationError('PROFILE_DRIFT', { projectId });
  }
  const profile = parseLifecycleProfile(source);
  const materialized = materializeLifecycleProfile(profile);
  if (configBytes === null || record.descriptor.profileHash !== sha256(source) ||
      record.descriptor.profileHash !== materialized.sourceHash ||
      record.descriptor.outputLanguage !== profile.outputLanguage ||
      profileBytes !== materialized.profileJson || configBytes !== materialized.configJson) {
    throw new ProfileOperationError('PROFILE_DRIFT', { projectId });
  }
  return { mode: 'custom', outputLanguage: profile.outputLanguage, workspace };
}

export async function resolveRegisteredProfileBinding(
  knowledgeRoot: string,
  projectId: string,
  options: ResolveRegisteredProfileBindingOptions = {},
): Promise<ResolvedRegisteredProfileBinding> {
  const legacy = await resolveLegacyBinding(knowledgeRoot, projectId);
  const source = await readConfinedText(
    legacy.workspace,
    join(legacy.workspace, 'profile-binding.json'),
    projectId,
    { maximumBytes: 16 * 1024, optional: true },
  );
  const expected = profileBindingForLegacyResolution(legacy);
  let registered: RegisteredProfileBinding;
  let canonical: string;
  if (source === null) {
    registered = registerProfileBinding(expected);
    canonical = serializeCanonicalJson(expected);
  } else {
    try {
      const decoded = JSON.parse(source) as unknown;
      registered = registerProfileBinding(decoded, options);
      canonical = serializeCanonicalJson(registered.binding);
    } catch {
      throw new ProfileOperationError('PROFILE_BINDING_INVALID', { projectId });
    }
    const baseMatches = registered.binding.profileId === expected.profileId &&
      registered.binding.outputLanguage === expected.outputLanguage &&
      registered.binding.upstreamProfile === expected.upstreamProfile &&
      expected.adapters.every((adapter) => registered.binding.adapters.some((entry) =>
        entry.adapterId === adapter.adapterId && entry.adapterVersion === adapter.adapterVersion));
    if (source !== canonical || !baseMatches ||
        (registered.binding.schemaVersion !== PROFILE_BINDING_V2_SCHEMA_VERSION &&
          canonical !== serializeCanonicalJson(expected))) {
      throw new ProfileOperationError('PROFILE_DRIFT', { projectId });
    }
  }
  return Object.freeze({
    ...registered,
    bindingDigest: sha256(canonical),
    workspace: legacy.workspace,
  });
}

export function createProfileBindingPreflight(
  knowledgeRoot: string,
  options: ResolveRegisteredProfileBindingOptions = {},
): ProfileBindingPreflight {
  return {
    async resolve(projectId): Promise<ProfileBinding> {
      const registered = await resolveRegisteredProfileBinding(knowledgeRoot, projectId, options);
      return {
        mode: registered.binding.upstreamProfile,
        outputLanguage: registered.binding.outputLanguage,
        workspace: registered.workspace,
      };
    },
  };
}
