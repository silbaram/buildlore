import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';

import { GitMachineError, isNodeError, KnowledgeError } from './errors.js';

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 100_000;
const MAX_CONFIGURED_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURED_RECORDS = 1_000_000;
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MODE_PATTERN = /^[0-7]{6}$/u;
const STATUS_PAIR_PATTERN = /^[.MADRCU]{2}$/u;
const SUBMODULE_PATTERN = /^(?:N\.\.\.|S[.C][.M][.U])$/u;
const REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const FULL_BRANCH_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,244}$/u;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export type GitStatusEntry =
  | {
      readonly headMode: string;
      readonly headOid: string;
      readonly indexMode: string;
      readonly indexOid: string;
      readonly indexStatus: string;
      readonly kind: 'ordinary';
      readonly path: string;
      readonly submodule: string;
      readonly worktreeMode: string;
      readonly worktreeStatus: string;
    }
  | {
      readonly headMode: string;
      readonly headOid: string;
      readonly indexMode: string;
      readonly indexOid: string;
      readonly indexStatus: string;
      readonly kind: 'renamed';
      readonly originalPath: string;
      readonly path: string;
      readonly score: string;
      readonly submodule: string;
      readonly worktreeMode: string;
      readonly worktreeStatus: string;
    }
  | {
      readonly ancestorMode: string;
      readonly ancestorOid: string;
      readonly indexStatus: string;
      readonly kind: 'unmerged';
      readonly ourMode: string;
      readonly ourOid: string;
      readonly path: string;
      readonly submodule: string;
      readonly theirMode: string;
      readonly theirOid: string;
      readonly worktreeMode: string;
      readonly worktreeStatus: string;
    }
  | { readonly kind: 'untracked'; readonly path: string }
  | { readonly kind: 'ignored'; readonly path: string };

export interface GitCachedDiffEntry {
  readonly newMode: string;
  readonly newOid: string;
  readonly oldMode: string;
  readonly oldOid: string;
  readonly originalPath?: string;
  readonly path: string;
  readonly status: string;
}

export interface GitMachinePort {
  status(repositoryRoot: string): Promise<readonly GitStatusEntry[]>;
  cachedDiff(repositoryRoot: string): Promise<readonly GitCachedDiffEntry[]>;
  addExact(repositoryRoot: string, relativePaths: readonly string[]): Promise<void>;
  writeTree(repositoryRoot: string): Promise<string>;
  commitTree(
    repositoryRoot: string,
    treeOid: string,
    parentOids: readonly string[],
    message: Buffer,
  ): Promise<string>;
  updateRefCompareAndSwap(
    repositoryRoot: string,
    ref: string,
    newOid: string,
    expectedOldOid: string,
  ): Promise<void>;
  lsRemoteExact(repositoryRoot: string, remote: string, ref: string): Promise<string | null>;
  fetchObjectNoRefUpdate(repositoryRoot: string, remote: string, oid: string): Promise<void>;
  isAncestor(repositoryRoot: string, ancestorOid: string, descendantOid: string): Promise<boolean>;
  pushExactNonForce(
    repositoryRoot: string,
    remote: string,
    oid: string,
    ref: string,
  ): Promise<void>;
}

export interface GitMachineAdapterOptions {
  readonly maxOutputBytes?: number;
  readonly maxRecords?: number;
}

interface MachineCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
}

function invalidMachineOutput(): GitMachineError {
  return new GitMachineError(
    'GIT_MACHINE_OUTPUT_INVALID',
    'Git returned invalid machine output.',
  );
}

function assertOutputBound(output: Buffer, maxOutputBytes: number): void {
  if (output.byteLength > maxOutputBytes) {
    throw new GitMachineError(
      'GIT_MACHINE_OUTPUT_LIMIT',
      'Git machine output exceeded the configured limit.',
    );
  }
}

function decodeUtf8(value: Buffer): string {
  try {
    return utf8Decoder.decode(value);
  } catch {
    throw invalidMachineOutput();
  }
}

function decodeMachineField(value: Buffer): string {
  if (value.byteLength === 0) throw invalidMachineOutput();
  for (const byte of value) {
    if (byte < 0x21 || byte > 0x7e) throw invalidMachineOutput();
  }
  return value.toString('ascii');
}

function decodeMachineRecord(value: Buffer): string {
  if (value.byteLength === 0) throw invalidMachineOutput();
  for (const byte of value) {
    if (byte < 0x20 || byte > 0x7e) throw invalidMachineOutput();
  }
  return value.toString('ascii');
}

