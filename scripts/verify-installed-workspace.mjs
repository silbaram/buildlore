import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { inspectArchive, packLocal } from './pack-local.mjs';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'buildlore-installed-workspace-'));
const npm = process.env.npm_execpath;
assert(npm, 'Run through npm@11.19.0.');
try {
  assert.equal((await exec(process.execPath, [npm, '--version'])).stdout.trim(), '11.19.0');
  const args = process.argv.slice(2);
  assert(args.length === 0 || args.length === 2 && args[0] === '--archive', 'Usage: verify:installed-workspace [--archive <tgz>]');
  await exec(process.execPath, [npm, 'audit', '--omit=dev', '--audit-level=moderate'], { cwd: repo });
  const first = args.length === 0 ? await packLocal(repo, root, npm) : await inspectArchive(repo, resolve(args[1]));
  // The fixture removes its first copy to verify clone/reinstall. Never remove the delivered archive.
  if (args.length) await cp(resolve(args[1]), join(root, first.filename));
  const support = join(root, 'support');
  await mkdir(support);
  await exec(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit', 'false', '--rootDir', '.', '--outDir', support], { cwd: repo, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(support, 'package.json'), '{"type":"module"}\n');
  await symlink(join(repo, 'node_modules'), join(support, 'node_modules'), 'junction');
  /** @type {typeof import('../test/helpers/installed-workspace.js')} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Compiled, task-owned verification helper.
  const helper = await import(pathToFileURL(join(support, 'test/helpers/installed-workspace.js')).href);
  await helper.verifyInstalledWorkspace(join(root, first.filename), [repo, support]);
  process.stdout.write(JSON.stringify({ package: first.filename, size: 'size' in first ? first.size : null,
    unpackedSize: 'unpackedSize' in first ? first.unpackedSize : null, integrity: 'integrity' in first ? first.integrity : null,
    exportsPresent: true, published: false }) + '\n');
} finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
