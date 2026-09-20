import { createProjectWikiWorkflow } from './project-wiki-workflow.js';
import { safeSyncSourceRef } from '../projector/sync-sanitization-diagnostics.js';
import { workspaceGuide } from '../application/workspace-guide.js';
import { workspaceConnect, workspaceClientGuide } from '../application/workspace-setup.js';
import { workspaceCheck } from '../application/workspace-check.js';
import { createWorkspacePublicationService, normalizeWorkspacePublication } from '../knowledge/workspace-publication.js';
import { initializeKnowledgeWorkspace, resolveWorkspaceLayout, inspectKnowledgeWorkspace, type WorkspaceLayout } from '../knowledge/knowledge-workspace.js';
import type { ReadObserver } from '../retrieval/read-observer.js';
import { setupHub, connectProject, disconnectProject, resolveConnection, connectionOutcome, relocateHub } from '../connection/service.js';
import { fail as connectionFail, ConnectionError, digest as connectionPlanDigest } from '../connection/contracts.js';
import { connectionStatus, unavailableConnectionStatus, readConnectedWiki, readApprovedWiki, type WikiReadRequest } from '../application/wiki-read-service.js';
import { join } from 'node:path';
import { createProjectKnowledgeCompletenessWorkflow } from './project-knowledge-workflow.js';
import type { CompletenessRole } from '../compiler/project-knowledge/completeness.js';

import {
  createProjectCheck,
  createProjectCompiler,
  createProjectSessionCompiler,
  type ProjectCheckPort,
  type ProjectCompilerPort,
  type ProjectSessionCompilerPort,
  type HierarchySha256Digest,
} from '../compiler/index.js';
import { KnowledgeError, type KnowledgeErrorCode } from '../knowledge/errors.js';
import { cloneKnowledge, initKnowledge } from '../knowledge/git.js';
import { initializeModeAWorkspace } from '../knowledge/initialization.js';
import {
  bindLocalProject,
  ensureLocalProjectRegistryIgnored,
  initializeLocalProjectRegistry,
  inspectLocalProjectBindingCandidate,
  type LocalProjectRegistryHooks,
} from '../knowledge/local-project-registry.js';
import { createRepositoryWriterLease } from '../knowledge/repository-writer-lease.js';
import { getKnowledgeStatus } from '../knowledge/status.js';
import type {
  CompilerStatusPort,
  ProjectRecord,
  ProjectRegistryEntry,
} from '../knowledge/types.js';
import { addProject, listProjects, showProject, validateProjectRegistry } from '../knowledge/workspace.js';
import {
  createBuiltInSourceAdapterRegistry,
  createProjectSyncService,
  createSourceManagement,
  initializeSingleProjectQuickstart,
  inspectLocalSourceStatus,
  p2aRunJsonKnowledgeAdapter,
  type GenericSourceKind,
  type LocalSourceStatus,
  type ProjectSyncPort,
  type QuickstartInput,
  type SourceManagementPort,
} from '../projector/index.js';
import { SECURITY_RULES } from '../sanitizer/index.js';
import { readSourceCollectionManifest } from '../projector/source-manifest.js';
import { createProfileBindingV2, resolveRegisteredProfileBinding } from '../profile/index.js';
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
  createLocalWikiOperator,
  createProjectRetrieval,
  LocalWikiRetrievalError,
  type LocalWikiOperatorPort,
  type LocalWikiRetrievalIntent,
  type LocalWikiRetrievalMode,
  type ProjectRetrievalPort,
} from '../retrieval/index.js';
import {
  createLocalModelBindingService,
  type LocalModelBindingPort,
} from '../retrieval/embedding/index.js';
import {
  createWikiExportService,
  createWikiReadService,
  type WikiExportFormat,
  type WikiExportPort,
  type WikiReadPort,
} from '../wiki/index.js';
import {
  CliQualityGateError,
  mapCliError,
} from './error-map.js';
import {
  createHierarchicalWikiActivationService,
  type HierarchicalWikiActivationPort,
} from './hierarchical-activation.js';
import {
  createHierarchicalWorkflowService,
  type HierarchicalWorkflowServicePort,
} from './hierarchical-workflow.js';
import { createProjectKnowledgeWorkflow, type ProjectKnowledgeWorkflowService } from './project-knowledge-workflow.js';
import { createKnowledgeWikiReader } from '../retrieval/project-knowledge-reader.js';
import { hash, choice, invalid, ProjectKnowledgeError } from '../knowledge/project-knowledge/guards.js';
import { HELP_TEXT } from './help.js';
import { CliUsageError, CONNECTED_READ_COMMANDS, inferCliCommand, parseCliArguments } from './parser.js';
import { renderCliResult, writeRenderedCliResult } from './presentation.js';
import { createCliPublicationLineageResolver } from './publication-lineage.js';
import type {
  CliOutputMode,
  CliResult,
  CliFailureResult,
  CliPresentationContext,
  CliSuccessResult,
  ParsedCliCommand,
} from './types.js';

const CLI_JSON_KNOWLEDGE_ADAPTERS = Object.freeze([
  p2aRunJsonKnowledgeAdapter(),
]);
const CLI_SOURCE_ADAPTER_REGISTRY = createBuiltInSourceAdapterRegistry({
  registrations: CLI_JSON_KNOWLEDGE_ADAPTERS,
});

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

export interface CliQuickstartPort {
  initialize(input: QuickstartInput): Promise<unknown>;
}

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliRuntime {
  /** @internal Installed CLI override for isolated package verification. */
  readonly workspaceBinPath?: string;
  /** @internal Resolved per invocation; callers cannot select a mode through this field. */
  readonly workspaceLayout?: WorkspaceLayout;
  readonly readObserver?: ReadObserver;
  readonly configDir?: string;
  readonly artifactRoot?: string;
  readonly check?: ProjectCheckPort;
  readonly cwd: string;
  readonly compiler?: CompilerStatusPort;
  readonly hierarchyActivation?: HierarchicalWikiActivationPort;
  readonly hierarchyWorkflow?: HierarchicalWorkflowServicePort;
  readonly knowledgeInspection?: Pick<ProjectKnowledgeWorkflowService, 'inspect'>;
  /** @internal Fault seam for local registry integration tests. */
  readonly localProjectRegistryHooks?: LocalProjectRegistryHooks;
  readonly localModels?: LocalModelBindingPort;
  readonly localWiki?: LocalWikiOperatorPort;
  readonly projectCompiler?: ProjectCompilerPort;
  readonly parentPin?: ParentKnowledgePinPort;
  readonly publication?: KnowledgePublicationPort;
  readonly publicationLineage?: CliPublicationLineagePort;
  readonly quickstart?: CliQuickstartPort;
  readonly retrieval?: ProjectRetrievalPort;
  readonly sessionCompiler?: ProjectSessionCompilerPort;
  readonly sourceManagement?: SourceManagementPort;
  readonly sync?: ProjectSyncPort;
  readonly wikiExport?: WikiExportPort;
  readonly wikiRead?: WikiReadPort;
}

