import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from './atomic-file.js';
import { RepositoryWriterError } from './errors.js';
import { GitMachineAdapter, type GitMachinePort, type GitStatusEntry } from './git-machine.js';
import {
  createGitPublicationInspector,
  type PublicationCommitSnapshot,
  type PublicationInspectionPort,
  type PublicationReferenceSnapshot,
  type PublicationRepositorySnapshot,
} from './publication-inspection.js';
import { parseKnowledgeCommitLineage, renderKnowledgeCommitLineageJson } from './publication-codec.js';
import {
  KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
  PublicationError,
  type GitObjectId,
  type KnowledgeCommitLineageV1,
  type KnowledgePublishPushInput,
  type KnowledgePublishResult,
  type PublicationBlobPolicyPort,
  type PublicationDigest,
  type PublicationFailureCode,
  type PublicationFaultHooks,
  type PublishForeignCounts,
  type PublishPathStatus,
} from './publication-types.js';
import { createPublicationBlobPolicy, verifyCanonicalManifestRegistration } from './publication-validation.js';
import {
  createRepositoryWriterLease,
  type RepositoryWriterLeasePort,
} from './repository-writer-lease.js';
import { classifyTrackingPath, KNOWLEDGE_TRACKING_POLICY } from './tracking-policy.js';
import {
  LLM_WIKI_COMPILER_INTEGRITY,
  LLM_WIKI_COMPILER_PACKAGE,
  LLM_WIKI_COMPILER_VERSION,
  type CompilerPackageIdentity,
} from './tracking-types.js';
import { validateProjectId } from './validation.js';
import { showProject } from './workspace.js';

const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const packageIdentity: CompilerPackageIdentity = Object.freeze({
  exactVersion: LLM_WIKI_COMPILER_VERSION,
  packageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
  upstreamPackage: LLM_WIKI_COMPILER_PACKAGE,
});

interface NormalizedPushInput {
  readonly knowledgeRevision: GitObjectId;
  readonly projectId: string;
}

interface VerifiedPublicationCommit {
  readonly baseRevision: GitObjectId;
  readonly branchRef: string;
  readonly foreignCounts: PublishForeignCounts;
  readonly knowledgeRevision: GitObjectId;
  readonly lineage: KnowledgeCommitLineageV1;
  readonly localStateDigest: PublicationDigest;
  readonly projectId: string;
  readonly stagedPaths: readonly string[];
  readonly treeRevision: GitObjectId;
}

export interface KnowledgePublicationPushOptions {
  readonly blobPolicy?: PublicationBlobPolicyPort;
  readonly gitMachine?: GitMachinePort;
  readonly hooks?: PublicationFaultHooks;
  readonly inspector?: PublicationInspectionPort;
  readonly lease?: RepositoryWriterLeasePort;
}

function sha256(value: Buffer | string): PublicationDigest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeOid(value: unknown): GitObjectId {
  if (typeof value !== 'string') throw new PublicationError('PUBLISH_COMMIT_INVALID');
  const normalized = value.toLowerCase();
  if (!OID_PATTERN.test(normalized)) throw new PublicationError('PUBLISH_COMMIT_INVALID');
  return normalized;
}

function normalizeInput(input: KnowledgePublishPushInput): NormalizedPushInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PublicationError('PUBLISH_COMMIT_INVALID');
  }
  const value = input as unknown as Readonly<Record<string, unknown>>;
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('knowledgeRevision') ||
    !keys.includes('projectId') ||
    typeof value.projectId !== 'string'
  ) {
    throw new PublicationError('PUBLISH_COMMIT_INVALID');
  }
  return {
    knowledgeRevision: normalizeOid(value.knowledgeRevision),
    projectId: validateProjectId(value.projectId),
  };
}

