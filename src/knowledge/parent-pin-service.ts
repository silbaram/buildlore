import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { serializeCanonicalJson } from './atomic-file.js';
import { RepositoryWriterError } from './errors.js';
import {
  GitMachineAdapter,
  type GitCachedDiffEntry,
  type GitMachinePort,
  type GitStatusEntry,
} from './git-machine.js';
import { resolveGitCommonDirectory } from './git.js';
import {
  PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION,
  PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION,
  ParentKnowledgePinError,
  type ParentKnowledgePinBlockReason,
  type ParentKnowledgePinInput,
  type ParentKnowledgePinPlan,
  type ParentKnowledgePinPort,
  type ParentKnowledgePinResult,
  type ParentKnowledgePinServiceOptions,
} from './parent-pin-types.js';
import { parseKnowledgeCommitLineage } from './publication-codec.js';
import {
  createGitPublicationInspector,
  type PublicationCommitSnapshot,
  type PublicationInspectionPort,
  type PublicationRepositorySnapshot,
} from './publication-inspection.js';
import type {
  GitObjectId,
  KnowledgeCommitLineageV1,
  PublicationDigest,
} from './publication-types.js';
import {
  createRepositoryWriterLease,
  type RepositoryWriterLease,
  type RepositoryWriterLeasePort,
} from './repository-writer-lease.js';

const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ITERATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_ITERATION_ID_LENGTH = 120;
const KNOWLEDGE_PATH = 'knowledge' as const;
const PARENT_PIN_COMMIT_SCHEMA_VERSION =
  'buildlore.parent-knowledge-pin-commit.v1' as const;

interface NormalizedPinInput {
  readonly intent: 'iteration-close';
  readonly iterationId: string;
  readonly knowledgeRevision: GitObjectId;
}

interface PinComputation {
  readonly knowledgeRepository: PublicationRepositorySnapshot;
  readonly parentRepository: PublicationRepositorySnapshot;
  readonly plan: ParentKnowledgePinPlan;
  readonly remoteProofDigest: PublicationDigest;
  readonly remoteTarget: string | null;
}

interface ParentPinCommitMetadata {
  readonly schemaVersion: typeof PARENT_PIN_COMMIT_SCHEMA_VERSION;
  readonly intent: 'iteration-close';
  readonly iterationId: string;
  readonly path: 'knowledge';
  readonly parentBaseRevision: GitObjectId;
  readonly codeRevision: GitObjectId;
  readonly oldKnowledgeGitlink: GitObjectId;
  readonly newKnowledgeGitlink: GitObjectId;
  readonly projectId: string;
  readonly sourceRevision: GitObjectId;
  readonly knowledgeLineageDigest: PublicationDigest;
  readonly planDigest: PublicationDigest;
}

function sha256(value: Buffer | string): PublicationDigest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeInput(input: ParentKnowledgePinInput): NormalizedPinInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ParentKnowledgePinError('PARENT_PIN_PLAN_DRIFT');
  }
  const value = input as unknown as Readonly<Record<string, unknown>>;
  if (
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'intent') ||
    !Object.hasOwn(value, 'iterationId') ||
    !Object.hasOwn(value, 'knowledgeRevision') ||
    value.intent !== 'iteration-close' ||
    typeof value.iterationId !== 'string' ||
    value.iterationId.length === 0 ||
    value.iterationId.length > MAX_ITERATION_ID_LENGTH ||
    !ITERATION_ID_PATTERN.test(value.iterationId) ||
    typeof value.knowledgeRevision !== 'string'
  ) {
    throw new ParentKnowledgePinError('PARENT_PIN_PLAN_DRIFT');
  }
  const knowledgeRevision = value.knowledgeRevision.toLowerCase();
  if (!OID_PATTERN.test(knowledgeRevision)) {
    throw new ParentKnowledgePinError('PARENT_PIN_PLAN_DRIFT');
  }
  return Object.freeze({
    intent: 'iteration-close',
    iterationId: value.iterationId,
    knowledgeRevision,
  });
}

function normalizeDigest(value: PublicationDigest): PublicationDigest {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ParentKnowledgePinError('PARENT_PIN_PLAN_DRIFT');
  }
  return value;
}

function publicationMessage(lineage: KnowledgeCommitLineageV1): Buffer {
  return Buffer.from(
    `BuildLore knowledge publish: ${lineage.projectId}\n\n${serializeCanonicalJson(lineage)}`,
    'utf8',
  );
}

