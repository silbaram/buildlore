import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  SourceCheckoutHandle,
  sourceRepositoryDigestFor,
} from '../src/knowledge/local-project-registry.js';
import {
  MAX_SOURCE_DECLARATIONS,
  MAX_SOURCE_MANIFEST_BYTES,
  MAX_SOURCE_PATH_LENGTH,
  parseSourceCollectionManifest,
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
  SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
  type SourceCollectionManifestV1,
} from '../src/projector/source-manifest.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const sourceRepository = 'https://example.test/alpha.git';

interface Fixture {
  readonly checkout: SourceCheckoutHandle;
  readonly root: string;
  readonly sourceRoot: string;
}

function manifest(
  sources: readonly Readonly<Record<string, unknown>>[],
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    projectId: 'alpha',
    schemaVersion: SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
    sourceRepository,
    sources,
    ...overrides,
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-source-manifest-'));
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  await mkdir(join(sourceRoot, '.buildlore'), { recursive: true });
  return {
    checkout: new SourceCheckoutHandle(
      'alpha',
      sourceRepositoryDigestFor(sourceRepository),
      sourceRoot,
    ),
    root,
    sourceRoot,
  };
}

async function writeManifest(
  sourceRoot: string,
  value: unknown,
): Promise<SourceCollectionManifestV1> {
  const parsed = parseSourceCollectionManifest(value);
  await writeFile(
    join(sourceRoot, '.buildlore/sources.json'),
    serializeCanonicalJson(parsed),
  );
  return parsed;
}