function statusCounts(status: readonly GitStatusEntry[]): PublishForeignCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const entry of status) {
    if (entry.kind === 'ignored') continue;
    if (entry.kind === 'untracked') {
      untracked += 1;
      continue;
    }
    if (entry.indexStatus !== '.') staged += 1;
    if (entry.worktreeStatus !== '.') unstaged += 1;
  }
  return { staged, unstaged, untracked };
}

function safeRecovery(input: NormalizedPushInput): readonly string[] {
  return Object.freeze([
    'publish',
    'push',
    '--project',
    input.projectId,
    '--knowledge-revision',
    input.knowledgeRevision,
  ]);
}

function blocked(
  input: NormalizedPushInput,
  context: VerifiedPublicationCommit | null,
  baseRevision: GitObjectId,
  errorCode: Exclude<PublicationFailureCode, 'PUBLISH_PUSH_FAILED'>,
  remoteRevision: GitObjectId | null = null,
  partial = false,
  localCommitPreserved = true,
): KnowledgePublishResult {
  return Object.freeze({
    schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
    state: 'blocked',
    projectId: input.projectId,
    baseRevision: context?.baseRevision ?? baseRevision,
    errorCode,
    foreignCounts: context?.foreignCounts ?? { staged: 0, unstaged: 0, untracked: 0 },
    knowledgeRevision: input.knowledgeRevision,
    localCommitPreserved,
    partial,
    pinRequired: true,
    recoveryCommand: safeRecovery(input),
    remoteRevision,
    stagedPaths: context?.stagedPaths ?? Object.freeze([]),
    treeRevision: context?.treeRevision ?? null,
    warnings: Object.freeze([]),
  });
}

function pushed(
  input: NormalizedPushInput,
  context: VerifiedPublicationCommit,
  warnings: readonly string[] = [],
): KnowledgePublishResult {
  return Object.freeze({
    schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
    state: 'pushed',
    projectId: input.projectId,
    baseRevision: context.baseRevision,
    foreignCounts: context.foreignCounts,
    knowledgeRevision: input.knowledgeRevision,
    localCommitPreserved: true,
    partial: false,
    pinRequired: true,
    recoveryCommand: Object.freeze(['knowledge', 'status']),
    remoteRevision: input.knowledgeRevision,
    stagedPaths: context.stagedPaths,
    treeRevision: context.treeRevision,
    warnings: Object.freeze([...warnings]),
  });
}

function pushFailed(
  input: NormalizedPushInput,
  context: VerifiedPublicationCommit,
  observedRemoteRevision: GitObjectId,
  warnings: readonly string[] = [],
): KnowledgePublishResult {
  return Object.freeze({
    schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
    state: 'push-failed',
    projectId: input.projectId,
    baseRevision: context.baseRevision,
    errorCode: 'PUBLISH_PUSH_FAILED',
    foreignCounts: context.foreignCounts,
    knowledgeRevision: input.knowledgeRevision,
    localCommitPreserved: true,
    partial: true,
    pinRequired: true,
    recoveryCommand: safeRecovery(input),
    remoteRevision: observedRemoteRevision,
    stagedPaths: context.stagedPaths,
    treeRevision: context.treeRevision,
    warnings: Object.freeze([...warnings]),
  });
}

function publicationMessage(lineage: KnowledgeCommitLineageV1): Buffer {
  return Buffer.from(
    `BuildLore knowledge publish: ${lineage.projectId}\n\n${renderKnowledgeCommitLineageJson(lineage)}`,
    'utf8',
  );
}

function pathStatus(status: string): PublishPathStatus | null {
  if (status === 'A') return 'added';
  if (status === 'M') return 'modified';
  if (status === 'D') return 'deleted';
  return null;
}

