import { join } from 'node:path';

import {
  createProjectCheck,
  createProjectCompiler,
  type ProjectCheckPort,
  type ProjectCompilerPort,
} from '../compiler/index.js';
import { KnowledgeError, type KnowledgeErrorCode } from '../knowledge/errors.js';
import { cloneKnowledge, initKnowledge } from '../knowledge/git.js';
import { initializeModeAWorkspace } from '../knowledge/initialization.js';
import { getKnowledgeStatus } from '../knowledge/status.js';
import type { CompilerStatusPort } from '../knowledge/types.js';
import { addProject, listProjects, showProject, validateProjectRegistry } from '../knowledge/workspace.js';
import { createProjectSyncService, type ProjectSyncPort } from '../projector/index.js';
import {
  createKnowledgePublicationService,
  createParentKnowledgePinService,
  parseKnowledgePublishPlan,
  parseKnowledgePublishResult,
  parseParentKnowledgePinPlan,
  parseParentKnowledgePinResult,
  renderKnowledgePublishPlan,
  renderKnowledgePublishResult,
  renderParentKnowledgePinPlan,
  renderParentKnowledgePinResult,
  type KnowledgePublicationPort,
  type KnowledgePublishPlanInput,
  type ParentKnowledgePinPort,
  type PublicationDigest,
} from '../knowledge/index.js';
import {
  createProjectRetrieval,
  type ProjectRetrievalPort,
  type RetrievalMode,
} from '../retrieval/index.js';
import {
  CliQualityGateError,
  mapCliError,
} from './error-map.js';
import { HELP_TEXT } from './help.js';
import { CliUsageError, inferCliCommand, parseCliArguments } from './parser.js';
import { renderCliResult, writeRenderedCliResult } from './presentation.js';
import { createCliPublicationLineageResolver } from './publication-lineage.js';
import type {
  CliOutputMode,
  CliFailureResult,
  CliPresentationContext,
  CliSuccessResult,
  ParsedCliCommand,
} from './types.js';

export type CliPublicationLineage = Readonly<Pick<
  KnowledgePublishPlanInput,
  | 'codeRevision'
  | 'embeddingCompatibilityDigest'
  | 'modelCompatibilityDigest'
  | 'profileDigest'
  | 'promptDigest'
>>;

export interface CliPublicationLineagePort {
  resolve(projectId: string): Promise<CliPublicationLineage>;
}

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliRuntime {
  readonly artifactRoot?: string;
  readonly check?: ProjectCheckPort;
  readonly cwd: string;
  readonly compiler?: CompilerStatusPort;
  readonly projectCompiler?: ProjectCompilerPort;
  readonly parentPin?: ParentKnowledgePinPort;
  readonly publication?: KnowledgePublicationPort;
  readonly publicationLineage?: CliPublicationLineagePort;
  readonly retrieval?: ProjectRetrievalPort;
  readonly sync?: ProjectSyncPort;
}

async function publicationInput(
  command: ParsedCliCommand,
  runtime: CliRuntime,
): Promise<KnowledgePublishPlanInput> {
  const projectId = requiredStringOption(command, '--project');
  await assertProjectCommandsReady(runtime, projectId);
  const lineage = await (runtime.publicationLineage ??
    createCliPublicationLineageResolver(runtime.cwd)).resolve(projectId);
  return {
    codeRevision: lineage.codeRevision,
    embeddingCompatibilityDigest: lineage.embeddingCompatibilityDigest,
    includePolicyTrack: command.options['--include-policy-track'] === true,
    modelCompatibilityDigest: lineage.modelCompatibilityDigest,
    profileDigest: lineage.profileDigest,
    projectId,
    promptDigest: lineage.promptDigest,
    registration: command.options['--registration'] === true,
    sourceRevision: requiredStringOption(command, '--source-revision'),
  };
}

function stringOption(command: ParsedCliCommand, option: string): string | undefined {
  const value = command.options[option];
  return typeof value === 'string' ? value : undefined;
}

