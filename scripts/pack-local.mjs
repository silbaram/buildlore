import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/** @param {string} directory @param {string} [prefix] @returns {Promise<string[]>} */
async function filesIn(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'Package inputs must not be symbolic links.');
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(join(directory, entry.name), path + '/'));
    else { assert(entry.isFile()); files.push(path); }
  }
  return files;
}
/** @param {string} repo @param {Set<string>} paths @param {unknown} metadata */
async function inspectEntries(repo, paths, metadata) {
  const expectedDist = new Set((await filesIn(join(repo, 'src'))).filter(p => p.endsWith('.ts')).flatMap(p =>
    ['.js', '.js.map', '.d.ts', '.d.ts.map'].map(suffix => `dist/${p.slice(0, -3)}${suffix}`)));
  for (const path of paths) {
    assert(/^(?:dist|schemas|profiles|skills)\//u.test(path) || ['package.json', 'README.md', 'README.ko.md', 'LICENSE', 'CHANGELOG.md', 'RELEASE.md'].includes(path), 'Unexpected package file.');
    if (path.startsWith('dist/')) assert(expectedDist.has(path), 'Orphan build output in package.');
  }
  for (const path of expectedDist) assert(paths.has(path), 'Missing compiled package file.');
  for (const path of ['dist/cli/bin.js', 'LICENSE', 'README.md', 'README.ko.md', 'RELEASE.md', 'CHANGELOG.md',
    'skills/buildlore-authoring/SKILL.md', 'skills/buildlore-activation/SKILL.md']) assert(paths.has(path), 'Missing release asset.');
  assert(metadata && typeof metadata === 'object' && 'exports' in metadata && metadata.exports && typeof metadata.exports === 'object');
  /** @type {unknown[]} */
  const entries = Object.values(metadata.exports);
  for (const entry of entries) {
    assert(typeof entry === 'string' || entry && typeof entry === 'object');
    for (const path of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      assert(typeof path === 'string' && paths.has(path.replace(/^\.\//u, '')), 'Missing public export.');
    }
  }

}
/** Inspect a supplied archive without extracting files or modifying it.
 * @param {string} repo @param {string} archive
 */
export async function inspectArchive(repo, archive) {
  const listing = await exec('tar', ['-tzf', archive], { maxBuffer: 8 * 1024 * 1024 });
  const entries = listing.stdout.trim().split('\n');
  assert(entries.every(p => p.startsWith('package/') && !p.includes('..') && !p.includes('\\')), 'Invalid archive paths.');
  const paths = new Set(entries.map(p => p.slice('package/'.length)));
  assert.equal(paths.size, entries.length, 'Duplicate archive paths.');
  /** @type {unknown} */
  const metadata = JSON.parse((await exec('tar', ['-xOf', archive, 'package/package.json'], { maxBuffer: 1024 * 1024 })).stdout);
  await inspectEntries(repo, paths, metadata);
  const bytes = await readFile(archive);
  return { filename: basename(archive), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, entryCount: paths.size, published: false };
}

/** Build and inspect the exact archive that will be delivered. Never publishes.
 * @param {string} repo @param {string} output @param {string} npm
 */
export async function packLocal(repo, output, npm) {
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node.js 24+ is required.');
  assert.equal((await exec(process.execPath, [npm, '--version'])).stdout.trim(), '11.19.0', 'Use npm@11.19.0.');
  await mkdir(output, { recursive: true });
  // The package prepack hook performs the clean build, including plain npm pack.
  const result = await exec(process.execPath, [npm, 'pack', '--json', '--pack-destination', output], { cwd: repo, maxBuffer: 8 * 1024 * 1024 });
  /** @type {unknown} */
  const raw = JSON.parse(result.stdout);
  assert(Array.isArray(raw) && raw.length === 1);
  /** @type {unknown} */
  const packed = raw[0];
  assert(packed && typeof packed === 'object' && 'filename' in packed && typeof packed.filename === 'string' &&
    basename(packed.filename) === packed.filename && 'files' in packed && Array.isArray(packed.files) &&
    'integrity' in packed && typeof packed.integrity === 'string');
  const paths = new Set(packed.files.map((/** @type {unknown} */ file) => {
    assert(file && typeof file === 'object' && 'path' in file && typeof file.path === 'string'); return file.path;
  }));
  /** @type {unknown} */
  const metadata = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  await inspectEntries(repo, paths, metadata);
  const bytes = await readFile(join(output, packed.filename));
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, packed.integrity);
  return { filename: packed.filename, integrity: packed.integrity, sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length, unpackedSize: 'unpackedSize' in packed ? packed.unpackedSize : null, entryCount: paths.size, published: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.length === 4 && process.argv[2] === '--output', 'Usage: npm run pack:local -- --output <directory>');
  assert(process.env.npm_execpath, 'Run through npm@11.19.0.');
  const output = resolve(process.argv[3]);
  const packed = await packLocal(resolve(import.meta.dirname, '..'), output, process.env.npm_execpath);
  process.stdout.write(JSON.stringify({ ...packed, directory: output,
    next: 'In your knowledge Git checkout: npm install --save-exact <archive>; npx --no buildlore workspace init' }) + '\n');
}
