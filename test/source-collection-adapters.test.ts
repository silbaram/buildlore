import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  SourceCheckoutHandle,
  sourceRepositoryDigestFor,
} from '../src/knowledge/local-project-registry.js';
import { createSourceCollectionAdapter } from '../src/projector/source-adapters.js';
import type { P2aArtifactAdapter } from '../src/projector/p2a-artifacts.js';
import {
  parseSourceCollectionManifest,
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
  SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
} from '../src/projector/source-manifest.js';

const temporaryRoots: string[] = [];
const repository = 'https://example.test/alpha.git';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fixture(): Promise<{
  readonly checkout: SourceCheckoutHandle;
  readonly root: string;
  readonly sourceRoot: string;
}> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-source-adapter-'));
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  await mkdir(join(sourceRoot, '.buildlore'), { recursive: true });
  return {
    checkout: new SourceCheckoutHandle(
      'alpha',
      sourceRepositoryDigestFor(repository),
      sourceRoot,
    ),
    root,
    sourceRoot,
  };
}

async function select(
  sourceRoot: string,
  checkout: SourceCheckoutHandle,
  sources: readonly Readonly<Record<string, unknown>>[],
) {
  const manifest = parseSourceCollectionManifest({
    projectId: 'alpha',
    schemaVersion: SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
    sourceRepository: repository,
    sources,
  });
  await writeFile(
    join(sourceRoot, '.buildlore/sources.json'),
    serializeCanonicalJson(manifest),
  );
  const loadedManifest = await readSourceCollectionManifest(checkout, 'alpha');
  const inventory = await selectDeclaredSourceFiles(checkout, loadedManifest);
  return { inventory, loadedManifest };
}