function requiredStringOption(command: ParsedCliCommand, option: string): string {
  const value = stringOption(command, option);
  if (value === undefined) throw new CliUsageError('CLI_OPTION_MISSING');
  return value;
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

async function assertProjectCommandsReady(
  runtime: CliRuntime,
  projectId?: string,
): Promise<void> {
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
  if (projectId !== undefined) {
    await showProject(join(runtime.cwd, 'knowledge'), projectId);
  }
}

function retrievalMode(command: ParsedCliCommand): RetrievalMode {
  switch (stringOption(command, '--mode')) {
    case 'lexical':
      return 'lexical';
    case 'semantic':
      return 'semantic';
    case 'hybrid':
    case undefined:
      return 'hybrid';
    default:
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
}

async function executeCommand(
  command: ParsedCliCommand,
  runtime: CliRuntime,
): Promise<unknown> {
  switch (command.operation) {
    case 'init': {
      const branch = stringOption(command, '--branch');
      return initializeModeAWorkspace(runtime.cwd, {
        ...(branch === undefined ? {} : { branch }),
        repository: requiredStringOption(command, '--knowledge-repo'),
      });
    }
    case 'knowledge.clone': {
      const branch = stringOption(command, '--branch');
      const revision = stringOption(command, '--revision');
      return cloneKnowledge(runtime.cwd, {
        ...(branch === undefined ? {} : { branch }),
        repository: requiredStringOption(command, '--knowledge-repo'),
        ...(revision === undefined ? {} : { revision }),
      });
    }
    case 'knowledge.init':
      return initKnowledge(runtime.cwd);
    case 'knowledge.status': {
      const compiler = runtime.compiler ??
        createProjectCompiler({ knowledgeRoot: join(runtime.cwd, 'knowledge') });
      return getKnowledgeStatus(runtime.cwd, {
        compiler,
        ...(command.projectId === null ? {} : { projectId: command.projectId }),
      });
    }
    case 'project.add': {
      const projectId = requiredStringOption(command, '--id');
      await assertProjectCommandsReady(runtime);
      return addProject(join(runtime.cwd, 'knowledge'), {
        displayName: stringOption(command, '--name') ?? projectId,
        projectId,
        sourceRepository: requiredStringOption(command, '--source-repo'),
      });
    }
    case 'project.list':
      await assertProjectCommandsReady(runtime);
      return listProjects(join(runtime.cwd, 'knowledge'));
    case 'project.show':
      await assertProjectCommandsReady(runtime);
      return showProject(join(runtime.cwd, 'knowledge'), requiredStringOption(command, '--project'));
    case 'project.validate':
      await assertProjectCommandsReady(runtime);
      return validateProjectRegistry(
        join(runtime.cwd, 'knowledge'),
        command.projectId ?? undefined,
      );
    case 'sync': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const service = runtime.sync ?? createProjectSyncService();
      return service.sync({
        artifactRoot: runtime.artifactRoot ??
          join(runtime.cwd, '.plan2agent', 'artifacts', projectId),
        dryRun: command.options['--dry-run'] === true,
        knowledgeRoot: join(runtime.cwd, 'knowledge'),
        projectId,
      });
    }
    case 'compile': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.projectCompiler ?? createProjectCompiler({
        knowledgeRoot: join(runtime.cwd, 'knowledge'),
      });
      return compiler.execute({
        capability: 'compile',
        projectId,
        ...(command.options['--review'] === true ? { review: true } : {}),
      });
    }
    case 'check': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.projectCompiler ?? createProjectCompiler({
        knowledgeRoot: join(runtime.cwd, 'knowledge'),
      });
      const check = runtime.check ?? createProjectCheck(compiler);
      return check.check(projectId);
    }
    case 'search': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const retrieval = runtime.retrieval ?? createProjectRetrieval({
        knowledgeRoot: join(runtime.cwd, 'knowledge'),
      });
      return retrieval.search({
        mode: retrievalMode(command),
        projectId,
        query: requiredStringOption(command, '--query'),
      });
    }
    case 'query': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.projectCompiler ?? createProjectCompiler({
        knowledgeRoot: join(runtime.cwd, 'knowledge'),
      });
      return compiler.execute({
        capability: 'query',
        projectId,
        question: requiredStringOption(command, '--question'),
      });
    }
    case 'context': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const retrieval = runtime.retrieval ?? createProjectRetrieval({
        knowledgeRoot: join(runtime.cwd, 'knowledge'),
      });
      return retrieval.context({
        projectId,
        prompt: requiredStringOption(command, '--prompt'),
      });
    }
    case 'publish.plan': {
      const service = runtime.publication ?? createKnowledgePublicationService(
        join(runtime.cwd, 'knowledge'),
      );
      return service.plan(await publicationInput(command, runtime));
    }
    case 'publish.commit': {
      const service = runtime.publication ?? createKnowledgePublicationService(
        join(runtime.cwd, 'knowledge'),
      );
      return service.commit({
        ...await publicationInput(command, runtime),
        expectedPlanDigest: requiredStringOption(command, '--expect-plan') as PublicationDigest,
      });
    }
    case 'publish.push': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const service = runtime.publication ?? createKnowledgePublicationService(
        join(runtime.cwd, 'knowledge'),
      );
      return service.push({
        knowledgeRevision: requiredStringOption(command, '--knowledge-revision'),
        projectId,
      });
    }
    case 'knowledge.pin.plan': {
      const service = runtime.parentPin ?? createParentKnowledgePinService(runtime.cwd);
      return service.plan({
        intent: 'iteration-close',
        iterationId: requiredStringOption(command, '--iteration'),
        knowledgeRevision: requiredStringOption(command, '--knowledge-revision'),
      });
    }
    case 'knowledge.pin.commit': {
      const service = runtime.parentPin ?? createParentKnowledgePinService(runtime.cwd);
      return service.commit({
        intent: 'iteration-close',
        iterationId: requiredStringOption(command, '--iteration'),
        knowledgeRevision: requiredStringOption(command, '--knowledge-revision'),
      }, requiredStringOption(command, '--expect-plan') as PublicationDigest);
    }
  }
}

function safeStringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) return null;
  const field = value[key as keyof typeof value];
  return typeof field === 'string' ? field : null;
}

function safeKnowledgeRevision(value: unknown): string | null {
  const direct = safeStringField(value, 'currentCommit');
  if (direct !== null) return direct;
  const publication = safeStringField(value, 'knowledgeRevision');
  if (publication !== null) return publication;
  const pin = safeStringField(value, 'newKnowledgeGitlink');
  if (pin !== null) return pin;
  if (typeof value !== 'object' || value === null || !('knowledge' in value)) return null;
  return safeStringField(value.knowledge, 'checkedOutCommit');
}

function safeWarnings(data: unknown): readonly { readonly code: string; readonly message: string }[] {
  if (typeof data !== 'object' || data === null || !('warnings' in data) ||
      !Array.isArray(data.warnings)) return [];
  const codes = data.warnings.map((warning: unknown) => {
    if (typeof warning === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(warning)) {
      return warning;
    }
    if (typeof warning !== 'object' || warning === null || !('code' in warning) ||
        typeof warning.code !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(warning.code)) {
      return null;
    }
    return warning.code;
  });
  if (codes.some((code) => code === null)) return [];
  return [...new Set(codes as string[])].sort().map((code) => Object.freeze({
    code,
    message: 'The command completed with a structured warning.',
  }));
}

function normalizeDomainData(command: ParsedCliCommand, data: unknown): unknown {
  switch (command.operation) {
    case 'publish.plan':
      return parseKnowledgePublishPlan(renderKnowledgePublishPlan(
        data as Parameters<typeof renderKnowledgePublishPlan>[0],
      ));
    case 'publish.commit':
    case 'publish.push':
      return parseKnowledgePublishResult(renderKnowledgePublishResult(
        data as Parameters<typeof renderKnowledgePublishResult>[0],
      ));
    case 'knowledge.pin.plan':
      return parseParentKnowledgePinPlan(renderParentKnowledgePinPlan(
        data as Parameters<typeof renderParentKnowledgePinPlan>[0],
      ));
    case 'knowledge.pin.commit':
      return parseParentKnowledgePinResult(renderParentKnowledgePinResult(
        data as Parameters<typeof renderParentKnowledgePinResult>[0],
      ));
    default:
      return data;
  }
}

function safeRecovery(data: unknown): readonly string[] | undefined {
  if (typeof data !== 'object' || data === null || !('recoveryCommand' in data) ||
      !Array.isArray(data.recoveryCommand) || data.recoveryCommand.length === 0 ||
      data.recoveryCommand.some((part: unknown) =>
        typeof part !== 'string' || !/^(?:--)?[A-Za-z0-9._:-]+$/u.test(part))) return undefined;
  return Object.freeze(data.recoveryCommand.map((part: unknown) => String(part)));
}

function publicationExitCode(code: string): 3 | 6 {
  return code === 'PUBLISH_INELIGIBLE' || code === 'PUBLISH_PATH_DRIFT' ||
    code === 'PUBLISH_POLICY_BLOCKED'
    ? 3
    : 6;
}

function domainFailureResult(
  command: ParsedCliCommand,
  data: unknown,
): CliFailureResult | null {
  if (typeof data !== 'object' || data === null || !('state' in data) ||
      (data.state !== 'blocked' && data.state !== 'push-failed')) return null;
  const code = 'errorCode' in data && typeof data.errorCode === 'string'
    ? data.errorCode
    : 'INTERNAL_ERROR';
  const isPin = command.operation === 'knowledge.pin.commit';
  const exitCode = isPin ? 6 : publicationExitCode(code);
  const recoveryCommand = safeRecovery(data);
  return Object.freeze({
    command: command.command,
    data,
    errors: Object.freeze([Object.freeze({
      code,
      message: exitCode === 3
        ? 'Publication input or policy was rejected safely.'
        : isPin
          ? 'Parent knowledge pin state requires recovery.'
          : 'Git publication state requires recovery.',
      ...(recoveryCommand === undefined ? {} : { recoveryCommand }),
    })]),
    exitCode,
    knowledgeRevision: safeKnowledgeRevision(data),
    ok: false,
    partial: dataIsPartial(data),
    projectId: command.projectId,
    warnings: Object.freeze(safeWarnings(data)),
    workspacePath: null,
  });
}

