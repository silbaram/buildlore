// Full Linux installation lifecycle. All installations and Git fixtures are disposable.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, symlink, rm, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const archive = resolve(process.env.BUILDLORE_INSTALL_EVIDENCE_DIR ?? '.plan2agent/artifacts/buildlore/m3-installed-2026-09-15');
await mkdir(archive, { recursive: true });
const archivedRun = await mkdtemp(join(archive, 'run-'));
const root = await mkdtemp(join(tmpdir(), 'buildlore-m3-baseline-'));
// The development checkout is hidden during measurement; collect outside it.
const evidence = join(root, 'evidence'); await mkdir(evidence);
try {
  assert.equal((await exec('npm', ['--version'])).stdout.trim(), '11.19.0', 'Use npm@11.19.0 on PATH.');
  const baseline = join(root, 'baseline'); await mkdir(baseline);
  const sourceArchive = join(root, 'baseline.tar');
  await exec('git', ['archive', '--format=tar', '--output', sourceArchive, '4db97a8'], { cwd: repo });
  await exec('tar', ['-xf', sourceArchive, '-C', baseline]);
  await symlink(join(repo, 'node_modules'), join(baseline, 'node_modules'));
  await exec('npm', ['run', 'build'], { cwd: baseline, maxBuffer: 16 * 1024 * 1024 });
  await exec('npm', ['pack', '--pack-destination', evidence], { cwd: baseline, maxBuffer: 16 * 1024 * 1024 });
  const baselineTarball = join(evidence, 'buildlore-0.1.0.tgz');
  const child = exec(process.execPath, ['scripts/verify-installed-read.mjs'], { cwd: repo, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, BUILDLORE_VERIFY_M2: '0', BUILDLORE_VERIFY_M3: '1', BUILDLORE_INSTALL_EVIDENCE_DIR: evidence,
      BUILDLORE_M3_BASELINE_TARBALL: baselineTarball } });
  child.child.stdout?.on('data', /** @param {Buffer} bytes */ bytes => process.stdout.write(bytes));
  child.child.stderr?.on('data', /** @param {Buffer} bytes */ bytes => process.stderr.write(bytes));
  await child;
  process.stdout.write(`M3 installed lifecycle verified. Evidence: ${archivedRun}\n`);
} finally {
  await cp(evidence, archivedRun, { recursive: true });
  await rm(root, { recursive: true, force: true });
}