async function load(
  fixture: Fixture,
  value: unknown,
): ReturnType<typeof readSourceCollectionManifest> {
  await writeManifest(fixture.sourceRoot, value);
  return readSourceCollectionManifest(fixture.checkout, 'alpha');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('project-owned source collection manifest', () => {
  it('reads a canonical manifest and selects declared files deterministically', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceRoot, 'docs/nested'), { recursive: true });
    await mkdir(join(fixture.sourceRoot, '.plan2agent/iterations/v1'), { recursive: true });
    await mkdir(join(fixture.sourceRoot, '.plan2agent/runs/attempt'), { recursive: true });
    await writeFile(join(fixture.sourceRoot, 'docs/zulu.md'), '# Zulu\n');
    await writeFile(join(fixture.sourceRoot, 'docs/alpha.markdown'), '# Alpha\n');
    await writeFile(join(fixture.sourceRoot, 'docs/nested/beta.md'), '# Beta\n');
    await writeFile(join(fixture.sourceRoot, 'docs/nested/ignored.txt'), 'ignore me');
    await writeFile(join(fixture.sourceRoot, '.plan2agent/current-spec.json'), '{}\n');
    await writeFile(join(fixture.sourceRoot, '.plan2agent/decisions.jsonl'), '{}\n');
    await writeFile(join(fixture.sourceRoot, '.plan2agent/iterations/v1/iteration.json'), '{}\n');
    await writeFile(join(fixture.sourceRoot, '.plan2agent/ignored.ts'), 'do not select');
    await writeFile(join(fixture.sourceRoot, '.plan2agent/runs/run-index.json'), '{invalid');
    await symlink(
      join(fixture.root, 'missing-execution-sentinel'),
      join(fixture.sourceRoot, '.plan2agent/runs/attempt/unreadable-run.json'),
    );

    const loaded = await load(fixture, manifest([
      {
        documentKind: 'p2a-planning',
        id: 'planning',
        path: '.plan2agent',
        pathType: 'directory',
        recursive: true,
      },
      {
        documentKind: 'markdown',
        id: 'documentation',
        path: 'docs',
        pathType: 'directory',
        recursive: true,
      },
    ]));
    expect(loaded.manifest.sources.map((source) => source.id)).toEqual([
      'documentation',
      'planning',
    ]);

    const first = await selectDeclaredSourceFiles(fixture.checkout, loaded);
    const second = await selectDeclaredSourceFiles(fixture.checkout, loaded);
    expect(second).toEqual(first);
    expect(first.files.map((file) => [file.declarationId, file.sourceRef])).toEqual([
      ['documentation', 'docs/alpha.markdown'],
      ['documentation', 'docs/nested/beta.md'],
      ['documentation', 'docs/zulu.md'],
      ['planning', '.plan2agent/current-spec.json'],
      ['planning', '.plan2agent/decisions.jsonl'],
      ['planning', '.plan2agent/iterations/v1/iteration.json'],
    ]);
    expect(first.files.every((file) => file.contentDigest.startsWith('sha256:'))).toBe(true);
    expect(first.files.some((file) => file.sourceRef.includes('runs'))).toBe(false);
    expect(first.files.some((file) => file.sourceRef.endsWith('.txt'))).toBe(false);
    expect(first.files.some((file) => file.sourceRef.endsWith('.ts'))).toBe(false);
    expect(await readFile(join(fixture.sourceRoot, '.plan2agent/runs/run-index.json'), 'utf8'))
      .toBe('{invalid');
  });

  it('supports exact files and non-recursive directory selection', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceRoot, 'docs/nested'), { recursive: true });
    await writeFile(join(fixture.sourceRoot, 'README.md'), '# Readme\n');
    await writeFile(join(fixture.sourceRoot, 'docs/top.md'), '# Top\n');
    await writeFile(join(fixture.sourceRoot, 'docs/nested/deep.md'), '# Deep\n');
    const loaded = await load(fixture, manifest([
      {
        documentKind: 'markdown',
        id: 'docs',
        path: 'docs',
        pathType: 'directory',
      },
      {
        documentKind: 'markdown',
        id: 'readme',
        path: 'README.md',
        pathType: 'file',
      },
    ]));

    const selected = await selectDeclaredSourceFiles(fixture.checkout, loaded);
    expect(selected.files.map((file) => file.sourceRef)).toEqual(['docs/top.md', 'README.md']);
  });

  it('does not confuse safe leading-dot names with parent traversal', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceRoot, '..notes'));
    await writeFile(join(fixture.sourceRoot, '..notes/guide.md'), '# Guide\n');
    const loaded = await load(fixture, manifest([{
      documentKind: 'markdown',
      id: 'notes',
      path: '..notes/guide.md',
      pathType: 'file',
    }]));

    const selected = await selectDeclaredSourceFiles(fixture.checkout, loaded);
    expect(selected.files.map((file) => file.sourceRef)).toEqual(['..notes/guide.md']);
  });

  it('enforces the closed declaration union and rejects execution kinds first', () => {
    expect(() => parseSourceCollectionManifest(manifest([{
      documentKind: 'p2a-execution',
      id: 'runs',
      path: '.plan2agent/runs',
      pathType: 'directory',
      recursive: true,
    }]))).toThrowError(expect.objectContaining({
      code: 'SOURCE_KIND_UNSUPPORTED',
      field: 'documentKind',
    }));
    for (const source of [
      {
        documentKind: 'markdown',
        id: 'file',
        path: 'README.md',
        pathType: 'file',
        recursive: false,
      },
      {
        documentKind: 'markdown',
        id: 'unknown',
        path: 'docs',
        pathType: 'directory',
        unknown: true,
      },
      {
        documentKind: 'markdown',
        id: 'directory',
        path: 'docs',
        pathType: 'directory',
        recursive: 'yes',
      },
    ]) {
      expect(() => parseSourceCollectionManifest(manifest([source]))).toThrowError(
        expect.objectContaining({ code: 'SOURCE_MANIFEST_INVALID' }),
      );
    }
  });

  it('rejects duplicate IDs, invalid identities, bounds, and unsafe paths', () => {
    const safeSource = {
      documentKind: 'markdown',
      id: 'docs',
      path: 'docs/README.md',
      pathType: 'file',
    } as const;
    expect(() => parseSourceCollectionManifest(manifest([safeSource, safeSource])))
      .toThrowError(expect.objectContaining({ code: 'SOURCE_MANIFEST_INVALID', field: 'id' }));
    expect(() => parseSourceCollectionManifest(manifest([])))
      .toThrowError(expect.objectContaining({ field: 'sources' }));
    expect(() => parseSourceCollectionManifest(manifest(
      Array.from({ length: MAX_SOURCE_DECLARATIONS + 1 }, (_, index) => ({
        ...safeSource,
        id: `docs-${index}`,
      })),
    ))).toThrowError(expect.objectContaining({ field: 'sources' }));
    expect(() => parseSourceCollectionManifest(manifest([safeSource], { projectId: 'Upper' })))
      .toThrowError(expect.objectContaining({ field: 'projectId' }));
    expect(() => parseSourceCollectionManifest(manifest([safeSource], {
      sourceRepository: '/absolute/repository',
    }))).toThrowError(expect.objectContaining({ field: 'sourceRepository' }));

    for (const path of [
      '',
      '/absolute/file.md',
      '../escape.md',
      'docs/../escape.md',
      'docs\\file.md',
      'docs/%2e%2e/escape.md',
      'docs//file.md',
      'docs/.git/config',
      'docs/access-token/value.md',
      `docs/${'a'.repeat(MAX_SOURCE_PATH_LENGTH)}.md`,
    ]) {
      expect(() => parseSourceCollectionManifest(manifest([{ ...safeSource, path }])))
        .toThrowError(expect.objectContaining({
          code: 'SOURCE_MANIFEST_INVALID',
          field: 'path',
        }));
    }

    const boundaryPath = `${'a/'.repeat(63)}${'z'.repeat(386)}`;
    expect(boundaryPath).toHaveLength(MAX_SOURCE_PATH_LENGTH);
    expect(() => parseSourceCollectionManifest(manifest([{
      ...safeSource,
      path: boundaryPath,
    }]))).not.toThrow();

    expect(() => parseSourceCollectionManifest(manifest(
      Array.from({ length: MAX_SOURCE_DECLARATIONS }, (_, index) => ({
        ...safeSource,
        id: `docs-${index}`,
      })),
    ))).not.toThrow();
  });

  it('rejects declared file-kind and path-type mismatches', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceRoot, 'docs'));
    await writeFile(join(fixture.sourceRoot, 'notes.txt'), 'not markdown');
    await writeFile(join(fixture.sourceRoot, 'docs/readme.md'), '# Readme\n');

    let loaded = await load(fixture, manifest([{
      documentKind: 'markdown',
      id: 'notes',
      path: 'notes.txt',
      pathType: 'file',
    }]));
    await expect(selectDeclaredSourceFiles(fixture.checkout, loaded)).rejects.toMatchObject({
      code: 'SOURCE_SELECTION_KIND_MISMATCH',
    });

    loaded = await load(fixture, manifest([{
      documentKind: 'markdown',
      id: 'wrong-type',
      path: 'docs',
      pathType: 'file',
    }]));
    await expect(selectDeclaredSourceFiles(fixture.checkout, loaded)).rejects.toMatchObject({
      code: 'SOURCE_SELECTION_KIND_MISMATCH',
    });

    loaded = await load(fixture, manifest([{
      documentKind: 'p2a-planning',
      id: 'execution',
      path: '.plan2agent/runs/run.json',
      pathType: 'file',
    }]));
    await expect(selectDeclaredSourceFiles(fixture.checkout, loaded)).rejects.toMatchObject({
      code: 'SOURCE_SELECTION_KIND_MISMATCH',
    });
  });

  it('rejects malformed, noncanonical, oversized, and identity-mismatched manifests', async () => {
    const fixture = await createFixture();
    const manifestPath = join(fixture.sourceRoot, '.buildlore/sources.json');
    const canonical = parseSourceCollectionManifest(manifest([{
      documentKind: 'markdown',
      id: 'docs',
      path: 'README.md',
      pathType: 'file',
    }]));
    for (const source of [
      `\ufeff${serializeCanonicalJson(canonical)}`,
      '{"projectId":"alpha","projectId":"beta"}\n',
      JSON.stringify({ ...canonical, unknown: true }),
    ]) {
      await writeFile(manifestPath, source);
      await expect(readSourceCollectionManifest(fixture.checkout, 'alpha')).rejects
        .toMatchObject({ code: 'SOURCE_MANIFEST_INVALID' });
    }

    await writeFile(manifestPath, `${' '.repeat(MAX_SOURCE_MANIFEST_BYTES)}{}`);
    await expect(readSourceCollectionManifest(fixture.checkout, 'alpha')).rejects
      .toMatchObject({ code: 'SOURCE_MANIFEST_TOO_LARGE' });

    await writeManifest(fixture.sourceRoot, manifest([{
      documentKind: 'markdown',
      id: 'docs',
      path: 'README.md',
      pathType: 'file',
    }], { projectId: 'beta' }));
    await expect(readSourceCollectionManifest(fixture.checkout, 'alpha')).rejects
      .toMatchObject({ code: 'SOURCE_PROJECT_MISMATCH', field: 'projectId' });

    await writeManifest(fixture.sourceRoot, manifest([{
      documentKind: 'markdown',
      id: 'docs',
      path: 'README.md',
      pathType: 'file',
    }], { sourceRepository: 'https://example.test/other.git' }));
    await expect(readSourceCollectionManifest(fixture.checkout, 'alpha')).rejects
      .toMatchObject({ code: 'SOURCE_PROJECT_MISMATCH', field: 'sourceRepository' });
  });

  it('requires an explicit manifest without inferring source locations', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.sourceRoot, '.buildlore'), { recursive: true });
    await expect(readSourceCollectionManifest(fixture.checkout, 'alpha')).rejects.toMatchObject({
      code: 'SOURCE_MANIFEST_REQUIRED',
      field: 'manifest',
    });
  });

  it('rejects symlinks, realpath escapes, and unsafe selected file types without value echo', async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, 'private-source-sentinel.md');
    await writeFile(outside, '# Private\n');
    await mkdir(join(fixture.sourceRoot, 'docs'), { recursive: true });
    await symlink(outside, join(fixture.sourceRoot, 'docs/private-source-sentinel.md'));
    let loaded = await load(fixture, manifest([{
      documentKind: 'markdown',
      id: 'docs',
      path: 'docs',
      pathType: 'directory',
      recursive: true,
    }]));
    let failure: unknown;
    try {
      await selectDeclaredSourceFiles(fixture.checkout, loaded);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'SOURCE_SELECTION_PATH_UNSAFE' });
    expect(String(failure)).not.toContain('private-source-sentinel');
    expect(JSON.stringify(failure)).not.toContain('private-source-sentinel');

    await rm(join(fixture.sourceRoot, 'docs/private-source-sentinel.md'));
    if (process.platform !== 'win32') {
      await execFileAsync('mkfifo', [join(fixture.sourceRoot, 'docs/unsafe.pipe')]);
      loaded = await readSourceCollectionManifest(fixture.checkout, 'alpha');
      await expect(selectDeclaredSourceFiles(fixture.checkout, loaded)).rejects.toMatchObject({
        code: 'SOURCE_SELECTION_PATH_UNSAFE',
      });
    }
  });

  it('enforces file-count, file-byte, aggregate-byte, and depth limits', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceRoot, 'docs/nested'), { recursive: true });
    await writeFile(join(fixture.sourceRoot, 'docs/a.md'), 'aaa');
    await writeFile(join(fixture.sourceRoot, 'docs/b.md'), 'bbb');
    await writeFile(join(fixture.sourceRoot, 'docs/nested/c.md'), 'ccc');
    const loaded = await load(fixture, manifest([{
      documentKind: 'markdown',
      id: 'docs',
      path: 'docs',
      pathType: 'directory',
      recursive: true,
    }]));

    for (const limits of [
      { maxFileCount: 1 },
      { maxFileBytes: 2 },
      { maxAggregateBytes: 5 },
      { maxDepth: 2 },
    ]) {
      await expect(selectDeclaredSourceFiles(fixture.checkout, loaded, { limits })).rejects
        .toMatchObject({ code: 'SOURCE_SELECTION_LIMIT_EXCEEDED' });
    }
  });

  it('detects read-after-stat source and manifest drift', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceRoot, 'docs'));
    const selectedPath = join(fixture.sourceRoot, 'docs/a.md');
    await writeFile(selectedPath, 'before');
    const value = manifest([{
      documentKind: 'markdown',
      id: 'docs',
      path: 'docs/a.md',
      pathType: 'file',
    }]);
    const loaded = await load(fixture, value);
    let changed = false;
    await expect(selectDeclaredSourceFiles(fixture.checkout, loaded, {
      afterFileStat: async () => {
        if (!changed) {
          changed = true;
          await writeFile(selectedPath, 'changed-source');
        }
      },
    })).rejects.toMatchObject({ code: 'SOURCE_SELECTION_CHANGED' });

    await writeManifest(fixture.sourceRoot, value);
    const manifestPath = join(fixture.sourceRoot, '.buildlore/sources.json');
    await expect(readSourceCollectionManifest(fixture.checkout, 'alpha', {
      afterManifestStat: async () => {
        await writeFile(manifestPath, `${serializeCanonicalJson(
          parseSourceCollectionManifest(value),
        )}\n`);
      },
    })).rejects.toMatchObject({ code: 'SOURCE_SELECTION_CHANGED' });
  });

  it('keeps the public schema closed and aligned with codec variants', async () => {
    const schema = JSON.parse(
      await readFile(
        new URL('../schemas/source-collection-manifest.schema.json', import.meta.url),
        'utf8',
      ),
    ) as {
      readonly additionalProperties: boolean;
      readonly properties: {
        readonly projectId: { readonly $ref: string };
        readonly sourceRepository: { readonly $ref: string };
        readonly sources: {
          readonly maxItems: number;
          readonly minItems: number;
          readonly items: { readonly oneOf: readonly unknown[] };
        };
      };
      readonly required: readonly string[];
      readonly $defs: {
        readonly directoryDeclaration: { readonly additionalProperties: boolean };
        readonly fileDeclaration: { readonly additionalProperties: boolean };
        readonly projectId: {
          readonly allOf: readonly [unknown, { readonly not: { readonly enum: readonly string[] } }];
        };
        readonly relativePath: { readonly maxLength: number; readonly pattern: string };
        readonly safeId: { readonly pattern: string };
        readonly sourceRepository: {
          readonly anyOf: readonly { readonly pattern: string }[];
        };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['projectId', 'schemaVersion', 'sourceRepository', 'sources']);
    expect(schema.properties.sources).toMatchObject({
      maxItems: MAX_SOURCE_DECLARATIONS,
      minItems: 1,
    });
    expect(schema.properties.sources.items.oneOf).toHaveLength(2);
    expect(schema.$defs.fileDeclaration.additionalProperties).toBe(false);
    expect(schema.$defs.directoryDeclaration.additionalProperties).toBe(false);
    expect(schema.properties.projectId.$ref).toBe('#/$defs/projectId');
    expect(schema.$defs.projectId.allOf[1].not.enum).toEqual([
      'knowledge',
      'manifest',
      'projects',
      'shared',
    ]);
    const safeIdPattern = new RegExp(schema.$defs.safeId.pattern, 'u');
    const schemaAcceptsProjectId = (value: string): boolean =>
      safeIdPattern.test(value) && !schema.$defs.projectId.allOf[1].not.enum.includes(value);
    expect(schemaAcceptsProjectId('alpha')).toBe(true);
    expect(schemaAcceptsProjectId('knowledge')).toBe(false);
    expect(schema.properties.sourceRepository.$ref).toBe('#/$defs/sourceRepository');
    const repositoryPatterns = schema.$defs.sourceRepository.anyOf.map(
      ({ pattern }) => new RegExp(pattern, 'u'),
    );
    const schemaAcceptsRepository = (value: string): boolean =>
      repositoryPatterns.some((pattern) => pattern.test(value));
    expect(schemaAcceptsRepository('https://example.test/alpha.git')).toBe(true);
    expect(schemaAcceptsRepository('git@example.test:alpha.git')).toBe(true);
    expect(schemaAcceptsRepository('../alpha.git')).toBe(true);
    expect(schemaAcceptsRepository('/private/alpha.git')).toBe(false);
    expect(schemaAcceptsRepository('C:\\private\\alpha.git')).toBe(false);
    expect(schemaAcceptsRepository('https://user@example.test/alpha.git')).toBe(false);
    expect(schemaAcceptsRepository(' alpha.git ')).toBe(false);
    expect(schema.$defs.relativePath.maxLength).toBe(MAX_SOURCE_PATH_LENGTH);
    const relativePathPattern = new RegExp(schema.$defs.relativePath.pattern, 'u');
    expect(relativePathPattern.test('docs/guide.md')).toBe(true);
    expect(relativePathPattern.test('docs/./guide.md')).toBe(false);
    expect(relativePathPattern.test('.git/config.md')).toBe(false);
    expect(relativePathPattern.test('C:/docs/guide.md')).toBe(false);
    expect(relativePathPattern.test('docs//guide.md')).toBe(false);
    expect(relativePathPattern.test('docs/')).toBe(false);
    expect(relativePathPattern.test('..notes/guide.md')).toBe(true);
    expect(relativePathPattern.test('docs/access-token/value.md')).toBe(false);
    expect(relativePathPattern.test('docs/ACCESS_TOKEN/value.md')).toBe(false);
    expect(relativePathPattern.test('docs/guide\u2060.md')).toBe(false);
    expect(relativePathPattern.test(`${'a/'.repeat(64)}guide.md`)).toBe(false);
  });

  it('does not write to the source checkout during manifest read or selection', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceRoot, 'docs'));
    await writeFile(join(fixture.sourceRoot, 'docs/a.md'), '# A\n');
    const loaded = await load(fixture, manifest([{
      documentKind: 'markdown',
      id: 'docs',
      path: 'docs',
      pathType: 'directory',
      recursive: true,
    }]));
    const before = await readdir(fixture.sourceRoot, { recursive: true });
    const sourceBefore = await readFile(join(fixture.sourceRoot, 'docs/a.md'), 'utf8');
    await selectDeclaredSourceFiles(fixture.checkout, loaded);
    expect(await readdir(fixture.sourceRoot, { recursive: true })).toEqual(before);
    expect(await readFile(join(fixture.sourceRoot, 'docs/a.md'), 'utf8')).toBe(sourceBefore);
  });
});
