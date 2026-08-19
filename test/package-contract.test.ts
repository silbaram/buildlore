import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface PackageContract {
  readonly bin: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly engines: Readonly<Record<string, string>>;
  readonly packageManager: string;
  readonly scripts: Readonly<Record<string, string>>;
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

describe('package contract', () => {
  it('pins the approved runtime and development toolchain exactly', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageContract;

    expect(packageJson.packageManager).toBe('npm@11.19.0');
    expect(packageJson.bin).toEqual({ buildlore: './dist/cli/bin.js' });
    expect(packageJson.dependencies).toBeUndefined();
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
});