function pinCommitMessage(metadata: ParentPinCommitMetadata): Buffer {
  return Buffer.from(
    `BuildLore parent knowledge pin: ${metadata.iterationId}\n\n${serializeCanonicalJson(metadata)}`,
    'utf8',
  );
}

function isExpectedUnstagedGitlink(
  entry: GitStatusEntry,
  oldKnowledgeRevision: GitObjectId,
): boolean {
  return entry.kind === 'ordinary' &&
    entry.path === KNOWLEDGE_PATH &&
    entry.indexStatus === '.' &&
    entry.worktreeStatus === 'M' &&
    entry.headMode === '160000' &&
    entry.indexMode === '160000' &&
    entry.worktreeMode === '160000' &&
    entry.headOid === oldKnowledgeRevision &&
    entry.indexOid === oldKnowledgeRevision &&
    entry.submodule.startsWith('S');
}

function isExpectedStagedGitlink(
  entry: GitStatusEntry,
  oldKnowledgeRevision: GitObjectId,
  targetKnowledgeRevision: GitObjectId,
): boolean {
  return entry.kind === 'ordinary' &&
    entry.path === KNOWLEDGE_PATH &&
    entry.indexStatus === 'M' &&
    entry.worktreeStatus === '.' &&
    entry.headMode === '160000' &&
    entry.indexMode === '160000' &&
    entry.worktreeMode === '160000' &&
    entry.headOid === oldKnowledgeRevision &&
    entry.indexOid === targetKnowledgeRevision;
}

function isExactGitlinkDiff(
  entry: GitCachedDiffEntry,
  oldKnowledgeRevision: GitObjectId,
  targetKnowledgeRevision: GitObjectId,
): boolean {
  return entry.path === KNOWLEDGE_PATH &&
    entry.originalPath === undefined &&
    entry.status === 'M' &&
    entry.oldMode === '160000' &&
    entry.newMode === '160000' &&
    entry.oldOid === oldKnowledgeRevision &&
    entry.newOid === targetKnowledgeRevision;
}

function recoveryPlan(input: NormalizedPinInput): readonly string[] {
  return Object.freeze([
    'knowledge',
    'pin',
    'plan',
    '--knowledge-revision',
    input.knowledgeRevision,
    '--iteration',
    input.iterationId,
    '--intent',
    'iteration-close',
  ]);
}

function recoveryInspect(): readonly string[] {
  return Object.freeze(['knowledge', 'status']);
}

function resultIdentity(plan: ParentKnowledgePinPlan): {
  readonly schemaVersion: typeof PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION;
  readonly intent: 'iteration-close';
  readonly iterationId: string;
  readonly path: 'knowledge';
  readonly projectId: string | null;
  readonly sourceRevision: GitObjectId | null;
  readonly parentBaseRevision: GitObjectId;
  readonly codeRevision: GitObjectId;
  readonly oldKnowledgeGitlink: GitObjectId;
  readonly newKnowledgeGitlink: GitObjectId;
  readonly targetRemoteReachability: boolean;
  readonly planDigest: PublicationDigest;
} {
  return {
    schemaVersion: PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION,
    intent: plan.intent,
    iterationId: plan.iterationId,
    path: plan.path,
    projectId: plan.projectId,
    sourceRevision: plan.sourceRevision,
    parentBaseRevision: plan.parentBaseRevision,
    codeRevision: plan.codeRevision,
    oldKnowledgeGitlink: plan.oldKnowledgeGitlink,
    newKnowledgeGitlink: plan.newKnowledgeGitlink,
    targetRemoteReachability: plan.targetRemoteReachability,
    planDigest: plan.planDigest,
  };
}

function blocked(
  plan: ParentKnowledgePinPlan,
  errorCode: Extract<ParentKnowledgePinResult, { readonly state: 'blocked' }>['errorCode'],
  options: {
    readonly partial?: boolean;
    readonly resultingParentCommitSha?: GitObjectId | null;
    readonly recoveryCommand?: readonly string[];
  } = {},
): ParentKnowledgePinResult {
  const partial = options.partial === true;
  const recoveryCommand = options.recoveryCommand ?? (partial ? recoveryInspect() : recoveryPlan({
    intent: plan.intent,
    iterationId: plan.iterationId,
    knowledgeRevision: plan.newKnowledgeGitlink,
  }));
  return Object.freeze({
    ...resultIdentity(plan),
    state: 'blocked',
    errorCode,
    applied: false,
    noOp: false,
    partial,
    resultingParentCommitSha: options.resultingParentCommitSha ?? null,
    recoveryCommand,
  });
}

