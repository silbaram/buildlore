/** Internal filesystem policy; Windows mode bits do not describe its ACL. */
export function hasExpectedFilePermissions(
  mode: number,
  expected: 0o600 | 0o700,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    // Node exposes read/write attributes, without POSIX owner/group separation.
    // Actual access is enforced by the OS when opening or changing the file.
    return (mode & 0o600) === 0o600;
  }
  return (mode & 0o777) === expected;
}

export function usesPosixFilePermissions(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}
