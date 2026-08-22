import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { serializeCanonicalJson } from './atomic-file.js';
import { GitMachineError } from './errors.js';
import { resolveGitCommonDirectory, resolveGitWorktreeRoot } from './git.js';
import type { GitObjectId, PublicationDigest } from './publication-types.js';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_RECORDS = 100_000;
const MAX_PATH_BYTES = 4096;
const MAX_PUBLICATION_FILE_BYTES = 8 * 1024 * 1024;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BRANCH_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,244}$/u;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface PublicationIndexEntry {
  readonly mode: string;
  readonly oid: GitObjectId;
  readonly path: string;
  readonly stage: 0 | 1 | 2 | 3;
}

export interface PublicationRepositorySnapshot {
  readonly baseRevision: GitObjectId;
  readonly branchRef: string;
  readonly indexEntries: readonly PublicationIndexEntry[];
  readonly indexSnapshotDigest: PublicationDigest;
  readonly localUpstreamRevision: GitObjectId | null;
  readonly repositoryIdentityDigest: PublicationDigest;
  readonly repositoryRoot: string;
}

export interface PublicationCommitSnapshot {
  readonly changedPaths: readonly string[];
  readonly message: Buffer;
  readonly parentRevisions: readonly GitObjectId[];
  readonly treeRevision: GitObjectId;
}

export interface PublicationFileSnapshot {
  readonly content: Buffer;
  readonly digest: PublicationDigest;
  readonly identityDigest: PublicationDigest;
  readonly mode: '100644';
}

export interface PublicationInspectionPort {
  inspectCommit(repositoryRoot: string, oid: GitObjectId): Promise<PublicationCommitSnapshot>;
  inspectRepository(repositoryRoot: string): Promise<PublicationRepositorySnapshot>;
  inspectWorktreePathIdentity(
    repositoryRoot: string,
    relativePath: string,
  ): Promise<PublicationDigest | null>;
  readHeadFile(repositoryRoot: string, relativePath: string): Promise<Buffer | null>;
  readIndexBlob(repositoryRoot: string, oid: GitObjectId): Promise<Buffer>;
  readWorktreeFile(repositoryRoot: string, relativePath: string): Promise<PublicationFileSnapshot>;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
}

function sha256(value: Buffer | string): PublicationDigest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function invalidOutput(): GitMachineError {
  return new GitMachineError(
    'GIT_MACHINE_OUTPUT_INVALID',
    'Git returned invalid publication inspection output.',
  );
}

function validateRelativePath(path: string): string {
  const encoded = Buffer.from(path, 'utf8');
  if (
    path.length === 0 ||
    encoded.byteLength > MAX_PATH_BYTES ||
    utf8Decoder.decode(encoded) !== path ||
    path !== path.normalize('NFC') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((component) =>
      component === '' || component === '.' || component === '..' || component === '.git')
  ) {
    throw new GitMachineError('GIT_OPERATION_FAILED', 'Publication path is unsafe.');
  }
  return path;
}

function validateOid(oid: string): string {
  const normalized = oid.toLowerCase();
  if (!OID_PATTERN.test(normalized)) {
    throw new GitMachineError('GIT_MACHINE_OUTPUT_INVALID', 'Git object id is invalid.');
  }
  return normalized;
}

function decodeSingleLine(output: Buffer): string {
  let decoded: string;
  try {
    decoded = utf8Decoder.decode(output);
  } catch {
    throw invalidOutput();
  }
  if (!decoded.endsWith('\n') || decoded.slice(0, -1).includes('\n') || decoded.includes('\r')) {
    throw invalidOutput();
  }
  return decoded.slice(0, -1);
}

function parseIndex(output: Buffer): readonly PublicationIndexEntry[] {
  if (output.byteLength === 0) return [];
  if (output[output.byteLength - 1] !== 0) throw invalidOutput();
  const entries: PublicationIndexEntry[] = [];
  let start = 0;
  for (let offset = 0; offset < output.byteLength; offset += 1) {
    if (output[offset] !== 0) continue;
    const record = output.subarray(start, offset);
    start = offset + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) throw invalidOutput();
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3) throw invalidOutput();
    const mode = metadata[0];
    const oid = metadata[1];
    const stageText = metadata[2];
    let path: string;
    try {
      path = utf8Decoder.decode(record.subarray(tab + 1));
    } catch {
      throw invalidOutput();
    }
    if (
      mode === undefined ||
      !/^[0-7]{6}$/u.test(mode) ||
      oid === undefined ||
      !OID_PATTERN.test(oid) ||
      stageText === undefined ||
      !/^[0-3]$/u.test(stageText)
    ) {
      throw invalidOutput();
    }
    validateRelativePath(path);
    const stageNumber = Number(stageText);
    if (stageNumber !== 0 && stageNumber !== 1 && stageNumber !== 2 && stageNumber !== 3) {
      throw invalidOutput();
    }
    entries.push({ mode, oid, path, stage: stageNumber });
    if (entries.length > MAX_INDEX_RECORDS) throw invalidOutput();
  }
  return entries;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

