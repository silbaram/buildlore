import { join } from 'node:path';

import { writeJsonAtomic } from '../knowledge/atomic-file.js';
import { PROJECT_SCHEMA_VERSION } from '../knowledge/types.js';
import { resolveProjectWorkspace } from '../knowledge/paths.js';
import { createProfileProjectDescriptor } from '../knowledge/validation.js';
import { showProject } from '../knowledge/workspace.js';
import { consumePreparedSource, inspectPreparedSource } from '../sanitizer/approval.js';
import {
  createProjectSecurityService,
  SANITIZER_RULES_VERSION,
  type PreparedSource,
} from '../sanitizer/index.js';
import { parseLifecycleProfile } from './codec.js';
import { ProfileOperationError } from './errors.js';
import { readConfinedText, readEntityInventory } from './io.js';
import { materializeLifecycleProfile, sha256 } from './materializer.js';
import { createLifecycleProfileSdkValidator } from './sdk-validator.js';
import {
  BUILDLORE_PROFILE_VERSION,
  PROFILE_APPLY_SCHEMA_VERSION,
  PROFILE_PLAN_SCHEMA_VERSION,
  type MaterializedProfile,
  type ProfileApplyResult,
  type ProfileChangePlan,
  type ProjectLifecycleProfilePort,
} from './types.js';

interface ProfileSnapshot {
  readonly configBytes: string | null;
  readonly descriptorBytes: string;
  readonly descriptorHash: `sha256:${string}`;
  readonly inventoryDigest: `sha256:${string}`;
  readonly materialized: MaterializedProfile;
  readonly plan: ProfileChangePlan;
  readonly prepared: PreparedSource;
  readonly profileBytes: string | null;
  readonly sanitizerPolicyDigest: `sha256:${string}`;
  readonly sourceBytes: string;
  readonly workspace: string;
}

interface PlanBinding {
  consumed: boolean;
  readonly fingerprint: string;
  readonly projectId: string;
}

class ProfileApplyCoordinator {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(workspace) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(workspace, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#tails.get(workspace) === tail) this.#tails.delete(workspace);
    }
  }
}

const profileApplies = new ProfileApplyCoordinator();

function fingerprint(snapshot: ProfileSnapshot): string {
  return [
    snapshot.plan.projectId,
    snapshot.plan.sourceHash,
    snapshot.descriptorHash,
    snapshot.profileBytes === null ? 'absent' : sha256(snapshot.profileBytes),
    snapshot.configBytes === null ? 'absent' : sha256(snapshot.configBytes),
    snapshot.inventoryDigest,
    snapshot.sanitizerPolicyDigest,
  ].join('\n');
}

