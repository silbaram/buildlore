import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isNodeError, KnowledgeError } from './errors.js';
import { syncDirectory } from './atomic-file.js';
import { resolveKnowledgeRoot } from './paths.js';

export const KNOWLEDGE_GITIGNORE = `# BuildLore Mode A safe defaults
.env
.env.*
!.env.example
**/.env
**/.env.*
!**/.env.example
**/*[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]*
**/.llmwiki/embeddings/**
**/.llmwiki/*.lock
**/.llmwiki/**/*.lock
**/.llmwiki/journal/**
**/.llmwiki/**/*.journal
**/.llmwiki/**/*.tmp
**/.llmwiki/**/*.bak
**/*.tmp
**/*.bak
manifest.json.lock
.*.tmp
projects/.buildlore-workspace-*/
`;

export const LLWIKI_TRACKING_MATRIX = {
  ignoredByDefault: [
    '.env and credential material',
    '.llmwiki embedding caches',
    '.llmwiki locks and journals',
    'temporary and backup files',
  ],
  reviewBeforeStep10: [
    '.llmwiki/state.json',
    '.llmwiki/candidates/',
    '.llmwiki/workflows/',
    '.llmwiki/eval/',
  ],
  tracked: ['manifest.json', 'projects/*/project.json', 'projects/*/sources/*.md', 'projects/*/wiki/', 'projects/*/log.md'],
} as const;

function assertExistingIgnorePolicy(status: Awaited<ReturnType<typeof lstat>>): void {
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Knowledge .gitignore is unsafe.');
  }
}

export async function ensureKnowledgeIgnorePolicy(
  knowledgeRoot: string,
): Promise<'created' | 'existing'> {
  const root = await resolveKnowledgeRoot(knowledgeRoot);
  const path = join(root, '.gitignore');
  try {
    assertExistingIgnorePolicy(await lstat(path));
    return 'existing';
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      if (error instanceof KnowledgeError) {
        throw error;
      }
      throw new KnowledgeError('PATH_OUTSIDE_KNOWLEDGE', 'Unable to inspect knowledge .gitignore.', {
        cause: error,
      });
    }
  }
  try {
    await writeFile(path, KNOWLEDGE_GITIGNORE, {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
      mode: 0o600,
    });
    await syncDirectory(root);
    return 'created';
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      try {
        assertExistingIgnorePolicy(await lstat(path));
        return 'existing';
      } catch (inspectionError) {
        if (inspectionError instanceof KnowledgeError) {
          throw inspectionError;
        }
        throw new KnowledgeError(
          'PATH_OUTSIDE_KNOWLEDGE',
          'Unable to inspect concurrent knowledge .gitignore.',
          { cause: inspectionError },
        );
      }
    }
    throw new KnowledgeError('REGISTRY_WRITE_FAILED', 'Unable to create knowledge ignore policy.', {
      cause: error,
      recoveryCommand: ['project', 'validate'],
    });
  }
}
