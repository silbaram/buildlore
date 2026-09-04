import { isGeneratedIdentifier } from '../sanitizer/index.js';
import { SESSION_COMPILE_LIMITS } from '../compiler/session/contracts.js';
import { validateSourceSelectionPath } from '../projector/source-manifest.js';
import type {
  CliCommandId,
  CliOperation,
  CliOptionValue,
  CliOutputMode,
  ParsedCliCommand,
  ParsedCliInvocation,
} from './types.js';

export type CliUsageErrorCode =
  | 'CLI_ARGUMENT_INVALID'
  | 'CLI_COMMAND_UNSUPPORTED'
  | 'CLI_OPTION_CONFLICT'
  | 'CLI_OPTION_MISSING'
  | 'CLI_OPTION_UNSUPPORTED';

export class CliUsageError extends Error {
  readonly code: CliUsageErrorCode;

  constructor(code: CliUsageErrorCode) {
    super('Command usage is invalid.');
    this.name = 'CliUsageError';
    this.code = code;
  }
}

interface CommandSpec {
  readonly command: CliCommandId;
  readonly flagOptions: readonly string[];
  readonly operation: CliOperation;
  readonly optionAliases?: Readonly<Record<string, string>>;
  readonly projectOption?: string;
  readonly requiredOptions: readonly string[];
  readonly repeatableValueOptions: readonly string[];
  readonly tokens: readonly string[];
  readonly valueOptions: readonly string[];
}

const COMMON_FLAGS = ['--json'] as const;
const MAX_RETRIEVAL_TEXT_LENGTH = 8_192;
const FULL_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PLAN_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HIERARCHY_RUN_ID_PATTERN = /^run-[0-9a-f]{64}$/u;
const ITERATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RESERVED_PROJECT_IDS = new Set(['knowledge', 'manifest', 'projects', 'shared']);
const LOCAL_MODEL_PROFILE_ID = 'multilingual-e5-small';

