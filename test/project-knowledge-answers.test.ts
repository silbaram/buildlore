import { createKnowledgeGenerationHistoryStore } from '../src/retrieval/project-knowledge-history-store.js';
import { createAnswerEvaluationWithHistory, parseAnswerEvaluationWithHistory } from '../src/compiler/project-knowledge/answer-evaluation.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addProject } from '../src/knowledge/index.js';
import { digest, list, ProjectKnowledgeError, record, text } from '../src/knowledge/project-knowledge/guards.js';
import { parseJsonStrict } from '../src/knowledge/strict-json.js';
import { createAnswerEvaluationContract, parseAnswerEvaluationContract } from '../src/compiler/project-knowledge/answer-evaluation-contract.js';
import { answerEvidenceContext, answerFactContext, answerInitialContext, createAnswerEvaluation, parseAnswerEvaluation } from '../src/compiler/project-knowledge/answer-evaluation.js';
import { createKnowledgeAnswerEvaluationService } from '../src/compiler/project-knowledge/answer-evaluation-service.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { fixtureFact, fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { sha256 } from '../src/knowledge/project-knowledge/guards.js';
import type { KnowledgeRendererVersion } from '../src/knowledge/project-knowledge/types.js';
import { createKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createProposedKnowledgeRecord } from '../src/knowledge/project-knowledge/records.js';
import { TEST_KNOWLEDGE_ACTOR } from './helpers/project-knowledge-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function evaluationFixture(rendererVersion: KnowledgeRendererVersion = 'knowledge-markdown-v1') {
  const oracle = record(parseJsonStrict(await readFile('test/fixtures/project-knowledge/v1/oracle.json', 'utf8')));
  const sample = record(record(oracle.samples)['generic-md-json']);
  const snapshot = await knowledgeFixtureSnapshot();
  // This freezes the fixture codec's input; it is not independent oracle review or actual AI authoring.
  const contractInput = { projectId: 'parcel', sampleId: 'generic-md-json', revision: 'R1',
    fixtureDigest: snapshot.snapshotDigest, oracleDigest: digest(oracle),
    questions: list(oracle.questions, 5).map((item) => {
      const q = record(item);
      const id = text(q.id);
      return { id, question: text(q.question), criteria: [
        ...list(record(sample.required)[id], 32).map((statement, index) => ({ id: `mandatory-${index}`,
          kind: 'mandatory', statement: text(statement) })),
        { id: 'forbidden-0', kind: 'forbidden', statement: text(list(sample.forbidden, 32)[0]) },
        { id: 'unknown-0', kind: 'unknown', statement: 'Identify missing current revision-bound verification evidence.' },
      ] };
    }) };
  const contract = createAnswerEvaluationContract(contractInput, 'parcel');
  const proposal = fixtureProposal(snapshot);
  const generation = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, rendererVersion);
  const initialContext = answerInitialContext(contract, generation);
  const answers = contract.questions.map((question) => {
    const answer = '문서상 목적을 설명합니다. This is a codec fixture, not an actual AI answer.';
    return { questionId: question.id, answer,
      tokenUsage: { status: 'unavailable', inputTokens: null, outputTokens: null, unavailableReason: 'No provider was invoked.' },
      claims: [{ id: 'claim-0', startUtf8: 0, endUtf8: Buffer.byteLength(answer), text: answer, verdict: 'supported',
        evidenceIds: generation.evidence.map((e) => e.evidenceId), rationale: 'Synthetic protocol judgment only.',
        unsupportedImplementationOrVerification: false, historicalAsCurrent: false, hiddenContradiction: false }],
      criteria: question.criteria.map((c) => ({ criterionId: c.id, verdict: 'satisfied', rationale: 'Synthetic protocol judgment only.' })) };
  });
  const input = { projectId: 'parcel', contractDigest: contract.contractDigest, generationDigest: generation.generationDigest,
    origin: 'deterministic-replay', writer: proposal.actor,
    reader: { sessionId: 'fixture-reader', model: 'deterministic-fixture-not-a-live-ai', kind: 'agent' },
    reviewer: { sessionId: 'fixture-answer-reviewer', model: 'deterministic-fixture-not-a-live-ai', kind: 'agent' },
    attestations: { freshReader: false, oracleWithheld: false, writerHistoryWithheld: false,
      oracleFrozenBeforeGeneration: false, readerSessionDigest: null, reviewerSessionDigest: null },
    initialContext, runtimeContext: { body: null, unavailableReason: 'Runtime context not supplied.' }, lookups: [], answers };
  const evaluate = (value: unknown = input) => createAnswerEvaluation(value, contract, [generation], 'parcel');
  return { contractInput, contract, generation, input, evaluate };
}

