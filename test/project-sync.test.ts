import { describe, expect, it } from 'vitest';

import {
  createProjectSyncService,
  EXECUTION_INCLUSION_POLICY_VERSION,
  EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION,
  PROJECTION_PLAN_SCHEMA_VERSION,
  ProjectSyncError,
  type ExecutionKnowledgeProjectorPort,
  type ExecutionProjectionPlan,
  type PlanningProjectorPort,
  type ProjectionPlan,
} from '../src/projector/index.js';
import {
  SANITIZATION_REPORT_SCHEMA_VERSION,
  SANITIZER_RULES_VERSION,
  type SanitizationReport,
} from '../src/sanitizer/index.js';

const PLANNING_TARGET = `planning--${'1'.repeat(64)}.md`;
const EXECUTION_TARGET = `execution--${'2'.repeat(64)}.md`;
const SOURCE_REVISION = `sha256:${'3'.repeat(64)}` as const;
const PLANNING_FINGERPRINT = `sha256:${'4'.repeat(64)}` as const;
const EXECUTION_FINGERPRINT = `sha256:${'5'.repeat(64)}` as const;

function securityReport(decision: 'blocked' | 'include'): SanitizationReport {
  return {
    classification: 'restricted',
    decision,
    findingsOverflow: false,
    inputDigest: `sha256:${'6'.repeat(64)}`,
    ...(decision === 'include' ? { outputDigest: `sha256:${'7'.repeat(64)}` as const } : {}),
    policyDigest: `sha256:${'8'.repeat(64)}`,
    projectId: 'alpha',
    rulesVersion: SANITIZER_RULES_VERSION,
    schemaVersion: SANITIZATION_REPORT_SCHEMA_VERSION,
    sourceIdentitySha256: '9'.repeat(64),
    summaries: [{
      action: decision === 'include' ? 'redact' : 'block',
      count: 1,
      overriddenCount: 0,
      ruleId: 'credential.provider.openai',
    }],
  };
}

function planningPlan(options: {
  readonly blocked?: boolean;
  readonly target?: string;
  readonly compatibilityWarnings?: ProjectionPlan['compatibilityWarnings'];
  readonly writeStatus?: 'create' | 'unchanged' | 'update';
} = {}): ProjectionPlan {
  const blocked = options.blocked ?? false;
  return {
    compatibilityWarnings: options.compatibilityWarnings ?? [],
    counts: {
      blocked: blocked ? 1 : 0,
      error: 0,
      exclude: 0,
      include: blocked ? 0 : 1,
      quarantine: 0,
    },
    entries: [{
      decision: blocked ? 'blocked' : 'include',
      documentKind: 'product-spec',
      reasonCode: blocked ? 'security_blocked' : 'approved_product_spec',
      security: securityReport(blocked ? 'blocked' : 'include'),
      sourceArtifact: blocked ? 'token=do-not-reflect' : 'current-spec.json',
      sourceRevision: SOURCE_REVISION,
      sourceUri: 'buildlore+p2a:fixture',
      target: options.target ?? PLANNING_TARGET,
      ...(blocked ? {} : { writeStatus: options.writeStatus ?? 'create' }),
    }],
    planFingerprint: PLANNING_FINGERPRINT,
    projectId: 'alpha',
    schemaVersion: PROJECTION_PLAN_SCHEMA_VERSION,
  };
}

function executionPlan(options: {
  readonly target?: string;
  readonly writeStatus?: 'create' | 'unchanged' | 'update';
} = {}): ExecutionProjectionPlan {
  return {
    counts: { blocked: 0, exclude: 0, include: 1, quarantine: 0 },
    entries: [{
      attempts: [],
      decision: 'include',
      reasonCode: 'reusable_verification',
      sourceRevision: SOURCE_REVISION,
      target: options.target ?? EXECUTION_TARGET,
      taskStableId: 'a'.repeat(64),
      writeStatus: options.writeStatus ?? 'create',
    }],
    planFingerprint: EXECUTION_FINGERPRINT,
    policyVersion: EXECUTION_INCLUSION_POLICY_VERSION,
    projectId: 'alpha',
    schemaVersion: EXECUTION_PROJECTION_PLAN_SCHEMA_VERSION,
  };
}

const input = {
  artifactRoot: '/not-exposed/artifacts',
  dryRun: false,
  knowledgeRoot: '/not-exposed/knowledge',
  projectId: 'alpha',
};

