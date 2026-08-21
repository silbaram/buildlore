import { describe, expect, it } from 'vitest';

import { CliUsageError, parseCliArguments } from '../src/cli/index.js';

function expectUsageError(args: readonly string[], code: string): void {
  try {
    parseCliArguments(args);
  } catch (error) {
    expect(error).toBeInstanceOf(CliUsageError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error('Expected CLI arguments to be rejected.');
}

describe('CLI argument parser', () => {
  it.each([
    { args: ['init', '--knowledge-repo', '../knowledge.git'], command: 'init' },
    {
      args: ['project', 'add', '--id', 'alpha', '--source-repo', '../alpha'],
      command: 'project.add',
    },
    { args: ['project', 'list'], command: 'project.list' },
    { args: ['project', 'show', '--project', 'alpha'], command: 'project.show' },
    { args: ['sync', '--project', 'alpha', '--dry-run'], command: 'sync' },
    { args: ['compile', '--project', 'alpha', '--review'], command: 'compile' },
    { args: ['check', '--project', 'alpha'], command: 'check' },
    {
      args: ['search', '--project', 'alpha', '--query', 'failure', '--mode', 'hybrid'],
      command: 'search',
    },
    { args: ['query', '--project', 'alpha', '--question', 'why'], command: 'query' },
    { args: ['context', '--project', 'alpha', '--prompt', 'fix it'], command: 'context' },
  ])('parses canonical $command', ({ args, command }) => {
    expect(parseCliArguments(args)).toMatchObject({ command, kind: 'command' });
    expect(parseCliArguments([...args, '--json'])).toMatchObject({
      command,
      kind: 'command',
      outputMode: 'json',
    });
  });

  it('normalizes project-add compatibility options and defaults to human output', () => {
    expect(
      parseCliArguments([
        'project',
        'add',
        '--project-id',
        'alpha',
        '--source-repository',
        '../alpha',
        '--display-name',
        'Alpha',
      ]),
    ).toEqual({
      command: 'project.add',
      kind: 'command',
      operation: 'project.add',
      options: {
        '--id': 'alpha',
        '--source-repo': '../alpha',
        '--name': 'Alpha',
      },
      outputMode: 'human',
      projectId: 'alpha',
    });
  });

  it('selects JSON output without changing the canonical command', () => {
    expect(parseCliArguments(['check', '--project', 'alpha', '--json'])).toMatchObject({
      command: 'check',
      options: { '--json': true, '--project': 'alpha' },
      outputMode: 'json',
      projectId: 'alpha',
    });
  });

  it('rejects unknown commands, options, missing values, conflicts, and --all', () => {
    expectUsageError(['unknown'], 'CLI_COMMAND_UNSUPPORTED');
    expectUsageError(['check', '--project', 'alpha', '--future'], 'CLI_OPTION_UNSUPPORTED');
    expectUsageError(['check', '--project'], 'CLI_OPTION_MISSING');
    expectUsageError(
      ['project', 'show', '--project', 'alpha', '--project-id', 'beta'],
      'CLI_OPTION_CONFLICT',
    );
    expectUsageError(['compile', '--all'], 'CLI_OPTION_UNSUPPORTED');
  });

  it('requires explicit project selection and validates search mode', () => {
    expectUsageError(['compile'], 'CLI_OPTION_MISSING');
    expectUsageError(['check', '--project', 'TOKEN=do-not-reflect'], 'CLI_ARGUMENT_INVALID');
    expectUsageError(
      ['search', '--project', 'alpha', '--query', 'failure', '--mode', 'future'],
      'CLI_ARGUMENT_INVALID',
    );
  });

  it('rejects unsafe retrieval text before command execution', () => {
    for (const query of ['   ', '...', 'line\nsecret', `unsafe${'\ud800'}`, 'a'.repeat(8_193)]) {
      expectUsageError(
        ['search', '--project', 'alpha', '--query', query],
        'CLI_ARGUMENT_INVALID',
      );
    }
    for (const [command, option] of [
      ['query', '--question'],
      ['context', '--prompt'],
    ] as const) {
      for (const value of ['   ', 'line\nsecret', `unsafe${'\ud800'}`, 'a'.repeat(8_193)]) {
        expectUsageError(
          [command, '--project', 'alpha', option, value],
          'CLI_ARGUMENT_INVALID',
        );
      }
    }
  });
});