function samePlan(left: ProfileChangePlan, right: ProfileChangePlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseJson(bytes: string, projectId: string): unknown {
  try {
    return JSON.parse(bytes) as unknown;
  } catch {
    throw new ProfileOperationError('PROFILE_UPSTREAM_INVALID', { projectId });
  }
}

async function snapshotFor(knowledgeRoot: string, projectId: string): Promise<ProfileSnapshot> {
  const record = await showProject(knowledgeRoot, projectId);
  const workspace = await resolveProjectWorkspace(knowledgeRoot, projectId, { mustExist: true });
  const sourcePath = join(workspace, 'profile.json');
  const sourceBytes = await readConfinedText(workspace, sourcePath, projectId);
  if (sourceBytes === null) throw new ProfileOperationError('PROFILE_SOURCE_INVALID', { projectId });
  const profile = parseLifecycleProfile(sourceBytes);
  const materialized = materializeLifecycleProfile(profile);
  if (materialized.sourceHash !== sha256(sourceBytes)) {
    throw new ProfileOperationError('PROFILE_SOURCE_INVALID', { projectId });
  }

  const securityService = createProjectSecurityService({ knowledgeRoot });
  const preparedResult = await securityService.prepareSource({
    body: sourceBytes,
    bodyDigest: materialized.sourceHash,
    projectId,
    source: `buildlore://profile/${projectId}`,
    sourceKind: 'profile',
    sourceRevisionOrContentSha256: materialized.sourceHash,
  });
  if (!preparedResult.ok || preparedResult.report.decision !== 'include' ||
      preparedResult.report.inputDigest !== materialized.sourceHash ||
      preparedResult.report.outputDigest !== materialized.sourceHash ||
      preparedResult.report.projectId !== projectId ||
      preparedResult.report.rulesVersion !== SANITIZER_RULES_VERSION) {
    throw new ProfileOperationError('PROFILE_UNSAFE', { projectId });
  }
  const inspected = inspectPreparedSource(preparedResult.prepared);
  if (inspected === null || inspected.approvedBody !== sourceBytes ||
      inspected.approvedBodyDigest !== materialized.sourceHash ||
      inspected.inputBodyDigest !== materialized.sourceHash || inspected.projectId !== projectId ||
      inspected.sourceKind !== 'profile' ||
      inspected.sourceRevisionOrContentSha256 !== materialized.sourceHash) {
    throw new ProfileOperationError('PROFILE_BINDING_INVALID', { projectId });
  }

  await createLifecycleProfileSdkValidator().validate(materialized, projectId);
  const descriptorBytes = await readConfinedText(
    workspace,
    join(workspace, 'project.json'),
    projectId,
  );
  if (descriptorBytes === null) throw new ProfileOperationError('PROFILE_UNSAFE', { projectId });
  const profileBytes = await readConfinedText(
    workspace,
    join(workspace, '.llmwiki', 'profile.json'),
    projectId,
    { optional: true },
  );
  const configBytes = await readConfinedText(
    workspace,
    join(workspace, '.llmwiki', 'config.json'),
    projectId,
    { optional: true },
  );
  const inventory = await readEntityInventory(workspace, projectId);

  const reasons: string[] = [];
  let migrationRequired = false;
  let unchanged = false;
  if (record.descriptor.schemaVersion === PROJECT_SCHEMA_VERSION) {
    if (profileBytes !== null) {
      migrationRequired = true;
      reasons.push('foreign-profile');
    }
    if (configBytes !== null && configBytes !== materialized.configJson) {
      migrationRequired = true;
      reasons.push('foreign-config');
    }
    if (!migrationRequired) reasons.push('default-to-buildlore');
  } else {
    const profileMatches = profileBytes === materialized.profileJson;
    const configMatches = configBytes === materialized.configJson;
    if (!profileMatches || !configMatches) {
      migrationRequired = true;
      reasons.push('materialized-drift');
    } else if (record.descriptor.profileHash === materialized.sourceHash &&
        record.descriptor.outputLanguage === profile.outputLanguage) {
      unchanged = true;
      reasons.push('already-applied');
    } else {
      reasons.push('language-update');
    }
  }
  const plan: ProfileChangePlan = Object.freeze({
    affectedEntityTypes: Object.freeze(['decisions', 'failures', 'verifications'] as const),
    affectedPageCounts: inventory.counts,
    ...(record.descriptor.schemaVersion === PROJECT_SCHEMA_VERSION
      ? {}
      : { appliedHash: record.descriptor.profileHash }),
    disposition: migrationRequired
      ? 'migration-required'
      : unchanged
        ? 'unchanged'
        : 'compatible-recompile',
    migrationRequired,
    outputLanguage: profile.outputLanguage,
    profileVersion: BUILDLORE_PROFILE_VERSION,
    projectId,
    reasonCodes: Object.freeze(reasons.sort()),
    recompileRequired: !unchanged && !migrationRequired,
    reviewConfigHash: materialized.configJsonHash,
    schemaVersion: PROFILE_PLAN_SCHEMA_VERSION,
    sourceHash: materialized.sourceHash,
    upstreamProfileHash: materialized.profileJsonHash,
    warnings: Object.freeze(migrationRequired ? ['manual-migration-required'] : []),
  });
  return {
    configBytes,
    descriptorBytes,
    descriptorHash: sha256(descriptorBytes),
    inventoryDigest: inventory.digest,
    materialized,
    plan,
    prepared: preparedResult.prepared,
    profileBytes,
    sanitizerPolicyDigest: inspected.policyDigest,
    sourceBytes,
    workspace,
  };
}

export function createProjectLifecycleProfile(options: {
  readonly knowledgeRoot: string;
}): ProjectLifecycleProfilePort {
  const bindings = new WeakMap<object, PlanBinding>();
  const knowledgeRoot = options.knowledgeRoot;

  return {
    async plan(projectId): Promise<ProfileChangePlan> {
      const snapshot = await snapshotFor(knowledgeRoot, projectId);
      bindings.set(snapshot.plan, {
        consumed: false,
        fingerprint: fingerprint(snapshot),
        projectId,
      });
      return snapshot.plan;
    },
    async apply(plan): Promise<ProfileApplyResult> {
      const binding = bindings.get(plan);
      if (binding === undefined || binding.consumed || binding.projectId !== plan.projectId) {
        throw new ProfileOperationError('PROFILE_BINDING_INVALID', { projectId: plan.projectId });
      }
      const record = await showProject(knowledgeRoot, plan.projectId);
      const workspace = await resolveProjectWorkspace(knowledgeRoot, plan.projectId, {
        mustExist: true,
      });
      return profileApplies.run(workspace, async () => {
        const fresh = await snapshotFor(knowledgeRoot, plan.projectId);
        if (fingerprint(fresh) !== binding.fingerprint || !samePlan(fresh.plan, plan)) {
          throw new ProfileOperationError('PROFILE_BINDING_INVALID', {
            projectId: plan.projectId,
            recoveryAction: 'create-profile-plan',
          });
        }
        if (plan.migrationRequired) {
          throw new ProfileOperationError('PROFILE_MIGRATION_REQUIRED', {
            migrationRequired: true,
            projectId: plan.projectId,
            recoveryAction: 'check-profile',
          });
        }
        const prepared = consumePreparedSource(fresh.prepared);
        if (prepared === null || prepared.approvedBody !== fresh.sourceBytes ||
            prepared.approvedBodyDigest !== plan.sourceHash ||
            prepared.inputBodyDigest !== plan.sourceHash || prepared.projectId !== plan.projectId ||
            prepared.policyDigest !== fresh.sanitizerPolicyDigest ||
            prepared.sourceKind !== 'profile') {
          throw new ProfileOperationError('PROFILE_BINDING_INVALID', { projectId: plan.projectId });
        }
        binding.consumed = true;
        if (plan.disposition === 'unchanged') {
          return Object.freeze({
            outcome: 'unchanged',
            outputLanguage: plan.outputLanguage,
            profileHash: plan.sourceHash,
            profileVersion: BUILDLORE_PROFILE_VERSION,
            projectId: plan.projectId,
            recompileRequired: false,
            reviewConfigHash: plan.reviewConfigHash,
            schemaVersion: PROFILE_APPLY_SCHEMA_VERSION,
            upstreamProfileHash: plan.upstreamProfileHash,
            warnings: Object.freeze([]),
          });
        }
        const descriptor = createProfileProjectDescriptor({
          outputLanguage: plan.outputLanguage,
          profileHash: plan.sourceHash,
          projectId: plan.projectId,
          sourceRepository: record.descriptor.sourceRepository,
        });
        try {
          if (fresh.configBytes !== fresh.materialized.configJson) {
            await writeJsonAtomic(
              join(workspace, '.llmwiki', 'config.json'),
              parseJson(fresh.materialized.configJson, plan.projectId),
            );
          }
          if (fresh.profileBytes !== fresh.materialized.profileJson) {
            await writeJsonAtomic(
              join(workspace, '.llmwiki', 'profile.json'),
              parseJson(fresh.materialized.profileJson, plan.projectId),
            );
          }
          await writeJsonAtomic(join(workspace, 'project.json'), descriptor);
        } catch (error) {
          if (error instanceof ProfileOperationError) throw error;
          throw new ProfileOperationError('PROFILE_APPLY_FAILED', {
            projectId: plan.projectId,
            recompileRequired: true,
            recoveryAction: 'create-profile-plan',
          });
        }
        return Object.freeze({
          outcome: 'applied',
          outputLanguage: plan.outputLanguage,
          profileHash: plan.sourceHash,
          profileVersion: BUILDLORE_PROFILE_VERSION,
          projectId: plan.projectId,
          recompileRequired: true,
          reviewConfigHash: plan.reviewConfigHash,
          schemaVersion: PROFILE_APPLY_SCHEMA_VERSION,
          upstreamProfileHash: plan.upstreamProfileHash,
          warnings: Object.freeze([]),
        });
      });
    },
  };
}
