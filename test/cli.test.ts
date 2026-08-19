import { describe, expect, it } from 'vitest';

import { HELP_TEXT, runCli, type CliIo } from '../src/cli/index.js';

async function captureCli(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
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
    exitCode: await runCli(args, io),
    stderr,
    stdout,
  };
}

describe('BuildLore CLI', () => {
  it.each([
    { args: [] as const, label: 'no arguments' },
    { args: ['--help'] as const, label: '--help' },
    { args: ['-h'] as const, label: '-h' },
  ])('prints help for $label', async ({ args }) => {
    await expect(captureCli(args)).resolves.toEqual({
      exitCode: 0,
      stderr: '',
      stdout: HELP_TEXT,
    });
  });

  it('fails closed without reflecting unsupported input', async () => {
    const secretLikeInput = 'token=do-not-reflect-me';
    const result = await captureCli([secretLikeInput]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Unsupported command. Run buildlore --help for usage.\n');
    expect(result.stderr).not.toContain(secretLikeInput);
  });
});