function decodePath(value: Buffer): string {
  if (value.byteLength === 0 || value.byteLength > MAX_PATH_BYTES) {
    throw invalidMachineOutput();
  }
  return decodeUtf8(value);
}

function splitNulRecords(output: Buffer, maxRecords: number): readonly Buffer[] {
  if (output.byteLength === 0) return [];
  if (output[output.byteLength - 1] !== 0) throw invalidMachineOutput();
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    if (output[index] !== 0) continue;
    records.push(output.subarray(start, index));
    if (records.length > maxRecords * 3) throw invalidMachineOutput();
    start = index + 1;
  }
  return records;
}

function splitPrefixFields(
  record: Buffer,
  fieldCount: number,
): { readonly fields: readonly string[]; readonly remainder: Buffer } {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const end = record.indexOf(0x20, start);
    if (end < 0) throw invalidMachineOutput();
    fields.push(decodeMachineField(record.subarray(start, end)));
    start = end + 1;
  }
  if (start >= record.byteLength) throw invalidMachineOutput();
  return { fields, remainder: record.subarray(start) };
}

function requiredField(fields: readonly string[], index: number): string {
  const field = fields[index];
  if (field === undefined) throw invalidMachineOutput();
  return field;
}

function assertStatusMetadata(
  xy: string,
  submodule: string,
  modes: readonly string[],
  oids: readonly string[],
): void {
  if (
    !STATUS_PAIR_PATTERN.test(xy) ||
    !SUBMODULE_PATTERN.test(submodule) ||
    modes.some((mode) => !MODE_PATTERN.test(mode)) ||
    oids.some((oid) => !OBJECT_ID_PATTERN.test(oid))
  ) {
    throw invalidMachineOutput();
  }
}

export function parsePorcelainV2Z(
  output: Buffer,
  options: { readonly maxOutputBytes?: number; readonly maxRecords?: number } = {},
): readonly GitStatusEntry[] {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  assertOutputBound(output, maxOutputBytes);
  const records = splitNulRecords(output, maxRecords);
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.byteLength < 3) throw invalidMachineOutput();
    const recordType = record[0];
    if (recordType === 0x31 || recordType === 0x32) {
      const renamed = recordType === 0x32;
      const { fields, remainder } = splitPrefixFields(record, renamed ? 9 : 8);
      const type = requiredField(fields, 0);
      const xy = requiredField(fields, 1);
      const submodule = requiredField(fields, 2);
      const headMode = requiredField(fields, 3);
      const indexMode = requiredField(fields, 4);
      const worktreeMode = requiredField(fields, 5);
      const headOid = requiredField(fields, 6);
      const indexOid = requiredField(fields, 7);
      if (type !== (renamed ? '2' : '1')) throw invalidMachineOutput();
      assertStatusMetadata(
        xy,
        submodule,
        [headMode, indexMode, worktreeMode],
        [headOid, indexOid],
      );
      const path = decodePath(remainder);
      if (renamed) {
        const score = requiredField(fields, 8);
        if (!/^[RC](?:[0-9]{1,2}|100)$/u.test(score)) throw invalidMachineOutput();
        const originalRecord = records[index + 1];
        if (originalRecord === undefined) throw invalidMachineOutput();
        index += 1;
        entries.push({
          headMode,
          headOid,
          indexMode,
          indexOid,
          indexStatus: xy[0] ?? '.',
          kind: 'renamed',
          originalPath: decodePath(originalRecord),
          path,
          score,
          submodule,
          worktreeMode,
          worktreeStatus: xy[1] ?? '.',
        });
      } else {
        entries.push({
          headMode,
          headOid,
          indexMode,
          indexOid,
          indexStatus: xy[0] ?? '.',
          kind: 'ordinary',
          path,
          submodule,
          worktreeMode,
          worktreeStatus: xy[1] ?? '.',
        });
      }
      continue;
    }
    if (recordType === 0x75) {
      const { fields, remainder } = splitPrefixFields(record, 10);
      const xy = requiredField(fields, 1);
      const submodule = requiredField(fields, 2);
      const ancestorMode = requiredField(fields, 3);
      const ourMode = requiredField(fields, 4);
      const theirMode = requiredField(fields, 5);
      const worktreeMode = requiredField(fields, 6);
      const ancestorOid = requiredField(fields, 7);
      const ourOid = requiredField(fields, 8);
      const theirOid = requiredField(fields, 9);
      if (requiredField(fields, 0) !== 'u') throw invalidMachineOutput();
      assertStatusMetadata(
        xy,
        submodule,
        [ancestorMode, ourMode, theirMode, worktreeMode],
        [ancestorOid, ourOid, theirOid],
      );
      entries.push({
        ancestorMode,
        ancestorOid,
        indexStatus: xy[0] ?? 'U',
        kind: 'unmerged',
        ourMode,
        ourOid,
        path: decodePath(remainder),
        submodule,
        theirMode,
        theirOid,
        worktreeMode,
        worktreeStatus: xy[1] ?? 'U',
      });
      continue;
    }
    if ((recordType === 0x3f || recordType === 0x21) && record[1] === 0x20) {
      entries.push({
        kind: recordType === 0x3f ? 'untracked' : 'ignored',
        path: decodePath(record.subarray(2)),
      });
      continue;
    }
    throw invalidMachineOutput();
  }
  if (entries.length > maxRecords) throw invalidMachineOutput();
  return entries;
}

