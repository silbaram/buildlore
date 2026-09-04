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
      args: [
        'project', 'add', '--id', 'alpha', '--source-repo', '../alpha',
        '--source-root', '/workspace/alpha',
      ],
      command: 'project.add',
    },
    {
      args: ['project', 'bind', '--project', 'alpha', '--source-root', '/workspace/alpha'],
      command: 'project.bind',
    },
    { args: ['project', 'list'], command: 'project.list' },
    { args: ['project', 'show', '--project', 'alpha'], command: 'project.show' },
    {
      args: [
        'source', 'add', '--project', 'alpha', '--id', 'guide', '--kind', 'markdown',
        '--path', 'docs/guide.md',
      ],
      command: 'source.add',
    },
    { args: ['source', 'list', '--project', 'alpha'], command: 'source.list' },
    { args: ['source', 'diff', '--project', 'alpha'], command: 'source.diff' },
    { args: ['wiki', 'list', '--project', 'alpha', '--limit', '25'], command: 'wiki.list' },
    { args: ['wiki', 'curate', '--project', 'alpha'], command: 'wiki.curate' },
    {
      args: ['wiki', 'read', '--project', 'alpha', '--page', 'concepts/local-search'],
      command: 'wiki.read',
    },
    {
      args: ['wiki', 'citations', '--project', 'alpha', '--page', 'concepts/local-search'],
      command: 'wiki.citations',
    },
    {
      args: ['export', '--project', 'alpha', '--format', 'json', '--output', 'exports/alpha'],
      command: 'export',
    },
    { args: ['sync', '--project', 'alpha', '--dry-run'], command: 'sync' },
    { args: ['compile', '--project', 'alpha', '--review'], command: 'compile' },
    { args: ['compile', 'plan', '--project', 'alpha'], command: 'compile.plan' },
    {
      args: [
        'compile', 'apply', '--project', 'alpha', '--page', 'one.json', '--page', 'two.json',
      ],
      command: 'compile.apply',
    },
    { args: ['compile', 'candidates', '--project', 'alpha'], command: 'compile.candidates' },
    {
      args: ['compile', 'approve', '--project', 'alpha', '--candidate', `candidate-${'a'.repeat(64)}`],
      command: 'compile.approve',
    },
    {
      args: [
        'compile', 'activate', '--project', 'alpha', '--input',
        '.buildlore/approved-wiki.json', '--confirm-approval', `sha256:${'a'.repeat(64)}`,
      ],
      command: 'compile.activate',
    },
    {
      args: ['compile', 'activate', '--project', 'alpha', '--rematerialize'],
      command: 'compile.activate',
    },
    {
      args: ['compile', 'hierarchy', 'start', '--project', 'alpha', '--purpose', 'purpose.json'],
      command: 'compile.hierarchy.start',
    },
    {
      args: ['compile', 'hierarchy', 'status', '--project', 'alpha', '--run', `run-${'a'.repeat(64)}`],
      command: 'compile.hierarchy.status',
    },
    {
      args: [
        'compile', 'hierarchy', 'submit', '--project', 'alpha', '--run', `run-${'a'.repeat(64)}`,
        '--input', 'handoffs/proposal.json', '--expect-exchange', `sha256:${'b'.repeat(64)}`,
      ],
      command: 'compile.hierarchy.submit',
    },
    {
      args: [
        'compile', 'hierarchy', 'resubmit', '--project', 'alpha',
        '--run', `run-${'a'.repeat(64)}`, '--page', `page-${'c'.repeat(64)}`,
        '--input', 'handoffs/proposal.json', '--expect-exchange', `sha256:${'b'.repeat(64)}`,
      ],
      command: 'compile.hierarchy.resubmit',
    },
    {
      args: [
        'compile', 'hierarchy', 'child-review', '--project', 'alpha',
        '--run', `run-${'a'.repeat(64)}`, '--input', 'handoffs/child-review.json',
        '--expect-review', `sha256:${'c'.repeat(64)}`,
      ],
      command: 'compile.hierarchy.child-review',
    },
    {
      args: ['compile', 'hierarchy', 'review', '--project', 'alpha', '--run', `run-${'a'.repeat(64)}`],
      command: 'compile.hierarchy.review',
    },
    {
      args: [
        'compile', 'hierarchy', 'finalize', '--project', 'alpha',
        '--run', `run-${'a'.repeat(64)}`, '--input', 'handoffs/final-review.json',
        '--expect-review', `sha256:${'d'.repeat(64)}`,
      ],
      command: 'compile.hierarchy.finalize',
    },
    {
      args: [
        'compile', 'hierarchy', 'approve', '--project', 'alpha', '--run', `run-${'a'.repeat(64)}`,
        '--expect-ledger', `sha256:${'e'.repeat(64)}`, '--confirm-approval',
      ],
      command: 'compile.hierarchy.approve',
    },
    { args: ['check', '--project', 'alpha'], command: 'check' },
    { args: ['index', 'status', '--project', 'alpha'], command: 'index.status' },
    { args: ['index', 'rebuild', '--project', 'alpha', '--full'], command: 'index.rebuild' },
    {
      args: [
        'search', '--project', 'alpha', '--query', 'failure', '--mode', 'hybrid',
        '--intent', 'current',
      ],
      command: 'search',
    },
    { args: ['query', '--project', 'alpha', '--question', 'why'], command: 'query' },
    { args: ['context', '--project', 'alpha', '--prompt', 'fix it'], command: 'context' },
    {
      args: ['model', 'bind', '--profile', 'multilingual-e5-small'],
      command: 'model.bind',
    },
    {
      args: [
        'model', 'bind', '--profile', 'multilingual-e5-small', '--directory', '/models/e5',
      ],
      command: 'model.bind',
    },
    {
      args: ['model', 'inspect', '--profile', 'multilingual-e5-small'],
      command: 'model.inspect',
    },
    {
      args: ['model', 'verify', '--profile', 'multilingual-e5-small'],
      command: 'model.verify',
    },
    {
      args: ['publish', 'plan', '--project', 'alpha', '--source-revision', 'a'.repeat(40)],
      command: 'publish.plan',
    },
    {
      args: [
        'publish', 'commit', '--project', 'alpha', '--source-revision', 'a'.repeat(40),
        '--expect-plan', `sha256:${'b'.repeat(64)}`,
      ],
      command: 'publish.commit',
    },
    {
      args: ['publish', 'push', '--project', 'alpha', '--knowledge-revision', 'c'.repeat(40)],
      command: 'publish.push',
    },
    {
      args: [
        'knowledge', 'pin', 'plan', '--knowledge-revision', 'c'.repeat(40),
        '--iteration', 'v11-iteration', '--intent', 'iteration-close',
      ],
      command: 'knowledge.pin.plan',
    },
    {
      args: [
        'knowledge', 'pin', 'commit', '--knowledge-revision', 'c'.repeat(40),
        '--iteration', 'v11-iteration', '--intent', 'iteration-close',
        '--expect-plan', `sha256:${'d'.repeat(64)}`,
      ],
      command: 'knowledge.pin.commit',
    },
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
        '--source-root',
        '/workspace/alpha',
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
        '--source-root': '/workspace/alpha',
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

  it('preserves ordered repeated proposal files for session apply', () => {
    expect(parseCliArguments([
      'compile', 'apply', '--project', 'alpha',
      '--page', 'proposal-b.json', '--page', 'proposal-a.json',
    ])).toMatchObject({
      command: 'compile.apply',
      operation: 'compile.apply',
      options: {
        '--page': ['proposal-b.json', 'proposal-a.json'],
        '--project': 'alpha',
      },
    });
  });

  it('parses hierarchy approval confirmation as a required boolean without changing activation', () => {
    const approval = parseCliArguments([
      'compile', 'hierarchy', 'approve', '--project', 'alpha',
      '--run', `run-${'a'.repeat(64)}`, '--expect-ledger', `sha256:${'b'.repeat(64)}`,
      '--confirm-approval',
    ]);
    expect(approval).toMatchObject({
      command: 'compile.hierarchy.approve',
      options: { '--confirm-approval': true },
    });
    expect(parseCliArguments([
      'compile', 'activate', '--project', 'alpha',
      '--confirm-approval', `sha256:${'c'.repeat(64)}`,
    ])).toMatchObject({
      command: 'compile.activate',
      options: { '--confirm-approval': `sha256:${'c'.repeat(64)}` },
    });
  });

  it('accepts raw hierarchical page identifiers for Wiki reads and citations', () => {
    const pageId = `page-${'a'.repeat(64)}`;
    for (const command of ['read', 'citations']) {
      expect(parseCliArguments(['wiki', command, '--project', 'alpha', '--page', pageId]))
        .toMatchObject({ options: { '--page': pageId } });
    }
  });

  it('enforces hierarchy run, digest, and confined relative file contracts', () => {
    const run = `run-${'a'.repeat(64)}`;
    const digest = `sha256:${'b'.repeat(64)}`;
    const maximumPath = `${'a'.repeat(4_091)}.json`;
    expect(parseCliArguments([
      'compile', 'hierarchy', 'submit', '--project', 'alpha', '--run', run,
      '--input', maximumPath, '--expect-exchange', digest,
    ])).toMatchObject({ command: 'compile.hierarchy.submit' });
    expect(parseCliArguments([
      'compile', 'hierarchy', 'resubmit', '--project', 'alpha', '--run', run,
      '--page', `page-${'c'.repeat(64)}`, '--input', maximumPath,
      '--expect-exchange', digest,
    ])).toMatchObject({ command: 'compile.hierarchy.resubmit' });

    for (const invalidRun of ['run-1', `run-${'A'.repeat(64)}`, `other-${'a'.repeat(64)}`]) {
      expectUsageError([
        'compile', 'hierarchy', 'status', '--project', 'alpha', '--run', invalidRun,
      ], 'CLI_ARGUMENT_INVALID');
    }
    for (const invalidDigest of ['sha256:short', `sha256:${'A'.repeat(64)}`, 'b'.repeat(64)]) {
      expectUsageError([
        'compile', 'hierarchy', 'submit', '--project', 'alpha', '--run', run,
        '--input', 'proposal.json', '--expect-exchange', invalidDigest,
      ], 'CLI_ARGUMENT_INVALID');
    }
    for (const unsafePath of [
      '../purpose.json', 'nested/../purpose.json', '/purpose.json', '~/purpose.json',
      'C:/purpose.json', 'nested\\purpose.json', 'nested//purpose.json', 'nested/./purpose.json',
      'purpose\n.json', `${'a'.repeat(4_092)}.json`,
    ]) {
      expectUsageError([
        'compile', 'hierarchy', 'start', '--project', 'alpha', '--purpose', unsafePath,
      ], 'CLI_ARGUMENT_INVALID');
      expectUsageError([
        'compile', 'hierarchy', 'finalize', '--project', 'alpha', '--run', run,
        '--input', unsafePath, '--expect-review', digest,
      ], 'CLI_ARGUMENT_INVALID');
    }
  });

  it('rejects missing, duplicate, valued, and unsupported hierarchy options', () => {
    const run = `run-${'a'.repeat(64)}`;
    const digest = `sha256:${'b'.repeat(64)}`;
    expectUsageError([
      'compile', 'hierarchy', 'approve', '--project', 'alpha', '--run', run,
      '--expect-ledger', digest,
    ], 'CLI_OPTION_MISSING');
    expectUsageError([
      'compile', 'hierarchy', 'approve', '--project', 'alpha', '--run', run,
      '--expect-ledger', digest, '--confirm-approval', 'true',
    ], 'CLI_ARGUMENT_INVALID');
    expectUsageError([
      'compile', 'hierarchy', 'status', '--project', 'alpha', '--run', run, '--run', run,
    ], 'CLI_OPTION_CONFLICT');
    expectUsageError([
      'compile', 'hierarchy', 'review', '--project', 'alpha', '--run', run, '--input', 'x.json',
    ], 'CLI_OPTION_UNSUPPORTED');
    expectUsageError([
      'compile', 'hierarchy', 'submit', '--project', 'alpha', '--run', run,
      '--input', 'proposal.json',
    ], 'CLI_OPTION_MISSING');
    expectUsageError([
      'compile', 'hierarchy', 'resubmit', '--project', 'alpha', '--run', run,
      '--page', 'page-invalid', '--input', 'proposal.json', '--expect-exchange', digest,
    ], 'CLI_ARGUMENT_INVALID');
  });

  it.each([1, 50, 51, 184, 8192])(
    'accepts %i proposal files for one session apply invocation',
    (count) => {
      const pages = Array.from({ length: count }, (_, index) => `proposal-${String(index)}.json`);
      const parsed = parseCliArguments([
        'compile', 'apply', '--project', 'alpha',
        ...pages.flatMap((page) => ['--page', page]),
      ]);
      expect(parsed).toMatchObject({ command: 'compile.apply' });
      if (parsed.kind !== 'command') throw new Error('missing command fixture');
      expect(parsed.options['--page']).toEqual(pages);
    },
  );

  it('rejects a proposal set above the shared apply cardinality', () => {
    const pages = Array.from({ length: 8193 }, (_, index) => `proposal-${String(index)}.json`);
    expectUsageError([
      'compile', 'apply', '--project', 'alpha',
      ...pages.flatMap((page) => ['--page', page]),
    ], 'CLI_ARGUMENT_INVALID');
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
    expectUsageError(['compile', 'apply', '--project', 'alpha'], 'CLI_OPTION_MISSING');
    expectUsageError(['compile', 'approve', '--project', 'alpha'], 'CLI_OPTION_MISSING');
    expectUsageError(
      ['compile', 'approve', '--project', 'alpha', '--candidate', 'candidate-*'],
      'CLI_ARGUMENT_INVALID',
    );
    expectUsageError(
      ['compile', 'apply', '--project', 'alpha', '--page', 'unsafe\npath.json'],
      'CLI_ARGUMENT_INVALID',
    );
    expectUsageError(
      [
        'compile', 'activate', '--project', 'alpha', '--input', '../approved-wiki.json',
        '--confirm-approval', `sha256:${'a'.repeat(64)}`,
      ],
      'CLI_ARGUMENT_INVALID',
    );
    expectUsageError(
      ['compile', 'activate', '--project', 'alpha'],
      'CLI_OPTION_MISSING',
    );
    expectUsageError(
      ['compile', 'activate', '--project', 'alpha', '--confirm-approval', 'sha256:wrong'],
      'CLI_ARGUMENT_INVALID',
    );
    expectUsageError(
      [
        'compile', 'activate', '--project', 'alpha', '--rematerialize',
        '--confirm-approval', `sha256:${'a'.repeat(64)}`,
      ],
      'CLI_OPTION_CONFLICT',
    );
    expectUsageError([
      'source', 'add', '--project', 'alpha', '--id', 'unsafe', '--kind', 'markdown',
      '--path', 'docs/access-token/value.md',
    ], 'CLI_ARGUMENT_INVALID');
    expectUsageError(
      ['wiki', 'read', '--project', 'alpha', '--page', '../beta/private'],
      'CLI_ARGUMENT_INVALID',
    );
    expectUsageError(
      ['wiki', 'list', '--project', 'alpha', '--limit', '101'],
      'CLI_ARGUMENT_INVALID',
    );
    expectUsageError(
      ['export', '--project', 'alpha', '--format', 'html', '--output', 'exports/alpha'],
      'CLI_ARGUMENT_INVALID',
    );
    expectUsageError(['model', 'inspect'], 'CLI_OPTION_MISSING');
    expectUsageError(
      ['model', 'inspect', '--profile', 'another-model'],
      'CLI_ARGUMENT_INVALID',
    );
    expectUsageError(
      ['model', 'verify', '--profile', 'multilingual-e5-small', '--directory', '/model'],
      'CLI_OPTION_UNSUPPORTED',
    );
    expectUsageError(
      ['model', 'bind', '--profile', 'multilingual-e5-small', '--directory', 'unsafe\npath'],
      'CLI_ARGUMENT_INVALID',
    );
  });

  it('requires explicit project selection and validates search mode and intent', () => {
    expectUsageError(
      ['project', 'add', '--id', 'alpha', '--source-repo', '../alpha'],
      'CLI_OPTION_MISSING',
    );
    expectUsageError(['compile'], 'CLI_OPTION_MISSING');
    expectUsageError(['check', '--project', 'TOKEN=do-not-reflect'], 'CLI_ARGUMENT_INVALID');
    expectUsageError(
      ['search', '--project', 'alpha', '--query', 'failure', '--mode', 'future'],
      'CLI_ARGUMENT_INVALID',
    );
    expectUsageError(
      ['search', '--project', 'alpha', '--query', 'failure', '--intent', 'future'],
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

  it('binds publication flags and rejects non-canonical revision, digest, iteration, and intent', () => {
    expect(parseCliArguments([
      'publish', 'plan', '--project', 'alpha', '--source-revision', 'a'.repeat(40),
      '--include-policy-track', '--registration',
    ])).toMatchObject({
      operation: 'publish.plan',
      options: {
        '--include-policy-track': true,
        '--project': 'alpha',
        '--registration': true,
        '--source-revision': 'a'.repeat(40),
      },
    });

    for (const args of [
      ['publish', 'plan', '--project', 'alpha', '--source-revision', 'A'.repeat(40)],
      ['publish', 'push', '--project', 'alpha', '--knowledge-revision', 'a'.repeat(39)],
      [
        'publish', 'commit', '--project', 'alpha', '--source-revision', 'a'.repeat(40),
        '--expect-plan', 'sha256:short',
      ],
      [
        'knowledge', 'pin', 'plan', '--knowledge-revision', 'a'.repeat(40),
        '--iteration', 'UPPER', '--intent', 'iteration-close',
      ],
      [
        'knowledge', 'pin', 'plan', '--knowledge-revision', 'a'.repeat(40),
        '--iteration', 'v11', '--intent', 'close',
      ],
    ]) expectUsageError(args, 'CLI_ARGUMENT_INVALID');

    expectUsageError([
      'knowledge', 'pin', 'plan', '--knowledge-revision', 'a'.repeat(40),
      '--iteration', 'v11', '--intent', 'iteration-close', '--expect-plan',
      `sha256:${'a'.repeat(64)}`,
    ], 'CLI_OPTION_UNSUPPORTED');
  });
});
