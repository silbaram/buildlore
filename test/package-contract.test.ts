import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface PackageContract {
  readonly bin: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly engines: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly files: readonly string[];
  readonly packageManager: string;
  readonly scripts: Readonly<Record<string, string>>;
}

interface PackageLockContract {
  readonly packages: Readonly<Record<string, {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly integrity?: string;
    readonly version?: string;
  }>>;
}

const compilerIntegrity =
  'sha512-LJslVmSt8tng8n3t0tw1QEqZJKKD0ualJ/WupdZMCtCzmCNarkP999k6hiNIg5ezvE8B/JQ1C1bUi6eY88Q79A==';

const approvedDevDependencies = {
  '@eslint/js': '10.0.1',
  '@types/node': '24.13.3',
  eslint: '10.8.1',
  globals: '17.11.0',
  typescript: '6.0.3',
  'typescript-eslint': '8.67.0',
  vitest: '4.1.11',
} as const;

const approvedRuntimeDependencies = {
  'llm-wiki-compiler': '1.1.0',
  yaml: '2.9.0',
} as const;

describe('package contract', () => {
  it('pins the approved runtime and development toolchain exactly', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageContract;

    expect(packageJson.packageManager).toBe('npm@11.19.0');
    expect(packageJson.bin).toEqual({ buildlore: './dist/cli/bin.js' });
    expect(packageJson.exports['./schemas/source-document.schema.json']).toBe(
      './schemas/source-document.schema.json',
    );
    expect(packageJson.exports['./schemas/lifecycle-profile.schema.json']).toBe(
      './schemas/lifecycle-profile.schema.json',
    );
    expect(packageJson.exports['./schemas/retrieval-corpus.schema.json']).toBe(
      './schemas/retrieval-corpus.schema.json',
    );
    expect(packageJson.exports['./schemas/retrieval-evaluation.schema.json']).toBe(
      './schemas/retrieval-evaluation.schema.json',
    );
    expect(packageJson.exports['./profiles/buildlore.profile.v1.json']).toBe(
      './profiles/buildlore.profile.v1.json',
    );
    expect(packageJson.files).toEqual(['dist', 'schemas', 'profiles']);
    expect(packageJson.dependencies).toEqual(approvedRuntimeDependencies);
    expect(packageJson.engines).toEqual({ node: '>=24', npm: '>=11 <12' });
    expect(packageJson.devDependencies).toEqual(approvedDevDependencies);
    expect(packageJson.scripts).toEqual({
      build: 'tsc -p tsconfig.build.json',
      'eval:retrieval': 'npm run build --silent && node dist/retrieval/evaluation/cli.js',
      lint: 'eslint . --max-warnings 0',
      'p2a:init': 'node scripts/bootstrap-p2a.mjs',
      test: 'vitest run',
      typecheck: 'tsc -p tsconfig.json --noEmit',
    });
  });

  it('[V9-V-24][V10-V-16] locks package-root SDK and forbids dependency/boundary expansion', async () => {
    const packageLock = JSON.parse(
      await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    ) as PackageLockContract;
    expect(packageLock.packages['']?.dependencies).toEqual(approvedRuntimeDependencies);
    expect(packageLock.packages['node_modules/llm-wiki-compiler']).toMatchObject({
      version: '1.1.0',
    });
    expect(packageLock.packages['node_modules/llm-wiki-compiler']?.integrity).toBe(
      compilerIntegrity,
    );
    expect(packageLock.packages['node_modules/yaml']).toMatchObject({
      integrity:
        'sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==',
      version: '2.9.0',
    });

    const adapterSource = await readFile(
      new URL('../src/compiler/backend.ts', import.meta.url),
      'utf8',
    );
    expect(adapterSource).toContain("from 'llm-wiki-compiler'");
    expect(adapterSource).not.toMatch(/\btype\s+Wiki\b/u);
    const publicCompilerSource = await readFile(
      new URL('../src/compiler/index.ts', import.meta.url),
      'utf8',
    );
    expect(publicCompilerSource).not.toContain('createLlmWikiCompilerBackend');
    expect(publicCompilerSource).not.toContain('createProjectEmbeddingIdentityStore');
    expect(publicCompilerSource).not.toContain('ProjectEmbeddingIdentityPort');
    const sourceRoot = new URL('../src/', import.meta.url);
    const sourcePaths = (await readdir(sourceRoot, { recursive: true })).filter((path) =>
      path.endsWith('.ts'),
    );
    const allSource = (
      await Promise.all(
        sourcePaths.map(async (path) =>
          readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8'),
        ),
      )
    ).join('\n');
    expect(allSource).not.toMatch(/from\s+['"]llm-wiki-compiler\//u);
    const retrievalSource = (
      await Promise.all(
        sourcePaths
          .filter((path) => path.startsWith('retrieval/'))
          .map(async (path) =>
            readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8'),
          ),
      )
    ).join('\n');
    expect(retrievalSource).not.toMatch(/Intl\.Segmenter/u);
    expect(retrievalSource).not.toMatch(/from\s+['"](?:garu-ko|node:child_process|llm-wiki-compiler\/)/u);
    const compilerSource = (
      await Promise.all(
        sourcePaths
          .filter((path) => path.startsWith('compiler/'))
          .map(async (path) =>
            readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8'),
          ),
      )
    ).join('\n');
    const externalImports = [
      ...compilerSource.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
    ]
      .map((match) => match[1])
      .filter(
        (specifier): specifier is string =>
          specifier !== undefined &&
          !specifier.startsWith('.') &&
          !specifier.startsWith('node:'),
      );
    expect([...new Set(externalImports)]).toEqual(['llm-wiki-compiler']);
    expect(compilerSource).not.toMatch(/node:child_process|Promise\.race|process\.(?:on|once)\(/u);

    const projectionSource = (
      await Promise.all(
        sourcePaths
          .filter((path) => path.startsWith('projector/') || path.startsWith('sanitizer/'))
          .map(async (path) =>
            readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8'),
          ),
      )
    ).join('\n');
    const projectionExternalImports = [
      ...projectionSource.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
    ]
      .map((match) => match[1])
      .filter(
        (specifier): specifier is string =>
          specifier !== undefined &&
          !specifier.startsWith('.') &&
          !specifier.startsWith('node:'),
      );
    expect([...new Set(projectionExternalImports)]).toEqual(['yaml']);
    expect(projectionSource).not.toMatch(
      /node:child_process|from\s+['"]plan2agent(?:\/|['"])|Date\.now\s*\(|new\s+Date\s*\(\s*\)|\bmtime(?:Ms|Ns)?\b|\b(?:YAML|yaml)\.stringify\b|\bstringifyDocument\b/u,
    );
  });

  it('keeps the CLI on domain ports without upstream CLI fallback or stdout scraping', async () => {
    const cliRoot = new URL('../src/cli/', import.meta.url);
    const cliPaths = (await readdir(cliRoot, { recursive: true }))
      .filter((path) => path.endsWith('.ts'));
    const cliSource = (
      await Promise.all(
        cliPaths.map(async (path) =>
          readFile(new URL(path.replaceAll('\\', '/'), cliRoot), 'utf8')),
      )
    ).join('\n');

    expect(cliSource).not.toMatch(/from\s+['"]llm-wiki-compiler(?:\/|['"])/u);
    expect(cliSource).not.toMatch(/node:child_process|\b(?:exec|execFile|spawn|fork)\s*\(/u);
    expect(cliSource).not.toMatch(/JSON\.parse\s*\([^)]*\.stdout|\.stdout\s*\.\s*(?:match|split|trim)\s*\(/u);
  });

  it('[V11-V-23] forbids Git authority, unsafe commands, services, and dependency expansion outside knowledge', async () => {
    const sourceRoot = new URL('../src/', import.meta.url);
    const sourcePaths = (await readdir(sourceRoot, { recursive: true }))
      .filter((path) => path.endsWith('.ts'));
    const readSources = async (prefixes: readonly string[]): Promise<string> => (
      await Promise.all(sourcePaths
        .filter((path) => prefixes.some((prefix) => path.startsWith(prefix)))
        .map(async (path) => readFile(
          new URL(path.replaceAll('\\', '/'), sourceRoot),
          'utf8',
        )))
    ).join('\n');
    const nonKnowledgeGitConsumers = await readSources(['compiler/', 'projector/', 'retrieval/']);
    expect(nonKnowledgeGitConsumers).not.toMatch(
      /knowledge\/(?:git-machine|parent-pin|publication|repository-writer-lease)/u,
    );

    const allSource = await readSources(['']);
    expect(allSource).not.toMatch(/from\s+['"]llm-wiki-compiler\//u);
    expect(allSource).not.toMatch(/\bGIT_INDEX_FILE\b/u);
    expect(allSource).not.toMatch(/['"](?:pull|rebase|stash)['"]/u);
    expect(allSource).not.toMatch(/['"]--force(?:-with-lease)?['"]/u);
    expect(allSource).not.toMatch(
      /from\s+['"](?:express|fastify|pg|postgres|sqlite3|better-sqlite3|node:http|node:http2)['"]/u,
    );
    expect(allSource).not.toMatch(/['"](?:checkout|switch)['"][\s\S]{0,80}['"]-(?:b|c)['"]/u);

    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageContract;
    expect(packageJson.dependencies).toEqual(approvedRuntimeDependencies);
  });
});
