import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addProject } from '../src/knowledge/index.js';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { digest, list, ProjectKnowledgeError, record, sha256, text } from '../src/knowledge/project-knowledge/guards.js';
import type { KnowledgeRendererVersion } from '../src/knowledge/project-knowledge/types.js';
import { parseJsonStrict } from '../src/knowledge/strict-json.js';
import { createAnswerEvaluationContract, createReaderAnswerEvaluationContract, createCliReaderAnswerEvaluationContract,
  parseAnswerEvaluationContract } from '../src/compiler/project-knowledge/answer-evaluation-contract.js';
import { createKnowledgeAnswerEvaluationService } from '../src/compiler/project-knowledge/answer-evaluation-service.js';
import { answerEvidenceContext, answerInitialContext, createAnswerEvaluation, parseAnswerEvaluation } from '../src/compiler/project-knowledge/answer-evaluation.js';
import { knowledgeEvidenceSectionContext } from '../src/compiler/project-knowledge/evidence-section-context.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { renderKnowledgeFiles } from '../src/compiler/project-knowledge/markdown.js';
import { renderKnowledgeReaderPages } from '../src/compiler/project-knowledge/reader-context.js';
import { fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function readerFixture(content = '# Parcel\n\n## Non-goals\n\nParcel local batch server operations are outside the documented scope.\n',
  rendererVersion: KnowledgeRendererVersion = 'knowledge-markdown-v2') {
  const original = await knowledgeFixtureSnapshot();
  const snapshot = createKnowledgeSnapshot({ projectId: original.projectId, selectionDigest: original.selectionDigest,
    sanitizerPolicyDigest: original.sanitizerPolicyDigest, sanitizerRulesVersion: original.sanitizerRulesVersion,
    sources: original.sources.map(source => source.sourceRef === 'README.md' ? { ...source, content, sourceContentDigest: sha256(content) } : source) }, 'parcel');
  const input = { projectId: 'parcel', sampleId: 'reader-fixture', revision: 'R1', fixtureDigest: snapshot.snapshotDigest,
    oracleDigest: digest('synthetic independent protocol fixture, not a real oracle review'),
    questions: Array.from({ length: 5 }, (_, i) => ({ id: `question-${String(i)}`, question: `Explain documented fixture aspect ${String(i)}.`,
      criteria: [{ id: 'required', kind: 'mandatory', statement: 'Withheld synthetic answer criterion.' }] })) };
  const legacy = createAnswerEvaluationContract(input, 'parcel');
  const contract = createReaderAnswerEvaluationContract(input, 'parcel');
  const proposal = fixtureProposal(snapshot);
  const generation = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, rendererVersion);
  const fact = generation.records[0];
  const evidence = generation.evidence.find(item => item.evidenceId === fact?.evidenceIds[0]);
  if (!fact || !evidence) throw new Error('Missing synthetic reader fixture.');
  return { input, legacy, contract, proposal, generation, fact, evidence };
}

async function evaluationService() {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-reader-context-'));
  roots.push(root);
  await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
  await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
  return createKnowledgeAnswerEvaluationService({ knowledgeRoot: root });
}

function syntheticReportInput(f: Awaited<ReturnType<typeof readerFixture>>) {
  const answer = `This is synthetic protocol text, not an AI quality judgment. [fact:${f.fact.id}] [evidence:${f.evidence.evidenceId}]`;
  return { projectId: 'parcel', contractDigest: f.contract.contractDigest, generationDigest: f.generation.generationDigest,
    origin: 'deterministic-replay', writer: f.proposal.actor,
    reader: { sessionId: 'fixture-reader', model: 'deterministic-fixture-not-a-live-ai', kind: 'agent' },
    reviewer: { sessionId: 'fixture-answer-reviewer', model: 'deterministic-fixture-not-a-live-ai', kind: 'agent' },
    attestations: { freshReader: false, oracleWithheld: false, writerHistoryWithheld: false,
      oracleFrozenBeforeGeneration: false, readerSessionDigest: null, reviewerSessionDigest: null },
    initialContext: answerInitialContext(f.contract, f.generation),
    runtimeContext: { body: null, unavailableReason: 'Runtime context not supplied.' }, lookups: [],
    answers: f.contract.questions.map(question => ({ questionId: question.id, answer,
      tokenUsage: { status: 'unavailable', inputTokens: null, outputTokens: null, unavailableReason: 'No AI provider invoked.' },
      claims: [{ id: 'claim-0', startUtf8: 0, endUtf8: Buffer.byteLength(answer), text: answer, verdict: 'supported',
        evidenceIds: [f.evidence.evidenceId], factIds: [f.fact.id], rationale: 'Synthetic protocol judgment only.',
        unsupportedImplementationOrVerification: false, historicalAsCurrent: false, hiddenContradiction: false }],
      criteria: question.criteria.map(c => ({ criterionId: c.id, verdict: 'satisfied', rationale: 'Synthetic protocol judgment only.' })) })) };
}

