import { describe, expect, it } from 'vitest';

import { HELP_TEXT, runCli, type CliIo } from '../src/cli/index.js';

function captureCli(args: readonly string[]): {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
} {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (message) => {
      stdout += message;
    },
    stderr: (message) => {
      stderr += message;
    },
  };

  return {
    exitCode: runCli(args, io),
    stderr,
    stdout,
  };
}

describe('BuildLore CLI', () => {
  it.each([
    { args: [] as const, label: 'no arguments' },
    { args: ['--help'] as const, label: '--help' },
    { args: ['-h'] as const, label: '-h' },
  ])('prints help for $label', ({ args }) => {
    expect(captureCli(args)).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: HELP_TEXT,
    });
  });

  it('fails closed without reflecting unsupported input', () => {
    const secretLikeInput = 'token=do-not-reflect-me';
    const result = captureCli([secretLikeInput]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Unsupported command. Run buildlore --help for usage.\n');
    expect(result.stderr).not.toContain(secretLikeInput);
  });
});
