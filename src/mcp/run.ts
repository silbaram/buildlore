import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { resolveConnection, type ConnectionOptions } from '../connection/service.js';
import { createProjectMcpServer } from './server.js';
import { ProjectTransport } from './transport.js';
import { withReadCancellation } from '../application/read-cancellation.js';

export async function runMcp(args: readonly string[], input: Readable, output: Writable,
  diagnostic: (message: string) => void, options: ConnectionOptions = {}): Promise<number> {
  if (!(args.length === 3 && args[0] === '--project-dir' && args[1] && isAbsolute(args[1]) && args[2] === '--read-only')) {
    diagnostic('CLI_ARGUMENT_INVALID\n'); return 2;
  }
  const root = args[1];
  if (!root) return 2;
  const controller = new AbortController();
  let stop: () => void = () => undefined;
  const closed = new Promise<void>(resolve => { stop = resolve; });
  const end = (): void => { controller.abort(); stop(); };
  // Register before resolving the connection: startup itself performs Git reads.
  input.on('error', end); input.once('end', end); input.once('close', end);
  output.on('error', end); output.once('close', end);
  process.once('SIGTERM', end); process.once('SIGINT', end);
  try {
    if (input.destroyed || input.readableEnded || output.destroyed) end();
    const context = await withReadCancellation(controller.signal, async () => {
      controller.signal.throwIfAborted();
      return resolveConnection(root, options);
    });
    if (controller.signal.aborted) return 0;
    if (!context) { diagnostic('CONNECTION_MISSING\n'); return 2; }
    const transport = new ProjectTransport(input, output, context.projectId, end);
    const api = createProjectMcpServer(context, controller.signal, { onConnectionChange: () => { setImmediate(end); }, onCancelledSettled: id => transport.finishCancelled(id) });
    try {
      await api.server.connect(transport);
      await closed;
      await api.server.close();
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([api.settled(), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); } finally { clearTimeout(timer); }
    } finally {
      end(); await transport.close();
    }
    return 0;
  } catch {
    if (controller.signal.aborted) return 0;
    diagnostic('MCP_CONNECTION_FAILED\n'); return 3;
  } finally {
    end();
    input.off('error', end); input.off('end', end); input.off('close', end);
    output.off('error', end); output.off('close', end);
    process.off('SIGTERM', end); process.off('SIGINT', end);
  }
}
