import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { mapCliError } from '../src/cli/error-map.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  bindLocalProject,
  emptyLocalProjectRegistry,
  LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
  parseLocalProjectRegistry,
  readLocalProjectRegistry,
  resolveLocalProjectBinding,
  sourceRepositoryDigestFor,
} from '../src/knowledge/local-project-registry.js';
import { addProject, readManifest, showProject } from '../src/knowledge/index.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

interface Fixture {
  readonly hubRoot: string;
  readonly root: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-local-project-registry-'));
  temporaryRoots.push(root);
  const hubRoot = join(root, 'hub');
  await mkdir(hubRoot);
  return { hubRoot, root };
}

async function initializeCheckout(checkout: string): Promise<void> {
  await execFileAsync('git', ['init', '--initial-branch=main'], {
    cwd: checkout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

async function createCheckout(root: string, name: string): Promise<string> {
  const checkout = join(root, name);
  await mkdir(checkout);
  await initializeCheckout(checkout);
  return checkout;
}

async function writeRawRegistry(hubRoot: string, source: string): Promise<void> {
  const stateDirectory = join(hubRoot, '.buildlore');
  await mkdir(stateDirectory, { mode: 0o700 });
  await writeFile(join(stateDirectory, 'local-projects.json'), source, { mode: 0o600 });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('hub-local project registry', () => {
  it('binds one project to the canonical hub checkout itself', async () => {
    const { hubRoot } = await createFixture();
    await initializeCheckout(hubRoot);
    const input = {
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: hubRoot,
    } as const;

    await expect(bindLocalProject(hubRoot, input)).resolves.toMatchObject({
      outcome: 'created',
      projectId: 'alpha',
    });
    await expect(bindLocalProject(hubRoot, input)).resolves.toMatchObject({
      outcome: 'unchanged',
      projectId: 'alpha',
    });
    const resolved = await resolveLocalProjectBinding(
      hubRoot,
      'alpha',
      input.sourceRepository,
    );
    expect(resolved.checkout.resolveRootForInternalUse()).toBe(hubRoot);
    expect(JSON.stringify(resolved)).not.toContain(hubRoot);
    await expect(bindLocalProject(hubRoot, {
      projectId: 'beta',
      sourceRepository: 'https://example.test/beta.git',
      sourceRoot: hubRoot,
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_CONFLICT' });
  });

  it('continues to reject strict ancestry between hub and source roots', async () => {
    const { hubRoot, root } = await createFixture();
    const childSource = await createCheckout(hubRoot, 'child-source');
    await expect(bindLocalProject(hubRoot, {
      projectId: 'child',
      sourceRepository: 'https://example.test/child.git',
      sourceRoot: childSource,
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_INVALID' });

    const parentSource = await createCheckout(root, 'parent-source');
    const childHub = join(parentSource, 'child-hub');
    await mkdir(childHub);
    await expect(bindLocalProject(childHub, {
      projectId: 'parent',
      sourceRepository: 'https://example.test/parent.git',
      sourceRoot: parentSource,
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_INVALID' });
  });

  it('creates a canonical, sorted, owner-only local registry', async () => {
    const { hubRoot, root } = await createFixture();
    const zuluRoot = await createCheckout(root, 'zulu-source');
    const alphaRoot = await createCheckout(root, 'alpha-source');

    await expect(bindLocalProject(hubRoot, {
      projectId: 'zulu',
      sourceRepository: 'https://example.test/zulu.git',
      sourceRoot: zuluRoot,
    })).resolves.toMatchObject({ outcome: 'created', projectId: 'zulu' });
    await expect(bindLocalProject(hubRoot, {
      projectId: 'alpha',
      sourceRepository: 'git@example.test:alpha.git',
      sourceRoot: alphaRoot,
    })).resolves.toMatchObject({ outcome: 'created', projectId: 'alpha' });

    const registry = await readLocalProjectRegistry(hubRoot);
    expect(registry).toEqual({
      bindings: [
        {
          projectId: 'alpha',
          sourceRepositoryDigest: sourceRepositoryDigestFor('git@example.test:alpha.git'),
          sourceRoot: alphaRoot,
        },
        {
          projectId: 'zulu',
          sourceRepositoryDigest: sourceRepositoryDigestFor('https://example.test/zulu.git'),
          sourceRoot: zuluRoot,
        },
      ],
      schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
    });
    await expect(readFile(join(hubRoot, '.buildlore/local-projects.json'), 'utf8')).resolves.toBe(
      serializeCanonicalJson(registry),
    );

    if (process.platform !== 'win32') {
      const [directoryStatus, fileStatus] = await Promise.all([
        stat(join(hubRoot, '.buildlore')),
        stat(join(hubRoot, '.buildlore/local-projects.json')),
      ]);
      expect(directoryStatus.mode & 0o777).toBe(0o700);
      expect(fileStatus.mode & 0o777).toBe(0o600);
    }
  });

  it('is repeat-safe and requires compare-and-swap for replacement', async () => {
    const { hubRoot, root } = await createFixture();
    const firstRoot = await createCheckout(root, 'alpha-first');
    const secondRoot = await createCheckout(root, 'alpha-second');
    const input = {
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: firstRoot,
    } as const;
    const created = await bindLocalProject(hubRoot, input);
    const registryPath = join(hubRoot, '.buildlore/local-projects.json');
    const before = await readFile(registryPath, 'utf8');

    await expect(bindLocalProject(hubRoot, input)).resolves.toEqual({
      bindingDigest: created.bindingDigest,
      outcome: 'unchanged',
      projectId: 'alpha',
    });
    await expect(readFile(registryPath, 'utf8')).resolves.toBe(before);
    await expect(bindLocalProject(hubRoot, {
      ...input,
      sourceRoot: secondRoot,
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_CONFLICT' });

    const replaced = await bindLocalProject(hubRoot, {
      ...input,
      expectedBindingDigest: created.bindingDigest,
      sourceRoot: secondRoot,
    });
    expect(replaced).toMatchObject({ outcome: 'replaced', projectId: 'alpha' });
    const resolved = await resolveLocalProjectBinding(
      hubRoot,
      'alpha',
      'https://example.test/alpha.git',
    );
    expect(resolved.checkout.resolveRootForInternalUse()).toBe(secondRoot);
    expect(JSON.stringify(resolved)).not.toContain(secondRoot);
  });

  it('rejects a checkout already assigned to another project', async () => {
    const { hubRoot, root } = await createFixture();
    const sourceRoot = await createCheckout(root, 'shared-source');
    await bindLocalProject(hubRoot, {
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot,
    });
    await expect(bindLocalProject(hubRoot, {
      projectId: 'beta',
      sourceRepository: 'https://example.test/beta.git',
      sourceRoot,
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_CONFLICT' });
  });

  it('rejects nested Git worktrees across project bindings', async () => {
    const { hubRoot, root } = await createFixture();
    const alphaRoot = await createCheckout(root, 'alpha-source');
    const nestedRoot = await createCheckout(alphaRoot, 'nested-beta-source');
    await bindLocalProject(hubRoot, {
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: alphaRoot,
    });

    await expect(bindLocalProject(hubRoot, {
      projectId: 'beta',
      sourceRepository: 'https://example.test/beta.git',
      sourceRoot: nestedRoot,
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_CONFLICT' });
  });

  it('serializes concurrent mutations with an exclusive local lock', async () => {
    const { hubRoot, root } = await createFixture();
    const alphaRoot = await createCheckout(root, 'alpha-source');
    const betaRoot = await createCheckout(root, 'beta-source');
    let nestedFailureCode: string | undefined;

    await bindLocalProject(hubRoot, {
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: alphaRoot,
    }, {
      afterLockOpen: async () => {
        try {
          await bindLocalProject(hubRoot, {
            projectId: 'beta',
            sourceRepository: 'https://example.test/beta.git',
            sourceRoot: betaRoot,
          });
        } catch (error) {
          nestedFailureCode = (error as { readonly code?: string }).code;
        }
      },
    });

    expect(nestedFailureCode).toBe('SOURCE_BINDING_BUSY');
    await expect(resolveLocalProjectBinding(hubRoot, 'beta')).rejects.toMatchObject({
      code: 'SOURCE_BINDING_REQUIRED',
    });
  });

  it.each([
    {
      name: 'byte-order mark',
      source: `\ufeff${serializeCanonicalJson(emptyLocalProjectRegistry())}`,
    },
    {
      name: 'duplicate JSON key',
      source: '{"bindings":[],"bindings":[],"schemaVersion":"buildlore.local-projects.v1"}\n',
    },
    {
      name: 'unknown root field',
      source: serializeCanonicalJson({
        bindings: [],
        extra: true,
        schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
      }),
    },
    {
      name: 'relative root',
      source: serializeCanonicalJson({
        bindings: [{
          projectId: 'alpha',
          sourceRepositoryDigest: `sha256:${'a'.repeat(64)}`,
          sourceRoot: 'relative/source',
        }],
        schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
      }),
    },
    {
      name: 'duplicate project ID',
      source: serializeCanonicalJson({
        bindings: [
          {
            projectId: 'alpha',
            sourceRepositoryDigest: `sha256:${'a'.repeat(64)}`,
            sourceRoot: '/source/alpha-one',
          },
          {
            projectId: 'alpha',
            sourceRepositoryDigest: `sha256:${'b'.repeat(64)}`,
            sourceRoot: '/source/alpha-two',
          },
        ],
        schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
      }),
    },
    {
      name: 'unsupported version',
      source: serializeCanonicalJson({ bindings: [], schemaVersion: 'buildlore.local-projects.v2' }),
    },
  ])('fails closed for registry corruption: $name', async ({ source }) => {
    const { hubRoot } = await createFixture();
    await writeRawRegistry(hubRoot, source);
    await expect(readLocalProjectRegistry(hubRoot)).rejects.toMatchObject({
      code: 'SOURCE_BINDING_INVALID',
    });
  });

  it('rejects noncanonical ordering and insecure permissions', async () => {
    const { hubRoot } = await createFixture();
    await writeRawRegistry(hubRoot, serializeCanonicalJson({
      bindings: [
        {
          projectId: 'zulu',
          sourceRepositoryDigest: `sha256:${'a'.repeat(64)}`,
          sourceRoot: '/source/zulu',
        },
        {
          projectId: 'alpha',
          sourceRepositoryDigest: `sha256:${'b'.repeat(64)}`,
          sourceRoot: '/source/alpha',
        },
      ],
      schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION,
    }));
    await expect(readLocalProjectRegistry(hubRoot)).rejects.toMatchObject({
      code: 'SOURCE_BINDING_INVALID',
    });

    if (process.platform !== 'win32') {
      await writeFile(
        join(hubRoot, '.buildlore/local-projects.json'),
        serializeCanonicalJson(emptyLocalProjectRegistry()),
      );
      await chmod(join(hubRoot, '.buildlore/local-projects.json'), 0o644);
      await expect(readLocalProjectRegistry(hubRoot)).rejects.toMatchObject({
        code: 'SOURCE_BINDING_INVALID',
      });
    }
  });

  it('preserves the prior registry when atomic replacement fails', async () => {
    const { hubRoot, root } = await createFixture();
    const firstRoot = await createCheckout(root, 'first-source');
    const secondRoot = await createCheckout(root, 'second-source');
    const created = await bindLocalProject(hubRoot, {
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: firstRoot,
    });
    const stateDirectory = join(hubRoot, '.buildlore');
    const registryPath = join(stateDirectory, 'local-projects.json');
    const before = await readFile(registryPath, 'utf8');

    await expect(bindLocalProject(hubRoot, {
      expectedBindingDigest: created.bindingDigest,
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: secondRoot,
    }, {
      beforeRename: () => Promise.reject(new Error('injected replacement failure')),
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_WRITE_FAILED' });

    await expect(readFile(registryPath, 'utf8')).resolves.toBe(before);
    const entries = await readdir(stateDirectory);
    expect(entries).not.toContain('local-projects.json.lock');
    expect(entries).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.local-projects\.json\..+\.tmp$/u)]),
    );
  });

  it('keeps a portable legacy project valid and explicitly unbound until migration', async () => {
    const { hubRoot, root } = await createFixture();
    const sourceRoot = await createCheckout(root, 'legacy-source');
    const knowledgeRoot = join(hubRoot, 'knowledge');
    await mkdir(knowledgeRoot);
    await addProject(knowledgeRoot, {
      displayName: 'Legacy',
      projectId: 'legacy',
      sourceRepository: 'https://example.test/legacy.git',
    });
    const portableBefore = await readFile(join(knowledgeRoot, 'manifest.json'), 'utf8');

    await expect(resolveLocalProjectBinding(hubRoot, 'legacy')).rejects.toMatchObject({
      code: 'SOURCE_BINDING_REQUIRED',
    });
    await expect(showProject(knowledgeRoot, 'legacy')).resolves.toMatchObject({
      entry: { projectId: 'legacy' },
    });

    await bindLocalProject(hubRoot, {
      projectId: 'legacy',
      sourceRepository: 'https://example.test/legacy.git',
      sourceRoot,
    });
    await expect(readManifest(knowledgeRoot)).resolves.toMatchObject({
      projects: [{ projectId: 'legacy' }],
    });
    const portableAfter = await readFile(join(knowledgeRoot, 'manifest.json'), 'utf8');
    expect(portableAfter).toBe(portableBefore);
    expect(portableAfter).not.toContain(sourceRoot);
    await expect(readFile(join(knowledgeRoot, 'projects/legacy/project.json'), 'utf8')).resolves
      .not.toContain(sourceRoot);
  });

  it('rejects unsafe roots and redacts their values from structured failures', async () => {
    const { hubRoot, root } = await createFixture();
    const checkout = await createCheckout(root, 'safe-checkout');
    const nested = join(checkout, 'nested');
    await mkdir(nested);
    await expect(bindLocalProject(hubRoot, {
      projectId: 'nested',
      sourceRepository: 'https://example.test/nested.git',
      sourceRoot: nested,
    })).rejects.toMatchObject({ code: 'SOURCE_BINDING_INVALID' });

    const linked = join(root, 'credential-secret-source-link');
    await symlink(checkout, linked, 'dir');
    let failure: unknown;
    try {
      await bindLocalProject(hubRoot, {
        projectId: 'linked',
        sourceRepository: 'https://example.test/linked.git',
        sourceRoot: linked,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain('credential-secret-source-link');
    expect(JSON.stringify(mapCliError(failure))).not.toContain('credential-secret-source-link');
  });

  it('exactly ignores hub-local registry state without ignoring project manifests', async () => {
    const ignoreSource = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(ignoreSource).toContain('/.buildlore/local-projects.json\n');
    expect(ignoreSource).toContain('/.buildlore/local-projects.json.lock\n');
    expect(ignoreSource).toContain('/.buildlore/.local-projects.json.*.tmp\n');
    expect(ignoreSource).toContain('/.buildlore/hierarchy-runs/\n');
    expect(ignoreSource).not.toContain('/.buildlore/\n');
    expect(ignoreSource).not.toContain('.buildlore/sources.json');
  });

  it('keeps the public schema closed and aligned with the runtime record shape', async () => {
    const schema = JSON.parse(
      await readFile(
        new URL('../schemas/local-project-registry.schema.json', import.meta.url),
        'utf8',
      ),
    ) as {
      readonly additionalProperties: boolean;
      readonly properties: {
        readonly bindings: { readonly uniqueItems: boolean };
        readonly schemaVersion: unknown;
      };
      readonly required: readonly string[];
      readonly $defs: {
        readonly binding: {
          readonly additionalProperties: boolean;
          readonly properties: {
            readonly projectId: unknown;
            readonly sourceRepositoryDigest: unknown;
            readonly sourceRoot: {
              readonly oneOf: readonly { readonly pattern: string }[];
            };
          };
          readonly required: readonly string[];
        };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['bindings', 'schemaVersion']);
    expect(Object.keys(schema.properties).sort()).toEqual(['bindings', 'schemaVersion']);
    expect(schema.properties.bindings.uniqueItems).toBe(true);
    expect(schema.$defs.binding.additionalProperties).toBe(false);
    expect(schema.$defs.binding.required).toEqual([
      'projectId',
      'sourceRepositoryDigest',
      'sourceRoot',
    ]);
    expect(Object.keys(schema.$defs.binding.properties).sort()).toEqual([
      'projectId',
      'sourceRepositoryDigest',
      'sourceRoot',
    ]);
    const sourceRootPatterns = schema.$defs.binding.properties.sourceRoot.oneOf.map(
      ({ pattern }) => new RegExp(pattern, 'u'),
    );
    const schemaAcceptsSourceRoot = (value: string): boolean =>
      sourceRootPatterns.some((pattern) => pattern.test(value));
    expect(schemaAcceptsSourceRoot('/srv/projects/alpha')).toBe(true);
    expect(schemaAcceptsSourceRoot('/')).toBe(true);
    expect(schemaAcceptsSourceRoot('C:\\projects\\alpha')).toBe(true);
    expect(schemaAcceptsSourceRoot('C:\\')).toBe(true);
    expect(schemaAcceptsSourceRoot('\\\\server\\share\\alpha')).toBe(true);
    expect(schemaAcceptsSourceRoot('relative/projects/alpha')).toBe(false);
    expect(schemaAcceptsSourceRoot('/srv/../private')).toBe(false);
    expect(schemaAcceptsSourceRoot('/srv//alpha')).toBe(false);
    expect(schemaAcceptsSourceRoot('/srv/alpha/')).toBe(false);
    expect(schemaAcceptsSourceRoot('C:\\projects\\\\alpha')).toBe(false);
    expect(schemaAcceptsSourceRoot('\\\\server\\share\\\\alpha')).toBe(false);
  });

  it('resolves only the requested project binding', async () => {
    const { hubRoot, root } = await createFixture();
    const alphaRoot = await createCheckout(root, 'alpha-source');
    const betaRoot = await createCheckout(root, 'beta-source');
    await bindLocalProject(hubRoot, {
      projectId: 'alpha',
      sourceRepository: 'https://example.test/alpha.git',
      sourceRoot: alphaRoot,
    });
    await bindLocalProject(hubRoot, {
      projectId: 'beta',
      sourceRepository: 'https://example.test/beta.git',
      sourceRoot: betaRoot,
    });

    const alpha = await resolveLocalProjectBinding(hubRoot, 'alpha');
    expect(alpha.projectId).toBe('alpha');
    expect(alpha.checkout.resolveRootForInternalUse()).toBe(alphaRoot);
    expect(alpha.checkout.resolveRootForInternalUse()).not.toBe(betaRoot);
    await expect(resolveLocalProjectBinding(hubRoot, 'gamma')).rejects.toMatchObject({
      code: 'SOURCE_BINDING_REQUIRED',
    });
  });

  it('rejects invalid runtime registry shapes with value-free errors', () => {
    for (const value of [
      null,
      [],
      { bindings: 'invalid', schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION },
      { bindings: [], schemaVersion: LOCAL_PROJECT_REGISTRY_SCHEMA_VERSION, unknown: true },
    ]) {
      expect(() => parseLocalProjectRegistry(value)).toThrowError(
        expect.objectContaining({ code: 'SOURCE_BINDING_INVALID' }),
      );
    }
  });
});
