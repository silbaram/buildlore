import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createBuiltInSourceAdapterRegistry, initializeSingleProjectQuickstart, p2aRunJsonKnowledgeAdapter } from '../../src/projector/index.js';
import { parseSourceCollectionManifestV2, readSourceCollectionManifest, selectDeclaredSourceFiles } from '../../src/projector/source-manifest.js';
import { resolveLocalProjectBinding } from '../../src/knowledge/local-project-registry.js';
import { resolveRegisteredProfileBinding } from '../../src/profile/preflight.js';
import { createProfileBindingV2 } from '../../src/profile/index.js';
import { runCli } from '../../src/cli/index.js';
import { record } from '../../src/knowledge/project-knowledge/guards.js';
import { writeSecurityPolicy } from '../fixtures/security-policy.js';
import { serializeCanonicalJson } from '../../src/knowledge/atomic-file.js';
import { createKnowledgeProposal } from '../../src/compiler/project-knowledge/proposal.js';
import { createProposedKnowledgeRecord } from '../../src/knowledge/project-knowledge/records.js';
import type { KnowledgeExchangeV1 } from '../../src/compiler/project-knowledge/session.js';
import { fixtureReview, TEST_KNOWLEDGE_ACTOR } from './project-knowledge-fixture.js';
import type { KnowledgeFactInputV1, KnowledgeProposalV1 } from '../../src/knowledge/project-knowledge/types.js';

const exec = promisify(execFile);
export interface KnowledgeWorkflowFixture {
  readonly root: string;
  readonly hubRoot: string;
  readonly sourceRoot: string;
  readonly knowledgeRoot: string;
  readonly projectId: string;
  setRevision(revision: 'R1' | 'R2'): Promise<void>;
  json(name: string, value: unknown): Promise<string>;
  cli(args: readonly string[]): Promise<Readonly<{ exitCode: number; data: Readonly<Record<string, unknown>>; stderr: string }>>;
  cleanup(): Promise<void>;
}