function validSuccessfulPushReferenceTransition(
  before: PublicationReferenceSnapshot,
  after: PublicationReferenceSnapshot,
  remoteAlias: string,
  branchRef: string,
  targetRevision: GitObjectId,
): boolean {
  if (before.fetchHeadDigest !== after.fetchHeadDigest) return false;
  const expectedTrackingRef = `refs/remotes/${remoteAlias}/${branchRef.slice('refs/heads/'.length)}`;
  const beforeRefs = new Map(before.trackingRefs.map((entry) => [entry.ref, entry]));
  const afterRefs = new Map(after.trackingRefs.map((entry) => [entry.ref, entry]));
  const refs = new Set([...beforeRefs.keys(), ...afterRefs.keys()]);
  const beforeExpected = beforeRefs.get(expectedTrackingRef);
  const afterExpected = afterRefs.get(expectedTrackingRef);
  for (const ref of refs) {
    const beforeEntry = beforeRefs.get(ref);
    const afterEntry = afterRefs.get(ref);
    if (ref !== expectedTrackingRef) {
      if (
        beforeEntry?.symbolicTarget === expectedTrackingRef &&
        afterEntry?.symbolicTarget === expectedTrackingRef
      ) {
        if (
          beforeEntry.oid !== beforeExpected?.oid ||
          afterEntry.oid !== afterExpected?.oid
        ) return false;
        continue;
      }
      if (
        beforeEntry?.oid !== afterEntry?.oid ||
        beforeEntry?.symbolicTarget !== afterEntry?.symbolicTarget
      ) return false;
      continue;
    }
    if (
      beforeEntry?.symbolicTarget !== afterEntry?.symbolicTarget ||
      (afterEntry?.oid !== beforeEntry?.oid && afterEntry?.oid !== targetRevision)
    ) return false;
  }
  return true;
}

export class KnowledgePublicationPushService {
  readonly #blobPolicy: PublicationBlobPolicyPort;
  readonly #git: GitMachinePort;
  readonly #hooks: PublicationFaultHooks;
  readonly #inspector: PublicationInspectionPort;
  readonly #knowledgeRoot: string;
  readonly #lease: RepositoryWriterLeasePort;

  constructor(knowledgeRoot: string, options: KnowledgePublicationPushOptions = {}) {
    this.#knowledgeRoot = knowledgeRoot;
    this.#git = options.gitMachine ?? new GitMachineAdapter();
    this.#hooks = options.hooks ?? {};
    this.#inspector = options.inspector ?? createGitPublicationInspector();
    this.#lease = options.lease ?? createRepositoryWriterLease();
    this.#blobPolicy = options.blobPolicy ?? createPublicationBlobPolicy(knowledgeRoot);
  }

