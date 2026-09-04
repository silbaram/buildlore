import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { addProject } from '../src/knowledge/index.js';
import {
  bindLocalProject,
  SourceCheckoutHandle,
  sourceRepositoryDigestFor,
} from '../src/knowledge/local-project-registry.js';
import { createProjectSessionCompiler } from '../src/compiler/index.js';
import {
  createBuildLoreLifecycleProfile,
  createProjectLifecycleProfile,
  renderLifecycleProfile,
} from '../src/profile/index.js';
import {
  createSourceCollectionAdapter,
  genericSourceAdapter,
  SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
} from '../src/projector/source-adapters.js';
import {
  createP2aArtifactAdapter,
  type P2aArtifactAdapter,
} from '../src/projector/p2a-artifacts.js';
import {
  createP2aPlanningProjector,
  createProjectSyncService,
} from '../src/projector/index.js';
import {
  parseSourceCollectionManifest,
  parseSourceCollectionManifestV2,
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
  SOURCE_COLLECTION_MANIFEST_SCHEMA_VERSION,
  SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
} from '../src/projector/source-manifest.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const repository = 'https://example.test/alpha.git';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

async function prepareP2aKnowledgeHub(
  root: string,
  sourceRoot: string,
): Promise<Readonly<{ readonly hubRoot: string; readonly knowledgeRoot: string }>> {
  const hubRoot = join(root, `hub-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`);
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await mkdir(knowledgeRoot, { recursive: true });
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: repository,
  });
  await bindLocalProject(hubRoot, {
    projectId: 'alpha',
    sourceRepository: repository,
    sourceRoot,
  });
  await writeSecurityPolicy(knowledgeRoot, 'alpha', { capabilities: ['compile'] });
  await writeFile(
    join(knowledgeRoot, 'projects/alpha/profile.json'),
    renderLifecycleProfile(createBuildLoreLifecycleProfile('en')),
  );
  const profiles = createProjectLifecycleProfile({ knowledgeRoot });
  await profiles.apply(await profiles.plan('alpha'));
  return Object.freeze({ hubRoot, knowledgeRoot });
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
    expect(genericSourceAdapter().registration.limits).toEqual({
      maxMetadataBytes: 16_384,
      maxMetadataDepth: 8,
      maxMetadataKeys: 64,
    });
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
      ingestedAt: '2026-08-24T00:00:00.000Z',
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
    expect(result.candidates.map((candidate) => candidate.adapterDocumentKind)).toEqual([
      'intake',
      'implementation-plan',
      'product-spec',
    ]);
    expect(result.candidates.every((candidate) =>
      candidate.producer === 'p2a' && candidate.documentKind === 'p2a-planning')).toBe(true);
    expect(result.candidates.find((candidate) =>
      candidate.adapterDocumentKind === 'product-spec')?.retrievalMeaning).toMatchObject({
      meaning: {
        authority: 'canonical', evidenceKind: 'decision', lifecycle: 'current', revisionOrdinal: 1,
      },
      origin: 'adapter',
    });
    expect(result.candidates.find((candidate) =>
      candidate.adapterDocumentKind === 'intake')?.retrievalMeaning).toMatchObject({
      meaning: {
        authority: 'historical', evidenceKind: 'planning', lifecycle: 'superseded', revisionOrdinal: 1,
      },
      origin: 'adapter',
    });
    expect(JSON.stringify(result)).not.toContain(current.sourceRoot);
    expect(await readFile(join(current.sourceRoot, '.plan2agent/runs/run-index.json'), 'utf8'))
      .toBe('{malformed');
    expect(await readFile(
      join(current.sourceRoot, '.plan2agent/runs/attempt/p2a.run.json'),
      'utf8',
    )).toBe('{changed');
  });

  it('[GLW-V-02][GLW-V-05] preserves legacy P2A source and citation identities via the registry', async () => {
    const current = await fixture();
    await writePlanningFixture(current.sourceRoot);
    await rm(join(current.sourceRoot, '.plan2agent/runs'), { force: true, recursive: true });
    const selected = await select(current.sourceRoot, current.checkout, [{
      documentKind: 'p2a-planning',
      id: 'planning',
      path: '.plan2agent',
      pathType: 'directory',
      recursive: true,
    }]);
    await git(current.sourceRoot, ['init', '--initial-branch=main']);
    await git(current.sourceRoot, ['config', 'user.email', 'buildlore@example.invalid']);
    await git(current.sourceRoot, ['config', 'user.name', 'BuildLore Test']);
    await git(current.sourceRoot, ['add', '.']);
    await git(current.sourceRoot, ['commit', '-m', 'seed P2A compatibility corpus']);

    const legacy = await prepareP2aKnowledgeHub(join(current.root, 'legacy'), current.sourceRoot);
    const registered = await prepareP2aKnowledgeHub(
      join(current.root, 'registered'),
      current.sourceRoot,
    );
    const artifactRoot = join(current.sourceRoot, '.plan2agent');
    const legacyProjector = createP2aPlanningProjector();
    await legacyProjector.apply(await legacyProjector.plan({
      artifactRoot,
      knowledgeRoot: legacy.knowledgeRoot,
      projectId: 'alpha',
    }));
    const synchronized = await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: registered.hubRoot,
      projectId: 'alpha',
    });
    expect(synchronized.collection?.counts.include).toBe(3);
    expect(synchronized.writes.every((write) => write.sourceKind === 'planning')).toBe(true);

    const legacyAdapter = await createP2aArtifactAdapter().read({
      artifactRoot,
      projectId: 'alpha',
    }, repository, {
      selectedFiles: selected.inventory.files.map((file) =>
        file.sourceRef.slice('.plan2agent/'.length)),
    });
    const registeredAdapter = await createSourceCollectionAdapter().collect({
      checkout: current.checkout,
      ...selected,
    });
    const sortCandidates = <T extends { readonly documentKind: string }>(
      candidates: readonly T[],
    ): readonly T[] => [...candidates].sort((left, right) =>
      left.documentKind < right.documentKind ? -1 : left.documentKind > right.documentKind ? 1 : 0);
    expect(sortCandidates(registeredAdapter.candidates.map((candidate) => ({
      body: candidate.body,
      documentKind: candidate.adapterDocumentKind ?? 'missing',
      ingestedAt: candidate.ingestedAt,
      sourceRevision: candidate.sourceRevision,
      sourceUri: candidate.sourceUri,
      target: candidate.target,
      title: candidate.title,
    })))).toEqual(sortCandidates(
      legacyAdapter.candidates.map((candidate) => ({
        body: candidate.body,
        documentKind: candidate.documentKind,
        ingestedAt: candidate.ingestedAt,
        sourceRevision: candidate.sourceRevision,
        sourceUri: candidate.sourceUri,
        target: candidate.target,
        title: candidate.title,
      })),
    ));

    const legacyPlan = await createProjectSessionCompiler({
      hubRoot: legacy.hubRoot,
      knowledgeRoot: legacy.knowledgeRoot,
    }).plan({ projectId: 'alpha' });
    const registeredPlan = await createProjectSessionCompiler({
      hubRoot: registered.hubRoot,
      knowledgeRoot: registered.knowledgeRoot,
    }).plan({ projectId: 'alpha' });
    const compatibilityProjection = (plan: typeof legacyPlan): string => serializeCanonicalJson(
      plan.sources.map((source) => ({
        citationAnchors: source.citationAnchors,
        compilerSourceId: source.compilerSourceId,
        revision: source.revision,
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
      })),
    );
    expect(compatibilityProjection(registeredPlan)).toBe(compatibilityProjection(legacyPlan));
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
      ingestedAt: '2026-08-24T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'PROJECTION_SOURCE_COLLISION' });
  });

  it('rejects selected adapter fields that do not match their declaration', async () => {
    const current = await fixture();
    await mkdir(join(current.sourceRoot, 'docs'), { recursive: true });
    await writeFile(join(current.sourceRoot, 'docs/guide.md'), '# Guide\n');
    const selected = await select(current.sourceRoot, current.checkout, [{
      documentKind: 'markdown',
      id: 'docs',
      path: 'docs/guide.md',
      pathType: 'file',
    }]);
    const only = selected.inventory.files[0];
    if (only === undefined) throw new Error('fixture selection is empty');

    await expect(createSourceCollectionAdapter().collect({
      checkout: current.checkout,
      inventory: {
        ...selected.inventory,
        files: [{ ...only, kind: 'text', mediaType: 'text/plain' }],
      },
      loadedManifest: selected.loadedManifest,
      ingestedAt: '2026-08-24T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
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

  it('collects registered text and code without the optional P2A adapter', async () => {
    const current = await fixture();
    await mkdir(join(current.sourceRoot, 'portable'));
    await Promise.all([
      writeFile(join(current.sourceRoot, 'portable/readme.txt'), 'portable text\r\nsecond line\r\n'),
      writeFile(join(current.sourceRoot, 'portable/tool.ts'), 'const fence = "```";\r\n'),
    ]);
    const manifest = parseSourceCollectionManifestV2({
      projectId: 'alpha',
      schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
      sourceRepository: repository,
      sources: [
        {
          adapterId: 'buildlore.generic',
          adapterVersion: 1,
          id: 'code',
          kind: 'code',
          path: 'portable/tool.ts',
          pathType: 'file',
        },
        {
          adapterId: 'buildlore.generic',
          adapterVersion: 1,
          id: 'text',
          kind: 'text',
          path: 'portable/readme.txt',
          pathType: 'file',
        },
      ],
    });
    await writeFile(
      join(current.sourceRoot, '.buildlore/sources.json'),
      serializeCanonicalJson(manifest),
    );
    const loadedManifest = await readSourceCollectionManifest(current.checkout, 'alpha');
    const inventory = await selectDeclaredSourceFiles(current.checkout, loadedManifest);
    const result = await createSourceCollectionAdapter({ includeP2a: false }).collect({
      checkout: current.checkout,
      inventory,
      loadedManifest,
      ingestedAt: '2026-08-24T00:00:00.000Z',
    });
    expect(result.candidates.map((candidate) => candidate.sourceKind)).toEqual(['code', 'text']);
    const code = result.candidates[0];
    expect(code?.body).toBe('````typescript\nconst fence = "```";\n````');
    expect(code?.canonicalDocument.schemaVersion).toBe('buildlore.source.v2');
    expect(code?.rangeMappings).toEqual([{
      canonical: { endColumn: 21, endLine: 2, startColumn: 1, startLine: 2 },
      origin: { endColumn: 21, endLine: 1, startColumn: 1, startLine: 1 },
    }]);
    expect(JSON.stringify(result)).not.toContain(current.sourceRoot);
  });

  it('rejects generic manifest supersession drift before candidates reach persistence',
    async () => {
      const current = await fixture();
      await mkdir(join(current.sourceRoot, 'portable'));
      await Promise.all([
        writeFile(join(current.sourceRoot, 'portable/current.md'), '# Current\n'),
        writeFile(join(current.sourceRoot, 'portable/old.md'), '# Old\n'),
      ]);
      const meaning = (
        supersededBySourceRefs: readonly string[],
        supersedesSourceRefs: readonly string[],
      ) => ({
        namespace: 'buildlore.generic',
        schemaVersion: 'buildlore.generic-metadata.v1',
        values: {
          retrievalMeaning: {
            authority: 'canonical',
            evidenceKind: 'decision',
            iterationGroup: null,
            lifecycle: 'current',
            revisionOrdinal: 1,
            schemaVersion: SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
            supersededBySourceRefs,
            supersedesSourceRefs,
            topicGroup: 'supersession',
          },
        },
      });
      const manifest = parseSourceCollectionManifestV2({
        projectId: 'alpha',
        schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
        sourceRepository: repository,
        sources: [
          {
            adapterId: 'buildlore.generic',
            adapterVersion: 1,
            id: 'current',
            kind: 'markdown',
            metadata: meaning([], ['portable/old.md']),
            path: 'portable/current.md',
            pathType: 'file',
          },
          {
            adapterId: 'buildlore.generic',
            adapterVersion: 1,
            id: 'old',
            kind: 'markdown',
            metadata: meaning([], []),
            path: 'portable/old.md',
            pathType: 'file',
          },
        ],
      });
      await writeFile(
        join(current.sourceRoot, '.buildlore/sources.json'),
        serializeCanonicalJson(manifest),
      );
      const loadedManifest = await readSourceCollectionManifest(current.checkout, 'alpha');
      const inventory = await selectDeclaredSourceFiles(current.checkout, loadedManifest);

      await expect(createSourceCollectionAdapter({ includeP2a: false }).collect({
        checkout: current.checkout,
        inventory,
        loadedManifest,
        ingestedAt: '2026-08-24T00:00:00.000Z',
      })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
    });

  it('rejects P2A declarations when the optional adapter is disabled', async () => {
    const current = await fixture();
    await writePlanningFixture(current.sourceRoot);
    const selected = await select(current.sourceRoot, current.checkout, [{
      documentKind: 'p2a-planning',
      id: 'planning',
      path: '.plan2agent',
      pathType: 'directory',
      recursive: true,
    }]);
    await expect(createSourceCollectionAdapter({ includeP2a: false }).collect({
      checkout: current.checkout,
      ...selected,
    })).rejects.toMatchObject({ code: 'PROJECTION_ARTIFACT_INVALID' });
  });
});