function parseRawDiffMetadata(record: Buffer): {
  readonly newMode: string;
  readonly newOid: string;
  readonly oldMode: string;
  readonly oldOid: string;
  readonly status: string;
} {
  const fields = decodeMachineRecord(record).split(' ');
  if (fields.length !== 5) throw invalidMachineOutput();
  const rawOldMode = requiredField(fields, 0);
  const oldMode = rawOldMode.startsWith(':') ? rawOldMode.slice(1) : '';
  const newMode = requiredField(fields, 1);
  const oldOid = requiredField(fields, 2);
  const newOid = requiredField(fields, 3);
  const status = requiredField(fields, 4);
  if (
    !MODE_PATTERN.test(oldMode) ||
    !MODE_PATTERN.test(newMode) ||
    !OBJECT_ID_PATTERN.test(oldOid) ||
    !OBJECT_ID_PATTERN.test(newOid) ||
    !/^[ACDMRTUXB](?:[0-9]{1,3})?$/u.test(status)
  ) {
    throw invalidMachineOutput();
  }
  return { newMode, newOid, oldMode, oldOid, status };
}

export function parseCachedDiffRawZ(
  output: Buffer,
  options: { readonly maxOutputBytes?: number; readonly maxRecords?: number } = {},
): readonly GitCachedDiffEntry[] {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  assertOutputBound(output, maxOutputBytes);
  const records = splitNulRecords(output, maxRecords);
  const entries: GitCachedDiffEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const metadataRecord = records[index];
    const pathRecord = records[index + 1];
    if (metadataRecord === undefined || pathRecord === undefined || metadataRecord[0] !== 0x3a) {
      throw invalidMachineOutput();
    }
    const metadata = parseRawDiffMetadata(metadataRecord);
    index += 1;
    const originalPath = decodePath(pathRecord);
    if (metadata.status.startsWith('R') || metadata.status.startsWith('C')) {
      const destinationRecord = records[index + 1];
      if (destinationRecord === undefined) throw invalidMachineOutput();
      index += 1;
      entries.push({
        ...metadata,
        originalPath,
        path: decodePath(destinationRecord),
      });
    } else {
      entries.push({ ...metadata, path: originalPath });
    }
  }
  if (entries.length > maxRecords) throw invalidMachineOutput();
  return entries;
}

function validateOid(oid: string): string {
  const normalized = oid.toLowerCase();
  if (!OBJECT_ID_PATTERN.test(normalized)) {
    throw new GitMachineError('GIT_OPERATION_FAILED', 'Git object id is invalid.');
  }
  return normalized;
}

function validateRemote(remote: string): string {
  if (
    !REMOTE_PATTERN.test(remote) ||
    remote.startsWith('-') ||
    remote.includes('..') ||
    remote.includes('//')
  ) {
    throw new GitMachineError('GIT_OPERATION_FAILED', 'Configured Git remote is invalid.');
  }
  return remote;
}

function validateBranchRef(ref: string): string {
  if (
    !FULL_BRANCH_REF_PATTERN.test(ref) ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.includes('@{') ||
    ref.endsWith('.') ||
    ref.endsWith('/') ||
    ref.split('/').some((component) => component.startsWith('.') || component.endsWith('.lock'))
  ) {
    throw new GitMachineError('GIT_OPERATION_FAILED', 'Git branch ref is invalid.');
  }
  return ref;
}

