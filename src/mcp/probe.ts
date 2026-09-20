import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { parseJsonStrict } from '../knowledge/strict-json.js';
import { validReadPage } from '../application/read-validation.js';
import { packageVersion } from '../package-version.js';

export class McpProbeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'McpProbeError'; }
}
function invalid(code = 'MCP_PROTOCOL_INVALID'): never { throw new McpProbeError(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

/** Bounded stdio transport. No child output is copied into diagnostics. */
export class McpProbe {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private nextId = 0;
  private fatal: McpProbeError | null = null;
  private stopped = false;
  private readonly deadline: NodeJS.Timeout;
  // Approved-history validation can exceed 10s; allow the server's existing 60s request budget.
  constructor(program: string, args: readonly string[], env: NodeJS.ProcessEnv, private readonly timeoutMs = 60000,
    totalTimeoutMs = 300000, private readonly maxBytes = 8 * 1024 * 1024) {
    this.child = spawn(program, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.closed = new Promise(resolve => this.child.once('close', () => {
      this.stopped = true; this.fail('MCP_EXITED'); resolve();
    }));
    this.deadline = setTimeout(() => this.fail('MCP_TIMEOUT'), totalTimeoutMs);
    this.child.on('error', () => this.fail('MCP_START_FAILED'));
    this.child.stdin.on('error', () => this.fail('MCP_EXITED'));
    this.child.stdout.on('error', () => this.fail('MCP_PROTOCOL_INVALID'));
    this.child.stderr.on('error', () => this.fail('MCP_PROTOCOL_INVALID'));
    let stderrBytes = 0, stdoutBytes = 0;
    this.child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) this.fail('MCP_OUTPUT_LIMIT');
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.fatal) return;
      stdoutBytes += chunk.length;
      this.buffer += this.decoder.write(chunk);
      if (stdoutBytes > 64 * 1024 * 1024 || Buffer.byteLength(this.buffer) > this.maxBytes) { this.fail('MCP_OUTPUT_LIMIT'); return; }
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = object(parseJsonStrict(line));
          if (message.jsonrpc !== '2.0') invalid();
          if (!('id' in message) && typeof message.method === 'string') continue;
          if (typeof message.id !== 'number') invalid();
          const request = this.pending.get(message.id);
          if (!request) invalid();
          if ('error' in message) request.reject(new McpProbeError('MCP_RPC_FAILED'));
          else request.resolve(object(message.result));
          this.pending.delete(message.id);
        } catch { this.fail('MCP_PROTOCOL_INVALID'); return; }
      }
    });
  }
  private fail(code: string): void {
    this.fatal ??= new McpProbeError(code);
    for (const request of this.pending.values()) request.reject(this.fatal);
    this.pending.clear();
    if (!this.stopped) this.child.kill('SIGKILL');
  }
  notify(method: string): void {
    if (this.fatal) throw this.fatal;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }
  async request(method: string, params: object = {}): Promise<Record<string, unknown>> {
    if (this.fatal) throw this.fatal;
    const id = ++this.nextId;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => this.fail('MCP_TIMEOUT'), this.timeoutMs);
        const bytes = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        if (Buffer.byteLength(bytes) > 16384) { this.fail('MCP_REQUEST_LIMIT'); return; }
        this.child.stdin.write(bytes);
      });
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async close(): Promise<void> {
    clearTimeout(this.deadline);
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}

