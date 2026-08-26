import { validateProjectId } from '../../knowledge/validation.js';
import { compareSessionText } from './canonical.js';
import {
  readSessionCompileProposalFile,
  SESSION_COMPILE_LIMITS,
} from './contracts.js';
import { createSessionCompileAdmission, type SessionCompileAdmission } from './admission.js';
import { SessionCompileError } from './errors.js';
import {
  createSessionCompilePlanner,
  type SessionCompilePlanner,
} from './source-planner.js';
import { validateSessionProposalBatch } from './validator.js';
import type {
  ProjectSessionCompilerPort,
  SessionCompileApplyRequest,
  SessionCompileApplyResultV1,
  SessionCompilePlanRequest,
  SessionCompilePlanV1,
} from './types.js';

export interface CreateProjectSessionCompilerOptions {
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
}

interface CreateProjectSessionCompilerInternalOptions
  extends CreateProjectSessionCompilerOptions {
  readonly admission?: SessionCompileAdmission;
  readonly planner?: SessionCompilePlanner;
}

class SessionProjectCoordinator {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(projectId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(projectId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#tails.get(projectId) === tail) this.#tails.delete(projectId);
    }
  }
}

const applyCoordinator = new SessionProjectCoordinator();

function validProjectId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SessionCompileError('SESSION_CONTRACT_INVALID', 'unknown');
  }
  try {
    return validateProjectId(value);
  } catch {
    throw new SessionCompileError('SESSION_CONTRACT_INVALID', 'unknown');
  }
}

function planRequest(input: SessionCompilePlanRequest): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input) ||
      Object.keys(input).length !== 1 || !Object.hasOwn(input, 'projectId')) {
    throw new SessionCompileError('SESSION_CONTRACT_INVALID', 'unknown');
  }
  return validProjectId(input.projectId);
}

function applyRequest(input: SessionCompileApplyRequest): Readonly<{
  readonly projectId: string;
  readonly proposalFiles: readonly string[];
}> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) ||
      Object.keys(input).sort(compareSessionText).join(',') !== 'projectId,proposalFiles') {
    throw new SessionCompileError('SESSION_CONTRACT_INVALID', 'unknown');
  }
  const projectId = validProjectId(input.projectId);
  const proposalFiles: unknown = input.proposalFiles;
  if (!Array.isArray(proposalFiles) || proposalFiles.length === 0 ||
      proposalFiles.length > SESSION_COMPILE_LIMITS.maxProposals ||
      proposalFiles.some((path: unknown) => typeof path !== 'string' || path.length === 0 ||
        path.length > 4_096 || path.includes('\0')) ||
      new Set(proposalFiles as readonly string[]).size !== proposalFiles.length) {
    throw new SessionCompileError('SESSION_CONTRACT_INVALID', projectId);
  }
  return Object.freeze({
    projectId,
    proposalFiles: Object.freeze([...(proposalFiles as readonly string[])]),
  });
}

function createProjectSessionCompilerInternal(
  options: CreateProjectSessionCompilerInternalOptions,
): ProjectSessionCompilerPort {
  const planner = options.planner ?? createSessionCompilePlanner({
    hubRoot: options.hubRoot,
    knowledgeRoot: options.knowledgeRoot,
  });
  const admission = options.admission ?? createSessionCompileAdmission();
  async function plan(input: SessionCompilePlanRequest): Promise<SessionCompilePlanV1> {
    const projectId = planRequest(input);
    return (await planner.create(projectId)).plan;
  }
  async function apply(
    input: SessionCompileApplyRequest,
  ): Promise<SessionCompileApplyResultV1> {
    const request = applyRequest(input);
    return applyCoordinator.run(request.projectId, async () => {
      const proposals = [];
      for (const path of request.proposalFiles) {
        proposals.push(await readSessionCompileProposalFile(path, request.projectId));
      }
      const snapshot = await planner.create(request.projectId);
      const batch = await validateSessionProposalBatch(
        snapshot,
        proposals,
        options.knowledgeRoot,
        request.projectId,
      );
      return admission.stage(
        snapshot.workspace,
        request.projectId,
        snapshot.profileMode,
        batch,
        async () => {
          const current = await planner.create(request.projectId);
          if (
            current.plan.planDigest !== snapshot.plan.planDigest ||
            current.workspace !== snapshot.workspace ||
            current.profileMode !== snapshot.profileMode
          ) throw new SessionCompileError('SESSION_PLAN_STALE', request.projectId);
        },
      );
    });
  }
  return Object.freeze({ apply, plan });
}

export function createProjectSessionCompiler(
  options: CreateProjectSessionCompilerOptions,
): ProjectSessionCompilerPort {
  return createProjectSessionCompilerInternal(options);
}

/** @internal Test-only construction seam; not exported from the package domain index. */
export function createProjectSessionCompilerForTest(
  options: CreateProjectSessionCompilerInternalOptions,
): ProjectSessionCompilerPort {
  return createProjectSessionCompilerInternal(options);
}
