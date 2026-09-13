import { describe, expect, it } from 'vitest';
import { compiler } from '../src/index.js';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { digest, ProjectKnowledgeError, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { inspectKnowledgeAuthoringSources } from '../src/compiler/project-knowledge/authoring-inspection.js';
import { DEVELOPMENT_HANDOFF_INSPECTION_GUIDE } from '../src/compiler/project-knowledge/development-handoff.js';

const requirements = [{ id: 'guide', sourceRef: 'guide.md', jsonPointer: null, contentKind: 'text' }];
const selection = { purpose: requirements, architecture: requirements, 'current-state': requirements,
  decisions: requirements, changes: requirements };

describe('generic development handoff authoring, not AI quality certification', () => {
  it('asks for actors, trust boundaries, preserved behavior and version-specific verification without project-specific answers', () => {
    const questions = compiler.createDevelopmentHandoffQuestions(selection);
    const architecture = questions.find(question => question.id === 'architecture')?.question ?? '';
    const changes = questions.find(question => question.id === 'changes')?.question ?? '';
    for (const detail of ['actors', 'external', 'persisted', 'this answer']) expect(architecture).toContain(detail);
    for (const detail of ['preserved', 'normal responses', 'error', 'version']) expect(changes).toContain(detail);
    const guide = DEVELOPMENT_HANDOFF_INSPECTION_GUIDE.join(' ');
    for (const detail of ['another answer', 'unchanged', 'normal responses', 'version', 'one version']) expect(guide).toContain(detail);
    expect(questions.every(question => question.requirements[0]?.sourceRef === 'guide.md')).toBe(true);
    expect(`${architecture} ${changes} ${guide}`).not.toMatch(/BuildLore|P2A|TypeScript|session\.ts|purpose v[123]|item-too-large/u);
  });

  it('leaves caller-owned and previously frozen questions unchanged when fresh factory wording improves', () => {
    const old = [{ id: 'changes', role: 'decisions', question: 'What changed between the available revisions?', requirements }];
    const before = JSON.stringify(old);
    const parsed = compiler.parseKnowledgeAuthoringQuestions(old);
    compiler.createDevelopmentHandoffQuestions(selection);
    expect(parsed).toEqual(old);
    expect(JSON.stringify(old)).toBe(before);
    expect(compiler.parseKnowledgeAuthoringQuestions(parsed)).toEqual(parsed);
  });

  it('reconciles supported non-runtime topics within each answer rather than relying on another answer', () => {
    const changes = compiler.createDevelopmentHandoffQuestions(selection).find(question => question.id === 'changes')?.question ?? '';
    for (const detail of ['non-runtime', 'documentation', 'authoring guidance', 'development process']) expect(changes).toContain(detail);
    const checklist = DEVELOPMENT_HANDOFF_INSPECTION_GUIDE.at(-1) ?? '';
    for (const detail of ['inventory', 'cited sentence', 'another answer does not count', 'unsupported', 'not quality certification']) {
      expect(checklist).toContain(detail);
    }
    expect(Buffer.byteLength(checklist)).toBeLessThanOrEqual(512);
    expect(checklist).not.toMatch(/BuildLore|P2A|TypeScript|changes-handoff|09-08|33\/34/u);
    const content = '# History\n\nA documented review practice changed.\n';
    const snapshot = createKnowledgeSnapshot({ projectId: 'parcel', selectionDigest: digest('selection'),
      sanitizerPolicyDigest: digest('policy'), sanitizerRulesVersion: 'fixture', sources: [{ sourceId: 'guide',
        sourceRef: 'guide.md', content, sourceContentDigest: sha256(content), sourceRevision: null,
        codeRevision: null, tracked: false, format: 'markdown' }] }, 'parcel');
    const result = inspectKnowledgeAuthoringSources(snapshot, digest('exchange'), compiler.createDevelopmentHandoffQuestions(selection),
      compiler.parseKnowledgeAuthoringInspectionRequest({ schemaVersion: compiler.KNOWLEDGE_INSPECTION_REQUEST_VERSION,
        projectId: 'parcel', questionId: 'changes', operation: 'coverage' }, 'parcel'));
    expect(result.instructions).toContain(checklist);
    expect(result.entries).toMatchObject([{ status: 'available', semanticReviewRequired: true }]);
  });

  it('provides five caller-bound project questions with change, rationale and code impact coverage', () => {
    const questions = compiler.createDevelopmentHandoffQuestions(selection);
    expect(questions.map(q => q.id)).toEqual(Object.keys(selection));
    expect(questions.map(q => q.role)).toEqual(['overview', 'architecture', 'overview', 'decisions', 'decisions']);
    expect(compiler.parseKnowledgeAuthoringQuestions(questions)).toEqual(questions);
    const prose = questions.map(q => q.question).join(' ');
    for (const detail of ['callers', 'input/output', 'failure', 'actually verified', 'alternatives', 'previous state', 'remaining work']) {
      expect(prose).toContain(detail);
    }
    expect(prose).not.toMatch(/BuildLore|P2A|\.ts\b|TypeScript/u);
    for (const input of [{ ...selection, producer: 'p2a' }, { ...selection, changes: [] },
      { ...selection, architecture: [{ ...requirements[0], sourceRef: '../unselected' }] }]) {
      expect(() => compiler.createDevelopmentHandoffQuestions(input)).toThrow(ProjectKnowledgeError);
    }
  });

  it('separates snapshot selection gaps, heading-only values and missing details without inventing causes', () => {
    const sources = [{ sourceId: 'guide', sourceRef: 'guide.md', content: '# Project\n\nLocal batch processing.\n' },
      { sourceId: 'heading', sourceRef: 'heading.md', content: '# Settings\n' }].map(source => ({ ...source,
      sourceContentDigest: sha256(source.content), sourceRevision: null, codeRevision: null, tracked: false, format: 'markdown' as const }));
    const snapshot = createKnowledgeSnapshot({ projectId: 'parcel', selectionDigest: digest('selection'),
      sanitizerPolicyDigest: digest('policy'), sanitizerRulesVersion: 'fixture', sources }, 'parcel');
    const questions = compiler.parseKnowledgeAuthoringQuestions([{ id: 'gaps', role: 'overview', question: 'What can be checked?',
      requirements: [requirements[0], { ...requirements[0], id: 'heading', sourceRef: 'heading.md' },
        { ...requirements[0], id: 'not-selected', sourceRef: 'history.json' },
        { ...requirements[0], id: 'no-detail', jsonPointer: '/missing' }] }]);
    const input = { schemaVersion: compiler.KNOWLEDGE_INSPECTION_REQUEST_VERSION, projectId: 'parcel', questionId: 'gaps', operation: 'coverage', limit: 2 };
    const inspect = (extra = {}) => inspectKnowledgeAuthoringSources(snapshot, digest('exchange'), questions,
      compiler.parseKnowledgeAuthoringInspectionRequest({ ...input, ...extra }, 'parcel'));
    const first = inspect();
    const next = inspect({ cursor: first.cursor });
    expect([...first.entries, ...next.entries]).toMatchObject([
      { requirementId: 'guide', status: 'available', semanticReviewRequired: true },
      { requirementId: 'heading', status: 'heading-only' },
      { requirementId: 'not-selected', status: 'source-not-selected', evidenceIds: [] },
      { requirementId: 'no-detail', status: 'detail-unavailable', evidenceIds: [] },
    ]);
    expect(first.instructions.join(' ')).toContain('Do not guess');
    expect(first.instructions.join(' ')).toContain('information sufficiency separately');
    expect(JSON.stringify(first.entries)).not.toContain('Local batch processing');
    expect(next.cursor).toBeNull();
    expect(() => inspect({ operation: 'sources', cursor: first.cursor })).toThrow(ProjectKnowledgeError);
    for (const extra of [{ contains: 'batch' }, { sourceRef: 'guide.md' }]) {
      expect(() => inspect(extra)).toThrow(ProjectKnowledgeError);
    }
  });
});