export type ProbeStage = 'initialize' | 'tools' | 'status' | 'list' | 'search' | 'read';
export async function inspectWikiProtocol(peer: Pick<McpProbe, 'request' | 'notify'>, projectId: string,
  stage: (id: ProbeStage, state: 'pending' | 'complete') => void,
): Promise<void> {
  const step = async <T>(id: ProbeStage, work: () => Promise<T>): Promise<T> => {
    stage(id, 'pending'); const result = await work(); stage(id, 'complete'); return result;
  };
  const call = async (name: string, args: object = {}, generation?: string): Promise<Record<string, unknown>> => {
    const result = await peer.request('tools/call', { name, arguments: args });
    const envelope = object(result.structuredContent);
    if (result.isError || envelope.ok !== true) {
      const allowed = new Set(['APPROVAL_MISSING', 'KNOWLEDGE_INVALID', 'GENERATION_CHANGED', 'PROJECT_MISMATCH', 'CONNECTION_CONFLICT', 'KNOWLEDGE_PIN_MISMATCH', 'FORMAT_UNSUPPORTED']);
      const first: unknown = Array.isArray(envelope.errors) ? envelope.errors[0] : null;
      const code = first && typeof first === 'object' && 'code' in first ? first.code : null;
      invalid(typeof code === 'string' && allowed.has(code) ? code : 'MCP_TOOL_FAILED');
    }
    if (envelope.projectId !== projectId) invalid('PROJECT_MISMATCH');
    if (generation !== undefined && object(envelope.readContext).generation !== generation) invalid('GENERATION_CHANGED');
    return envelope;
  };
  await step('initialize', async () => {
    const result = await peer.request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'buildlore-workspace-check', version: packageVersion() } });
    if (result.protocolVersion !== '2025-11-25' || object(result.serverInfo).name !== 'buildlore') invalid();
    if (object(result.serverInfo).version !== packageVersion()) invalid('MCP_VERSION_MISMATCH');
    peer.notify('notifications/initialized');
  });
  await step('tools', async () => {
    const result = await peer.request('tools/list');
    if (!Array.isArray(result.tools)) invalid();
    const names = new Set(result.tools.map((tool: unknown) => object(tool).name));
    if (!['status', 'list', 'search', 'read'].every(name => names.has(name))) invalid('MCP_TOOLS_MISSING');
  });
  const status = await step('status', async () => {
    const data = object((await call('status')).data);
    if (data.projectId !== projectId) invalid('PROJECT_MISMATCH');
    if (data.readable !== true) invalid('APPROVAL_MISSING');
    if (data.dirty !== 'clean') invalid('KNOWLEDGE_DIRTY');
    if (typeof data.generation !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(data.generation)) invalid();
    return data.generation;
  });
  const listed = await step('list', async () => {
    const data = object((await call('list', { limit: 1, expectedGeneration: status }, status)).data);
    if (data.projectId !== projectId) invalid('PROJECT_MISMATCH');
    if (!Array.isArray(data.pages) || !data.pages.length) invalid('WIKI_EMPTY');
    const first = object(data.pages[0]);
    if (typeof first.title !== 'string' || !/[\p{L}\p{N}]/u.test(first.title)) invalid('WIKI_EMPTY');
    return first.title.slice(0, 1024);
  });
  const page = await step('search', async () => {
    const data = object((await call('search', { query: listed, expectedGeneration: status }, status)).data);
    if (data.projectId !== projectId) invalid('PROJECT_MISMATCH');
    if (!Array.isArray(data.hits) || !data.hits.length) invalid('SEARCH_EMPTY');
    const locator = object(object(data.hits[0]).locator);
    if (locator.projectId !== projectId || typeof locator.pageId !== 'string' || !validReadPage(locator.pageId)) invalid('PROJECT_MISMATCH');
    return locator.pageId;
  });
  await step('read', async () => {
    const data = object((await call('read', { page, expectedGeneration: status }, status)).data);
    if (data.projectId !== projectId) invalid('PROJECT_MISMATCH');
    if (data.pageId !== page) invalid('MCP_PAGE_MISMATCH');
    // Project-knowledge returns Markdown; legacy hierarchy returns a structured page.
    if (typeof data.markdown === 'string' && data.markdown.trim()) return;
    if (Array.isArray(data.sections) && data.sections.some((section: unknown) => {
      const body = object(section).body; return typeof body === 'string' && body.trim();
    })) return;
    invalid('WIKI_READ_EMPTY');
  });
}
