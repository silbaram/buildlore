import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { validateProjectId } from '../knowledge/validation.js';
import { showProject } from '../knowledge/workspace.js';
import { requiresEgress } from './capabilities.js';
import { createLlmWikiCompilerBackend } from './backend.js';
import { CompilerBackendError, CompilerOperationError } from './errors.js';
import { normalizeCompilerResult, validateCompilerRequest } from './normalizers.js';
import type {
  CompilerBackend,
  CompilerEgressAuthorizer,
  CompilerEgressContext,
  CompilerEgressPermit,
  CompilerExecutionControl,
  CompilerOperationResult,
  CompilerRequest,
  ProjectCompilerPort,
} from './types.js';

const TIMEOUT_ENV_NAMES = ['LLMWIKI_REQUEST_TIMEOUT_MS', 'OLLAMA_TIMEOUT_MS'] as const;
const MAX_TIMER_MS = 2_147_483_647;
const issuedPermits = new WeakMap<object, CompilerEgressContext & { consumed: boolean }>();

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function mayWriteWorkspace(capability: CompilerRequest['capability']): boolean {
  return capability === 'compile' || capability === 'eval-full' || capability === 'query';
}

export type CompilerEgressDecision = (
  context: CompilerEgressContext,
) => boolean | Promise<boolean>;

export function createCompilerEgressAuthorizer(
  decide: CompilerEgressDecision,
): CompilerEgressAuthorizer {
  return {
    async authorize(context) {
      const immutableContext = Object.freeze({ ...context });
      if ((await decide(immutableContext)) !== true) {
        throw new CompilerOperationError('COMPILER_EGRESS_DENIED', 'Compiler egress is not authorized.', {
          capability: immutableContext.capability,
          projectId: immutableContext.projectId,
          recoveryAction: 'check-config',
          retryable: false,
          sideEffectsPossible: false,
        });
      }
      const permit = Object.freeze({ opaque: true as const });
      issuedPermits.set(permit, { ...immutableContext, consumed: false });
      return permit;
    },
  };
}

const denyEgress = createCompilerEgressAuthorizer(() => false);

function consumePermit(
  permit: CompilerEgressPermit,
  expected: CompilerEgressContext,
): void {
  const binding = issuedPermits.get(permit);
  if (
    binding === undefined ||
    binding.consumed ||
    binding.capability !== expected.capability ||
    binding.projectId !== expected.projectId
  ) {
    throw new CompilerOperationError('COMPILER_EGRESS_DENIED', 'Compiler egress is not authorized.', {
      capability: expected.capability,
      projectId: expected.projectId,
      recoveryAction: 'check-config',
      retryable: false,
      sideEffectsPossible: false,
    });
  }
  binding.consumed = true;
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
  readonly egressAuthorizer?: CompilerEgressAuthorizer;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly knowledgeRoot: string;
}

export function createProjectCompiler(options: CreateProjectCompilerOptions): ProjectCompilerPort {
  const backend = options.backend ?? createLlmWikiCompilerBackend();
  const egressAuthorizer = options.egressAuthorizer ?? denyEgress;
  const environment = options.environment ?? process.env;

  async function resolveWorkspace(projectId: string): Promise<string> {
    const record = await showProject(options.knowledgeRoot, projectId);
    return resolveProjectWorkspace(options.knowledgeRoot, record.entry.projectId, {
      mustExist: true,
    });
  }

  async function execute(
    request: CompilerRequest,
    control: CompilerExecutionControl = {},
  ): Promise<CompilerOperationResult> {
    validateCompilerRequest(request);
    validateProjectId(request.projectId);
    validateExecutionControl(request, control);
    const selectedWorkspace = await resolveWorkspace(request.projectId);
    return projectOperations.run(selectedWorkspace, async () => {
      const workspace = await resolveWorkspace(request.projectId);
      if (isAborted(control.signal)) {
        throw cancellationError(request, false);
      }
      if (requiresEgress(request)) {
        validateProviderTimeouts(request, environment);
        const context = Object.freeze({
          capability: request.capability,
          projectId: request.projectId,
        });
        try {
          consumePermit(await egressAuthorizer.authorize(context), context);
        } catch (error) {
          if (error instanceof CompilerOperationError) {
            throw error;
          }
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

      let cancelRequested = false;
      const onAbort = (): void => {
        cancelRequested = true;
      };
      control.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        let raw: unknown;
        try {
          raw = await backend.run(workspace, request);
        } catch (error) {
          if (cancelRequested) {
            throw cancellationError(request, true);
          }
          if (error instanceof CompilerOperationError) {
            throw error;
          }
          if (error instanceof CompilerBackendError) {
            throw mapBackendError(request, error);
          }
          throw new CompilerOperationError('COMPILER_FAILED', 'Compiler operation failed.', {
            capability: request.capability,
            projectId: request.projectId,
            recoveryAction: 'status',
            retryable: false,
            sideEffectsPossible: mayWriteWorkspace(request.capability),
          });
        }
        if (cancelRequested) {
          throw cancellationError(request, true);
        }
        try {
          return normalizeCompilerResult(request, raw);
        } catch (error) {
          if (error instanceof CompilerOperationError) {
            throw error;
          }
          throw contractError(request);
        }
      } finally {
        control.signal?.removeEventListener('abort', onAbort);
      }
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
