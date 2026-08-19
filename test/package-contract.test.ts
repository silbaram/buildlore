import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface PackageContract {
  readonly bin: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly engines: Readonly<Record<string, string>>;
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
} as const;

describe('package contract', () => {
  it('pins the approved runtime and development toolchain exactly', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageContract;

    expect(packageJson.packageManager).toBe('npm@11.19.0');
    expect(packageJson.bin).toEqual({ buildlore: './dist/cli/bin.js' });
    expect(packageJson.dependencies).toEqual(approvedRuntimeDependencies);
    expect(packageJson.engines).toEqual({ node: '>=24', npm: '>=11 <12' });
    expect(packageJson.devDependencies).toEqual(approvedDevDependencies);
    expect(packageJson.scripts).toEqual({
      build: 'tsc -p tsconfig.build.json',
      lint: 'eslint . --max-warnings 0',
      'p2a:init': 'node scripts/bootstrap-p2a.mjs',
      test: 'vitest run',
      typecheck: 'tsc -p tsconfig.json --noEmit',
    });
  });

  it('locks the public compiler package without deep imports', async () => {
    const packageLock = JSON.parse(
      await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    ) as PackageLockContract;
    expect(packageLock.packages['']?.dependencies).toEqual(approvedRuntimeDependencies);
    expect(packageLock.packages['node_modules/llm-wiki-compiler']).toMatchObject({
      version: '1.1.0',
    });
    expect(packageLock.packages['node_modules/llm-wiki-compiler']?.integrity).toMatch(/^sha512-/u);

    const adapterSource = await readFile(
      new URL('../src/compiler/index.ts', import.meta.url),
      'utf8',
    );
    expect(adapterSource).toContain("from 'llm-wiki-compiler'");
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
  });
});
