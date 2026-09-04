import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectSessionCompiler } from '../src/compiler/index.js';
import {
  callerHarnessCompatibilityDigest,
  parseSessionCompileProposal,
  proposalDigest,
} from '../src/compiler/session/contracts.js';
import { createSessionReviewStore } from '../src/compiler/session/review-store.js';
import type {
  SessionCompilePlanV1,
  SessionCompileProposalV1,
} from '../src/compiler/session/types.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  createBuildLoreLifecycleProfile,
  createProjectLifecycleProfile,
  registerProfileBinding,
  renderLifecycleProfile,
} from '../src/profile/index.js';
import {
  createProjectSyncService,
  createSourceManagement,
  initializeSingleProjectQuickstart,
  parseSourceCollectionManifestV2,
  type GenericSourceKind,
} from '../src/projector/index.js';
import { createProjectRetrieval } from '../src/retrieval/index.js';
import { createWikiReadService } from '../src/wiki/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd, env: { ...process.env, LC_ALL: 'C' } });
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'BuildLore Test']);
  await git(repository, ['config', 'user.email', 'buildlore@example.invalid']);
}

interface SourceFixture {
  readonly id: string;
  readonly kind: GenericSourceKind;
  readonly path: string;
}

interface RetrievalQualityQuery {
  readonly expectedPageRef: string;
  readonly kind: GenericSourceKind | 'json';
  readonly query: string;
}

function failStage(stage: string, error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'unknown';
  throw new Error(`${stage} failed (${code})`);
}

function sourceFixtures(): readonly SourceFixture[] {
  return Object.freeze(Array.from({ length: 20 }, (_, index) => {
    const suffix = String(index).padStart(2, '0');
    if (index < 8) {
      return Object.freeze({
        id: `source-${suffix}`,
        kind: 'markdown' as const,
        path: `docs/markdown-${suffix}.md`,
      });
    }
    if (index < 14) {
      return Object.freeze({
        id: `source-${suffix}`,
        kind: 'text' as const,
        path: `notes/text-${suffix}.txt`,
      });
    }
    return Object.freeze({
      id: `source-${suffix}`,
      kind: 'code' as const,
      path: `code/tool-${suffix}.ts`,
    });
  }));
}

