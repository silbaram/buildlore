import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'buildlore-installed-workspace-'));
const npm = process.env.npm_execpath;
assert(npm, 'Run through npm@11.19.0.');
try {
  assert.equal((await exec(process.execPath, [npm, '--version'])).stdout.trim(), '11.19.0');
  await exec(process.execPath, [npm, 'run', 'build'], { cwd: repo });
  const output = await exec(process.execPath, [npm, 'pack', '--json', '--pack-destination', root], { cwd: repo });
  /** @type {unknown} */
  const raw = JSON.parse(output.stdout);
  assert(Array.isArray(raw) && raw.length === 1);
  /** @type {unknown} */
  const first = raw[0];
  assert(first && typeof first === 'object' && 'filename' in first && typeof first.filename === 'string' && 'files' in first && Array.isArray(first.files));
  /** @type {unknown[]} */
  const files = first.files;
  for (const file of files) {
    assert(file && typeof file === 'object' && 'path' in file && typeof file.path === 'string');
    assert(!/^(?:src|test|plans|\.plan2agent|knowledge|node_modules)\//u.test(file.path));
  }
  const paths = files.map(file => {
    assert(file && typeof file === 'object' && 'path' in file && typeof file.path === 'string');
    return file.path;
  });
  for (const required of ['dist/cli/bin.js', 'schemas/workspace-guide.schema.json',
    'skills/buildlore-authoring/SKILL.md', 'skills/buildlore-activation/SKILL.md']) assert(paths.includes(required));
  /** @type {{ private: boolean, packageManager: string, exports: Record<string, string | Record<string, string>> }} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Package metadata is checked below.
  const metadata = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  assert.equal(metadata.private, true);
  assert.equal(metadata.packageManager, 'npm@11.19.0');
  for (const entry of Object.values(metadata.exports)) {
    for (const path of typeof entry === 'string' ? [entry] : Object.values(entry)) assert(paths.includes(path.replace(/^\.\//u, '')));
  }
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
    exportsPresent: true, private: true, published: false }) + '\n');
} finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
