import { execFile } from 'node:child_process';
import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConnectionError, fail, type SourceIdentity } from './contracts.js';

export async function gitRead(root: string, args: readonly string[], optional = false): Promise<string | null> {
  if (!['rev-parse', 'config', 'ls-files', 'status'].includes(args[0] ?? '')) fail();
  return new Promise((ok, reject) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', ...args], {
      cwd: root, encoding: 'utf8', shell: false, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    }, (error, stdout) => {
      if (!error) { ok(stdout); return; }
      if (optional && typeof error.code === 'number') { ok(null); return; }
      reject(new ConnectionError('HUB_UNAVAILABLE'));
    });
  });
}
export async function worktreeRoot(cwd: string): Promise<string> {
  const actual = await realpath(cwd).catch(() => fail('CONNECTION_MISSING'));
  const raw = await gitRead(actual, ['rev-parse', '--show-toplevel'], true);
  if (!raw) fail('CONNECTION_MISSING');
  const root = pathLine(raw);
  return realpath(root);
}
function pathLine(raw: string): string {
  // Git terminates a path with one LF. Other trailing whitespace belongs to
  // the filename and must never redirect the operation to a sibling checkout.
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!value || /[\r\n]/u.test(value)) fail();
  return value;
}
export async function sourceIdentity(root: string): Promise<SourceIdentity> {
  const s = await lstat(root, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink()) fail('READ_BOUNDARY_VIOLATION');
  const common = await gitRead(root, ['rev-parse', '--git-common-dir']);
  if (!common) fail();
  return { device: String(s.dev), inode: String(s.ino), gitCommonDir: await realpath(resolve(root, pathLine(common))) };
}
