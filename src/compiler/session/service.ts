import { validateProjectId } from '../../knowledge/validation.js';
import { resolveProjectWorkspace } from '../../knowledge/paths.js';
import { showProject } from '../../knowledge/workspace.js';
import { createProfileBindingPreflight } from '../../profile/preflight.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from '../../projector/json-knowledge-adapter.js';
import { isGeneratedIdentifier } from '../../sanitizer/index.js';
import { compareSessionText, digestSessionValue } from './canonical.js';
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
import { createSessionReviewService, type SessionReviewService } from './review-service.js';
import { SESSION_COMPILE_APPLY_RESULT_SCHEMA_VERSION } from './types.js';
import type {
  ProjectSessionCompilerPort,
  SessionCompileApproveRequest,
  SessionCompileApproveResultV1,
  SessionCompileApplyRequest,
  SessionCompileApplyResultV2,
  SessionCompileCandidatesRequest,
  SessionCompileCandidatesResultV1,
  SessionCompilePlanRequest,
  SessionCompilePlanV1,
  SessionSha256Digest,
} from './types.js';

export interface CreateProjectSessionCompilerOptions {
  readonly hubRoot: string;
  readonly jsonKnowledgeAdapters?: readonly RegisteredJsonKnowledgeAdapterV1[];
  readonly knowledgeRoot: string;
}

interface CreateProjectSessionCompilerInternalOptions
  extends CreateProjectSessionCompilerOptions {
  readonly admission?: SessionCompileAdmission;
  readonly planner?: SessionCompilePlanner;
  readonly review?: SessionReviewService;
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

function stableSnapshotDigest(snapshot: Awaited<ReturnType<SessionCompilePlanner['create']>>):
SessionSha256Digest {
  return digestSessionValue(Object.fromEntries(Object.entries(snapshot.plan).filter(([key]) =>
    key !== 'existingKnowledgeDigest' && key !== 'planDigest')));
}

function samePendingSlugs(
  actual: ReadonlySet<string>,
  expected: ReadonlySet<string>,
): boolean {
  return actual.size === expected.size && [...actual].every((slug) => expected.has(slug));
}

function assertExpectedSnapshot(
  initial: Awaited<ReturnType<SessionCompilePlanner['create']>>,
  current: Awaited<ReturnType<SessionCompilePlanner['create']>>,
  expectedPendingSlugs: ReadonlySet<string>,
  expectedCandidateInventoryDigest: SessionSha256Digest | undefined,
  projectId: string,
): void {
  if (
    current.workspace !== initial.workspace ||
    current.profileMode !== initial.profileMode ||
    current.wikiInventoryDigest !== initial.wikiInventoryDigest ||
    stableSnapshotDigest(current) !== stableSnapshotDigest(initial) ||
    !samePendingSlugs(current.pendingSlugs, expectedPendingSlugs) ||
    (expectedCandidateInventoryDigest !== undefined &&
      current.candidateInventoryDigest !== expectedCandidateInventoryDigest)
  ) throw new SessionCompileError('SESSION_PLAN_STALE', projectId);
}

function chunkValidatedBatch(
  batch: Awaited<ReturnType<typeof validateSessionProposalBatch>>,
): readonly Awaited<ReturnType<typeof validateSessionProposalBatch>>[] {
  const chunks = [];
  for (let offset = 0; offset < batch.pages.length;
    offset += SESSION_COMPILE_LIMITS.maxProposalsPerBatch) {
    chunks.push(Object.freeze({
      batchDigest: batch.batchDigest,
      harness: batch.harness,
      pages: Object.freeze(batch.pages.slice(
        offset,
        offset + SESSION_COMPILE_LIMITS.maxProposalsPerBatch,
      )),
    }));
  }
  return Object.freeze(chunks);
}

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
      proposalFiles.length > SESSION_COMPILE_LIMITS.maxApplyProposals ||
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

function candidatesRequest(input: SessionCompileCandidatesRequest): string {
  return planRequest(input);
}

function approveRequest(input: SessionCompileApproveRequest): Readonly<{
  readonly candidateId: string;
  readonly projectId: string;
}> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) ||
      Object.keys(input).sort(compareSessionText).join(',') !== 'candidateId,projectId') {
    throw new SessionCompileError('SESSION_CONTRACT_INVALID', 'unknown');
  }
  const projectId = validProjectId(input.projectId);
  if (typeof input.candidateId !== 'string' ||
      !isGeneratedIdentifier(input.candidateId, 'candidate')) {
    throw new SessionCompileError('SESSION_CANDIDATE_NOT_FOUND', projectId);
  }
  return Object.freeze({ candidateId: input.candidateId, projectId });
}

