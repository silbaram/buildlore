import { describe, expect, it } from 'vitest';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { digest, ProjectKnowledgeError, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { inspectKnowledgeAuthoringSources, parseKnowledgeAuthoringInspectionRequest,
  KNOWLEDGE_INSPECTION_REQUEST_VERSION, KnowledgeAuthoringInspectionBudgetError } from '../src/compiler/project-knowledge/authoring-inspection.js';
import { parseKnowledgeAuthoringQuestions } from '../src/compiler/project-knowledge/authoring-questions.js';

const projectId = 'parcel';
const exchangeDigest = digest('fixed-inspection-exchange');
const questions = parseKnowledgeAuthoringQuestions([{ id: 'flow', question: 'How does the batch flow work?', role: 'architecture',
  requirements: [{ id: 'entry', sourceRef: 'src/entry.js', jsonPointer: null, contentKind: 'text' }] },
{ id: 'tests', question: 'What does the test define?', role: 'overview',
  requirements: [{ id: 'test', sourceRef: 'checks/flow.py', jsonPointer: null, contentKind: 'text' }] }]);
const snapshot = (large = false) => createKnowledgeSnapshot({ projectId, selectionDigest: digest('selection'),
  sanitizerPolicyDigest: digest('policy'), sanitizerRulesVersion: 'fixture', sources: [
    { sourceId: 'entry', sourceRef: 'src/entry.js', content: 'export function entry() {\n  return normalize();\n}\n\nexport function normalize() { return []; }\n' },
    { sourceId: 'checks', sourceRef: 'checks/flow.py', content: 'def test_normalize():\n    assert normalize() == []\n' },
    ...(large ? [{ sourceId: 'large', sourceRef: 'src/large.py', content: `# ${'검사 '.repeat(4000)}\n` }] : []),
  ].map(s => ({ ...s, sourceContentDigest: sha256(s.content), sourceRevision: null,
    codeRevision: null, tracked: false, repositoryRevision: 'a'.repeat(40), format: 'markdown' })) }, projectId);
const request = (extra: Readonly<Record<string, unknown>> = {}) => ({ schemaVersion: KNOWLEDGE_INSPECTION_REQUEST_VERSION,
  projectId, questionId: 'flow', operation: 'find', contains: 'normalize', ...extra });

describe('question-bound source inspection', () => {
  it('accepts parsed requests again without weakening operation requirements', () => {
    for (const input of [request(), request({ operation: 'sources', contains: null }),
      request({ operation: 'read', sourceRef: 'src/entry.js', contains: null })]) {
      const parsed = parseKnowledgeAuthoringInspectionRequest(input, projectId);
      expect(parseKnowledgeAuthoringInspectionRequest(parsed, projectId)).toEqual(parsed);
      expect(parseKnowledgeAuthoringInspectionRequest(JSON.parse(JSON.stringify(parsed)) as unknown, projectId)).toEqual(parsed);
    }
    for (const extra of [{ operation: 'read', sourceRef: null, contains: null }, { contains: null },
      { operation: 'sources', sourceRef: 'src/entry.js', contains: null }, { operation: 'read', sourceRef: 'src/entry.js' }]) {
      expect(() => parseKnowledgeAuthoringInspectionRequest(request(extra), projectId)).toThrow(ProjectKnowledgeError);
    }
  });

  it('reports metadata budget recovery for large questions, including empty results and the maximum limit', () => {
    const s = snapshot();
    for (const [pointerLength, maxBytes, retryable] of [[240, 8192, true], [240, 65_536, true],
      [4094, 1_048_576, false]] as const) {
      const largeQuestions = parseKnowledgeAuthoringQuestions([{ id: 'flow', question: 'Explain the flow.', role: 'architecture',
        requirements: Array.from({ length: 256 }, (_, i) => ({ id: `source-${String(i)}`, sourceRef: 'src/entry.js',
          jsonPointer: `/${'a'.repeat(pointerLength)}`, contentKind: 'text' })) }]);
      for (const contains of [null, 'not-in-any-path']) {
        const input = { schemaVersion: KNOWLEDGE_INSPECTION_REQUEST_VERSION, projectId, questionId: 'flow',
          operation: 'sources', contains, limit: 1, maxBytes };
        const inspect = (value: unknown) => inspectKnowledgeAuthoringSources(s, exchangeDigest, largeQuestions,
          parseKnowledgeAuthoringInspectionRequest(value, projectId));
        let failure: unknown;
        try { inspect(input); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(KnowledgeAuthoringInspectionBudgetError);
        if (!(failure instanceof KnowledgeAuthoringInspectionBudgetError)) throw new Error('Missing budget details.');
        const details = failure.details;
        expect(details).toMatchObject({ reason: 'response-metadata-too-large', byteBudget: maxBytes,
          maximumBytes: 1_048_576, retryable });
        expect(details.minimumRequiredBytes).toBeGreaterThan(maxBytes);
        expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThan(8192);
        expect(JSON.stringify(details)).not.toContain(largeQuestions[0]?.question);
        if (retryable) {
          const retried = inspect({ ...input, maxBytes: details.minimumRequiredBytes });
          expect(retried.status).toBe(contains === null ? 'ready' : 'empty');
          expect(Buffer.byteLength(JSON.stringify(retried))).toBeLessThanOrEqual(details.minimumRequiredBytes);
          expect(retried.question).toEqual(largeQuestions[0]);
        }
      }
    }
  }, 15_000);

  it('uses literal evidence lookup, retains exact content and does not infer execution or raw line numbers', () => {
    const s = snapshot();
    const result = inspectKnowledgeAuthoringSources(s, exchangeDigest, questions, parseKnowledgeAuthoringInspectionRequest(request(), projectId));
    expect(result.entries).toHaveLength(3);
    expect(result.entries.every(item => 'evidenceId' in item && s.evidence.includes(item))).toBe(true);
    expect(result.instructions.join(' ')).toContain('Code inspection is not execution');
    expect(result.instructions.join(' ')).toContain('not necessarily original code-file lines');
    const noRegex = inspectKnowledgeAuthoringSources(s, exchangeDigest, questions,
      parseKnowledgeAuthoringInspectionRequest(request({ contains: 'normalize.*' }), projectId));
    expect(noRegex).toMatchObject({ total: 0, status: 'empty', entries: [], cursor: null });
    const { resultDigest, ...basis } = result;
    expect(resultDigest).toBe(digest(basis));
  });

  it('paginates stably and binds cursors to the source snapshot, question and literal filter', () => {
    const s = snapshot();
    const first = inspectKnowledgeAuthoringSources(s, exchangeDigest, questions,
      parseKnowledgeAuthoringInspectionRequest(request({ limit: 1 }), projectId));
    expect(first.entries).toHaveLength(1);
    expect(first.cursor).not.toBeNull();
    const nextInput = request({ limit: 1, cursor: first.cursor });
    const next = inspectKnowledgeAuthoringSources(s, exchangeDigest, questions,
      parseKnowledgeAuthoringInspectionRequest(nextInput, projectId));
    expect(next.entries).not.toEqual(first.entries);
    for (const changed of [{ questionId: 'tests' }, { contains: 'entry' }, { sourceRef: 'src/entry.js' }]) {
      expect(() => inspectKnowledgeAuthoringSources(s, exchangeDigest, questions,
        parseKnowledgeAuthoringInspectionRequest({ ...nextInput, ...changed }, projectId))).toThrow(ProjectKnowledgeError);
    }
    expect(() => inspectKnowledgeAuthoringSources(snapshot(true), exchangeDigest, questions,
      parseKnowledgeAuthoringInspectionRequest(nextInput, projectId))).toThrow(ProjectKnowledgeError);
  });

  it('reports oversized whole evidence and resumes with a larger byte budget without clipping or skipping', () => {
    const s = snapshot(true);
    const input = request({ operation: 'read', sourceRef: 'src/large.py', maxBytes: 8192 });
    const { contains, ...readInput } = input; void contains;
    const small = inspectKnowledgeAuthoringSources(s, exchangeDigest, questions,
      parseKnowledgeAuthoringInspectionRequest(readInput, projectId));
    expect(small).toMatchObject({ status: 'item-too-large', entries: [] });
    expect(small.minimumRequiredBytes).toBeGreaterThan(8192);
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(8192);
    if (small.minimumRequiredBytes === null) throw new Error('Missing retry budget.');
    const large = inspectKnowledgeAuthoringSources(s, exchangeDigest, questions,
      parseKnowledgeAuthoringInspectionRequest({ ...readInput, maxBytes: small.minimumRequiredBytes, cursor: small.cursor }, projectId));
    expect(large).toMatchObject({ status: 'ready', total: 1, cursor: null });
    expect(large.entries).toEqual(s.evidence.filter(e => e.sourceRef === 'src/large.py'));
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(65_536);
  });

  it('rejects unknown fields, traversal, invalid operation bounds and undeclared source/question access', () => {
    for (const extra of [{ projectId: 'other' }, { operation: 'execute' }, { sourceRef: '../outside.js' },
      { limit: 0 }, { limit: 51 }, { maxBytes: 0 }, { maxBytes: 1_048_577 }, { cursor: 'forged' },
      { force: true }, { operation: 'sources', sourceRef: 'src/entry.js' }, { operation: 'read' }]) {
      expect(() => parseKnowledgeAuthoringInspectionRequest(request(extra), projectId)).toThrow(ProjectKnowledgeError);
    }
    for (const extra of [{ sourceRef: 'private/not-selected.js' }, { questionId: 'unknown' }]) {
      expect(() => inspectKnowledgeAuthoringSources(snapshot(), exchangeDigest, questions,
        parseKnowledgeAuthoringInspectionRequest(request(extra), projectId))).toThrow(ProjectKnowledgeError);
    }
  });
});
