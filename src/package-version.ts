import { readFileSync } from 'node:fs';

/** Resolve metadata relative to this package, never to the caller's workspace. */
export function packageVersion(): string {
  const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof metadata !== 'object' || metadata === null || !('version' in metadata) ||
      typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(metadata.version)) {
    throw new Error('Invalid package version.');
  }
  return metadata.version;
}