function noOp(plan: ParentKnowledgePinPlan): ParentKnowledgePinResult {
  return Object.freeze({
    ...resultIdentity(plan),
    state: 'no-op',
    applied: false,
    noOp: true,
    partial: false,
    resultingParentCommitSha: null,
    recoveryCommand: recoveryPlan({
      intent: plan.intent,
      iterationId: plan.iterationId,
      knowledgeRevision: plan.newKnowledgeGitlink,
    }),
  });
}

function applied(
  plan: ParentKnowledgePinPlan,
  parentCommitOid: GitObjectId,
): ParentKnowledgePinResult {
  return Object.freeze({
    ...resultIdentity(plan),
    state: 'applied',
    applied: true,
    noOp: false,
    partial: false,
    resultingParentCommitSha: parentCommitOid,
    recoveryCommand: recoveryPlan({
      intent: plan.intent,
      iterationId: plan.iterationId,
      knowledgeRevision: plan.newKnowledgeGitlink,
    }),
  });
}

function validateLineage(
  commit: PublicationCommitSnapshot,
): KnowledgeCommitLineageV1 {
  const firstLineEnd = commit.message.indexOf(0x0a);
  if (firstLineEnd < 0) throw new ParentKnowledgePinError('PARENT_PIN_INELIGIBLE');
  const firstLine = commit.message.subarray(0, firstLineEnd).toString('utf8');
  const match = /^BuildLore knowledge publish: ([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(firstLine);
  if (match?.[1] === undefined || commit.message[firstLineEnd + 1] !== 0x0a) {
    throw new ParentKnowledgePinError('PARENT_PIN_INELIGIBLE');
  }
  const lineage = parseKnowledgeCommitLineage(commit.message.subarray(firstLineEnd + 2));
  if (
    lineage.projectId !== match[1] ||
    commit.parentRevisions.length !== 1 ||
    commit.parentRevisions[0] !== lineage.knowledgeParentRevision ||
    commit.treeRevision !== lineage.knowledgeTreeRevision ||
    !commit.message.equals(publicationMessage(lineage))
  ) {
    throw new ParentKnowledgePinError('PARENT_PIN_INELIGIBLE');
  }
  return lineage;
}

export class ParentKnowledgePinService implements ParentKnowledgePinPort {
  readonly #git: GitMachinePort;
  readonly #hooks: NonNullable<ParentKnowledgePinServiceOptions['hooks']>;
  readonly #inspector: PublicationInspectionPort;
  readonly #knowledgeRoot: string;
  readonly #lease: RepositoryWriterLeasePort;
  readonly #parentRoot: string;

  constructor(parentRoot: string, options: ParentKnowledgePinServiceOptions = {}) {
    this.#parentRoot = parentRoot;
    this.#knowledgeRoot = join(parentRoot, KNOWLEDGE_PATH);
    this.#git = options.gitMachine ?? new GitMachineAdapter();
    this.#hooks = options.hooks ?? {};
    this.#inspector = options.inspector ?? createGitPublicationInspector();
    this.#lease = options.lease ?? createRepositoryWriterLease();
  }

  async plan(input: ParentKnowledgePinInput): Promise<ParentKnowledgePinPlan> {
    return (await this.#computePlan(normalizeInput(input))).plan;
  }

  async commit(
    input: ParentKnowledgePinInput,
    expectedPlanDigest: PublicationDigest,
  ): Promise<ParentKnowledgePinResult> {
    const normalized = normalizeInput(input);
    const expected = normalizeDigest(expectedPlanDigest);
    const initial = await this.#computePlan(normalized);
    if (initial.plan.planDigest !== expected) {
      return blocked(initial.plan, 'PARENT_PIN_PLAN_DRIFT');
    }
    if (!initial.plan.eligible) {
      return blocked(initial.plan, 'PARENT_PIN_INELIGIBLE');
    }

    let mutationAttempted = false;
    let refUpdated = false;
    let createdCommit: GitObjectId | null = null;
    try {
      return await this.#withDualLeases(async (parentLease, knowledgeLease) => {
        await parentLease.updatePhase('parent-pin-revalidate');
        await knowledgeLease.updatePhase('parent-pin-revalidate');
        const fresh = await this.#computePlan(normalized);
        if (
          !fresh.plan.eligible ||
          fresh.plan.planDigest !== expected ||
          fresh.remoteTarget !== initial.remoteTarget
        ) {
          return blocked(fresh.plan, 'PARENT_PIN_PLAN_DRIFT');
        }
        if (fresh.plan.noOp) return noOp(fresh.plan);

        try {
          await this.#hooks.beforeAdd?.();
          const beforeAdd = await this.#computePlan(normalized);
          if (
            !beforeAdd.plan.eligible ||
            beforeAdd.plan.planDigest !== expected ||
            beforeAdd.remoteTarget !== fresh.remoteTarget
          ) {
            return blocked(beforeAdd.plan, 'PARENT_PIN_PLAN_DRIFT');
          }

          await parentLease.updatePhase('parent-pin-stage');
          mutationAttempted = true;
          await this.#git.addExact(this.#parentRoot, [KNOWLEDGE_PATH]);
          await this.#hooks.afterAdd?.();
          const cached = await this.#git.cachedDiff(this.#parentRoot);
          if (
            cached.length !== 1 ||
            cached[0] === undefined ||
            !isExactGitlinkDiff(
              cached[0],
              beforeAdd.plan.oldKnowledgeGitlink,
              beforeAdd.plan.newKnowledgeGitlink,
            )
          ) {
            throw new ParentKnowledgePinError('PARENT_PIN_PARTIAL', true);
          }
          await this.#assertStagedState(beforeAdd);
          await this.#hooks.afterCachedValidation?.();

          await parentLease.updatePhase('parent-pin-write-tree');
          const treeOid = await this.#git.writeTree(this.#parentRoot);
          await this.#hooks.afterWriteTree?.(treeOid);
          const message = pinCommitMessage(this.#commitMetadata(beforeAdd.plan));

          await parentLease.updatePhase('parent-pin-commit-tree');
          createdCommit = await this.#git.commitTree(
            this.#parentRoot,
            treeOid,
            [beforeAdd.plan.parentBaseRevision],
            message,
          );
          await this.#hooks.afterCommitTree?.(createdCommit);
          await this.#hooks.beforeUpdateRef?.(createdCommit);
          await this.#assertStagedState(beforeAdd);

          await parentLease.updatePhase('parent-pin-update-ref');
          await this.#git.updateRefCompareAndSwap(
            this.#parentRoot,
            beforeAdd.parentRepository.branchRef,
            createdCommit,
            beforeAdd.plan.parentBaseRevision,
          );
          refUpdated = true;

          await this.#hooks.beforePostVerify?.(createdCommit);
          await parentLease.updatePhase('parent-pin-postverify');
          await this.#postVerify(beforeAdd, treeOid, createdCommit, message);
          return applied(beforeAdd.plan, createdCommit);
        } catch (error) {
          if (error instanceof ParentKnowledgePinError) {
            const errorCode = refUpdated
              ? 'PARENT_PIN_POSTVERIFY_FAILED'
              : mutationAttempted ? 'PARENT_PIN_PARTIAL' : error.code;
            return blocked(fresh.plan, errorCode, {
              partial: mutationAttempted || error.partial,
              resultingParentCommitSha: refUpdated ? createdCommit : null,
              ...(refUpdated ? { recoveryCommand: recoveryPlan(normalized) } : {}),
            });
          }
          return blocked(fresh.plan, refUpdated
            ? 'PARENT_PIN_POSTVERIFY_FAILED'
            : mutationAttempted ? 'PARENT_PIN_PARTIAL' : 'PARENT_PIN_TRANSACTION_FAILED', {
            partial: mutationAttempted,
            resultingParentCommitSha: refUpdated ? createdCommit : null,
            ...(refUpdated ? { recoveryCommand: recoveryPlan(normalized) } : {}),
          });
        }
      });
    } catch (error) {
      if (error instanceof RepositoryWriterError && error.code === 'REPOSITORY_BUSY') {
        return blocked(initial.plan, 'PARENT_PIN_REPOSITORY_BUSY');
      }
      return blocked(initial.plan, refUpdated
        ? 'PARENT_PIN_POSTVERIFY_FAILED'
        : mutationAttempted ? 'PARENT_PIN_PARTIAL' : 'PARENT_PIN_TRANSACTION_FAILED', {
        partial: mutationAttempted,
        resultingParentCommitSha: refUpdated ? createdCommit : null,
        ...(refUpdated ? { recoveryCommand: recoveryPlan(normalized) } : {}),
      });
    }
  }

  async #computePlan(input: NormalizedPinInput): Promise<PinComputation> {
    const [parentRepository, knowledgeRepository] = await Promise.all([
      this.#inspector.inspectRepository(this.#parentRoot),
      this.#inspector.inspectRepository(this.#knowledgeRoot),
    ]);
    const [parentStatus, knowledgeStatus, parentCached] = await Promise.all([
      this.#git.status(this.#parentRoot),
      this.#git.status(this.#knowledgeRoot),
      this.#git.cachedDiff(this.#parentRoot),
    ]);
    const gitlinkEntries = parentRepository.indexEntries.filter((entry) =>
      entry.path === KNOWLEDGE_PATH);
    const gitlink = gitlinkEntries[0];
    if (
      gitlinkEntries.length !== 1 ||
      gitlink === undefined ||
      gitlink.mode !== '160000' ||
      gitlink.stage !== 0 ||
      !OID_PATTERN.test(gitlink.oid)
    ) {
      throw new ParentKnowledgePinError('PARENT_PIN_INELIGIBLE');
    }

    const oldKnowledgeGitlink = gitlink.oid;
    const noOpValue = oldKnowledgeGitlink === input.knowledgeRevision;
    const reasons = new Set<ParentKnowledgePinBlockReason>();
    if (knowledgeRepository.baseRevision !== input.knowledgeRevision) {
      reasons.add('KNOWLEDGE_HEAD_MISMATCH');
    }
    if (knowledgeStatus.length !== 0) reasons.add('KNOWLEDGE_DIRTY');
    if (parentCached.length !== 0) reasons.add('PARENT_DIRTY');
    if (noOpValue) {
      if (parentStatus.length !== 0) reasons.add('PARENT_DIRTY');
    } else if (
      parentStatus.length !== 1 ||
      parentStatus[0] === undefined ||
      !isExpectedUnstagedGitlink(parentStatus[0], oldKnowledgeGitlink)
    ) {
      reasons.add('PARENT_DIRTY');
    }

    let lineage: KnowledgeCommitLineageV1 | null = null;
    let lineageDigest: PublicationDigest | null = null;
    try {
      const commit = await this.#inspector.inspectCommit(
        this.#knowledgeRoot,
        input.knowledgeRevision,
      );
      lineage = validateLineage(commit);
      lineageDigest = sha256(serializeCanonicalJson(lineage));
    } catch {
      reasons.add('KNOWLEDGE_LINEAGE_INVALID');
    }
    if (lineage !== null && !noOpValue && lineage.codeRevision !== parentRepository.baseRevision) {
      reasons.add('PARENT_CODE_MISMATCH');
    }

    let targetRemoteReachability = false;
    let remoteProofDigest = sha256('unverified');
    let remoteTarget: string | null = null;
    try {
      const configuration = await this.#inspector.inspectPushConfiguration(
        this.#knowledgeRoot,
        knowledgeRepository.branchRef,
      );
      remoteTarget = configuration.effectivePushTarget;
      const proof = await this.#git.proveRemoteReachability(
        this.#knowledgeRoot,
        configuration.effectivePushTarget,
        configuration.branchRef,
        input.knowledgeRevision,
      );
      const remoteRevision = proof.remoteRevision;
      if (remoteRevision === null) {
        reasons.add('KNOWLEDGE_REMOTE_MISSING');
        remoteProofDigest = sha256(serializeCanonicalJson({
          branchRefDigest: sha256(configuration.branchRef),
          remoteAliasDigest: sha256(configuration.remoteAlias),
          remoteRevision: null,
        }));
      } else {
        targetRemoteReachability = proof.targetReachable;
        if (!targetRemoteReachability) reasons.add('KNOWLEDGE_REMOTE_UNREACHABLE');
        remoteProofDigest = sha256(serializeCanonicalJson({
          branchRefDigest: sha256(configuration.branchRef),
          remoteAliasDigest: sha256(configuration.remoteAlias),
          remoteRevision,
        }));
      }
    } catch {
      reasons.add('KNOWLEDGE_REMOTE_UNREADABLE');
    }

    const blockReasons = Object.freeze([...reasons].sort());
    const base = {
      schemaVersion: PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION,
      intent: input.intent,
      iterationId: input.iterationId,
      path: KNOWLEDGE_PATH,
      parentRepositoryIdentityDigest: parentRepository.repositoryIdentityDigest,
      knowledgeRepositoryIdentityDigest: knowledgeRepository.repositoryIdentityDigest,
      parentBaseRevision: parentRepository.baseRevision,
      codeRevision: lineage?.codeRevision ?? parentRepository.baseRevision,
      oldKnowledgeGitlink,
      newKnowledgeGitlink: input.knowledgeRevision,
      projectId: lineage?.projectId ?? null,
      sourceRevision: lineage?.sourceRevision ?? null,
      lineageDigest,
      targetRemoteReachability,
      noOp: noOpValue,
      eligible: blockReasons.length === 0,
      blockReasons,
    };
    const planDigest = sha256(serializeCanonicalJson({
      ...base,
      parentBranchRefDigest: sha256(parentRepository.branchRef),
      parentIndexSnapshotDigest: parentRepository.indexSnapshotDigest,
      parentStatus,
      knowledgeBranchRefDigest: sha256(knowledgeRepository.branchRef),
      knowledgeIndexSnapshotDigest: knowledgeRepository.indexSnapshotDigest,
      knowledgeStatus,
      remoteProofDigest,
    }));
    return {
      parentRepository,
      knowledgeRepository,
      remoteProofDigest,
      remoteTarget,
      plan: Object.freeze({ ...base, planDigest }),
    };
  }

  #commitMetadata(computationPlan: ParentKnowledgePinPlan): ParentPinCommitMetadata {
    if (
      computationPlan.projectId === null ||
      computationPlan.sourceRevision === null ||
      computationPlan.lineageDigest === null
    ) {
      throw new ParentKnowledgePinError('PARENT_PIN_PLAN_DRIFT');
    }
    return Object.freeze({
      schemaVersion: PARENT_PIN_COMMIT_SCHEMA_VERSION,
      intent: computationPlan.intent,
      iterationId: computationPlan.iterationId,
      path: KNOWLEDGE_PATH,
      parentBaseRevision: computationPlan.parentBaseRevision,
      codeRevision: computationPlan.codeRevision,
      oldKnowledgeGitlink: computationPlan.oldKnowledgeGitlink,
      newKnowledgeGitlink: computationPlan.newKnowledgeGitlink,
      projectId: computationPlan.projectId,
      sourceRevision: computationPlan.sourceRevision,
      knowledgeLineageDigest: computationPlan.lineageDigest,
      planDigest: computationPlan.planDigest,
    });
  }

  async #assertStagedState(computation: PinComputation): Promise<void> {
    const [parentRepository, knowledgeRepository, parentStatus, knowledgeStatus, cached] =
      await Promise.all([
        this.#inspector.inspectRepository(this.#parentRoot),
        this.#inspector.inspectRepository(this.#knowledgeRoot),
        this.#git.status(this.#parentRoot),
        this.#git.status(this.#knowledgeRoot),
        this.#git.cachedDiff(this.#parentRoot),
      ]);
    const gitlink = parentRepository.indexEntries.filter((entry) =>
      entry.path === KNOWLEDGE_PATH);
    if (
      parentRepository.baseRevision !== computation.plan.parentBaseRevision ||
      parentRepository.branchRef !== computation.parentRepository.branchRef ||
      parentRepository.repositoryIdentityDigest !==
        computation.plan.parentRepositoryIdentityDigest ||
      knowledgeRepository.baseRevision !== computation.plan.newKnowledgeGitlink ||
      knowledgeRepository.branchRef !== computation.knowledgeRepository.branchRef ||
      knowledgeRepository.repositoryIdentityDigest !==
        computation.plan.knowledgeRepositoryIdentityDigest ||
      knowledgeStatus.length !== 0 ||
      parentStatus.length !== 1 ||
      parentStatus[0] === undefined ||
      !isExpectedStagedGitlink(
        parentStatus[0],
        computation.plan.oldKnowledgeGitlink,
        computation.plan.newKnowledgeGitlink,
      ) ||
      cached.length !== 1 ||
      cached[0] === undefined ||
      !isExactGitlinkDiff(
        cached[0],
        computation.plan.oldKnowledgeGitlink,
        computation.plan.newKnowledgeGitlink,
      ) ||
      gitlink.length !== 1 ||
      gitlink[0]?.mode !== '160000' ||
      gitlink[0]?.stage !== 0 ||
      gitlink[0]?.oid !== computation.plan.newKnowledgeGitlink
    ) {
      throw new ParentKnowledgePinError('PARENT_PIN_PARTIAL', true);
    }
  }

  async #postVerify(
    computation: PinComputation,
    expectedTreeOid: GitObjectId,
    parentCommitOid: GitObjectId,
    expectedMessage: Buffer,
  ): Promise<void> {
    const [parentRepository, knowledgeRepository, parentCommit, parentStatus, knowledgeStatus,
      cached] = await Promise.all([
      this.#inspector.inspectRepository(this.#parentRoot),
      this.#inspector.inspectRepository(this.#knowledgeRoot),
      this.#inspector.inspectCommit(this.#parentRoot, parentCommitOid),
      this.#git.status(this.#parentRoot),
      this.#git.status(this.#knowledgeRoot),
      this.#git.cachedDiff(this.#parentRoot),
    ]);
    const gitlinks = parentRepository.indexEntries.filter((entry) =>
      entry.path === KNOWLEDGE_PATH);
    const diff = parentCommit.diffEntries[0];
    if (
      parentRepository.baseRevision !== parentCommitOid ||
      parentRepository.branchRef !== computation.parentRepository.branchRef ||
      parentRepository.repositoryIdentityDigest !==
        computation.plan.parentRepositoryIdentityDigest ||
      knowledgeRepository.baseRevision !== computation.plan.newKnowledgeGitlink ||
      knowledgeRepository.branchRef !== computation.knowledgeRepository.branchRef ||
      knowledgeRepository.repositoryIdentityDigest !==
        computation.plan.knowledgeRepositoryIdentityDigest ||
      parentStatus.length !== 0 ||
      knowledgeStatus.length !== 0 ||
      cached.length !== 0 ||
      gitlinks.length !== 1 ||
      gitlinks[0]?.mode !== '160000' ||
      gitlinks[0]?.stage !== 0 ||
      gitlinks[0]?.oid !== computation.plan.newKnowledgeGitlink ||
      parentCommit.treeRevision !== expectedTreeOid ||
      parentCommit.parentRevisions.length !== 1 ||
      parentCommit.parentRevisions[0] !== computation.plan.parentBaseRevision ||
      parentCommit.changedPaths.length !== 1 ||
      parentCommit.changedPaths[0] !== KNOWLEDGE_PATH ||
      parentCommit.diffEntries.length !== 1 ||
      diff === undefined ||
      !isExactGitlinkDiff(
        diff,
        computation.plan.oldKnowledgeGitlink,
        computation.plan.newKnowledgeGitlink,
      ) ||
      !parentCommit.message.equals(expectedMessage)
    ) {
      throw new ParentKnowledgePinError('PARENT_PIN_POSTVERIFY_FAILED', true);
    }
  }

  async #withDualLeases<T>(
    action: (
      parentLease: RepositoryWriterLease,
      knowledgeLease: RepositoryWriterLease,
    ) => Promise<T>,
  ): Promise<T> {
    const [parentCommon, knowledgeCommon] = await Promise.all([
      resolveGitCommonDirectory(this.#parentRoot),
      resolveGitCommonDirectory(this.#knowledgeRoot),
    ]);
    if (parentCommon === knowledgeCommon) {
      throw new ParentKnowledgePinError('PARENT_PIN_TRANSACTION_FAILED');
    }
    const parentFirst = parentCommon < knowledgeCommon;
    const firstRoot = parentFirst ? this.#parentRoot : this.#knowledgeRoot;
    const secondRoot = parentFirst ? this.#knowledgeRoot : this.#parentRoot;
    return this.#lease.withLease(firstRoot, 'parent-pin', (firstLease) =>
      this.#lease.withLease(secondRoot, 'parent-pin', (secondLease) =>
        parentFirst
          ? action(firstLease, secondLease)
          : action(secondLease, firstLease)));
  }
}

export function createParentKnowledgePinService(
  parentRoot: string,
  options: ParentKnowledgePinServiceOptions = {},
): ParentKnowledgePinPort {
  return new ParentKnowledgePinService(parentRoot, options);
}