function createProjectSessionCompilerInternal(
  options: CreateProjectSessionCompilerInternalOptions,
): ProjectSessionCompilerPort {
  const planner = options.planner ?? createSessionCompilePlanner({
    hubRoot: options.hubRoot,
    ...(options.jsonKnowledgeAdapters === undefined
      ? {}
      : { jsonKnowledgeAdapters: options.jsonKnowledgeAdapters }),
    knowledgeRoot: options.knowledgeRoot,
  });
  const admission = options.admission ?? createSessionCompileAdmission();
  const review = options.review ?? createSessionReviewService();
  const profilePreflight = createProfileBindingPreflight(options.knowledgeRoot, {
    registrations: options.jsonKnowledgeAdapters ?? [],
  });
  async function reviewWorkspace(projectId: string): Promise<string> {
    const [record, workspace, profile] = await Promise.all([
      showProject(options.knowledgeRoot, projectId),
      resolveProjectWorkspace(options.knowledgeRoot, projectId, { mustExist: true }),
      profilePreflight.resolve(projectId),
    ]);
    if (record.entry.projectId !== projectId || profile.workspace !== workspace) {
      throw new SessionCompileError('SESSION_CANDIDATE_PROJECT_MISMATCH', projectId);
    }
    return workspace;
  }
  async function plan(input: SessionCompilePlanRequest): Promise<SessionCompilePlanV1> {
    const projectId = planRequest(input);
    return (await planner.create(projectId)).plan;
  }
  async function apply(
    input: SessionCompileApplyRequest,
  ): Promise<SessionCompileApplyResultV2> {
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
      const candidateRefs: string[] = [];
      const expectedPendingSlugs = new Set(snapshot.pendingSlugs);
      let expectedCandidateInventoryDigest = snapshot.candidateInventoryDigest;
      for (const chunk of chunkValidatedBatch(batch)) {
        try {
          const chunkResult = await admission.stage(
            snapshot.workspace,
            request.projectId,
            snapshot.profileMode,
            chunk,
            async () => assertExpectedSnapshot(
              snapshot,
              await planner.create(request.projectId),
              expectedPendingSlugs,
              expectedCandidateInventoryDigest,
              request.projectId,
            ),
          );
          candidateRefs.push(...chunkResult.candidateRefs);
          if (snapshot.profileMode === 'custom') {
            for (const page of chunk.pages) expectedPendingSlugs.add(page.proposal.slug);
            const stagedSnapshot = await planner.create(request.projectId);
            assertExpectedSnapshot(
              snapshot,
              stagedSnapshot,
              expectedPendingSlugs,
              undefined,
              request.projectId,
            );
            expectedCandidateInventoryDigest = stagedSnapshot.candidateInventoryDigest;
          }
        } catch (error) {
          if (candidateRefs.length === 0) throw error;
          const failedRefs = error instanceof SessionCompileError ? error.candidateRefs : [];
          throw new SessionCompileError('SESSION_ADMISSION_FAILED', request.projectId, {
            candidateRefs: [...new Set([...candidateRefs, ...failedRefs])],
            recoveryAction: 'status',
            sideEffectsPossible: true,
          });
        }
      }
      return Object.freeze({
        schemaVersion: SESSION_COMPILE_APPLY_RESULT_SCHEMA_VERSION,
        projectId: request.projectId,
        planDigest: snapshot.plan.planDigest,
        batchDigest: batch.batchDigest,
        outcome: 'staged',
        reviewRequired: true,
        admissionKind: 'buildlore-review',
        admittedCount: batch.pages.length,
        heldCount: batch.pages.length,
        skippedCount: 0,
        candidateRefs: Object.freeze(candidateRefs.sort(compareSessionText)),
        sideEffectsPossible: false,
        recoveryAction: 'review',
        warnings: Object.freeze([]),
      });
    });
  }
  async function candidates(
    input: SessionCompileCandidatesRequest,
  ): Promise<SessionCompileCandidatesResultV1> {
    const projectId = candidatesRequest(input);
    return review.list(await reviewWorkspace(projectId), projectId);
  }
  async function approve(
    input: SessionCompileApproveRequest,
  ): Promise<SessionCompileApproveResultV1> {
    const request = approveRequest(input);
    return applyCoordinator.run(request.projectId, async () => {
      const workspace = await reviewWorkspace(request.projectId);
      return review.approve(
        workspace,
        request.projectId,
        request.candidateId,
        async () => planner.create(request.projectId),
      );
    });
  }
  return Object.freeze({ apply, approve, candidates, plan });
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
