import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from './atomic-file.js';
import { RepositoryWriterError } from './errors.js';
import { GitMachineAdapter, type GitCachedDiffEntry, type GitMachinePort, type GitStatusEntry } from './git-machine.js';
import {
  createGitPublicationInspector,
  type PublicationFileSnapshot,
  type PublicationInspectionPort,
  type PublicationRepositorySnapshot,
} from './publication-inspection.js';
import {
  KNOWLEDGE_COMMIT_LINEAGE_SCHEMA_VERSION,
  KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION,
  KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
  PublicationError,
  type ForeignChangeBucket,
  type ForeignChangeSummary,
  type ForeignPathSummary,
  type KnowledgeCommitLineageV1,
  type KnowledgePublishCommitInput,
  type KnowledgePublishPlan,
  type KnowledgePublishPlanInput,
  type KnowledgePublishPushInput,
  type KnowledgePublishResult,
  type PublicationBlobPolicyPort,
  type PublicationDigest,
  type PublicationFailureCode,
  type PublicationFaultHooks,
  type PublishBlockReason,
  type PublishPathEntry,
  type PublishPathStatus,
  type RegistrationManifestEntry,
} from './publication-types.js';
import { KnowledgePublicationPushService } from './publication-push.js';
import {
  createPublicationBlobPolicy,
  verifyCanonicalManifestRegistration,
} from './publication-validation.js';
import {
  createRepositoryWriterLease,
  type RepositoryWriterLeasePort,
} from './repository-writer-lease.js';
import {
  classifyTrackingPath,
  KNOWLEDGE_TRACKING_POLICY,
} from './tracking-policy.js';
import {
  LLM_WIKI_COMPILER_INTEGRITY,
  LLM_WIKI_COMPILER_PACKAGE,
  LLM_WIKI_COMPILER_VERSION,
  type CompilerPackageIdentity,
} from './tracking-types.js';
import { validateProjectId } from './validation.js';
import { showProject } from './workspace.js';

const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_FOREIGN_ENTRIES = 100;
const MAX_SELECTED_PATHS = 100_000;

const packageIdentity: CompilerPackageIdentity = Object.freeze({
  exactVersion: LLM_WIKI_COMPILER_VERSION,
  packageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
  upstreamPackage: LLM_WIKI_COMPILER_PACKAGE,
});

interface NormalizedPlanInput {
  readonly codeRevision: string;
  readonly embeddingCompatibilityDigest: PublicationDigest;
  readonly includePolicyTrack: boolean;
  readonly modelCompatibilityDigest: PublicationDigest;
  readonly profileDigest: PublicationDigest;
  readonly projectId: string;
  readonly promptDigest: PublicationDigest;
  readonly registration: boolean;
  readonly sourceRevision: string;
}

interface PlanComputation {
  readonly foreignSnapshotDigest: PublicationDigest;
  readonly plan: KnowledgePublishPlan;
  readonly repository: PublicationRepositorySnapshot;
}

export interface KnowledgePublicationPort {
  plan(input: KnowledgePublishPlanInput): Promise<KnowledgePublishPlan>;
  commit(input: KnowledgePublishCommitInput): Promise<KnowledgePublishResult>;
  push(input: KnowledgePublishPushInput): Promise<KnowledgePublishResult>;
}

export interface KnowledgePublicationServiceOptions {
  readonly blobPolicy?: PublicationBlobPolicyPort;
  readonly gitMachine?: GitMachinePort;
  readonly hooks?: PublicationFaultHooks;
  readonly inspector?: PublicationInspectionPort;
  readonly lease?: RepositoryWriterLeasePort;
}

function sha256(value: Buffer | string): PublicationDigest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeOid(value: string): string {
  const normalized = value.toLowerCase();
  if (!OID_PATTERN.test(normalized)) throw new PublicationError('PUBLISH_REPOSITORY_DRIFT');
  return normalized;
}

function normalizeDigest(value: string): PublicationDigest {
  if (!DIGEST_PATTERN.test(value)) throw new PublicationError('PUBLISH_PLAN_DRIFT');
  return value as PublicationDigest;
}

