import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readM3CandidateIdentity } from './helpers/m3-installed-evaluation.js';

const exec = promisify(execFile);

describe('M3 candidate archive identity', () => {
  it('uses archive metadata for rc.2 and subsequent versions rather than the archive input name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buildlore-m3-identity-'));
    try {
      await mkdir(join(root, 'package'));
      const archive = join(root, 'arbitrary-input-name.tgz');
      for (const version of ['0.1.1-rc.2', '1.2.3-rc.4', '1.2.3']) {
        await writeFile(join(root, 'package/package.json'), JSON.stringify({ name: 'buildlore', version }));
        await exec('tar', ['-czf', archive, '-C', root, 'package/package.json']);
        await expect(readM3CandidateIdentity(archive)).resolves.toEqual({ version, filename: `buildlore-${version}.tgz` });
      }
      for (const metadata of [{ name: 'other', version: '1.2.3' }, { name: 'buildlore', version: '../escape' }]) {
        await writeFile(join(root, 'package/package.json'), JSON.stringify(metadata));
        await exec('tar', ['-czf', archive, '-C', root, 'package/package.json']);
        await expect(readM3CandidateIdentity(archive)).rejects.toThrow();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
