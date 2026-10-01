import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { prepareRelease, releaseIdentity, releaseNotes } from './prepare-release.mjs';
import { inspectArchive, inspectHistoricalArchive } from './pack-local.mjs';

const exec = promisify(execFile);

await test('release URLs select a compiled versioned asset and keep registry publication disabled', () => {
  const identity = releaseIdentity({ name: 'buildlore', version: '0.1.1-rc.2', private: true });
  assert.equal(identity.url, 'https://github.com/silbaram/buildlore/releases/download/v0.1.1-rc.2/buildlore-0.1.1-rc.2.tgz');
  const notes = releaseNotes(identity, 'a'.repeat(64));
  assert(notes.includes(`npm install --save-exact "${identity.url}"`));
  assert(notes.includes('Native Windows authoring validation remains pending'));
  assert(notes.includes('preparation alone does not prove tests passed'));
});

await test('invalid package identities and URL-breaking versions fail before packaging', () => {
  for (const metadata of [null, {}, { name: 'another', version: '1.0.0', private: true },
    { name: 'buildlore', version: '1.0.0', private: false },
    ...['../1.0.0', '1.0.0/latest', '01.0.0', '1.0.0+mutable', '1.0.0-..', '1.0.0-01'].map(version => ({ name: 'buildlore', version, private: true }))]) {
    assert.throws(() => releaseIdentity(metadata));
  }
});

await test('preparation refuses to overwrite existing files and rejects linked output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-release-guard-'));
  try {
    const repo = join(root, 'repo'), output = join(root, 'release');
    await mkdir(repo); await mkdir(output);
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'buildlore', version: '0.1.1-rc.2', private: true }));
    await writeFile(join(output, 'SHA256SUMS'), 'existing checksum');
    await assert.rejects(prepareRelease(repo, output, 'unused-npm'), /empty output directory/u);
    assert.equal(await readFile(join(output, 'SHA256SUMS'), 'utf8'), 'existing checksum');
    const linked = join(root, 'linked'); await symlink(output, linked, 'junction');
    await assert.rejects(prepareRelease(repo, linked, 'unused-npm'), /regular directory/u);
    await assert.rejects(prepareRelease(repo, join(repo, 'dist/release'), 'unused-npm'), /outside package inputs/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('preparation rejects symlink parents into package inputs before creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-release-parent-'));
  try {
    const repo = join(root, 'repo'); await mkdir(repo);
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'buildlore', version: '0.1.1-rc.2', private: true }));
    for (const name of ['src', 'dist', 'schemas', 'profiles', 'skills', 'test', 'node_modules']) {
      const input = join(repo, name), alias = join(root, `alias-${name}`);
      await mkdir(input); await symlink(input, alias, 'junction');
      await assert.rejects(prepareRelease(repo, join(alias, 'one/two'), 'unused-npm'), /outside package inputs/u);
      await assert.rejects(lstat(join(input, 'one')), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('historical archives own their layout while candidates retain current-source checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-release-history-'));
  try {
    const repo = join(root, 'repo'), source = join(repo, 'src'), packageRoot = join(root, 'package');
    await mkdir(join(source, 'cli'), { recursive: true });
    for (const name of ['cli/bin', 'previous']) await writeFile(join(source, `${name}.ts`), 'export {};\n');
    const metadata = { name: 'buildlore', private: true, version: '0.1.1-rc.1', exports: { '.': './dist/previous.js' } };
    const files = ['LICENSE', 'README.md', 'README.ko.md', 'RELEASE.md', 'CHANGELOG.md',
      'skills/buildlore-authoring/SKILL.md', 'skills/buildlore-activation/SKILL.md',
      ...['cli/bin', 'previous'].flatMap(name => ['.js', '.js.map', '.d.ts', '.d.ts.map'].map(suffix => `dist/${name}${suffix}`))];
    for (const name of files) {
      await mkdir(dirname(join(packageRoot, name)), { recursive: true });
      await writeFile(join(packageRoot, name), 'fixture\n');
    }
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify(metadata));
    const archive = join(root, 'buildlore-0.1.1-rc.1.tgz');
    // npm archives contain files rather than separate directory entries.
    const packedFiles = ['package/package.json', ...files.map(name => `package/${name}`)];
    const packFiles = async (paths = packedFiles) => { await exec('tar', ['-czf', archive, '-C', root, ...paths]); };
    await packFiles();
    assert.equal((await inspectArchive(repo, archive)).entryCount, packedFiles.length);
    await writeFile(join(source, 'future.ts'), 'export {};\n');
    await assert.rejects(inspectArchive(repo, archive), /Missing compiled package file/u);
    assert.equal((await inspectHistoricalArchive(archive)).entryCount, packedFiles.length);
    await rm(join(source, 'previous.ts'));
    await assert.rejects(inspectArchive(repo, archive), /Orphan build output/u);
    await inspectHistoricalArchive(archive);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...metadata, exports: { '.': './dist/missing.js' } }));
    await packFiles();
    await assert.rejects(inspectHistoricalArchive(archive), /Missing public export/u);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify(metadata));
    await rm(join(packageRoot, 'LICENSE'));
    await packFiles(packedFiles.filter(name => name !== 'package/LICENSE'));
    await assert.rejects(inspectHistoricalArchive(archive), /Missing release asset/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