describe('explicit knowledge reader format (not an independent AI quality result)', () => {
  it('binds complete CLI payloads and single-ID lookups without changing old audit formats', async () => {
    const f = await readerFixture();
    const contract = createCliReaderAnswerEvaluationContract(f.input, 'parcel');
    expect(contract.budget).toEqual(f.contract.budget);
    expect(contract.questions).toEqual(f.contract.questions);
    expect(contract.contractDigest).not.toBe(f.contract.contractDigest);
    expect(parseAnswerEvaluationContract(contract, 'parcel')).toEqual(contract);
    const service = await evaluationService();
    expect(await service.inspect({ projectId: 'parcel', contract, generations: [f.generation] })).toMatchObject({
      contextFormat: 'knowledge-cli-reader-v1' });
    const session = await service.prepare({ projectId: 'parcel', contract, generations: [f.generation] });
    const returned = await session.lookup('question-0', [f.evidence.evidenceId]);
    expect(record(parseJsonStrict(returned.returned.body))).toMatchObject({
      schemaVersion: 'buildlore.knowledge-reader-lookup.v1', kind: 'evidence', id: f.evidence.evidenceId,
      generationDigest: f.generation.generationDigest, result: { evidence: f.evidence } });
    const input = { ...syntheticReportInput(f), contractDigest: contract.contractDigest,
      initialContext: session.initialContext, lookups: [returned] };
    const report = parseAnswerEvaluation(parseJsonStrict(await session.serializeReport(input)), contract, [f.generation], 'parcel');
    expect(report.outcome).toBe('fixture-only');
    expect(report.usage.evidenceLookupUtf8Bytes).toBe(Buffer.byteLength(returned.returned.body));
    const withoutEnvelope = { ...returned, returned: answerEvidenceContext(f.generation, [f.evidence.evidenceId], true) };
    expect(() => createAnswerEvaluation({ ...input, lookups: [withoutEnvelope] }, contract, [f.generation], 'parcel')).toThrow(ProjectKnowledgeError);
    await expect(session.lookup('question-1', [])).rejects.toThrow(ProjectKnowledgeError);
    await expect(session.lookup('question-1', [f.evidence.evidenceId, digest('second lookup ID')])).rejects.toThrow(ProjectKnowledgeError);
  });
  it('versions presentation without changing old contracts, questions or the fixed byte budget', async () => {
    const f = await readerFixture();
    expect(f.contract.budget).toEqual(f.legacy.budget);
    expect(f.contract.questions).toEqual(f.legacy.questions);
    expect(f.contract.contractDigest).not.toBe(f.legacy.contractDigest);
    expect(parseAnswerEvaluationContract(f.legacy, 'parcel')).toEqual(f.legacy);
    expect(parseAnswerEvaluationContract(f.contract, 'parcel')).toEqual(f.contract);
    for (const change of [{ contextFormat: 'summary' }, { contextFormat: undefined }, { extra: true },
      { schemaVersion: f.legacy.schemaVersion }, { budget: { ...f.contract.budget, initialContextUtf8Bytes: 65536 } }]) {
      expect(() => parseAnswerEvaluationContract({ ...f.contract, ...change }, 'parcel')).toThrow(ProjectKnowledgeError);
    }
    expect(() => parseAnswerEvaluationContract(f.contract, 'another')).toThrow(ProjectKnowledgeError);
    const old = await readerFixture(undefined, 'knowledge-markdown-v1');
    expect(() => answerInitialContext(old.contract, old.generation)).toThrow(ProjectKnowledgeError);
    expect(answerInitialContext(old.legacy, old.generation)).toHaveLength(5);
    expect(answerInitialContext(f.legacy, f.generation).filter(item => item.kind === 'wiki').map(item => item.body))
      .toEqual(renderKnowledgeFiles(f.generation).filter(file => file.path.endsWith('.md')).map(file => file.body));
    expect(JSON.parse(answerEvidenceContext(f.generation, [f.evidence.evidenceId]).body)).toEqual([f.evidence]);
  });

  it('keeps all authored prose and fact states, deferring full excerpts without changing stored Markdown', async () => {
    const f = await readerFixture();
    const stored = renderKnowledgeFiles(f.generation);
    const context = answerInitialContext(f.contract, f.generation);
    const packet = context.map(item => item.body).join('\n');
    for (const page of f.generation.pages) for (const section of page.sections) for (const claim of section.claims) {
      expect(context.find(item => item.ref === `${page.role}.md`)?.body).toContain(claim.text);
    }
    expect(packet).toContain(`[fact:${f.fact.id}]`);
    expect(packet).toContain(`[evidence:${f.evidence.evidenceId}]`);
    expect(packet).toContain(`${f.fact.classification}/${f.fact.lifecycle}/${f.fact.reviewStatus}`);
    expect(packet).toContain(f.fact.scope);
    expect(packet).not.toContain(f.evidence.excerpt);
    expect(packet).not.toContain(f.input.questions[0]?.criteria[0]?.statement);
    expect(packet).not.toContain(f.proposal.actor.sessionId);
    expect(renderKnowledgeFiles(f.generation)).toEqual(stored);
    expect(context.every(item => item.utf8Bytes === Buffer.byteLength(item.body) && item.bodyDigest === sha256(item.body))).toBe(true);
    // Presentation-only cases: these are not accepted generations or persisted reviews.
    const historical = renderKnowledgeReaderPages({ ...f.generation,
      records: [{ ...f.fact, lifecycle: 'superseded', supersededBy: [digest('replacement')] }],
      pages: f.generation.pages.map(page => ({ ...page, sections: page.sections.map(section => ({ ...section,
        claims: section.claims.map(claim => ({ ...claim, presentation: 'history' as const })) })) })) });
    expect(historical[0]?.body).toContain('[history]');
    expect(historical[0]?.body).toContain('/superseded/');
    expect(historical[0]?.body).toContain(`[fact:${digest('replacement')}]`);
    expect(() => renderKnowledgeReaderPages({ ...f.generation, records: [] })).toThrow(ProjectKnowledgeError);
  });

  it('inspects over-budget full Wiki inputs without disclosure or truncation and accounts for known runtime bytes', async () => {
    const excerpt = `Parcel local batch limitations. ${'Documented local processing only. '.repeat(360)}`;
    const f = await readerFixture(`# Parcel\n\n## Non-goals\n\n${excerpt}\n`);
    const service = await evaluationService();
    const input = { projectId: 'parcel', contract: f.legacy, generations: [f.generation] };
    const full = await service.inspect(input);
    expect(full).toMatchObject({ contextFormat: 'full-wiki', exceedsBudget: true, runtimeContextKnown: false, initialLimitUtf8Bytes: 32768 });
    expect(full.knownInitialUtf8Bytes).toBeGreaterThan(32768);
    expect(JSON.stringify(full)).not.toContain(excerpt);
    await expect(service.prepare(input)).rejects.toThrow(ProjectKnowledgeError);
    const reading = { ...input, contract: f.contract };
    const compact = await service.inspect(reading);
    expect(compact).toMatchObject({ contextFormat: 'knowledge-reader-v1', exceedsBudget: false, runtimeContextKnown: false });
    expect(compact.parts.reduce((sum, item) => sum + item.utf8Bytes, 0)).toBe(compact.knownInitialUtf8Bytes);
    const session = await service.prepare(reading);
    expect(session.initialContext).toEqual(answerInitialContext(f.contract, f.generation));
    const room = 32768 - compact.knownInitialUtf8Bytes;
    const runtimeContext = { body: '가'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3), unavailableReason: null };
    expect(await service.inspect({ ...reading, runtimeContext })).toMatchObject({ knownInitialUtf8Bytes: 32768, runtimeContextKnown: true, exceedsBudget: false });
    await expect(service.prepare({ ...reading, runtimeContext })).resolves.toBeDefined();
    const overflow = { ...runtimeContext, body: `${runtimeContext.body}x` };
    expect(await service.inspect({ ...reading, runtimeContext: overflow })).toMatchObject({ knownInitialUtf8Bytes: 32769, exceedsBudget: true });
    await expect(service.prepare({ ...reading, runtimeContext: overflow })).rejects.toThrow(ProjectKnowledgeError);
    const first = await session.lookup('question-0', [f.evidence.evidenceId]);
    expect(first.returned.utf8Bytes).toBeGreaterThan(Buffer.byteLength(excerpt));
    expect(record(record(list(record(parseJsonStrict(first.returned.body)).items, 64)[0]).evidence).excerpt).toBe(f.evidence.excerpt);
    await expect(session.lookup('question-0', [f.evidence.evidenceId])).rejects.toThrow(ProjectKnowledgeError);
  });

  it('binds exact heading-aware lookups to reports, counts shared/repeated lookups, and rejects altered ledgers', async () => {
    const f = await readerFixture();
    const service = await evaluationService();
    const session = await service.prepare({ projectId: 'parcel', contract: f.contract, generations: [f.generation] });
    const first = await session.lookup('question-0', [f.evidence.evidenceId]);
    const packet = record(parseJsonStrict(first.returned.body));
    const item = record(list(packet.items, 64)[0]);
    expect(item.evidence).toEqual(f.evidence);
    expect(record(item.sectionContext).headings).toEqual([
      { level: 1, startLine: 1, endLine: 1, excerpt: '# Parcel' },
      { level: 2, startLine: 3, endLine: 3, excerpt: '## Non-goals' },
    ]);
    const lookups = [first, await session.lookupFacts('question-0', [f.fact.id])];
    for (let i = 2; i < 10; i += 1) lookups.push(await session.lookup('question-0', [f.evidence.evidenceId]));
    await expect(session.lookupFacts('question-0', [f.fact.id])).rejects.toThrow(ProjectKnowledgeError);
    const input = { ...syntheticReportInput(f), lookups };
    const result = parseAnswerEvaluation(parseJsonStrict(await session.serializeReport(input)), f.contract, [f.generation], 'parcel');
    expect(result.outcome).toBe('fixture-only');
    expect(result.usage.evidenceLookupUtf8Bytes).toBe(lookups.reduce((sum, lookup) => sum + Buffer.byteLength(lookup.returned.body), 0));
    expect(result.usage.lookupCount).toBe(10);
    expect(result.usage.initialContextUtf8Bytes).toBeNull();
    await expect(session.serializeReport({ ...input, lookups: lookups.slice(1) })).rejects.toThrow(ProjectKnowledgeError);
    for (const returned of [answerEvidenceContext(f.generation, [f.evidence.evidenceId]),
      { ...first.returned, body: first.returned.body.replace('Non-goals', 'Implemented') }]) {
      expect(() => createAnswerEvaluation({ ...input, lookups: [{ ...first, returned }] }, f.contract, [f.generation], 'parcel')).toThrow(ProjectKnowledgeError);
    }
    const defs = record(record(parseJsonStrict(await readFile('schemas/project-knowledge-answers.schema.json', 'utf8'))).$defs);
    for (const [name, value] of Object.entries({ contractV2: f.contract, contextualEvidence: packet, sectionContext: item.sectionContext })) {
      const shape = record(defs[name]);
      expect(shape.additionalProperties).toBe(false);
      expect(Object.keys(record(shape.properties)).sort()).toEqual(Object.keys(record(value)).sort());
      expect(list(shape.required, 64).map(key => text(key)).sort()).toEqual(Object.keys(record(value)).sort());
    }
  });

  it('does not treat a listed identity, a fact lookup or a later lookup as already-read source evidence', async () => {
    const f = await readerFixture();
    const service = await evaluationService();
    const session = await service.prepare({ projectId: 'parcel', contract: f.contract, generations: [f.generation] });
    const input = syntheticReportInput(f);
    const evaluate = (lookups: unknown) => createAnswerEvaluation({ ...input, lookups }, f.contract, [f.generation], 'parcel');
    expect(evaluate([]).outcome).toBe('failed');
    const fact = await session.lookupFacts('question-0', [f.fact.id]);
    expect(evaluate([fact]).outcome).toBe('failed');
    const late = await session.lookup('question-1', [f.evidence.evidenceId]);
    expect(evaluate([fact, late]).outcome).toBe('failed');
    await expect(session.lookup('question-0', [f.evidence.evidenceId])).rejects.toThrow(ProjectKnowledgeError);
    expect(evaluate([{ ...late, questionId: 'question-0' }]).outcome).toBe('fixture-only');
    // State-only statements remain possible from the initial fact metadata without source lookup.
    const stateAnswer = `Recorded state is current. [fact:${f.fact.id}]`;
    expect(createAnswerEvaluation({ ...input, answers: input.answers.map(answer => ({ ...answer, answer: stateAnswer,
      claims: answer.claims.map(claim => ({ ...claim, text: stateAnswer, endUtf8: Buffer.byteLength(stateAnswer), evidenceIds: [] })) })) },
    f.contract, [f.generation], 'parcel').outcome).toBe('fixture-only');
  });

  it('screens even inspection-only inputs before returning size diagnostics', async () => {
    const f = await readerFixture();
    const service = await evaluationService();
    const input = { projectId: 'parcel', contract: f.contract, generations: [f.generation],
      runtimeContext: { body: ['-----BEGIN ', 'PRIVATE KEY-----'].join(''), unavailableReason: null } };
    await expect(service.inspect(input)).rejects.toThrow(ProjectKnowledgeError);
    await expect(service.prepare(input)).rejects.toThrow(ProjectKnowledgeError);
  });
});