function validateRelativePath(path: string): string {
  const encoded = Buffer.from(path, 'utf8');
  if (
    path.length === 0 ||
    encoded.byteLength > MAX_PATH_BYTES ||
    decodeUtf8(encoded) !== path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((component) => component === '' || component === '.' || component === '..' || component === '.git')
  ) {
    throw new GitMachineError('GIT_OPERATION_FAILED', 'Git path is not a safe relative path.');
  }
  return path;
}

function encodeNulPathspec(relativePaths: readonly string[]): Buffer {
  const seen = new Set<string>();
  const chunks: Buffer[] = [];
  for (const candidate of relativePaths) {
    const path = validateRelativePath(candidate);
    if (seen.has(path)) {
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Git path list contains a duplicate.');
    }
    seen.add(path);
    chunks.push(Buffer.from(path, 'utf8'), Buffer.from([0]));
  }
  return Buffer.concat(chunks);
}

function parseOidOutput(output: Buffer): string {
  const value = decodeUtf8(output);
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\n$/u.exec(value);
  if (match?.[1] === undefined) throw invalidMachineOutput();
  return match[1];
}

export class GitMachineAdapter implements GitMachinePort {
  readonly #maxOutputBytes: number;
  readonly #maxRecords: number;

  constructor(options: GitMachineAdapterOptions = {}) {
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (
      !Number.isSafeInteger(this.#maxOutputBytes) ||
      this.#maxOutputBytes < 1024 ||
      this.#maxOutputBytes > MAX_CONFIGURED_OUTPUT_BYTES ||
      !Number.isSafeInteger(this.#maxRecords) ||
      this.#maxRecords < 1 ||
      this.#maxRecords > MAX_CONFIGURED_RECORDS
    ) {
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Git machine limits are invalid.');
    }
  }

  async status(repositoryRoot: string): Promise<readonly GitStatusEntry[]> {
    const result = await this.#run(repositoryRoot, [
      '--literal-pathspecs',
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
    ]);
    this.#assertSuccess(result);
    return parsePorcelainV2Z(result.stdout, {
      maxOutputBytes: this.#maxOutputBytes,
      maxRecords: this.#maxRecords,
    });
  }

