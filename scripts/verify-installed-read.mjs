// Actual tarball installation and executed syscall evidence. Fixture construction
// may use dev tools; every measured command runs the installed bin in isolation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'buildlore-installed-read-'));
const evidence = process.env.BUILDLORE_INSTALL_EVIDENCE_DIR ? resolve(process.env.BUILDLORE_INSTALL_EVIDENCE_DIR) : join(root, 'evidence');
await mkdir(evidence, { recursive: true });
/** @param {string} file @param {string[]} args @param {import('node:child_process').ExecFileOptions} [options] */
const run = (file, args, options = {}) => exec(file, args, { cwd: repo, maxBuffer: 16 * 1024 * 1024, ...options, encoding: 'utf8' });
/** @param {string | Uint8Array} bytes */
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** @type {Awaited<ReturnType<typeof import('../test/helpers/connected-fixture.js').connectedFixture>> | undefined} */
let fixture;
/** @typedef {{schemaVersion: string, ok: boolean, readContext: {generation: string} | null, data: {readable?: boolean, evidence?: {evidenceId: string}[]} | null}} Envelope */
/** @param {string} text @returns {Envelope} */
const envelope = text => {
  /** @type {Envelope} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Typed boundary for a validated fixture/module or JSON assertion below.
  const value = JSON.parse(text);
  assert(value && typeof value.ok === 'boolean');
  return value;
};
try {
  const versions = { node: process.version, npm: (await run('npm', ['--version'])).stdout.trim(), git: (await run('git', ['--version'])).stdout.trim(), platform: process.platform, arch: process.arch };
  assert.equal(versions.npm, '11.19.0', 'Run with npm@11.19.0 on PATH.');
  assert.equal(versions.platform, 'linux'); assert.equal(versions.arch, 'x64');
  await run('strace', ['--version']); await run('bwrap', ['--ro-bind', '/', '/', '--unshare-net', '--proc', '/proc', '--dev', '/dev', 'true']);
  await run('npm', ['run', 'build']);
  /** @type {{filename: string, integrity: string, files: {path: string}[]}[]} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Typed boundary for a validated fixture/module or JSON assertion below.
  const packs = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', root])).stdout);
  const packed = packs[0];
  assert(packed);
  const tarball = join(root, packed.filename);
  const install = join(root, 'installation'); await mkdir(install);
  await writeFile(join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', tarball], { cwd: install });
  const binary = join(install, 'node_modules/.bin/buildlore');
  assert.equal(await realpath(binary), join(install, 'node_modules/buildlore/dist/cli/bin.js'));
  for (const name of ['typescript', 'vitest', 'eslint']) {
    await assert.rejects(realpath(join(install, 'node_modules', name)));
  }
  for (const entry of packed.files) assert(!/^(src|test|plans|\.plan2agent|node_modules)\//u.test(entry.path));
  await run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { resolveConnection } from 'buildlore/connection';
    import { readConnectedWiki } from 'buildlore/wiki-read';
    assert.equal(typeof resolveConnection, 'function'); assert.equal(typeof readConnectedWiki, 'function');
    for (const name of ['connection', 'read-connections', 'connection-status', 'cli-envelope-v2']) {
      const value = JSON.parse(await readFile(new URL(import.meta.resolve('buildlore/schemas/' + name + '.schema.json')), 'utf8'));
      assert.equal(value.additionalProperties, false); assert(value.$schema);
    }
  `], { cwd: install });

  // Compile fixture helpers outside the installed package. This support tree is
  // hidden while measuring, as is the entire development checkout.
  const support = join(root, 'support');
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit', 'false', '--rootDir', '.', '--outDir', support]);
  await writeFile(join(support, 'package.json'), '{"type":"module"}\n');
  await symlink(join(repo, 'node_modules'), join(support, 'node_modules'));
  /** @type {typeof import('../test/helpers/connected-fixture.js')} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Typed boundary for a validated fixture/module or JSON assertion below.
  const helpers = await import(pathToFileURL(join(support, 'test/helpers/connected-fixture.js')).href);
  fixture = await helpers.connectedFixture(true);
  /** @type {typeof import('../src/connection/service.js')} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Typed boundary for a validated fixture/module or JSON assertion below.
  const service = await import(pathToFileURL(join(support, 'src/connection/service.js')).href);
  await service.disconnectProject(fixture.sourceRoot, true, { configDir: fixture.configDir });
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, BUILDLORE_CONFIG_DIR: fixture.configDir, LC_ALL: 'C', LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
  const sourceRoot = fixture.sourceRoot;
  const trailingSpaceRoot = `${sourceRoot} `;
  await mkdir(trailingSpaceRoot);
  await helpers.git(trailingSpaceRoot, 'init');
  /** @param {string[]} args @param {string} [cwd] */
  const cli = async (args, cwd = sourceRoot) => envelope((await run(binary, [...args, '--json'], { cwd, env })).stdout);
  assert.match((await run(binary, ['--help'], { cwd: fixture.sourceRoot, env })).stdout, /buildlore setup/u);
  assert.equal((await cli(['setup', '--hub', fixture.hubRoot, '--knowledge-repo', '../knowledge.git'])).ok, true);
  assert.equal((await cli(['connect', '--hub', fixture.hubRoot, '--project', fixture.projectId, '--source-repo', 'https://example.test/parcel.git'])).data?.readable, true);
  const emptyCache = join(root, 'empty-cache'); await mkdir(emptyCache);
  env.XDG_CACHE_HOME = emptyCache;
  const freshHub = join(root, 'fresh-hub');
  const freshEnv = { ...env, BUILDLORE_CONFIG_DIR: join(root, 'fresh-config') };
  // Absolute local locators are intentionally not portable; use a relative locator.
  const relative = (await import('node:path')).relative(freshHub, join(fixture.root, 'knowledge.git'));
  assert.equal(envelope((await run(binary, ['setup', '--hub', freshHub, '--knowledge-repo', relative, '--json'], { env: freshEnv })).stdout).ok, true);
  const first = await cli(['wiki', 'list']);
  assert(first.readContext);
  const generation = first.readContext.generation;
  const page = await cli(['wiki', 'read', '--page', 'overview', '--expect-generation', generation]);
  const evidenceId = page.data?.evidence?.[0]?.evidenceId;
  assert(evidenceId);
  /** @type {[string, string[], number, string?][]} */
  const cases = [
    ['list', ['wiki', 'list'], 0],
    ['list-subdir', ['wiki', 'list'], 0, join(fixture.sourceRoot, 'docs')],
    ['search', ['search', '--query', 'local'], 0],
    ['memory', ['wiki', 'memory', '--task', 'local', '--progressive'], 0],
    ['read', ['wiki', 'read', '--page', 'overview', '--expect-generation', generation], 0],
    ['reader', ['wiki', 'read', '--page', 'overview', '--view', 'reader', '--expect-generation', generation], 0],
    ['citations', ['wiki', 'citations', '--page', 'overview', '--expect-generation', generation], 0],
    ['lookup', ['wiki', 'lookup', '--kind', 'evidence', '--id', evidenceId, '--expect-generation', generation], 0],
    ['status', ['connection', 'status'], 0], ['doctor', ['doctor'], 0],
    ['missing-generation', ['wiki', 'read', '--page', 'overview'], 2],
    ['stale-generation', ['wiki', 'read', '--page', 'overview', '--expect-generation', `sha256:${'0'.repeat(64)}`], 3],
    ['wrong-project', ['wiki', 'list', '--project', 'another'], 3],
    ['trailing-space-unconnected', ['wiki', 'list'], 2, trailingSpaceRoot],
    ['unsupported', ['search', '--query', 'local', '--mode', 'semantic'], 2],
  ];
  const other = await helpers.addHierarchicalProject(fixture);
  await cli(['connect', '--hub', fixture.hubRoot, '--project', other.projectId, '--source-repo', 'https://example.test/other.git'], other.sourceRoot);
  assert(other.pageId);
  const extraRoot = join(fixture.root, '추가 작업 트리');
  await helpers.git(fixture.sourceRoot, 'worktree', 'add', '-b', 'installed-extra', extraRoot);
  await mkdir(join(extraRoot, '한글 하위 폴더'));
  await cli(['connect', '--hub', fixture.hubRoot, '--project', fixture.projectId, '--source-repo', 'https://example.test/parcel.git'], extraRoot);
  cases.push(['extra-worktree', ['wiki', 'list'], 0, join(extraRoot, '한글 하위 폴더')],
    ['hierarchy-list', ['wiki', 'list'], 0, other.sourceRoot],
    ['hierarchy-search', ['search', '--query', 'wiki'], 0, other.sourceRoot],
    ['hierarchy-read', ['wiki', 'read', '--page', other.pageId, '--expect-generation', other.generation], 0, other.sourceRoot],
    ['hierarchy-citations', ['wiki', 'citations', '--page', other.pageId, '--expect-generation', other.generation], 0, other.sourceRoot],
    ['hierarchy-memory', ['wiki', 'memory'], 2, other.sourceRoot]);
  /** @param {string} trace */
  const forbidden = trace => trace.split('\n').filter(line =>
    (/\b(?:open|openat|openat2)\(.*\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b/u.test(line) &&
      !/"\/dev\/null", O_RDWR\) = \d+<\/dev\/null<char 1:3>>$/u.test(line)) ||
    /\b(?:creat|rename|renameat|renameat2|unlink|unlinkat|mkdir|mkdirat|rmdir|link|linkat|symlink|symlinkat|truncate|ftruncate|chmod|fchmod|fchmodat|chown|fchown|lchown|utime|utimes|utimensat|mknod|mknodat|setxattr|removexattr)\(/u.test(line) ||
    /\b(?:write|writev|pwrite64|pwritev|pwritev2)\(\d+<\//u.test(line) ||
    /\bmmap\(.*PROT_WRITE.*MAP_SHARED.*<\//u.test(line) ||
    /\bsocket\(AF_(?:INET|INET6|PACKET)/u.test(line) || /\bconnect\(/u.test(line));
  /** @param {string} name @param {string} program @param {string[]} args @param {string} cwd @param {number} expectedCode */
  async function traced(name, program, args, cwd, expectedCode) {
    const prefix = join(evidence, name);
    /** @type {{stdout: string, stderr: string, code: number}} */
    let result;
    try {
      const output = await run('bwrap', ['--ro-bind', '/', '/', '--bind', evidence, evidence,
        '--tmpfs', repo, '--tmpfs', join(root, 'support'), '--unshare-net', '--proc', '/proc', '--dev', '/dev',
        '--chdir', cwd, 'strace', '-ff', '-yy', '-s', '4096', '-o', prefix,
        '-e', 'trace=%file,%network,write,writev,pwrite64,pwritev,pwritev2,mmap,ftruncate,fchmod,fchown', program, ...args], { env });
      result = { ...output, code: 0 };
    } catch (error) {
      assert(error instanceof Error && 'code' in error && 'stdout' in error && 'stderr' in error);
      assert(typeof error.code === 'number' && typeof error.stdout === 'string' && typeof error.stderr === 'string');
      result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    const traceFiles = (await readdir(evidence)).filter(file => file.startsWith(`${name}.`) && /\.\d+$/u.test(file));
    if (traceFiles.length === 0) await writeFile(join(evidence, `${name}.unavailable.json`), JSON.stringify(result, null, 2));
    assert(traceFiles.length > 0, 'Syscall tracing unavailable; inspect local unavailable evidence.');
    const trace = (await Promise.all(traceFiles.map(file => readFile(join(evidence, file), 'utf8')))).join('\n');
    assert.match(trace, /execve\(/u);
    assert.match(trace, /exited with/u);
    await writeFile(join(evidence, `${name}.result.json`), JSON.stringify({ exitCode: result.code,
      stdout: result.stdout, stderr: result.stderr, traceFiles, traceDigest: hash(trace), violations: forbidden(trace) }, null, 2));
    assert.equal(result.code, expectedCode, `${name}: ${result.stderr}`);
    return { trace, result, violations: forbidden(trace) };
  }
  // Negative controls detect failed writes on the read-only mount as well as
  // same-byte rewrites and create-delete actions that a final hash would miss.
  const control = join(evidence, 'control'); await writeFile(control, 'same');
  const positive = await traced('control-mutating', process.execPath, ['--input-type=module', '-e',
    `import{writeFileSync,unlinkSync}from'node:fs';writeFileSync(${JSON.stringify(control)},'same');writeFileSync(${JSON.stringify(control + '.tmp')},'x');unlinkSync(${JSON.stringify(control + '.tmp')});`], fixture.sourceRoot, 0);
  assert(positive.violations.length >= 3);
  const denied = await traced('control-denied', process.execPath, ['--input-type=module', '-e',
    `import{writeFileSync}from'node:fs';try{writeFileSync(${JSON.stringify(join(fixture.sourceRoot, 'denied'))},'x')}catch{}`], fixture.sourceRoot, 0);
  assert(denied.violations.length > 0);
  const results = [];
  for (const [name, args, code, cwd] of cases) {
    const measured = await traced(name, binary, [...args, '--json'], cwd ?? fixture.sourceRoot, code);
    assert.deepEqual(measured.violations, [], `${name} attempted a mutation or network access`);
    const response = envelope(code === 0 ? measured.result.stdout : measured.result.stderr);
    assert.equal(response.schemaVersion, 'buildlore.cli-envelope.v2');
    assert.equal(response.ok, code === 0);
    if (code !== 0) { assert.equal(response.data, null); assert.equal(response.readContext, null); }
    else if (!['status', 'doctor'].includes(name)) assert.equal(response.readContext?.generation, name.startsWith('hierarchy-') ? other.generation : generation);
    const unselected = name.startsWith('hierarchy-') ? fixture.projectId : other.projectId;
    assert(!measured.trace.split('\n').some(line => /\bopen(?:at|at2)?\(/u.test(line) && line.includes(`/projects/${unselected}/`)), `${name} opened another project's content`);
    assert(!measured.trace.split('\n').some(line => /\bopen(?:at|at2)?\(/u.test(line) && /\.(?:onnx|safetensors)(?:"|>)/u.test(line)), `${name} opened model weights`);
    for (const line of measured.trace.split('\n').filter(line => /execve\(/u.test(line) && line.endsWith(' = 0'))) {
      assert(/(?:buildlore|node|git)"/u.test(line.split(', [')[0]), `${name} spawned an unexpected executable`);
    }
    results.push({ name, exitCode: code, fileMutationAttempts: 0, networkAttempts: 0 });
    process.stdout.write(`Verified installed ${name} (exit ${code})\n`);
  }
  await writeFile(join(evidence, 'summary.json'), JSON.stringify({ schemaVersion: 'buildlore.installed-read-evidence.v1',
    versions, package: { name: 'buildlore', version: '0.1.0', sha256: hash(await readFile(tarball)), integrity: packed.integrity },
    isolation: { runtimeDependenciesOnly: true, sourceCheckoutHidden: true, readOnlyMount: true, networkNamespace: true },
    controls: { sameBytesRewriteDetected: true, createDeleteDetected: true, failedWriteDetected: true,
      stdioDeviceException: 'Successful O_RDWR open of /dev/null character device 1:3 for Git standard descriptor initialization; no persistent file mutation.' }, results }, null, 2));
  process.stdout.write(`Installed read verification passed: ${results.length} commands. Evidence: ${evidence}\n`);
  if (process.env.BUILDLORE_VERIFY_M2 === '1') {
    /** @type {typeof import('../test/helpers/m2-installed-evaluation.js')} */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Compiled local verification helper.
    const m2 = await import(pathToFileURL(join(support, 'test/helpers/m2-installed-evaluation.js')).href);
    await m2.verifyInstalledM2({ binary, hubRoot: fixture.hubRoot, repo, root, sourceRoot, configDir: fixture.configDir, projectId: fixture.projectId, evidence, support, generation, evidenceId, other });
  }
} finally {
  await fixture?.cleanup();
  // Keep traces for review; all throwaway package/fixture paths are PC-local.
  if (!evidence.startsWith(root + '/')) await rm(root, { recursive: true, force: true });
}
