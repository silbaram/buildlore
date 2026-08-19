import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectSourceChanges, normalizeCompilerStatus } from '../src/compiler/index.js';

const temporaryRoots: string[] = [];

const INITIAL_SOURCE = `---
title: Alpha decision
source: repo@aaaaaaaa:docs/alpha.md
ingestedAt: 2026-08-19T00:00:00.000Z
buildlore.sourceKind: decision
---

Alpha decision body with enough deterministic text for the source contract.
`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createWorkspace(): Promise<{
  readonly sourcePath: string;
  readonly statePath: string;
  readonly workspace: string;
}> {
  const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-compiler-adapter-'));
  temporaryRoots.push(workspace);
  await Promise.all([
    mkdir(join(workspace, 'sources', 'nested'), { recursive: true }),
    mkdir(join(workspace, 'wiki', 'concepts'), { recursive: true }),
    mkdir(join(workspace, 'wiki', 'queries'), { recursive: true }),
    mkdir(join(workspace, '.llmwiki'), { recursive: true }),
  ]);
  const sourcePath = join(workspace, 'sources', 'decision--alpha.md');
  const statePath = join(workspace, '.llmwiki', 'state.json');
  await writeFile(sourcePath, INITIAL_SOURCE, 'utf8');
  await writeFile(join(workspace, 'sources', 'nested', 'ignored.md'), INITIAL_SOURCE, 'utf8');
  await writeFile(join(workspace, 'sources', 'ignored.txt'), 'not markdown\n', 'utf8');
  return { sourcePath, statePath, workspace };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('llm-wiki-compiler public status adapter', () => {
  it('rejects malformed or contradictory compiler status results', () => {
    expect(() =>
      normalizeCompilerStatus({
        pendingChanges: [{ file: '../outside.md', status: 'new' }],
        pendingChangesCount: 1,
        stateStatus: 'missing',
      }),
    ).toThrow(/unsafe status item/u);
    expect(() =>
      normalizeCompilerStatus({
        pendingChanges: [
          { file: 'alpha.md', status: 'new' },
          { file: 'alpha.md', status: 'changed' },
        ],
        pendingChangesCount: 2,
        stateStatus: 'missing',
      }),
    ).toThrow(/unsafe status result/u);
    expect(() =>
      normalizeCompilerStatus({
        pendingChanges: [{ file: 'alpha.md', status: 'new' }],
        pendingChangesCount: 1,
        stateStatus: 'corrupt',
      }),
    ).toThrow(/unsafe status result/u);
    expect(() =>
      normalizeCompilerStatus({
        pendingChanges: [{ file: 'alpha.md', status: 'new' }],
        pendingChangesCount: 0,
        stateStatus: 'future',
      }),
    ).toThrow(/unsafe status result/u);
  });

  it('detects direct new sources without scanning nested or non-Markdown files', async () => {
    const fixture = await createWorkspace();
    await expect(detectSourceChanges(fixture.workspace)).resolves.toMatchObject({
      pendingChanges: [{ file: 'decision--alpha.md', status: 'new' }],
      pendingChangesCount: 1,
      stateStatus: 'missing',
    });
  });

  it('detects changed and deleted sources from a documented v1 state fixture', async () => {
    const fixture = await createWorkspace();
    const state = {
      indexHash: '',
      sources: {
        'decision--alpha.md': {
          compiledAt: '2026-08-19T00:00:00.000Z',
          concepts: [],
          hash: sha256(INITIAL_SOURCE),
        },
      },
      version: 1,
    };
    await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const stateBefore = await readFile(fixture.statePath, 'utf8');
    await expect(detectSourceChanges(fixture.workspace)).resolves.toMatchObject({
      pendingChanges: [],
      pendingChangesCount: 0,
    });

    await writeFile(fixture.sourcePath, `${INITIAL_SOURCE}\nChanged.\n`, 'utf8');
    await expect(detectSourceChanges(fixture.workspace)).resolves.toMatchObject({
      pendingChanges: [{ file: 'decision--alpha.md', status: 'changed' }],
      pendingChangesCount: 1,
    });

    await unlink(fixture.sourcePath);
    await expect(detectSourceChanges(fixture.workspace)).resolves.toMatchObject({
      pendingChanges: [{ file: 'decision--alpha.md', status: 'deleted' }],
      pendingChangesCount: 1,
    });
    await expect(readFile(fixture.statePath, 'utf8')).resolves.toBe(stateBefore);
  });

  it('surfaces corrupt and too-new state without false pending changes', async () => {
    const corrupt = await createWorkspace();
    await writeFile(corrupt.statePath, '{invalid json\n', 'utf8');
    await expect(detectSourceChanges(corrupt.workspace)).resolves.toMatchObject({
      pendingChanges: [],
      pendingChangesCount: 0,
      stateStatus: 'corrupt',
    });

    const tooNew = await createWorkspace();
    await writeFile(
      tooNew.statePath,
      `${JSON.stringify({ indexHash: '', sources: {}, version: 999 })}\n`,
      'utf8',
    );
    await expect(detectSourceChanges(tooNew.workspace)).resolves.toMatchObject({
      pendingChanges: [],
      pendingChangesCount: 0,
      stateStatus: 'too-new',
    });
  });
});