const COMMAND_SPECS: readonly CommandSpec[] = [
  command(
    ['init'],
    'init',
    'init',
    ['--knowledge-repo', '--branch', '--project', '--source-repo', '--source-root', '--name'],
    [],
    [],
    {},
    '--project',
  ),
  command(
    ['project', 'add'],
    'project.add',
    'project.add',
    ['--id', '--source-repo', '--source-root', '--name'],
    ['--id', '--source-repo', '--source-root'],
    [],
    {
      '--display-name': '--name',
      '--project-id': '--id',
      '--source-repository': '--source-repo',
    },
    '--id',
  ),
  command(
    ['project', 'bind'],
    'project.bind',
    'project.bind',
    ['--project', '--source-root'],
    ['--project', '--source-root'],
    [],
    { '--project-id': '--project' },
    '--project',
  ),
  command(['project', 'list'], 'project.list', 'project.list'),
  command(
    ['project', 'show'],
    'project.show',
    'project.show',
    ['--project'],
    ['--project'],
    [],
    { '--project-id': '--project' },
    '--project',
  ),
  command(
    ['source', 'add'],
    'source.add',
    'source.add',
    ['--project', '--id', '--kind', '--path'],
    ['--project', '--id', '--kind', '--path'],
    ['--recursive'],
    {},
    '--project',
  ),
  command(
    ['source', 'list'],
    'source.list',
    'source.list',
    ['--project'],
    ['--project'],
    [],
    {},
    '--project',
  ),
  command(
    ['source', 'diff'],
    'source.diff',
    'source.diff',
    ['--project'],
    ['--project'],
    [],
    {},
    '--project',
  ),
  command(
    ['wiki', 'list'],
    'wiki.list',
    'wiki.list',
    ['--project', '--cursor', '--limit'],
    ['--project'],
    [],
    {},
    '--project',
  ),
  command(
    ['wiki', 'curate'],
    'wiki.curate',
    'wiki.curate',
    ['--project'],
    ['--project'],
    [],
    {},
    '--project',
  ),
  command(
    ['wiki', 'read'],
    'wiki.read',
    'wiki.read',
    ['--project', '--page'],
    ['--project', '--page'],
    [],
    {},
    '--project',
  ),
  command(
    ['wiki', 'citations'],
    'wiki.citations',
    'wiki.citations',
    ['--project', '--page'],
    ['--project', '--page'],
    [],
    {},
    '--project',
  ),
  command(
    ['export'],
    'export',
    'export',
    ['--project', '--format', '--output'],
    ['--project', '--format', '--output'],
    [],
    {},
    '--project',
  ),
  command(['sync'], 'sync', 'sync', ['--project'], ['--project'], ['--dry-run'], {}, '--project'),
  command(
    ['compile', 'plan'],
    'compile.plan',
    'compile.plan',
    ['--project'],
    ['--project'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'apply'],
    'compile.apply',
    'compile.apply',
    ['--project', '--page'],
    ['--project', '--page'],
    [],
    {},
    '--project',
    ['--page'],
  ),
  command(
    ['compile', 'candidates'],
    'compile.candidates',
    'compile.candidates',
    ['--project'],
    ['--project'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'approve'],
    'compile.approve',
    'compile.approve',
    ['--project', '--candidate'],
    ['--project', '--candidate'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'activate'],
    'compile.activate',
    'compile.activate',
    ['--project', '--input', '--confirm-approval'],
    ['--project'],
    ['--rematerialize'],
    {},
    '--project',
  ),
  command(
    ['compile', 'hierarchy', 'start'],
    'compile.hierarchy.start',
    'compile.hierarchy.start',
    ['--project', '--purpose'],
    ['--project', '--purpose'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'hierarchy', 'status'],
    'compile.hierarchy.status',
    'compile.hierarchy.status',
    ['--project', '--run'],
    ['--project', '--run'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'hierarchy', 'submit'],
    'compile.hierarchy.submit',
    'compile.hierarchy.submit',
    ['--project', '--run', '--input', '--expect-exchange'],
    ['--project', '--run', '--input', '--expect-exchange'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'hierarchy', 'resubmit'],
    'compile.hierarchy.resubmit',
    'compile.hierarchy.resubmit',
    ['--project', '--run', '--page', '--input', '--expect-exchange'],
    ['--project', '--run', '--page', '--input', '--expect-exchange'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'hierarchy', 'child-review'],
    'compile.hierarchy.child-review',
    'compile.hierarchy.child-review',
    ['--project', '--run', '--input', '--expect-review'],
    ['--project', '--run', '--input', '--expect-review'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'hierarchy', 'review'],
    'compile.hierarchy.review',
    'compile.hierarchy.review',
    ['--project', '--run'],
    ['--project', '--run'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'hierarchy', 'finalize'],
    'compile.hierarchy.finalize',
    'compile.hierarchy.finalize',
    ['--project', '--run', '--input', '--expect-review'],
    ['--project', '--run', '--input', '--expect-review'],
    [],
    {},
    '--project',
  ),
  command(
    ['compile', 'hierarchy', 'approve'],
    'compile.hierarchy.approve',
    'compile.hierarchy.approve',
    ['--project', '--run', '--expect-ledger'],
    ['--project', '--run', '--expect-ledger', '--confirm-approval'],
    ['--confirm-approval'],
    {},
    '--project',
  ),
  command(['compile'], 'compile', 'compile', ['--project'], ['--project'], ['--review'], {}, '--project'),
  command(['check'], 'check', 'check', ['--project'], ['--project'], [], {}, '--project'),
  command(
    ['index', 'status'],
    'index.status',
    'index.status',
    ['--project'],
    ['--project'],
    [],
    {},
    '--project',
  ),
  command(
    ['index', 'rebuild'],
    'index.rebuild',
    'index.rebuild',
    ['--project'],
    ['--project'],
    ['--full'],
    {},
    '--project',
  ),
  command(
    ['search'],
    'search',
    'search',
    ['--project', '--query', '--mode', '--intent'],
    ['--project', '--query'],
    [],
    {},
    '--project',
  ),
  command(
    ['query'],
    'query',
    'query',
    ['--project', '--question'],
    ['--project', '--question'],
    [],
    {},
    '--project',
  ),
  command(
    ['context'],
    'context',
    'context',
    ['--project', '--prompt'],
    ['--project', '--prompt'],
    [],
    {},
    '--project',
  ),
  command(
    ['publish', 'plan'],
    'publish.plan',
    'publish.plan',
    ['--project', '--source-revision'],
    ['--project', '--source-revision'],
    ['--include-policy-track', '--registration'],
    {},
    '--project',
  ),
  command(
    ['publish', 'commit'],
    'publish.commit',
    'publish.commit',
    ['--project', '--source-revision', '--expect-plan'],
    ['--project', '--source-revision', '--expect-plan'],
    ['--include-policy-track', '--registration'],
    {},
    '--project',
  ),
  command(
    ['publish', 'push'],
    'publish.push',
    'publish.push',
    ['--project', '--knowledge-revision'],
    ['--project', '--knowledge-revision'],
    [],
    {},
    '--project',
  ),
  command(
    ['knowledge', 'pin', 'plan'],
    'knowledge.pin.plan',
    'knowledge.pin.plan',
    ['--knowledge-revision', '--iteration', '--intent'],
    ['--knowledge-revision', '--iteration', '--intent'],
  ),
  command(
    ['knowledge', 'pin', 'commit'],
    'knowledge.pin.commit',
    'knowledge.pin.commit',
    ['--knowledge-revision', '--iteration', '--intent', '--expect-plan'],
    ['--knowledge-revision', '--iteration', '--intent', '--expect-plan'],
  ),
  command(
    ['knowledge', 'clone'],
    'init',
    'knowledge.clone',
    ['--knowledge-repo', '--branch', '--revision'],
    ['--knowledge-repo'],
    [],
    { '--repository': '--knowledge-repo' },
  ),
  command(['knowledge', 'init'], 'init', 'knowledge.init'),
  command(
    ['knowledge', 'status'],
    'check',
    'knowledge.status',
    ['--project'],
    [],
    [],
    { '--project-id': '--project' },
    '--project',
  ),
  command(
    ['project', 'validate'],
    'check',
    'project.validate',
    ['--project'],
    [],
    [],
    { '--project-id': '--project' },
    '--project',
  ),
  command(
    ['model', 'bind'],
    'model.bind',
    'model.bind',
    ['--profile', '--directory'],
    ['--profile'],
  ),
  command(
    ['model', 'inspect'],
    'model.inspect',
    'model.inspect',
    ['--profile'],
    ['--profile'],
  ),
  command(
    ['model', 'verify'],
    'model.verify',
    'model.verify',
    ['--profile'],
    ['--profile'],
  ),
];

