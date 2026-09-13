import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addProject } from '../src/knowledge/index.js';
import { digest, ProjectKnowledgeError } from '../src/knowledge/project-knowledge/guards.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { knowledgeReaderPacket, serializeKnowledgeReaderPacketData } from '../src/compiler/project-knowledge/reader-packet.js';
import { knowledgeReaderLookup } from '../src/compiler/project-knowledge/reader-surface.js';
import { createPacketAnswerEvaluationContract, createReaderAnswerEvaluationContract, parseAnswerEvaluationContract } from '../src/compiler/project-knowledge/answer-evaluation-contract.js';
import { answerInitialContext, createAnswerEvaluation } from '../src/compiler/project-knowledge/answer-evaluation.js';
import { createKnowledgeAnswerEvaluationService } from '../src/compiler/project-knowledge/answer-evaluation-service.js';
import { fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

import { createKnowledgeWorkflowFixture, submitWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const snapshot = await knowledgeFixtureSnapshot();
  const proposal = fixtureProposal(snapshot);
  const generation = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, 'knowledge-markdown-v2');
  const input = { projectId: 'parcel', sampleId: 'packet-fixture', revision: 'R1', fixtureDigest: snapshot.snapshotDigest,
    oracleDigest: digest('synthetic codec fixture, not a quality result'), questions: Array.from({ length: 5 }, (_, i) => ({
      id: `question-${String(i)}`, question: `Explain fixture aspect ${String(i)}.`,
      criteria: [{ id: 'required', kind: 'mandatory', statement: 'Withheld fixture criterion.' }],
    })) };
  return { generation, proposal, input, contract: createPacketAnswerEvaluationContract(input, 'parcel') };
}
describe('lossless opt-in Wiki packet and fixed-budget evaluation', () => {
  it('serves identical CLI/SDK packet data and keeps generation-guarded lookup', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json');
    try {
      expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      const purpose = await f.json('packet-purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
        projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
      const started = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
      const { approved } = await submitWorkflowFixture(f, started.data);
      const args = approved.data.activationArgs;
      if (!Array.isArray(args) || !args.every((arg: unknown) => typeof arg === 'string')) throw new Error('Missing activation.');
      expect(await f.cli(args)).toMatchObject({ exitCode: 0 });
      const reader = createKnowledgeWikiReader(f.knowledgeRoot);
      const packet = await reader.readPacket(f.projectId);
      if (!packet) throw new Error('Missing packet.');
      expect(await f.cli(['wiki', 'packet', '--project', f.projectId])).toMatchObject({ exitCode: 0, data: packet });
      const evidence = Object.values(packet.evidence)[0]; if (!evidence) throw new Error('Missing evidence.');
      const sdk = await reader.lookup(f.projectId, packet.generationDigest, 'evidence', evidence[0]);
      expect(await f.cli(['wiki', 'lookup', '--project', f.projectId, '--kind', 'evidence', '--id', evidence[0],
        '--expect-generation', packet.generationDigest])).toMatchObject({ exitCode: 0, data: sdk });
      await expect(reader.lookup(f.projectId, digest('wrong generation'), 'evidence', evidence[0])).rejects.toThrow();
      await expect(reader.readPacket('other-project')).rejects.toThrow();
    } finally { await f.cleanup(); }
  }, 60000);

  it('restores every claim and fact reference and advertises exact complete lookup bytes', async () => {
    const { generation } = await fixture();
    const before = JSON.stringify(generation);
    const packet = knowledgeReaderPacket(generation);
    expect(packet.pages.map(page => ({ ...page, sections: page.sections.map(section => ({ ...section,
      claims: section.claims.map(({ facts, ...claim }) => ({ ...claim, factIds: facts.map(alias => packet.facts[alias]?.[0]) })),
    })) }))).toEqual(generation.pages);
    for (const fact of Object.values(packet.facts)) {
      const original = generation.records.find(item => item.id === fact[0]);
      expect(original).toMatchObject({ classification: fact[1], lifecycle: fact[2], reviewStatus: fact[3], scope: fact[4],
        supersededBy: fact[5], evidenceIds: fact[6].map(alias => packet.evidence[alias]?.[0]) });
      expect(fact[7]).toBe(Buffer.byteLength(serializeKnowledgeReaderPacketData(knowledgeReaderLookup(generation, 'fact', fact[0]))));
    }
    for (const evidence of Object.values(packet.evidence)) {
      expect(generation.evidence.find(item => item.evidenceId === evidence[0])).toMatchObject({
        sourceRef: packet.sources[evidence[1]], locator: evidence[2][0] === 'lines' ? { kind: 'lines', start: evidence[2][1], end: evidence[2][2] } : { kind: 'json-pointer', pointer: evidence[2][1] } });
      expect(evidence[3]).toBe(Buffer.byteLength(serializeKnowledgeReaderPacketData(knowledgeReaderLookup(generation, 'evidence', evidence[0]))));
    }
    expect(JSON.stringify(generation)).toBe(before);
    expect(knowledgeReaderPacket({ ...generation, records: [...generation.records].reverse(), evidence: [...generation.evidence].reverse() })).toEqual(packet);
    expect(() => knowledgeReaderPacket({ ...generation, records: [] })).toThrow(ProjectKnowledgeError);
    expect(() => knowledgeReaderPacket({ ...generation, evidence: [] })).toThrow(ProjectKnowledgeError);
    expect(() => knowledgeReaderPacket({ ...generation, projectId: 'another' })).toThrow(ProjectKnowledgeError);
    expect(() => knowledgeReaderPacket({ ...generation, rendererVersion: 'knowledge-markdown-v1' })).toThrow(ProjectKnowledgeError);
  });

  it('versions compact context, hides criteria and refuses altered contracts and alias lookup IDs', async () => {
    const f = await fixture();
    const old = createReaderAnswerEvaluationContract(f.input, 'parcel');
    expect(parseAnswerEvaluationContract(f.contract, 'parcel')).toEqual(f.contract);
    expect(f.contract.questions).toEqual(old.questions);
    expect(f.contract.budget).toEqual(old.budget);
    for (const change of [{ contextFormat: old.contextFormat }, { extra: true }, { projectId: 'another' },
      { budget: { ...f.contract.budget, initialContextUtf8Bytes: 65536 } }]) {
      expect(() => parseAnswerEvaluationContract({ ...f.contract, ...change }, 'parcel')).toThrow(ProjectKnowledgeError);
    }
    const context = answerInitialContext(f.contract, f.generation);
    expect(context.map(item => item.body).join('')).not.toContain('Withheld fixture criterion');
    const packet = knowledgeReaderPacket(f.generation);
    expect(context.find(item => item.kind === 'wiki')?.body).toBe(serializeKnowledgeReaderPacketData(packet));
    const root = await mkdtemp(join(tmpdir(), 'buildlore-packet-')); roots.push(root);
    await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
    await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
    const service = createKnowledgeAnswerEvaluationService({ knowledgeRoot: root });
    const input = { projectId: 'parcel', contract: f.contract, generations: [f.generation] };
    expect(await service.inspect(input)).toMatchObject({ contextFormat: 'knowledge-reader-packet-v1',
      knownInitialUtf8Bytes: context.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0), runtimeContextKnown: false });
    const session = await service.prepare(input);
    await expect(session.lookup('question-0', ['e0'])).rejects.toThrow(ProjectKnowledgeError);
    await expect(session.lookup('question-0', [])).rejects.toThrow(ProjectKnowledgeError);
    const evidence = Object.values(packet.evidence)[0]; if (!evidence) throw new Error('Missing fixture evidence.');
    const result = await session.lookup('question-0', [evidence[0]]);
    expect(result.returned.utf8Bytes).toBe(evidence[3]);
    expect(result.returned.body).toBe(serializeKnowledgeReaderPacketData(knowledgeReaderLookup(f.generation, 'evidence', evidence[0])));
  });

  it('does not let an unread source citation pass through the new contract', async () => {
    const f = await fixture(); const fact = f.generation.records[0]; const evidence = fact?.evidenceIds[0];
    if (!fact || !evidence) throw new Error('Missing fixture.');
    const answer = `Recorded fixture statement. [fact:${fact.id}] [evidence:${evidence}]`;
    const result = createAnswerEvaluation({ projectId: 'parcel', contractDigest: f.contract.contractDigest,
      generationDigest: f.generation.generationDigest, origin: 'deterministic-replay', writer: f.proposal.actor,
      reader: { sessionId: 'packet-reader', model: 'fixture', kind: 'agent' },
      reviewer: { sessionId: 'packet-reviewer', model: 'fixture', kind: 'agent' },
      attestations: { freshReader: false, oracleWithheld: false, writerHistoryWithheld: false,
        oracleFrozenBeforeGeneration: false, readerSessionDigest: null, reviewerSessionDigest: null },
      initialContext: answerInitialContext(f.contract, f.generation), runtimeContext: { body: null, unavailableReason: 'No live session.' },
      lookups: [], answers: f.contract.questions.map(q => ({ questionId: q.id, answer,
        tokenUsage: { status: 'unavailable', inputTokens: null, outputTokens: null, unavailableReason: 'No provider.' },
        claims: [{ id: 'claim-1', startUtf8: 0, endUtf8: Buffer.byteLength(answer), text: answer, verdict: 'supported',
          evidenceIds: [evidence], factIds: [fact.id], rationale: 'Synthetic check only.',
          unsupportedImplementationOrVerification: false, historicalAsCurrent: false, hiddenContradiction: false }],
        criteria: q.criteria.map(c => ({ criterionId: c.id, verdict: 'satisfied', rationale: 'Synthetic check only.' })),
      })),
    }, f.contract, [f.generation], 'parcel');
    expect(result.outcome).toBe('failed');
  });
});
