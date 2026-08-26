import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  finalizeSessionCompilePlan,
  SESSION_COMPILE_CONTRACT_DIGEST,
  SESSION_COMPILE_LIMITS,
} from '../src/compiler/session/contracts.js';
import {
  createSessionCitationAnchors,
  createSessionTasksAndMerges,
} from '../src/compiler/session/planner-pure.js';
import { SessionCompileError } from '../src/compiler/session/errors.js';
import {
  SESSION_COMPILE_ALGORITHM_VERSION,
  SESSION_COMPILE_PLAN_SCHEMA_VERSION,
  type SessionPlannedSource,
} from '../src/compiler/session/types.js';
import { sessionSha256 } from '../src/compiler/session/canonical.js';
import {
  bindLocalProject,
  initializeLocalProjectRegistry,
  resolveLocalProjectBinding,
} from '../src/knowledge/local-project-registry.js';
import { addProject } from '../src/knowledge/index.js';
import { createProjectSyncService } from '../src/projector/index.js';
import { parseSourceDocument, renderSourceDocument } from '../src/projector/source-document.js';
import {
  createSourceCollectionAdapter,
} from '../src/projector/collection-adapters.js';
import {
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
} from '../src/projector/source-manifest.js';
import { createSessionCompilePlanner } from '../src/compiler/session/source-planner.js';
import { readSessionKnowledgeInventory } from '../src/compiler/session/inventory.js';
import {
  prepareCompilerEgress,
  verifyAndConsumeCompilerEgress,
} from '../src/compiler/security.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import {
  createProjectSecurityService,
  readSecurityPolicy,
} from '../src/sanitizer/index.js';
import { consumePreparedSource } from '../src/sanitizer/approval.js';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd }, (error) => {
      if (error === null) resolve();
      else reject(new Error('Git fixture command failed.', { cause: error }));
    });
  });
}

async function directoryDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : 1)) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      hash.update(relative);
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else hash.update(await readFile(join(directory, entry.name)));
    }
  }
  await visit(root);
  return hash.digest('hex');
}

function source(idCharacter: string, sourceRef: string, body: string): SessionPlannedSource {
  const sourceId = `source-${idCharacter.repeat(64)}`;
  return Object.freeze({
    citationAnchors: createSessionCitationAnchors({
      originalBody: body,
      sanitizedBody: body,
      sourceId,
      sourceRef,
    }),
    originalContentDigest: DIGEST,
    revision: DIGEST,
    sanitizedBody: body,
    sanitizedContentDigest: DIGEST,
    sourceId,
    sourceKind: 'planning',
    sourceRef,
    title: 'Session compile',
  });
}