  async push(input: KnowledgePublishPushInput): Promise<KnowledgePublishResult> {
    const normalized = normalizeInput(input);
    let repository: PublicationRepositorySnapshot;
    try {
      await showProject(this.#knowledgeRoot, normalized.projectId);
      repository = await this.#inspector.inspectRepository(this.#knowledgeRoot);
    } catch {
      throw new PublicationError('PUBLISH_REPOSITORY_DRIFT');
    }
    let initial: VerifiedPublicationCommit;
    try {
      initial = await this.#verifyLocalCommit(normalized);
    } catch {
      return blocked(
        normalized,
        null,
        repository.baseRevision,
        'PUBLISH_COMMIT_INVALID',
        null,
        false,
        repository.baseRevision === normalized.knowledgeRevision,
      );
    }

    try {
      return await this.#lease.withLease(this.#knowledgeRoot, 'push', async (lease) => {
        await lease.updatePhase('verify-local');
        let fresh: VerifiedPublicationCommit;
        try {
          fresh = await this.#verifyLocalCommit(normalized);
        } catch {
          return blocked(
            normalized,
            initial,
            repository.baseRevision,
            'PUBLISH_REPOSITORY_DRIFT',
          );
        }
        if (fresh.localStateDigest !== initial.localStateDigest) {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REPOSITORY_DRIFT',
          );
        }

        let configuration;
        try {
          configuration = await this.#inspector.inspectPushConfiguration(
            this.#knowledgeRoot,
            fresh.branchRef,
          );
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REMOTE_UNREADABLE',
          );
        }
        let referenceBefore;
        try {
          referenceBefore = await this.#inspector.inspectReferenceSnapshot(this.#knowledgeRoot);
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REFERENCE_DRIFT',
          );
        }
        let oldRemoteRevision: GitObjectId | null;
        try {
          await lease.updatePhase('inspect-remote');
          oldRemoteRevision = await this.#git.lsRemoteExact(
            this.#knowledgeRoot,
            configuration.remoteAlias,
            configuration.branchRef,
          );
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REMOTE_UNREADABLE',
          );
        }
        if (oldRemoteRevision === null) {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REMOTE_MISSING',
          );
        }
        if (oldRemoteRevision === normalized.knowledgeRevision) {
          let localAfter;
          try {
            localAfter = await this.#verifyLocalCommit(normalized);
          } catch {
            return blocked(
              normalized,
              fresh,
              repository.baseRevision,
              'PUBLISH_REPOSITORY_DRIFT',
              oldRemoteRevision,
            );
          }
          let referenceAfter;
          try {
            referenceAfter = await this.#inspector.inspectReferenceSnapshot(this.#knowledgeRoot);
          } catch {
            return blocked(
              normalized,
              fresh,
              repository.baseRevision,
              'PUBLISH_REFERENCE_DRIFT',
              oldRemoteRevision,
            );
          }
          if (localAfter.localStateDigest !== fresh.localStateDigest) {
            return blocked(
              normalized,
              fresh,
              repository.baseRevision,
              'PUBLISH_REPOSITORY_DRIFT',
              oldRemoteRevision,
            );
          }
          if (referenceAfter.digest !== referenceBefore.digest) {
            return blocked(
              normalized,
              fresh,
              repository.baseRevision,
              'PUBLISH_REFERENCE_DRIFT',
              oldRemoteRevision,
            );
          }
          return pushed(normalized, fresh, ['REMOTE_ALREADY_EQUAL']);
        }

        try {
          await lease.updatePhase('fetch-object');
          await this.#git.fetchObjectNoRefUpdate(
            this.#knowledgeRoot,
            configuration.remoteAlias,
            oldRemoteRevision,
          );
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REMOTE_UNREADABLE',
            oldRemoteRevision,
          );
        }
        let referenceAfterFetch;
        try {
          referenceAfterFetch = await this.#inspector.inspectReferenceSnapshot(this.#knowledgeRoot);
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REFERENCE_DRIFT',
            oldRemoteRevision,
          );
        }
        if (referenceAfterFetch.digest !== referenceBefore.digest) {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REFERENCE_DRIFT',
            oldRemoteRevision,
          );
        }

        let fastForward: boolean;
        try {
          fastForward = await this.#git.isAncestor(
            this.#knowledgeRoot,
            oldRemoteRevision,
            normalized.knowledgeRevision,
          );
          if (!fastForward) {
            const remoteAhead = await this.#git.isAncestor(
              this.#knowledgeRoot,
              normalized.knowledgeRevision,
              oldRemoteRevision,
            );
            return blocked(
              normalized,
              fresh,
              repository.baseRevision,
              remoteAhead ? 'PUBLISH_REMOTE_AHEAD' : 'PUBLISH_REMOTE_DIVERGED',
              oldRemoteRevision,
            );
          }
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REMOTE_UNREADABLE',
            oldRemoteRevision,
          );
        }

        try {
          await this.#hooks.beforePush?.(oldRemoteRevision);
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REMOTE_RACE',
            oldRemoteRevision,
          );
        }
        let beforePushLocal;
        try {
          beforePushLocal = await this.#verifyLocalCommit(normalized);
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REPOSITORY_DRIFT',
            oldRemoteRevision,
          );
        }
        let beforePushRemote: GitObjectId | null;
        try {
          beforePushRemote = await this.#git.lsRemoteExact(
            this.#knowledgeRoot,
            configuration.remoteAlias,
            configuration.branchRef,
          );
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REMOTE_UNREADABLE',
            oldRemoteRevision,
          );
        }
        let beforePushReference;
        try {
          beforePushReference = await this.#inspector.inspectReferenceSnapshot(this.#knowledgeRoot);
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REFERENCE_DRIFT',
            oldRemoteRevision,
          );
        }
        if (
          beforePushLocal.localStateDigest !== fresh.localStateDigest ||
          beforePushRemote !== oldRemoteRevision ||
          beforePushReference.digest !== referenceBefore.digest
        ) {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REMOTE_RACE',
            beforePushRemote,
          );
        }

        await lease.updatePhase('push');
        try {
          await this.#git.pushExactNonForce(
            this.#knowledgeRoot,
            configuration.remoteAlias,
            normalized.knowledgeRevision,
            configuration.branchRef,
          );
        } catch {
          let localAfterFailure;
          try {
            localAfterFailure = await this.#verifyLocalCommit(normalized);
          } catch {
            return blocked(
              normalized,
              fresh,
              repository.baseRevision,
              'PUBLISH_REPOSITORY_DRIFT',
              oldRemoteRevision,
              true,
              false,
            );
          }
          if (localAfterFailure.localStateDigest !== fresh.localStateDigest) {
            return blocked(
              normalized,
              fresh,
              repository.baseRevision,
              'PUBLISH_REPOSITORY_DRIFT',
              oldRemoteRevision,
              true,
              false,
            );
          }
          let referenceWarnings: readonly string[] = [];
          try {
            const referenceAfterFailure = await this.#inspector.inspectReferenceSnapshot(
              this.#knowledgeRoot,
            );
            if (referenceAfterFailure.digest !== referenceBefore.digest) {
              referenceWarnings = ['REFERENCE_STATE_DRIFT_AFTER_PUSH_FAILURE'];
            }
          } catch {
            referenceWarnings = ['REFERENCE_STATE_UNVERIFIED_AFTER_PUSH_FAILURE'];
          }
          let liveRemote: GitObjectId | null;
          try {
            liveRemote = await this.#git.lsRemoteExact(
              this.#knowledgeRoot,
              configuration.remoteAlias,
              configuration.branchRef,
            );
          } catch {
            return pushFailed(normalized, fresh, oldRemoteRevision, referenceWarnings);
          }
          if (liveRemote === normalized.knowledgeRevision) {
            return pushed(normalized, fresh, ['REMOTE_CONFIRMED_AFTER_TRANSPORT_FAILURE']);
          }
          return pushFailed(
            normalized,
            fresh,
            liveRemote ?? oldRemoteRevision,
            referenceWarnings,
          );
        }

        let localAfterPush: VerifiedPublicationCommit;
        try {
          localAfterPush = await this.#verifyLocalCommit(normalized);
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REPOSITORY_DRIFT',
            null,
            true,
            false,
          );
        }
        if (localAfterPush.localStateDigest !== fresh.localStateDigest) {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REPOSITORY_DRIFT',
            null,
            true,
            false,
          );
        }
        let finalRemote: GitObjectId | null;
        let referenceAfterPush: PublicationReferenceSnapshot;
        try {
          [finalRemote, referenceAfterPush] = await Promise.all([
            this.#git.lsRemoteExact(
              this.#knowledgeRoot,
              configuration.remoteAlias,
              configuration.branchRef,
            ),
            this.#inspector.inspectReferenceSnapshot(this.#knowledgeRoot),
          ]);
        } catch {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REMOTE_UNREADABLE',
            null,
            true,
          );
        }
        if (!validSuccessfulPushReferenceTransition(
          referenceBefore,
          referenceAfterPush,
          configuration.remoteAlias,
          configuration.branchRef,
          normalized.knowledgeRevision,
        )) {
          return blocked(
            normalized,
            fresh,
            repository.baseRevision,
            'PUBLISH_REFERENCE_DRIFT',
            finalRemote,
            true,
          );
        }
        if (finalRemote === normalized.knowledgeRevision) return pushed(normalized, fresh);
        if (finalRemote === oldRemoteRevision) {
          return pushFailed(normalized, fresh, oldRemoteRevision);
        }
        return blocked(
          normalized,
          fresh,
          repository.baseRevision,
          'PUBLISH_REMOTE_RACE',
          finalRemote,
          true,
        );
      });
    } catch (error) {
      if (error instanceof RepositoryWriterError && error.code === 'REPOSITORY_BUSY') {
        return blocked(
          normalized,
          initial,
          repository.baseRevision,
          'PUBLISH_REPOSITORY_BUSY',
        );
      }
      throw error;
    }
  }

  async #verifyLocalCommit(
    input: NormalizedPushInput,
  ): Promise<VerifiedPublicationCommit> {
    const repository = await this.#inspector.inspectRepository(this.#knowledgeRoot);
    if (repository.baseRevision !== input.knowledgeRevision) {
      throw new PublicationError('PUBLISH_COMMIT_INVALID');
    }
    const [commit, status] = await Promise.all([
      this.#inspector.inspectCommit(this.#knowledgeRoot, input.knowledgeRevision),
      this.#git.status(this.#knowledgeRoot),
    ]);
    const lineage = this.#parseAndValidateLineage(input, commit);
    const selected = await this.#validateCommitDiff(input, commit);
    const selectedPathsDigest = sha256(serializeCanonicalJson(selected.map((entry) => ({
      contentSha256: entry.contentSha256,
      mode: entry.mode,
      relativePath: entry.relativePath,
      status: entry.status,
    }))));
    if (
      selectedPathsDigest !== lineage.selectedPathsDigest ||
      lineage.trackingPolicyDigest !== KNOWLEDGE_TRACKING_POLICY.policyDigest
    ) {
      throw new PublicationError('PUBLISH_COMMIT_INVALID');
    }
    const stagedPaths = Object.freeze(selected.map(({ relativePath }) => relativePath));
    return {
      baseRevision: lineage.knowledgeParentRevision,
      branchRef: repository.branchRef,
      foreignCounts: statusCounts(status),
      knowledgeRevision: input.knowledgeRevision,
      lineage,
      localStateDigest: sha256(serializeCanonicalJson({
        baseRevision: repository.baseRevision,
        branchRef: repository.branchRef,
        indexSnapshotDigest: repository.indexSnapshotDigest,
        repositoryIdentityDigest: repository.repositoryIdentityDigest,
        status,
      })),
      projectId: input.projectId,
      stagedPaths,
      treeRevision: lineage.knowledgeTreeRevision,
    };
  }

  #parseAndValidateLineage(
    input: NormalizedPushInput,
    commit: PublicationCommitSnapshot,
  ): KnowledgeCommitLineageV1 {
    const prefix = `BuildLore knowledge publish: ${input.projectId}\n\n`;
    if (!commit.message.subarray(0, Buffer.byteLength(prefix)).equals(Buffer.from(prefix, 'utf8'))) {
      throw new PublicationError('PUBLISH_COMMIT_INVALID');
    }
    const lineage = parseKnowledgeCommitLineage(commit.message.subarray(Buffer.byteLength(prefix)));
    if (
      lineage.projectId !== input.projectId ||
      commit.parentRevisions.length !== 1 ||
      commit.parentRevisions[0] !== lineage.knowledgeParentRevision ||
      commit.treeRevision !== lineage.knowledgeTreeRevision ||
      !commit.message.equals(publicationMessage(lineage))
    ) {
      throw new PublicationError('PUBLISH_COMMIT_INVALID');
    }
    return lineage;
  }

  async #validateCommitDiff(
    input: NormalizedPushInput,
    commit: PublicationCommitSnapshot,
  ): Promise<readonly {
    readonly contentSha256: PublicationDigest | null;
    readonly mode: '100644' | null;
    readonly relativePath: string;
    readonly status: PublishPathStatus;
  }[]> {
    if (commit.diffEntries.length === 0 || commit.diffEntries.length > 100_000) {
      throw new PublicationError('PUBLISH_COMMIT_INVALID');
    }
    const selected: Array<{
      readonly contentSha256: PublicationDigest | null;
      readonly mode: '100644' | null;
      readonly relativePath: string;
      readonly status: PublishPathStatus;
    }> = [];
    let manifestCount = 0;
    for (const entry of commit.diffEntries) {
      const status = pathStatus(entry.status);
      const projectPath = entry.path.startsWith(`projects/${input.projectId}/`);
      const isManifest = entry.path === 'manifest.json';
      if (
        status === null ||
        entry.originalPath !== undefined ||
        (!projectPath && !isManifest)
      ) throw new PublicationError('PUBLISH_COMMIT_INVALID');
      if (
        (status === 'added' && (
          entry.oldMode !== '000000' || !/^0+$/u.test(entry.oldOid) || entry.newMode !== '100644'
        )) ||
        (status === 'modified' && (
          entry.oldMode !== '100644' || entry.newMode !== '100644' ||
          /^0+$/u.test(entry.oldOid) || /^0+$/u.test(entry.newOid)
        )) ||
        (status === 'deleted' && (
          entry.oldMode !== '100644' || entry.newMode !== '000000' ||
          /^0+$/u.test(entry.oldOid) || !/^0+$/u.test(entry.newOid)
        ))
      ) throw new PublicationError('PUBLISH_COMMIT_INVALID');
      const classification = classifyTrackingPath(entry.path, packageIdentity, {
        includePolicyTrack: true,
      });
      if (!classification.ok || classification.classification === 'always-ignore') {
        throw new PublicationError('PUBLISH_COMMIT_INVALID');
      }
      let contentSha256: PublicationDigest | null = null;
      if (status !== 'deleted') {
        const blob = await this.#inspector.readIndexBlob(this.#knowledgeRoot, entry.newOid);
        contentSha256 = sha256(blob);
        if (!await this.#blobPolicy.validate(input.projectId, entry.path, blob, contentSha256)) {
          throw new PublicationError('PUBLISH_COMMIT_INVALID');
        }
      }
      if (isManifest) {
        manifestCount += 1;
        if (status !== 'modified') throw new PublicationError('PUBLISH_COMMIT_INVALID');
        const [before, after] = await Promise.all([
          this.#inspector.readIndexBlob(this.#knowledgeRoot, entry.oldOid),
          this.#inspector.readIndexBlob(this.#knowledgeRoot, entry.newOid),
        ]);
        const registration = verifyCanonicalManifestRegistration(before, after, input.projectId);
        if (registration === null || registration.contentSha256 !== contentSha256) {
          throw new PublicationError('PUBLISH_COMMIT_INVALID');
        }
      }
      selected.push({
        contentSha256,
        mode: status === 'deleted' ? null : '100644',
        relativePath: entry.path,
        status,
      });
    }
    if (manifestCount > 1) throw new PublicationError('PUBLISH_COMMIT_INVALID');
    selected.sort((left, right) => left.relativePath < right.relativePath ? -1 : 1);
    if (
      new Set(selected.map(({ relativePath }) => relativePath)).size !== selected.length ||
      commit.changedPaths.length !== selected.length ||
      commit.changedPaths.some((path, index) => path !== selected[index]?.relativePath)
    ) {
      throw new PublicationError('PUBLISH_COMMIT_INVALID');
    }
    return Object.freeze(selected);
  }
}

export function createKnowledgePublicationPushService(
  knowledgeRoot: string,
  options: KnowledgePublicationPushOptions = {},
): KnowledgePublicationPushService {
  return new KnowledgePublicationPushService(knowledgeRoot, options);
}