function normalizeInput(
  input: KnowledgePublishPlanInput,
  allowExpectedPlanDigest = false,
): NormalizedPlanInput {
  const allowed = new Set([
    'codeRevision',
    'embeddingCompatibilityDigest',
    'includePolicyTrack',
    'modelCompatibilityDigest',
    'profileDigest',
    'projectId',
    'promptDigest',
    'registration',
    'sourceRevision',
    ...(allowExpectedPlanDigest ? ['expectedPlanDigest'] : []),
  ]);
  const actual = Object.keys(input);
  const required = [
    'codeRevision',
    'embeddingCompatibilityDigest',
    'modelCompatibilityDigest',
    'profileDigest',
    'projectId',
    'promptDigest',
    'sourceRevision',
    ...(allowExpectedPlanDigest ? ['expectedPlanDigest'] : []),
  ];
  const value = input as unknown as Readonly<Record<string, unknown>>;
  if (actual.some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(value, key) || typeof value[key] !== 'string') ||
      (input.includePolicyTrack !== undefined && typeof input.includePolicyTrack !== 'boolean') ||
      (input.registration !== undefined && typeof input.registration !== 'boolean')) {
    throw new PublicationError('PUBLISH_PLAN_DRIFT');
  }
  return Object.freeze({
    codeRevision: normalizeOid(input.codeRevision),
    embeddingCompatibilityDigest: normalizeDigest(input.embeddingCompatibilityDigest),
    includePolicyTrack: input.includePolicyTrack === true,
    modelCompatibilityDigest: normalizeDigest(input.modelCompatibilityDigest),
    profileDigest: normalizeDigest(input.profileDigest),
    projectId: validateProjectId(input.projectId),
    promptDigest: normalizeDigest(input.promptDigest),
    registration: input.registration === true,
    sourceRevision: normalizeOid(input.sourceRevision),
  });
}

function safePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    path !== path.normalize('NFC') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\0')
  ) return false;
  return path.split('/').every((segment) =>
    segment.length > 0 && segment !== '.' && segment !== '..' && segment !== '.git');
}

function safeSummaryPath(path: string): string {
  if (
    path.length > 240 ||
    /(?:api[-_]?key|authorization|bearer|credential|password|secret|token|https?:\/\/|ssh:\/\/)/iu
      .test(path)
  ) return `redacted-${sha256(path).slice(7, 23)}`;
  return path;
}

function pathStatus(entry: GitStatusEntry): string {
  if (entry.kind === 'untracked') return '?';
  if (entry.kind === 'ignored') return '!';
  return `${entry.indexStatus}${entry.worktreeStatus}`;
}

function bucket(entries: readonly ForeignPathSummary[]): ForeignChangeBucket {
  const ordered = entries.toSorted((left, right) => {
    if (left.relativePath !== right.relativePath) {
      return left.relativePath < right.relativePath ? -1 : 1;
    }
    return left.status < right.status ? -1 : left.status > right.status ? 1 : 0;
  });
  return Object.freeze({
    count: ordered.length,
    entries: Object.freeze(ordered.slice(0, MAX_FOREIGN_ENTRIES)),
    overflow: ordered.length > MAX_FOREIGN_ENTRIES,
  });
}

function foreignSummary(
  staged: readonly ForeignPathSummary[],
  unstaged: readonly ForeignPathSummary[],
  untracked: readonly ForeignPathSummary[],
): ForeignChangeSummary {
  const all = {
    staged: bucket(staged),
    unstaged: bucket(unstaged),
    untracked: bucket(untracked),
  };
  return Object.freeze({
    digest: sha256(serializeCanonicalJson(all)),
    staged: all.staged,
    unstaged: all.unstaged,
    untracked: all.untracked,
  });
}

function selectedStatus(entry: GitStatusEntry): PublishPathStatus | null {
  if (entry.kind === 'untracked') return 'added';
  if (entry.kind === 'ignored' || entry.kind === 'unmerged' || entry.kind === 'renamed') return null;
  if (entry.indexStatus === 'D' || entry.worktreeStatus === 'D') return 'deleted';
  if (/^0+$/u.test(entry.headOid)) return 'added';
  return 'modified';
}