async function writePlanningFixture(sourceRoot: string): Promise<void> {
  const planningRoot = join(sourceRoot, '.plan2agent');
  const iterationRoot = join(planningRoot, 'iterations/v1-adapter');
  const intakeRef = 'iterations/v1-adapter/gate-a-intake/intake.json';
  const specRef = 'iterations/v1-adapter/gate-b-spec/spec.json';
  await Promise.all([
    mkdir(join(iterationRoot, 'gate-a-intake'), { recursive: true }),
    mkdir(join(iterationRoot, 'gate-b-spec'), { recursive: true }),
    mkdir(join(planningRoot, 'runs/attempt'), { recursive: true }),
  ]);
  const intake = json({
    assumptions: [],
    clarifying_questions: [],
    evidence: [],
    idea: 'Selected planning documents',
    known_facts: [],
    needs_user_decision: [],
    schema_version: 'p2a.intake.v1',
    status: 'ready_for_spec',
    summary: 'Collect only approved planning data.',
  });
  const spec = json({
    approval: 'approved',
    clarifying_question_disposition: [],
    evidence: [],
    implementation: {
      architecture: ['Keep the collection boundary replaceable.'],
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
      goals: ['Collect selected planning documents.'],
      must_preserve: [],
      non_goals: [],
      problem: 'Unselected execution data must remain untouched.',
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
    at: '2026-08-24T00:00:00.000Z',
    prev_sha256: null,
    quote: 'approved',
    scope_ref: intakeRef,
    seq: 1,
    sha256: sha256(intake),
    type: 'gate.what.approved',
  };
  const decisions = [
    firstDecision,
    {
      at: '2026-08-24T00:01:00.000Z',
      prev_sha256: sha256(JSON.stringify(firstDecision)),
      quote: 'approved',
      scope_ref: specRef,
      seq: 2,
      sha256: sha256(spec),
      type: 'gate.what.approved',
    },
  ].map((value) => JSON.stringify(value)).join('\n');
  await Promise.all([
    writeFile(join(planningRoot, 'current-spec.json'), json({
      active_iteration: 'v1-adapter',
      closed_iterations: [],
      project_id: 'alpha',
      schema_version: 'p2a.current_spec.v1',
    })),
    writeFile(join(planningRoot, 'decisions.jsonl'), `${decisions}\n`),
    writeFile(join(planningRoot, intakeRef), intake),
    writeFile(join(planningRoot, specRef), spec),
    writeFile(join(iterationRoot, 'iteration.json'), json({
      idea: 'Selected planning documents',
      iteration_id: 'v1-adapter',
      project_id: 'alpha',
      schema_version: 'p2a.iteration_metadata.v1',
      status: 'gate_b_approved',
    })),
    writeFile(join(planningRoot, 'runs/run-index.json'), '{malformed'),
    writeFile(join(planningRoot, 'runs/attempt/p2a.run.json'), '{changed'),
  ]);
  await symlink(
    join(sourceRoot, 'missing-execution-target'),
    join(planningRoot, 'runs/attempt/inaccessible-execution-sentinel'),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('selected source collection adapters', () => {
  it('creates deterministic canonical Markdown candidates with portable metadata', async () => {
    const current = await fixture();
    await mkdir(join(current.sourceRoot, 'docs'), { recursive: true });
    await writeFile(
      join(current.sourceRoot, 'docs/guide.md'),
      `# Portable guide\r\n\r\n${'content '.repeat(15_000)}\r\n`,
    );
    const selected = await select(current.sourceRoot, current.checkout, [{
      documentKind: 'markdown',
      id: 'guide',
      path: 'docs/guide.md',
      pathType: 'file',
    }]);
    const adapter = createSourceCollectionAdapter();
    const input = {
      checkout: current.checkout,
      ...selected,
      markdownIngestedAt: '2026-08-24T00:00:00.000Z',
    } as const;
    const first = await adapter.collect(input);
    const second = await adapter.collect(input);

    expect(second).toEqual(first);
    expect(first.candidates).toHaveLength(1);
    const candidate = first.candidates[0];
    expect(candidate).toMatchObject({
      declarationId: 'guide',
      documentKind: 'markdown',
      producer: 'buildlore',
      projectId: 'alpha',
      sourceKind: 'markdown',
      sourceRef: 'docs/guide.md',
      title: 'Portable guide',
    });
    expect(candidate?.sourceUri).toMatch(/^buildlore\+source:\//u);
    expect(candidate?.target).toMatch(/^markdown--[a-f0-9]{64}\.md$/u);
    expect(candidate?.canonicalDocument.truncated).toBe(true);
    expect(candidate?.canonicalDocument.buildlore.contentHash).toMatch(/^sha256:/u);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(current.sourceRoot);
    expect(serialized).not.toContain(current.root);
  });

  it('uses only manifest-selected planning files and leaves execution sentinels untouched', async () => {
    const current = await fixture();
    await writePlanningFixture(current.sourceRoot);
    const selected = await select(current.sourceRoot, current.checkout, [{
      documentKind: 'p2a-planning',
      id: 'planning',
      path: '.plan2agent',
      pathType: 'directory',
      recursive: true,
    }]);
    expect(selected.inventory.files.some((file) => file.sourceRef.includes('/runs/'))).toBe(false);

    const result = await createSourceCollectionAdapter().collect({
      checkout: current.checkout,
      ...selected,
    });
    expect(result.candidates.map((candidate) => candidate.planningDocumentKind)).toEqual([
      'intake',
      'implementation-plan',
      'product-spec',
    ]);
    expect(result.candidates.every((candidate) =>
      candidate.producer === 'p2a' && candidate.documentKind === 'p2a-planning')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(current.sourceRoot);
    expect(await readFile(join(current.sourceRoot, '.plan2agent/runs/run-index.json'), 'utf8'))
      .toBe('{malformed');
    expect(await readFile(
      join(current.sourceRoot, '.plan2agent/runs/attempt/p2a.run.json'),
      'utf8',
    )).toBe('{changed');
  });

  it('rejects duplicate selected identities before producing candidates', async () => {
    const current = await fixture();
    await mkdir(join(current.sourceRoot, 'docs'), { recursive: true });
    await writeFile(join(current.sourceRoot, 'docs/duplicate.md'), '# Duplicate\n');
    const selected = await select(current.sourceRoot, current.checkout, [{
      documentKind: 'markdown',
      id: 'docs',
      path: 'docs',
      pathType: 'directory',
      recursive: true,
    }]);
    const only = selected.inventory.files[0];
    if (only === undefined) throw new Error('fixture selection is empty');
    await expect(createSourceCollectionAdapter().collect({
      checkout: current.checkout,
      inventory: {
        ...selected.inventory,
        files: [...selected.inventory.files, only],
      },
      loadedManifest: selected.loadedManifest,
      markdownIngestedAt: '2026-08-24T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'PROJECTION_SOURCE_COLLISION' });
  });

  it('rejects duplicate target identities returned by producer adapters', async () => {
    const current = await fixture();
    await mkdir(
      join(current.sourceRoot, '.plan2agent/iterations/v1-collision/gate-b-spec'),
      { recursive: true },
    );
    await Promise.all([
      writeFile(join(current.sourceRoot, '.plan2agent/current-spec.json'), '{}\n'),
      writeFile(join(current.sourceRoot, '.plan2agent/decisions.jsonl'), '{}\n'),
      writeFile(
        join(current.sourceRoot, '.plan2agent/iterations/v1-collision/gate-b-spec/spec.json'),
        '{}\n',
      ),
    ]);
    const selected = await select(current.sourceRoot, current.checkout, [{
      documentKind: 'p2a-planning',
      id: 'planning',
      path: '.plan2agent',
      pathType: 'directory',
      recursive: true,
    }]);
    const specFile = selected.inventory.files.find((file) => file.sourceRef.endsWith('/spec.json'));
    if (specFile === undefined) throw new Error('fixture spec selection is missing');
    const sourceUri = (documentKind: 'implementation-plan' | 'product-spec'): string => [
      'buildlore+p2a:',
      encodeURIComponent(repository),
      'alpha',
      'v1-collision',
      documentKind,
      encodeURIComponent('iterations/v1-collision/gate-b-spec/spec.json'),
    ].join('/');
    const target = `planning--${'d'.repeat(64)}.md`;
    const p2aArtifactAdapter: P2aArtifactAdapter = {
      read(input, _repository, selection) {
        return Promise.resolve({
          artifactRoot: input.artifactRoot,
          bindings: [],
          candidates: [
            {
              body: 'Implementation body',
              documentKind: 'implementation-plan',
              ingestedAt: '2026-08-24T00:00:00.000Z',
              producer: 'p2a',
              sourceArtifact: 'iterations/v1-collision/gate-b-spec/spec.json',
              sourceKind: 'planning',
              sourceRevision: specFile.contentDigest,
              sourceUri: sourceUri('implementation-plan'),
              target,
              timestampSource: 'explicit',
              title: 'Implementation',
            },
            {
              body: 'Product body',
              documentKind: 'product-spec',
              ingestedAt: '2026-08-24T00:00:00.000Z',
              producer: 'p2a',
              sourceArtifact: 'iterations/v1-collision/gate-b-spec/spec.json',
              sourceKind: 'planning',
              sourceRevision: specFile.contentDigest,
              sourceUri: sourceUri('product-spec'),
              target,
              timestampSource: 'explicit',
              title: 'Product',
            },
          ],
          compatibilityWarnings: [],
          entries: [],
          scannedFiles: selection?.selectedFiles ?? [],
        });
      },
      async verify() {
        // The collection-only path never persists or invokes verification/apply.
      },
    };
    await expect(createSourceCollectionAdapter({ p2aArtifactAdapter }).collect({
      checkout: current.checkout,
      ...selected,
    })).rejects.toMatchObject({ code: 'PROJECTION_SOURCE_COLLISION' });
  });
});