async function typedEvaluationFixture() {
  const f = await evaluationFixture('knowledge-markdown-v2');
  const factId = f.generation.records[0]?.id;
  const evidenceId = f.generation.records[0]?.evidenceIds[0];
  if (!factId || !evidenceId) throw new Error('Missing synthetic citations.');
  const answer = `Documented purpose is recorded as current. [fact:${factId}] [evidence:${evidenceId}]`;
  const answers = f.input.answers.map(a => ({ ...a, answer, claims: a.claims.map(c => ({ ...c,
    text: answer, endUtf8: Buffer.byteLength(answer), evidenceIds: [evidenceId], factIds: [factId] })) }));
  const input = { ...f.input, answers };
  return { ...f, input, factId, evidenceId, evaluate: (value: unknown = input) => f.evaluate(value) };
}

describe('typed answer evidence and fact-state citations (codec regressions only)', () => {
  it('uses verified history for evaluation and preserves legacy report semantics without reconstructing an array', async () => {
    const f = await typedEvaluationFixture();
    const root = await mkdtemp(join(tmpdir(), 'buildlore-history-answer-'));
    roots.push(root);
    await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
    await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
    const history = await createKnowledgeGenerationHistoryStore({ knowledgeRoot: root }).stageLegacy([f.generation], 'parcel');
    const result = createAnswerEvaluationWithHistory(f.input, f.contract, history, 'parcel');
    expect(result).toEqual(f.evaluate());
    expect(parseAnswerEvaluationWithHistory(result, f.contract, history, 'parcel')).toEqual(result);
    expect(() => createAnswerEvaluationWithHistory(f.input, f.contract, { ...history }, 'parcel')).toThrow();
    const service = createKnowledgeAnswerEvaluationService({ knowledgeRoot: root });
    const input = { projectId: 'parcel', history, contract: f.contract };
    const session = await service.prepare(input);
    expect(JSON.parse(await session.serializeReport(f.input))).toEqual(result);
    await expect(service.prepare({ ...input, generations: [] })).rejects.toThrow();
    await expect(service.inspect({ ...input, history: { ...history } })).rejects.toThrow();
  });

  it('round-trips v2 while binding the unchanged five-question contract', async () => {
    const f = await typedEvaluationFixture();
    const result = f.evaluate();
    expect(result.schemaVersion).toBe('buildlore.knowledge-answer-evaluation.v2');
    expect(result.outcome).toBe('fixture-only');
    expect(result.contractDigest).toBe((await evaluationFixture()).contract.contractDigest);
    expect(parseAnswerEvaluation(result, f.contract, [f.generation], 'parcel')).toEqual(result);
    expect(result.initialContext[0]?.body).toContain('never infer empty arrays');
    const factAnswer = `Knowledge state is recorded as current. [fact:${f.factId}]`;
    const factOnly = f.evaluate({ ...f.input, answers: f.input.answers.map(a => ({ ...a, answer: factAnswer,
      claims: a.claims.map(c => ({ ...c, text: factAnswer, endUtf8: Buffer.byteLength(factAnswer), evidenceIds: [] })) })) });
    expect(factOnly.outcome).toBe('fixture-only');
    expect(f.evaluate({ ...f.input, answers: f.input.answers.map(a => ({ ...a,
      claims: a.claims.map(c => ({ ...c, verdict: 'insufficient' })) })) }).outcome).toBe('failed');
  });

  it('rejects mixed-up identities, unlabelled hashes and structured citations not actually in the span', async () => {
    const f = await typedEvaluationFixture();
    for (const change of [{ factIds: [f.evidenceId] }, { evidenceIds: [f.factId] },
      { factIds: [] }, { evidenceIds: [] }, { factIds: [digest('another generation')] }, { factIds: undefined }]) {
      expect(() => f.evaluate({ ...f.input, answers: f.input.answers.map(a => ({ ...a,
        claims: a.claims.map(c => ({ ...c, ...change })) })) })).toThrow(ProjectKnowledgeError);
    }
    for (const answer of [`State ${f.factId}`, `State [fact:${f.factId}] sha256:bad`,
      `State [fact:${f.factId}] [evidence:sha256:bad]`]) {
      expect(() => f.evaluate({ ...f.input, answers: f.input.answers.map(a => ({ ...a, answer,
        claims: a.claims.map(c => ({ ...c, text: answer, endUtf8: Buffer.byteLength(answer), evidenceIds: [] })) })) })).toThrow(ProjectKnowledgeError);
    }
  });

  it('replays lookup facts from the generation and rejects forged state or mixed lookup kinds', async () => {
    const f = await typedEvaluationFixture();
    const returned = answerFactContext(f.generation, [f.factId]);
    const lookup = { questionId: 'purpose', evidenceIds: [], factIds: [f.factId], returned };
    expect(f.evaluate({ ...f.input, lookups: [lookup] }).usage.evidenceLookupUtf8Bytes).toBe(Buffer.byteLength(returned.body));
    expect(returned.body).toContain(f.generation.snapshot.snapshotDigest);
    for (const change of [{ evidenceIds: [f.evidenceId] }, { factIds: [] },
      { returned: { ...returned, body: returned.body.replace('current', 'superseded') } }]) {
      expect(() => f.evaluate({ ...f.input, lookups: [{ ...lookup, ...change }] })).toThrow(ProjectKnowledgeError);
    }
    expect(() => answerFactContext(f.generation, [])).toThrow(ProjectKnowledgeError);
    const defs = record(record(parseJsonStrict(await readFile('schemas/project-knowledge-answers.schema.json', 'utf8'))).$defs);
    const result = f.evaluate({ ...f.input, lookups: [lookup] });
    const answer = result.answers[0];
    if (!answer) throw new Error('Missing answer.');
    for (const [name, value] of Object.entries({ reportV2: result, answerV2: answer, claimV2: answer.claims[0], lookupV2: result.lookups[0] })) {
      const shape = record(defs[name]);
      expect(shape.additionalProperties).toBe(false);
      expect(Object.keys(record(shape.properties)).sort()).toEqual(Object.keys(record(value)).sort());
      expect(list(shape.required, 64).map(k => text(k)).sort()).toEqual(Object.keys(record(value)).sort());
    }
  });

  it('shares the real lookup budget and ledger across source and state requests, preserving v1 sessions', async () => {
    const f = await typedEvaluationFixture();
    const root = await mkdtemp(join(tmpdir(), 'buildlore-typed-answer-'));
    roots.push(root);
    await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
    await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
    const service = createKnowledgeAnswerEvaluationService({ knowledgeRoot: root });
    const session = await service.prepare({ projectId: 'parcel', contract: f.contract, generations: [f.generation] });
    const lookups = [await session.lookupFacts('purpose', [f.factId]), await session.lookup('purpose', [f.evidenceId])];
    expect(lookups[0]).toMatchObject({ evidenceIds: [], factIds: [f.factId] });
    expect(lookups[1]).toMatchObject({ evidenceIds: [f.evidenceId], factIds: [] });
    for (let i = 2; i < 10; i += 1) lookups.push(await session.lookup('purpose', [f.evidenceId]));
    await expect(session.lookupFacts('purpose', [f.factId])).rejects.toThrow(ProjectKnowledgeError);
    const report = record(parseJsonStrict(await session.serializeReport({ ...f.input, lookups })));
    expect(record(report.usage).lookupCount).toBe(10);
    await expect(session.serializeReport({ ...f.input, lookups: lookups.slice(1) })).rejects.toThrow(ProjectKnowledgeError);
    const legacy = await evaluationFixture();
    const old = await service.prepare({ projectId: 'parcel', contract: legacy.contract, generations: [legacy.generation] });
    await expect(old.lookupFacts('purpose', [legacy.generation.records[0]?.id])).rejects.toThrow(ProjectKnowledgeError);
    // A rejected new lookup must not mutate an old session's report history.
    expect(record(parseJsonStrict(await old.serializeReport(legacy.input))).schemaVersion).toBe('buildlore.knowledge-answer-evaluation.v1');
  });

  it('screens a digest-heavy v2 reader packet without mistaking generated citation formatting for secrets', async () => {
    const f = await evaluationFixture('knowledge-markdown-v2');
    const snapshot = f.generation.snapshot;
    const facts = Array.from({ length: 8 }, (_, index) => ({ ...fixtureFact(snapshot),
      subject: `project:parcel-aspect-${String(index)}`,
      statement: `Parcel prepares local delivery manifests for documented fixture aspect ${String(index)}.` }));
    const ids = facts.map(fact => createProposedKnowledgeRecord(fact, snapshot, TEST_KNOWLEDGE_ACTOR).id);
    const proposal = createKnowledgeProposal({ projectId: 'parcel', snapshotDigest: snapshot.snapshotDigest,
      baselineGenerationDigest: null, actor: TEST_KNOWLEDGE_ACTOR, facts, supersessions: [], conflicts: [],
      pages: ['overview', 'architecture', 'decisions'].map(role => ({ role, title: 'Digest-heavy fixture coverage',
        sections: [{ title: 'Cited fixture facts', claims: facts.map((fact, index) => ({ claimId: `claim-${role}-${String(index)}`,
          text: fact.statement, factIds: [ids[index]], presentation: 'current' })) }] })) }, snapshot);
    const generation = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null);
    const root = await mkdtemp(join(tmpdir(), 'buildlore-digest-heavy-context-'));
    roots.push(root);
    await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
    await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
    const session = await createKnowledgeAnswerEvaluationService({ knowledgeRoot: root })
      .prepare({ projectId: 'parcel', contract: f.contract, generations: [generation] });
    const packet = session.initialContext.map(item => item.body).join('\n');
    expect(packet).toContain(`[^citation-${ids[0]?.slice(7) ?? ''}]`);
    expect(packet).toContain(`cite: [fact:${ids[0] ?? ''}]`);
    expect(session.initialContext.reduce((sum, item) => sum + item.utf8Bytes, 0)).toBeLessThanOrEqual(32768);
  });
});

