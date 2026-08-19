import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addProject,
  getProjectKnowledgeStatus,
  KNOWLEDGE_GITIGNORE,
  type CompilerStatusPort,
} from '../src/knowledge/index.js';

const temporaryRoots: string[] = [];

function gitCheckIgnore(cwd: string, paths: readonly string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['check-ignore', '--no-index', '--', ...paths],
      { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(new Error('git check-ignore could not run', { cause: error }));
          return;
        }
        resolve(stdout.trim().split(/\r?\n/u).filter(Boolean));
      },
    );
  });
}

async function createKnowledgeRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-knowledge-isolation-'));
  temporaryRoots.push(root);
  const knowledge = join(root, 'knowledge');
  await mkdir(knowledge);
  return knowledge;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('project isolation and tracking policy', () => {
  it('passes exactly one selected workspace to the compiler and preserves its sibling', async () => {
    const knowledge = await createKnowledgeRoot();
    for (const projectId of ['alpha', 'beta']) {
      await addProject(knowledge, {
        displayName: projectId,
        projectId,
        sourceRepository: `https://example.test/${projectId}.git`,
      });
    }
    const betaSource = join(knowledge, 'projects', 'beta', 'sources', 'decision--beta.md');
    const betaWiki = join(knowledge, 'projects', 'beta', 'wiki', 'beta.md');
    const betaState = join(knowledge, 'projects', 'beta', '.llmwiki', 'state.json');
    const betaLog = join(knowledge, 'projects', 'beta', 'log.md');
    await writeFile(betaSource, 'beta sentinel\n', 'utf8');
    await writeFile(betaWiki, 'beta wiki sentinel\n', 'utf8');
    await writeFile(betaState, '{"beta":"sentinel"}\n', 'utf8');
    const betaBefore = await Promise.all(
      [betaSource, betaWiki, betaState, betaLog].map(async (path) => readFile(path, 'utf8')),
    );
    const calls: string[] = [];
    const compiler: CompilerStatusPort = {
      status: (workspaceRoot) => {
        calls.push(workspaceRoot);
        return Promise.resolve({
          pendingChanges: [{ file: 'decision--alpha.md', status: 'new' }],
          pendingChangesCount: 1,
          stateStatus: 'missing',
        });
      },
    };

    await expect(getProjectKnowledgeStatus(knowledge, 'alpha', compiler)).resolves.toMatchObject({
      compiler: { pendingChangesCount: 1 },
      projectId: 'alpha',
      workspacePath: 'projects/alpha',
    });
    expect(calls).toEqual([join(knowledge, 'projects', 'alpha')]);
    await expect(
      Promise.all(
        [betaSource, betaWiki, betaState, betaLog].map(async (path) => readFile(path, 'utf8')),
      ),
    ).resolves.toEqual(betaBefore);
  });

  it('creates safe ignore defaults without excluding durable project records', async () => {
    const knowledge = await createKnowledgeRoot();
    await addProject(knowledge, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    await expect(readFile(join(knowledge, '.gitignore'), 'utf8')).resolves.toBe(
      KNOWLEDGE_GITIGNORE,
    );
    await Promise.all([
      mkdir(join(knowledge, 'projects', 'alpha', '.llmwiki', 'embeddings'), { recursive: true }),
      mkdir(join(knowledge, 'projects', 'alpha', '.llmwiki', 'journal'), { recursive: true }),
      mkdir(join(knowledge, 'projects', 'alpha', '.llmwiki', 'candidates'), { recursive: true }),
      mkdir(join(knowledge, 'projects', 'alpha', '.llmwiki', 'workflows'), { recursive: true }),
      mkdir(join(knowledge, 'projects', 'alpha', '.llmwiki', 'eval'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(knowledge, '.env'), 'ignored fixture value\n', 'utf8'),
      writeFile(
        join(knowledge, 'projects', 'alpha', '.llmwiki', 'embeddings', 'index.json'),
        '{}\n',
        'utf8',
      ),
      writeFile(
        join(knowledge, 'projects', 'alpha', '.llmwiki', 'journal', 'pending.json'),
        '{}\n',
        'utf8',
      ),
      writeFile(join(knowledge, 'projects', 'alpha', '.llmwiki', 'compile.lock'), '', 'utf8'),
      writeFile(join(knowledge, 'projects', 'alpha', 'PRIVATE-CREDENTIALS.json'), '{}\n', 'utf8'),
      writeFile(join(knowledge, 'projects', 'alpha', 'scratch.tmp'), 'temp\n', 'utf8'),
      writeFile(join(knowledge, 'projects', 'alpha', 'scratch.bak'), 'backup\n', 'utf8'),
      writeFile(join(knowledge, 'projects', 'alpha', '.llmwiki', 'state.json'), '{}\n', 'utf8'),
      writeFile(join(knowledge, 'projects', 'alpha', '.llmwiki', 'candidates', 'one.json'), '{}\n', 'utf8'),
      writeFile(join(knowledge, 'projects', 'alpha', '.llmwiki', 'workflows', 'one.json'), '{}\n', 'utf8'),
      writeFile(join(knowledge, 'projects', 'alpha', '.llmwiki', 'eval', 'one.json'), '{}\n', 'utf8'),
      writeFile(join(knowledge, 'projects', 'alpha', 'sources', 'decision--alpha.md'), 'source\n', 'utf8'),
      writeFile(join(knowledge, 'projects', 'alpha', 'wiki', 'alpha.md'), 'wiki\n', 'utf8'),
    ]);

    const ignored = await gitCheckIgnore(knowledge, [
      '.env',
      'projects/alpha/.llmwiki/embeddings/index.json',
      'projects/alpha/.llmwiki/journal/pending.json',
      'projects/alpha/.llmwiki/compile.lock',
      'projects/alpha/PRIVATE-CREDENTIALS.json',
      'projects/alpha/scratch.tmp',
      'projects/alpha/scratch.bak',
      'manifest.json',
      'projects/alpha/project.json',
      'projects/alpha/sources/decision--alpha.md',
      'projects/alpha/wiki/alpha.md',
      'projects/alpha/log.md',
      'projects/alpha/.llmwiki/state.json',
      'projects/alpha/.llmwiki/candidates/one.json',
      'projects/alpha/.llmwiki/workflows/one.json',
      'projects/alpha/.llmwiki/eval/one.json',
    ]);
    expect(ignored).toEqual([
      '.env',
      'projects/alpha/.llmwiki/embeddings/index.json',
      'projects/alpha/.llmwiki/journal/pending.json',
      'projects/alpha/.llmwiki/compile.lock',
      'projects/alpha/PRIVATE-CREDENTIALS.json',
      'projects/alpha/scratch.tmp',
      'projects/alpha/scratch.bak',
    ]);
  });

  it('maps unexpected compiler failures to a credential-free domain error', async () => {
    const knowledge = await createKnowledgeRoot();
    await addProject(knowledge, {
      displayName: 'Alpha',
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
    });
    const compiler: CompilerStatusPort = {
      status: () => Promise.reject(new Error('/private/path/provider-token=secret')),
    };
    await expect(getProjectKnowledgeStatus(knowledge, 'alpha', compiler)).rejects.toMatchObject({
      code: 'COMPILER_STATUS_UNSAFE',
      message: 'Compiler status could not be read safely.',
    });
  });
});
