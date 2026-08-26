import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createSessionCompileAdmission,
  type SessionCompileAdmissionPort,
} from '../src/compiler/session/admission.js';
import {
  SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
  SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION,
  type SessionCompileProposalV1,
  type SessionCompileProvenanceV1,
} from '../src/compiler/session/types.js';
import type { ValidatedSessionBatch } from '../src/compiler/session/validator.js';
import {
  createBuildLoreLifecycleProfile,
  materializeLifecycleProfile,
} from '../src/profile/index.js';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SOURCE_ID = `source-${'b'.repeat(64)}` as const;
const TASK_ID = `task-${'c'.repeat(64)}` as const;

function validatedBatch(
  kind: 'concept' | 'decision' | 'failure' | 'verification',
): ValidatedSessionBatch {
  const slug = `session-${kind}`;
  const directory = kind === 'concept' ? 'concepts' : `${kind}s`;
  const profileFields = kind === 'decision'
    ? { status: 'active' }
    : kind === 'failure'
      ? { failureClass: 'test', status: 'open' }
      : kind === 'verification'
        ? { evidenceRefs: ['evidence-ref'], status: 'recorded', verificationKind: 'test' }
        : undefined;
  const proposal: SessionCompileProposalV1 = {
    schemaVersion: SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
    projectId: 'alpha',
    planDigest: DIGEST,
    proposalId: `proposal-${slug}`,
    proposalDigest: DIGEST,
    taskId: TASK_ID,
    mergeCandidateIds: [],
    pageId: `${directory}/${slug}`,
    slug,
    title: 'Session output',
    kind,
    summary: 'Review-only session output.',
    body: 'Evidence.[^evidence]',
    sources: [SOURCE_ID],
    wikilinks: [],
    citations: [{
      file: 'docs/evidence.md',
      id: 'evidence',
      line: 4,
      quote: 'Evidence.',
      sourceId: SOURCE_ID,
    }],
    confidence: 0.75,
    callerHarness: { compatibilityDigest: DIGEST, kind: 'codex', version: '1.0.0' },
    ...(profileFields === undefined ? {} : { profileFields }),
  };
  const provenance: SessionCompileProvenanceV1 = {
    schemaVersion: SESSION_COMPILE_PROVENANCE_SCHEMA_VERSION,
    projectId: 'alpha',
    planDigest: DIGEST,
    proposalDigest: DIGEST,
    sourceManifestDigest: DIGEST,
    profileDigest: DIGEST,
    policyDigest: DIGEST,
    callerHarness: proposal.callerHarness,
    contractDigest: DIGEST,
    bindingDigest: DIGEST,
  };
  return Object.freeze({
    batchDigest: DIGEST,
    harness: proposal.callerHarness,
    pages: Object.freeze([Object.freeze({ proposal, provenance })]),
  });
}

