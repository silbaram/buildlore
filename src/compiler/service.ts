import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { validateProjectId } from '../knowledge/validation.js';
import { showProject } from '../knowledge/workspace.js';
import {
  createProfileBindingPreflight,
  type ProfileBindingPreflight,
} from '../profile/preflight.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from '../projector/json-knowledge-adapter.js';
import { requiresEgress } from './capabilities.js';
import { createLlmWikiCompilerBackend } from './backend.js';
import { CompilerBackendError, CompilerOperationError } from './errors.js';
import {
  createProjectEmbeddingIdentityStore,
  resolveConfiguredEmbeddingIdentity,
  type ProjectEmbeddingIdentityPort,
} from './embedding-identity.js';
import { normalizeCompilerResult, validateCompilerRequest } from './normalizers.js';
import { createSessionReviewStore } from './session/review-store.js';
import {
  processOutputLanguageCoordinator,
  type OutputLanguageCoordinator,
} from './output-language.js';
import {
  prepareCompilerEgress,
  verifyAndConsumeCompilerEgress,
  type CompilerSecurityPermit,
} from './security.js';
import type {
  CompilerBackend,
  CompilerExecutionControl,
  CompilerOperationResult,
  CompilerRequest,
  EgressCapability,
  ProjectCompilerPort,
} from './types.js';

const TIMEOUT_ENV_NAMES = ['LLMWIKI_REQUEST_TIMEOUT_MS', 'OLLAMA_TIMEOUT_MS'] as const;
const MAX_TIMER_MS = 2_147_483_647;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function mayWriteWorkspace(capability: CompilerRequest['capability']): boolean {
  return capability === 'approve' || capability === 'compile' || capability === 'eval-full' || capability === 'query';
}

function configError(request: CompilerRequest): CompilerOperationError {
  return new CompilerOperationError('COMPILER_CONFIG_INVALID', 'Compiler configuration is invalid.', {
    capability: request.capability,
    projectId: request.projectId,
    recoveryAction: 'check-config',
    retryable: false,
    sideEffectsPossible: false,
  });
}

function validateExecutionControl(request: CompilerRequest, control: unknown): asserts control is CompilerExecutionControl {
  if (
    typeof control !== 'object' ||
    control === null ||
    Array.isArray(control) ||
    Object.keys(control).some((field) => field !== 'signal')
  ) {
    throw configError(request);
  }
  const signal = (control as { readonly signal?: unknown }).signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw configError(request);
  }
}

function validateProviderTimeouts(
  request: CompilerRequest,
  environment: Readonly<NodeJS.ProcessEnv>,
): void {
  for (const name of TIMEOUT_ENV_NAMES) {
    const raw = environment[name]?.trim();
    if (raw === undefined || raw === '') {
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
      throw configError(request);
    }
  }
}

function cancellationError(request: CompilerRequest, sideEffectsPossible: boolean): CompilerOperationError {
  return new CompilerOperationError('COMPILER_CANCELLED', 'Compiler operation was cancelled.', {
    capability: request.capability,
    projectId: request.projectId,
    recoveryAction: sideEffectsPossible ? 'status' : 'retry',
    retryable: !sideEffectsPossible,
    sideEffectsPossible,
  });
}

function mapBackendError(request: CompilerRequest, error: CompilerBackendError): CompilerOperationError {
  switch (error.kind) {
    case 'busy':
      return new CompilerOperationError('COMPILER_BUSY', 'Compiler workspace is busy.', {
        capability: request.capability,
        projectId: request.projectId,
        recoveryAction: 'status',
        retryable: true,
        sideEffectsPossible: false,
      });
    case 'provider-unavailable':
      return new CompilerOperationError(
        'COMPILER_PROVIDER_UNAVAILABLE',
        'Compiler provider is unavailable.',
        {
          capability: request.capability,
          projectId: request.projectId,
          recoveryAction: 'check-config',
          retryable: false,
          sideEffectsPossible: false,
        },
      );
    case 'provider-unknown':
      return new CompilerOperationError('COMPILER_PROVIDER_UNKNOWN', 'Compiler provider is unknown.', {
        capability: request.capability,
        projectId: request.projectId,
        recoveryAction: 'check-config',
        retryable: false,
        sideEffectsPossible: false,
      });
    case 'timeout':
      return new CompilerOperationError('COMPILER_TIMEOUT', 'Compiler provider request timed out.', {
        capability: request.capability,
        projectId: request.projectId,
        recoveryAction: 'status',
        retryable: true,
        sideEffectsPossible: mayWriteWorkspace(request.capability),
      });
    case 'failed':
      return new CompilerOperationError('COMPILER_FAILED', 'Compiler operation failed.', {
        capability: request.capability,
        projectId: request.projectId,
        recoveryAction: 'status',
        retryable: false,
        sideEffectsPossible: mayWriteWorkspace(request.capability),
      });
  }
}