function command(
  tokens: readonly string[],
  commandId: CliCommandId,
  operation: CliOperation,
  valueOptions: readonly string[] = [],
  requiredOptions: readonly string[] = [],
  flagOptions: readonly string[] = [],
  optionAliases: Readonly<Record<string, string>> = {},
  projectOption?: string,
  repeatableValueOptions: readonly string[] = [],
): CommandSpec {
  return {
    command: commandId,
    flagOptions: [...COMMON_FLAGS, ...flagOptions],
    operation,
    optionAliases,
    ...(projectOption === undefined ? {} : { projectOption }),
    requiredOptions,
    repeatableValueOptions,
    tokens,
    valueOptions,
  };
}

function findCommandSpec(args: readonly string[]): CommandSpec | null {
  return COMMAND_SPECS.find((spec) =>
    spec.tokens.every((token, index) => args[index] === token),
  ) ?? null;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateRetrievalTextOptions(
  commandId: CliCommandId,
  values: Readonly<Record<string, CliOptionValue>>,
): void {
  const option = commandId === 'search'
    ? '--query'
    : commandId === 'query'
      ? '--question'
      : commandId === 'context'
        ? '--prompt'
        : null;
  if (option === null) return;
  const value = values[option];
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > MAX_RETRIEVAL_TEXT_LENGTH ||
    containsControlCharacter(value) ||
    (commandId === 'search' && !/[\p{L}\p{N}]/u.test(value.normalize('NFC')))
  ) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
}