function stableFileIdentity(status: Stats, canonicalPath: string): PublicationDigest {
  return sha256(serializeCanonicalJson({
    device: status.dev,
    inode: status.ino,
    mode: status.mode,
    modifiedMilliseconds: status.mtimeMs,
    pathDigest: sha256(canonicalPath),
    size: status.size,
  }));
}

export class GitPublicationInspector implements PublicationInspectionPort {
  async inspectCommit(repositoryRoot: string, oid: GitObjectId): Promise<PublicationCommitSnapshot> {
    const commitOid = validateOid(oid);
    const [object, changed] = await Promise.all([
      this.#run(repositoryRoot, ['cat-file', 'commit', commitOid]),
      this.#run(repositoryRoot, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        '-z',
        `${commitOid}^`,
        commitOid,
      ]),
    ]);
    const headerEnd = object.stdout.indexOf(Buffer.from('\n\n', 'ascii'));
    if (headerEnd < 0) throw invalidOutput();
    const headers = object.stdout.subarray(0, headerEnd).toString('ascii').split('\n');
    let treeRevision: string | undefined;
    const parentRevisions: string[] = [];
    for (const header of headers) {
      if (header.startsWith('tree ')) treeRevision = validateOid(header.slice(5));
      else if (header.startsWith('parent ')) parentRevisions.push(validateOid(header.slice(7)));
    }
    if (treeRevision === undefined || parentRevisions.length !== 1) throw invalidOutput();
    const changedPaths: string[] = [];
    if (changed.stdout.byteLength > 0) {
      if (changed.stdout[changed.stdout.byteLength - 1] !== 0) throw invalidOutput();
      for (const record of changed.stdout.subarray(0, -1).toString('utf8').split('\0')) {
        validateRelativePath(record);
        changedPaths.push(record);
      }
    }
    return {
      changedPaths: Object.freeze(changedPaths.toSorted()),
      message: Buffer.from(object.stdout.subarray(headerEnd + 2)),
      parentRevisions: Object.freeze(parentRevisions),
      treeRevision,
    };
  }

  async inspectRepository(repositoryRoot: string): Promise<PublicationRepositorySnapshot> {
    const canonicalRoot = await resolveGitWorktreeRoot(repositoryRoot);
    if (canonicalRoot === null || canonicalRoot !== await realpath(resolve(repositoryRoot))) {
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Knowledge repository root is invalid.');
    }
    const [head, branch, upstream, index, commonDirectory] = await Promise.all([
      this.#run(canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
      this.#run(canonicalRoot, ['symbolic-ref', '-q', 'HEAD']),
      this.#run(canonicalRoot, ['rev-parse', '--verify', '@{upstream}^{commit}'], undefined, true),
      this.#run(canonicalRoot, ['ls-files', '--stage', '-z']),
      resolveGitCommonDirectory(canonicalRoot),
    ]);
    if (head.exitCode !== 0 || branch.exitCode !== 0 || index.exitCode !== 0) {
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Knowledge repository state is unavailable.');
    }
    const baseRevision = validateOid(decodeSingleLine(head.stdout));
    const branchRef = decodeSingleLine(branch.stdout);
    if (!BRANCH_REF_PATTERN.test(branchRef) || branchRef.includes('..') || branchRef.includes('@{')) {
      throw invalidOutput();
    }
    let localUpstreamRevision: GitObjectId | null = null;
    if (upstream.exitCode === 0) {
      localUpstreamRevision = validateOid(decodeSingleLine(upstream.stdout));
    } else if (upstream.stdout.byteLength !== 0) {
      throw invalidOutput();
    }
    const indexEntries = parseIndex(index.stdout);
    return {
      baseRevision,
      branchRef,
      indexEntries,
      indexSnapshotDigest: sha256(serializeCanonicalJson(indexEntries)),
      localUpstreamRevision,
      repositoryIdentityDigest: sha256(commonDirectory),
      repositoryRoot: canonicalRoot,
    };
  }

  async inspectWorktreePathIdentity(
    repositoryRoot: string,
    relativePath: string,
  ): Promise<PublicationDigest | null> {
    const root = await realpath(resolve(repositoryRoot));
    const path = validateRelativePath(relativePath);
    const target = join(root, ...path.split('/'));
    if (!isContained(root, target)) throw new GitMachineError(
      'GIT_OPERATION_FAILED',
      'Publication path escapes its repository.',
    );
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await lstat(target);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Publication path metadata is unavailable.');
    }
    return sha256(serializeCanonicalJson({
      device: status.dev,
      inode: status.ino,
      mode: status.mode,
      modifiedMilliseconds: status.mtimeMs,
      pathDigest: sha256(path),
      size: status.size,
      type: status.isFile() ? 'file' : status.isDirectory() ? 'directory' :
        status.isSymbolicLink() ? 'symlink' : 'other',
    }));
  }

  async readHeadFile(repositoryRoot: string, relativePath: string): Promise<Buffer | null> {
    const path = validateRelativePath(relativePath);
    const result = await this.#run(repositoryRoot, ['show', `HEAD:${path}`], undefined, true);
    if (result.exitCode === 0) return result.stdout;
    if (result.stdout.byteLength !== 0) throw invalidOutput();
    return null;
  }

  async readIndexBlob(repositoryRoot: string, oid: GitObjectId): Promise<Buffer> {
    const result = await this.#run(repositoryRoot, ['cat-file', 'blob', validateOid(oid)]);
    if (result.exitCode !== 0) throw new GitMachineError('GIT_OPERATION_FAILED', 'Git blob is unavailable.');
    return result.stdout;
  }

  async readWorktreeFile(
    repositoryRoot: string,
    relativePath: string,
  ): Promise<PublicationFileSnapshot> {
    const root = await realpath(resolve(repositoryRoot));
    const path = validateRelativePath(relativePath);
    const segments = path.split('/');
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      const status = await lstat(parent);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new GitMachineError('GIT_OPERATION_FAILED', 'Publication path is unsafe.');
      }
      const canonicalParent = await realpath(parent);
      if (canonicalParent !== parent || !isContained(root, canonicalParent)) {
        throw new GitMachineError('GIT_OPERATION_FAILED', 'Publication path escapes its project.');
      }
    }
    const target = join(root, ...segments);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o111) !== 0) {
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Publication file mode is unsafe.');
    }
    if (before.size > MAX_PUBLICATION_FILE_BYTES) {
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Publication file exceeds its safe limit.');
    }
    const canonicalTarget = await realpath(target);
    if (canonicalTarget !== target || !isContained(root, canonicalTarget)) {
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Publication file escapes its project.');
    }
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.mode !== before.mode ||
        opened.size !== before.size ||
        opened.size > MAX_PUBLICATION_FILE_BYTES ||
        (opened.mode & 0o111) !== 0
      ) {
        throw new GitMachineError('GIT_OPERATION_FAILED', 'Publication file changed during validation.');
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.mode !== opened.mode ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs
      ) {
        throw new GitMachineError('GIT_OPERATION_FAILED', 'Publication file changed during validation.');
      }
      return {
        content,
        digest: sha256(content),
        identityDigest: stableFileIdentity(after, canonicalTarget),
        mode: '100644',
      };
    } finally {
      await handle?.close();
    }
  }

  #run(
    cwd: string,
    args: readonly string[],
    stdin?: Buffer,
    allowFailure = false,
  ): Promise<CommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', [...args], {
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let limited = false;
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_OUTPUT_BYTES) {
          limited = true;
          child.kill();
          return;
        }
        chunks.push(chunk);
      });
      child.once('error', () => {
        reject(new GitMachineError('GIT_OPERATION_FAILED', 'Git publication inspection failed.'));
      });
      child.once('close', (code) => {
        if (limited) {
          reject(new GitMachineError('GIT_MACHINE_OUTPUT_LIMIT', 'Git publication output exceeded its limit.'));
          return;
        }
        const exitCode = code ?? 1;
        if (exitCode !== 0 && !allowFailure) {
          reject(new GitMachineError('GIT_OPERATION_FAILED', 'Git publication inspection failed.'));
          return;
        }
        resolvePromise({ exitCode, stdout: Buffer.concat(chunks) });
      });
      if (stdin === undefined) child.stdin.end();
      else child.stdin.end(stdin);
    });
  }
}

export function createGitPublicationInspector(): PublicationInspectionPort {
  return new GitPublicationInspector();
}
