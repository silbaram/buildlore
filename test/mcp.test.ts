import { runCli } from '../src/cli/run-cli.js';
import { LookupBatchError } from '../src/compiler/project-knowledge/lookup-batch.js';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createProjectMcpServer, type ReadPorts } from '../src/mcp/server.js';
import { ProjectTransport } from '../src/mcp/transport.js';
import { runMcp } from '../src/mcp/run.js';
import { connectedFixture } from './helpers/connected-fixture.js';
import { readConnectedWiki } from '../src/application/wiki-read-service.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function start(ports?: ReadPorts) {
  const f = await connectedFixture(true);
  const input = new PassThrough(), output = new PassThrough();
  let buffered = '', diagnostics = '';
  const messages: Record<string, unknown>[] = [];
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const message: unknown = JSON.parse(buffered.slice(0, end));
      if (typeof message !== 'object' || message === null) throw new Error('Invalid protocol');
      messages.push(message as Record<string, unknown>); buffered = buffered.slice(end + 1);
    }
  });
  const done = (async () => {
    if (!ports) return runMcp(['--project-dir', f.sourceRoot, '--read-only'], input, output, s => { diagnostics += s; }, { configDir: f.configDir });
    const controller = new AbortController();
    let stop = (): void => undefined;
    const end = new Promise<void>(resolve => { stop = resolve; });
    const transport = new ProjectTransport(input, output, f.projectId, stop);
    const api = createProjectMcpServer(f.context, controller.signal, { ports, onCancelledSettled: id => transport.finishCancelled(id) });
    input.once('end', stop);
    await api.server.connect(transport); await end; controller.abort(); await api.server.close(); await api.settled(); return 0;
  })();
  let next = 0;
  const send = (message: object): void => { input.write(JSON.stringify(message) + '\n'); };
  const request = async (method: string, params: object = {}): Promise<Record<string, unknown>> => {
    const id = ++next; send({ jsonrpc: '2.0', id, method, params });
    await expect.poll(() => messages.find(m => m.id === id), { timeout: 15000 }).toBeDefined();
    const result = messages.find(m => m.id === id); if (!result) throw new Error('No response'); return result;
  };
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const stop = async (): Promise<void> => { input.end(); expect(await done).toBe(0); expect(diagnostics).toBe(''); await f.cleanup(); };
  return { f, input, output, request, init, stop, messages, done, send };
}
function result(message: Record<string, unknown>): Record<string, unknown> {
  const v = message.result; if (typeof v !== 'object' || v === null) throw new Error('Missing result'); return v as Record<string, unknown>;
}
describe('project-bound MCP', () => {
  it('returns safe batch size metadata without partial items', async () => {
    const s = await start({ status: () => Promise.resolve({}), read: () => Promise.reject(new LookupBatchError(70000, 32768)) });
    try {
      const id = 'sha256:' + 'a'.repeat(64);
      expect(result(await s.request('tools/call', { name: 'lookup', arguments: { kind: 'fact', ids: [id], expectedGeneration: id } })))
        .toMatchObject({ isError: true, structuredContent: { data: { requiredBytes: 70000, maxBytes: 32768 }, errors: [{ code: 'LOOKUP_BATCH_TOO_LARGE' }] } });
    } finally { await s.stop(); }
  }, 30000);
  it('handshakes, exposes only read tools, preserves data and generation, and exits on EOF', async () => {
    const s = await start();
    try {
      expect(result(s.init).protocolVersion).toBe('2025-11-25');
      expect(result(s.init).capabilities).toEqual({ tools: {} });
      expect(result(await s.request('tools/list'))).toMatchObject({ tools: ['status', 'list', 'search', 'read', 'citations', 'lookup', 'memory'].map(name => ({ name })) });
      const cli = await readConnectedWiki(s.f.context, { operation: 'list' });
      const response = result(await s.request('tools/call', { name: 'list', arguments: {} }));
      expect(response.structuredContent).toMatchObject({ ok: true, projectId: s.f.projectId, data: cli.data, readContext: cli.readContext });
      expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(response.structuredContent) }]);
      for (const name of ['read', 'lookup', 'citations']) {
        const fail = result(await s.request('tools/call', { name, arguments: {} }));
        expect(fail).toMatchObject({ isError: true, structuredContent: { data: null, errors: [{ code: 'GENERATION_REQUIRED' }] } });
      }
    } finally { await s.stop(); }
  }, 30000);
  it('rejects project overrides, unknown tools and unsafe inputs without echoing them', async () => {
    const s = await start();
    try {
      expect(result(await s.request('tools/call', { name: 'list', arguments: { projectId: 'other' } }))).toMatchObject({ isError: true });
      expect(await s.request('tools/call', { name: 'compile' })).toMatchObject({ error: { code: -32602 } });
      expect(await s.request('resources/list')).toMatchObject({ error: { code: -32601 } });
      const value = 'Cookie: session=' + 'example-only-value';
      const fail = await s.request('tools/call', { name: 'search', arguments: { query: value } });
      expect(JSON.stringify(fail)).not.toContain(value);
      expect(result(fail)).toMatchObject({ isError: true });
    } finally { await s.stop(); }
  }, 30000);
});