function parseOptions(
  args: readonly string[],
  spec: CommandSpec,
): Readonly<Record<string, CliOptionValue>> {
  const values: Record<string, CliOptionValue> = {};
  for (let index = spec.tokens.length; index < args.length; index += 1) {
    const rawOption = args[index];
    if (rawOption === undefined || !rawOption.startsWith('--') || rawOption === '--all') {
      throw new CliUsageError(
        rawOption === '--all' ? 'CLI_OPTION_UNSUPPORTED' : 'CLI_ARGUMENT_INVALID',
      );
    }
    const option = spec.optionAliases?.[rawOption] ?? rawOption;
    if (option in values && !spec.repeatableValueOptions.includes(option)) {
      throw new CliUsageError('CLI_OPTION_CONFLICT');
    }
    if (spec.flagOptions.includes(option)) {
      values[option] = true;
      continue;
    }
    if (!spec.valueOptions.includes(option)) {
      throw new CliUsageError('CLI_OPTION_UNSUPPORTED');
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) {
      throw new CliUsageError('CLI_OPTION_MISSING');
    }
    if (spec.repeatableValueOptions.includes(option)) {
      const existing = values[option];
      const repeated = existing === undefined
        ? [value]
        : [...(Array.isArray(existing) ? existing as readonly string[] : [String(existing)]), value];
      if (repeated.length > SESSION_COMPILE_LIMITS.maxApplyProposals) {
        throw new CliUsageError('CLI_ARGUMENT_INVALID');
      }
      values[option] = Object.freeze(repeated);
    } else {
      values[option] = value;
    }
    index += 1;
  }
  if (spec.requiredOptions.some((option) => {
    const value = values[option];
    if (spec.flagOptions.includes(option)) return value !== true;
    return typeof value !== 'string' && !(Array.isArray(value) && value.length > 0);
  })) {
    throw new CliUsageError('CLI_OPTION_MISSING');
  }
  if (
    spec.command === 'search' &&
    values['--mode'] !== undefined &&
    !['graph', 'hybrid', 'lexical', 'semantic'].includes(String(values['--mode']))
  ) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
  if (
    spec.command === 'search' &&
    values['--intent'] !== undefined &&
    !['auto', 'current', 'historical', 'neutral'].includes(String(values['--intent']))
  ) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
  validateRetrievalTextOptions(spec.command, values);
  validatePublicationOptions(spec.command, values);
  validateSessionCompileOptions(spec.command, values);
  validateSourceOptions(spec.operation, values);
  validateWikiOptions(spec.command, values);
  validateLocalModelOptions(spec.command, values);
  return Object.freeze(values);
}

function validateLocalModelOptions(
  commandId: CliCommandId,
  values: Readonly<Record<string, CliOptionValue>>,
): void {
  if (commandId !== 'model.bind' && commandId !== 'model.inspect' &&
      commandId !== 'model.verify') return;
  if (values['--profile'] !== LOCAL_MODEL_PROFILE_ID) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
  const directory = values['--directory'];
  if (directory !== undefined && (commandId !== 'model.bind' ||
      typeof directory !== 'string' || directory.length > 4096 ||
      containsControlCharacter(directory))) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
}

