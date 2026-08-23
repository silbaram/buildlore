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
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'buildlore-installed-cli-runtime-'));
    const packageRoot = join(temporaryRoot, 'package');
    const consumerRoot = join(temporaryRoot, 'consumer');
    const workspaceRoot = join(runtimeRoot, 'workspace');

    try {
      await mkdir(packageRoot);
      await mkdir(consumerRoot);
      await mkdir(workspaceRoot);
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
      const installedCommand = process.platform === 'win32'
        ? join(installedRoot, binaryTarget)
        : executable;
      const help = await run(process.execPath, [installedCommand, '--help'], consumerRoot);
      expect(help.stderr).toBe('');
      for (const command of [
        'sync',
        'compile',
        'check',
        'search',
        'query',
        'context',
        'publish plan',
        'publish commit',
        'publish push',
        'knowledge pin plan',
        'knowledge pin commit',
      ]) {
        expect(help.stdout).toContain(`buildlore ${command}`);
      }

      const knowledgeOrigin = join(runtimeRoot, 'knowledge.git');
      const knowledgeSeed = join(runtimeRoot, 'knowledge-seed');
      await run('git', ['init', '--bare', '--initial-branch=main', knowledgeOrigin], runtimeRoot);
      await run(
        'git',
        ['-c', 'protocol.file.allow=always', 'clone', knowledgeOrigin, knowledgeSeed],
        runtimeRoot,
      );
      await run('git', ['config', 'user.name', 'BuildLore Test'], knowledgeSeed);
      await run('git', ['config', 'user.email', 'buildlore@example.invalid'], knowledgeSeed);
      await writeFile(join(knowledgeSeed, 'README.md'), '# Knowledge fixture\n', 'utf8');
      await run('git', ['add', 'README.md'], knowledgeSeed);
      await run('git', ['commit', '-m', 'seed knowledge'], knowledgeSeed);
      await run('git', ['push', 'origin', 'main'], knowledgeSeed);

      const initialized = await run(
        process.execPath,
        [
          installedCommand,
          'init',
          '--knowledge-repo',
          '../knowledge.git',
          '--branch',
          'main',
          '--json',
        ],
        workspaceRoot,
      );
      expect(initialized.stderr).toBe('');
      expect(JSON.parse(initialized.stdout)).toMatchObject({ command: 'init', ok: true });

      const added = await run(
        process.execPath,
        [
          installedCommand,
          'project',
          'add',
          '--id',
          'alpha',
          '--source-repo',
          'https://example.test/alpha.git',
          '--json',
        ],
        workspaceRoot,
      );
      expect(JSON.parse(added.stdout)).toMatchObject({ command: 'project.add', ok: true });
      const listed = await run(
        process.execPath,
        [installedCommand, 'project', 'list', '--json'],
        workspaceRoot,
      );
      expect(JSON.parse(listed.stdout)).toMatchObject({ command: 'project.list', ok: true });
      const shown = await run(
        process.execPath,
        [installedCommand, 'project', 'show', '--project', 'alpha', '--json'],
        workspaceRoot,
      );
      expect(JSON.parse(shown.stdout)).toMatchObject({
        command: 'project.show',
        ok: true,
        projectId: 'alpha',
      });

      const knowledgeRoot = join(workspaceRoot, 'knowledge');
      const pageDirectory = join(knowledgeRoot, 'projects', 'alpha', 'wiki', 'concepts');
      const page = join(pageDirectory, 'publication.md');
      await mkdir(pageDirectory, { recursive: true });
      await writeFile(
        page,
        '---\n' +
        'title: Publication\n' +
        'summary: Safe publication fixture.\n' +
        'sources:\n' +
        '  - source.md\n' +
        'modelId: fixture-model\n' +
        'promptVersion: v1\n' +
        '---\n' +
        '# Publication\n\nInitial body.\n',
        'utf8',
      );
      await run('git', ['config', 'user.name', 'BuildLore Test'], knowledgeRoot);
      await run('git', ['config', 'user.email', 'buildlore@example.invalid'], knowledgeRoot);
      await run('git', ['add', '.'], knowledgeRoot);
      await run('git', ['commit', '-m', 'seed project knowledge'], knowledgeRoot);
      await run('git', ['config', 'user.name', 'BuildLore Test'], workspaceRoot);
      await run('git', ['config', 'user.email', 'buildlore@example.invalid'], workspaceRoot);
      await run('git', ['add', 'knowledge'], workspaceRoot);
      await run('git', ['commit', '-m', 'pin project knowledge'], workspaceRoot);
      await writeFile(
        page,
        '---\n' +
        'title: Publication\n' +
        'summary: Safe publication fixture.\n' +
        'sources:\n' +
        '  - source.md\n' +
        'modelId: fixture-model\n' +
        'promptVersion: v1\n' +
        '---\n' +
        '# Publication\n\nUpdated body.\n',
        'utf8',
      );
      const planned = await run(
        process.execPath,
        [
          installedCommand,
          'publish',
          'plan',
          '--project',
          'alpha',
          '--source-revision',
          'b'.repeat(40),
          '--json',
        ],
        workspaceRoot,
      );
      expect(planned.stderr).toBe('');
      expect(JSON.parse(planned.stdout)).toMatchObject({
        command: 'publish.plan',
        data: { eligible: true, projectId: 'alpha' },
        ok: true,
      });

      const unconfiguredExitCode = await runForExitCode(
        process.execPath,
        [installedCommand, 'project', 'list'],
        consumerRoot,
      );
      expect(unconfiguredExitCode).toBe(6);

      const exitCode = await runForExitCode(
        process.execPath,
        [installedCommand, 'unsupported'],
        consumerRoot,
      );

      expect(exitCode).toBe(2);
    } finally {
      await Promise.all([
        rm(runtimeRoot, { force: true, recursive: true }),
        rm(temporaryRoot, { force: true, recursive: true }),
      ]);
    }
  }, 30_000);
});