function ineligiblePlanFailureResult(
  command: ParsedCliCommand,
  data: unknown,
): CliFailureResult | null {
  if ((command.operation !== 'publish.plan' && command.operation !== 'knowledge.pin.plan') ||
      typeof data !== 'object' || data === null || !('eligible' in data) ||
      data.eligible !== false || !('blockReasons' in data) || !Array.isArray(data.blockReasons)) {
    return null;
  }
  const pin = command.operation === 'knowledge.pin.plan';
  const repositoryConflict = data.blockReasons.some((reason: unknown) =>
    reason === 'DIRTY_INDEX' || reason === 'FOREIGN_STAGED_CHANGE' ||
    reason === 'UNMERGED_CHANGE');
  const exitCode = pin || repositoryConflict ? 6 : 3;
  const code = pin ? 'PARENT_PIN_INELIGIBLE' : 'PUBLISH_INELIGIBLE';
  return Object.freeze({
    command: command.command,
    data,
    errors: Object.freeze([Object.freeze({
      code,
      message: exitCode === 3
        ? 'Publication input or policy was rejected safely.'
        : pin
          ? 'Parent knowledge pin state requires recovery.'
          : 'Git publication state requires recovery.',
    })]),
    exitCode,
    knowledgeRevision: safeKnowledgeRevision(data),
    ok: false,
    partial: false,
    projectId: command.projectId,
    warnings: Object.freeze([]),
    workspacePath: null,
  });
}

function dataIsPartial(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'partial' in data && data.partial === true;
}

function qualityFailed(command: ParsedCliCommand, data: unknown): boolean {
  return command.command === 'check' && typeof data === 'object' && data !== null &&
    'passed' in data && data.passed === false;
}

function successResult(command: ParsedCliCommand, data: unknown): CliSuccessResult {
  return Object.freeze({
    command: command.command,
    data,
    errors: Object.freeze([]),
    exitCode: 0,
    knowledgeRevision: safeKnowledgeRevision(data),
    ok: true,
    partial: dataIsPartial(data),
    projectId: command.projectId,
    warnings: Object.freeze(safeWarnings(data)),
    workspacePath: safeStringField(data, 'workspacePath'),
  });
}

function requestedOutputMode(args: readonly string[]): CliOutputMode {
  return args.includes('--json') ? 'json' : 'human';
}

export async function runCli(
  args: readonly string[],
  io: CliIo,
  runtime: CliRuntime = { cwd: process.cwd() },
): Promise<number> {
  let outputMode = requestedOutputMode(args);
  let context: CliPresentationContext = { command: inferCliCommand(args) };
  try {
    const invocation = parseCliArguments(args);
    if (invocation.kind === 'help') {
      io.stdout(HELP_TEXT);
      return 0;
    }
    outputMode = invocation.outputMode;
    context = { command: invocation.command, projectId: invocation.projectId };
    const data = normalizeDomainData(invocation, await executeCommand(invocation, runtime));
    const domainFailure = domainFailureResult(invocation, data) ??
      ineligiblePlanFailureResult(invocation, data);
    if (domainFailure !== null) {
      const rendered = renderCliResult(domainFailure, outputMode);
      writeRenderedCliResult(io, rendered);
      return rendered.exitCode;
    }
    const unhealthyStatus = unhealthyKnowledgeStatus(data);
    if (unhealthyStatus !== null) {
      const error = new KnowledgeError(
        statusErrorCode(unhealthyStatus.knowledge.state),
        'Knowledge repository requires recovery before project access.',
        unhealthyStatus.recoveryCommand === undefined
          ? {}
          : { recoveryCommand: unhealthyStatus.recoveryCommand },
      );
      const failure = mapCliError(error, {
        ...context,
        knowledgeRevision: safeStringField(data, 'currentCommit'),
        workspacePath: safeStringField(data, 'workspacePath'),
      });
      const rendered = renderCliResult(
        Object.freeze({ ...failure, data, partial: true }),
        outputMode,
      );
      writeRenderedCliResult(io, rendered);
      return rendered.exitCode;
    }
    if (qualityFailed(invocation, data)) {
      const failure = mapCliError(new CliQualityGateError(), context);
      const rendered = renderCliResult(Object.freeze({
        ...failure,
        data,
        partial: dataIsPartial(data),
        warnings: Object.freeze(safeWarnings(data)),
      }), outputMode);
      writeRenderedCliResult(io, rendered);
      return rendered.exitCode;
    }
    const rendered = renderCliResult(successResult(invocation, data), outputMode);
    writeRenderedCliResult(io, rendered);
    return rendered.exitCode;
  } catch (error) {
    const rendered = renderCliResult(mapCliError(error, context), outputMode);
    writeRenderedCliResult(io, rendered);
    return rendered.exitCode;
  }
}
