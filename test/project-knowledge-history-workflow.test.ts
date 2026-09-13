import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { inspectKnowledgeProposalGrounding, inspectKnowledgeProposalGroundingWithHistory } from '../src/compiler/project-knowledge/grounding-diagnostic.js';
import { inspectKnowledgeQuestionCoverage, inspectKnowledgeQuestionCoverageWithHistory } from '../src/compiler/project-knowledge/question-coverage.js';
import { parseKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createKnowledgeSessionService, isSanitizedKnowledgeGeneration } from '../src/compiler/project-knowledge/session.js';
import { addProject } from '../src/knowledge/index.js';
import { digest, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { createKnowledgeGenerationHistoryStore } from '../src/retrieval/project-knowledge-history-store.js';
import { createProjectSecurityService } from '../src/sanitizer/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-history-session-'));
  roots.push(root);
  const projectId = 'parcel';
  await addProject(root, { projectId, displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
  await writeSecurityPolicy(root, projectId, { capabilities: [] });
  const snapshot = await knowledgeFixtureSnapshot();
  const proposal = fixtureProposal(snapshot);
  const first = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null);
  const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
  const history = await store.stageLegacy([first], projectId);
  const security = createProjectSecurityService({ knowledgeRoot: root });
  const sources = await Promise.all(snapshot.sources.map(async source => {
    const result = await security.prepareSource({ projectId, source: source.sourceRef, sourceKind: source.format,
      body: source.content, bodyDigest: sha256(source.content), sourceRevisionOrContentSha256: source.sourceContentDigest });
    if (!result.ok) throw new Error('Fixed source fixture was rejected.');
    return { source, prepared: result.prepared };
  }));
  return { root, projectId, snapshot, first, history, store, sources,
    service: createKnowledgeSessionService({ knowledgeRoot: root }) };
}

describe('history-backed authoring integration', () => {
  it('uses a verified predecessor through prepare/submit/review/finalize and stages exactly one next generation', async () => {
    const f = await fixture();
    const session = await f.service.prepare({ projectId: f.projectId, selectionDigest: f.snapshot.selectionDigest,
      sources: f.sources, previousHistory: f.history });
    expect(session.exchange.baselineGenerationDigest).toBe(f.first.generationDigest);
    expect(session.exchange.previousRecords).toEqual(f.first.records);
    const { proposalDigest: ignored, ...original } = fixtureProposal(session.exchange.snapshot);
    void ignored;
    const basis = { ...original, baselineGenerationDigest: f.first.generationDigest };
    const proposal = parseKnowledgeProposal({ ...basis, proposalDigest: digest(basis) }, session.exchange.snapshot);
    const submitted = await session.submit(proposal, session.exchange.exchangeDigest);
    const next = await session.finalize(fixtureReview(submitted), submitted.proposalDigest);
    expect(isSanitizedKnowledgeGeneration(next)).toBe(true);
    expect(next.baselineGenerationDigest).toBe(f.first.generationDigest);
    const history = await f.store.stageAppend({ projectId: f.projectId, baseline: f.history, generation: next });
    expect(history.reference.generationCount).toBe('2');
    expect(history.latest).toEqual(next);
  });

  it('rejects simultaneous legacy/history inputs, forged capabilities, and actual ancestor drift', async () => {
    const f = await fixture();
    const input = { projectId: f.projectId, selectionDigest: f.snapshot.selectionDigest, sources: f.sources };
    await expect(f.service.prepare({ ...input, previousGenerations: [], previousHistory: f.history })).rejects.toThrow();
    await expect(f.service.prepare({ ...input, previousHistory: { ...f.history } })).rejects.toThrow();
    // prepare consumes source capabilities, so use a fresh prepared-source set for the next attempt.
    const second = await fixture();
    const path = join(second.root, 'projects/parcel/.llmwiki/buildlore-hierarchy/knowledge-history/objects',
      `${second.first.generationDigest.slice(7)}.json`);
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('Fixed regression', 'False regression'));
    await expect(second.service.prepare({ projectId: second.projectId, selectionDigest: second.snapshot.selectionDigest,
      sources: second.sources, previousHistory: second.history })).rejects.toThrow();
  });

  it('keeps coverage/grounding results identical to the valid legacy baseline without reconstructing a chain', async () => {
    const f = await fixture();
    const { proposalDigest: ignored, ...original } = fixtureProposal(f.snapshot);
    void ignored;
    const basis = { ...original, baselineGenerationDigest: f.first.generationDigest };
    const proposal = parseKnowledgeProposal({ ...basis, proposalDigest: digest(basis) }, f.snapshot);
    const questions = [{ id: 'purpose', claimIds: ['claim-overview'], requirements: [
      { id: 'readme', sourceRef: 'README.md', jsonPointer: null, contentKind: 'text' },
    ] }];
    expect(await inspectKnowledgeQuestionCoverageWithHistory(f.snapshot, proposal, questions, f.projectId, f.history))
      .toEqual(inspectKnowledgeQuestionCoverage(f.snapshot, proposal, questions, f.projectId, [f.first]));
    expect(await inspectKnowledgeProposalGroundingWithHistory(f.snapshot, proposal, f.projectId, Promise.resolve(f.history)))
      .toEqual(inspectKnowledgeProposalGrounding(f.snapshot, proposal, f.projectId, [f.first]));
    await expect(inspectKnowledgeProposalGroundingWithHistory(f.snapshot, proposal, f.projectId, { ...f.history })).rejects.toThrow();
    await expect(inspectKnowledgeQuestionCoverageWithHistory(f.snapshot, proposal, questions, f.projectId, null)).rejects.toThrow();
  });
});