function validateWikiOptions(
  commandId: CliCommandId,
  values: Readonly<Record<string, CliOptionValue>>,
): void {
  if (commandId === 'wiki.read' || commandId === 'wiki.citations') {
    const page = values['--page'];
    if (typeof page !== 'string' || page.length > 320 ||
        !/^(?:(?:concepts|decisions|failures|queries|verifications)\/[a-z0-9]+(?:-[a-z0-9]+)*|page-[a-f0-9]{64})$/u
          .test(page)) {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
    return;
  }
  if (commandId === 'wiki.list') {
    const cursor = values['--cursor'];
    const limit = values['--limit'];
    if ((cursor !== undefined && (typeof cursor !== 'string' ||
        !/^[A-Za-z0-9_-]{1,1024}$/u.test(cursor))) ||
        (limit !== undefined && (typeof limit !== 'string' || !/^\d{1,3}$/u.test(limit) ||
          Number(limit) < 1 || Number(limit) > 100))) {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
    return;
  }
  if (commandId !== 'export') return;
  const output = values['--output'];
  if ((values['--format'] !== 'json' && values['--format'] !== 'okf') ||
      typeof output !== 'string' || output.length > 4_096 || containsControlCharacter(output)) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
}

function validateSourceOptions(
  operation: CliOperation,
  values: Readonly<Record<string, CliOptionValue>>,
): void {
  if (operation === 'init') {
    const project = values['--project'];
    const quickstartOptions = ['--source-repo', '--source-root', '--name'];
    if (project === undefined) {
      if (quickstartOptions.some((option) => values[option] !== undefined)) {
        throw new CliUsageError('CLI_OPTION_CONFLICT');
      }
      if (typeof values['--knowledge-repo'] !== 'string') {
        throw new CliUsageError('CLI_OPTION_MISSING');
      }
      return;
    }
    if (typeof values['--source-repo'] !== 'string' ||
        typeof values['--source-root'] !== 'string') {
      throw new CliUsageError('CLI_OPTION_MISSING');
    }
    return;
  }
  if (operation !== 'source.add') return;
  const id = values['--id'];
  const kind = values['--kind'];
  const path = values['--path'];
  if (
    typeof id !== 'string' ||
    id.length > 64 ||
    !PROJECT_ID_PATTERN.test(id) ||
    (kind !== 'code' && kind !== 'json' && kind !== 'markdown' && kind !== 'text') ||
    typeof path !== 'string'
  ) throw new CliUsageError('CLI_ARGUMENT_INVALID');
  try {
    validateSourceSelectionPath(path);
  } catch {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
}

function validatePublicationOptions(
  commandId: CliCommandId,
  values: Readonly<Record<string, CliOptionValue>>,
): void {
  if (!commandId.startsWith('publish.') && !commandId.startsWith('knowledge.pin.')) return;
  for (const option of ['--source-revision', '--knowledge-revision']) {
    const value = values[option];
    if (value !== undefined && (typeof value !== 'string' || !FULL_OID_PATTERN.test(value))) {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
  }
  const expectedPlan = values['--expect-plan'];
  if (expectedPlan !== undefined &&
      (typeof expectedPlan !== 'string' || !PLAN_DIGEST_PATTERN.test(expectedPlan))) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
  if (commandId.startsWith('knowledge.pin.')) {
    const iteration = values['--iteration'];
    if (typeof iteration !== 'string' || iteration.length > 120 ||
        !ITERATION_ID_PATTERN.test(iteration) || values['--intent'] !== 'iteration-close') {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
  }
}

function validateSessionCompileOptions(
  commandId: CliCommandId,
  values: Readonly<Record<string, CliOptionValue>>,
): void {
  if (commandId.startsWith('compile.hierarchy.')) {
    validateHierarchyCompileOptions(commandId, values);
    return;
  }
  if (commandId === 'compile.activate') {
    const rematerialize = values['--rematerialize'];
    const input = values['--input'];
    if (input !== undefined && (typeof input !== 'string' || input.length > 4_096 ||
        containsControlCharacter(input) || input.startsWith('/') || input.startsWith('~') ||
        input.includes('\\') || /^[A-Za-z]:/u.test(input) ||
        input.split('/').some((part) => part === '' || part === '.' || part === '..'))) {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
    const confirmation = values['--confirm-approval'];
    if (rematerialize === true) {
      if (input !== undefined || confirmation !== undefined) {
        throw new CliUsageError('CLI_OPTION_CONFLICT');
      }
      return;
    }
    if (confirmation === undefined) {
      throw new CliUsageError('CLI_OPTION_MISSING');
    }
    if (rematerialize !== undefined || typeof confirmation !== 'string' ||
        !PLAN_DIGEST_PATTERN.test(confirmation)) {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
    return;
  }
  if (commandId === 'compile.approve') {
    const candidateId = values['--candidate'];
    if (typeof candidateId !== 'string' || !isGeneratedIdentifier(candidateId, 'candidate')) {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
    return;
  }
  if (commandId !== 'compile.apply') return;
  const pages = values['--page'];
  if (!Array.isArray(pages) || pages.length === 0 ||
      pages.length > SESSION_COMPILE_LIMITS.maxApplyProposals ||
      pages.some((page: unknown) => typeof page !== 'string' || page.length > 4_096 ||
        page.length === 0 || containsControlCharacter(page))) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
}

function isConfinedRelativeFilePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= 4_096 &&
    !containsControlCharacter(value) && !value.startsWith('/') && !value.startsWith('~') &&
    !value.includes('\\') && !/^[A-Za-z]:/u.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validateHierarchyCompileOptions(
  commandId: CliCommandId,
  values: Readonly<Record<string, CliOptionValue>>,
): void {
  const run = values['--run'];
  if (commandId !== 'compile.hierarchy.start' &&
      (typeof run !== 'string' || !HIERARCHY_RUN_ID_PATTERN.test(run))) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
  for (const option of ['--expect-exchange', '--expect-review', '--expect-ledger']) {
    const value = values[option];
    if (value !== undefined && (typeof value !== 'string' || !PLAN_DIGEST_PATTERN.test(value))) {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
  }
  for (const option of ['--purpose', '--input']) {
    const value = values[option];
    if (value !== undefined && !isConfinedRelativeFilePath(value)) {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
  }
  if (commandId === 'compile.hierarchy.resubmit') {
    const page = values['--page'];
    if (typeof page !== 'string' || !isGeneratedIdentifier(page, 'page')) {
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
    }
  }
  if (commandId === 'compile.hierarchy.approve' && values['--confirm-approval'] !== true) {
    throw new CliUsageError('CLI_OPTION_MISSING');
  }
}

function validatedProjectId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (
    value.length > 64 ||
    !PROJECT_ID_PATTERN.test(value) ||
    RESERVED_PROJECT_IDS.has(value)
  ) {
    throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
  return value;
}

export function parseCliArguments(args: readonly string[]): ParsedCliInvocation {
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    return Object.freeze({ kind: 'help' });
  }
  const spec = findCommandSpec(args);
  if (spec === null) throw new CliUsageError('CLI_COMMAND_UNSUPPORTED');
  const options = parseOptions(args, spec);
  const outputMode: CliOutputMode = options['--json'] === true ? 'json' : 'human';
  const projectId = validatedProjectId(
    spec.projectOption === undefined || typeof options[spec.projectOption] !== 'string'
      ? undefined
      : String(options[spec.projectOption]),
  );
  const result: ParsedCliCommand = {
    command: spec.command,
    kind: 'command',
    operation: spec.operation,
    options,
    outputMode,
    projectId,
  };
  return Object.freeze(result);
}

export function inferCliCommand(args: readonly string[]): CliCommandId | 'unknown' {
  return findCommandSpec(args)?.command ?? 'unknown';
}