describe('project knowledge answer evaluation protocol (not live AI quality)', () => {
  it('round-trips a digest-bound five-question record without treating fixture judgments as AI evidence', async () => {
    const f = await evaluationFixture();
    const result = f.evaluate();
    expect(result.outcome).toBe('fixture-only');
    expect(result.answers).toHaveLength(5);
    expect(result.answers[0]?.utf8Bytes).toBe(Buffer.byteLength(f.input.answers[0]?.answer ?? ''));
    expect(result.answers[0]?.utf8Bytes).toBeGreaterThan(f.input.answers[0]?.answer.length ?? 0);
    expect(result.answers[0]?.tokenUsage).toEqual(f.input.answers[0]?.tokenUsage);
    expect(parseAnswerEvaluation(result, f.contract, [f.generation], 'parcel')).toEqual(result);
    expect(parseAnswerEvaluationContract(f.contract, 'parcel')).toEqual(f.contract);
    expect(JSON.stringify(result.initialContext)).not.toContain(f.contract.questions[0]?.criteria[0]?.statement);
    expect(result.initialContext.map((item) => item.kind)).toEqual(['instructions', 'questions', 'wiki', 'wiki', 'wiki']);
    expect(result.initialContext.some((item) => item.body.includes('sourceRevision'))).toBe(false);
  });

  it('publishes every emitted audit field in the closed public schema', async () => {
    const f = await evaluationFixture();
    const result = f.evaluate();
    const schema = record(parseJsonStrict(await readFile('schemas/project-knowledge-answers.schema.json', 'utf8')));
    const defs = record(schema.$defs);
    const firstAnswer = result.answers[0];
    if (!firstAnswer) throw new Error('Missing synthetic answer');
    const examples = { contract: f.contract, report: result, budget: f.contract.budget, question: f.contract.questions[0],
      criterion: f.contract.questions[0]?.criteria[0], context: result.initialContext[0], answer: firstAnswer,
      claim: firstAnswer.claims[0], judgment: firstAnswer.criteria[0], attestations: result.attestations, usage: result.usage };
    for (const [name, value] of Object.entries(examples)) {
      const shape = record(defs[name]);
      expect(shape.additionalProperties).toBe(false);
      expect(Object.keys(record(shape.properties)).sort()).toEqual(Object.keys(record(value)).sort());
      expect(list(shape.required, 64).map((key) => text(key)).sort()).toEqual(Object.keys(record(value)).sort());
    }
    const unavailableTokens = record(list(record(defs.tokens).oneOf, 2)[1]);
    expect(Object.keys(record(unavailableTokens.properties)).sort()).toEqual(Object.keys(firstAnswer.tokenUsage).sort());
  });

  it('rejects altered budgets, missing/duplicate criteria, wrong project and stale bindings', async () => {
    const f = await evaluationFixture();
    expect(() => parseAnswerEvaluationContract({ ...f.contract, budget: { ...f.contract.budget, maximumLookups: 99 } }, 'parcel')).toThrow(ProjectKnowledgeError);
    expect(() => createAnswerEvaluationContract({ ...f.contractInput, questions: f.contractInput.questions.slice(1) }, 'parcel')).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, projectId: 'lantern' })).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, contractDigest: digest('stale') })).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, generationDigest: digest('stale') })).toThrow(ProjectKnowledgeError);
    for (const criteria of [[], [f.input.answers[0]?.criteria[0], f.input.answers[0]?.criteria[0]]]) {
      expect(() => f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a, criteria })) })).toThrow(ProjectKnowledgeError);
    }
    const result = f.evaluate();
    expect(() => parseAnswerEvaluation({ ...result, outcome: 'recorded-pass' }, f.contract, [f.generation], 'parcel')).toThrow(ProjectKnowledgeError);
    expect(() => parseAnswerEvaluation({ ...result, usage: { ...result.usage, answerUtf8Bytes: 0 } }, f.contract, [f.generation], 'parcel')).toThrow(ProjectKnowledgeError);
  });

  it('requires separate actors and leaves unproven live-session identity incomplete', async () => {
    const f = await evaluationFixture();
    expect(() => f.evaluate({ ...f.input, reader: f.input.writer })).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, reviewer: f.input.reader })).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, reader: f.generation.review.reviewer })).toThrow(ProjectKnowledgeError);
    expect(f.evaluate({ ...f.input, origin: 'live-session' }).outcome).toBe('incomplete');
    expect(f.evaluate({ ...f.input, origin: 'live-session', answers: [] }).outcome).toBe('incomplete');
    expect(() => f.evaluate({ ...f.input, answers: [...f.input.answers].reverse() })).toThrow(ProjectKnowledgeError);
  });

  it('accounts for runtime framing and never reports an unknown total as a complete initial context budget', async () => {
    const f = await evaluationFixture();
    const attested = { ...f.input, origin: 'live-session', attestations: { freshReader: true, oracleWithheld: true,
      writerHistoryWithheld: true, oracleFrozenBeforeGeneration: true,
      readerSessionDigest: digest('synthetic reader binding'), reviewerSessionDigest: digest('synthetic reviewer binding') } };
    expect(f.evaluate(attested).outcome).toBe('incomplete');
    expect(f.evaluate(attested).usage.initialContextUtf8Bytes).toBeNull();
    const runtimeContext = { body: 'Synthetic known runtime instructions.', unavailableReason: null };
    const complete = f.evaluate({ ...attested, runtimeContext });
    // A codec-only assertion about recorded attestations, never a real AI acceptance result.
    expect(complete.outcome).toBe('recorded-pass');
    expect(complete.usage.initialContextUtf8Bytes).toBe(f.input.initialContext.reduce((sum, c) => sum + c.utf8Bytes, 0) + Buffer.byteLength(runtimeContext.body));
    expect(f.evaluate({ ...attested, runtimeContext: { ...runtimeContext, body: '가'.repeat(11000) } }).outcome).toBe('failed');
    expect(f.evaluate({ ...attested, runtimeContext, answers: f.input.answers.map((a) => ({ ...a,
      criteria: a.criteria.map((c) => ({ ...c, verdict: 'unassessed' })) })) }).outcome).toBe('incomplete');
  });

  it('checks every UTF-8 claim span, rejects split codepoints and uncovered answer text', async () => {
    const f = await evaluationFixture();
    for (const change of [{ startUtf8: 1 }, { endUtf8: 1 }, { text: 'Different text' }, { endUtf8: 999999 }]) {
      expect(() => f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a,
        claims: a.claims.map((c) => ({ ...c, ...change })) })) })).toThrow(ProjectKnowledgeError);
    }
    expect(() => f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a, answer: `${a.answer} Unsupported completion.` })) })).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a, claims: [...a.claims, ...a.claims] })) })).toThrow(ProjectKnowledgeError);
  });

  it('separates valid citation identity from semantic support and currentness failures', async () => {
    const f = await evaluationFixture();
    for (const change of [{ verdict: 'unsupported' }, { verdict: 'insufficient' }, { verdict: 'conflicting' },
      { evidenceIds: [] }, { unsupportedImplementationOrVerification: true }, { historicalAsCurrent: true }, { hiddenContradiction: true }]) {
      const result = f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a,
        claims: a.claims.map((c) => ({ ...c, ...change })) })) });
      expect(result.outcome).toBe('failed');
    }
    expect(() => f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a,
      claims: a.claims.map((c) => ({ ...c, evidenceIds: [digest('unknown evidence')] })) })) })).toThrow(ProjectKnowledgeError);
    expect(f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a,
      criteria: a.criteria.map((c) => ({ ...c, verdict: 'violated' })) })) }).outcome).toBe('failed');
  });

  it('retains oversized answers as failed records without truncating or relabeling bytes as tokens', async () => {
    const f = await evaluationFixture();
    const answer = '한'.repeat(2731);
    const result = f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a, answer,
      claims: a.claims.map((c) => ({ ...c, text: answer, endUtf8: Buffer.byteLength(answer) })) })) });
    expect(result.outcome).toBe('failed');
    expect(result.answers[0]?.answer).toBe(answer);
    expect(result.answers[0]?.utf8Bytes).toBe(8193);
    expect(result.answers[0]?.tokenUsage.inputTokens).toBeNull();
  });

  it('accepts only real-count-shaped token usage or explicit unavailable values', async () => {
    const f = await evaluationFixture();
    const measured = { status: 'measured', inputTokens: 123, outputTokens: 45, unavailableReason: null };
    expect(f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a, tokenUsage: measured })) })
      .answers[0]?.tokenUsage).toEqual(measured);
    for (const tokenUsage of [{ ...measured, inputTokens: -1 }, { ...measured, outputTokens: 1.5 },
      { ...measured, inputTokens: Number.MAX_SAFE_INTEGER + 1 }, { ...measured, unavailableReason: 'estimated' },
      { status: 'unavailable', inputTokens: 0, outputTokens: 0, unavailableReason: 'not provided' },
      { status: 'unavailable', inputTokens: null, outputTokens: null, unavailableReason: '' }]) {
      expect(() => f.evaluate({ ...f.input, answers: f.input.answers.map((a) => ({ ...a, tokenUsage })) })).toThrow(ProjectKnowledgeError);
    }
  });

  it('binds ordered lookups to actual evidence bytes and counts repeat lookups cumulatively', async () => {
    const f = await evaluationFixture();
    const evidenceIds = f.generation.evidence.map((e) => e.evidenceId);
    const lookup = { questionId: 'purpose', evidenceIds, returned: answerEvidenceContext(f.generation, evidenceIds) };
    const result = f.evaluate({ ...f.input, lookups: [lookup, lookup] });
    expect(result.usage.evidenceLookupUtf8Bytes).toBe(2 * Buffer.byteLength(lookup.returned.body));
    expect(result.usage.lookupCount).toBe(2);
    expect(f.evaluate({ ...f.input, lookups: Array.from({ length: 11 }, () => lookup) }).outcome).toBe('failed');
    expect(() => f.evaluate({ ...f.input, lookups: [{ ...lookup, returned: { ...lookup.returned, utf8Bytes: 0 } }] })).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, lookups: [{ ...lookup, questionId: 'changes' }, lookup] })).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, initialContext: [...f.input.initialContext, lookup.returned] })).toThrow(ProjectKnowledgeError);
  });

  it('blocks cumulative evidence byte exhaustion before the lookup-count limit without disclosing a partial result', async () => {
    const f = await evaluationFixture();
    const previous = f.generation.snapshot;
    const sources = previous.sources.map((source) => {
      if (source.sourceRef !== 'README.md') return source;
      const content = '# Parcel\n\nParcel local batch planning. ' + 'Extended synthetic evidence description. '.repeat(80) + '\n';
      return { ...source, content, sourceContentDigest: sha256(content) };
    });
    const snapshot = createKnowledgeSnapshot({ projectId: 'parcel', sources, selectionDigest: previous.selectionDigest,
      sanitizerPolicyDigest: previous.sanitizerPolicyDigest, sanitizerRulesVersion: previous.sanitizerRulesVersion }, 'parcel');
    const proposal = fixtureProposal(snapshot);
    const generation = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, 'knowledge-markdown-v1');
    const root = await mkdtemp(join(tmpdir(), 'buildlore-answer-budget-'));
    roots.push(root);
    await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
    await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
    const session = await createKnowledgeAnswerEvaluationService({ knowledgeRoot: root })
      .prepare({ projectId: 'parcel', contract: f.contract, generations: [generation] });
    const ids = generation.evidence.map((e) => e.evidenceId);
    const first = await session.lookup('purpose', ids);
    const maximum = Math.floor(16384 / first.returned.utf8Bytes);
    expect(maximum).toBeLessThan(10);
    expect(maximum).toBeGreaterThan(0);
    const admitted = [first];
    for (let index = 1; index < maximum; index += 1) admitted.push(await session.lookup('purpose', ids));
    await expect(session.lookup('purpose', ids)).rejects.toThrow(ProjectKnowledgeError);
    const input = { ...f.input, generationDigest: generation.generationDigest, initialContext: session.initialContext,
      lookups: admitted, answers: f.input.answers.map((a) => ({ ...a, claims: a.claims.map((c) => ({ ...c, evidenceIds: ids })) })) };
    const result = record(parseJsonStrict(await session.serializeReport(input)));
    expect(record(result.usage).lookupCount).toBe(maximum);
    expect(record(result.usage).evidenceLookupUtf8Bytes).toBe(maximum * first.returned.utf8Bytes);
  });

  it('rejects unknown nested fields, getters, cycles, invalid Unicode and oversized data without value reflection', async () => {
    const f = await evaluationFixture();
    const cyclic: Record<string, unknown> = { ...f.input };
    cyclic.self = cyclic;
    expect(() => f.evaluate(cyclic)).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, rawStdout: 'untrusted trace' })).toThrow(ProjectKnowledgeError);
    const withGetter = { ...f.input };
    Object.defineProperty(withGetter, 'origin', { enumerable: true, get() { throw new Error('Getter must not execute'); } });
    expect(() => f.evaluate(withGetter)).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, reader: { ...f.input.reader, model: '\ud800' } })).toThrow(ProjectKnowledgeError);
    expect(() => f.evaluate({ ...f.input, reader: { ...f.input.reader, model: 'x'.repeat(524289) } })).toThrow(ProjectKnowledgeError);
  });

  it('screens context, lookup and report output before disclosure, and binds reports to actual lookup history', async () => {
    const f = await evaluationFixture();
    const root = await mkdtemp(join(tmpdir(), 'buildlore-answer-evaluation-'));
    roots.push(root);
    await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
    await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
    const service = createKnowledgeAnswerEvaluationService({ knowledgeRoot: root });
    const session = await service.prepare({ projectId: 'parcel', contract: f.contract, generations: [f.generation] });
    expect(session.initialContext).toEqual(f.input.initialContext);
    const lookup = await session.lookup('purpose', f.generation.evidence.map((e) => e.evidenceId));
    await expect(session.serializeReport(f.input)).rejects.toThrow(ProjectKnowledgeError);
    const safeInput = { ...f.input, lookups: [lookup] };
    expect(record(parseJsonStrict(await session.serializeReport(safeInput))).outcome).toBe('fixture-only');
    // Synthetic credentials and private paths are assembled only in memory, never real user data.
    for (const sentinel of [`ghp_${'1234567890'.repeat(3)}123456`, ['/', 'home', '/', 'private-evaluation-user', '/', 'secret.txt'].join('')]) {
      const input = { ...safeInput, answers: safeInput.answers.map((a) => ({ ...a,
        claims: a.claims.map((c) => ({ ...c, rationale: sentinel })) })) };
      try { await session.serializeReport(input); throw new Error('Unsafe report was accepted'); }
      catch (error) { expect(error).toBeInstanceOf(ProjectKnowledgeError); expect(String(error)).not.toContain(sentinel); }
    }
    await expect(session.lookup('purpose', [digest('not in inventory')])).rejects.toThrow(ProjectKnowledgeError);
    await expect(service.prepare({ projectId: 'lantern', contract: f.contract, generations: [f.generation] })).rejects.toThrow(ProjectKnowledgeError);
    await expect(service.prepare({ projectId: 'parcel', contract: f.contract, generations: [f.generation],
      runtimeContext: { body: '가'.repeat(11000), unavailableReason: null } })).rejects.toThrow(ProjectKnowledgeError);
    const ids = f.generation.evidence.map((e) => e.evidenceId);
    const admitted = [lookup];
    for (let index = 1; index < 10; index += 1) admitted.push(await session.lookup('purpose', ids));
    await expect(session.lookup('purpose', ids)).rejects.toThrow(ProjectKnowledgeError);
    const exact = record(parseJsonStrict(await session.serializeReport({ ...f.input, lookups: admitted })));
    expect(record(exact.usage).lookupCount).toBe(10);
    await expect(session.serializeReport({ ...f.input, lookups: admitted.slice(1) })).rejects.toThrow(ProjectKnowledgeError);
  });
});