describe('session compile OKF admission', () => {
  it('stages a provenance-bound default candidate through the exact public SDK with bounded counts, reviewRequired, no live page, and no sibling-project mutation', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-sdk-'));
    const sibling = await mkdtemp(join(process.cwd(), '.test-tmp-session-sdk-sibling-'));
    try {
      await Promise.all([
        mkdir(join(workspace, 'sources')),
        mkdir(join(workspace, 'wiki')),
        writeFile(join(sibling, 'sentinel.txt'), 'sibling-private-marker\n', 'utf8'),
      ]);
      const result = await createSessionCompileAdmission().stage(
        workspace,
        'alpha',
        'default',
        validatedBatch('concept'),
      );

      expect(result).toMatchObject({
        admissionKind: 'untrusted-okf',
        admittedCount: 1,
        candidateRefs: ['concepts/session-concept'],
        heldCount: 1,
        outcome: 'staged',
        recoveryAction: 'review',
        reviewRequired: true,
        sideEffectsPossible: false,
        skippedCount: 0,
        warnings: [],
      });
      const candidates = await readdir(join(workspace, '.llmwiki', 'candidates'));
      expect(candidates).toHaveLength(1);
      const candidate = await readFile(
        join(workspace, '.llmwiki', 'candidates', candidates[0] ?? ''),
        'utf8',
      );
      expect(candidate).toContain('originalFrontmatter');
      expect(candidate).toContain('bindingDigest');
      for (const key of [
        'planDigest',
        'proposalDigest',
        'sourceManifestDigest',
        'profileDigest',
        'policyDigest',
        'contractDigest',
        'compatibilityDigest',
      ]) {
        expect(candidate).toContain(key);
      }
      expect(candidate).toContain('kind');
      expect(candidate).toContain('version');
      expect(candidate).not.toContain(workspace);
      expect(candidate).not.toContain(sibling);
      expect(candidate).not.toContain('sibling-private-marker');
      expect(candidate).not.toMatch(/credential|executablePath/u);
      await expect(stat(join(workspace, 'wiki', 'concepts', 'session-concept.md')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(sibling, 'sentinel.txt'), 'utf8'))
        .resolves.toBe('sibling-private-marker\n');
      await expect(readdir(sibling)).resolves.toEqual(['sentinel.txt']);
    } finally {
      await Promise.all([workspace, sibling].map(async (root) =>
        rm(root, { force: true, recursive: true })));
    }
  });

  it.each(['decision', 'failure', 'verification'] as const)(
    'stages a custom-profile %s candidate through the exact public SDK without promotion',
    async (kind) => {
    const workspace = await mkdtemp(join(process.cwd(), '.test-tmp-session-custom-sdk-'));
    try {
      await Promise.all([
        mkdir(join(workspace, 'sources')),
        mkdir(join(workspace, 'wiki')),
        mkdir(join(workspace, '.llmwiki')),
      ]);
      const materialized = materializeLifecycleProfile(
        createBuildLoreLifecycleProfile('en'),
      );
      await Promise.all([
        writeFile(join(workspace, '.llmwiki', 'profile.json'), materialized.profileJson, 'utf8'),
        writeFile(join(workspace, '.llmwiki', 'config.json'), materialized.configJson, 'utf8'),
      ]);

      const result = await createSessionCompileAdmission().stage(
        workspace,
        'alpha',
        'custom',
        validatedBatch(kind),
      );

      expect(result).toMatchObject({
        admittedCount: 1,
        candidateRefs: [`${kind}s/session-${kind}`],
        heldCount: 1,
        outcome: 'staged',
        reviewRequired: true,
        sideEffectsPossible: false,
      });
      const candidates = await readdir(join(workspace, '.llmwiki', 'candidates'));
      expect(candidates).toHaveLength(1);
      const candidate = await readFile(
        join(workspace, '.llmwiki', 'candidates', candidates[0] ?? ''),
        'utf8',
      );
      expect(candidate).toContain('targetEntityType');
      expect(candidate).toContain(`${kind}s`);
      expect(candidate).toContain('bindingDigest');
      await expect(stat(join(workspace, 'wiki', `${kind}s`, `session-${kind}.md`)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it.each([
    ['default', 'concept', 'pages'] as const,
    ['custom', 'decision', 'typed'] as const,
  ])('uses dryRun:true then trusted:false only and returns reviewRequired staged %s %s output',
    async (profileMode, kind, reportSection) => {
      const batch = validatedBatch(kind);
      const calls: Array<Readonly<{
        readonly bundle: string;
        readonly dryRun: boolean;
        readonly rendered: string;
        readonly trusted: false;
      }>> = [];
      const page = batch.pages[0]?.proposal;
      if (page === undefined) throw new Error('missing fixture page');
      const port: SessionCompileAdmissionPort = {
        async importOkf(_workspace, bundle, options): Promise<unknown> {
          const rendered = await readFile(join(bundle, `${page.pageId}.md`), 'utf8');
          calls.push({
            bundle,
            dryRun: options.dryRun === true,
            rendered,
            trusted: options.trusted,
          });
          const item = reportSection === 'pages'
            ? { okfPath: `${page.pageId}.md`, slug: page.slug, targetDirectory: 'concepts' }
            : {
                entityType: 'decisions',
                okfPath: `${page.pageId}.md`,
                outcome: 'staged-typed',
                slug: page.slug,
              };
          return {
            mode: options.dryRun === true ? 'dry-run' : 'staged',
            pages: reportSection === 'pages' ? [item] : [],
            typed: reportSection === 'typed' ? [item] : undefined,
            warnings: [],
            skipped: [],
            relationOutcomes: [],
          };
        },
      };
      const admission = createSessionCompileAdmission({ port });

      const result = await admission.stage('/workspace', 'alpha', profileMode, batch);

      expect(calls.map(({ dryRun, trusted }) => ({ dryRun, trusted }))).toEqual([
        { dryRun: true, trusted: false },
        { dryRun: false, trusted: false },
      ]);
      expect(calls[0]?.bundle).toBe(calls[1]?.bundle);
      expect(calls[0]?.rendered).toContain('buildlore:');
      expect(calls[0]?.rendered).toContain('bindingDigest:');
      expect(result).toMatchObject({
        admissionKind: 'untrusted-okf',
        admittedCount: 1,
        outcome: 'staged',
        reviewRequired: true,
        sideEffectsPossible: false,
      });
      await expect(stat(calls[0]?.bundle ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('renders citation definitions as Markdown literals without activating nested links or markers', async () => {
    const original = validatedBatch('concept');
    const page = original.pages[0];
    if (page === undefined) throw new Error('missing fixture page');
    const citation = page.proposal.citations[0];
    if (citation === undefined) throw new Error('missing fixture citation');
    const proposal = {
      ...page.proposal,
      body: 'Evidence.[^evidence]\n\n  \n',
      citations: [{
        ...citation,
        file: 'docs/[[source]].md',
        quote: 'See [[unknown-page]] and [^unknown-marker].',
      }],
    } as const;
    const batch: ValidatedSessionBatch = Object.freeze({
      ...original,
      pages: Object.freeze([Object.freeze({ ...page, proposal })]),
    });
    let rendered = '';
    const admission = createSessionCompileAdmission({
      port: {
        async importOkf(_workspace, bundle, options): Promise<unknown> {
          rendered = await readFile(join(bundle, `${proposal.pageId}.md`), 'utf8');
          return {
            mode: options.dryRun === true ? 'dry-run' : 'staged',
            pages: [{
              okfPath: `${proposal.pageId}.md`,
              slug: proposal.slug,
              targetDirectory: 'concepts',
            }],
            skipped: [],
            warnings: [],
          };
        },
      },
    });

    await expect(admission.stage('/workspace', 'alpha', 'default', batch))
      .resolves.toMatchObject({ outcome: 'staged' });
    expect(rendered).toContain(
      'docs/\\[\\[source\\]\\].md:4 — See \\[\\[unknown-page\\]\\] and \\[^unknown-marker\\].',
    );
    expect(rendered).toContain('Evidence.[^evidence]\n\n  \n\n[^evidence]:');
    expect(rendered).not.toContain('See [[unknown-page]]');
  });

  it('stops after a dry-run mismatch and reports actual partial settlement safely', async () => {
    const batch = validatedBatch('concept');
    const proposal = batch.pages[0]?.proposal;
    if (proposal === undefined) throw new Error('missing fixture page');
    let calls = 0;
    const dryRunMismatch = createSessionCompileAdmission({
      port: {
        importOkf: () => {
          calls += 1;
          return Promise.resolve({ mode: 'dry-run', pages: [], skipped: [], warnings: [] });
        },
      },
    });
    await expect(dryRunMismatch.stage('/workspace', 'alpha', 'default', batch))
      .rejects.toMatchObject({
        candidateRefs: [],
        code: 'SESSION_ADMISSION_FAILED',
        recoveryAction: 'review',
        sideEffectsPossible: false,
      });
    expect(calls).toBe(1);

    const actualMismatch = createSessionCompileAdmission({
      port: {
        importOkf: (_workspace, _bundle, options) => Promise.resolve({
          mode: options.dryRun === true ? 'dry-run' : 'staged',
          pages: [{
            okfPath: `${proposal.pageId}.md`,
            slug: proposal.slug,
            targetDirectory: 'concepts',
          }],
          skipped: [],
          warnings: options.dryRun === true ? [] : ['unexpected'],
        }),
      },
    });
    await expect(actualMismatch.stage('/workspace', 'alpha', 'default', batch))
      .rejects.toMatchObject({
        candidateRefs: [proposal.pageId],
        code: 'SESSION_ADMISSION_FAILED',
        recoveryAction: 'status',
        sideEffectsPossible: true,
      });
  });

  it('fails closed on dry-run collision, queue saturation, and lock failure without actual admission', async () => {
    const batch = validatedBatch('concept');
    const proposal = batch.pages[0]?.proposal;
    if (proposal === undefined) throw new Error('missing fixture page');
    const cases: readonly Readonly<{
      readonly response: () => Promise<unknown>;
      readonly recoveryAction: 'review' | 'status';
    }>[] = [
      {
        response: () => Promise.resolve({
          mode: 'dry-run',
          pages: [],
          skipped: [{
            okfPath: `${proposal.pageId}.md`,
            reason: 'pending-candidate',
            slug: proposal.slug,
          }],
          warnings: [],
        }),
        recoveryAction: 'review',
      },
      {
        response: () => Promise.resolve({
          mode: 'dry-run',
          pages: [{
            okfPath: `${proposal.pageId}.md`,
            slug: proposal.slug,
            targetDirectory: 'concepts',
          }],
          skipped: [],
          warnings: ['bounded queue reached'],
        }),
        recoveryAction: 'review',
      },
      {
        response: () => Promise.reject(new Error('private lock detail')),
        recoveryAction: 'status',
      },
    ];

    for (const fixture of cases) {
      let calls = 0;
      const admission = createSessionCompileAdmission({
        port: {
          importOkf: () => {
            calls += 1;
            return fixture.response();
          },
        },
      });
      const error = await admission.stage('/workspace', 'alpha', 'default', batch)
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        candidateRefs: [],
        code: 'SESSION_ADMISSION_FAILED',
        recoveryAction: fixture.recoveryAction,
        sideEffectsPossible: false,
      });
      expect(JSON.stringify(error)).not.toContain('private lock detail');
      expect(calls).toBe(1);
    }
  });

  it('rechecks the private bundle after dry-run before actual admission', async () => {
    const batch = validatedBatch('concept');
    const proposal = batch.pages[0]?.proposal;
    if (proposal === undefined) throw new Error('missing fixture page');
    let calls = 0;
    const admission = createSessionCompileAdmission({
      port: {
        async importOkf(_workspace, bundle, options): Promise<unknown> {
          calls += 1;
          if (options.dryRun === true) {
            const path = join(bundle, `${proposal.pageId}.md`);
            await writeFile(path, (await readFile(path, 'utf8')) + '\n', 'utf8');
          }
          return {
            mode: options.dryRun === true ? 'dry-run' : 'staged',
            pages: [{
              okfPath: `${proposal.pageId}.md`,
              slug: proposal.slug,
              targetDirectory: 'concepts',
            }],
            skipped: [],
            warnings: [],
          };
        },
      },
    });

    await expect(admission.stage('/workspace', 'alpha', 'default', batch))
      .rejects.toMatchObject({
        candidateRefs: [],
        code: 'SESSION_ADMISSION_FAILED',
        recoveryAction: 'review',
        sideEffectsPossible: false,
      });
    expect(calls).toBe(1);
  });

  it('rejects unexpected import report sections before actual admission', async () => {
    const batch = validatedBatch('concept');
    const proposal = batch.pages[0]?.proposal;
    if (proposal === undefined) throw new Error('missing fixture page');
    let calls = 0;
    const admission = createSessionCompileAdmission({
      port: {
        importOkf: () => {
          calls += 1;
          return Promise.resolve({
            mode: 'dry-run',
            pages: [{
              okfPath: `${proposal.pageId}.md`,
              slug: proposal.slug,
              targetDirectory: 'concepts',
            }],
            promoted: [proposal.pageId],
            skipped: [],
            warnings: [],
          });
        },
      },
    });

    await expect(admission.stage('/workspace', 'alpha', 'default', batch))
      .rejects.toMatchObject({ code: 'SESSION_ADMISSION_FAILED', sideEffectsPossible: false });
    expect(calls).toBe(1);
  });

  it('turns cleanup failure into a value-free status recovery failure', async () => {
    const batch = validatedBatch('concept');
    const proposal = batch.pages[0]?.proposal;
    if (proposal === undefined) throw new Error('missing fixture page');
    const admission = createSessionCompileAdmission({
      port: {
        importOkf: (_workspace, _bundle, options) => Promise.resolve({
          mode: options.dryRun === true ? 'dry-run' : 'staged',
          pages: [{
            okfPath: `${proposal.pageId}.md`,
            slug: proposal.slug,
            targetDirectory: 'concepts',
          }],
          skipped: [],
          warnings: [],
        }),
      },
      removeTemporary: async (path) => {
        await rm(path, { recursive: true });
        throw new Error('private temporary path');
      },
    });

    await expect(admission.stage('/workspace', 'alpha', 'default', batch))
      .rejects.toMatchObject({
        candidateRefs: [proposal.pageId],
        code: 'SESSION_ADMISSION_FAILED',
        recoveryAction: 'status',
        sideEffectsPossible: true,
      });
  });

  it('reports cleanup failure while recovering from bundle creation without leaking paths', async () => {
    const batch = validatedBatch('concept');
    const page = batch.pages[0];
    if (page === undefined) throw new Error('missing fixture page');
    const invalid = Object.freeze({
      ...batch,
      pages: Object.freeze([Object.freeze({
        ...page,
        proposal: Object.freeze({ ...page.proposal, pageId: '../../escape' }),
      })]),
    }) as ValidatedSessionBatch;
    let cleanupPath: string | undefined;
    let calls = 0;
    const admission = createSessionCompileAdmission({
      port: {
        importOkf: () => {
          calls += 1;
          return Promise.reject(new Error('must not run'));
        },
      },
      removeTemporary: (path) => {
        cleanupPath = path;
        return Promise.reject(new Error('private cleanup failure'));
      },
    });

    try {
      const error = await admission.stage('/workspace', 'alpha', 'default', invalid)
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({
        candidateRefs: [],
        code: 'SESSION_ADMISSION_FAILED',
        recoveryAction: 'status',
        sideEffectsPossible: true,
      });
      expect(JSON.stringify(error)).not.toContain(cleanupPath);
      expect(JSON.stringify(error)).not.toContain('private cleanup failure');
      expect(calls).toBe(0);
    } finally {
      if (cleanupPath !== undefined) {
        await rm(cleanupPath, { force: true, recursive: true });
      }
    }
  });
});