function runtimeKnowledgeRoot(runtime: CliRuntime): string {
  return runtime.workspaceLayout?.knowledgeRoot ?? join(runtime.cwd, 'knowledge');
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

function requiredStringArrayOption(
  command: ParsedCliCommand,
  option: string,
): readonly string[] {
  const value = command.options[option];
  if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== 'string')) {
    throw new CliUsageError('CLI_OPTION_MISSING');
  }
  return Object.freeze([...(value as readonly string[])]);
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
  if (runtime.workspaceLayout?.mode === 'knowledge') {
    await inspectKnowledgeWorkspace(runtime.cwd);
    if (projectId !== undefined) await showProject(runtime.cwd, projectId);
    return;
  }
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
    await showProject(runtimeKnowledgeRoot(runtime), projectId);
  }
}

async function assertPublicationPushReady(
  runtime: CliRuntime,
  projectId: string,
  knowledgeRevision: string,
): Promise<void> {
  if (runtime.workspaceLayout?.mode === 'knowledge') {
    await inspectKnowledgeWorkspace(runtime.cwd);
    if (projectId !== undefined) await showProject(runtime.cwd, projectId);
    return;
  }
  const status = await getKnowledgeStatus(runtime.cwd);
  const expectedPinMismatch =
    status.knowledge.state === 'commit-mismatch' &&
    status.knowledge.checkedOutCommit === knowledgeRevision;
  if (!status.ok && !expectedPinMismatch) {
    throw new KnowledgeError(
      statusErrorCode(status.knowledge.state),
      'Knowledge repository requires recovery before publication push.',
      status.recoveryCommand === undefined
        ? {}
        : { recoveryCommand: status.recoveryCommand },
    );
  }
  await showProject(runtimeKnowledgeRoot(runtime), projectId);
}

