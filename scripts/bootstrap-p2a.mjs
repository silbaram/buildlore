#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function run(command, args, cwd) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          `${command} exited with ${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}`,
        ),
      );
    });
  });
}

/**
 * @param {string} repositoryRoot
 * @param {string} manifestPath
 * @returns {Promise<void>}
 */
async function verifyManagedFiles(repositoryRoot, manifestPath) {
  const manifestText = await readFile(manifestPath, 'utf8');
  // JSON.parse is untyped; every consumed field is validated below.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const manifest = /** @type {{ managedFiles?: unknown }} */ (JSON.parse(manifestText));

  if (!Array.isArray(manifest.managedFiles) || manifest.managedFiles.length === 0) {
    throw new Error('Plan2Agent manifest.managedFiles must be a non-empty array.');
  }

  /** @type {string[]} */
  const failures = [];
  const managedFiles = /** @type {unknown[]} */ (manifest.managedFiles);

  for (const value of managedFiles) {
    if (typeof value !== 'object' || value === null) {
      failures.push('manifest contains a non-object managedFiles entry');
      continue;
    }

    const entry = /** @type {Record<string, unknown>} */ (value);
    const managedPath = entry.path;
    const expectedSha256 = entry.sha256;

    if (
      typeof managedPath !== 'string'
      || managedPath.length === 0
      || typeof expectedSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(expectedSha256)
    ) {
      failures.push('manifest contains an invalid managed file path or SHA-256');
      continue;
    }

    const absolutePath = resolve(repositoryRoot, managedPath);
    const repositoryRelativePath = relative(repositoryRoot, absolutePath);
    if (
      repositoryRelativePath === ''
      || repositoryRelativePath === '..'
      || repositoryRelativePath.startsWith(`..${sep}`)
      || isAbsolute(repositoryRelativePath)
    ) {
      failures.push(`${managedPath}: path escapes the repository`);
      continue;
    }

    try {
      const fileStats = await lstat(absolutePath);
      if (!fileStats.isFile()) {
        failures.push(`${managedPath}: expected a regular file`);
        continue;
      }

      const actualSha256 = createHash('sha256')
        .update(await readFile(absolutePath))
        .digest('hex');
      if (actualSha256 !== expectedSha256) {
        failures.push(`${managedPath}: SHA-256 mismatch`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${managedPath}: ${reason}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Plan2Agent managed asset integrity check failed:\n- ${failures.join('\n- ')}`,
    );
  }

  console.log(`Plan2Agent managed asset integrity verified: ${String(managedFiles.length)} files.`);
}

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const localState = join(repositoryRoot, '.plan2agent');

if (await pathExists(localState)) {
  await verifyManagedFiles(repositoryRoot, join(localState, 'manifest.json'));
  await run('p2a', ['doctor', '--target', repositoryRoot, '--dev'], repositoryRoot);
  console.log('Plan2Agent local state already exists and passed integrity checks.');
} else {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildlore-p2a-init-'));
  const stagedProject = join(temporaryRoot, 'buildlore');
  let copiedLocalState = false;

  try {
    await mkdir(stagedProject);
    await copyFile(join(repositoryRoot, 'package.json'), join(stagedProject, 'package.json'));
    await run('p2a', ['init', '--target', stagedProject], repositoryRoot);

    const stagedState = join(stagedProject, '.plan2agent');
    const manifestPath = join(stagedState, 'manifest.json');
    const manifest = await readFile(manifestPath, 'utf8');
    const stagedPathLiteral = JSON.stringify(stagedProject);
    const occurrences = manifest.split(stagedPathLiteral).length - 1;

    if (occurrences !== 1) {
      throw new Error('Unexpected Plan2Agent manifest targetProject shape.');
    }

    await writeFile(
      manifestPath,
      manifest.replace(stagedPathLiteral, JSON.stringify(repositoryRoot)),
      'utf8',
    );
    await verifyManagedFiles(repositoryRoot, manifestPath);
    await cp(stagedState, localState, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    copiedLocalState = true;

    await run('p2a', ['doctor', '--target', repositoryRoot, '--dev'], repositoryRoot);
    console.log('Plan2Agent local state initialized without overwriting tracked files.');
  } catch (error) {
    if (copiedLocalState) {
      await rm(localState, { force: true, recursive: true });
    }

    throw error;
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