function sourceBody(source: SourceFixture): string {
  const suffix = source.id.slice('source-'.length);
  switch (source.kind) {
    case 'markdown':
      return `# 로컬 위키 문서 ${suffix}\n\n한국어 검색 증거 local-wiki-${suffix}.\n`;
    case 'text':
      return `Portable English evidence local-wiki-${suffix} for offline retrieval.\n`;
    case 'code':
      return `export const portableTool${suffix} = "local-wiki-${suffix}";\n`;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeP2aPlanningFixture(sourceRoot: string): Promise<string> {
  const artifactRef = '.plan2agent/artifacts/alpha';
  const artifactRoot = join(sourceRoot, ...artifactRef.split('/'));
  const iterationRoot = join(artifactRoot, 'iterations/self-hosted');
  const intakeRef = 'iterations/self-hosted/gate-a-intake/intake.json';
  const specRef = 'iterations/self-hosted/gate-b-spec/spec.json';
  await Promise.all([
    mkdir(join(iterationRoot, 'gate-a-intake'), { recursive: true }),
    mkdir(join(iterationRoot, 'gate-b-spec'), { recursive: true }),
    mkdir(join(artifactRoot, 'runs/attempt'), { recursive: true }),
  ]);
  const intake = json({
    assumptions: [],
    clarifying_questions: [],
    evidence: [],
    idea: 'Self-hosted planning fixture',
    known_facts: [],
    needs_user_decision: [],
    schema_version: 'p2a.intake.v1',
    status: 'ready_for_spec',
    summary: 'Collect explicit self-hosted planning documents.',
  });
  const spec = json({
    approval: 'approved',
    clarifying_question_disposition: [],
    evidence: [],
    implementation: {
      architecture: ['Keep self-hosted collection project-confined.'],
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
      goals: ['Collect explicit self-hosted planning documents.'],
      must_preserve: [],
      non_goals: [],
      problem: 'Generated execution state must not become source input.',
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
    at: '2026-08-30T00:00:00.000Z',
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
      at: '2026-08-30T00:01:00.000Z',
      prev_sha256: sha256(JSON.stringify(firstDecision)),
      quote: 'approved',
      scope_ref: specRef,
      seq: 2,
      sha256: sha256(spec),
      type: 'gate.what.approved',
    },
  ].map((value) => JSON.stringify(value)).join('\n');
  await Promise.all([
    writeFile(join(artifactRoot, 'current-spec.json'), json({
      active_iteration: 'self-hosted',
      closed_iterations: [],
      project_id: 'alpha',
      schema_version: 'p2a.current_spec.v1',
    })),
    writeFile(join(artifactRoot, 'decisions.jsonl'), `${decisions}\n`),
    writeFile(join(artifactRoot, intakeRef), intake),
    writeFile(join(artifactRoot, specRef), spec),
    writeFile(join(iterationRoot, 'iteration.json'), json({
      idea: 'Self-hosted planning fixture',
      iteration_id: 'self-hosted',
      project_id: 'alpha',
      schema_version: 'p2a.iteration_metadata.v1',
      status: 'gate_b_approved',
    })),
    writeFile(join(artifactRoot, 'runs/run-index.json'), '{generated execution sentinel'),
    writeFile(join(artifactRoot, 'runs/attempt/p2a.run.json'), '{generated run sentinel'),
  ]);
  return artifactRef;
}

async function fixture(options: {
  readonly selfHosted?: boolean;
} = {}): Promise<Readonly<{
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly sourceRoot: string;
  readonly sources: readonly SourceFixture[];
}>> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-general-wiki-e2e-'));
  temporaryRoots.push(root);
  const origin = join(root, 'knowledge.git');
  const seed = join(root, 'knowledge-seed');
  const sourceRoot = join(root, 'source');
  const hubRoot = options.selfHosted === true ? sourceRoot : join(root, 'hub');
  const sources = sourceFixtures();
  await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', origin, seed]);
  await configureIdentity(seed);
  await writeFile(join(seed, 'README.md'), '# Knowledge\n');
  await git(seed, ['add', 'README.md']);
  await git(seed, ['commit', '-m', 'seed knowledge']);
  await git(seed, ['push', 'origin', 'main']);
  await mkdir(sourceRoot);
  if (hubRoot !== sourceRoot) await mkdir(hubRoot);
  await git(sourceRoot, ['init', '--initial-branch=main']);
  await configureIdentity(sourceRoot);
  await Promise.all([
    mkdir(join(sourceRoot, 'code')),
    mkdir(join(sourceRoot, 'docs')),
    mkdir(join(sourceRoot, 'notes')),
  ]);
  await Promise.all(sources.map(async (source) =>
    writeFile(join(sourceRoot, source.path), sourceBody(source))));
  await git(sourceRoot, ['add', '.']);
  await git(sourceRoot, ['commit', '-m', 'seed twenty generic sources']);
  await initializeSingleProjectQuickstart(hubRoot, {
    branch: 'main',
    knowledgeRepository: '../knowledge.git',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
    sourceRoot,
  });
  const knowledgeRoot = join(hubRoot, 'knowledge');
  await writeSecurityPolicy(knowledgeRoot, 'alpha', { capabilities: ['compile'] });
  return { hubRoot, knowledgeRoot, sourceRoot, sources };
}

async function proposalFiles(
  root: string,
  plan: SessionCompilePlanV1,
): Promise<Readonly<{
  readonly codePageRef: string;
  readonly paths: readonly string[];
  readonly qualityQueries: readonly RetrievalQualityQuery[];
  readonly searchPageRef: string;
}>> {
  const paths: string[] = [];
  let codePageRef: string | undefined;
  let searchPageRef: string | undefined;
  const qualityQueries: RetrievalQualityQuery[] = [];
  for (let index = 0; index < plan.sources.length; index += 1) {
    const source = plan.sources[index];
    if (source === undefined) throw new Error('missing planned source');
    const task = plan.tasks.find((candidate) =>
      candidate.sourceId === source.sourceId && candidate.requestedPageKinds.includes('concept'));
    const citation = source.citationAnchors[0];
    if (task === undefined || citation === undefined) {
      throw new Error('generic source lacks a citable compile task');
    }
    if (source.sourceKind === 'planning') {
      throw new Error('generic acceptance plan contains a P2A source');
    }
    const sourceKind = source.sourceKind;
    const suffix = String(index).padStart(2, '0');
    const slug = `generic-page-${suffix}`;
    const pageRef = `concepts/${slug}`;
    const token = `approved-generic-token-${suffix}`;
    const qualityText = sourceKind === 'markdown'
      ? `한국어 로컬 위키 검색 증거 ${token}`
      : sourceKind === 'text'
        ? `Portable English offline retrieval evidence ${token}`
        : `portableTool${suffix} code symbol evidence ${token}`;
    const draft: SessionCompileProposalV1 = {
      schemaVersion: 'buildlore.compile-proposal.v1',
      body: `${qualityText}.[^evidence]`,
      callerHarness: {
        compatibilityDigest: callerHarnessCompatibilityDigest('codex', '1.0.0'),
        kind: 'codex',
        version: '1.0.0',
      },
      citations: [{
        file: citation.originalFile,
        id: 'evidence',
        line: citation.originalLine,
        quote: citation.quote,
        sourceId: citation.sourceId,
      }],
      confidence: 1,
      kind: 'concept',
      mergeCandidateIds: [],
      pageId: pageRef,
      planDigest: plan.planDigest,
      projectId: plan.projectId,
      proposalDigest: `sha256:${'0'.repeat(64)}`,
      proposalId: `proposal-${slug}`,
      slug,
      sources: task.allowedSourceIds,
      summary: `Verified generic Wiki page ${suffix}.`,
      taskId: task.taskId,
      title: `Generic Wiki Page ${suffix}`,
      wikilinks: [],
    };
    const canonicalDraft = Object.freeze({
      ...draft,
      proposalDigest: proposalDigest(draft),
    });
    const parsedDraft = parseSessionCompileProposal(canonicalDraft, plan.projectId);
    const path = join(root, `${slug}.proposal.json`);
    await writeFile(path, serializeCanonicalJson(parsedDraft));
    paths.push(path);
    if (!qualityQueries.some((query) => query.kind === sourceKind)) {
      qualityQueries.push(Object.freeze({
        expectedPageRef: pageRef,
        kind: sourceKind,
        query: qualityText,
      }));
    }
    if (sourceKind === 'code' && codePageRef === undefined) codePageRef = pageRef;
    if (suffix === '19') searchPageRef = pageRef;
  }
  if (codePageRef === undefined || searchPageRef === undefined || qualityQueries.length !== 3) {
    throw new Error('generic acceptance proposal identities are missing');
  }
  return Object.freeze({
    codePageRef,
    paths: Object.freeze(paths),
    qualityQueries: Object.freeze(qualityQueries),
    searchPageRef,
  });
}

function retrievalMetrics(rankings: readonly Readonly<{
  readonly expectedPageRef: string;
  readonly pageRefs: readonly string[];
}>[]): Readonly<{ readonly mrr: number; readonly recallAt5: number }> {
  const reciprocalRanks = rankings.map(({ expectedPageRef, pageRefs }) => {
    const rank = pageRefs.indexOf(expectedPageRef);
    return rank < 0 ? 0 : 1 / (rank + 1);
  });
  const recallAt5 = rankings.filter(({ expectedPageRef, pageRefs }) =>
    pageRefs.slice(0, 5).includes(expectedPageRef)).length / rankings.length;
  return Object.freeze({
    mrr: reciprocalRanks.reduce((sum, value) => sum + value, 0) / rankings.length,
    recallAt5,
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('general local Wiki acceptance', () => {
  it('[SHW-V-05][SHW-V-06] syncs explicit P2A planning from the self-hosted checkout', async () => {
    const current = await fixture({ selfHosted: true });
    const sourceManagement = createSourceManagement({ hubRoot: current.hubRoot });
    await sourceManagement.add({
      id: current.sources[0]?.id ?? 'source-00',
      kind: 'markdown',
      path: current.sources[0]?.path ?? 'docs/markdown-00.md',
      projectId: 'alpha',
    });
    const planningRef = await writeP2aPlanningFixture(current.sourceRoot);
    const profileWorkspace = join(current.knowledgeRoot, 'projects/alpha');
    await writeFile(
      join(profileWorkspace, 'profile.json'),
      renderLifecycleProfile(createBuildLoreLifecycleProfile('en')),
    );
    const profiles = createProjectLifecycleProfile({ knowledgeRoot: current.knowledgeRoot });
    await profiles.apply(await profiles.plan('alpha'));
    const manifestPath = join(current.sourceRoot, '.buildlore/sources.json');
    const currentManifest = parseSourceCollectionManifestV2(
      JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
    );
    const manifest = parseSourceCollectionManifestV2({
      ...currentManifest,
      sources: [...currentManifest.sources, {
        adapterId: 'buildlore.p2a',
        adapterVersion: 1,
        id: 'planning',
        kind: 'planning',
        path: planningRef,
        pathType: 'directory',
        recursive: true,
      }],
    });
    const manifestBytes = serializeCanonicalJson(manifest);
    await writeFile(manifestPath, manifestBytes);

    await expect(sourceManagement.list('alpha')).resolves.toMatchObject({ declarationCount: 2 });
    const beforeSync = await sourceManagement.diff('alpha');
    expect(beforeSync.records.length).toBeGreaterThanOrEqual(4);
    expect(beforeSync.records.every((record) => record.status === 'added')).toBe(true);
    expect(beforeSync.records.some((record) => record.sourceRef.startsWith(`${planningRef}/`)))
      .toBe(true);
    expect(beforeSync.records.some((record) => record.sourceRef.includes('/runs/'))).toBe(false);
    expect(beforeSync.records.some((record) => /^(?:knowledge|projects|sources|wiki|exports?)(?:\/|$)/u
      .test(record.sourceRef))).toBe(false);
    const planningRoot = join(current.sourceRoot, ...planningRef.split('/'));
    expect(await readFile(join(planningRoot, 'runs/run-index.json'), 'utf8'))
      .toBe('{generated execution sentinel');
    await rm(join(planningRoot, 'runs'), { recursive: true });

    const synchronized = await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    });
    expect(new Set(synchronized.writes.map((write) => write.sourceKind)))
      .toEqual(new Set(['markdown', 'planning']));
    expect(synchronized.writes.every((write) => write.writeStatus === 'create')).toBe(true);
    const repeated = await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    });
    expect(repeated.appliedCount).toBe(0);
    expect(repeated.writes).toHaveLength(synchronized.writes.length);
    expect(repeated.writes.every((write) => write.writeStatus === 'unchanged')).toBe(true);
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBytes);

    const sourceTargets = (await readdir(
      join(current.knowledgeRoot, 'projects/alpha/sources'),
    )).sort();
    expect(sourceTargets).toEqual(synchronized.writes.map((write) => write.target).sort());
    const checkoutEntries = await readdir(current.sourceRoot);
    expect(checkoutEntries).toContain('knowledge');
    expect(checkoutEntries).not.toEqual(expect.arrayContaining([
      'export',
      'exports',
      'projects',
      'sources',
      'wiki',
    ]));
    const exclude = await readFile(join(current.sourceRoot, '.git/info/exclude'), 'utf8');
    expect(exclude).toContain('/.buildlore/local-projects.json\n');
    expect(exclude).toContain('/.buildlore/local-projects.json.lock\n');
    expect(exclude).toContain('/.buildlore/.local-projects.json.*.tmp\n');
  }, 60_000);

  it('[GLW-V-05][GLW-V-07][SHW-V-06][SHW-V-07] runs a self-hosted corpus through Wiki and retrieval quality gates', async () => {
    const current = await fixture({ selfHosted: true });
    expect(current.hubRoot).toBe(current.sourceRoot);
    const sourceManagement = createSourceManagement({ hubRoot: current.hubRoot });
    for (const source of current.sources) {
      await sourceManagement.add({
        id: source.id,
        kind: source.kind,
        path: source.path,
        projectId: 'alpha',
      });
    }
    await expect(sourceManagement.list('alpha')).resolves.toMatchObject({ declarationCount: 20 });
    const beforeSync = await sourceManagement.diff('alpha');
    expect(beforeSync.records).toHaveLength(20);
    expect(beforeSync.records.every((record) => record.status === 'added')).toBe(true);

    const synchronized = await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    });
    expect(synchronized.appliedCount).toBe(20);
    expect(synchronized.writes).toHaveLength(20);
    const afterSync = await sourceManagement.diff('alpha');
    expect(afterSync.records).toHaveLength(20);
    expect(afterSync.records.every((record) => record.status === 'unchanged')).toBe(true);
    const repeatedSync = await createProjectSyncService().sync({
      dryRun: false,
      hubRoot: current.hubRoot,
      projectId: 'alpha',
    });
    expect(repeatedSync).toMatchObject({
      appliedCount: 0,
      remainingCount: 0,
    });
    expect(repeatedSync.writes).toHaveLength(20);
    expect(repeatedSync.writes.every((write) => write.writeStatus === 'unchanged')).toBe(true);

    const binding = registerProfileBinding(JSON.parse(await readFile(
      join(current.knowledgeRoot, 'projects/alpha/profile-binding.json'),
      'utf8',
    )) as unknown);
    expect(binding.binding.profileId).toBe('general');
    expect(binding.sourceAdapters.list().map((adapter) => adapter.adapterId))
      .toEqual(['buildlore.generic']);

    const compiler = createProjectSessionCompiler({
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
    });
    const plan = await compiler.plan({ projectId: 'alpha' });
    expect(plan.sources).toHaveLength(20);
    expect(new Set(plan.sources.map((source) => source.sourceKind))).toEqual(
      new Set(['code', 'markdown', 'text']),
    );
    const proposals = await proposalFiles(current.hubRoot, plan);
    await expect(compiler.plan({ projectId: 'alpha' })).resolves.toEqual(plan);
    const applied = await compiler.apply({
      projectId: 'alpha',
      proposalFiles: proposals.paths,
    }).catch((error: unknown) => failStage('compile apply', error));
    expect(applied).toMatchObject({ admittedCount: 20, heldCount: 20, reviewRequired: true });
    const candidates = await compiler.candidates({ projectId: 'alpha' });
    expect(candidates.candidates).toHaveLength(20);
    for (const candidate of candidates.candidates) {
      await expect(compiler.approve({
        candidateId: candidate.candidateId,
        projectId: 'alpha',
      }).catch((error: unknown) => failStage('candidate approval', error)))
        .resolves.toMatchObject({ outcome: 'approved', providerUsed: false });
    }
    const store = createSessionReviewStore(
      join(current.knowledgeRoot, 'projects', 'alpha'),
      'alpha',
    );
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.listProofs()).resolves.toHaveLength(20);

    const wiki = createWikiReadService({ knowledgeRoot: current.knowledgeRoot });
    const listed = await wiki.list({ limit: 100, projectId: 'alpha' })
      .catch((error: unknown) => failStage('wiki list', error));
    expect(listed.total).toBe(20);
    expect(listed.pages).toHaveLength(20);
    const page = await wiki.read({ pageRef: proposals.searchPageRef, projectId: 'alpha' })
      .catch((error: unknown) => failStage('wiki read', error));
    expect(page.body).toContain('approved-generic-token-19');
    const citations = await wiki.citations({
      pageRef: proposals.codePageRef,
      projectId: 'alpha',
    }).catch((error: unknown) => failStage('wiki citations', error));
    expect(citations.citations).toHaveLength(1);
    expect(citations.citations[0]?.range.startLine).toBe(1);
    expect(citations.citations[0]?.sourceRef).toMatch(/^code\/tool-\d{2}\.ts$/u);

    const searched = await createProjectRetrieval({ knowledgeRoot: current.knowledgeRoot }).search({
      mode: 'lexical',
      projectId: 'alpha',
      query: 'approved-generic-token-19',
    });
    expect(searched.effectiveMode).toBe('lexical');
    expect(searched.excluded.unverified).toBe(0);
    expect(searched.hits.map((hit) => hit.pageId)).toContain(proposals.searchPageRef);

    const rankings = await Promise.all(proposals.qualityQueries.map(async (quality) => {
      const result = await createProjectRetrieval({ knowledgeRoot: current.knowledgeRoot }).search({
        mode: 'lexical',
        projectId: 'alpha',
        query: quality.query,
      });
      expect(result.effectiveMode).toBe('lexical');
      expect(result.excluded.unverified).toBe(0);
      return Object.freeze({
        expectedPageRef: quality.expectedPageRef,
        pageRefs: Object.freeze(result.hits.map((hit) => hit.pageId)),
      });
    }));
    expect(new Set(proposals.qualityQueries.map((query) => query.kind))).toEqual(
      new Set(['code', 'markdown', 'text']),
    );
    const approvedBaseline = Object.freeze({ mrr: 1, recallAt5: 1 });
    const metrics = retrievalMetrics(rankings);
    expect(metrics.recallAt5).toBeGreaterThanOrEqual(approvedBaseline.recallAt5);
    expect(metrics.mrr).toBeGreaterThanOrEqual(approvedBaseline.mrr);
  }, 180_000);
});