function retrievalMode(command: ParsedCliCommand): LocalWikiRetrievalMode {
  switch (stringOption(command, '--mode')) {
    case 'graph':
      return 'graph';
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

function retrievalIntent(command: ParsedCliCommand): LocalWikiRetrievalIntent {
  switch (stringOption(command, '--intent')) {
    case 'current':
      return 'current';
    case 'historical':
      return 'historical';
    case 'neutral':
      return 'neutral';
    case 'auto':
    case undefined:
      return 'auto';
    default:
      throw new CliUsageError('CLI_ARGUMENT_INVALID');
  }
}

function createDefaultLocalWiki(runtime: CliRuntime): LocalWikiOperatorPort {
  return createLocalWikiOperator({
    hubRoot: runtime.cwd,
    knowledgeRoot: runtimeKnowledgeRoot(runtime),
    repositoryLease: createRepositoryWriterLease(),
  });
}

type RoutedHierarchyWorkflow = {
  [K in keyof HierarchicalWorkflowServicePort]: (...args: Parameters<HierarchicalWorkflowServicePort[K]>) => Promise<unknown>;
};

function createDefaultHierarchyWorkflow(runtime: CliRuntime, role?: CompletenessRole,
  stageBound = false, allowLegacyAuthoring = false): RoutedHierarchyWorkflow {
  const legacy = createHierarchicalWorkflowService({
    compiler: createProjectSessionCompiler({
      hubRoot: runtime.cwd,
      jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
      knowledgeRoot: runtimeKnowledgeRoot(runtime),
    }),
    hubRoot: runtime.cwd,
    knowledgeRoot: runtimeKnowledgeRoot(runtime),
  });
  const knowledge = createProjectKnowledgeWorkflow({ hubRoot: runtime.cwd,
    knowledgeRoot: runtimeKnowledgeRoot(runtime), jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS });
  const completeness = createProjectKnowledgeCompletenessWorkflow({ hubRoot: runtime.cwd,
    knowledgeRoot: runtimeKnowledgeRoot(runtime), jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS });
  return {
    async start(projectId, purposeFile) {
      if (await completeness.handlesPurpose(projectId, purposeFile)) return completeness.start(projectId, purposeFile);
      if (!allowLegacyAuthoring) throw new ProjectKnowledgeError('KNOWLEDGE_COMPLETENESS_REQUIRED');
      return (await knowledge.handlesPurpose(projectId, purposeFile) ? knowledge : legacy).start(projectId, purposeFile);
    },
    async status(projectId, runId) {
      if (await completeness.handlesRun(projectId, runId)) return completeness.status(projectId, runId, role);
      if (role !== undefined) throw new CliUsageError('CLI_OPTION_UNSUPPORTED');
      return (await knowledge.handlesRun(projectId, runId) ? knowledge : legacy).status(projectId, runId);
    },
    async submit(projectId, runId, inputFile, expected) {
      return (await knowledge.handlesRun(projectId, runId) ? knowledge : legacy).submit(projectId, runId, inputFile, expected);
    },
    async review(projectId, runId) {
      if (await completeness.handlesRun(projectId, runId)) return completeness.status(projectId, runId, role);
      if (role !== undefined) throw new CliUsageError('CLI_OPTION_UNSUPPORTED');
      return (await knowledge.handlesRun(projectId, runId) ? knowledge : legacy).review(projectId, runId);
    },
    async finalize(projectId, runId, inputFile, expected) {
      if (await completeness.handlesRun(projectId, runId)) {
        if (!stageBound) throw new CliUsageError('CLI_OPTION_MISSING');
        return completeness.finalize(projectId, runId, inputFile, expected);
      }
      if (stageBound) throw new CliUsageError('CLI_OPTION_UNSUPPORTED');
      return (await knowledge.handlesRun(projectId, runId) ? knowledge : legacy).finalize(projectId, runId, inputFile, expected);
    },
    async approve(projectId, runId, expected, confirmed) {
      if (await completeness.handlesRun(projectId, runId)) return completeness.approve(projectId, runId, expected, confirmed);
      return (await knowledge.handlesRun(projectId, runId) ? knowledge : legacy).approve(projectId, runId, expected, confirmed);
    },
    resubmit: (...args) => legacy.resubmit(...args),
    childReview: (...args) => legacy.childReview(...args),
  };
}

function isRawHierarchyPageId(value: string): boolean {
  return /^page-[0-9a-f]{64}$/u.test(value);
}

function isApprovedWikiUnavailable(error: unknown): boolean {
  return error instanceof LocalWikiRetrievalError &&
    error.code === 'LOCAL_WIKI_PROJECTION_UNAVAILABLE';
}

async function listWikiPages(
  command: ParsedCliCommand,
  runtime: CliRuntime,
  projectId: string,
): Promise<unknown> {
  const cursor = stringOption(command, '--cursor');
  const limit = stringOption(command, '--limit');
  const input = {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    projectId,
  };
  if (runtime.localWiki !== undefined) return runtime.localWiki.listPages(input);
  if (runtime.wikiRead !== undefined) return runtime.wikiRead.list(input);
  const knowledge = await createKnowledgeWikiReader(runtimeKnowledgeRoot(runtime)).list(projectId, input);
  if (knowledge !== null) return knowledge;
  try {
    return await createDefaultLocalWiki(runtime).listPages(input);
  } catch (error) {
    if (!isApprovedWikiUnavailable(error)) throw error;
    return createWikiReadService({
      knowledgeRoot: runtimeKnowledgeRoot(runtime),
      sourceAdapterRegistrations: CLI_JSON_KNOWLEDGE_ADAPTERS,
    }).list(input);
  }
}

async function readWikiPage(
  command: ParsedCliCommand,
  runtime: CliRuntime,
  projectId: string,
): Promise<unknown> {
  const pageRef = requiredStringOption(command, '--page');
  if (command.options['--view'] === 'reader') {
    if (runtime.localWiki !== undefined || runtime.wikiRead !== undefined) throw new CliUsageError('CLI_ARGUMENT_INVALID');
    return await createKnowledgeWikiReader(runtimeKnowledgeRoot(runtime)).readContext(projectId, pageRef) ?? invalid();
  }
  if (runtime.localWiki === undefined && runtime.wikiRead === undefined) {
    const knowledge = await createKnowledgeWikiReader(runtimeKnowledgeRoot(runtime)).read(projectId, pageRef);
    if (knowledge !== null) return knowledge;
  }
  if (isRawHierarchyPageId(pageRef)) {
    return (runtime.localWiki ?? createDefaultLocalWiki(runtime)).readPage({
      pageId: pageRef,
      projectId,
    });
  }
  return (runtime.wikiRead ?? createWikiReadService({
    knowledgeRoot: runtimeKnowledgeRoot(runtime),
    sourceAdapterRegistrations: CLI_JSON_KNOWLEDGE_ADAPTERS,
  })).read({ pageRef, projectId });
}

async function readWikiCitations(
  command: ParsedCliCommand,
  runtime: CliRuntime,
  projectId: string,
): Promise<unknown> {
  const pageRef = requiredStringOption(command, '--page');
  if (runtime.localWiki === undefined && runtime.wikiRead === undefined) {
    const knowledge = await createKnowledgeWikiReader(runtimeKnowledgeRoot(runtime)).citations(projectId, pageRef);
    if (knowledge !== null) return knowledge;
  }
  if (isRawHierarchyPageId(pageRef)) {
    return (runtime.localWiki ?? createDefaultLocalWiki(runtime)).pageCitations({
      pageId: pageRef,
      projectId,
    });
  }
  return (runtime.wikiRead ?? createWikiReadService({
    knowledgeRoot: runtimeKnowledgeRoot(runtime),
    sourceAdapterRegistrations: CLI_JSON_KNOWLEDGE_ADAPTERS,
  })).citations({ pageRef, projectId });
}

async function searchWithApprovedWiki(
  command: ParsedCliCommand,
  runtime: CliRuntime,
  projectId: string,
): Promise<unknown> {
  const mode = retrievalMode(command);
  const intent = retrievalIntent(command);
  const query = requiredStringOption(command, '--query');
  if (runtime.retrieval !== undefined && mode !== 'graph' && intent === 'auto') {
    return runtime.retrieval.search({ mode, projectId, query });
  }
  if (runtime.retrieval === undefined && runtime.localWiki === undefined) {
    const knowledge = await createKnowledgeWikiReader(runtimeKnowledgeRoot(runtime), { hubRoot: runtime.cwd })
      .search(projectId, query, mode, intent);
    if (knowledge !== null) return knowledge;
  }
  try {
    return await (runtime.localWiki ?? createDefaultLocalWiki(runtime)).search({
      ...(intent === 'auto' ? {} : { intent }),
      mode,
      projectId,
      query,
    });
  } catch (error) {
    if (!(error instanceof LocalWikiRetrievalError) ||
        error.code !== 'LOCAL_WIKI_PROJECTION_UNAVAILABLE' ||
        (mode !== 'lexical' && mode !== 'hybrid')) throw error;
    const legacy = await createProjectRetrieval({
      jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
      knowledgeRoot: runtimeKnowledgeRoot(runtime),
    }).search({ mode: 'lexical', projectId, query });
    return Object.freeze({
      ...legacy,
      effectiveMode: 'lexical',
      fallback: mode === 'hybrid'
        ? Object.freeze({
            fromMode: 'hybrid',
            reasonCode: 'approved-wiki-projection-unavailable',
            toMode: 'lexical',
          })
        : null,
      partial: true,
      recoveryAction: Object.freeze({
        command: Object.freeze(['compile', 'activate', '--project', projectId] as const),
        rebuildRequired: true,
      }),
      requestedMode: mode,
      warnings: Object.freeze([
        ...legacy.warnings,
        Object.freeze({ code: 'approved-wiki-projection-unavailable' }),
      ]),
    });
  }
}

async function executeCommand(
  command: ParsedCliCommand,
  runtime: CliRuntime,
): Promise<unknown> {
  if (CONNECTED_READ_COMMANDS.includes(command.command) && stringOption(command, '--expect-generation') !== undefined) {
    const projectId = requiredStringOption(command, '--project');
    await assertProjectCommandsReady(runtime, projectId);
    return (await readApprovedWiki(runtime.cwd, projectId, connectedRequest(command), 'hub-compatible')).data;
  }
  if (runtime.workspaceLayout?.mode === 'knowledge' && ['init', 'knowledge.clone', 'knowledge.init', 'knowledge.pin.plan', 'knowledge.pin.commit'].includes(command.operation)) {
    throw new CliUsageError('CLI_COMMAND_UNSUPPORTED');
  }
  switch (command.operation) {
    case 'workspace.guide': case 'workspace.connect': case 'workspace.check': throw new CliUsageError('CLI_ARGUMENT_INVALID');
    case 'workspace.init': return initializeKnowledgeWorkspace(runtime.cwd, stringOption(command, '--knowledge-repo'));
    case 'setup': return setupHub(requiredStringOption(command, '--hub'), requiredStringOption(command, '--knowledge-repo'), runtime);
    case 'connect': {
      const sourceRepository = stringOption(command, '--source-repo');
      const hub = stringOption(command, '--hub'), workspace = stringOption(command, '--workspace');
      if ((hub === undefined) === (workspace === undefined)) throw new CliUsageError('CLI_OPTION_CONFLICT');
      const context = await connectProject(runtime.cwd, { ...(hub === undefined ? {} : { hub }), ...(workspace === undefined ? {} : { workspace }), projectId: requiredStringOption(command, '--project'),
        ...(sourceRepository === undefined ? {} : { sourceRepository }) }, runtime);
      const status = await connectionStatus(context);
      return { outcome: connectionOutcome(context), projectId: context.projectId, connectionDigest: context.connectionDigest, readable: status.readable };
    }
    case 'disconnect': return disconnectProject(runtime.cwd, command.options['--remove-shared'] === true, runtime);
    case 'connection.relocate-hub': {
      const expected = stringOption(command, '--expect-plan');
      const apply = command.options['--apply'] === true;
      if (apply !== (expected !== undefined)) throw new CliUsageError('CLI_OPTION_CONFLICT');
      return relocateHub({ from: requiredStringOption(command, '--from'), to: requiredStringOption(command, '--to'),
        knowledgeRepository: requiredStringOption(command, '--knowledge-repo'), apply,
        ...(expected === undefined ? {} : { expectedPlan: connectionPlanDigest(expected) }) }, runtime);
    }
    case 'connection.status': case 'doctor': throw new CliUsageError('CLI_ARGUMENT_INVALID');
    case 'model.bind': {
      const localModels = runtime.localModels ?? createLocalModelBindingService(runtime.cwd);
      const directory = stringOption(command, '--directory');
      return localModels.bind({
        ...(directory === undefined ? {} : { directory }),
        profileId: requiredStringOption(command, '--profile'),
      });
    }
    case 'model.inspect': {
      const localModels = runtime.localModels ?? createLocalModelBindingService(runtime.cwd);
      return localModels.inspect(requiredStringOption(command, '--profile'));
    }
    case 'model.verify': {
      const localModels = runtime.localModels ?? createLocalModelBindingService(runtime.cwd);
      return localModels.verify(requiredStringOption(command, '--profile'));
    }
    case 'init': {
      const branch = stringOption(command, '--branch');
      const projectId = stringOption(command, '--project');
      if (projectId !== undefined) {
        const knowledgeRepository = stringOption(command, '--knowledge-repo');
        const input: QuickstartInput = {
          ...(branch === undefined ? {} : { branch }),
          ...(stringOption(command, '--name') === undefined
            ? {}
            : { displayName: stringOption(command, '--name') as string }),
          ...(knowledgeRepository === undefined ? {} : { knowledgeRepository }),
          projectId,
          sourceRepository: requiredStringOption(command, '--source-repo'),
          sourceRoot: requiredStringOption(command, '--source-root'),
        };
        if (runtime.quickstart !== undefined) return runtime.quickstart.initialize(input);
        return initializeSingleProjectQuickstart(runtime.cwd, input, {
          ...(runtime.localProjectRegistryHooks === undefined
            ? {}
            : { localProjectRegistryHooks: runtime.localProjectRegistryHooks }),
        });
      }
      const workspace = await initializeModeAWorkspace(runtime.cwd, {
        ...(branch === undefined ? {} : { branch }),
        repository: requiredStringOption(command, '--knowledge-repo'),
      });
      await ensureLocalProjectRegistryIgnored(runtime.cwd);
      const localProjects = await initializeLocalProjectRegistry(runtime.cwd);
      return Object.freeze({ ...workspace, localProjects });
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
      if (runtime.workspaceLayout?.mode === 'knowledge') {
        await inspectKnowledgeWorkspace(runtime.cwd);
        return { schemaVersion: 'buildlore.workspace-status.v1', mode: 'knowledge', ok: true, parentPin: 'not_applicable',
          registry: await validateProjectRegistry(runtime.cwd, command.projectId ?? undefined) };
      }
      const compiler = runtime.compiler ??
        createProjectCompiler({
          jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
          knowledgeRoot: runtimeKnowledgeRoot(runtime),
        });
      return getKnowledgeStatus(runtime.cwd, {
        compiler,
        ...(command.projectId === null ? {} : { projectId: command.projectId }),
      });
    }
    case 'project.add': {
      const projectId = requiredStringOption(command, '--id');
      const sourceRepository = requiredStringOption(command, '--source-repo');
      const sourceRoot = requiredStringOption(command, '--source-root');
      await assertProjectCommandsReady(runtime);
      await ensureLocalProjectRegistryIgnored(runtime.cwd);
      const candidate = await inspectLocalProjectBindingCandidate(runtime.cwd, {
        allowReplacement: false,
        projectId,
        sourceRepository,
        sourceRoot,
      });
      const sources = await readSourceCollectionManifest(candidate.checkout, projectId, {
        sourceAdapterRegistry: CLI_SOURCE_ADAPTER_REGISTRY,
      });
      const declaredAdapters = new Set(sources.manifest.sources.map(source =>
        'adapterId' in source ? source.adapterId :
          source.documentKind === 'p2a-planning' ? 'buildlore.p2a' : 'buildlore.generic'));
      const registrations = CLI_JSON_KNOWLEDGE_ADAPTERS
        .filter(adapter => declaredAdapters.has(adapter.registration.adapterId));
      let binding: Awaited<ReturnType<typeof bindLocalProject>> | undefined;
      const project = await addProject(runtimeKnowledgeRoot(runtime), {
        displayName: stringOption(command, '--name') ?? projectId,
        projectId,
        sourceRepository,
      }, {
        initialProfileBinding: createProfileBindingV2('general', 'en', registrations),
        afterRegistration: async () => {
          const profile = await resolveRegisteredProfileBinding(runtimeKnowledgeRoot(runtime), projectId, {
            registrations: CLI_JSON_KNOWLEDGE_ADAPTERS,
          });
          await readSourceCollectionManifest(candidate.checkout, projectId, {
            sourceAdapterRegistry: profile.sourceAdapters,
          });
          binding = await bindLocalProject(runtime.cwd, {
            expectedBindingDigest: null,
            projectId,
            sourceRepository,
            sourceRoot,
          }, runtime.localProjectRegistryHooks);
        },
      });
      if (binding === undefined) {
        throw new KnowledgeError(
          'REGISTRY_WRITE_FAILED',
          'Project registration did not complete safely.',
        );
      }
      return projectCliView(
        project,
        await inspectLocalSourceStatus(runtime.cwd, project.entry),
        binding,
      );
    }
    case 'project.bind': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      await ensureLocalProjectRegistryIgnored(runtime.cwd);
      const project = await showProject(runtimeKnowledgeRoot(runtime), projectId);
      const sourceRoot = requiredStringOption(command, '--source-root');
      const candidate = await inspectLocalProjectBindingCandidate(runtime.cwd, {
        allowReplacement: true,
        projectId,
        sourceRepository: project.entry.sourceRepository,
        sourceRoot,
      });
      await readSourceCollectionManifest(candidate.checkout, projectId, {
        sourceAdapterRegistry: CLI_SOURCE_ADAPTER_REGISTRY,
      });
      const binding = await bindLocalProject(runtime.cwd, {
        ...(candidate.currentBindingDigest === null
          ? {}
          : { expectedBindingDigest: candidate.currentBindingDigest }),
        projectId,
        sourceRepository: project.entry.sourceRepository,
        sourceRoot,
      }, runtime.localProjectRegistryHooks);
      return projectCliView(
        project,
        await inspectLocalSourceStatus(runtime.cwd, project.entry),
        binding,
      );
    }
    case 'project.list': {
      await assertProjectCommandsReady(runtime);
      const projects = await listProjects(runtimeKnowledgeRoot(runtime));
      return Promise.all(projects.map(async (project) =>
        projectListCliView(project, await inspectLocalSourceStatus(runtime.cwd, project))));
    }
    case 'project.show': {
      await assertProjectCommandsReady(runtime);
      const project = await showProject(
        runtimeKnowledgeRoot(runtime),
        requiredStringOption(command, '--project'),
      );
      return projectCliView(
        project,
        await inspectLocalSourceStatus(runtime.cwd, project.entry),
      );
    }
    case 'project.validate':
      await assertProjectCommandsReady(runtime);
      return validateProjectRegistry(
        runtimeKnowledgeRoot(runtime),
        command.projectId ?? undefined,
      );
    case 'source.add': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const sourceManagement = runtime.sourceManagement ?? createSourceManagement({
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
        hubRoot: runtime.cwd,
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
      });
      return sourceManagement.add({
        id: requiredStringOption(command, '--id'),
        kind: requiredStringOption(command, '--kind') as GenericSourceKind | 'json',
        path: requiredStringOption(command, '--path'),
        projectId,
        ...(command.options['--recursive'] === true ? { recursive: true } : {}),
      });
    }
    case 'source.list': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const sourceManagement = runtime.sourceManagement ?? createSourceManagement({
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
        hubRoot: runtime.cwd,
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
      });
      return sourceManagement.list(projectId);
    }
    case 'source.diff': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const sourceManagement = runtime.sourceManagement ?? createSourceManagement({
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
        hubRoot: runtime.cwd,
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
      });
      return sourceManagement.diff(projectId);
    }
    case 'wiki.list': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return listWikiPages(command, runtime, projectId);
    }
    case 'wiki.curate': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return (runtime.localWiki ?? createDefaultLocalWiki(runtime)).curate({ projectId });
    }
    case 'wiki.read': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return readWikiPage(command, runtime, projectId);
    }
    case 'wiki.citations': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return readWikiCitations(command, runtime, projectId);
    }
    case 'wiki.memory': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      if (runtime.localWiki !== undefined || runtime.wikiRead !== undefined) throw new CliUsageError('CLI_ARGUMENT_INVALID');
      const task = stringOption(command, '--task');
      const budget = stringOption(command, '--max-bytes');
      const progressive = command.options['--progressive'] === true;
      const cursor = stringOption(command, '--cursor');
      if (cursor !== undefined && !progressive) throw new CliUsageError('CLI_ARGUMENT_INVALID');
      const reader = createKnowledgeWikiReader(runtimeKnowledgeRoot(runtime), runtime.readObserver ? { observer: runtime.readObserver } : {});
      if (task === undefined) {
        if (budget !== undefined || progressive) throw new CliUsageError('CLI_ARGUMENT_INVALID');
        return await reader.readMemory(projectId) ?? invalid();
      }
      if (budget !== undefined && !/^[0-9]+$/u.test(budget)) throw new CliUsageError('CLI_ARGUMENT_INVALID');
      if (progressive) return await reader.readProgressiveMemory(projectId, { task,
        ...(budget === undefined ? {} : { maxBytes: Number(budget) }), ...(cursor === undefined ? {} : { cursor }) }) ?? invalid();
      return await reader.readTaskMemory(projectId, { task,
        ...(budget === undefined ? {} : { maxBytes: Number(budget) }) }) ?? invalid();
    }
    case 'wiki.packet': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      if (runtime.localWiki !== undefined || runtime.wikiRead !== undefined) throw new CliUsageError('CLI_ARGUMENT_INVALID');
      return await createKnowledgeWikiReader(runtimeKnowledgeRoot(runtime)).readPacket(projectId) ?? invalid();
    }
    case 'wiki.lookup': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      if (runtime.localWiki !== undefined || runtime.wikiRead !== undefined) throw new CliUsageError('CLI_ARGUMENT_INVALID');
      const reader = createKnowledgeWikiReader(runtimeKnowledgeRoot(runtime), runtime.readObserver ? { observer: runtime.readObserver } : {});
      const ids = stringOption(command, '--ids'), maxBytes = stringOption(command, '--max-bytes');
      if (ids !== undefined) return reader.lookupBatch(projectId,
        hash(requiredStringOption(command, '--expect-generation')),
        choice(requiredStringOption(command, '--kind'), ['evidence', 'fact']), ids.split(',').map(id => hash(id)),
        maxBytes === undefined ? {} : { maxBytes: Number(maxBytes) });
      return reader.lookup(projectId,
        hash(requiredStringOption(command, '--expect-generation')),
        choice(requiredStringOption(command, '--kind'), ['evidence', 'fact']), hash(requiredStringOption(command, '--id')));
    }
    case 'export': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const service = runtime.wikiExport ?? createWikiExportService({
        hubRoot: runtime.cwd,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
      });
      return service.export({
        format: requiredStringOption(command, '--format') as WikiExportFormat,
        outputRoot: requiredStringOption(command, '--output'),
        projectId,
      });
    }
    case 'sync': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const service = runtime.sync ?? createProjectSyncService({
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
      });
      return service.sync({
        dryRun: command.options['--dry-run'] === true,
        hubRoot: runtime.cwd,
        projectId,
      });
    }
    case 'compile': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.projectCompiler ?? createProjectCompiler({
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
      });
      return compiler.execute({
        capability: 'compile',
        projectId,
        ...(command.options['--review'] === true ? { review: true } : {}),
      });
    }
    case 'compile.plan': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.sessionCompiler ?? createProjectSessionCompiler({
        hubRoot: runtime.cwd,
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
      });
      return compiler.plan({ projectId });
    }
    case 'compile.apply': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.sessionCompiler ?? createProjectSessionCompiler({
        hubRoot: runtime.cwd,
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
      });
      return compiler.apply({
        projectId,
        proposalFiles: requiredStringArrayOption(command, '--page'),
      });
    }
    case 'compile.candidates': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.sessionCompiler ?? createProjectSessionCompiler({
        hubRoot: runtime.cwd,
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
      });
      return compiler.candidates({ projectId });
    }
    case 'compile.approve': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.sessionCompiler ?? createProjectSessionCompiler({
        hubRoot: runtime.cwd,
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
      });
      return compiler.approve({
        candidateId: requiredStringOption(command, '--candidate'),
        projectId,
      });
    }
    case 'compile.wiki.start':
    case 'compile.wiki.status':
    case 'compile.wiki.inspect':
    case 'compile.wiki.submit':
    case 'compile.wiki.review':
    case 'compile.wiki.revise':
    case 'compile.wiki.finalize':
    case 'compile.wiki.approve': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const service = createProjectWikiWorkflow({ hubRoot: runtime.cwd, knowledgeRoot: runtimeKnowledgeRoot(runtime),
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS });
      if (command.command === 'compile.wiki.start') return service.start(projectId, requiredStringOption(command, '--purpose'));
      const runId = requiredStringOption(command, '--run');
      if (command.command === 'compile.wiki.status') return service.status(projectId, runId);
      if (command.command === 'compile.wiki.approve') return service.approve(projectId, runId,
        requiredStringOption(command, '--expect-ledger') as `sha256:${string}`, command.options['--confirm-approval'] === true);
      const stage = requiredStringOption(command, '--expect-stage') as `sha256:${string}`;
      if (command.command === 'compile.wiki.finalize') return service.finalize(projectId, runId, stage);
      const input = requiredStringOption(command, '--input');
      if (command.command === 'compile.wiki.inspect') return service.inspect(projectId, runId, input, stage);
      if (command.command === 'compile.wiki.review') return service.review(projectId, runId, input, stage);
      return service.submit(projectId, runId, input, stage, command.command === 'compile.wiki.revise');
    }
    case 'compile.hierarchy.start': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return (runtime.hierarchyWorkflow ?? createDefaultHierarchyWorkflow(runtime, undefined, false,
        command.options['--allow-legacy-authoring'] === true)).start(
        projectId,
        requiredStringOption(command, '--purpose'),
      );
    }
    case 'compile.hierarchy.status': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return (runtime.hierarchyWorkflow ?? createDefaultHierarchyWorkflow(runtime, stringOption(command, '--role') as CompletenessRole | undefined)).status(
        projectId,
        requiredStringOption(command, '--run'),
      );
    }
    case 'compile.hierarchy.inspect': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const completeness = createProjectKnowledgeCompletenessWorkflow({ hubRoot: runtime.cwd,
        knowledgeRoot: runtimeKnowledgeRoot(runtime), jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS });
      if (runtime.knowledgeInspection === undefined && await completeness.handlesRun(projectId, requiredStringOption(command, '--run'))) {
        return completeness.inspect(projectId, requiredStringOption(command, '--run'), requiredStringOption(command, '--input'),
          requiredStringOption(command, '--expect-exchange') as HierarchySha256Digest);
      }
      const inspector = runtime.knowledgeInspection ?? createProjectKnowledgeWorkflow({ hubRoot: runtime.cwd,
        knowledgeRoot: runtimeKnowledgeRoot(runtime), jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS });
      return inspector.inspect(projectId, requiredStringOption(command, '--run'), requiredStringOption(command, '--input'),
        requiredStringOption(command, '--expect-exchange') as HierarchySha256Digest);
    }
    case 'compile.hierarchy.submit': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return (runtime.hierarchyWorkflow ?? createDefaultHierarchyWorkflow(runtime)).submit(
        projectId,
        requiredStringOption(command, '--run'),
        requiredStringOption(command, '--input'),
        requiredStringOption(command, '--expect-exchange') as HierarchySha256Digest,
      );
    }
    case 'compile.hierarchy.resubmit': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return (runtime.hierarchyWorkflow ?? createDefaultHierarchyWorkflow(runtime)).resubmit(
        projectId,
        requiredStringOption(command, '--run'),
        requiredStringOption(command, '--page'),
        requiredStringOption(command, '--input'),
        requiredStringOption(command, '--expect-exchange') as HierarchySha256Digest,
      );
    }
    case 'compile.hierarchy.child-review': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return (runtime.hierarchyWorkflow ?? createDefaultHierarchyWorkflow(runtime)).childReview(
        projectId,
        requiredStringOption(command, '--run'),
        requiredStringOption(command, '--input'),
        requiredStringOption(command, '--expect-review') as HierarchySha256Digest,
      );
    }
    case 'compile.hierarchy.review': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return (runtime.hierarchyWorkflow ?? createDefaultHierarchyWorkflow(runtime, stringOption(command, '--role') as CompletenessRole | undefined)).review(
        projectId,
        requiredStringOption(command, '--run'),
      );
    }
    case 'compile.hierarchy.finalize': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return (runtime.hierarchyWorkflow ?? createDefaultHierarchyWorkflow(runtime, undefined, command.options['--expect-stage'] !== undefined)).finalize(
        projectId,
        requiredStringOption(command, '--run'),
        requiredStringOption(command, '--input'),
        requiredStringOption(command, command.options['--expect-stage'] === undefined ? '--expect-review' : '--expect-stage') as HierarchySha256Digest,
      );
    }
    case 'compile.hierarchy.completeness.shadow':
    case 'compile.hierarchy.completeness.inventory':
    case 'compile.hierarchy.completeness.inventory-review':
    case 'compile.hierarchy.completeness.reconcile':
    case 'compile.hierarchy.completeness.submit':
    case 'compile.hierarchy.completeness.review':
    case 'compile.hierarchy.completeness.source-review':
    case 'compile.hierarchy.completeness.correct':
    case 'compile.hierarchy.completeness.correct-inventory': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const service = createProjectKnowledgeCompletenessWorkflow({ hubRoot: runtime.cwd,
        knowledgeRoot: runtimeKnowledgeRoot(runtime), jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS });
      const action = command.command.slice('compile.hierarchy.completeness.'.length);
      const names = ['shadow', 'inventory', 'inventory-review', 'reconcile', 'submit', 'review', 'source-review', 'correct', 'correct-inventory'] as const;
      const selected = names.find(name => name === action);
      if (selected === undefined) throw new CliUsageError('CLI_ARGUMENT_INVALID');
      return service.write(selected, projectId, requiredStringOption(command, '--run'), requiredStringOption(command, '--input'),
        requiredStringOption(command, '--expect-stage') as HierarchySha256Digest);
    }
    case 'compile.hierarchy.approve': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      if (command.options['--confirm-approval'] !== true) {
        throw new CliUsageError('CLI_OPTION_MISSING');
      }
      return (runtime.hierarchyWorkflow ?? createDefaultHierarchyWorkflow(runtime)).approve(
        projectId,
        requiredStringOption(command, '--run'),
        requiredStringOption(command, '--expect-ledger') as HierarchySha256Digest,
        true,
      );
    }
    case 'compile.activate': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const activation = runtime.hierarchyActivation ?? createHierarchicalWikiActivationService({
        hubRoot: runtime.cwd,
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
      });
      if (command.options['--rematerialize'] === true) {
        return activation.activate({ projectId, rematerialize: true });
      }
      const inputFile = stringOption(command, '--input');
      return activation.activate({
        confirmationDigest: requiredStringOption(command, '--confirm-approval') as
          `sha256:${string}`,
        ...(inputFile === undefined ? {} : { inputFile }),
        projectId,
      });
    }
    case 'check': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.projectCompiler ?? createProjectCompiler({
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
      });
      const check = runtime.check ?? createProjectCheck(compiler);
      return check.check(projectId);
    }
    case 'index.status': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const localWiki = runtime.localWiki ?? createDefaultLocalWiki(runtime);
      return localWiki.indexStatus(projectId);
    }
    case 'index.rebuild': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const localWiki = runtime.localWiki ?? createDefaultLocalWiki(runtime);
      return localWiki.rebuildIndex({
        ...(command.options['--full'] === true ? { full: true } : {}),
        projectId,
      });
    }
    case 'search': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      return searchWithApprovedWiki(command, runtime, projectId);
    }
    case 'query': {
      const projectId = requiredStringOption(command, '--project');
      await assertProjectCommandsReady(runtime, projectId);
      const compiler = runtime.projectCompiler ?? createProjectCompiler({
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
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
        jsonKnowledgeAdapters: CLI_JSON_KNOWLEDGE_ADAPTERS,
        knowledgeRoot: runtimeKnowledgeRoot(runtime),
      });
      return retrieval.context({
        projectId,
        prompt: requiredStringOption(command, '--prompt'),
      });
    }
    case 'publish.plan': {
      const inner = runtime.publication ?? createKnowledgePublicationService(runtimeKnowledgeRoot(runtime));
      const service = runtime.workspaceLayout?.mode === 'knowledge' ? createWorkspacePublicationService(runtime.cwd, inner) : inner;
      return service.plan(await publicationInput(command, runtime));
    }
    case 'publish.commit': {
      const inner = runtime.publication ?? createKnowledgePublicationService(runtimeKnowledgeRoot(runtime));
      const service = runtime.workspaceLayout?.mode === 'knowledge' ? createWorkspacePublicationService(runtime.cwd, inner) : inner;
      return service.commit({
        ...await publicationInput(command, runtime),
        expectedPlanDigest: requiredStringOption(command, '--expect-plan') as PublicationDigest,
      });
    }
    case 'publish.push': {
      const projectId = requiredStringOption(command, '--project');
      const knowledgeRevision = requiredStringOption(command, '--knowledge-revision');
      await assertPublicationPushReady(runtime, projectId, knowledgeRevision);
      const inner = runtime.publication ?? createKnowledgePublicationService(runtimeKnowledgeRoot(runtime));
      const service = runtime.workspaceLayout?.mode === 'knowledge' ? createWorkspacePublicationService(runtime.cwd, inner) : inner;
      return service.push({
        knowledgeRevision,
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

function projectCliView(
  project: ProjectRecord,
  localSource: LocalSourceStatus,
  binding?: {
    readonly bindingDigest: string;
    readonly outcome: 'created' | 'replaced' | 'unchanged';
  },
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    descriptor: project.descriptor,
    entry: project.entry,
    localSource,
    workspacePath: project.workspacePath,
    ...(binding === undefined
      ? {}
      : {
          binding: Object.freeze({
            bindingDigest: binding.bindingDigest,
            outcome: binding.outcome,
          }),
        }),
  });
}

function projectListCliView(
  project: ProjectRegistryEntry,
  localSource: LocalSourceStatus,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...project, localSource });
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
  const redactionRuleIds = new Set(SECURITY_RULES
    .filter((rule) => rule.action === 'redact' || rule.action === 'warn')
    .map((rule) => rule.ruleId));
  const warnings = data.warnings.map((warning: unknown) => {
    if (typeof warning === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(warning)) {
      return Object.freeze({
        code: warning,
        message: 'The command completed with a structured warning.',
      });
    }
    if (typeof warning !== 'object' || warning === null || !('code' in warning) ||
        typeof warning.code !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(warning.code)) {
      return null;
    }
    if (warning.code !== 'sanitization-redaction-applied' && warning.code !== 'sanitization-risk-warning') {
      return Object.freeze({
        code: warning.code,
        message: 'The command completed with a structured warning.',
      });
    }
    if (
      Object.keys(warning).some((key) =>
        !['code', 'occurrenceCount', 'ruleId', 'sourceCount', 'sourceRefs', 'omittedSourceCount'].includes(key)) ||
      !('ruleId' in warning) || typeof warning.ruleId !== 'string' ||
      !redactionRuleIds.has(warning.ruleId) ||
      !('occurrenceCount' in warning) || typeof warning.occurrenceCount !== 'number' ||
      !Number.isSafeInteger(warning.occurrenceCount) || warning.occurrenceCount <= 0 ||
      !('sourceCount' in warning) || typeof warning.sourceCount !== 'number' ||
      !Number.isSafeInteger(warning.sourceCount) || warning.sourceCount <= 0 ||
      warning.sourceCount > warning.occurrenceCount
    ) return null;
    const refs = 'sourceRefs' in warning && Array.isArray(warning.sourceRefs)
      ? warning.sourceRefs.slice(0, 32).filter((ref: unknown): ref is string =>
          typeof ref === 'string' && safeSyncSourceRef(ref) === ref) : [];
    return Object.freeze({
      code: warning.code,
      message: warning.code === 'sanitization-risk-warning'
        ? `Sanitizer rule ${warning.ruleId} flagged ${warning.occurrenceCount} occurrence(s) across ${warning.sourceCount} source(s); processing continued.${refs.length > 0 ? ` Files: ${refs.join(', ')}.` : ''}`
        : `Sanitizer rule ${warning.ruleId} redacted ${warning.occurrenceCount} occurrence(s) across ${warning.sourceCount} source(s).`,
    });
  });
  if (warnings.some((warning) => warning === null)) return [];
  const unique = new Map<string, Readonly<{ readonly code: string; readonly message: string }>>();
  for (const warning of warnings) {
    if (warning !== null) unique.set(`${warning.code}\u0000${warning.message}`, warning);
  }
  return Object.freeze([...unique.values()].sort((left, right) => {
    const leftKey = `${left.code}\u0000${left.message}`;
    const rightKey = `${right.code}\u0000${right.message}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }));
}

function normalizeDomainData(command: ParsedCliCommand, data: unknown): unknown {
  if (command.operation.startsWith('publish.') && typeof data === 'object' && data !== null && 'schemaVersion' in data &&
      (data.schemaVersion === 'buildlore.workspace-publish-plan.v1' || data.schemaVersion === 'buildlore.workspace-publish-result.v1')) {
    return normalizeWorkspacePublication(data);
  }
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

export function successResult(command: Pick<ParsedCliCommand, 'command' | 'projectId'>, data: unknown): CliSuccessResult {
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

function connectedRequest(command: ParsedCliCommand): WikiReadRequest {
  const operation = (command.command === 'search' ? 'search' : command.command.slice(5)) as WikiReadRequest['operation'];
  const strings = Object.fromEntries([['--expect-generation', 'expectedGeneration'], ['--page', 'page'], ['--query', 'query'], ['--mode', 'mode'],
    ['--view', 'view'], ['--cursor', 'cursor'], ['--task', 'task'], ['--kind', 'kind'], ['--id', 'id'], ['--intent', 'intent']]
    .flatMap(([option, key]) => option && key && stringOption(command, option) !== undefined ? [[key, stringOption(command, option)]] : []));
  const maxBytes = stringOption(command, '--max-bytes');
  const ids = stringOption(command, '--ids');
  if (maxBytes !== undefined && (!/^\d+$/u.test(maxBytes) || !Number.isSafeInteger(Number(maxBytes)) || Number(maxBytes) < 1)) throw new CliUsageError('CLI_ARGUMENT_INVALID');
  return { operation, ...strings, ...(command.options['--progressive'] === true ? { progressive: true } : {}),
    ...(ids === undefined ? {} : { ids: ids.split(',') }),
    ...(maxBytes === undefined ? {} : { maxBytes: Number(maxBytes) }),
    ...(stringOption(command, '--limit') === undefined ? {} : { limit: Number(stringOption(command, '--limit')) }) };
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
    const invocation = parseCliArguments(args, { connected: true });
    if (invocation.kind === 'help') {
      io.stdout(HELP_TEXT);
      return 0;
    }
    if (invocation.command === 'workspace.connect' || invocation.command === 'workspace.check' ||
        invocation.command === 'workspace.guide' && stringOption(invocation, '--client') !== undefined) {
      if (stringOption(invocation, '--client') !== 'codex' || !invocation.projectId) throw new CliUsageError('CLI_ARGUMENT_INVALID');
      const options = { directory: runtime.cwd, projectId: invocation.projectId, client: 'codex' as const,
        apply: invocation.options['--apply'] === true,
        ...(runtime.configDir === undefined ? {} : { configDir: runtime.configDir }),
        ...(runtime.workspaceBinPath === undefined ? {} : { binPath: runtime.workspaceBinPath }) };
      const data = invocation.command === 'workspace.connect' ? await workspaceConnect(options)
        : invocation.command === 'workspace.check' ? await workspaceCheck(options) : await workspaceClientGuide(options);
      const result: CliResult = data.overall === 'blocked'
        ? { ...successResult(invocation, data), ok: false, exitCode: 3,
          partial: data.operation === 'connect' && data.stages.some(s => s.id === 'connection' && s.state === 'complete'),
          errors: [{ code: data.stages.find(s => s.state === 'blocked')?.code ?? 'WORKSPACE_SETUP_FAILED',
            message: 'Follow the next action, then repeat the command.' }] }
        : successResult(invocation, data);
      const rendered = renderCliResult(result, invocation.outputMode);
      writeRenderedCliResult(io, rendered); return rendered.exitCode;
    }
    if (invocation.command === 'workspace.guide') {
      const data = await workspaceGuide(runtime.cwd, invocation.projectId ?? undefined, runtime.configDir);
      const result: CliResult = data.overall === 'blocked'
        ? { ...successResult(invocation, data), ok: false, exitCode: 3,
          errors: [{ code: 'WORKSPACE_GUIDE_BLOCKED', message: 'Setup needs repair. Follow the next action at its specified location.' }] }
        : successResult(invocation, data);
      const rendered = renderCliResult(result, invocation.outputMode);
      writeRenderedCliResult(io, rendered);
      return rendered.exitCode;
    }
    runtime = { ...runtime, workspaceLayout: await resolveWorkspaceLayout(runtime.cwd) };
    outputMode = invocation.outputMode;
    context = { command: invocation.command, projectId: invocation.projectId };
    const options = runtime.configDir === undefined ? {} : { configDir: runtime.configDir };
    const diagnostic = invocation.command === 'connection.status' || invocation.command === 'doctor';
    const reading = CONNECTED_READ_COMMANDS.includes(invocation.command);
    if (diagnostic || reading) {
      let connection;
      try { connection = await resolveConnection(runtime.cwd, options); }
      catch (error) {
        // Explicit project reads in a legacy non-Git test/runtime keep the old route.
        if (error instanceof ConnectionError && error.code === 'CONNECTION_MISSING' && invocation.projectId !== null && !diagnostic) connection = null;
        else {
          context = { ...context, readContext: null };
          if (!diagnostic) throw error;
          const failure = { ...mapCliError(error, context), data: unavailableConnectionStatus(error) };
          const rendered = renderCliResult(failure, outputMode);
          writeRenderedCliResult(io, rendered); return rendered.exitCode;
        }
      }
      if (connection) {
        context = { ...context, projectId: connection.projectId, readContext: null };
        if (invocation.projectId !== null && invocation.projectId !== connection.projectId) connectionFail('PROJECT_MISMATCH');
        if (diagnostic) {
          const data = await connectionStatus(connection);
          const result = data.readable === true ? { ...successResult(invocation, data), ...context } :
            { ...mapCliError(new ConnectionError(data.pin !== 'matched' && data.pin !== 'not_applicable' ? 'KNOWLEDGE_PIN_MISMATCH' :
              data.approval === 'invalid' ? 'KNOWLEDGE_INVALID' : 'APPROVAL_MISSING'), context), data };
          const rendered = renderCliResult(result, outputMode); writeRenderedCliResult(io, rendered); return rendered.exitCode;
        }
        const read = await readConnectedWiki(connection, connectedRequest(invocation), runtime.readObserver ? { observer: runtime.readObserver } : {});
        const rendered = renderCliResult({ ...successResult(invocation, read.data), ...context,
          readContext: read.readContext, knowledgeRevision: read.knowledgeRevision }, outputMode);
        writeRenderedCliResult(io, rendered); return rendered.exitCode;
      }
      if (diagnostic || invocation.projectId === null) {
        context = { ...context, readContext: null };
        const error = new ConnectionError('CONNECTION_MISSING');
        const failure = { ...mapCliError(error, context), ...(diagnostic ? { data: unavailableConnectionStatus(error) } : {}) };
        const rendered = renderCliResult(failure, outputMode); writeRenderedCliResult(io, rendered); return rendered.exitCode;
      }
    }
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
    if (CONNECTED_READ_COMMANDS.includes(context.command as ParsedCliCommand['command']) && context.readContext === undefined) {
      try {
        if (!args.includes('--project') || await resolveConnection(runtime.cwd, runtime)) context = { ...context, readContext: null };
      } catch (resolutionError) {
        if (!(resolutionError instanceof ConnectionError) || resolutionError.code !== 'CONNECTION_MISSING') context = { ...context, readContext: null };
      }
    }
    const rendered = renderCliResult(mapCliError(error, context), outputMode);
    writeRenderedCliResult(io, rendered);
    return rendered.exitCode;
  }
}
