import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { inspectArchive, inspectHistoricalArchive } from './pack-local.mjs';
import { releaseIdentity } from './prepare-release.mjs';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const npm = process.env.npm_execpath;
assert(npm, 'Run through npm@11.19.0.');
assert.equal((await exec(process.execPath, [npm, '--version'])).stdout.trim(), '11.19.0');
const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === '--archive' && args[2] === '--previous-archive',
  'Usage: npm run verify:release-install -- --archive <candidate.tgz> --previous-archive <compatible-previous.tgz>');
const candidatePath = resolve(args[1]), previousPath = resolve(args[3]);
const candidate = await inspectArchive(repo, candidatePath), previous = await inspectHistoricalArchive(previousPath);
/** @param {string} path */
async function identity(path) {
  const result = await exec('tar', ['-xOf', path, 'package/package.json']);
  return releaseIdentity(JSON.parse(result.stdout));
}
const current = await identity(candidatePath), old = await identity(previousPath);
assert.equal(current.filename, candidate.filename); assert.equal(old.filename, previous.filename);
assert.notEqual(current.version, old.version, 'Use an actual different previous package version.');
const assets = new Map([
  [`/releases/download/${current.tag}/${current.filename}`, await readFile(candidatePath)],
  [`/releases/download/${old.tag}/${old.filename}`, await readFile(previousPath)],
]);
/** @type {Map<string, number>} */
const downloads = new Map();
const server = createServer((request, response) => {
  const path = request.url ?? '', bytes = assets.get(path);
  if (request.method !== 'GET' || !bytes) { response.writeHead(404); response.end(); return; }
  downloads.set(path, (downloads.get(path) ?? 0) + 1);
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }); response.end(bytes);
});
const root = await mkdtemp(join(tmpdir(), 'buildlore-release-install-'));
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const support = join(root, 'support'); await mkdir(support);
  await exec(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit', 'false', '--rootDir', '.', '--outDir', support], { cwd: repo, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(support, 'package.json'), '{"type":"module"}\n');
  await symlink(join(repo, 'node_modules'), join(support, 'node_modules'), 'junction');
  /** @type {typeof import('../test/helpers/installed-workspace.js')} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Compiled project-owned verification helper.
  const helper = await import(pathToFileURL(join(support, 'test/helpers/installed-workspace.js')).href);
  await helper.verifyInstalledWorkspace(candidatePath, [repo, support], {
    candidateUrl: `${base}/releases/download/${current.tag}/${current.filename}`,
    previousUrl: `${base}/releases/download/${old.tag}/${old.filename}`,
    candidateVersion: current.version, previousVersion: old.version, candidateIntegrity: candidate.integrity,
  });
  assert(downloads.get(`/releases/download/${current.tag}/${current.filename}`) >= 2, 'Candidate must be fetched for install and fresh clone.');
  assert(downloads.get(`/releases/download/${old.tag}/${old.filename}`) >= 1);
  process.stdout.write(JSON.stringify({ releaseInstall: 'passed', candidate: current.version, previous: old.version,
    candidateSha256: candidate.sha256, previousSha256: previous.sha256,
    delivery: 'local HTTP tarball endpoint; actual GitHub HTTPS delivery remains a post-publication check', published: false }) + '\n');
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
