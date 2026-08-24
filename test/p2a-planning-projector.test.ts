import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectCompiler } from '../src/compiler/index.js';
import { addProject } from '../src/knowledge/index.js';
import {
  createP2aPlanningProjector,
  parseSourceDocument,
} from '../src/projector/index.js';
import type { ProjectionError } from '../src/projector/index.js';
import { createP2aArtifactAdapter } from '../src/projector/p2a-artifacts.js';
import { validateP2aCurrentSpec } from '../src/projector/p2a-codecs.js';
import { createProjectSourceWriter } from '../src/projector/project-source-writer.js';
import { startFakeOpenAiServer } from './fixtures/fake-openai.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const temporaryRoots: string[] = [];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ApprovalEvent {
  readonly at: string;
  readonly scope_ref: string;
  readonly sha256: string;
}

function decisionRecords(
  events: readonly ApprovalEvent[],
  existing: readonly Readonly<Record<string, unknown>>[] = [],
): readonly Readonly<Record<string, unknown>>[] {
  const records = [...existing];
  let previousHash = records.length === 0
    ? null
    : digest(JSON.stringify(records.at(-1)));
  for (const event of events) {
    const record = {
      seq: records.length + 1,
      at: event.at,
      scope_ref: event.scope_ref,
      sha256: event.sha256,
      type: 'gate.what.approved',
      quote: 'approved fixture',
      prev_sha256: previousHash,
    };
    records.push(record);
    previousHash = digest(JSON.stringify(record));
  }
  return records;
}