function ports(options: {
  readonly events: string[];
  readonly executionApply?: ExecutionKnowledgeProjectorPort['apply'];
  readonly executionPlan?: ExecutionProjectionPlan;
  readonly planningApply?: PlanningProjectorPort['apply'];
  readonly planningPlan?: ProjectionPlan;
}): {
  readonly executionProjector: ExecutionKnowledgeProjectorPort;
  readonly planningProjector: PlanningProjectorPort;
} {
  return {
    executionProjector: {
      apply: options.executionApply ?? ((plan) => {
        options.events.push('execution-apply');
        return Promise.resolve({
          planFingerprint: plan.planFingerprint,
          projectId: plan.projectId,
          writes: [{
            sourceRevision: SOURCE_REVISION,
            target: EXECUTION_TARGET,
            taskStableId: 'a'.repeat(64),
            writeStatus: 'create',
          }],
        });
      }),
      plan: () => {
        options.events.push('execution-plan');
        return Promise.resolve(options.executionPlan ?? executionPlan());
      },
    },
    planningProjector: {
      apply: options.planningApply ?? ((plan) => {
        options.events.push('planning-apply');
        return Promise.resolve({
          planFingerprint: plan.planFingerprint,
          projectId: plan.projectId,
          writes: [{
            documentKind: 'product-spec',
            sourceRevision: SOURCE_REVISION,
            target: PLANNING_TARGET,
            writeStatus: 'create',
          }],
        });
      }),
      plan: () => {
        options.events.push('planning-plan');
        return Promise.resolve(options.planningPlan ?? planningPlan());
      },
    },
  };
}