it('keeps four concurrent requests bounded and rejects oversized results without leaking their bodies', async () => {
  let release = (): void => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const s = await start({ status: () => Promise.resolve({}), read: async (context, request) => {
    if (request.operation === 'list') { calls++; await held; }
    return { data: request.operation === 'search' ? { huge: 'x'.repeat(9 * 1024 * 1024) } : { completed: true },
      readContext: { generation: 'sha256:' + 'a'.repeat(64) as `sha256:${string}`, knowledgeRepositoryDigest: context.knowledgeRepositoryDigest, format: 'project-knowledge', readPolicy: 'connected-approved' }, knowledgeRevision: 'a'.repeat(40) };
  } });
  try {
    const reads = Array.from({ length: 4 }, () => s.request('tools/call', { name: 'list', arguments: {} }));
    await expect.poll(() => calls).toBe(4);
    expect(result(await s.request('tools/call', { name: 'list', arguments: {} }))).toMatchObject({ isError: true, structuredContent: { errors: [{ code: 'MCP_BUSY' }] } });
    release(); await Promise.all(reads);
    const oversized = await s.request('tools/call', { name: 'search', arguments: { query: 'test' } });
    expect(result(oversized)).toMatchObject({ isError: true, structuredContent: { data: null, errors: [{ code: 'MCP_RESPONSE_TOO_LARGE' }] } });
    expect(JSON.stringify(oversized).length).toBeLessThan(2000);
  } finally { release(); await s.stop(); }
}, 30000);
it('discards only the cancelled request while another request completes', async () => {
  let release = (): void => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const s = await start({ status: () => Promise.resolve({ ready: true }), read: async (context, request) => {
    started = true; await held; return readConnectedWiki(context, request);
  } });
  try {
    s.send({ jsonrpc: '2.0', id: 'cancel-me', method: 'tools/call', params: { name: 'list', arguments: {} } });
    await expect.poll(() => started).toBe(true);
    s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me' } });
    expect(result(await s.request('tools/call', { name: 'status', arguments: {} }))).toMatchObject({ structuredContent: { ok: true } });
    release();
    await s.request('ping');
  } finally { release(); await s.stop(); }
  expect(s.messages.some(m => m.id === 'cancel-me')).toBe(false);
}, 30000);

