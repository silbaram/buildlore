import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWiki } from 'llm-wiki-compiler';

import { ProfileOperationError } from './errors.js';
import type { MaterializedProfile } from './types.js';

export interface LifecycleProfileSdkValidator {
  validate(materialized: MaterializedProfile, projectId: string): Promise<void>;
}

export function createLifecycleProfileSdkValidator(): LifecycleProfileSdkValidator {
  return {
    async validate(materialized, projectId): Promise<void> {
      const root = await mkdtemp(join(tmpdir(), 'buildlore-profile-validation-'));
      try {
        await Promise.all([
          mkdir(join(root, 'sources')),
          mkdir(join(root, 'wiki')),
          mkdir(join(root, '.llmwiki')),
        ]);
        await Promise.all([
          writeFile(join(root, '.llmwiki', 'profile.json'), materialized.profileJson, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          }),
          writeFile(join(root, '.llmwiki', 'config.json'), materialized.configJson, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          }),
        ]);
        const wiki = createWiki({ root });
        await wiki.status();
        await wiki.lint();
      } catch {
        throw new ProfileOperationError('PROFILE_UPSTREAM_INVALID', { projectId });
      } finally {
        await rm(root, { force: true, recursive: true }).catch(() => undefined);
      }
    },
  };
}
