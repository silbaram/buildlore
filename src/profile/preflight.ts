import { join } from 'node:path';

import { PROJECT_SCHEMA_VERSION } from '../knowledge/types.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { showProject } from '../knowledge/workspace.js';
import { parseLifecycleProfile } from './codec.js';
import { ProfileOperationError } from './errors.js';
import { readConfinedText } from './io.js';
import { materializeLifecycleProfile, sha256 } from './materializer.js';
import type { ProfileBinding } from './types.js';

export interface ProfileBindingPreflight {
  resolve(projectId: string): Promise<ProfileBinding>;
}

export function createProfileBindingPreflight(knowledgeRoot: string): ProfileBindingPreflight {
  return {
    async resolve(projectId): Promise<ProfileBinding> {
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
    },
  };
}