  async cachedDiff(repositoryRoot: string): Promise<readonly GitCachedDiffEntry[]> {
    const result = await this.#run(repositoryRoot, [
      '--literal-pathspecs',
      'diff',
      '--cached',
      '--raw',
      '-z',
      '--no-renames',
      '--no-abbrev',
      '--no-ext-diff',
      '--no-textconv',
      '--',
    ]);
    this.#assertSuccess(result);
    return parseCachedDiffRawZ(result.stdout, {
      maxOutputBytes: this.#maxOutputBytes,
      maxRecords: this.#maxRecords,
    });
  }

  async addExact(repositoryRoot: string, relativePaths: readonly string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    const result = await this.#run(
      repositoryRoot,
      [
        '--literal-pathspecs',
        'add',
        '--all',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      encodeNulPathspec(relativePaths),
    );
    this.#assertSuccess(result);
    if (result.stdout.byteLength !== 0) throw invalidMachineOutput();
  }

  async writeTree(repositoryRoot: string): Promise<string> {
    const result = await this.#run(repositoryRoot, ['write-tree']);
    this.#assertSuccess(result);
    return parseOidOutput(result.stdout);
  }

  async commitTree(
    repositoryRoot: string,
    treeOid: string,
    parentOids: readonly string[],
    message: Buffer,
  ): Promise<string> {
    if (
      message.byteLength === 0 ||
      message.byteLength > MAX_COMMIT_MESSAGE_BYTES ||
      message.includes(0)
    ) {
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Git commit message is invalid.');
    }
    const parents = parentOids.flatMap((oid) => ['-p', validateOid(oid)]);
    const result = await this.#run(
      repositoryRoot,
      ['commit-tree', validateOid(treeOid), ...parents, '-F', '-'],
      message,
    );
    this.#assertSuccess(result);
    return parseOidOutput(result.stdout);
  }

  async updateRefCompareAndSwap(
    repositoryRoot: string,
    ref: string,
    newOid: string,
    expectedOldOid: string,
  ): Promise<void> {
    const result = await this.#run(repositoryRoot, [
      'update-ref',
      '--no-deref',
      validateBranchRef(ref),
      validateOid(newOid),
      validateOid(expectedOldOid),
    ]);
    if (result.exitCode !== 0) {
      throw new GitMachineError('GIT_REF_RACE', 'Git ref changed before it could be updated.');
    }
    if (result.stdout.byteLength !== 0) throw invalidMachineOutput();
  }

  async lsRemoteExact(
    repositoryRoot: string,
    remote: string,
    ref: string,
  ): Promise<string | null> {
    const exactRef = validateBranchRef(ref);
    const result = await this.#run(repositoryRoot, [
      'ls-remote',
      '--exit-code',
      '--refs',
      validateRemote(remote),
      exactRef,
    ]);
    if (result.exitCode === 2 && result.stdout.byteLength === 0) return null;
    this.#assertSuccess(result);
    const value = decodeUtf8(result.stdout);
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t([^\r\n]+)\n$/u.exec(value);
    if (match?.[1] === undefined || match[2] !== exactRef) throw invalidMachineOutput();
    return match[1];
  }

  async fetchObjectNoRefUpdate(
    repositoryRoot: string,
    remote: string,
    oid: string,
  ): Promise<void> {
    const result = await this.#run(repositoryRoot, [
      'fetch',
      '--no-write-fetch-head',
      '--no-tags',
      validateRemote(remote),
      validateOid(oid),
    ]);
    this.#assertSuccess(result);
    if (result.stdout.byteLength !== 0) throw invalidMachineOutput();
  }

  async isAncestor(
    repositoryRoot: string,
    ancestorOid: string,
    descendantOid: string,
  ): Promise<boolean> {
    const result = await this.#run(repositoryRoot, [
      'merge-base',
      '--is-ancestor',
      validateOid(ancestorOid),
      validateOid(descendantOid),
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitMachineError('GIT_OPERATION_FAILED', 'Git ancestry check failed.');
  }

  async pushExactNonForce(
    repositoryRoot: string,
    remote: string,
    oid: string,
    ref: string,
  ): Promise<void> {
    const result = await this.#run(repositoryRoot, [
      'push',
      '--porcelain',
      validateRemote(remote),
      `${validateOid(oid)}:${validateBranchRef(ref)}`,
    ]);
    if (result.exitCode !== 0) {
      throw new GitMachineError('GIT_PUSH_REJECTED', 'Git remote rejected the exact non-force push.');
    }
  }

  #assertSuccess(result: MachineCommandResult): void {
    if (result.exitCode !== 0) {
      throw new GitMachineError('GIT_OPERATION_FAILED', 'Git machine operation failed.');
    }
  }

  #run(
    repositoryRoot: string,
    args: readonly string[],
    stdin: Buffer = Buffer.alloc(0),
  ): Promise<MachineCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...args], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let exceeded = false;
      let settled = false;

      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const checkChunk = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
        if (stream === 'stdout') {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes <= this.#maxOutputBytes) stdoutChunks.push(chunk);
        } else {
          stderrBytes += chunk.byteLength;
        }
        if (stdoutBytes > this.#maxOutputBytes || stderrBytes > this.#maxOutputBytes) {
          exceeded = true;
          child.kill();
        }
      };

      child.stdout.on('data', (chunk: Buffer) => checkChunk(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => checkChunk(chunk, 'stderr'));
      child.stdin.on('error', () => {
        // Process exit remains the normalized authority for a closed stdin pipe.
      });
      child.on('error', (error: Error) => {
        if (isNodeError(error) && error.code === 'ENOENT') {
          rejectOnce(new KnowledgeError('GIT_NOT_AVAILABLE', 'Git is not available.'));
          return;
        }
        rejectOnce(new GitMachineError('GIT_OPERATION_FAILED', 'Git machine operation failed.'));
      });
      child.on('close', (exitCode: number | null) => {
        if (settled) return;
        if (exceeded) {
          rejectOnce(
            new GitMachineError(
              'GIT_MACHINE_OUTPUT_LIMIT',
              'Git machine output exceeded the configured limit.',
            ),
          );
          return;
        }
        if (exitCode === null) {
          rejectOnce(new GitMachineError('GIT_OPERATION_FAILED', 'Git machine operation failed.'));
          return;
        }
        settled = true;
        resolve({ exitCode, stdout: Buffer.concat(stdoutChunks, stdoutBytes) });
      });
      child.stdin.end(stdin);
    });
  }
}

export function createGitMachineAdapter(
  options: GitMachineAdapterOptions = {},
): GitMachinePort {
  return new GitMachineAdapter(options);
}