describe('session compile deterministic plan', () => {
  it('anchors only unchanged original lines and preserves original line numbers', () => {
    const anchors = createSessionCitationAnchors({
      originalBody: 'first\r\nsecret value\r\nthird',
      sanitizedBody: 'first\n[REDACTED]\nthird',
      sourceId: `source-${'b'.repeat(64)}`,
      sourceRef: 'docs/source.md',
    });

    expect(anchors.map(({ originalFile, originalLine, quote }) => ({
      originalFile,
      originalLine,
      quote,
    }))).toEqual([
      { originalFile: 'docs/source.md', originalLine: 1, quote: 'first' },
      { originalFile: 'docs/source.md', originalLine: 3, quote: 'third' },
    ]);
  });

  it('keeps frontmatter offsets and Unicode exactness while excluding transformed or truncated lines', () => {
    const sourceId = `source-${'c'.repeat(64)}`;
    const original = [
      '---',
      'title: Evidence',
      '---',
      'café evidence',
      'cafe\u0301 transformed',
      'x'.repeat(513),
    ].join('\r\n');
    const sanitized = [
      '---',
      'title: Evidence',
      '---',
      'café evidence',
      'café transformed',
      'x'.repeat(512),
    ].join('\n');

    const anchors = createSessionCitationAnchors({
      originalBody: original,
      sanitizedBody: sanitized,
      sourceId,
      sourceRef: 'docs/frontmatter.md',
    });

    expect(anchors.map(({ originalLine, quote }) => ({ originalLine, quote }))).toEqual([
      { originalLine: 1, quote: '---' },
      { originalLine: 2, quote: 'title: Evidence' },
      { originalLine: 3, quote: '---' },
      { originalLine: 4, quote: 'café evidence' },
    ]);
  });

  it('produces stable tasks and cross-source merge candidates independent of input order', () => {
    const left = source('b', 'docs/left.md', '# Session Compile\nLeft evidence.');
    const right = source('c', 'docs/right.md', '# Session Compile\nRight evidence.');

    const forward = createSessionTasksAndMerges([left, right], 'default', 'alpha');
    const reverse = createSessionTasksAndMerges([right, left], 'default', 'alpha');

    expect(reverse).toEqual(forward);
    expect(forward.tasks).toHaveLength(2);
    expect(forward.tasks.every((task) =>
      task.requestedPageKinds.join(',') === 'concept,query')).toBe(true);
    expect(forward.mergeCandidates).toHaveLength(1);
    expect(forward.mergeCandidates[0]).toMatchObject({
      deterministicEvidence: {
        scoreBasisPoints: 10_000,
        sharedTokens: ['compile', 'session'],
      },
    });
  });

  it('enforces cross-source two-token Jaccard threshold and deterministic tie ordering', () => {
    const accepted = createSessionTasksAndMerges([
      source('b', 'docs/accepted-left.md', '# Alpha Beta Gamma\nLeft.'),
      source('c', 'docs/accepted-right.md', '# Alpha Beta Delta\nRight.'),
    ], 'default', 'alpha');
    expect(accepted.mergeCandidates).toHaveLength(1);
    expect(accepted.mergeCandidates[0]?.deterministicEvidence).toEqual({
      scoreBasisPoints: 5_000,
      sharedTokens: ['alpha', 'beta'],
    });

    const rejected = createSessionTasksAndMerges([
      source('d', 'docs/rejected-left.md', '# Alpha Beta Gamma Delta\nLeft.'),
      source('e', 'docs/rejected-right.md', '# Alpha Beta Epsilon Zeta\nRight.'),
    ], 'default', 'alpha');
    expect(rejected.mergeCandidates).toEqual([]);

    const sameSource = source('f', 'docs/same.md', '# Shared Heading\nOne.\n# Shared Heading\nTwo.');
    expect(createSessionTasksAndMerges([sameSource], 'default', 'alpha').mergeCandidates)
      .toEqual([]);

    const tied = createSessionTasksAndMerges([
      source('1', 'docs/one.md', '# Shared Heading\nOne.'),
      source('2', 'docs/two.md', '# Shared Heading\nTwo.'),
      source('3', 'docs/three.md', '# Shared Heading\nThree.'),
    ], 'default', 'alpha').mergeCandidates;
    expect(tied).toHaveLength(3);
    expect(tied.map((candidate) => candidate.orderingKey)).toEqual(
      [...tied.map((candidate) => candidate.orderingKey)].sort(),
    );
  });

  it('uses only Unicode letter/number tokens and does not merge punctuation-only headings', () => {
    const separated = createSessionTasksAndMerges([
      source('a', 'docs/separated-left.md', '# Alpha-beta_value\nLeft.'),
      source('b', 'docs/separated-right.md', '# Alpha beta value\nRight.'),
    ], 'default', 'alpha');
    expect(separated.mergeCandidates).toHaveLength(1);
    expect(separated.mergeCandidates[0]?.deterministicEvidence.sharedTokens)
      .toEqual(['alpha', 'beta', 'value']);

    const punctuation = createSessionTasksAndMerges([
      source('c', 'docs/punctuation-left.md', '# ---\nLeft.'),
      source('d', 'docs/punctuation-right.md', '# ___\nRight.'),
    ], 'default', 'alpha');
    expect(punctuation.tasks.map((task) => task.headingKey)).toEqual(['document', 'document']);
    expect(punctuation.mergeCandidates).toEqual([]);
  });

  it('preserves well-formed Unicode heading keys and rejects schema-bound overflow', () => {
    const supplementaryLetter = '\u{10400}'.repeat(256);
    const unicode = createSessionTasksAndMerges([
      source('d', 'docs/unicode.md', `# ${supplementaryLetter}\nEvidence.`),
    ], 'default', 'alpha');
    const key = unicode.tasks[0]?.headingKey ?? '';
    expect([...key]).toHaveLength(256);
    expect(Buffer.from(key, 'utf8').toString('utf8')).toBe(key);

    const excessiveToken = '\u{10400}'.repeat(257);
    expect(() => createSessionTasksAndMerges([
      source('e', 'docs/excessive-token.md', `# ${excessiveToken}\nEvidence.`),
    ], 'default', 'alpha')).toThrowError(SessionCompileError);

    const excessiveTokens = Array.from({ length: 257 }, (_, index) =>
      `t${String(index).padStart(3, '0')}`).join(' ');
    expect(() => createSessionTasksAndMerges([
      source('f', 'docs/excessive-tokens.md', `# ${excessiveTokens}\nEvidence.`),
    ], 'default', 'alpha')).toThrowError(SessionCompileError);
  });

  it('fails instead of truncating merge candidates at the public contract limit', () => {
    const sources = Array.from({ length: 33 }, (_, index) => {
      const item = source('a', `docs/source-${String(index)}.md`, '# Shared Heading\nEvidence.');
      const sourceId = `source-${index.toString(16).padStart(64, '0')}`;
      return Object.freeze({
        ...item,
        citationAnchors: createSessionCitationAnchors({
          originalBody: item.sanitizedBody,
          sanitizedBody: item.sanitizedBody,
          sourceId,
          sourceRef: item.sourceRef,
        }),
        sourceId,
      });
    });

    expect(() => createSessionTasksAndMerges(sources, 'default', 'alpha'))
      .toThrowError(SessionCompileError);
  });

  it('does not hide a real heading after an indented code-literal fence marker', () => {
    const planned = createSessionTasksAndMerges([
      source('e', 'docs/indented.md', '    ```\n# Visible Heading\n    ```'),
    ], 'default', 'alpha');

    expect(planned.tasks.map((task) => task.headingKey)).toContain('heading-visible');
  });

  it('rejects a wiki-root symlink before reading sibling inventory', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-wiki-root-'));
    const sibling = await mkdtemp(join(process.cwd(), '.test-tmp-session-wiki-sibling-'));
    try {
      await mkdir(join(sibling, 'wiki', 'graph'), { recursive: true });
      await writeFile(
        join(sibling, 'wiki', 'graph', 'relations.jsonl'),
        '{"private":"sibling-marker"}\n',
        'utf8',
      );
      await symlink(join(sibling, 'wiki'), join(workspace, 'wiki'));

      const error = await readSessionKnowledgeInventory(workspace, 'alpha')
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: 'SESSION_PLAN_DENIED', projectId: 'alpha' });
      expect(JSON.stringify(error)).not.toContain('sibling-marker');
    } finally {
      await Promise.all([workspace, sibling].map(async (root) =>
        rm(root, { force: true, recursive: true })));
    }
  });

  it('binds the complete plan to a reproducible digest', () => {
    const plannedSource = source('d', 'plans/entry.md', '# Entry\nEvidence.');
    const planned = createSessionTasksAndMerges([plannedSource], 'custom', 'alpha');
    const input = {
      schemaVersion: SESSION_COMPILE_PLAN_SCHEMA_VERSION,
      projectId: 'alpha',
      contractDigest: SESSION_COMPILE_CONTRACT_DIGEST,
      profileDigest: DIGEST,
      policyDigest: DIGEST,
      selectionDigest: DIGEST,
      sourceManifestDigest: DIGEST,
      existingKnowledgeDigest: DIGEST,
      algorithmVersion: SESSION_COMPILE_ALGORITHM_VERSION,
      limits: SESSION_COMPILE_LIMITS,
      sources: [plannedSource],
      tasks: planned.tasks,
      mergeCandidates: planned.mergeCandidates,
      allowedLinkTargets: [],
    } as const;

    expect(finalizeSessionCompilePlan(input)).toEqual(finalizeSessionCompilePlan(input));
    expect(finalizeSessionCompilePlan(input).planDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('makes a deterministic finite inventory-bound plan with zero LLM/provider/agent/child-process/SDK mutation or sibling reads/writes and denies egress, sanitizer findings, stale originals, and symlink state', async () => {
    const hubRoot = await mkdtemp(join(process.cwd(), '.test-tmp-session-planner-'));
    const sourceRoot = await mkdtemp(join(process.cwd(), '.test-tmp-session-source-'));
    try {
      const knowledgeRoot = join(hubRoot, 'knowledge');
      const sourceRepository = 'https://example.test/alpha.git';
      await mkdir(knowledgeRoot);
      await git(sourceRoot, ['init', '--initial-branch=main']);
      await git(sourceRoot, ['config', 'user.name', 'BuildLore Test']);
      await git(sourceRoot, ['config', 'user.email', 'buildlore@example.invalid']);
      await Promise.all([
        mkdir(join(sourceRoot, '.buildlore')),
        mkdir(join(sourceRoot, 'docs')),
      ]);
      await writeFile(
        join(sourceRoot, 'docs', 'overview.md'),
        '# Session Compile\n\nOriginal public evidence.\n',
        'utf8',
      );
      await writeFile(join(sourceRoot, '.buildlore', 'sources.json'), JSON.stringify({
        projectId: 'alpha',
        schemaVersion: 'buildlore.sources.v1',
        sourceRepository,
        sources: [{
          documentKind: 'markdown',
          id: 'docs',
          path: 'docs',
          pathType: 'directory',
          recursive: true,
        }],
      }, null, 2) + '\n', 'utf8');
      await git(sourceRoot, ['add', '.']);
      await git(sourceRoot, ['commit', '-m', 'seed source']);
      await addProject(knowledgeRoot, {
        displayName: 'Alpha',
        projectId: 'alpha',
        sourceRepository,
      });
      await addProject(knowledgeRoot, {
        displayName: 'Beta',
        projectId: 'beta',
        sourceRepository: 'https://example.test/beta.git',
      });
      await Promise.all([
        writeSecurityPolicy(knowledgeRoot, 'alpha'),
        writeSecurityPolicy(knowledgeRoot, 'beta'),
      ]);
      await initializeLocalProjectRegistry(hubRoot);
      await bindLocalProject(hubRoot, {
        expectedBindingDigest: null,
        projectId: 'alpha',
        sourceRepository,
        sourceRoot,
      });
      await createProjectSyncService().sync({
        dryRun: false,
        hubRoot,
        projectId: 'alpha',
      });
      const workspace = join(knowledgeRoot, 'projects', 'alpha');
      const siblingWorkspace = join(knowledgeRoot, 'projects', 'beta');
      await writeFile(join(siblingWorkspace, 'sibling-private.txt'), 'beta-private-marker\n', 'utf8');
      const siblingBefore = await directoryDigest(siblingWorkspace);
      await Promise.all([
        mkdir(join(workspace, 'wiki', 'concepts'), { recursive: true }),
        mkdir(join(workspace, 'wiki', 'graph'), { recursive: true }),
        mkdir(join(workspace, 'wiki', 'outputs', 'workflows'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(workspace, 'wiki', 'concepts', 'existing-page.md'),
          '# Existing page\n',
          'utf8',
        ),
        writeFile(
          join(workspace, 'wiki', 'graph', 'relations.jsonl'),
          '{"type":"relation"}\n',
          'utf8',
        ),
        writeFile(
          join(workspace, 'wiki', 'outputs', 'workflows', 'fixture.md'),
          '# Workflow output\n',
          'utf8',
        ),
      ]);
      const storedNames = await readdir(join(workspace, 'sources'));
      expect(storedNames).toHaveLength(1);
      const storedRaw = await readFile(
        join(workspace, 'sources', storedNames[0] ?? ''),
        'utf8',
      );
      const stored = parseSourceDocument(storedRaw);
      expect(renderSourceDocument(stored)).toBe(storedRaw);
      expect(stored).toMatchObject({
        body: '# Session Compile\n\nOriginal public evidence.\n',
        buildlore: { projectId: 'alpha', sourceKind: 'markdown' },
        title: 'Session Compile',
      });
      const checkout = await resolveLocalProjectBinding(
        hubRoot,
        'alpha',
        sourceRepository,
      );
      const loadedManifest = await readSourceCollectionManifest(checkout.checkout, 'alpha');
      const selected = await selectDeclaredSourceFiles(checkout.checkout, loadedManifest);
      const collected = await createSourceCollectionAdapter().collect({
        checkout: checkout.checkout,
        inventory: selected,
        loadedManifest,
        markdownIngestedAt: '1970-01-01T00:00:00.000Z',
      });
      const candidate = collected.candidates[0];
      if (candidate === undefined) throw new Error('missing collection fixture');
      const policy = await readSecurityPolicy(knowledgeRoot, 'alpha');
      const security = createProjectSecurityService({ knowledgeRoot });
      const titleResult = await security.prepareSource({
        body: candidate.title,
        bodyDigest: sessionSha256(candidate.title),
        projectId: 'alpha',
        source: candidate.sourceUri,
        sourceKind: 'markdown',
        sourceRevisionOrContentSha256: candidate.sourceRevision,
      });
      const bodyResult = await security.prepareSource({
        body: candidate.body,
        bodyDigest: sessionSha256(candidate.body),
        projectId: 'alpha',
        source: candidate.sourceUri,
        sourceKind: 'markdown',
        sourceRevisionOrContentSha256: candidate.sourceRevision,
      });
      expect(titleResult).toMatchObject({ ok: true, report: { policyDigest: policy.digest } });
      expect(bodyResult).toMatchObject({ ok: true, report: { policyDigest: policy.digest } });
      if (!titleResult.ok || !bodyResult.ok) throw new Error('sanitization fixture rejected');
      expect(consumePreparedSource(titleResult.prepared)?.approvedBody).toBe(stored.title);
      expect(`${consumePreparedSource(bodyResult.prepared)?.approvedBody}\n`).toBe(stored.body);
      expect(candidate).toMatchObject({
        sourceRevision: stored.buildlore.sourceRevision,
        sourceUri: stored.source,
      });
      const egressRequest = { capability: 'compile' as const, projectId: 'alpha' };
      const permit = await prepareCompilerEgress(knowledgeRoot, workspace, egressRequest);
      await verifyAndConsumeCompilerEgress(
        permit,
        knowledgeRoot,
        workspace,
        egressRequest,
      );
      const before = await directoryDigest(workspace);
      const phases: string[] = [];
      const planner = createSessionCompilePlanner({
        hubRoot,
        knowledgeRoot,
        onPhase: (phase) => phases.push(phase),
      });

      let first;
      try {
        first = await planner.create('alpha');
      } catch (error) {
        throw new Error(`Session planner stopped after ${phases.at(-1) ?? 'start'}.`, {
          cause: error,
        });
      }
      const second = await planner.create('alpha');

      expect(second.plan).toEqual(first.plan);
      expect(first.plan.sources).toHaveLength(1);
      expect(first.plan.sources[0]?.sourceRef).toBe('docs/overview.md');
      expect(first.plan.sources[0]?.citationAnchors.map((anchor) => anchor.originalLine))
        .toEqual([1, 3]);
      expect(first.plan.tasks.length).toBeGreaterThan(0);
      expect(first.plan.allowedLinkTargets).toEqual([{
        pageId: 'concepts/existing-page',
        slug: 'existing-page',
      }]);
      expect(first.plan.limits).toEqual(SESSION_COMPILE_LIMITS);
      expect(JSON.stringify(first.plan)).not.toMatch(/beta-private-marker|projects\/beta/u);
      expect(phases).toEqual([
        'project-resolved',
        'binding-resolved',
        'sources-collected',
        'policy-resolved',
        'source-bound',
        'source-sanitized',
        'source-stored-verified',
        'source-original-read',
        'sources-verified',
        'egress-authorized',
        'inventory-read',
        'project-resolved',
        'binding-resolved',
        'sources-collected',
        'policy-resolved',
        'source-bound',
        'source-sanitized',
        'source-stored-verified',
        'source-original-read',
        'sources-verified',
        'egress-authorized',
        'inventory-read',
      ]);
      expect(await directoryDigest(workspace)).toBe(before);

      await mkdir(join(workspace, '.llmwiki', 'candidates', 'archive'), { recursive: true });
      expect((await planner.create('alpha')).plan).toEqual(first.plan);
      await writeFile(join(workspace, 'wiki', 'rogue.md'), '# Rogue page\n', 'utf8');
      await expect(planner.create('alpha')).rejects.toMatchObject({
        code: 'SESSION_PLAN_DENIED',
        projectId: 'alpha',
      });
      await rm(join(workspace, 'wiki', 'rogue.md'));
      await rm(join(workspace, '.llmwiki', 'candidates'), { recursive: true });
      await symlink(join(workspace, 'wiki'), join(workspace, '.llmwiki', 'candidates'));
      await expect(planner.create('alpha')).rejects.toMatchObject({
        code: 'SESSION_PLAN_DENIED',
        projectId: 'alpha',
      });
      await rm(join(workspace, '.llmwiki', 'candidates'), { force: true, recursive: true });

      await writeSecurityPolicy(knowledgeRoot, 'alpha', { capabilities: [] });
      const deniedEgressBefore = await directoryDigest(workspace);
      await expect(planner.create('alpha')).rejects.toMatchObject({
        code: 'SESSION_PLAN_DENIED',
        projectId: 'alpha',
      });
      await expect(directoryDigest(workspace)).resolves.toBe(deniedEgressBefore);
      await writeSecurityPolicy(knowledgeRoot, 'alpha');

      await writeFile(
        join(sourceRoot, 'docs', 'overview.md'),
        '# Session Compile\n\nOriginal changed after projection.\n',
        'utf8',
      );
      const staleBefore = await directoryDigest(workspace);
      await expect(planner.create('alpha')).rejects.toMatchObject({
        code: 'SESSION_PLAN_DENIED',
        projectId: 'alpha',
      });
      await expect(directoryDigest(workspace)).resolves.toBe(staleBefore);

      const unsafeValue = ['sk-', 'Q1w2E3r4T5y6U7i8O9p0', 'AsDfGhJk'].join('');
      await writeFile(
        join(sourceRoot, 'docs', 'overview.md'),
        `# Session Compile\n\ncredential=${unsafeValue}\n`,
        'utf8',
      );
      await git(sourceRoot, ['add', 'docs/overview.md']);
      await git(sourceRoot, ['commit', '-m', 'unsafe runtime fixture']);
      const unsafeManifest = await readSourceCollectionManifest(checkout.checkout, 'alpha');
      const unsafeSelection = await selectDeclaredSourceFiles(checkout.checkout, unsafeManifest);
      const unsafeCollection = await createSourceCollectionAdapter().collect({
        checkout: checkout.checkout,
        inventory: unsafeSelection,
        loadedManifest: unsafeManifest,
        markdownIngestedAt: '1970-01-01T00:00:00.000Z',
      });
      const unsafeCandidate = unsafeCollection.candidates[0];
      if (unsafeCandidate === undefined) throw new Error('missing unsafe runtime fixture');
      await writeFile(
        join(workspace, 'sources', storedNames[0] ?? ''),
        renderSourceDocument(unsafeCandidate.canonicalDocument),
        'utf8',
      );
      const sanitizerBefore = await directoryDigest(workspace);
      const sanitizerError = await planner.create('alpha').catch((error: unknown) => error);
      expect(sanitizerError).toMatchObject({
        code: 'SESSION_PLAN_DENIED',
        projectId: 'alpha',
      });
      expect(JSON.stringify(sanitizerError)).not.toContain(unsafeValue);
      await expect(directoryDigest(workspace)).resolves.toBe(sanitizerBefore);
      await expect(directoryDigest(siblingWorkspace)).resolves.toBe(siblingBefore);
    } finally {
      await Promise.all([hubRoot, sourceRoot].map(async (root) =>
        rm(root, { force: true, recursive: true })));
    }
  });
});
