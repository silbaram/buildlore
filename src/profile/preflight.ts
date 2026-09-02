import { join } from 'node:path';

import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { PROJECT_SCHEMA_VERSION } from '../knowledge/types.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { showProject } from '../knowledge/workspace.js';
import {
  profileBindingForLegacyResolution,
  registerProfileBinding,
  type RegisteredProfileBindingV1,
} from './bindings.js';
import { parseLifecycleProfile } from './codec.js';
import { ProfileOperationError } from './errors.js';
import { readConfinedText } from './io.js';
import { materializeLifecycleProfile, sha256 } from './materializer.js';
import type { ProfileBinding } from './types.js';

export interface ProfileBindingPreflight {
  resolve(projectId: string): Promise<ProfileBinding>;
}

export interface ResolvedRegisteredProfileBindingV1 extends RegisteredProfileBindingV1 {
  readonly bindingDigest: `sha256:${string}`;
  readonly workspace: string;
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
): Promise<ResolvedRegisteredProfileBindingV1> {
  const legacy = await resolveLegacyBinding(knowledgeRoot, projectId);
  const source = await readConfinedText(
    legacy.workspace,
    join(legacy.workspace, 'profile-binding.json'),
    projectId,
    { maximumBytes: 16 * 1024, optional: true },
  );
  const expected = profileBindingForLegacyResolution(legacy);
  let registered: RegisteredProfileBindingV1;
  let canonical: string;
  if (source === null) {
    registered = registerProfileBinding(expected);
    canonical = serializeCanonicalJson(expected);
  } else {
    try {
      const decoded = JSON.parse(source) as unknown;
      registered = registerProfileBinding(decoded);
      canonical = serializeCanonicalJson(registered.binding);
    } catch {
      throw new ProfileOperationError('PROFILE_BINDING_INVALID', { projectId });
    }
    if (source !== canonical || canonical !== serializeCanonicalJson(expected)) {
      throw new ProfileOperationError('PROFILE_DRIFT', { projectId });
    }
  }
  return Object.freeze({
    ...registered,
    bindingDigest: sha256(canonical),
    workspace: legacy.workspace,
  });
}

export function createProfileBindingPreflight(knowledgeRoot: string): ProfileBindingPreflight {
  return {
    async resolve(projectId): Promise<ProfileBinding> {
      const registered = await resolveRegisteredProfileBinding(knowledgeRoot, projectId);
      return {
        mode: registered.binding.upstreamProfile,
        outputLanguage: registered.binding.outputLanguage,
        workspace: registered.workspace,
      };
    },
  };
}