function lineCount(content: Buffer): number | null {
  if (content.byteLength > 1024 * 1024) return null;
  let count = 0;
  for (const byte of content) if (byte === 0x0a) count += 1;
  return count;
}

function foreignCounts(plan: KnowledgePublishPlan): {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
} {
  return {
    staged: plan.foreignChanges.staged.count,
    unstaged: plan.foreignChanges.unstaged.count,
    untracked: plan.foreignChanges.untracked.count,
  };
}

function ineligibleFailureCode(
  plan: KnowledgePublishPlan,
): Exclude<PublicationFailureCode, 'PUBLISH_PUSH_FAILED'> {
  return plan.blockReasons.some((reason) =>
    reason === 'DIRTY_INDEX' || reason === 'FOREIGN_STAGED_CHANGE' ||
    reason === 'UNMERGED_CHANGE')
    ? 'PUBLISH_DIRTY_INDEX'
    : 'PUBLISH_INELIGIBLE';
}

function blocked(
  plan: KnowledgePublishPlan,
  errorCode: Exclude<PublicationFailureCode, 'PUBLISH_PUSH_FAILED'>,
  options: {
    readonly knowledgeRevision?: string | null;
    readonly partial?: boolean;
    readonly stagedPaths?: readonly string[];
    readonly treeRevision?: string | null;
  } = {},
): KnowledgePublishResult {
  return Object.freeze({
    schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
    state: 'blocked',
    projectId: plan.projectId,
    baseRevision: plan.baseRevision,
    errorCode,
    foreignCounts: foreignCounts(plan),
    knowledgeRevision: options.knowledgeRevision ?? null,
    localCommitPreserved: options.knowledgeRevision !== undefined && options.knowledgeRevision !== null,
    partial: options.partial === true,
    pinRequired: true,
    recoveryCommand: Object.freeze(options.partial === true
      ? ['knowledge', 'status']
      : ['publish', 'plan', '--project', plan.projectId]),
    remoteRevision: null,
    stagedPaths: Object.freeze([...(options.stagedPaths ?? [])]),
    treeRevision: options.treeRevision ?? null,
    warnings: Object.freeze([]),
  });
}

function commitLineage(
  input: NormalizedPlanInput,
  plan: KnowledgePublishPlan,
  treeRevision: string,
): KnowledgeCommitLineageV1 {
  const selectedPathsDigest = sha256(serializeCanonicalJson(
    plan.selectedPaths.map(({ contentSha256, mode, relativePath, status }) =>
      ({ contentSha256, mode, relativePath, status })),
  ));
  return Object.freeze({
    schemaVersion: KNOWLEDGE_COMMIT_LINEAGE_SCHEMA_VERSION,
    projectId: plan.projectId,
    knowledgeParentRevision: plan.baseRevision,
    knowledgeTreeRevision: treeRevision,
    sourceRevision: input.sourceRevision,
    codeRevision: input.codeRevision,
    compilerPackage: LLM_WIKI_COMPILER_PACKAGE,
    compilerPackageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
    compilerVersion: LLM_WIKI_COMPILER_VERSION,
    embeddingCompatibilityDigest: input.embeddingCompatibilityDigest,
    modelCompatibilityDigest: input.modelCompatibilityDigest,
    planDigest: plan.planDigest,
    profileDigest: input.profileDigest,
    promptDigest: input.promptDigest,
    selectedPathsDigest,
    trackingPolicyDigest: plan.trackingPolicyDigest,
  });
}

export function renderKnowledgeCommitLineage(lineage: KnowledgeCommitLineageV1): Buffer {
  return Buffer.from(
    `BuildLore knowledge publish: ${lineage.projectId}\n\n${serializeCanonicalJson(lineage)}`,
    'utf8',
  );
}

export class KnowledgePublicationService implements KnowledgePublicationPort {
  readonly #blobPolicy: PublicationBlobPolicyPort;
  readonly #git: GitMachinePort;
  readonly #hooks: PublicationFaultHooks;
  readonly #inspector: PublicationInspectionPort;
  readonly #knowledgeRoot: string;
  readonly #lease: RepositoryWriterLeasePort;
  readonly #pusher: KnowledgePublicationPushService;

