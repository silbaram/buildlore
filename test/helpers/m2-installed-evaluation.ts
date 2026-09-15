import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { evaluateActualClients } from './m2-client-evaluation.js';
import { parseJsonStrict } from '../../src/knowledge/strict-json.js';


function object(v: unknown): Record<string, unknown> { assert(v !== null && typeof v === 'object' && !Array.isArray(v)); return v as Record<string, unknown>; }
export interface InstalledM2Options {
  binary: string; hubRoot: string; repo: string; root: string; sourceRoot: string; configDir: string; projectId: string;
  evidence: string; support: string; generation: string; evidenceId: string; other: { sourceRoot: string; projectId: string; generation: string; pageId: string };
}
class Peer {
  private next = 0;
  private buffer = '';
  private readonly waiting = new Map<number, { resolve(v: Record<string, unknown>): void; reject(e: Error): void }>();
  readonly messages: Record<string, unknown>[] = [];
  readonly child;
  readonly closed: Promise<unknown[]>;
  constructor(program: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = once(this.child, 'close');
    this.child.stderr.resume();
    this.child.stdout.on('data', (bytes: Buffer) => {
      this.buffer += bytes.toString();
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const value = object(parseJsonStrict(this.buffer.slice(0, index))); this.buffer = this.buffer.slice(index + 1);
        this.messages.push(value);
        if (typeof value.id === 'number') { this.waiting.get(value.id)?.resolve(value); this.waiting.delete(value.id); }
      }
    });
  }
  notify(method: string): void { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
  async request(method: string, params: object = {}): Promise<Record<string, unknown>> {
    const id = ++this.next;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.waiting.set(id, { resolve, reject });
        timer = setTimeout(() => { this.child.kill('SIGKILL'); reject(new Error('MCP evaluation timed out')); }, 30000);
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    } finally { clearTimeout(timer); this.waiting.delete(id); }
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => { this.child.kill('SIGKILL'); }, 5000);
    try { const [code] = await this.closed; assert.equal(code, 0); } finally { clearTimeout(timer); }
  }
}
export async function verifyInstalledM2(o: InstalledM2Options): Promise<void> {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, BUILDLORE_CONFIG_DIR: o.configDir, XDG_CACHE_HOME: join(o.root, 'empty-cache'), LC_ALL: 'C', LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
  const traces = [];
  for (const selected of [{ sourceRoot: o.sourceRoot, projectId: o.projectId, generation: o.generation, pageId: 'overview' }, o.other]) {
    const name = selected.projectId === o.projectId ? 'mcp-a' : 'mcp-b';
    const prefix = join(o.evidence, name);
    const p = new Peer('bwrap', ['--ro-bind', '/', '/', '--bind', o.evidence, o.evidence, '--tmpfs', o.repo, '--tmpfs', o.support,
      '--unshare-net', '--proc', '/proc', '--dev', '/dev', '--chdir', selected.sourceRoot,
      'strace', '-ff', '-yy', '-s', '4096', '-o', prefix, '-e', 'trace=%file,%network,write,writev,pwrite64,pwritev,pwritev2,mmap,ftruncate,fchmod,fchown',
      o.binary, 'mcp', '--project-dir', selected.sourceRoot, '--read-only'], env);
    try {
      const init = await p.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'installed-evaluation', version: '1' } });
      assert.equal(object(init.result).protocolVersion, '2025-11-25'); p.notify('notifications/initialized');
      const list = await p.request('tools/list'); assert.equal((object(list.result).tools as unknown[]).length, 7);
      const operations: [string, object][] = [['status', {}], ['list', {}], ['search', { query: 'local' }],
        ['read', { page: selected.pageId, expectedGeneration: selected.generation }],
        ['citations', { page: selected.pageId, expectedGeneration: selected.generation }],
        ['read', { page: selected.pageId, expectedGeneration: `sha256:${'0'.repeat(64)}` }],
        ['read', { page: selected.pageId }], ['list', { projectId: 'forbidden' }]];
      if (selected.projectId === o.projectId) operations.push(['memory', { task: 'local', progressive: true }], ['lookup', { kind: 'evidence', id: o.evidenceId, expectedGeneration: selected.generation }]);
      else operations.push(['memory', { task: 'local', progressive: true }]);
      for (const [name, args] of operations) {
        const message = await p.request('tools/call', { name, arguments: args });
        const content = object(object(message.result).structuredContent);
        assert.equal(content.projectId, selected.projectId);
        const failure = 'projectId' in args || name === 'read' && (!('expectedGeneration' in args) || 'expectedGeneration' in args && args.expectedGeneration !== selected.generation) || name === 'memory' && selected.projectId !== o.projectId;
        assert.equal(content.ok, !failure);
        if (failure) assert.equal(content.data, null);
        else if (name !== 'status') assert.equal(object(content.readContext).generation, selected.generation);
      }
    } finally { await p.close(); }
    const files = (await readdir(o.evidence)).filter(f => f.startsWith(name + '.') && /\.\d+$/u.test(f));
    assert(files.length);
    const trace = (await Promise.all(files.map(f => readFile(join(o.evidence, f), 'utf8')))).join('\n');
    const violations = trace.split('\n').filter(line =>
      (/\bopen(?:at|at2)?\(.*\b(?:O_WRONLY|O_RDWR|O_CREAT|O_TRUNC)\b/u.test(line) && !/"\/dev\/null", O_RDWR\) = \d+<\/dev\/null<char 1:3>>$/u.test(line)) ||
      /\b(?:creat|rename|renameat|renameat2|unlink|unlinkat|mkdir|mkdirat|rmdir|link|linkat|symlink|symlinkat|truncate|ftruncate|chmod|fchmod|fchmodat|chown|fchown|lchown|utime|utimes|utimensat|mknod|mknodat|setxattr|removexattr)\(/u.test(line) ||
      /\b(?:write|writev|pwrite64|pwritev|pwritev2)\(\d+<\//u.test(line) || /\bmmap\(.*PROT_WRITE.*MAP_SHARED.*<\//u.test(line) ||
      /\bsocket\(AF_(?:INET|INET6|PACKET)/u.test(line) || /\bconnect\(/u.test(line));
    assert.equal(violations.length, 0, 'MCP mutation or network attempt detected');
    const unselected = selected.projectId === o.projectId ? o.other.projectId : o.projectId;
    assert(!trace.split('\n').some(line => /\bopen(?:at|at2)?\(/u.test(line) && line.includes(`/projects/${unselected}/`)));
    traces.push({ name, requests: p.messages.length, fileMutationAttempts: 0, networkAttempts: 0, crossProjectReads: 0 });
    await writeFile(join(o.evidence, name + '.responses.json'), JSON.stringify(p.messages));
  }
  await writeFile(join(o.evidence, 'm2-protocol-summary.json'), JSON.stringify({ passed: true, traces }, null, 2));
  process.stdout.write('Installed MCP lifecycle and isolation checks passed.\n');
  await evaluateActualClients(o);
}
