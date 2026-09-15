import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connectedFixture } from './connected-fixture.js';

const exec = promisify(execFile);
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Opt-in installed upgrade checks with a user-provided baseline and local model. No AI calls. */
export async function verifyInstalledEmbeddingLifecycle(options: {
  baselineTarball: string;
  modelDirectory: string;
  tarball: string;
  install: string;
  evidence: string;
}): Promise<void> {
  const f = await connectedFixture(true);
  const binary = join(options.install, 'node_modules/buildlore/dist/cli/bin.js');
  const results: { name: string; exitCode: number }[] = [];
  const run = (program: string, args: string[], cwd = options.install) =>
    exec(program, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  const install = (tarball: string) =>
    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', tarball]);
  const explicitRuntime = () => run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund',
    '--save-exact', '@huggingface/transformers@4.2.0']);
  const metadata = async (relative: string) =>
    object(JSON.parse(await readFile(join(options.install, relative), 'utf8')));
  const runtime = async (present: boolean): Promise<void> => {
    await run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.resolve('buildlore'));
      for (const name of ['@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web']) {
        if (${String(present)}) assert(require.resolve(name));
        else assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
      }
    `]);
  };
  const cli = async (name: string, args: string[], expectedCode = 0) => {
    let stdout: string, stderr: string, code: number;
    try {
      ({ stdout, stderr } = await run(process.execPath, [binary, ...args, '--json'], f.hubRoot));
      code = 0;
    } catch (error) {
      const failure = object(error);
      assert.equal(typeof failure.stdout, 'string');
      assert.equal(typeof failure.stderr, 'string');
      assert.equal(typeof failure.code, 'number');
      stdout = String(failure.stdout); stderr = String(failure.stderr); code = Number(failure.code);
    }
    await writeFile(join(options.evidence, `embedding-${name}.json`),
      JSON.stringify({ stdout, stderr, code }, null, 2) + '\n');
    assert.equal(code, expectedCode, name);
    const envelope = object(JSON.parse(stdout.trim() || stderr.trim()));
    assert.equal(envelope.ok, expectedCode === 0, name);
    assert(!/ERR_MODULE_NOT_FOUND|Cannot find package|\n\s+at /u.test(stdout + stderr));
    results.push({ name, exitCode: code });
    process.stdout.write(`Verified installed embedding ${name}\n`);
    return envelope;
  };
  const search = async (name: string, mode: string, expectedCode = 0) =>
    cli(name, ['search', '--project', f.projectId, '--query', 'local project documentation',
      '--mode', mode], expectedCode);
  const recovery = (envelope: Record<string, unknown>, code: string): void => {
    assert(Array.isArray(envelope.errors));
    const error = object(envelope.errors[0]);
    assert.equal(error.code, code);
    assert.equal(error.recoveryCommand, undefined);
    assert(String(error.message).includes('npm install --prefix "<buildlore-install-prefix>"'));
    assert(String(error.message).includes('--save-exact @huggingface/transformers@4.2.0'));
  };
  const semantic = async (name: string): Promise<void> => {
    const data = object((await search(name, 'semantic')).data);
    assert.equal(data.effectiveMode, 'semantic');
    assert.equal(data.fallback, null);
    assert.equal(data.providerUsed, 'local-in-process');
  };
  try {
    await runtime(false);
    const model = join(f.root, 'model');
    await cp(options.modelDirectory, model, { recursive: true });
    await cli('model-bind', ['model', 'bind', '--profile', 'multilingual-e5-small', '--directory', model]);
    await install(options.baselineTarball);
    const baseline = await metadata('node_modules/buildlore/package.json');
    assert.equal(baseline.name, 'buildlore');
    assert.equal(object(baseline.dependencies)['@huggingface/transformers'], '4.2.0');
    assert.equal(object((await metadata('package.json')).dependencies)['@huggingface/transformers'], undefined);
    await runtime(true);
    await cli('baseline-index', ['index', 'rebuild', '--project', f.projectId]);
    await semantic('baseline-semantic');

    // The old automatic dependency is removed; models and existing indexes survive the update.
    await install(options.tarball);
    await runtime(false);
    await cli('upgrade-model-verify', ['model', 'verify', '--profile', 'multilingual-e5-small']);
    recovery(await search('upgrade-semantic-unavailable', 'semantic', 4), 'LOCAL_WIKI_SEMANTIC_UNAVAILABLE');
    recovery(await cli('upgrade-index-unavailable', ['index', 'rebuild', '--project', f.projectId], 4),
      'LOCAL_EMBEDDING_UNAVAILABLE');
    const fallback = object((await search('upgrade-hybrid-fallback', 'hybrid')).data);
    assert.equal(fallback.effectiveMode, 'lexical-graph');
    assert.equal(object(fallback.fallback).reasonCode, 'embedding-provider-unavailable');
    await search('upgrade-lexical', 'lexical');
    await cli('upgrade-compile-plan', ['compile', 'plan', '--project', f.projectId]);

    await explicitRuntime();
    await runtime(true);
    await semantic('restored-semantic-with-existing-index');
    await cli('restored-index', ['index', 'rebuild', '--project', f.projectId]);
    const hybrid = object((await search('restored-hybrid', 'hybrid')).data);
    assert.equal(hybrid.effectiveMode, 'hybrid');
    assert.equal(hybrid.fallback, null);

    // The documented pre-update explicit installation preserves the runtime on later updates.
    await install(options.baselineTarball);
    await explicitRuntime();
    await install(options.tarball);
    await runtime(true);
    assert.equal(object((await metadata('package.json')).dependencies)['@huggingface/transformers'], '4.2.0');
    await semantic('explicit-runtime-preserved-after-upgrade');
    const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
    await writeFile(join(options.evidence, 'embedding-upgrade-summary.json'), JSON.stringify({
      passed: true, actualAiClientCalls: 0, results,
      baselineSha256: await hash(options.baselineTarball), candidateSha256: await hash(options.tarball),
    }, null, 2) + '\n');
  } finally {
    await f.cleanup();
  }
}