function serializeDecisions(records: readonly Readonly<Record<string, unknown>>[]): string {
  return `${records.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

async function fixture(options: {
  readonly archived?: boolean;
  readonly intakeApprovalAt?: string;
  readonly promotedAt?: string;
  readonly specApprovalAt?: string;
} = {}): Promise<{
  readonly artifactRoot: string;
  readonly currentSpecPath: string;
  readonly decisionsPath: string;
  readonly intakePath: string;
  readonly knowledgeRoot: string;
  readonly specPath: string;
  readonly workspace: string;
}> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-p2a-projector-'));
  temporaryRoots.push(root);
  const artifactRoot = join(root, 'artifacts');
  const knowledgeRoot = join(root, 'knowledge');
  const iterationRoot = join(artifactRoot, 'iterations', 'v1-source-contract');
  await Promise.all([
    mkdir(join(iterationRoot, 'gate-a-intake'), { recursive: true }),
    mkdir(join(iterationRoot, 'gate-b-spec'), { recursive: true }),
    mkdir(join(iterationRoot, 'gate-c-task-graph'), { recursive: true }),
    mkdir(join(artifactRoot, 'iterations', 'maintenance'), { recursive: true }),
    mkdir(knowledgeRoot, { recursive: true }),
  ]);
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });

  const intakePath = 'iterations/v1-source-contract/gate-a-intake/intake.json';
  const specRelativePath = 'iterations/v1-source-contract/gate-b-spec/spec.json';
  const taskPath = 'iterations/v1-source-contract/gate-c-task-graph/task-graph.json';
  const intake = canonicalJson({
    assumptions: [],
    clarifying_questions: [],
    evidence: [],
    idea: 'SourceDocument projection',
    known_facts: ['Canonical JSON is authoritative.'],
    needs_user_decision: [],
    schema_version: 'p2a.intake.v1',
    status: 'ready_for_spec',
    summary: 'Project approved planning artifacts into compiler sources.',
  });
  const spec = canonicalJson({
    approval: 'approved',
    clarifying_question_disposition: [],
    evidence: [],
    implementation: {
      architecture: ['Keep the projector boundary explicit.'],
      data_flow: ['Read, sanitize, then persist.'],
      dependencies: ['Use exact dependencies.'],
      edge_cases: ['Reject drift.'],
      interfaces: ['Expose a library port.'],
      verification: ['Run deterministic tests.'],
    },
    open_decisions: [],
    product: {
      constraints: ['Remain local-first.'],
      core_flows: ['Plan before apply.'],
      data_model_draft: ['SourceDocument v1.'],
      external_integrations: ['P2A JSON artifacts.'],
      goals: ['Generate stable planning sources.'],
      must_preserve: ['Project isolation.'],
      non_goals: ['No end-user CLI.'],
      problem: 'Approved planning JSON is not compiler-readable.',
      screens_or_interfaces: ['PlanningProjectorPort.'],
      success_criteria: ['Second apply is unchanged.'],
      target_users: ['BuildLore operators.'],
    },
    project_id: 'alpha',
    schema_version: 'p2a.spec.v1',
    source_intake: '../gate-a-intake/intake.json',
    source_intake_sha256: digest(intake),
  });
  const decisions = decisionRecords([
    {
      at: options.intakeApprovalAt ?? '2026-08-19T01:00:00.000Z',
      scope_ref: intakePath,
      sha256: digest(intake),
    },
    {
      at: options.specApprovalAt ?? '2026-08-19T02:00:00.000Z',
      scope_ref: specRelativePath,
      sha256: digest(spec),
    },
  ]);
  const taskGraph = '{}\n';
  const closedAt = '2026-08-19T03:00:00.000Z';
  const closedIteration = {
    artifact_hashes: {
      [intakePath]: { present: true, sha256: digest(intake) },
      [specRelativePath]: { present: true, sha256: digest(spec) },
      [taskPath]: { present: true, sha256: digest(taskGraph) },
    },
    closed_at: closedAt,
    effective_spec_ref: specRelativePath,
    iteration_id: 'v1-source-contract',
    spec_ref: specRelativePath,
    status: 'archived',
    task_count: 1,
    task_graph_ref: taskPath,
    task_status_counts: { blocked: 0, done: 1, in_progress: 0, todo: 0 },
  };
  const specPath = join(artifactRoot, ...specRelativePath.split('/'));
  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  const decisionsPath = join(artifactRoot, 'decisions.jsonl');
  await Promise.all([
    writeFile(currentSpecPath, canonicalJson({
      active_iteration: 'v1-source-contract',
      closed_iterations: options.archived === true ? [closedIteration] : [],
      project_id: 'alpha',
      schema_version: 'p2a.current_spec.v1',
    }), 'utf8'),
    writeFile(decisionsPath, serializeDecisions(decisions), 'utf8'),
    writeFile(join(artifactRoot, ...intakePath.split('/')), intake, 'utf8'),
    writeFile(specPath, spec, 'utf8'),
    writeFile(join(iterationRoot, 'iteration.json'), canonicalJson({
      idea: 'SourceDocument projection',
      iteration_id: 'v1-source-contract',
      project_id: 'alpha',
      ...(options.promotedAt === undefined ? {} : { promoted_at: options.promotedAt }),
      schema_version: 'p2a.iteration_metadata.v1',
      ...(options.archived === true ? { close: closedIteration, closed_at: closedAt } : {}),
      status: options.archived === true ? 'archived' : 'gate_b_approved',
    }), 'utf8'),
    writeFile(join(iterationRoot, 'gate-b-spec', 'product-spec.md'), '# duplicate\n', 'utf8'),
    writeFile(join(iterationRoot, 'gate-c-task-graph', 'task-graph.json'), taskGraph, 'utf8'),
    writeFile(join(artifactRoot, 'iterations', 'maintenance', 'README.md'), '# maintenance\n', 'utf8'),
  ]);
  return {
    artifactRoot,
    currentSpecPath,
    decisionsPath,
    intakePath: join(artifactRoot, ...intakePath.split('/')),
    knowledgeRoot,
    specPath,
    workspace: join(knowledgeRoot, 'projects', 'alpha'),
  };
}

async function addFeatureIteration(
  item: Awaited<ReturnType<typeof fixture>>,
  iterationId: string,
  status: 'draft' | 'gate_b_approved',
): Promise<void> {
  const iterationRoot = join(item.artifactRoot, 'iterations', iterationId);
  await Promise.all([
    mkdir(join(iterationRoot, 'gate-a-intake'), { recursive: true }),
    mkdir(join(iterationRoot, 'gate-b-spec'), { recursive: true }),
  ]);
  const intake = await readFile(item.intakePath, 'utf8');
  const sourceSpec = JSON.parse(await readFile(item.specPath, 'utf8')) as Record<string, unknown>;
  const spec = canonicalJson({
    ...sourceSpec,
    approval: status === 'draft' ? 'draft' : 'approved',
    source_intake_sha256: digest(intake),
  });
  const intakeRelative = `iterations/${iterationId}/gate-a-intake/intake.json`;
  const specRelative = `iterations/${iterationId}/gate-b-spec/spec.json`;
  await Promise.all([
    writeFile(join(item.artifactRoot, ...intakeRelative.split('/')), intake, 'utf8'),
    writeFile(join(item.artifactRoot, ...specRelative.split('/')), spec, 'utf8'),
    writeFile(join(iterationRoot, 'iteration.json'), canonicalJson({
      idea: `Feature ${iterationId}`,
      iteration_id: iterationId,
      project_id: 'alpha',
      schema_version: 'p2a.iteration_metadata.v1',
      status,
    }), 'utf8'),
  ]);
  if (status === 'gate_b_approved') {
    const ledger = (await readFile(item.decisionsPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
    const additions = [
      {
        at: '2026-08-19T04:00:00.000Z',
        scope_ref: intakeRelative,
        sha256: digest(intake),
      },
      {
        at: '2026-08-19T05:00:00.000Z',
        scope_ref: specRelative,
        sha256: digest(spec),
      },
    ];
    await writeFile(
      item.decisionsPath,
      serializeDecisions(decisionRecords(additions, ledger)),
      'utf8',
    );
    const current = JSON.parse(
      await readFile(item.currentSpecPath, 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(item.currentSpecPath, canonicalJson({
      ...current,
      active_iteration: iterationId,
    }), 'utf8');
  }
}

async function rewriteApprovedSpec(
  item: Awaited<ReturnType<typeof fixture>>,
  update: (spec: Record<string, unknown>) => void,
): Promise<string> {
  const intake = await readFile(item.intakePath, 'utf8');
  const spec = JSON.parse(await readFile(item.specPath, 'utf8')) as Record<string, unknown>;
  update(spec);
  const specBytes = canonicalJson(spec);
  await Promise.all([
    writeFile(item.specPath, specBytes, 'utf8'),
    writeFile(item.decisionsPath, serializeDecisions(decisionRecords([
      {
        at: '2026-08-19T01:00:00.000Z',
        scope_ref: 'iterations/v1-source-contract/gate-a-intake/intake.json',
        sha256: digest(intake),
      },
      {
        at: '2026-08-19T02:00:00.000Z',
        scope_ref: 'iterations/v1-source-contract/gate-b-spec/spec.json',
        sha256: digest(specBytes),
      },
    ])), 'utf8'),
  ]);
  return specBytes;
}

async function rewriteApprovedIntake(
  item: Awaited<ReturnType<typeof fixture>>,
  update: (intake: Record<string, unknown>) => void,
): Promise<void> {
  const intake = JSON.parse(await readFile(item.intakePath, 'utf8')) as Record<string, unknown>;
  update(intake);
  const intakeBytes = canonicalJson(intake);
  const spec = JSON.parse(await readFile(item.specPath, 'utf8')) as Record<string, unknown>;
  spec.source_intake_sha256 = digest(intakeBytes);
  const specBytes = canonicalJson(spec);
  await Promise.all([
    writeFile(item.intakePath, intakeBytes, 'utf8'),
    writeFile(item.specPath, specBytes, 'utf8'),
    writeFile(item.decisionsPath, serializeDecisions(decisionRecords([
      {
        at: '2026-08-19T01:00:00.000Z',
        scope_ref: 'iterations/v1-source-contract/gate-a-intake/intake.json',
        sha256: digest(intakeBytes),
      },
      {
        at: '2026-08-19T02:00:00.000Z',
        scope_ref: 'iterations/v1-source-contract/gate-b-spec/spec.json',
        sha256: digest(specBytes),
      },
    ])), 'utf8'),
  ]);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('P2A planning projector', () => {
  it('uses explicitly injected artifact-reader and source-writer ports', async () => {
    const item = await fixture();
    const defaultReader = createP2aArtifactAdapter();
    let reads = 0;
    let verifications = 0;
    let writers = 0;
    const projector = createP2aPlanningProjector({
      artifactReader: {
        read(input, repository) {
          reads += 1;
          return defaultReader.read(input, repository);
        },
        verify(artifactRoot, bindings, scannedFiles) {
          verifications += 1;
          return defaultReader.verify(artifactRoot, bindings, scannedFiles);
        },
      },
      sourceWriter: {
        create(workspace, projectId) {
          writers += 1;
          return createProjectSourceWriter(workspace, projectId);
        },
      },
    });
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    await projector.apply(plan);

    expect({ reads, verifications, writers }).toEqual({
      reads: 1,
      verifications: 2,
      writers: 2,
    });
  });

  it('plans from approved canonical JSON without writing or invoking a sanitizer', async () => {
    const item = await fixture();
    const projector = createP2aPlanningProjector();
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    const sourceFiles = await readdir(join(item.workspace, 'sources'));

    expect(sourceFiles).toEqual([]);
    expect(plan.counts).toEqual({ blocked: 0, error: 0, exclude: 6, include: 3, quarantine: 0 });
    expect(plan.entries.filter((entry) => entry.decision === 'include')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCode: 'approved_product_spec', writeStatus: 'create' }),
        expect.objectContaining({ reasonCode: 'approved_implementation_plan', writeStatus: 'create' }),
        expect.objectContaining({ reasonCode: 'approved_intake', writeStatus: 'create' }),
      ]),
    );
    expect(plan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'duplicate_copy' }),
      expect.objectContaining({ reasonCode: 'maintenance' }),
      expect.objectContaining({ reasonCode: 'task_or_run' }),
    ]));
  });

  it('[V13-V-01] validates Gate B promotion bindings without rendering them', async () => {
    const promotedAt = '2026-08-19T02:30:00.000Z';
    const item = await fixture({ promotedAt });
    const specBytes = await readFile(item.specPath, 'utf8');
    const current = JSON.parse(
      await readFile(item.currentSpecPath, 'utf8'),
    ) as Record<string, unknown>;
    current.gate_b_promotion_bindings = {
      'v1-source-contract': {
        promoted_at: promotedAt,
        source_spec_ref: 'iterations/v1-source-contract/gate-b-spec/spec.json',
        source_spec_sha256: digest(specBytes),
      },
    };
    await writeFile(item.currentSpecPath, canonicalJson(current), 'utf8');

    const projector = createP2aPlanningProjector();
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.compatibilityWarnings).toEqual([]);
    await projector.apply(plan);
    const generated = await Promise.all(
      (await readdir(join(item.workspace, 'sources')))
        .map(async (file) => readFile(join(item.workspace, 'sources', file), 'utf8')),
    );
    expect(generated.join('\n')).not.toContain('gate_b_promotion_bindings');

    const invalid = JSON.parse(
      await readFile(item.currentSpecPath, 'utf8'),
    ) as Record<string, unknown>;
    const bindings = invalid.gate_b_promotion_bindings as Record<string, Record<string, unknown>>;
    const binding = bindings['v1-source-contract'];
    if (binding === undefined) throw new Error('promotion binding is missing');
    binding.source_spec_sha256 = '0'.repeat(64);
    await writeFile(item.currentSpecPath, canonicalJson(invalid), 'utf8');
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
  });

  it('[V13-V-01] enforces the complete Gate B promotion binding structure', () => {
    const iterationId = 'v1-source-contract';
    const binding = {
      promoted_at: '2026-08-19T02:30:00.000Z',
      source_spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
      source_spec_sha256: 'a'.repeat(64),
    };
    const current = (gateBPromotionBindings?: unknown): Record<string, unknown> => ({
      closed_iterations: [],
      ...(gateBPromotionBindings === undefined
        ? {}
        : { gate_b_promotion_bindings: gateBPromotionBindings }),
      project_id: 'alpha',
      schema_version: 'p2a.current_spec.v1',
    });

    expect(validateP2aCurrentSpec(current(), 'alpha').gateBPromotionBindings.size).toBe(0);
    expect(validateP2aCurrentSpec(current({ [iterationId]: binding }), 'alpha')
      .gateBPromotionBindings.size).toBe(1);

    const boundaryIterationId = 'a'.repeat(120);
    expect(validateP2aCurrentSpec(current({
      [boundaryIterationId]: {
        ...binding,
        source_spec_ref: `iterations/${boundaryIterationId}/gate-b-spec/spec.json`,
      },
    }), 'alpha').gateBPromotionBindings.size).toBe(1);

    const invalidBindings: readonly unknown[] = [
      [],
      { ['a'.repeat(121)]: binding },
      { 'V1-unsafe': binding },
      { [iterationId]: { ...binding, unexpected: true } },
      {
        [iterationId]: {
          promoted_at: binding.promoted_at,
          source_spec_ref: binding.source_spec_ref,
        },
      },
      { [iterationId]: { ...binding, source_spec_ref: 'iterations/other/spec.json' } },
      { [iterationId]: { ...binding, source_spec_sha256: 'A'.repeat(64) } },
      { [iterationId]: { ...binding, promoted_at: '2026-08-19T02:30:00Z' } },
    ];
    for (const invalid of invalidBindings) {
      expect(() => validateP2aCurrentSpec(current(invalid), 'alpha')).toThrowError(
        expect.objectContaining({ code: 'PROJECTION_ARTIFACT_INVALID' }),
      );
    }
  });

  it('[V13-V-01] cross-checks binding promotion time and iteration existence', async () => {
    const promotedAt = '2026-08-19T02:30:00.000Z';
    const drifted = await fixture({ promotedAt });
    const specBytes = await readFile(drifted.specPath, 'utf8');
    const current = JSON.parse(
      await readFile(drifted.currentSpecPath, 'utf8'),
    ) as Record<string, unknown>;
    current.gate_b_promotion_bindings = {
      'v1-source-contract': {
        promoted_at: promotedAt,
        source_spec_ref: 'iterations/v1-source-contract/gate-b-spec/spec.json',
        source_spec_sha256: digest(specBytes),
      },
    };
    const iterationPath = join(
      drifted.artifactRoot,
      'iterations/v1-source-contract/iteration.json',
    );
    const iteration = JSON.parse(await readFile(iterationPath, 'utf8')) as Record<string, unknown>;
    iteration.promoted_at = '2026-08-19T02:31:00.000Z';
    await Promise.all([
      writeFile(drifted.currentSpecPath, canonicalJson(current), 'utf8'),
      writeFile(iterationPath, canonicalJson(iteration), 'utf8'),
    ]);
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: drifted.artifactRoot,
      knowledgeRoot: drifted.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });

    const missing = await fixture();
    const missingCurrent = JSON.parse(
      await readFile(missing.currentSpecPath, 'utf8'),
    ) as Record<string, unknown>;
    missingCurrent.gate_b_promotion_bindings = {
      'v2-missing': {
        promoted_at: promotedAt,
        source_spec_ref: 'iterations/v2-missing/gate-b-spec/spec.json',
        source_spec_sha256: 'a'.repeat(64),
      },
    };
    await writeFile(missing.currentSpecPath, canonicalJson(missingCurrent), 'utf8');
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: missing.artifactRoot,
      knowledgeRoot: missing.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
  });

  it('[V13-V-01][V13-V-07] rejects duplicate keys, invalid JSON, and invalid UTF-8', async () => {
    const duplicate = await fixture();
    const binding = JSON.stringify({
      promoted_at: '2026-08-19T02:30:00.000Z',
      source_spec_ref: 'iterations/v1-source-contract/gate-b-spec/spec.json',
      source_spec_sha256: 'a'.repeat(64),
    });
    await writeFile(duplicate.currentSpecPath, [
      '{',
      '  "schema_version": "p2a.current_spec.v1",',
      '  "project_id": "alpha",',
      '  "closed_iterations": [],',
      '  "gate_b_promotion_bindings": {',
      `    "v1-source-contract": ${binding},`,
      `    "v1-source-contract": ${binding}`,
      '  }',
      '}',
      '',
    ].join('\n'), 'utf8');
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: duplicate.artifactRoot,
      knowledgeRoot: duplicate.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });

    const invalidJson = await fixture();
    await writeFile(invalidJson.currentSpecPath, '{"schema_version":', 'utf8');
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: invalidJson.artifactRoot,
      knowledgeRoot: invalidJson.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });

    const invalidUtf8 = await fixture();
    await writeFile(invalidUtf8.currentSpecPath, Buffer.from([0xc3, 0x28]));
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: invalidUtf8.artifactRoot,
      knowledgeRoot: invalidUtf8.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
  });

  it('[V13-V-01] keeps unknown control-plane fields fail closed', async () => {
    const item = await fixture();
    const current = JSON.parse(
      await readFile(item.currentSpecPath, 'utf8'),
    ) as Record<string, unknown>;
    current.approval_override = true;
    await writeFile(item.currentSpecPath, canonicalJson(current), 'utf8');

    await expect(createP2aPlanningProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
  });

  it('[V13-V-02] warns on safe additive content without rendering unknown values', async () => {
    const item = await fixture();
    const sentinel = 'unknown-value-must-not-be-rendered';
    await rewriteApprovedSpec(item, (spec) => {
      const product = spec.product;
      const implementation = spec.implementation;
      if (!isRecord(product) || !isRecord(implementation)) {
        throw new Error('fixture spec views are invalid');
      }
      product.future_summary = { value: sentinel };
      implementation.future_rollout = { value: `${sentinel}-implementation` };
    });

    const projector = createP2aPlanningProjector();
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.counts.include).toBe(3);
    expect(plan.compatibilityWarnings).toEqual([
      {
        code: 'p2a-additive-field-ignored',
        fieldName: 'future_rollout',
        sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
      },
      {
        code: 'p2a-additive-field-ignored',
        fieldName: 'future_summary',
        sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain(sentinel);

    await projector.apply(plan);
    const generated = await Promise.all(
      (await readdir(join(item.workspace, 'sources')))
        .map(async (file) => readFile(join(item.workspace, 'sources', file), 'utf8')),
    );
    expect(generated.join('\n')).not.toContain(sentinel);
    expect(generated.join('\n')).not.toContain('future_rollout');
    expect(generated.join('\n')).not.toContain('future_summary');
  });

  it('[V13-V-02] strips additive intake values before sanitization and rendering', async () => {
    const item = await fixture();
    const sentinel = 'intake-extension-must-not-be-rendered';
    await rewriteApprovedIntake(item, (intake) => {
      intake.assumptions = [1, 2].map((index) => ({
        confirmation_needed: false,
        future_assumption: `${sentinel}-assumption-${index}`,
        id: `A-${index}`,
        risk: 'low',
        statement: `Known assumption text ${index}.`,
      }));
      intake.clarifying_questions = [{
        answer: 'Known answer.',
        blocks: [],
        future_question: `${sentinel}-question`,
        id: 'CQ-1',
        question: 'Known question?',
        status: 'answered',
        why_it_matters: 'Known reason.',
      }];
      intake.evidence = [{
        future_evidence: `${sentinel}-evidence`,
        source_id: 'LOCAL-1',
        title: 'Known evidence',
        url: '',
        used_for: 'Boundary verification',
      }];
    });

    const projector = createP2aPlanningProjector();
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.compatibilityWarnings).toEqual([
      {
        code: 'p2a-additive-field-ignored',
        fieldName: 'future_assumption',
        sourceArtifact: 'iterations/v1-source-contract/gate-a-intake/intake.json',
      },
      {
        code: 'p2a-additive-field-ignored',
        fieldName: 'future_evidence',
        sourceArtifact: 'iterations/v1-source-contract/gate-a-intake/intake.json',
      },
      {
        code: 'p2a-additive-field-ignored',
        fieldName: 'future_question',
        sourceArtifact: 'iterations/v1-source-contract/gate-a-intake/intake.json',
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain(sentinel);

    await projector.apply(plan);
    const generated = await Promise.all(
      (await readdir(join(item.workspace, 'sources')))
        .map(async (file) => readFile(join(item.workspace, 'sources', file), 'utf8')),
    );
    expect(generated.join('\n')).not.toContain(sentinel);
    expect(generated.join('\n')).not.toContain('future_assumption');
    expect(generated.join('\n')).not.toContain('future_evidence');
    expect(generated.join('\n')).not.toContain('future_question');
  });

  it.each([31, 32, 33])(
    '[V13-V-08] bounds %i compatibility warnings with an overflow marker',
    async (warningCount) => {
      const item = await fixture();
      await rewriteApprovedSpec(item, (spec) => {
        const product = spec.product;
        if (!isRecord(product)) {
          throw new Error('fixture product is invalid');
        }
        for (let index = warningCount - 1; index >= 0; index -= 1) {
          product[`future_${String(index).padStart(2, '0')}`] = `ignored-${index}`;
        }
      });

      const plan = await createP2aPlanningProjector().plan({
        artifactRoot: item.artifactRoot,
        knowledgeRoot: item.knowledgeRoot,
        projectId: 'alpha',
      });
      expect(plan.compatibilityWarnings).toHaveLength(warningCount <= 31 ? warningCount : 32);
      expect(plan.compatibilityWarnings.filter((warning) =>
        warning.code === 'p2a-additive-field-ignored')).toHaveLength(
        Math.min(warningCount, 31),
      );
      expect(plan.compatibilityWarnings
        .filter((warning) => warning.fieldName !== undefined)
        .map((warning) => warning.fieldName)).toEqual(
        Array.from({ length: Math.min(warningCount, 31) }, (_, index) =>
          `future_${String(index).padStart(2, '0')}`),
      );
      expect(plan.compatibilityWarnings.some((warning) =>
        warning.code === 'p2a-compatibility-warning-overflow')).toBe(warningCount > 31);

      const repeated = await createP2aPlanningProjector().plan({
        artifactRoot: item.artifactRoot,
        knowledgeRoot: item.knowledgeRoot,
        projectId: 'alpha',
      });
      expect(JSON.stringify(repeated)).toBe(JSON.stringify(plan));
    },
  );

  it('[V13-V-08] exposes only safe non-credential field names at 128/129 boundaries', async () => {
    const item = await fixture();
    const sentinel = 'unsafe-field-and-value-must-not-leak';
    const safeBoundary = `f${'a'.repeat(127)}`;
    const oversized = `f${'b'.repeat(128)}`;
    await rewriteApprovedSpec(item, (spec) => {
      const product = spec.product;
      if (!isRecord(product)) {
        throw new Error('fixture product is invalid');
      }
      product[safeBoundary] = `${sentinel}-safe-boundary`;
      product[oversized] = `${sentinel}-oversized`;
      product.api_key = `${sentinel}-credential-label`;
      product['api.key'] = `${sentinel}-dotted-credential-label`;
      product.accessToken = `${sentinel}-camel-credential-label`;
      product.accessKey = `${sentinel}-key-label`;
      product.jwt = `${sentinel}-jwt-label`;
      product.passwd = `${sentinel}-password-label`;
      product.sessionId = `${sentinel}-session-label`;
      product.sshKey = `${sentinel}-ssh-label`;
      product['path/name'] = `${sentinel}-path-label`;
      product['control\nname'] = `${sentinel}-control-label`;
      product['token=unsafe-field-name'] = sentinel;
    });

    const plan = await createP2aPlanningProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.compatibilityWarnings).toEqual([
      {
        code: 'p2a-additive-field-ignored',
        sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
      },
      {
        code: 'p2a-additive-field-ignored',
        fieldName: safeBoundary,
        sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain(sentinel);
    expect(JSON.stringify(plan)).not.toContain(oversized);
    expect(JSON.stringify(plan)).not.toContain('api_key');
    expect(JSON.stringify(plan)).not.toContain('api.key');
    expect(JSON.stringify(plan)).not.toContain('accessToken');
    expect(JSON.stringify(plan)).not.toContain('accessKey');
    expect(JSON.stringify(plan)).not.toContain('jwt');
    expect(JSON.stringify(plan)).not.toContain('passwd');
    expect(JSON.stringify(plan)).not.toContain('sessionId');
    expect(JSON.stringify(plan)).not.toContain('sshKey');
    expect(JSON.stringify(plan)).not.toContain('path/name');
    expect(JSON.stringify(plan)).not.toContain('control\\nname');
    expect(JSON.stringify(plan)).not.toContain('token=unsafe-field-name');
  });

  it('[V13-V-02] binds compatibility warnings independently into the plan fingerprint', async () => {
    const item = await fixture();
    const input = {
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    } as const;
    const artifactReader = createP2aArtifactAdapter();
    const baseline = await createP2aPlanningProjector({ artifactReader }).plan(input);
    const warningProjector = createP2aPlanningProjector({
      artifactReader: {
        read: async (...args) => ({
          ...await artifactReader.read(...args),
          compatibilityWarnings: [{
            code: 'p2a-additive-field-ignored',
            fieldName: 'future_summary',
            sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
          }],
        }),
        verify: (...args) => artifactReader.verify(...args),
      },
    });
    const withWarning = await warningProjector.plan(input);

    expect(withWarning.entries).toEqual(baseline.entries);
    expect(withWarning.counts).toEqual(baseline.counts);
    expect(withWarning.planFingerprint).not.toBe(baseline.planFingerprint);
  });

  it('[V13-V-03] excludes a document-local incompatibility and keeps known intake content', async () => {
    const item = await fixture();
    await rewriteApprovedSpec(item, (spec) => {
      const product = spec.product;
      if (!isRecord(product)) {
        throw new Error('fixture product is invalid');
      }
      product.goals = [42];
    });

    const plan = await createP2aPlanningProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.counts.include).toBe(1);
    expect(plan.entries).toContainEqual(expect.objectContaining({
      decision: 'exclude',
      reasonCode: 'unsupported_schema',
      sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
    }));
    expect(plan.compatibilityWarnings).toEqual([{
      code: 'p2a-document-compatibility-excluded',
      sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
    }]);
  });

  it('[V13-EDGE-02] hard-fails wrong or missing root fields beside additive content', async () => {
    const sentinel = 'root-shape-sentinel-must-not-leak';
    const wrongType = await fixture();
    await rewriteApprovedSpec(wrongType, (spec) => {
      spec.product = [];
      const implementation = spec.implementation;
      if (!isRecord(implementation)) throw new Error('fixture implementation is invalid');
      implementation.future_summary = sentinel;
    });

    const wrongTypePlan = await createP2aPlanningProjector().plan({
      artifactRoot: wrongType.artifactRoot,
      knowledgeRoot: wrongType.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(wrongTypePlan.counts).toMatchObject({ error: 1, include: 0 });
    expect(wrongTypePlan.entries).toContainEqual(expect.objectContaining({
      decision: 'error',
      reasonCode: 'unsupported_schema',
      sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
    }));
    expect(wrongTypePlan.compatibilityWarnings).toEqual([]);
    expect(JSON.stringify(wrongTypePlan)).not.toContain(sentinel);

    const missing = await fixture();
    await rewriteApprovedSpec(missing, (spec) => {
      delete spec.evidence;
      const product = spec.product;
      if (!isRecord(product)) throw new Error('fixture product is invalid');
      product.future_summary = sentinel;
    });

    const missingPlan = await createP2aPlanningProjector().plan({
      artifactRoot: missing.artifactRoot,
      knowledgeRoot: missing.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(missingPlan.counts).toMatchObject({ error: 1, include: 0 });
    expect(missingPlan.compatibilityWarnings).toEqual([]);
    expect(JSON.stringify(missingPlan)).not.toContain(sentinel);

    const intakeRoot = await fixture();
    await rewriteApprovedIntake(intakeRoot, (intake) => {
      intake.assumptions = 'wrong-root-type';
    });
    const intakeRootPlan = await createP2aPlanningProjector().plan({
      artifactRoot: intakeRoot.artifactRoot,
      knowledgeRoot: intakeRoot.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(intakeRootPlan.counts).toMatchObject({ error: 1, include: 0 });
    expect(intakeRootPlan.compatibilityWarnings).toEqual([]);
  });

  it('keeps the plan deterministic across mtime, timezone, locale, and execution changes', async () => {
    const item = await fixture();
    const projector = createP2aPlanningProjector();
    const input = {
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    } as const;
    const first = await projector.plan(input);
    await utimes(item.specPath, new Date('2001-01-01T00:00:00.000Z'), new Date());
    const previousTimezone = process.env.TZ;
    const previousLocale = process.env.LANG;
    process.env.TZ = 'Pacific/Honolulu';
    process.env.LANG = 'tr_TR.UTF-8';
    try {
      const second = await projector.plan(input);
      expect(second.planFingerprint).toBe(first.planFingerprint);
      expect(second.entries).toEqual(first.entries);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
      if (previousLocale === undefined) delete process.env.LANG;
      else process.env.LANG = previousLocale;
    }
  });

  it('fails closed on project, schema, open-decision, and intake-lineage drift', async () => {
    const wrongProject = await fixture();
    await addProject(wrongProject.knowledgeRoot, {
      displayName: 'Beta',
      projectId: 'beta',
      sourceRepository: 'https://example.test/beta.git',
    });
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: wrongProject.artifactRoot,
      knowledgeRoot: wrongProject.knowledgeRoot,
      projectId: 'beta',
    })).rejects.toMatchObject({ code: 'PROJECTION_PROJECT_MISMATCH' });

    const wrongSchema = await fixture();
    const wrongSchemaSpec = JSON.parse(
      await readFile(wrongSchema.specPath, 'utf8'),
    ) as Record<string, unknown>;
    wrongSchemaSpec.schema_version = 'p2a.spec.v2';
    await writeFile(wrongSchema.specPath, canonicalJson(wrongSchemaSpec), 'utf8');
    const schemaPlan = await createP2aPlanningProjector().plan({
      artifactRoot: wrongSchema.artifactRoot,
      knowledgeRoot: wrongSchema.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(schemaPlan.entries).toContainEqual(expect.objectContaining({
      decision: 'error',
      reasonCode: 'unsupported_schema',
      sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
    }));

    const openDecision = await fixture();
    const openSpec = JSON.parse(await readFile(openDecision.specPath, 'utf8')) as Record<string, unknown>;
    openSpec.open_decisions = [{ id: 'ND-1', status: 'open' }];
    await writeFile(openDecision.specPath, canonicalJson(openSpec), 'utf8');
    const openPlan = await createP2aPlanningProjector().plan({
      artifactRoot: openDecision.artifactRoot,
      knowledgeRoot: openDecision.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(openPlan.entries).toContainEqual(expect.objectContaining({
      decision: 'exclude',
      reasonCode: 'draft',
      sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
    }));

    const badLineage = await fixture();
    const intake = await readFile(badLineage.intakePath, 'utf8');
    const badSpec = JSON.parse(await readFile(badLineage.specPath, 'utf8')) as Record<string, unknown>;
    badSpec.source_intake_sha256 = '0'.repeat(64);
    const badSpecBytes = canonicalJson(badSpec);
    await writeFile(badLineage.specPath, badSpecBytes, 'utf8');
    await writeFile(badLineage.decisionsPath, serializeDecisions(decisionRecords([
      {
        at: '2026-08-19T01:00:00.000Z',
        scope_ref: 'iterations/v1-source-contract/gate-a-intake/intake.json',
        sha256: digest(intake),
      },
      {
        at: '2026-08-19T02:00:00.000Z',
        scope_ref: 'iterations/v1-source-contract/gate-b-spec/spec.json',
        sha256: digest(badSpecBytes),
      },
    ])), 'utf8');
    const lineagePlan = await createP2aPlanningProjector().plan({
      artifactRoot: badLineage.artifactRoot,
      knowledgeRoot: badLineage.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(lineagePlan.counts.include).toBe(2);
    expect(lineagePlan.entries).toContainEqual(expect.objectContaining({
      decision: 'error',
      reasonCode: 'lineage_invalid',
      sourceArtifact: 'iterations/v1-source-contract/gate-a-intake/intake.json',
    }));

    const missingCanonical = await fixture();
    await rm(missingCanonical.intakePath);
    const missingPlan = await createP2aPlanningProjector().plan({
      artifactRoot: missingCanonical.artifactRoot,
      knowledgeRoot: missingCanonical.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(missingPlan.entries).toContainEqual(expect.objectContaining({
      decision: 'error',
      reasonCode: 'lineage_invalid',
      sourceArtifact: 'iterations/v1-source-contract/iteration.json',
    }));

    const danglingClose = await fixture({ archived: true });
    const danglingCurrent = JSON.parse(
      await readFile(danglingClose.currentSpecPath, 'utf8'),
    ) as Record<string, unknown>;
    const danglingRecords = danglingCurrent.closed_iterations as Array<Record<string, unknown>>;
    const firstClosed = danglingRecords[0];
    if (firstClosed === undefined) throw new Error('closed iteration is missing');
    danglingRecords.push({ ...firstClosed, iteration_id: 'v9-missing' });
    await writeFile(danglingClose.currentSpecPath, canonicalJson(danglingCurrent), 'utf8');
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: danglingClose.artifactRoot,
      knowledgeRoot: danglingClose.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
  });

  it('writes only sanitizer-approved canonical sources and is byte-stable on retry', async () => {
    const item = await fixture();
    const projector = createP2aPlanningProjector();
    const firstPlan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    const first = await projector.apply(firstPlan);
    expect(first.writes.map((write) => write.writeStatus)).toEqual(['create', 'create', 'create']);

    const files = (await readdir(join(item.workspace, 'sources'))).sort();
    expect(files).toHaveLength(3);
    const before = await Promise.all(
      files.map(async (file) => readFile(join(item.workspace, 'sources', file), 'utf8')),
    );
    for (const markdown of before) {
      const source = parseSourceDocument(markdown);
      expect(source.buildlore).toMatchObject({ producer: 'p2a', projectId: 'alpha' });
      expect(source.buildlore.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(source.ingestedAt).toMatch(/^2026-08-19T0[12]:00:00\.000Z$/u);
      expect(decodeURIComponent(source.source)).toContain('https://example.test/alpha.git');
    }
    await expect(projector.apply(firstPlan)).rejects.toMatchObject({
      code: 'PROJECTION_ARTIFACT_CHANGED',
    });

    const secondPlan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(secondPlan.entries
      .filter((entry) => entry.decision === 'include')
      .map((entry) => entry.writeStatus)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    const second = await projector.apply(secondPlan);
    expect(second.writes.map((write) => write.writeStatus)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
    await expect(Promise.all(
      files.map(async (file) => readFile(join(item.workspace, 'sources', file), 'utf8')),
    )).resolves.toEqual(before);

    await writeSecurityPolicy(item.knowledgeRoot, 'alpha');
    const compiler = createProjectCompiler({ knowledgeRoot: item.knowledgeRoot });
    await expect(compiler.status('alpha')).resolves.toMatchObject({
      pendingChangesCount: 3,
      stateStatus: 'missing',
    });
    const provider = await startFakeOpenAiServer();
    const previous = { ...process.env };
    try {
      process.env.LLMWIKI_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'fixture-projector-key';
      process.env.OPENAI_BASE_URL = provider.baseUrl;
      process.env.OPENAI_EMBEDDINGS_BASE_URL = provider.baseUrl;
      process.env.LLMWIKI_MODEL = 'fixture-model';
      process.env.LLMWIKI_EMBEDDING_MODEL = 'fixture-embedding-model';
      await expect(compiler.execute({ capability: 'compile', projectId: 'alpha' }))
        .resolves.toMatchObject({ outcome: 'succeeded', projectId: 'alpha' });
      const providerCalls = provider.chatCalls + provider.embeddingCalls;
      await expect(compiler.execute({ capability: 'compile', projectId: 'alpha' }))
        .resolves.toMatchObject({ data: { compiled: 0 }, outcome: 'unchanged' });
      expect(provider.chatCalls + provider.embeddingCalls).toBe(providerCalls);
    } finally {
      process.env = previous;
      await provider.close();
    }
  });

  it('adds an archive summary only when close metadata and recorded hashes agree', async () => {
    const item = await fixture({ archived: true });
    const plan = await createP2aPlanningProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });

    expect(plan.counts).toEqual({ blocked: 0, error: 0, exclude: 5, include: 4, quarantine: 0 });
    expect(plan.entries).toContainEqual(expect.objectContaining({
      decision: 'include',
      documentKind: 'archived-iteration',
      reasonCode: 'archived_feature',
      sourceArtifact: 'iterations/v1-source-contract/iteration.json',
    }));
  });

  it('keeps approved spec and intake views when an archive record is corrupt', async () => {
    const item = await fixture({ archived: true });
    const current = JSON.parse(
      await readFile(item.currentSpecPath, 'utf8'),
    ) as Record<string, unknown>;
    const closed = (current.closed_iterations as Array<Record<string, unknown>>)[0];
    if (closed === undefined) throw new Error('closed iteration is missing');
    const hashes = closed.artifact_hashes as Record<string, Record<string, unknown>>;
    const specHash = hashes['iterations/v1-source-contract/gate-b-spec/spec.json'];
    if (specHash === undefined) throw new Error('closed spec hash is missing');
    specHash.sha256 = '0'.repeat(64);
    await writeFile(item.currentSpecPath, canonicalJson(current), 'utf8');

    const plan = await createP2aPlanningProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });

    expect(plan.counts.include).toBe(3);
    expect(plan.entries).toContainEqual(expect.objectContaining({
      decision: 'error',
      reasonCode: 'lineage_invalid',
      sourceArtifact: 'iterations/v1-source-contract/iteration.json',
    }));
    expect(plan.entries.some((entry) => entry.documentKind === 'archived-iteration')).toBe(false);
  });

  it('keeps approved spec views visible when intake approval is missing', async () => {
    const item = await fixture();
    const spec = await readFile(item.specPath, 'utf8');
    await writeFile(item.decisionsPath, serializeDecisions(decisionRecords([{
      at: '2026-08-19T02:00:00.000Z',
      scope_ref: 'iterations/v1-source-contract/gate-b-spec/spec.json',
      sha256: digest(spec),
    }])), 'utf8');

    const plan = await createP2aPlanningProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });

    expect(plan.counts.include).toBe(2);
    expect(plan.entries).toContainEqual(expect.objectContaining({
      decision: 'error',
      reasonCode: 'approval_invalid',
      sourceArtifact: 'iterations/v1-source-contract/gate-a-intake/intake.json',
    }));
  });

  it('handles an initial archive and repeated feature while excluding draft and maintenance', async () => {
    const item = await fixture({ archived: true });
    const initialIterationPath = join(
      item.artifactRoot,
      'iterations',
      'v1-source-contract',
      'iteration.json',
    );
    const initialIteration = JSON.parse(
      await readFile(initialIterationPath, 'utf8'),
    ) as Record<string, unknown>;
    delete initialIteration.idea;
    await writeFile(initialIterationPath, canonicalJson(initialIteration), 'utf8');
    await addFeatureIteration(item, 'v2-feature', 'gate_b_approved');
    await addFeatureIteration(item, 'v3-draft', 'draft');
    const plan = await createP2aPlanningProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });

    expect(plan.counts.include).toBe(7);
    expect(plan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentKind: 'archived-iteration', reasonCode: 'archived_feature' }),
      expect.objectContaining({ reasonCode: 'draft', sourceArtifact: 'iterations/v3-draft/gate-b-spec/spec.json' }),
      expect.objectContaining({ reasonCode: 'maintenance' }),
    ]));
  });

  it('uses promotion, verified revision, then explicit timestamps and reports absence', async () => {
    const item = await fixture({
      intakeApprovalAt: '2026-08-19',
      promotedAt: '2026-08-19T06:00:00.000Z',
      specApprovalAt: '2026-08-19',
    });
    const revisionCalls: string[] = [];
    const revisionPlan = await createP2aPlanningProjector({
      revisionClock: {
        resolveTimestamp(request) {
          revisionCalls.push(request.sourceArtifact);
          return Promise.resolve({
            sourceRevision: request.sourceRevision,
            timestamp: '2026-08-19T07:00:00.000Z',
          });
        },
      },
    }).plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(revisionPlan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentKind: 'product-spec',
        ingestedAt: '2026-08-19T06:00:00.000Z',
        timestampSource: 'promotion',
      }),
      expect.objectContaining({
        documentKind: 'intake',
        ingestedAt: '2026-08-19T07:00:00.000Z',
        timestampSource: 'revision',
      }),
    ]));
    expect(revisionCalls).toEqual(['iterations/v1-source-contract/gate-a-intake/intake.json']);

    const explicitItem = await fixture({
      intakeApprovalAt: '2026-08-19',
      specApprovalAt: '2026-08-19',
    });
    const explicitPlan = await createP2aPlanningProjector().plan({
      artifactRoot: explicitItem.artifactRoot,
      explicitTimestamp: '2026-08-19T08:00:00.000Z',
      knowledgeRoot: explicitItem.knowledgeRoot,
      projectId: 'alpha',
    });
    const explicitEntries = explicitPlan.entries.filter((entry) => entry.decision === 'include');
    expect(explicitEntries).toHaveLength(3);
    expect(explicitEntries.every((entry) => entry.timestampSource === 'explicit')).toBe(true);

    const wrongRevisionPlan = await createP2aPlanningProjector({
      revisionClock: {
        resolveTimestamp() {
          return Promise.resolve({
            sourceRevision: `sha256:${'0'.repeat(64)}`,
            timestamp: '2026-08-19T07:30:00.000Z',
          });
        },
      },
    }).plan({
      artifactRoot: explicitItem.artifactRoot,
      explicitTimestamp: '2026-08-19T08:30:00.000Z',
      knowledgeRoot: explicitItem.knowledgeRoot,
      projectId: 'alpha',
    });
    const wrongRevisionEntries = wrongRevisionPlan.entries
      .filter((entry) => entry.decision === 'include');
    expect(wrongRevisionEntries).toHaveLength(3);
    expect(wrongRevisionEntries.every((entry) =>
      entry.timestampSource === 'explicit' &&
      entry.ingestedAt === '2026-08-19T08:30:00.000Z')).toBe(true);

    const unavailable = await createP2aPlanningProjector().plan({
      artifactRoot: explicitItem.artifactRoot,
      knowledgeRoot: explicitItem.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(unavailable.entries).toContainEqual(expect.objectContaining({
      decision: 'error',
      reasonCode: 'timestamp_unavailable',
    }));
  });

  it('does not read oversized run evidence while classifying the dry-run', async () => {
    const item = await fixture();
    const runs = join(item.artifactRoot, 'runs', 'v1-source-contract');
    await mkdir(runs, { recursive: true });
    await writeFile(join(runs, 'large-run.json'), Buffer.alloc(9 * 1024 * 1024));

    const plan = await createP2aPlanningProjector().plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.counts.error).toBe(0);
    expect(plan.entries).toContainEqual(expect.objectContaining({
      decision: 'exclude',
      reasonCode: 'task_or_run',
      sourceArtifact: 'runs/v1-source-contract/large-run.json',
    }));
  });

  it('validates the decision hash chain and treats revocation as authoritative', async () => {
    const tampered = await fixture();
    const tamperedRecords = (await readFile(tampered.decisionsPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const second = tamperedRecords[1];
    if (second === undefined) throw new Error('second decision is missing');
    second.prev_sha256 = '0'.repeat(64);
    await writeFile(tampered.decisionsPath, serializeDecisions(tamperedRecords), 'utf8');
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: tampered.artifactRoot,
      knowledgeRoot: tampered.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });

    const wrongReference = await fixture();
    const wrongReferenceRecords = (await readFile(wrongReference.decisionsPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
    const wrongReferenceLatest = wrongReferenceRecords.at(-1);
    if (wrongReferenceLatest === undefined) throw new Error('latest decision is missing');
    const invalidRevocation = {
      seq: wrongReferenceRecords.length + 1,
      at: '2026-08-19T08:00:00.000Z',
      type: 'gate.what.revoked',
      scope_ref: 'iterations/v1-source-contract/gate-b-spec/spec.json',
      sha256: digest(await readFile(wrongReference.specPath, 'utf8')),
      quote: 'invalid fixture reference',
      prev_seq: 1,
      prev_sha256: digest(JSON.stringify(wrongReferenceLatest)),
    };
    await writeFile(
      wrongReference.decisionsPath,
      serializeDecisions([...wrongReferenceRecords, invalidRevocation]),
      'utf8',
    );
    await expect(createP2aPlanningProjector().plan({
      artifactRoot: wrongReference.artifactRoot,
      knowledgeRoot: wrongReference.knowledgeRoot,
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });

    const revoked = await fixture();
    const records = (await readFile(revoked.decisionsPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
    const latest = records.at(-1);
    if (latest === undefined) throw new Error('latest decision is missing');
    const specBytes = await readFile(revoked.specPath, 'utf8');
    const revocation = {
      seq: records.length + 1,
      at: '2026-08-19T09:00:00.000Z',
      type: 'gate.what.revoked',
      scope_ref: 'iterations/v1-source-contract/gate-b-spec/spec.json',
      sha256: digest(specBytes),
      quote: 'revoke fixture approval',
      prev_seq: 2,
      prev_sha256: digest(JSON.stringify(latest)),
    };
    await writeFile(
      revoked.decisionsPath,
      serializeDecisions([...records, revocation]),
      'utf8',
    );
    const plan = await createP2aPlanningProjector().plan({
      artifactRoot: revoked.artifactRoot,
      knowledgeRoot: revoked.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.entries).toContainEqual(expect.objectContaining({
      decision: 'error',
      reasonCode: 'approval_invalid',
      sourceArtifact: 'iterations/v1-source-contract/gate-b-spec/spec.json',
    }));
  });

  it('keeps prepared source bodies private and rejects a cloned plan', async () => {
    const item = await fixture();
    const projector = createP2aPlanningProjector();
    const plan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    expect(plan.entries.filter((entry) => entry.decision === 'include').every((entry) =>
      entry.security?.decision === 'include')).toBe(true);
    await expect(projector.apply(structuredClone(plan))).rejects.toMatchObject({
      code: 'PROJECTION_ARTIFACT_CHANGED',
    });
    await expect(readdir(join(item.workspace, 'sources'))).resolves.toEqual([]);
  });

  it('fails closed before writes when artifacts or project security state drift', async () => {
    const item = await fixture();
    const projector = createP2aPlanningProjector();
    const driftPlan = await projector.plan({
      artifactRoot: item.artifactRoot,
      knowledgeRoot: item.knowledgeRoot,
      projectId: 'alpha',
    });
    await writeFile(item.specPath, '{"changed":true}\n', 'utf8');
    await expect(projector.apply(driftPlan)).rejects.toEqual(
      expect.objectContaining<Partial<ProjectionError>>({ code: 'PROJECTION_ARTIFACT_CHANGED' }),
    );
    await expect(readdir(join(item.workspace, 'sources'))).resolves.toEqual([]);

    const ledgerItem = await fixture();
    const ledgerProjector = createP2aPlanningProjector();
    const ledgerPlan = await ledgerProjector.plan({
      artifactRoot: ledgerItem.artifactRoot,
      knowledgeRoot: ledgerItem.knowledgeRoot,
      projectId: 'alpha',
    });
    await writeFile(ledgerItem.decisionsPath, '{"changed":true}\n', 'utf8');
    await expect(ledgerProjector.apply(ledgerPlan)).rejects.toMatchObject({
      code: 'PROJECTION_ARTIFACT_CHANGED',
    });
    await expect(readdir(join(ledgerItem.workspace, 'sources'))).resolves.toEqual([]);

    const fileSetItem = await fixture();
    const fileSetProjector = createP2aPlanningProjector();
    const fileSetPlan = await fileSetProjector.plan({
      artifactRoot: fileSetItem.artifactRoot,
      knowledgeRoot: fileSetItem.knowledgeRoot,
      projectId: 'alpha',
    });
    await writeFile(join(fileSetItem.artifactRoot, 'generated-after-plan.json'), '{}\n', 'utf8');
    await expect(fileSetProjector.apply(fileSetPlan)).rejects.toMatchObject({
      code: 'PROJECTION_ARTIFACT_CHANGED',
    });
    await expect(readdir(join(fileSetItem.workspace, 'sources'))).resolves.toEqual([]);

    const projectItem = await fixture();
    const projectProjector = createP2aPlanningProjector();
    const projectPlan = await projectProjector.plan({
      artifactRoot: projectItem.artifactRoot,
      knowledgeRoot: projectItem.knowledgeRoot,
      projectId: 'alpha',
    });
    const descriptorPath = join(projectItem.workspace, 'project.json');
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>;
    descriptor.sourceRepository = 'https://example.test/changed.git';
    await writeFile(descriptorPath, canonicalJson(descriptor), 'utf8');
    await expect(projectProjector.apply(projectPlan)).rejects.toMatchObject({
      code: 'PROJECTION_ARTIFACT_CHANGED',
    });
    await expect(readdir(join(projectItem.workspace, 'sources'))).resolves.toEqual([]);
  });
});
