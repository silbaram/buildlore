import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectArchive, packLocal } from './pack-local.mjs';

/** @param {unknown} metadata */
export function releaseIdentity(metadata) {
  assert(metadata && typeof metadata === 'object' && 'name' in metadata && metadata.name === 'buildlore', 'Unexpected package name.');
  assert('private' in metadata && metadata.private === true, 'Keep the package private to the npm registry.');
  assert('version' in metadata && typeof metadata.version === 'string' &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u.test(metadata.version), 'Invalid release version.');
  const version = metadata.version;
  const filename = `buildlore-${version}.tgz`, tag = `v${version}`;
  const url = `https://github.com/silbaram/buildlore/releases/download/${tag}/${filename}`;
  return { version, filename, tag, url };
}

/** @param {ReturnType<typeof releaseIdentity>} identity @param {string} sha256 */
export function releaseNotes(identity, sha256) {
  assert(/^[a-f0-9]{64}$/u.test(sha256), 'Invalid archive checksum.');
  return `# BuildLore ${identity.version}

Install this prebuilt npm archive in your knowledge Git checkout. Node.js 24+, npm 11
(reference: 11.19.0) and Git are required. No product source checkout, user build or global
installation is needed. Dependencies may still be downloaded from the npm registry.

The commands below work after these assets are published with the matching tag.

\`\`\`sh
cd my-knowledge
npm install --save-exact "${identity.url}"
npx --no buildlore workspace init --json
\`\`\`

To upgrade, stop running BuildLore MCP/client processes, run the same install command
with the new version's asset URL in this directory, check \`npx --no buildlore --version\`
and \`npx --no buildlore workspace check --project <id> --client codex\`, then restart
the client. Initialization is a first-install/restore step, not a routine upgrade step.
Each source project's MCP uses this installation; it does not need another package copy.

Retain the previous version URL/archive and lockfile before upgrading. To roll back,
install that compatible previous archive/URL explicitly and check the existing Wiki.
Installation does not migrate or approve knowledge. Commit reviewed npm metadata
separately from Wiki publication. A fresh clone can use \`npm ci\` while the recorded
URL remains available; restore machine-local source bindings as documented in README.

Linux/WSL is the tested runtime. Native Windows authoring validation remains pending;
Windows folders use existing ACLs. macOS and paid AI quality evaluation are unverified.
See the packaged RELEASE.md for verification and compatibility limits.

## Assets

- Package: \`${identity.filename}\`
- SHA-256: \`${sha256}\` (also in SHA256SUMS)
- Git tag: \`${identity.tag}\`

Upload the identical verified archive and SHA256SUMS. Do not replace an existing
version's archive or use GitHub's automatic source-code archive as this npm package.
These files were prepared locally; preparation alone does not prove tests passed or
that a GitHub Release was published. This package is not published to the npm registry.
`;
}

/** Resolve existing ancestors without creating the destination.
 * @param {string} path
 */
async function canonicalDestination(path) {
  let ancestor = resolve(path);
  const missing = [];
  for (;;) {
    try { return resolve(await realpath(ancestor), ...missing); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = dirname(ancestor);
      assert.notEqual(parent, ancestor, 'Cannot resolve output ancestor.');
      missing.unshift(basename(ancestor)); ancestor = parent;
    }
  }
}

/** @param {string} repo @param {string} output */
async function assertOutsideInputs(repo, output) {
  const destination = await canonicalDestination(output);
  for (const name of ['src', 'dist', 'schemas', 'profiles', 'skills', 'test', 'node_modules']) {
    const input = await canonicalDestination(join(repo, name));
    const path = relative(input, destination);
    assert(path && (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)), 'Output must be outside package inputs.');
  }
  return destination;
}

/** Prepare local assets only. Existing output files are never replaced.
 * @param {string} repo @param {string} output @param {string} npm
 */
export async function prepareRelease(repo, output, npm) {
  const identity = releaseIdentity(JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')));
  await assertOutsideInputs(repo, output);
  await mkdir(output, { recursive: true });
  const stat = await lstat(output);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Output must be a regular directory.');
  // Pin the canonical directory so a parent alias cannot redirect staging/publication.
  output = await assertOutsideInputs(repo, output);
  assert.equal((await readdir(output)).length, 0, 'Use an empty output directory; existing release assets must not be replaced.');
  const staging = await mkdtemp(join(output, '.prepare-'));
  const created = [];
  try {
    const packed = await packLocal(repo, staging, npm);
    assert.equal(packed.filename, identity.filename, 'Package version and archive name differ.');
    const inspected = await inspectArchive(repo, join(staging, packed.filename));
    assert.equal(inspected.sha256, packed.sha256);
    await writeFile(join(staging, 'SHA256SUMS'), `${packed.sha256}  ${identity.filename}\n`, { flag: 'wx' });
    await writeFile(join(staging, 'release-notes.md'), releaseNotes(identity, packed.sha256), { flag: 'wx' });
    for (const filename of [identity.filename, 'SHA256SUMS', 'release-notes.md']) {
      // Hard-link publication is exclusive, including if another preparation races us.
      await link(join(staging, filename), join(output, filename)); created.push(filename);
    }
    return { ...identity, sha256: packed.sha256, integrity: packed.integrity, size: packed.size,
      assets: created, published: false, verified: false };
  } catch (error) {
    for (const filename of created) await rm(join(output, filename));
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.length === 4 && process.argv[2] === '--output', 'Usage: npm run release:prepare -- --output <empty-directory>');
  assert(process.env.npm_execpath, 'Run through npm@11.19.0.');
  const output = resolve(process.argv[3]);
  const result = await prepareRelease(resolve(import.meta.dirname, '..'), output, process.env.npm_execpath);
  process.stdout.write(JSON.stringify(result) + '\n');
}
