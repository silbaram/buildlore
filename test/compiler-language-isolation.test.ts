import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOutputLanguageCoordinator } from '../src/compiler/output-language.js';
import {
  createProjectCompiler,
  type CompilerRequest,
} from '../src/compiler/index.js';
import { addProject } from '../src/knowledge/index.js';
import {
  createBuildLoreLifecycleProfile,
  createProjectLifecycleProfile,
  renderLifecycleProfile,
} from '../src/profile/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const temporaryRoots: string[] = [];

function compileResult(): Readonly<Record<string, unknown>> {
  return {
    candidates: [],
    compiled: 0,
    concepts: [],
    deleted: 0,
    errors: [],
    pages: [],
    skipped: 0,
  };
}

function resultFor(request: CompilerRequest): Readonly<Record<string, unknown>> {
  if (request.capability === 'query') {
    return { answer: 'Verified answer.', pageIds: [], refs: [], selectedPages: [], warnings: [] };
  }
  return compileResult();
}

async function fixture(): Promise<Readonly<{ knowledgeRoot: string; workspace: (id: string) => string }>> {
  const knowledgeRoot = await mkdtemp(join(process.cwd(), '.test-tmp-language-isolation-'));
  temporaryRoots.push(knowledgeRoot);
  for (const projectId of ['alpha', 'beta', 'gamma']) {
    await addProject(knowledgeRoot, {
      displayName: projectId,
      projectId,
      sourceRepository: `https://example.test/${projectId}.git`,
    });
    await writeSecurityPolicy(knowledgeRoot, projectId);
  }
  for (const [projectId, language] of [['alpha', 'ko'], ['beta', 'en']] as const) {
    await writeFile(
      join(knowledgeRoot, 'projects', projectId, 'profile.json'),
      renderLifecycleProfile(createBuildLoreLifecycleProfile(language)),
      'utf8',
    );
    const manager = createProjectLifecycleProfile({ knowledgeRoot });
    await manager.apply(await manager.plan(projectId));
  }
  return {
    knowledgeRoot,
    workspace: (projectId: string) => join(knowledgeRoot, 'projects', projectId),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('compiler output-language isolation', () => {
  it('serializes ko, en, and legacy default operations across compiler instances', async () => {
    const environment: NodeJS.ProcessEnv = { LLMWIKI_OUTPUT_LANG: 'prior-value' };
    const coordinator = createOutputLanguageCoordinator(environment);
    const observed: string[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const operation = (label: string, language: 'en' | 'ko' | null): Promise<void> =>
      coordinator.run(language, () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        observed.push(`${label}:${environment.LLMWIKI_OUTPUT_LANG ?? 'absent'}`);
        return new Promise<void>((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve();
          });
        });
      });

    const korean = operation('alpha', 'ko');
    await vi.waitFor(() => expect(observed).toHaveLength(1));
    const english = operation('beta', 'en');
    const legacy = operation('gamma', null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observed).toHaveLength(1);
    releases.shift()?.();
    await korean;
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    releases.shift()?.();
    await english;
    await vi.waitFor(() => expect(observed).toHaveLength(3));
    releases.shift()?.();
    await legacy;

    expect(observed).toEqual([
      'alpha:Korean',
      'beta:English',
      'gamma:prior-value',
    ]);
    expect(maximumActive).toBe(1);
    expect(environment.LLMWIKI_OUTPUT_LANG).toBe('prior-value');
  });

  it('restores absent and preset environment state after success, throw, and cancellation', async () => {
    const item = await fixture();
    const environment: NodeJS.ProcessEnv = {};
    const coordinator = createOutputLanguageCoordinator(environment);
    const observed: string[] = [];
    const successful = createProjectCompiler({
      backend: {
        run: (_root, request) => {
          observed.push(`${request.projectId}:${environment.LLMWIKI_OUTPUT_LANG ?? 'absent'}`);
          return Promise.resolve(resultFor(request));
        },
      },
      environment,
      knowledgeRoot: item.knowledgeRoot,
      outputLanguageCoordinator: coordinator,
    });
    await successful.execute({ capability: 'compile', projectId: 'alpha' });
    await successful.execute({ capability: 'query', projectId: 'beta', question: 'Verify.' });
    await successful.execute({ capability: 'compile', projectId: 'gamma' });
    expect(observed).toEqual(['alpha:Korean', 'beta:English', 'gamma:absent']);
    expect(Object.hasOwn(environment, 'LLMWIKI_OUTPUT_LANG')).toBe(false);

    environment.LLMWIKI_OUTPUT_LANG = '';
    const throwing = createProjectCompiler({
      backend: { run: () => Promise.reject(new Error('synthetic backend failure')) },
      environment,
      knowledgeRoot: item.knowledgeRoot,
      outputLanguageCoordinator: coordinator,
    });
    await expect(throwing.execute({ capability: 'compile', projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'COMPILER_FAILED' });
    expect(environment.LLMWIKI_OUTPUT_LANG).toBe('');

    environment.LLMWIKI_OUTPUT_LANG = 'preset';
    let markBackendStarted: (() => void) | undefined;
    const backendStarted = new Promise<void>((resolve) => {
      markBackendStarted = resolve;
    });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelling = createProjectCompiler({
      backend: {
        run: async () => {
          markBackendStarted?.();
          await held;
          return compileResult();
        },
      },
      environment,
      knowledgeRoot: item.knowledgeRoot,
      outputLanguageCoordinator: coordinator,
    });
    const controller = new AbortController();
    const pending = cancelling.execute(
      { capability: 'compile', projectId: 'alpha' },
      { signal: controller.signal },
    );
    await backendStarted;
    expect(environment.LLMWIKI_OUTPUT_LANG).toBe('Korean');
    controller.abort();
    release?.();
    await expect(pending).rejects.toMatchObject({
      code: 'COMPILER_CANCELLED',
      sideEffectsPossible: true,
    });
    expect(environment.LLMWIKI_OUTPUT_LANG).toBe('preset');
  });

  it('rejects a reentrant language-sensitive lease instead of deadlocking', async () => {
    const coordinator = createOutputLanguageCoordinator({});
    await expect(coordinator.run('en', async () =>
      coordinator.run('ko', () => Promise.resolve('unreachable'))))
      .rejects.toMatchObject({ code: 'PROFILE_LANGUAGE_CONFLICT' });
  });
});
