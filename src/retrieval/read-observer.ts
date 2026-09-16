export type ReadPhase = 'connection' | 'publication' | 'policy' | 'materialized-screen' | 'lookup-project' | 'response-screen';
export interface ReadMeasurement { readonly phase: ReadPhase; readonly durationMs: number; readonly count: number }
export type ReadObserver = (measurement: ReadMeasurement) => void;

/** Local, opt-in inclusive timings. Observers receive no content, paths or identifiers. */
export async function measureRead<T>(observer: ReadObserver | undefined, phase: ReadPhase,
  read: () => Promise<T>, count = 1,
): Promise<T> {
  if (!observer) return read();
  const start = performance.now();
  try { return await read(); }
  finally {
    try { observer(Object.freeze({ phase, durationMs: performance.now() - start, count })); }
    catch { /* Observation must not change the read's result or security checks. */ }
  }
}
