import { hasReadControl } from '../application/read-validation.js';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { type Transport, type JSONRPCMessage, isJSONRPCRequest, isJSONRPCNotification, isJSONRPCErrorResponse, isJSONRPCResultResponse } from '@modelcontextprotocol/server';
import { Transform, type Readable, type Writable } from 'node:stream';
import { decodeUtf8Strict, parseJsonStrict } from '../knowledge/strict-json.js';
import { containsCredentialMaterial } from '../sanitizer/service.js';
import { isToolName } from './requests.js';
import { toolFailure } from './server.js';

const MAX_OUTPUT = 8 * 1024 * 1024;
/** The SDK owns framing; this boundary owns limits, safe errors and supported methods. */
export class ProjectTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly sdk: StdioServerTransport;
  private readonly checked: Transform;
  private initialized = false;
  private opened = false;
  private closed = false;
  private failed = false;
  private bytes = 0;
  private readonly active = new Map<string | number, string>();
  private readonly cancelled = new Set<string | number>();
  private readonly writes = new Set<Promise<void>>();
  constructor(input: Readable, private readonly output: Writable, private readonly projectId: string, private readonly end: () => void) {
    let buffer = Buffer.alloc(0);
    this.checked = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        try {
          if (buffer.length + chunk.length > 1024 * 1024) throw new Error('MCP_INPUT_TOO_LARGE');
          buffer = Buffer.concat([buffer, chunk]);
          let index: number;
          while ((index = buffer.indexOf(10)) >= 0) {
            const bytes = buffer.subarray(0, index);
            parseJsonStrict(decodeUtf8Strict(bytes));
            this.checked.push(Buffer.concat([bytes, Buffer.from('\n')]));
            buffer = buffer.subarray(index + 1);
          }
          callback();
        } catch { callback(new Error('MCP_PROTOCOL_INVALID')); }
      },
      flush: callback => { callback(buffer.length ? new Error('MCP_PROTOCOL_INVALID') : undefined); },
    });
    this.checked.on('error', () => { this.fail(-32700); });
    input.pipe(this.checked);
    this.sdk = new StdioServerTransport(this.checked, output, { maxBufferSize: 1024 * 1024 });
    this.sdk.onmessage = message => this.receive(message);
    this.sdk.onerror = () => { this.fail(); };
    this.sdk.onclose = () => { this.end(); };
  }
  private fail(code = -32600): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    // Malformed frames have no safe request id. This fixed JSON-RPC error contains no source bytes.
    if (!this.output.destroyed && this.bytes < MAX_OUTPUT - 256) this.output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message: 'MCP request rejected.' } }) + '\n');
    this.onerror?.(new Error('MCP_PROTOCOL_INVALID')); this.end();
  }
  private respond(id: string | number, code: number): void {
    const work = this.transmit({ jsonrpc: '2.0', id, error: { code, message: 'MCP request rejected.' } });
    this.track(work);
  }
  private track(work: Promise<void>): void {
    this.writes.add(work);
    void work.catch(() => { this.fail(); }).finally(() => { this.writes.delete(work); });
  }
  private receive(message: JSONRPCMessage): void {
    if (this.closed || this.failed) return;
    if (isJSONRPCRequest(message)) {
      const id = message.id;
      if (!(typeof id === 'number' ? Number.isSafeInteger(id) : id.length > 0 && id.length <= 128 && !hasReadControl(id) && !containsCredentialMaterial(id))) {
        this.fail(); return;
      }
      if (this.active.has(id)) { this.respond(id, -32600); return; }
      if (message.method === 'initialize') {
        if (this.opened) { this.respond(id, -32600); return; }
        this.opened = true;
      } else if (message.method !== 'ping' && !this.initialized) { this.respond(id, -32600); return; }
      if (!['initialize', 'ping', 'tools/list', 'tools/call'].includes(message.method)) { this.respond(id, -32601); return; }
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        if (typeof name !== 'string' || !isToolName(name)) { this.respond(id, -32602); return; }
        this.active.set(id, name);
      } else this.active.set(id, message.method);
      this.onmessage?.(message);
    } else if (isJSONRPCNotification(message)) {
      if (message.method === 'notifications/initialized' && this.opened) this.initialized = true;
      else if (message.method === 'notifications/cancelled') {
        const id = message.params?.requestId;
        if (typeof id === 'string' || typeof id === 'number') if (this.active.has(id)) this.cancelled.add(id);
      } else return;
      this.onmessage?.(message);
    }
  }
  async start(): Promise<void> { await this.sdk.start(); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sdk.close();
    this.checked.destroy();
    this.onclose?.();
  }
  finishCancelled(id: string | number): void { this.active.delete(id); this.cancelled.delete(id); }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.failed) return;
    let safe = message;
    let completedId: string | number | undefined;
    if (isJSONRPCErrorResponse(message)) safe = { jsonrpc: '2.0', id: message.id, error: { code: message.error.code, message: 'MCP request rejected.' } };
    if (isJSONRPCErrorResponse(safe) || isJSONRPCResultResponse(safe)) {
      const id = safe.id;
      const name = id === undefined ? undefined : this.active.get(id);
      if (id !== undefined && this.cancelled.delete(id)) { this.active.delete(id); return; }
      if (Buffer.byteLength(JSON.stringify(safe)) + 1 > MAX_OUTPUT) {
        if (id !== undefined && name && isToolName(name)) safe = { jsonrpc: '2.0', id, result: toolFailure(name, this.projectId, 'MCP_RESPONSE_TOO_LARGE') };
        else { this.fail(); return; }
      }
      completedId = id;
    }
    try { await this.transmit(safe); } finally {
      if (completedId !== undefined) this.active.delete(completedId);
    }
  }
  private async transmit(safe: JSONRPCMessage): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(safe)) + 1;
    if (bytes > MAX_OUTPUT || this.bytes + bytes > MAX_OUTPUT) { this.fail(); return; }
    this.bytes += bytes;
    const timer = setTimeout(() => { this.fail(); }, 10000);
    try { await this.sdk.send(safe); } finally { clearTimeout(timer); this.bytes -= bytes; }
  }
}