function contractError(request: CompilerRequest): CompilerOperationError {
  return new CompilerOperationError(
    'COMPILER_CONTRACT_VIOLATION',
    'Compiler returned an unsafe result.',
    {
      capability: request.capability,
      projectId: request.projectId,
      recoveryAction: 'status',
      retryable: false,
      sideEffectsPossible: mayWriteWorkspace(request.capability),
    },
  );
}

class ProjectOperationCoordinator {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(workspaceKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(workspaceKey, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#tails.get(workspaceKey) === tail) {
        this.#tails.delete(workspaceKey);
      }
    }
  }
}

const projectOperations = new ProjectOperationCoordinator();

export interface CreateProjectCompilerOptions {
  readonly backend?: CompilerBackend;
  readonly embeddingIdentityPort?: ProjectEmbeddingIdentityPort;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly knowledgeRoot: string;
  readonly jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
  readonly outputLanguageCoordinator?: OutputLanguageCoordinator;
  readonly profilePreflight?: ProfileBindingPreflight;
}

export function createProjectCompiler(options: CreateProjectCompilerOptions): ProjectCompilerPort {
  const backend = options.backend ?? createLlmWikiCompilerBackend();
  const environment = options.environment ?? process.env;
  const embeddingIdentityPort = options.embeddingIdentityPort ??
    createProjectEmbeddingIdentityStore(options.knowledgeRoot);
  const knowledgeRoot = options.knowledgeRoot;
  const outputLanguageCoordinator = options.outputLanguageCoordinator ??
    processOutputLanguageCoordinator;
  const profilePreflight = options.profilePreflight ?? createProfileBindingPreflight(knowledgeRoot, {
    registrations: options.jsonKnowledgeAdapters ?? [],
  });
  const requestOrdering = new ProjectOperationCoordinator();

  async function resolveWorkspace(projectId: string): Promise<string> {
    const record = await showProject(knowledgeRoot, projectId);
    return resolveProjectWorkspace(knowledgeRoot, record.entry.projectId, {
      mustExist: true,
    });
  }

  async function execute(
    inputRequest: CompilerRequest,
    inputControl: CompilerExecutionControl = {},
  ): Promise<CompilerOperationResult> {
    let requestSnapshot: Readonly<Record<string, unknown>>;
    let controlCandidate: unknown;
    try {
      requestSnapshot = { ...inputRequest };
      controlCandidate = typeof inputControl === 'object' && inputControl !== null &&
        !Array.isArray(inputControl)
        ? Object.freeze({ ...inputControl })
        : inputControl;
    } catch {
      throw new CompilerOperationError('COMPILER_CONFIG_INVALID', 'Compiler input is invalid.', {
        capability: 'unknown',
        projectId: 'unknown',
        recoveryAction: 'check-config',
        retryable: false,
        sideEffectsPossible: false,
      });
    }
    validateCompilerRequest(requestSnapshot);
    const request = Object.freeze(
      requestSnapshot.capability === 'context'
        ? { ...requestSnapshot, prompt: requestSnapshot.prompt.normalize('NFC') }
        : requestSnapshot.capability === 'query' || requestSnapshot.capability === 'search'
          ? { ...requestSnapshot, question: requestSnapshot.question.normalize('NFC') }
          : requestSnapshot,
    ) as CompilerRequest;
    validateProjectId(request.projectId);
    validateExecutionControl(request, controlCandidate);
    const startingEmbeddingIdentity = request.capability === 'compile' && request.review !== true
      ? resolveConfiguredEmbeddingIdentity(environment)
      : null;
    const control = controlCandidate;
    return requestOrdering.run(request.projectId, async () => {
      const selectedWorkspace = await resolveWorkspace(request.projectId);
      return projectOperations.run(selectedWorkspace, async () => {
        const workspace = await resolveWorkspace(request.projectId);
        const profileBinding = await profilePreflight.resolve(request.projectId);
        if (profileBinding.workspace !== workspace) throw configError(request);
        if (isAborted(control.signal)) {
          throw cancellationError(request, false);
        }
        let egressPermit: CompilerSecurityPermit | undefined;
        let egressRequest: (CompilerRequest & { readonly capability: EgressCapability }) | undefined;
        if (requiresEgress(request)) {
          egressRequest = request;
          validateProviderTimeouts(request, environment);
          try {
            egressPermit = await prepareCompilerEgress(
              knowledgeRoot,
              workspace,
              request,
              options.jsonKnowledgeAdapters ?? [],
            );
          } catch {
            throw new CompilerOperationError(
              'COMPILER_EGRESS_DENIED',
              'Compiler egress is not authorized.',
              {
                capability: request.capability,
                projectId: request.projectId,
                recoveryAction: 'check-config',
                retryable: false,
                sideEffectsPossible: false,
              },
            );
          }
          if (isAborted(control.signal)) {
            throw cancellationError(request, false);
          }
        }

        const performBackend = async (): Promise<CompilerOperationResult> => {
          const freshBinding = await profilePreflight.resolve(request.projectId);
          if (freshBinding.workspace !== workspace || freshBinding.mode !== profileBinding.mode ||
              freshBinding.outputLanguage !== profileBinding.outputLanguage) {
            throw configError(request);
          }
          if (isAborted(control.signal)) throw cancellationError(request, false);
          if (egressPermit !== undefined && egressRequest !== undefined) {
            try {
              await verifyAndConsumeCompilerEgress(
                egressPermit,
                knowledgeRoot,
                workspace,
                egressRequest,
                options.jsonKnowledgeAdapters ?? [],
              );
            } catch {
              throw new CompilerOperationError(
                'COMPILER_EGRESS_DENIED',
                'Compiler egress is not authorized.',
                {
                  capability: request.capability,
                  projectId: request.projectId,
                  recoveryAction: 'check-config',
                  retryable: false,
                  sideEffectsPossible: false,
                },
              );
            }
          }
          let cancelRequested = false;
          const onAbort = (): void => {
            cancelRequested = true;
          };
          control.signal?.addEventListener('abort', onAbort, { once: true });
          if (isAborted(control.signal)) cancelRequested = true;
          try {
            if (cancelRequested) throw cancellationError(request, false);
            let raw: unknown;
            try {
              raw = await backend.run(workspace, request);
            } catch (error) {
              if (cancelRequested) throw cancellationError(request, true);
              if (error instanceof CompilerOperationError) throw error;
              if (error instanceof CompilerBackendError) throw mapBackendError(request, error);
              throw new CompilerOperationError('COMPILER_FAILED', 'Compiler operation failed.', {
                capability: request.capability,
                projectId: request.projectId,
                recoveryAction: 'status',
                retryable: false,
                sideEffectsPossible: mayWriteWorkspace(request.capability),
              });
            }
            if (cancelRequested) throw cancellationError(request, true);
            try {
              let normalized = normalizeCompilerResult(request, raw);
              if (request.capability === 'status' && 'pendingCandidates' in normalized.data) {
                const managed = await createSessionReviewStore(workspace, request.projectId).list();
                const boundCustomCount = managed.filter(({ candidate }) =>
                  candidate.upstreamCandidateId !== undefined).length;
                normalized = Object.freeze({
                  ...normalized,
                  data: Object.freeze({
                    ...normalized.data,
                    pendingCandidates: Math.max(
                      0,
                      normalized.data.pendingCandidates - boundCustomCount,
                    ) + managed.length,
                  }),
                });
              }
              if (request.capability === 'compile' && request.review !== true &&
                  startingEmbeddingIdentity !== null) {
                const settledIdentity = resolveConfiguredEmbeddingIdentity(environment);
                if (settledIdentity === null || settledIdentity.compatibilityDigest !==
                    startingEmbeddingIdentity.compatibilityDigest) {
                  throw new CompilerOperationError(
                    'COMPILER_FAILED',
                    'Compiler embedding identity changed during execution.',
                    {
                      capability: request.capability,
                      projectId: request.projectId,
                      recoveryAction: 'status',
                      retryable: false,
                      sideEffectsPossible: true,
                    },
                  );
                }
                try {
                  await embeddingIdentityPort.record(request.projectId, settledIdentity);
                } catch {
                  throw new CompilerOperationError(
                    'COMPILER_FAILED',
                    'Compiler identity state could not be recorded.',
                    {
                      capability: request.capability,
                      projectId: request.projectId,
                      recoveryAction: 'status',
                      retryable: false,
                      sideEffectsPossible: true,
                    },
                  );
                }
              }
              return normalized;
            } catch (error) {
              if (error instanceof CompilerOperationError) throw error;
              throw contractError(request);
            }
          } finally {
            control.signal?.removeEventListener('abort', onAbort);
          }
        };
        if (request.capability === 'compile' || request.capability === 'query') {
          return outputLanguageCoordinator.run(
            profileBinding.mode === 'custom' ? profileBinding.outputLanguage : null,
            performBackend,
          );
        }
        return performBackend();
      });
    });
  }

  return {
    execute,
    async status(projectId) {
      const result = await execute({ capability: 'status', projectId });
      const data = result.data;
      if (!('pendingChanges' in data)) {
        throw new CompilerOperationError(
          'COMPILER_CONTRACT_VIOLATION',
          'Compiler returned an unsafe result.',
          {
            capability: 'status',
            projectId,
            recoveryAction: 'status',
            retryable: false,
            sideEffectsPossible: false,
          },
        );
      }
      return {
        pendingChanges: data.pendingChanges,
        pendingChangesCount: data.pendingChangesCount,
        stateStatus: data.stateStatus,
      };
    },
  };
}