export async function createKnowledgeWorkflowFixture(sample: 'generic-md-json' | 'optional-p2a'): Promise<KnowledgeWorkflowFixture> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-knowledge-e2e-'));
  const sourceRoot = join(root, 'source');
  const hubRoot = join(root, 'hub');
  const knowledgeRoot = join(hubRoot, 'knowledge');
  const projectId = sample === 'generic-md-json' ? 'parcel' : 'lantern';
  const fixtureRoot = join(process.cwd(), 'test/fixtures/project-knowledge/v1', sample);
  const git = async (cwd: string, args: readonly string[]): Promise<void> => {
    await exec('git', [...args], { cwd, env: { ...process.env, LC_ALL: 'C' } });
  };
  const setRevision = async (revision: 'R1' | 'R2'): Promise<void> => {
    await mkdir(join(sourceRoot, 'docs'), { recursive: true });
    for (const entry of await readdir(join(sourceRoot, 'docs'))) await rm(join(sourceRoot, 'docs', entry));
    const revisionRoot = join(fixtureRoot, revision);
    for (const entry of await readdir(revisionRoot)) {
      if (entry.endsWith('.md')) await cp(join(revisionRoot, entry), join(sourceRoot, 'docs', entry));
      if (entry === 'settings.json') await cp(join(revisionRoot, entry), join(sourceRoot, entry));
      if (entry === 'artifacts') await cp(join(revisionRoot, entry), join(sourceRoot, entry), { recursive: true });
    }
  };
  try {
    await mkdir(sourceRoot);
    await mkdir(hubRoot);
    await setRevision('R1');
    await git(sourceRoot, ['init', '--initial-branch=main']);
    await git(sourceRoot, ['config', 'user.name', 'BuildLore Fixture']);
    await git(sourceRoot, ['config', 'user.email', 'fixture@example.invalid']);
    await git(sourceRoot, ['add', '.']);
    await git(sourceRoot, ['commit', '-m', 'fixed R1 evidence']);
    const origin = join(root, 'knowledge.git');
    const seed = join(root, 'seed');
    await git(root, ['init', '--bare', '--initial-branch=main', origin]);
    await git(root, ['-c', 'protocol.file.allow=always', 'clone', origin, seed]);
    await git(seed, ['config', 'user.name', 'BuildLore Fixture']);
    await git(seed, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(seed, 'README.md'), '# Isolated knowledge fixture\n');
    await git(seed, ['add', 'README.md']);
    await git(seed, ['commit', '-m', 'seed']);
    await git(seed, ['push', 'origin', 'main']);
    await initializeSingleProjectQuickstart(hubRoot, { branch: 'main', knowledgeRepository: '../knowledge.git',
      projectId, sourceRepository: `https://example.test/${projectId}.git`, sourceRoot });
    const p2a = p2aRunJsonKnowledgeAdapter();
    await writeFile(join(sourceRoot, '.buildlore/sources.json'), serializeCanonicalJson(parseSourceCollectionManifestV2({ schemaVersion: 'buildlore.sources.v2',
      projectId, sourceRepository: `https://example.test/${projectId}.git`, sources: [
        { adapterId: 'buildlore.generic', adapterVersion: 1, id: 'docs', kind: 'markdown', path: 'docs', pathType: 'directory', recursive: true },
        { adapterId: 'buildlore.json', adapterVersion: 1, id: 'settings', kind: 'json', path: 'settings.json', pathType: 'file' },
        ...(sample === 'optional-p2a' ? [{ adapterId: p2a.registration.adapterId, adapterVersion: 1,
          id: 'execution-history', kind: 'json', path: 'artifacts/runs/run-index.json', pathType: 'file' }] : []),
      ] }, createBuiltInSourceAdapterRegistry({ registrations: sample === 'optional-p2a' ? [p2a] : [] }))));
    await writeFile(join(knowledgeRoot, 'projects', projectId, 'profile-binding.json'),
      serializeCanonicalJson(createProfileBindingV2('general', 'en', sample === 'optional-p2a' ? [p2a] : [])));
    await writeSecurityPolicy(knowledgeRoot, projectId);
    const binding = await resolveLocalProjectBinding(hubRoot, projectId, `https://example.test/${projectId}.git`);
    const profile = await resolveRegisteredProfileBinding(knowledgeRoot, projectId, { registrations: [p2a] });
    const manifest = await readSourceCollectionManifest(binding.checkout, projectId, { sourceAdapterRegistry: profile.sourceAdapters });
    await selectDeclaredSourceFiles(binding.checkout, manifest, { sourceAdapterRegistry: profile.sourceAdapters });
    const inputs = join(hubRoot, '.buildlore/knowledge-inputs');
    await mkdir(inputs, { mode: 0o700 });
    return {
      root, hubRoot, sourceRoot, knowledgeRoot, projectId, setRevision,
      async json(name, value) {
        const path = `.buildlore/knowledge-inputs/${name}`;
        await writeFile(join(hubRoot, path), JSON.stringify(value), { mode: 0o600 });
        return path;
      },
      async cli(args) {
        let stdout = '';
        let stderr = '';
        const exitCode = await runCli([...args, '--json'], { stdout: (v) => { stdout += v; }, stderr: (v) => { stderr += v; } }, { cwd: hubRoot });
        const parsed = stdout === '' ? {} : record(JSON.parse(stdout) as unknown);
        return { exitCode, data: record(parsed.data ?? parsed), stderr };
      },
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Read only a fixed safe fixture, never live project data. */
export async function readKnowledgeFixtureText(sample: string, revision: string, path: string): Promise<string> {
  return readFile(join(process.cwd(), 'test/fixtures/project-knowledge/v1', sample, revision, path), 'utf8');
}

/** Deliberately mechanical protocol fixture, never reported as actual AI generation or quality. */
export function workflowFixtureProposal(exchange: KnowledgeExchangeV1): KnowledgeProposalV1 {
  const snapshot = exchange.snapshot;
  const roles = ['overview', 'architecture', 'decisions'] as const;
  const facts: KnowledgeFactInputV1[] = roles.map((role) => {
    const path = role === 'overview' ? 'README.md' : role === 'architecture'
      ? snapshot.projectId === 'lantern' ? 'README.md' : 'architecture.md' : 'decision.md';
    const evidence = snapshot.evidence.filter((e) => e.sourceRef.endsWith(`/${path}`) && e.excerpt.length > 80 &&
      (snapshot.projectId !== 'lantern' || role === 'decisions' ||
        (role === 'architecture' ? e.excerpt.includes('documented flow') : e.excerpt.includes('offline maintainer'))))
      .sort((a, b) => b.excerpt.length - a.excerpt.length)[0];
    if (!evidence) throw new Error('Missing fixed protocol evidence.');
    return { subject: `protocol-fixture:${role}`, predicate: 'documented-description', scope: 'documented project description',
      statement: evidence.excerpt, classification: 'declared', lifecycle: 'current', evidenceIds: [evidence.evidenceId], observation: null };
  });
  const records = facts.map((f) => createProposedKnowledgeRecord(f, snapshot, TEST_KNOWLEDGE_ACTOR));
  return createKnowledgeProposal({ projectId: snapshot.projectId, snapshotDigest: snapshot.snapshotDigest,
    baselineGenerationDigest: exchange.baselineGenerationDigest, actor: TEST_KNOWLEDGE_ACTOR, facts,
    supersessions: records.flatMap((replacement) => {
      const previous = exchange.previousRecords.find((r) => r.subject === replacement.subject && r.lifecycle === 'current');
      return previous && previous.id !== replacement.id ? [{ previousFactId: previous.id,
        replacementFactId: replacement.id, evidenceIds: replacement.evidenceIds }] : [];
    }), conflicts: [], pages: roles.map((role, index) => {
      const fact = records[index];
      if (!fact) throw new Error('Missing fixed protocol fact.');
      return { role, title: fact.statement.split(/\s/u).slice(0, 5).join(' '),
        sections: [{ title: 'Documented evidence', claims: [{ claimId: `protocol-${role}`, text: fact.statement,
          factIds: [fact.id], presentation: 'current' }] }] };
    }) }, snapshot);
}

export async function submitWorkflowFixture(fixture: KnowledgeWorkflowFixture, started: Readonly<Record<string, unknown>>) {
  const run = String(started.runId);
  const exchange = started.exchange as KnowledgeExchangeV1;
  const proposal = workflowFixtureProposal(exchange);
  const input = await fixture.json(`${run}-proposal.json`, proposal);
  const submitted = await fixture.cli(['compile', 'hierarchy', 'submit', '--project', fixture.projectId, '--run', run,
    '--input', input, '--expect-exchange', exchange.exchangeDigest]);
  if (submitted.exitCode !== 0) throw new Error(`Protocol submit failed: ${submitted.stderr}`);
  const review = await fixture.json(`${run}-review.json`, fixtureReview(proposal));
  const finalized = await fixture.cli(['compile', 'hierarchy', 'finalize', '--project', fixture.projectId, '--run', run,
    '--input', review, '--expect-review', String(submitted.data.reviewViewDigest)]);
  if (finalized.exitCode !== 0) throw new Error(`Protocol finalize failed: ${finalized.stderr}`);
  const approved = await fixture.cli(['compile', 'hierarchy', 'approve', '--project', fixture.projectId, '--run', run,
    '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
  if (approved.exitCode !== 0) throw new Error(`Protocol approve failed: ${approved.stderr}`);
  return { proposal, approved };
}
