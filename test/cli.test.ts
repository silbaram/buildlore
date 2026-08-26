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

  it('documents the canonical workflow, common JSON mode, and provider requirements', () => {
    for (const command of [
      'init',
      'project add',
      'project bind',
      'project list',
      'project show',
      'sync',
      'compile',
      'check',
      'search',
      'query',
      'context',
    ]) {
      expect(HELP_TEXT).toContain(`buildlore ${command}`);
    }
    expect(HELP_TEXT).toContain('buildlore.cli-envelope.v1');
    expect(HELP_TEXT).toContain('Provider requirements:');
    expect(HELP_TEXT).toContain('Required     legacy compile, query');
    expect(HELP_TEXT).toContain('BuildLore never launches a Claude or Codex CLI process');
  });

  it('fails closed without reflecting unsupported input', async () => {
    const secretLikeInput = 'token=do-not-reflect-me';
    const result = await captureCli([secretLikeInput]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'unknown: failed\n' +
      'error CLI_COMMAND_UNSUPPORTED: Command usage is invalid. Run buildlore --help for usage.\n',
    );
    expect(result.stderr).not.toContain(secretLikeInput);
  });

  it('emits a versioned JSON failure envelope when requested', async () => {
    const result = await captureCli(['unsupported', '--json']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 'buildlore.cli-envelope.v1',
      command: 'unknown',
      ok: false,
      projectId: null,
      workspacePath: null,
      knowledgeRevision: null,
      data: null,
      partial: false,
      warnings: [],
      errors: [
        {
          code: 'CLI_COMMAND_UNSUPPORTED',
          message: 'Command usage is invalid. Run buildlore --help for usage.',
        },
      ],
    });
  });

  it('keeps the canonical command in known-command JSON usage failures', async () => {
    const result = await captureCli(['compile', '--all', '--json']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      command: 'compile',
      errors: [{ code: 'CLI_OPTION_UNSUPPORTED' }],
      ok: false,
    });
  });
});
