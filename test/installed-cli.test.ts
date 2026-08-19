import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

function runForExitCode(command: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error) => {
      if (error === null) {
        resolve(0);
        return;
      }

      if (typeof error.code === 'number') {
        resolve(error.code);
        return;
      }

      reject(new Error(error.message, { cause: error }));
    });
  });
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  shell = false,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, encoding: 'utf8', shell },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${command} failed:\n${stdout}${stderr}`, { cause: error }));
          return;
        }

        resolve({ stderr, stdout });
      },
    );
  });
}

interface PackageJson {
  readonly bin: Readonly<Record<string, string>>;
}

describe('installed CLI', () => {
  it('executes through a package-style bin link', async () => {
    const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
    const temporaryBase = join(repositoryRoot, '.test-tmp');
    await mkdir(temporaryBase, { recursive: true });
    const temporaryRoot = await mkdtemp(join(temporaryBase, 'buildlore-installed-cli-'));
    const packageRoot = join(temporaryRoot, 'package');
    const consumerRoot = join(temporaryRoot, 'consumer');

    try {
      await mkdir(packageRoot);
      await mkdir(consumerRoot);
      await Promise.all(
        ['LICENSE', 'README.md', 'package.json'].map(async (file) =>
          copyFile(join(repositoryRoot, file), join(packageRoot, file)),
        ),
      );

      await run(
        process.execPath,
        [
          fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
          '--project',
          join(repositoryRoot, 'tsconfig.build.json'),
          '--outDir',
          join(packageRoot, 'dist'),
        ],
        repositoryRoot,
      );

      const installedRoot = join(consumerRoot, 'node_modules', 'buildlore');
      const binaryDirectory = join(consumerRoot, 'node_modules', '.bin');
      await cp(packageRoot, installedRoot, { recursive: true });
      await mkdir(binaryDirectory, { recursive: true });

      const packageJson = JSON.parse(
        await readFile(join(installedRoot, 'package.json'), 'utf8'),
      ) as PackageJson;
      const binaryTarget = packageJson.bin.buildlore;
      expect(binaryTarget).toBe('./dist/cli/bin.js');
      if (binaryTarget === undefined) {
        throw new Error('buildlore bin target is missing');
      }

      await chmod(join(installedRoot, binaryTarget), 0o755);

      const executable = join(
        binaryDirectory,
        process.platform === 'win32' ? 'buildlore.cmd' : 'buildlore',
      );
      if (process.platform !== 'win32') {
        await symlink(`../buildlore/${binaryTarget.slice(2)}`, executable);
      }
      const exitCode = await runForExitCode(
        process.execPath,
        process.platform === 'win32'
          ? [join(installedRoot, binaryTarget), 'unsupported']
          : [executable, 'unsupported'],
        consumerRoot,
      );

      expect(exitCode).toBe(2);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 30_000);
});
