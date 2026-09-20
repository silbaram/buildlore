import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Drive paths are local paths, including when Git prints them with forward slashes. */
export function isRemoteRepository(value: string): boolean {
  return !/^[A-Za-z]:/u.test(value) &&
    (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) || /^(?:[^/@:]+@)?[^/:]+:/u.test(value));
}

export async function sameRepository(a: string, aRoot: string, b: string, bRoot: string): Promise<boolean> {
  if (isRemoteRepository(a) || isRemoteRepository(b)) return a === b;
  try { return await realpath(path.resolve(aRoot, a)) === await realpath(path.resolve(bRoot, b)); }
  catch { return false; }
}

export function containsPath(root: string, candidate: string, paths: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path): boolean {
  const difference = paths.relative(root, candidate);
  return difference === '' || (!paths.isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${paths.sep}`));
}
