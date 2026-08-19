import { join } from 'node:path';

import { compilerStatusPort } from '../compiler/index.js';
import { KnowledgeError, type KnowledgeErrorCode } from '../knowledge/errors.js';
import { cloneKnowledge, initKnowledge } from '../knowledge/git.js';
import { getKnowledgeStatus } from '../knowledge/status.js';
import { addProject, listProjects, showProject, validateProjectRegistry } from '../knowledge/workspace.js';
import { HELP_TEXT } from './help.js';

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliRuntime {
  readonly cwd: string;
  readonly compiler: typeof compilerStatusPort;
}

class CliUsageError extends Error {}

function optionsFrom(
  args: readonly string[],
  allowed: readonly string[],
  required: readonly string[] = [],
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !key.startsWith('--') ||
      value.startsWith('--') ||
      !allowed.includes(key) ||
      key in values
    ) {
      throw new CliUsageError('Invalid command arguments.');
    }
    values[key] = value;
  }
  if (required.some((key) => !(key in values))) {
    throw new CliUsageError('A required command argument is missing.');
  }
  return values;
}

function requiredOption(options: Readonly<Record<string, string>>, key: string): string {
  const value = options[key];
  if (value === undefined) {
    throw new CliUsageError('A required command argument is missing.');
  }
  return value;
}

function writeJson(io: CliIo, value: unknown, error = false): void {
  const message = `${JSON.stringify(value)}\n`;
  if (error) {
    io.stderr(message);
  } else {
    io.stdout(message);
  }
}

function unhealthyKnowledgeStatus(value: unknown): {
  readonly knowledge: { readonly state: string };
  readonly ok: false;
  readonly recoveryCommand?: readonly string[];
} | null {
  if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== false) {
    return null;
  }
  if (!('knowledge' in value) || typeof value.knowledge !== 'object' || value.knowledge === null) {
    return null;
  }
  return value as {
    readonly knowledge: { readonly state: string };
    readonly ok: false;
    readonly recoveryCommand?: readonly string[];
  };
}

function statusErrorCode(state: string): KnowledgeErrorCode {
  switch (state) {
    case 'unconfigured':
      return 'KNOWLEDGE_NOT_CONFIGURED';
    case 'uninitialized':
      return 'SUBMODULE_UNINITIALIZED';
    case 'conflicted':
      return 'SUBMODULE_CONFLICT';
    default:
      return 'SUBMODULE_MISMATCH';
  }
}

async function assertProjectCommandsReady(runtime: CliRuntime): Promise<void> {
  const status = await getKnowledgeStatus(runtime.cwd);
  if (!status.ok) {
    throw new KnowledgeError(
      statusErrorCode(status.knowledge.state),
      'Knowledge repository requires recovery before project access.',
      status.recoveryCommand === undefined
        ? {}
        : { recoveryCommand: status.recoveryCommand },
    );
  }
}

async function executeCommand(
  args: readonly string[],
  runtime: CliRuntime,
): Promise<unknown> {
  const [group, operation, ...rest] = args;
  if (group === 'knowledge' && operation === 'clone') {
    const options = optionsFrom(rest, ['--branch', '--repository', '--revision'], ['--repository']);
    return cloneKnowledge(runtime.cwd, {
      ...(options['--branch'] === undefined ? {} : { branch: options['--branch'] }),
      repository: requiredOption(options, '--repository'),
      ...(options['--revision'] === undefined ? {} : { revision: options['--revision'] }),
    });
  }
  if (group === 'knowledge' && operation === 'init') {
    optionsFrom(rest, []);
    return initKnowledge(runtime.cwd);
  }
  if (group === 'knowledge' && operation === 'status') {
    const options = optionsFrom(rest, ['--project-id']);
    return getKnowledgeStatus(runtime.cwd, {
      compiler: runtime.compiler,
      ...(options['--project-id'] === undefined ? {} : { projectId: options['--project-id'] }),
    });
  }

  const knowledgeRoot = join(runtime.cwd, 'knowledge');
  if (group === 'project' && operation === 'add') {
    const options = optionsFrom(
      rest,
      ['--display-name', '--project-id', '--source-repository'],
      ['--display-name', '--project-id', '--source-repository'],
    );
    await assertProjectCommandsReady(runtime);
    return addProject(knowledgeRoot, {
      displayName: requiredOption(options, '--display-name'),
      projectId: requiredOption(options, '--project-id'),
      sourceRepository: requiredOption(options, '--source-repository'),
    });
  }
  if (group === 'project' && operation === 'list') {
    optionsFrom(rest, []);
    await assertProjectCommandsReady(runtime);
    return listProjects(knowledgeRoot);
  }
  if (group === 'project' && operation === 'show') {
    const options = optionsFrom(rest, ['--project-id'], ['--project-id']);
    await assertProjectCommandsReady(runtime);
    return showProject(knowledgeRoot, requiredOption(options, '--project-id'));
  }
  if (group === 'project' && operation === 'validate') {
    const options = optionsFrom(rest, ['--project-id']);
    await assertProjectCommandsReady(runtime);
    return validateProjectRegistry(knowledgeRoot, options['--project-id']);
  }
  throw new CliUsageError('Unsupported command.');
}

export async function runCli(
  args: readonly string[],
  io: CliIo,
  runtime: CliRuntime = { compiler: compilerStatusPort, cwd: process.cwd() },
): Promise<number> {
  if (args.length === 0 || args.every((argument) => argument === '--help' || argument === '-h')) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  try {
    const data = await executeCommand(args, runtime);
    const unhealthyStatus = unhealthyKnowledgeStatus(data);
    if (unhealthyStatus !== null) {
      writeJson(
        io,
        {
          data,
          error: {
            code: statusErrorCode(unhealthyStatus.knowledge.state),
            message: 'Knowledge repository requires recovery before project access.',
            ...(unhealthyStatus.recoveryCommand === undefined
              ? {}
              : { recoveryCommand: unhealthyStatus.recoveryCommand }),
          },
          ok: false,
        },
        true,
      );
      return 1;
    }
    writeJson(io, { data, ok: true });
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr('Unsupported command. Run buildlore --help for usage.\n');
      return 2;
    }
    if (error instanceof KnowledgeError) {
      writeJson(
        io,
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.recoveryCommand === undefined
              ? {}
              : { recoveryCommand: error.recoveryCommand }),
          },
          ok: false,
        },
        true,
      );
      return 1;
    }
    writeJson(
      io,
      { error: { code: 'INTERNAL_ERROR', message: 'BuildLore could not complete the command.' }, ok: false },
      true,
    );
    return 1;
  }
}
