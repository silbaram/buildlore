import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addProject } from '../src/knowledge/index.js';
import {
  createP2aPlanningProjector,
  createSourceDocument,
  renderSourceDocument,
} from '../src/projector/index.js';
import { createProjectSourceWriter } from '../src/projector/project-source-writer.js';
import {
  issueSanitizationApproval,
  type SourceSanitizerPort,
} from '../src/sanitizer/index.js';

const temporaryRoots: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const sanitizer: SourceSanitizerPort = {
  sanitize(request) {
    return Promise.resolve(issueSanitizationApproval({
      approvedBody: request.body,
      approvedBodyDigest: `sha256:${sha256(request.body)}`,
      inputBodyDigest: request.bodyDigest,
      projectId: request.projectId,
      source: request.source,
    }));
  },
};

async function createFixture(): Promise<{
  readonly artifactRoot: string;
  readonly knowledgeRoot: string;
  readonly outside: string;
  readonly sources: string;
}> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-projector-writer-'));
  temporaryRoots.push(root);
  const artifactRoot = join(root, 'artifacts');
  const knowledgeRoot = join(root, 'knowledge');
  const iteration = join(artifactRoot, 'iterations', 'v1-writer');
  await Promise.all([
    mkdir(join(iteration, 'gate-a-intake'), { recursive: true }),
    mkdir(join(iteration, 'gate-b-spec'), { recursive: true }),
    mkdir(knowledgeRoot),
  ]);
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });
  const intakePath = 'iterations/v1-writer/gate-a-intake/intake.json';
  const specPath = 'iterations/v1-writer/gate-b-spec/spec.json';
  const intake = json({
    assumptions: [],
    clarifying_questions: [],
    evidence: [],
    idea: 'Safe writer',
    known_facts: [],
    needs_user_decision: [],
    schema_version: 'p2a.intake.v1',
    status: 'ready_for_spec',
    summary: 'Reject unsafe targets.',
  });
  const spec = json({
    approval: 'approved',
    clarifying_question_disposition: [],
    evidence: [],
    implementation: {
      architecture: [],
      data_flow: [],
      dependencies: [],
      edge_cases: [],
      interfaces: [],
      verification: [],
    },
    open_decisions: [],
    product: {
      constraints: [],
      core_flows: [],
      data_model_draft: [],
      external_integrations: [],
      goals: [],
      must_preserve: [],
      non_goals: [],
      problem: 'Unsafe source targets must fail closed.',
      screens_or_interfaces: [],
      success_criteria: [],
      target_users: [],
    },
    project_id: 'alpha',
    schema_version: 'p2a.spec.v1',
    source_intake: '../gate-a-intake/intake.json',
    source_intake_sha256: sha256(intake),
  });
  const firstDecision = {
    seq: 1,
    at: '2026-08-19T00:00:00.000Z',
    scope_ref: intakePath,
    sha256: sha256(intake),
    type: 'gate.what.approved',
    quote: 'approved fixture',
    prev_sha256: null,
  };
  const decisions = [
    firstDecision,
    {
      seq: 2,
      at: '2026-08-19T00:01:00.000Z',
      scope_ref: specPath,
      sha256: sha256(spec),
      type: 'gate.what.approved',
      quote: 'approved fixture',
      prev_sha256: sha256(JSON.stringify(firstDecision)),
    },
  ].map((value) => JSON.stringify(value)).join('\n');
  const outside = join(root, 'outside.md');
  await Promise.all([
    writeFile(join(artifactRoot, 'current-spec.json'), json({
      active_iteration: 'v1-writer',
      closed_iterations: [],
      project_id: 'alpha',
      schema_version: 'p2a.current_spec.v1',
    }), 'utf8'),
    writeFile(join(artifactRoot, 'decisions.jsonl'), `${decisions}\n`, 'utf8'),
    writeFile(join(artifactRoot, ...intakePath.split('/')), intake, 'utf8'),
    writeFile(join(artifactRoot, ...specPath.split('/')), spec, 'utf8'),
    writeFile(join(iteration, 'iteration.json'), json({
      idea: 'Safe writer',
      iteration_id: 'v1-writer',
      project_id: 'alpha',
      schema_version: 'p2a.iteration_metadata.v1',
      status: 'gate_b_approved',
    }), 'utf8'),
    writeFile(outside, 'OUTSIDE-SENTINEL\n', 'utf8'),
  ]);
  return {
    artifactRoot,
    knowledgeRoot,
    outside,
    sources: join(knowledgeRoot, 'projects', 'alpha', 'sources'),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('project source writer', () => {
  it('derives the target name from the complete source identity', async () => {
    const fixture = await createFixture();
    const writer = await createProjectSourceWriter(
      join(fixture.knowledgeRoot, 'projects', 'alpha'),
      'alpha',
    );
    await expect(writer.inspect({
      body: 'approved body',
      ingestedAt: '2026-08-19T00:00:00.000Z',
      sourceRevision: `sha256:${'a'.repeat(64)}`,
      sourceUri: 'buildlore+p2a:/expected-source',
      target: `planning--${'0'.repeat(64)}.md`,
      title: 'Expected source',
    })).rejects.toMatchObject({ code: 'PROJECTION_PATH_UNSAFE' });
  });

  it('rejects a symlink target without touching the linked file or sibling sources', async () => {
    const fixture = await createFixture();
    const projector = createP2aPlanningProjector();
    const plan = await projector.plan({
      artifactRoot: fixture.artifactRoot,
      knowledgeRoot: fixture.knowledgeRoot,
      projectId: 'alpha',
    });
    const target = plan.entries.find(
      (entry) => entry.reasonCode === 'approved_product_spec',
    )?.target;
    expect(target).toMatch(/^planning--[a-f0-9]{64}\.md$/u);
    if (target === undefined) throw new Error('product source target is missing');
    await symlink(fixture.outside, join(fixture.sources, target));

    await expect(projector.apply(plan, sanitizer)).rejects.toMatchObject({
      code: 'PROJECTION_PATH_UNSAFE',
    });
    await expect(readFile(fixture.outside, 'utf8')).resolves.toBe('OUTSIDE-SENTINEL\n');
    await expect(readdir(fixture.sources)).resolves.toEqual([target]);
  });

  it('rejects a regular target owned by a different source identity', async () => {
    const fixture = await createFixture();
    const projector = createP2aPlanningProjector();
    const plan = await projector.plan({
      artifactRoot: fixture.artifactRoot,
      knowledgeRoot: fixture.knowledgeRoot,
      projectId: 'alpha',
    });
    const target = plan.entries.find(
      (entry) => entry.reasonCode === 'approved_product_spec',
    )?.target;
    if (target === undefined) throw new Error('product source target is missing');
    const foreign = renderSourceDocument(createSourceDocument({
      body: 'foreign body',
      ingestedAt: '2026-08-19T00:00:00.000Z',
      producer: 'p2a',
      projectId: 'alpha',
      source: 'buildlore+p2a:/foreign-source',
      sourceKind: 'planning',
      sourceRevision: `sha256:${'b'.repeat(64)}`,
      sourceType: 'file',
      title: 'Foreign source',
    }));
    const targetPath = join(fixture.sources, target);
    await writeFile(targetPath, foreign, 'utf8');

    await expect(projector.apply(plan, sanitizer)).rejects.toMatchObject({
      code: 'PROJECTION_SOURCE_COLLISION',
    });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe(foreign);
  });
});