  constructor(knowledgeRoot: string, options: KnowledgePublicationServiceOptions = {}) {
    this.#knowledgeRoot = knowledgeRoot;
    this.#git = options.gitMachine ?? new GitMachineAdapter();
    this.#inspector = options.inspector ?? createGitPublicationInspector();
    this.#lease = options.lease ?? createRepositoryWriterLease();
    this.#blobPolicy = options.blobPolicy ?? createPublicationBlobPolicy(knowledgeRoot);
    this.#hooks = options.hooks ?? {};
    this.#pusher = new KnowledgePublicationPushService(knowledgeRoot, {
      blobPolicy: this.#blobPolicy,
      gitMachine: this.#git,
      hooks: this.#hooks,
      inspector: this.#inspector,
      lease: this.#lease,
    });
  }

  async plan(input: KnowledgePublishPlanInput): Promise<KnowledgePublishPlan> {
    return (await this.#computePlan(normalizeInput(input))).plan;
  }

  async commit(input: KnowledgePublishCommitInput): Promise<KnowledgePublishResult> {
    const normalized = normalizeInput(input, true);
    const expectedPlanDigest = normalizeDigest(input.expectedPlanDigest);
    let initial: PlanComputation;
    try {
      initial = await this.#computePlan(normalized);
    } catch {
      throw new PublicationError('PUBLISH_REPOSITORY_DRIFT');
    }
    if (initial.plan.planDigest !== expectedPlanDigest) {
      return blocked(initial.plan, 'PUBLISH_PLAN_DRIFT');
    }
    if (!initial.plan.eligible || initial.plan.selectedPaths.length === 0) {
      return blocked(initial.plan, ineligibleFailureCode(initial.plan));
    }

    try {
      return await this.#lease.withLease(this.#knowledgeRoot, 'commit', async (lease) => {
        await lease.updatePhase('revalidate');
        const fresh = await this.#computePlan(normalized);
        if (
          fresh.plan.planDigest !== expectedPlanDigest ||
          fresh.repository.branchRef !== initial.repository.branchRef ||
          fresh.repository.baseRevision !== initial.repository.baseRevision ||
          fresh.repository.indexSnapshotDigest !== initial.repository.indexSnapshotDigest ||
          fresh.repository.repositoryIdentityDigest !== initial.repository.repositoryIdentityDigest
        ) {
          return blocked(fresh.plan, 'PUBLISH_PLAN_DRIFT');
        }
        if (!fresh.plan.eligible) return blocked(fresh.plan, ineligibleFailureCode(fresh.plan));
        if ((await this.#git.cachedDiff(this.#knowledgeRoot)).length !== 0) {
          return blocked(fresh.plan, 'PUBLISH_DIRTY_INDEX');
        }

        const paths = fresh.plan.selectedPaths.map(({ relativePath }) => relativePath);
        let staged = false;
        let treeRevision: string | null = null;
        let knowledgeRevision: string | null = null;
        try {
          await this.#hooks.beforeAdd?.();
          let beforeAdd: PlanComputation;
          try {
            beforeAdd = await this.#computePlan(normalized);
          } catch {
            throw new PublicationError('PUBLISH_PATH_DRIFT');
          }
          if (
            beforeAdd.plan.planDigest !== expectedPlanDigest ||
            beforeAdd.repository.branchRef !== fresh.repository.branchRef ||
            beforeAdd.repository.baseRevision !== fresh.repository.baseRevision ||
            beforeAdd.repository.indexSnapshotDigest !== fresh.repository.indexSnapshotDigest ||
            beforeAdd.foreignSnapshotDigest !== fresh.foreignSnapshotDigest
          ) throw new PublicationError('PUBLISH_PLAN_DRIFT');
          await lease.updatePhase('add');
          await this.#git.addExact(this.#knowledgeRoot, paths);
          staged = true;
          await this.#hooks.afterAdd?.();

          await lease.updatePhase('validate-index');
          const cached = await this.#git.cachedDiff(this.#knowledgeRoot);
          this.#validateCachedDiff(fresh.plan, cached);
          await this.#hooks.afterCachedValidation?.();

          await lease.updatePhase('secret-scan');
          await this.#validateStagedBlobs(fresh.plan, cached);
          await this.#hooks.afterSecretScan?.();

          await lease.updatePhase('write-tree');
          treeRevision = await this.#git.writeTree(this.#knowledgeRoot);
          await this.#hooks.afterWriteTree?.(treeRevision);
          const lineage = commitLineage(normalized, fresh.plan, treeRevision);

          await lease.updatePhase('commit-tree');
          knowledgeRevision = await this.#git.commitTree(
            this.#knowledgeRoot,
            treeRevision,
            [fresh.plan.baseRevision],
            renderKnowledgeCommitLineage(lineage),
          );
          await this.#hooks.afterCommitTree?.(knowledgeRevision);

          await lease.updatePhase('update-ref');
          await this.#hooks.beforeUpdateRef?.(knowledgeRevision);
          await this.#git.updateRefCompareAndSwap(
            this.#knowledgeRoot,
            fresh.repository.branchRef,
            knowledgeRevision,
            fresh.plan.baseRevision,
          );

          await lease.updatePhase('post-verify');
          await this.#hooks.beforePostVerify?.();
          const verified = await this.#inspector.inspectRepository(this.#knowledgeRoot);
          const remaining = await this.#git.cachedDiff(this.#knowledgeRoot);
          const commitSnapshot = await this.#inspector.inspectCommit(
            this.#knowledgeRoot,
            knowledgeRevision,
          );
          const expectedMessage = renderKnowledgeCommitLineage(lineage);
          const postStatus = await this.#git.status(this.#knowledgeRoot);
          const foreignAfter = await this.#foreignSnapshotDigest(
            normalized.projectId,
            normalized.registration,
            postStatus,
          );
          if (
            verified.baseRevision !== knowledgeRevision ||
            verified.branchRef !== fresh.repository.branchRef ||
            remaining.length !== 0 ||
            commitSnapshot.treeRevision !== treeRevision ||
            commitSnapshot.parentRevisions.length !== 1 ||
            commitSnapshot.parentRevisions[0] !== fresh.plan.baseRevision ||
            !commitSnapshot.message.equals(expectedMessage) ||
            commitSnapshot.changedPaths.length !== paths.length ||
            commitSnapshot.changedPaths.some((path, index) => path !== paths.toSorted()[index]) ||
            foreignAfter !== fresh.foreignSnapshotDigest
          ) throw new PublicationError('PUBLISH_PARTIAL', true);

          return Object.freeze({
            schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
            state: 'committed',
            projectId: fresh.plan.projectId,
            baseRevision: fresh.plan.baseRevision,
            foreignCounts: foreignCounts(fresh.plan),
            knowledgeRevision,
            localCommitPreserved: true,
            partial: false,
            pinRequired: true,
            recoveryCommand: Object.freeze([
              'publish',
              'push',
              '--project',
              fresh.plan.projectId,
              '--knowledge-revision',
              knowledgeRevision,
            ]),
            remoteRevision: null,
            stagedPaths: Object.freeze(paths),
            treeRevision,
            warnings: Object.freeze([]),
          });
        } catch (error) {
          const code = error instanceof PublicationError && error.code !== 'PUBLISH_PUSH_FAILED'
            ? error.code
            : staged ? 'PUBLISH_PARTIAL' : 'PUBLISH_TRANSACTION_FAILED';
          return blocked(fresh.plan, code, {
            knowledgeRevision,
            partial: staged || (error instanceof PublicationError && error.partial),
            stagedPaths: staged ? paths : [],
            treeRevision,
          });
        }
      });
    } catch (error) {
      if (error instanceof RepositoryWriterError && error.code === 'REPOSITORY_BUSY') {
        return blocked(initial.plan, 'PUBLISH_REPOSITORY_BUSY');
      }
      throw error;
    }
  }

  async push(input: KnowledgePublishPushInput): Promise<KnowledgePublishResult> {
    return this.#pusher.push(input);
  }

  async #computePlan(input: NormalizedPlanInput): Promise<PlanComputation> {
    await showProject(this.#knowledgeRoot, input.projectId);
    const repository = await this.#inspector.inspectRepository(this.#knowledgeRoot);
    const status = await this.#git.status(this.#knowledgeRoot);
    const projectPrefix = `projects/${input.projectId}/`;
    const stagedForeign: ForeignPathSummary[] = [];
    const unstagedForeign: ForeignPathSummary[] = [];
    const untrackedForeign: ForeignPathSummary[] = [];
    const foreignStatusEntries: GitStatusEntry[] = [];
    const candidates: GitStatusEntry[] = [];
    const blockReasons = new Set<PublishBlockReason>();
    let manifestChanged = false;

    for (const entry of status) {
      if (entry.kind === 'ignored') continue;
      if (!safePath(entry.path)) {
        blockReasons.add('PATH_UNSAFE');
        continue;
      }
      const target = entry.path.startsWith(projectPrefix);
      const isManifest = entry.path === 'manifest.json';
      const isProjectPath = entry.path.startsWith('projects/');
      if (entry.kind === 'unmerged' || entry.kind === 'renamed') {
        blockReasons.add('UNMERGED_CHANGE');
      }
      const hasStaged = entry.kind !== 'untracked' && entry.indexStatus !== '.';
      const hasUnstaged = entry.kind !== 'untracked' && entry.worktreeStatus !== '.';
      if (hasStaged) {
        if (!target && !(input.registration && isManifest)) {
          stagedForeign.push({
            kind: 'staged',
            relativePath: safeSummaryPath(entry.path),
            status: pathStatus(entry),
          });
          blockReasons.add('FOREIGN_STAGED_CHANGE');
        }
        blockReasons.add('DIRTY_INDEX');
      }
      if (target) candidates.push(entry);
      else if (isManifest) {
        manifestChanged = true;
        if (!input.registration) blockReasons.add('ROOT_CHANGE_NOT_ALLOWED');
      } else if (!isProjectPath) {
        blockReasons.add('ROOT_CHANGE_NOT_ALLOWED');
      } else if (entry.kind === 'untracked') {
        untrackedForeign.push({
          kind: 'untracked',
          relativePath: safeSummaryPath(entry.path),
          status: '?',
        });
        foreignStatusEntries.push(entry);
      } else if (hasUnstaged) {
        unstagedForeign.push({
          kind: 'unstaged',
          relativePath: safeSummaryPath(entry.path),
          status: pathStatus(entry),
        });
        foreignStatusEntries.push(entry);
      }
    }

    if (candidates.length > MAX_SELECTED_PATHS) {
      blockReasons.add('TRACKING_POLICY_VIOLATION');
    }
    const selected: PublishPathEntry[] = [];
    const identityDigests: Array<{ readonly digest: PublicationDigest; readonly path: string }> = [];
    for (const entry of candidates.slice(0, MAX_SELECTED_PATHS)) {
      let file: PublicationFileSnapshot | null = null;
      const preliminaryStatus = selectedStatus(entry);
      if (preliminaryStatus !== null && preliminaryStatus !== 'deleted') {
        try {
          file = await this.#inspector.readWorktreeFile(this.#knowledgeRoot, entry.path);
        } catch {
          blockReasons.add('PATH_UNSAFE');
          continue;
        }
      }
      const classification = classifyTrackingPath(entry.path, packageIdentity, {
        includePolicyTrack: input.includePolicyTrack,
      });
      if (!classification.ok || classification.classification === 'always-ignore') {
        blockReasons.add('TRACKING_POLICY_VIOLATION');
        continue;
      }
      if (classification.disposition !== 'include') continue;
      const statusKind = selectedStatus(entry);
      if (statusKind === null) {
        blockReasons.add('UNMERGED_CHANGE');
        continue;
      }
      if (statusKind !== 'deleted') {
        if (file === null) {
          blockReasons.add('PATH_UNSAFE');
          continue;
        }
        identityDigests.push({ digest: file.identityDigest, path: entry.path });
      }
      selected.push({
        classification: classification.classification,
        contentSha256: file?.digest ?? null,
        mode: file?.mode ?? null,
        numstat: {
          added: statusKind === 'added' && file !== null ? lineCount(file.content) : null,
          deleted: null,
        },
        reasonCode: 'selected',
        relativePath: entry.path,
        status: statusKind,
      });
    }

    let registrationManifest: RegistrationManifestEntry | null = null;
    if (input.registration) {
      if (!manifestChanged) blockReasons.add('MANIFEST_REGISTRATION_INVALID');
      else {
        const before = await this.#inspector.readHeadFile(this.#knowledgeRoot, 'manifest.json');
        const currentFile = await this.#inspector.readWorktreeFile(this.#knowledgeRoot, 'manifest.json');
        if (before === null) blockReasons.add('MANIFEST_REGISTRATION_INVALID');
        else registrationManifest = verifyCanonicalManifestRegistration(
          before,
          currentFile.content,
          input.projectId,
        );
        if (registrationManifest === null) blockReasons.add('MANIFEST_REGISTRATION_INVALID');
        else {
          identityDigests.push({ digest: currentFile.identityDigest, path: 'manifest.json' });
          selected.push({
            classification: 'always-track',
            contentSha256: currentFile.digest,
            mode: '100644',
            numstat: { added: null, deleted: null },
            reasonCode: 'selected',
            relativePath: 'manifest.json',
            status: 'modified',
          });
        }
      }
    }

    const selectedPaths = Object.freeze(selected.toSorted((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
    const folded = new Set<string>();
    for (const entry of selectedPaths) {
      const identity = entry.relativePath.toLowerCase();
      if (folded.has(identity)) blockReasons.add('PATH_UNSAFE');
      folded.add(identity);
    }
    if (selectedPaths.length === 0) blockReasons.add('EMPTY_SELECTION');
    identityDigests.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const foreignSnapshotDigest = await this.#foreignIdentityDigest(foreignStatusEntries);
    const foreignChanges = foreignSummary(stagedForeign, unstagedForeign, untrackedForeign);
    const lineageDigest = sha256(serializeCanonicalJson({
      codeRevision: input.codeRevision,
      compilerPackage: LLM_WIKI_COMPILER_PACKAGE,
      compilerPackageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
      compilerVersion: LLM_WIKI_COMPILER_VERSION,
      embeddingCompatibilityDigest: input.embeddingCompatibilityDigest,
      modelCompatibilityDigest: input.modelCompatibilityDigest,
      profileDigest: input.profileDigest,
      projectId: input.projectId,
      promptDigest: input.promptDigest,
      sourceRevision: input.sourceRevision,
    }));
    const orderedBlockReasons = Object.freeze([...blockReasons].sort());
    const base = {
      schemaVersion: KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION,
      projectId: input.projectId,
      repositoryIdentityDigest: repository.repositoryIdentityDigest,
      baseRevision: repository.baseRevision,
      localUpstreamRevision: repository.localUpstreamRevision,
      sourceRevision: input.sourceRevision,
      codeRevision: input.codeRevision,
      selectedPaths,
      foreignChanges,
      registrationManifest,
      trackingPolicyDigest: KNOWLEDGE_TRACKING_POLICY.policyDigest,
      lineageDigest,
      indexSnapshotDigest: repository.indexSnapshotDigest,
      eligible: orderedBlockReasons.length === 0,
      blockReasons: orderedBlockReasons,
    };
    const planDigest = sha256(serializeCanonicalJson({
      ...base,
      normalizedOptions: input,
      pathIdentityDigests: identityDigests,
      foreignSnapshotDigest,
    }));
    return {
      plan: Object.freeze({
        ...base,
        planDigest,
      }),
      repository,
      foreignSnapshotDigest,
    };
  }

  async #foreignIdentityDigest(entries: readonly GitStatusEntry[]): Promise<PublicationDigest> {
    const identities: Array<{
      readonly headMode: string | null;
      readonly headOid: string | null;
      readonly indexMode: string | null;
      readonly indexOid: string | null;
      readonly pathDigest: PublicationDigest;
      readonly status: string;
      readonly worktreeIdentityDigest: PublicationDigest | null;
    }> = [];
    for (const entry of entries.toSorted((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
      const worktreeIdentityDigest = await this.#inspector.inspectWorktreePathIdentity(
        this.#knowledgeRoot,
        entry.path,
      );
      identities.push({
        headMode: entry.kind === 'ordinary' || entry.kind === 'renamed'
          ? entry.headMode : null,
        headOid: entry.kind === 'ordinary' || entry.kind === 'renamed'
          ? entry.headOid : null,
        indexMode: entry.kind === 'ordinary' || entry.kind === 'renamed'
          ? entry.indexMode : null,
        indexOid: entry.kind === 'ordinary' || entry.kind === 'renamed'
          ? entry.indexOid : null,
        pathDigest: sha256(entry.path),
        status: pathStatus(entry),
        worktreeIdentityDigest,
      });
    }
    return sha256(serializeCanonicalJson(identities));
  }

  async #foreignSnapshotDigest(
    projectId: string,
    registration: boolean,
    status: readonly GitStatusEntry[],
  ): Promise<PublicationDigest> {
    const prefix = `projects/${projectId}/`;
    return this.#foreignIdentityDigest(status.filter((entry) =>
      entry.kind !== 'ignored' &&
      !entry.path.startsWith(prefix) &&
      !(registration && entry.path === 'manifest.json') &&
      (entry.kind === 'untracked' || entry.kind === 'unmerged' || entry.kind === 'renamed' ||
        entry.indexStatus !== '.' || entry.worktreeStatus !== '.')));
  }

  #validateCachedDiff(
    plan: KnowledgePublishPlan,
    cached: readonly GitCachedDiffEntry[],
  ): void {
    const expected = new Map(plan.selectedPaths.map((entry) => [entry.relativePath, entry]));
    if (cached.length !== expected.size) throw new PublicationError('PUBLISH_PATH_DRIFT', true);
    for (const entry of cached) {
      const planned = expected.get(entry.path);
      if (
        planned === undefined ||
        entry.originalPath !== undefined ||
        !entry.status.startsWith(planned.status === 'added' ? 'A' : planned.status === 'deleted' ? 'D' : 'M')
      ) throw new PublicationError('PUBLISH_PATH_DRIFT', true);
      if (planned.status === 'deleted') {
        if (
          entry.oldMode !== '100644' ||
          /^0+$/u.test(entry.oldOid) ||
          entry.newMode !== '000000' ||
          !/^0+$/u.test(entry.newOid)
        ) {
          throw new PublicationError('PUBLISH_PATH_DRIFT', true);
        }
      } else if (
        entry.newMode !== '100644' ||
        /^0+$/u.test(entry.newOid) ||
        (planned.status === 'added'
          ? entry.oldMode !== '000000' || !/^0+$/u.test(entry.oldOid)
          : entry.oldMode !== '100644' || /^0+$/u.test(entry.oldOid))
      ) {
        throw new PublicationError('PUBLISH_PATH_DRIFT', true);
      }
    }
  }

  async #validateStagedBlobs(
    plan: KnowledgePublishPlan,
    cached: readonly GitCachedDiffEntry[],
  ): Promise<void> {
    const expected = new Map(plan.selectedPaths.map((entry) => [entry.relativePath, entry]));
    for (const entry of cached) {
      const planned = expected.get(entry.path);
      if (planned === undefined) throw new PublicationError('PUBLISH_PATH_DRIFT', true);
      const classification = classifyTrackingPath(entry.path, packageIdentity, {
        includePolicyTrack: planned.classification === 'policy-track',
      });
      if (!classification.ok || classification.disposition !== 'include') {
        throw new PublicationError('PUBLISH_POLICY_BLOCKED', true);
      }
      if (planned.status === 'deleted') continue;
      const blob = await this.#inspector.readIndexBlob(this.#knowledgeRoot, entry.newOid);
      if (sha256(blob) !== planned.contentSha256) {
        throw new PublicationError('PUBLISH_PATH_DRIFT', true);
      }
      if (!await this.#blobPolicy.validate(
        plan.projectId,
        entry.path,
        blob,
        planned.contentSha256,
      )) throw new PublicationError('PUBLISH_POLICY_BLOCKED', true);
    }
  }
}

export function createKnowledgePublicationService(
  knowledgeRoot: string,
  options: KnowledgePublicationServiceOptions = {},
): KnowledgePublicationPort {
  return new KnowledgePublicationService(knowledgeRoot, options);
}
