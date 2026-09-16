import { AsyncLocalStorage } from 'node:async_hooks';
const cancellation = new AsyncLocalStorage<AbortSignal>();
export function assertReadActive(): void { cancellation.getStore()?.throwIfAborted(); }
/** Scoped to one MCP request; existing CLI/write invocations have no signal. */
export function withReadCancellation<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  return cancellation.run(signal, read);
}
export function readProcessOptions(): { signal?: AbortSignal; killSignal?: NodeJS.Signals } {
  const signal = cancellation.getStore();
  return signal ? { signal, killSignal: 'SIGKILL' } : {};
}