describe('exact sanitized Markdown section context', () => {
  it('tracks enclosing sibling/nested headings, excluding fenced and indented examples', async () => {
    const f = await readerFixture('# Parcel\n\n## Old scope\n\n## Non-goals\n\n### Local limits\n\n~~~md\n# Not a heading\n~~~\n\n    # Indented example\n\nParcel local batch server operations.\n');
    expect(knowledgeEvidenceSectionContext(f.generation, f.evidence)).toMatchObject({ status: 'available', unavailableReason: null,
      headings: [{ excerpt: '# Parcel' }, { excerpt: '## Non-goals' }, { excerpt: '### Local limits' }] });
    const fenced = await readerFixture('# Parcel\n\n````md\n# Example\n```\n## Still inside the example\n````\n\nParcel local batch operations.\n');
    expect(knowledgeEvidenceSectionContext(fenced.generation, fenced.evidence).headings.map(h => h.excerpt)).toEqual(['# Parcel']);
  });

  it('retains Setext heading text/line numbers and reports no headings without inventing context', async () => {
    const f = await readerFixture('Parcel\n======\n\nNon-goals\n---------\n\nParcel local batch operations.\n');
    expect(knowledgeEvidenceSectionContext(f.generation, f.evidence).headings).toEqual([
      { level: 1, startLine: 1, endLine: 2, excerpt: 'Parcel\n======' },
      { level: 2, startLine: 4, endLine: 5, excerpt: 'Non-goals\n---------' },
    ]);
    const multiline = await readerFixture('Non-goals\nand excluded behavior\n---------------------\n\nParcel local batch operations.\n');
    expect(knowledgeEvidenceSectionContext(multiline.generation, multiline.evidence).headings).toEqual([
      { level: 2, startLine: 1, endLine: 3, excerpt: 'Non-goals\nand excluded behavior\n---------------------' },
    ]);
    const plain = await readerFixture('Parcel local batch operations.\n');
    expect(knowledgeEvidenceSectionContext(plain.generation, plain.evidence)).toEqual({ status: 'available', headings: [], unavailableReason: null });
  });

  it('never exposes redacted headings or joins historical evidence to changed same-path content', async () => {
    const f = await readerFixture('# Parcel\n\n## <REDACTED:SECRET>\n\n### Limits\n\nParcel local batch operations.\n');
    const context = knowledgeEvidenceSectionContext(f.generation, f.evidence);
    expect(context).toMatchObject({ status: 'partial', unavailableReason: 'redacted-heading' });
    expect(context.headings.map(h => h.excerpt)).toEqual(['# Parcel', '### Limits']);
    const later = await readerFixture('# Parcel\n\n## Implemented\n\nParcel local batch operations.\n');
    expect(knowledgeEvidenceSectionContext(later.generation, f.evidence)).toEqual({ status: 'unavailable', headings: [], unavailableReason: 'source-not-in-current-snapshot' });
    const changed = { ...f.generation, snapshot: { ...f.generation.snapshot, sources: f.generation.snapshot.sources.map(source =>
      source.sourceRef === 'README.md' ? { ...source, content: source.content.replace('Limits', 'Different') } : source) } };
    expect(knowledgeEvidenceSectionContext(changed, f.evidence).status).toBe('unavailable');
    const json = f.generation.snapshot.evidence.find(item => item.locator.kind === 'json-pointer');
    if (!json) throw new Error('Missing synthetic JSON evidence.');
    expect(knowledgeEvidenceSectionContext(f.generation, json).unavailableReason).toBe('not-markdown-lines');
  });

  it('binds context to the source identity and sanitized content even for matching excerpt text', async () => {
    const f = await readerFixture();
    for (const key of ['sourceId', 'sourceRef', 'sourceContentDigest', 'sanitizedContentDigest'] as const) {
      const value = key.endsWith('Digest') ? digest('different source') : 'another-source';
      expect(knowledgeEvidenceSectionContext(f.generation, { ...f.evidence, [key]: value }).status).toBe('unavailable');
    }
    expect(knowledgeEvidenceSectionContext({ ...f.generation, snapshot: { ...f.generation.snapshot, sources: [] } },
      f.evidence).unavailableReason).toBe('source-not-in-current-snapshot');
  });
});
