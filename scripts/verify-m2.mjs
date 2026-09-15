import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const evidence = process.env.BUILDLORE_INSTALL_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'buildlore-m2-evidence-'));
const archive = resolve('.plan2agent/artifacts/buildlore/m2-installed-2026-09-15');
const child = spawn('npx', ['--yes', '--package=npm@11.19.0', '--call', 'node scripts/verify-installed-read.mjs'], {
  stdio: 'inherit', env: { ...process.env, BUILDLORE_VERIFY_M2: '1', BUILDLORE_INSTALL_EVIDENCE_DIR: evidence },
});
const code = await /** @type {Promise<number>} */ (new Promise(resolve => {
  child.on('error', () => { process.stderr.write('M2 verification could not start.\n'); resolve(1); });
  child.on('close', code => { resolve(code ?? 1); });
}));
await mkdir(archive, { recursive: true });
const archivedRun = await mkdtemp(join(archive, 'run-'));
await cp(evidence, archivedRun, { recursive: true });
await writeFile(join(archive, 'latest.json'), JSON.stringify({ evidence: archivedRun, exitCode: code }, null, 2) + '\n');
process.exitCode = typeof code === 'number' ? code : 1;