describe('project sync orchestration', () => {
  it('returns deterministic dry-run summaries only after both sanitized plans complete', async () => {
    const events: string[] = [];
    const service = createProjectSyncService(ports({ events }));

    const first = await service.sync({ ...input, dryRun: true });
    const second = await service.sync({ ...input, dryRun: true });

    expect(first).toEqual(second);
    expect(events).toEqual([
      'planning-plan',
      'execution-plan',
      'planning-plan',
      'execution-plan',
    ]);
    expect(first).toMatchObject({
      appliedCount: 0,
      dryRun: true,
      execution: { counts: { include: 1 }, planFingerprint: EXECUTION_FINGERPRINT },
      partial: false,
      planning: {
        counts: { include: 1 },
        entries: [{
          security: {
            decision: 'include',
            summaries: [{ count: 1, ruleId: 'credential.provider.openai' }],
          },
          target: PLANNING_TARGET,
          writeStatus: 'create',
        }],
        planFingerprint: PLANNING_FINGERPRINT,
      },
      remainingCount: 2,
      schemaVersion: 'buildlore.project-sync.v1',
      writes: [],
    });
    expect(JSON.stringify(first)).not.toContain('/not-exposed');
  });

  it('[V13-V-03] returns a successful partial summary for bounded planning warnings', async () => {
    const events: string[] = [];
    const service = createProjectSyncService(ports({
      events,
      planningPlan: planningPlan({
        compatibilityWarnings: [{
          code: 'p2a-additive-field-ignored',
          fieldName: 'future_summary',
          sourceArtifact: 'iterations/v1/gate-b-spec/spec.json',
        }],
      }),
    }));

    await expect(service.sync({ ...input, dryRun: true })).resolves.toMatchObject({
      appliedCount: 0,
      partial: true,
      warnings: [{
        code: 'p2a-additive-field-ignored',
        fieldName: 'future_summary',
        sourceKind: 'planning',
        sourceRef: 'iterations/v1/gate-b-spec/spec.json',
      }],
      writes: [],
    });
    expect(events).toEqual(['planning-plan', 'execution-plan']);
  });

  it('[V13-EDGE-06] treats a warning-only empty planning candidate set as partial success', async () => {
    const events: string[] = [];
    const service = createProjectSyncService(ports({
      events,
      planningPlan: {
        ...planningPlan(),
        compatibilityWarnings: [{
          code: 'p2a-document-compatibility-excluded',
          sourceArtifact: 'iterations/v1/gate-b-spec/spec.json',
        }],
        counts: { blocked: 0, error: 0, exclude: 0, include: 0, quarantine: 0 },
        entries: [],
      },
    }));

    await expect(service.sync({ ...input, dryRun: true })).resolves.toMatchObject({
      partial: true,
      planning: { counts: { include: 0 } },
      warnings: [{ code: 'p2a-document-compatibility-excluded' }],
    });
    expect(events).toEqual(['planning-plan', 'execution-plan']);
  });

  it('[V13-V-03] keeps a thrown planning projection failure as SYNC_PLAN_FAILED', async () => {
    const events: string[] = [];
    const planningProjector: PlanningProjectorPort = {
      apply: () => Promise.reject(new Error('apply must not run')),
      plan: () => {
        events.push('planning-plan');
        return Promise.reject(new Error('projection-value-must-not-be-reflected'));
      },
    };
    const service = createProjectSyncService({
      ...ports({ events }),
      planningProjector,
    });

    let failure: unknown;
    try {
      await service.sync({ ...input, dryRun: true });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'SYNC_PLAN_FAILED',
      failedPhase: 'planning-plan',
    });
    expect(JSON.stringify(failure)).not.toContain('projection-value-must-not-be-reflected');
    expect(events).toEqual(['planning-plan']);
  });

  it('[V13-V-08] sorts and deduplicates planning warning tuples', async () => {
    const events: string[] = [];
    const repeated = {
      code: 'p2a-additive-field-ignored' as const,
      fieldName: 'future_summary',
      sourceArtifact: 'iterations/v1/gate-b-spec/spec.json',
    };
    const service = createProjectSyncService(ports({
      events,
      planningPlan: planningPlan({
        compatibilityWarnings: [repeated, { ...repeated }],
      }),
    }));

    await expect(service.sync({ ...input, dryRun: true })).resolves.toMatchObject({
      partial: true,
      warnings: [{
        code: repeated.code,
        fieldName: repeated.fieldName,
        sourceKind: 'planning',
        sourceRef: repeated.sourceArtifact,
      }],
    });
    expect(events).toEqual(['planning-plan', 'execution-plan']);
  });

  it('[V13-V-07] rejects extra warning fields without reflecting their values', async () => {
    const events: string[] = [];
    const invalidWarning = {
      code: 'p2a-additive-field-ignored' as const,
      sourceArtifact: 'iterations/v1/gate-b-spec/spec.json',
      unexpected: 'warning-value-must-not-be-reflected',
    };
    const service = createProjectSyncService(ports({
      events,
      planningPlan: {
        ...planningPlan(),
        compatibilityWarnings: [invalidWarning],
      },
    }));

    let failure: unknown;
    try {
      await service.sync({ ...input, dryRun: true });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'SYNC_PLAN_FAILED',
      failedPhase: 'planning-plan',
    });
    expect(JSON.stringify(failure)).not.toContain(invalidWarning.unexpected);
    expect(events).toEqual(['planning-plan']);
  });

  it('[V13-V-05] rejects credential-like warning field names without reflecting them', async () => {
    const events: string[] = [];
    const credentialLikeField = 'accessToken';
    const service = createProjectSyncService(ports({
      events,
      planningPlan: planningPlan({
        compatibilityWarnings: [{
          code: 'p2a-additive-field-ignored',
          fieldName: credentialLikeField,
          sourceArtifact: 'iterations/v1/gate-b-spec/spec.json',
        }],
      }),
    }));

    let failure: unknown;
    try {
      await service.sync({ ...input, dryRun: true });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'SYNC_PLAN_FAILED',
      failedPhase: 'planning-plan',
    });
    expect(JSON.stringify(failure)).not.toContain(credentialLikeField);
    expect(events).toEqual(['planning-plan']);
  });

  it('[V13-V-05] rejects absolute warning source refs without reflecting them', async () => {
    const events: string[] = [];
    const unsafeSource = '/private/location/value-must-not-be-reflected.json';
    const service = createProjectSyncService(ports({
      events,
      planningPlan: planningPlan({
        compatibilityWarnings: [{
          code: 'p2a-additive-field-ignored',
          sourceArtifact: unsafeSource,
        }],
      }),
    }));

    let failure: unknown;
    try {
      await service.sync({ ...input, dryRun: true });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'SYNC_PLAN_FAILED',
      failedPhase: 'planning-plan',
    });
    expect(JSON.stringify(failure)).not.toContain(unsafeSource);
    expect(events).toEqual(['planning-plan']);
  });

  it('[V13-V-08] rejects more than 31 detailed warnings without an overflow marker', async () => {
    const events: string[] = [];
    const service = createProjectSyncService(ports({
      events,
      planningPlan: planningPlan({
        compatibilityWarnings: Array.from({ length: 32 }, (_, index) => ({
          code: 'p2a-additive-field-ignored' as const,
          fieldName: `future_${String(index).padStart(2, '0')}`,
          sourceArtifact: 'iterations/v1/gate-b-spec/spec.json',
        })),
      }),
    }));

    await expect(service.sync({ ...input, dryRun: true })).rejects.toMatchObject({
      code: 'SYNC_PLAN_FAILED',
      failedPhase: 'planning-plan',
    });
    expect(events).toEqual(['planning-plan']);
  });

  it('plans both producers and rejects a secret-blocked plan before either apply', async () => {
    const events: string[] = [];
    const service = createProjectSyncService(ports({
      events,
      planningPlan: planningPlan({ blocked: true }),
    }));

    let failure: unknown;
    try {
      await service.sync(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProjectSyncError);
    expect(failure).toMatchObject({
      code: 'SYNC_PLAN_BLOCKED',
      completedTargets: [],
      failedPhase: 'planning-plan',
      partial: false,
      recoveryAction: 'inspect-plan',
    });
    expect(events).toEqual(['planning-plan', 'execution-plan']);
    expect(JSON.stringify(failure)).not.toContain('do-not-reflect');
    expect(JSON.stringify(failure)).not.toContain('stack');
  });

  it('rejects cross-plan target collisions without applying either plan', async () => {
    const events: string[] = [];
    const service = createProjectSyncService(ports({
      events,
      executionPlan: executionPlan({ target: PLANNING_TARGET }),
    }));

    await expect(service.sync(input)).rejects.toMatchObject({
      code: 'SYNC_TARGET_COLLISION',
      failedPhase: 'execution-plan',
      partial: false,
    });
    expect(events).toEqual(['planning-plan', 'execution-plan']);
  });

  it('reports conservative partial progress and converges on a fresh retry', async () => {
    const events: string[] = [];
    let failExecution = true;
    let planningApplyCount = 0;
    const configured = ports({
      events,
      executionApply: (plan) => {
        events.push('execution-apply');
        if (failExecution) {
          failExecution = false;
          return Promise.reject(new Error('token=do-not-reflect'));
        }
        return Promise.resolve({
          planFingerprint: plan.planFingerprint,
          projectId: plan.projectId,
          writes: [{
            sourceRevision: SOURCE_REVISION,
            target: EXECUTION_TARGET,
            taskStableId: 'a'.repeat(64),
            writeStatus: 'create',
          }],
        });
      },
      planningApply: (plan) => {
        events.push('planning-apply');
        planningApplyCount += 1;
        return Promise.resolve({
          planFingerprint: plan.planFingerprint,
          projectId: plan.projectId,
          writes: [{
            documentKind: 'product-spec',
            sourceRevision: SOURCE_REVISION,
            target: PLANNING_TARGET,
            writeStatus: planningApplyCount === 1 ? 'create' : 'unchanged',
          }],
        });
      },
    });
    const service = createProjectSyncService(configured);

    let failure: unknown;
    try {
      await service.sync(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'SYNC_APPLY_FAILED',
      completedTargets: [PLANNING_TARGET],
      failedPhase: 'execution-apply',
      partial: true,
      recoveryAction: 'retry-sync',
    });
    expect(JSON.stringify(failure)).not.toContain('do-not-reflect');

    await expect(service.sync(input)).resolves.toMatchObject({
      appliedCount: 1,
      partial: false,
      remainingCount: 0,
      writes: [
        { sourceKind: 'planning', writeStatus: 'unchanged' },
        { sourceKind: 'execution', writeStatus: 'create' },
      ],
    });
    expect(events).toEqual([
      'planning-plan',
      'execution-plan',
      'planning-apply',
      'execution-apply',
      'planning-plan',
      'execution-plan',
      'planning-apply',
      'execution-apply',
    ]);
  });

  it('marks a planning writer failure partial without running execution apply', async () => {
    const events: string[] = [];
    const service = createProjectSyncService(ports({
      events,
      planningApply: () => {
        events.push('planning-apply');
        return Promise.reject(new Error('writer failed'));
      },
    }));

    await expect(service.sync(input)).rejects.toMatchObject({
      code: 'SYNC_APPLY_FAILED',
      completedTargets: [],
      failedPhase: 'planning-apply',
      partial: true,
    });
    expect(events).toEqual(['planning-plan', 'execution-plan', 'planning-apply']);
  });
});
