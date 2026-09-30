import { describe, expect, it } from 'vitest';

import { hasExpectedFilePermissions, usesPosixFilePermissions } from '../src/knowledge/file-permissions.js';

describe('managed state file permissions', () => {
  it('accepts Windows read/write attributes without pretending they express private ACLs', () => {
    expect(hasExpectedFilePermissions(0o666, 0o600, 'win32')).toBe(true);
    expect(hasExpectedFilePermissions(0o666, 0o700, 'win32')).toBe(true);
    expect(hasExpectedFilePermissions(0o444, 0o600, 'win32')).toBe(false);
    expect(usesPosixFilePermissions('win32')).toBe(false);
  });

  it('keeps group/other access and directory execute requirements on POSIX', () => {
    expect(hasExpectedFilePermissions(0o600, 0o600, 'linux')).toBe(true);
    expect(hasExpectedFilePermissions(0o700, 0o700, 'linux')).toBe(true);
    expect(hasExpectedFilePermissions(0o666, 0o600, 'linux')).toBe(false);
    expect(hasExpectedFilePermissions(0o777, 0o700, 'linux')).toBe(false);
    expect(hasExpectedFilePermissions(0o600, 0o700, 'linux')).toBe(false);
    expect(usesPosixFilePermissions('linux')).toBe(true);
  });
});