it('matches CLI envelopes for every successful read operation and status', async () => {
  const s = await start();
  try {
    const generation = (await readConnectedWiki(s.f.context, { operation: 'list' })).readContext.generation;
    const page = await readConnectedWiki(s.f.context, { operation: 'read', page: 'overview', expectedGeneration: generation });
    const data = page.data as { evidence: { evidenceId: string }[] };
    const id = data.evidence[0]?.evidenceId; expect(id).toBeDefined();
    const cases: [string, object, string[]][] = [
      ['status', {}, ['connection', 'status']], ['list', {}, ['wiki', 'list']],
      ['search', { query: 'local' }, ['search', '--query', 'local']],
      ['memory', { task: 'local', progressive: true }, ['wiki', 'memory', '--task', 'local', '--progressive']],
      ['read', { page: 'overview', expectedGeneration: generation }, ['wiki', 'read', '--page', 'overview', '--expect-generation', generation]],
      ['citations', { page: 'overview', expectedGeneration: generation }, ['wiki', 'citations', '--page', 'overview', '--expect-generation', generation]],
      ['lookup', { kind: 'evidence', id, expectedGeneration: generation }, ['wiki', 'lookup', '--kind', 'evidence', '--id', id ?? '', '--expect-generation', generation]],
      ['lookup', { kind: 'evidence', ids: [id, id], expectedGeneration: generation }, ['wiki', 'lookup', '--kind', 'evidence', '--ids', [id, id].join(','), '--expect-generation', generation]],
    ];
    for (const [name, arguments_, args] of cases) {
      let text = '';
      const code = await runCli([...args, '--json'], { stdout: s => { text += s; }, stderr: s => { text += s; } }, { cwd: s.f.sourceRoot, configDir: s.f.configDir });
      expect(code).toBe(0);
      const cli: unknown = JSON.parse(text);
      expect(result(await s.request('tools/call', { name, arguments: arguments_ })).structuredContent).toEqual(cli);
    }
    const missing = 'sha256:' + 'f'.repeat(64);
    const rejected = result(await s.request('tools/call', { name: 'lookup', arguments: {
      kind: 'evidence', ids: [id, missing], expectedGeneration: generation,
    } }));
    expect(rejected).toMatchObject({ isError: true, structuredContent: { data: null, errors: [{ code: 'KNOWLEDGE_INVALID' }] } });
    expect(JSON.stringify(rejected)).not.toContain(missing);
  } finally { await s.stop(); }
}, 30000);
it('returns a fixed parse error and closes on a malformed frame', async () => {
  const s = await start();
  s.input.write('{untrusted invalid json}\n');
  await s.stop();
  expect(s.messages.at(-1)).toMatchObject({ id: null, error: { code: -32700 } });
  expect(JSON.stringify(s.messages)).not.toContain('untrusted invalid json');
}, 30000);
it.each(['input', 'output'] as const)('closes safely when the %s stream fails or closes', async side => {
  const s = await start();
  let ended = false;
  void s.done.then(() => { ended = true; });
  try {
    if (side === 'input') s.input.destroy(new Error('Untrusted stream detail'));
    else s.output.destroy();
    await expect.poll(() => ended, { timeout: 1500 }).toBe(true);
  } finally { await s.stop(); }
  expect(JSON.stringify(s.messages)).not.toContain('Untrusted stream detail');
}, 30000);
it('keeps request IDs reserved while a response waits for output drain', async () => {
  const input = new PassThrough();
  const output = new Writable({ highWaterMark: 1, write: () => { /* Deliberately blocked reader. */ } });
  const transport = new ProjectTransport(input, output, 'parcel', () => undefined);
  const replies: Promise<void>[] = [];
  let delivered = 0;
  transport.onmessage = () => { delivered++; replies.push(transport.send({ jsonrpc: '2.0', id: 7, result: {} })); };
  await transport.start();
  try {
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }) + '\n');
    await expect.poll(() => delivered).toBe(1);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    expect(delivered).toBe(1);
  } finally {
    output.destroy(new Error('Stop blocked output'));
    await Promise.allSettled(replies); await transport.close(); input.destroy();
  }
});
it('requires a new session after the saved connection becomes invalid', async () => {
  const s = await start();
  let ended = false;
  void s.done.then(() => { ended = true; });
  try {
    await writeFile(join(s.f.sourceRoot, '.buildlore/connection.json'), '{}\n');
    expect(result(await s.request('tools/call', { name: 'list', arguments: {} }))).toMatchObject({
      isError: true, structuredContent: { data: null, errors: [{ code: 'CONNECTION_INVALID' }] },
    });
    await expect.poll(() => ended, { timeout: 1500 }).toBe(true);
  } finally { await s.stop(); }
}, 30000);
