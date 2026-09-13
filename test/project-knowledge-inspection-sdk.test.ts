import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { compiler, knowledge, sanitizer } from '../src/index.js';
import { sha256, ProjectKnowledgeError } from '../src/knowledge/project-knowledge/guards.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function prepare(large = false) {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-inspection-sdk-')); roots.push(root);
  await knowledge.addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
  await writeFile(join(root, 'projects/parcel/security-policy.json'), sanitizer.serializeSecurityPolicy({
    schemaVersion: sanitizer.SECURITY_POLICY_SCHEMA_VERSION, projectId: 'parcel', defaultClassification: 'public',
    classificationRules: [], egressRules: [], overrides: [],
  }));
  const security = sanitizer.createProjectSecurityService({ knowledgeRoot: root });
  const content = 'export function entry() { return []; }\n\nexport function another() { return entry(); }\n';
  const source = { sourceId: 'entry', sourceRef: 'src/entry.js', content, sourceContentDigest: sha256(content),
    sourceRevision: null, codeRevision: null, tracked: false, format: 'markdown' as const };
  const result = await security.prepareSource({ projectId: 'parcel', source: source.sourceRef, sourceKind: 'code',
    body: content, bodyDigest: sha256(content), sourceRevisionOrContentSha256: source.sourceContentDigest });
  if (!result.ok) throw new Error('Safe fixture source rejected.');
  return compiler.createKnowledgeSessionService({ knowledgeRoot: root }).prepare({ projectId: 'parcel',
    selectionDigest: sha256('selection'), sources: [{ source, prepared: result.prepared }], authoringQuestions: [
      { id: 'flow', question: 'Explain the flow.', role: 'architecture', requirements: Array.from({ length: large ? 256 : 1 },
        (_, i) => ({ id: `${large ? 'r'.repeat(192) : 'entry'}-${String(i)}`, sourceRef: source.sourceRef,
          jsonPointer: null, contentKind: 'text' as const })) },
    ] });
}

const request = (extra: Readonly<Record<string, unknown>> = {}) => ({ schemaVersion: compiler.KNOWLEDGE_INSPECTION_REQUEST_VERSION,
  projectId: 'parcel', questionId: 'flow', operation: 'sources', ...extra });

describe('public inspection SDK', () => {
  it('accepts raw, parsed and serialized requests and still validates cursor and project bindings', async () => {
    const session = await prepare();
    for (const raw of [request(), request({ operation: 'coverage' }), request({ operation: 'find', contains: 'entry' }),
      request({ operation: 'read', sourceRef: 'src/entry.js' })]) {
      const expected = await session.inspect(raw, session.exchange.exchangeDigest);
      const parsed = compiler.parseKnowledgeAuthoringInspectionRequest(raw, 'parcel');
      expect(await session.inspect(parsed, session.exchange.exchangeDigest)).toEqual(expected);
      expect(await session.inspect(JSON.parse(JSON.stringify(parsed)) as unknown, session.exchange.exchangeDigest)).toEqual(expected);
    }
    const raw = request({ operation: 'read', sourceRef: 'src/entry.js', limit: 1 });
    const first = await session.inspect(raw, session.exchange.exchangeDigest);
    expect(first.cursor).not.toBeNull();
    const next = compiler.parseKnowledgeAuthoringInspectionRequest({ ...raw, cursor: first.cursor }, 'parcel');
    expect(await session.inspect(next, session.exchange.exchangeDigest)).toMatchObject({ status: 'ready', cursor: null });
    for (const extra of [{ projectId: 'other' }, { sourceRef: '../outside.js' },
      { cursor: `inspection-1-${'0'.repeat(64)}` }]) {
      await expect(session.inspect({ ...next, ...extra }, session.exchange.exchangeDigest)).rejects.toThrow(ProjectKnowledgeError);
    }
  });

  it('exposes actionable budget details while security denial takes precedence for unsafe queries', async () => {
    const session = await prepare(true);
    const raw = request({ limit: 1 });
    let failure: unknown;
    try { await session.inspect(raw, session.exchange.exchangeDigest); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(compiler.KnowledgeAuthoringInspectionBudgetError);
    if (!(failure instanceof compiler.KnowledgeAuthoringInspectionBudgetError)) throw new Error('Missing budget failure.');
    expect(failure.details).toMatchObject({ byteBudget: 65_536, retryable: true });
    const recovered = await session.inspect({ ...raw, maxBytes: failure.details.minimumRequiredBytes }, session.exchange.exchangeDigest);
    expect(recovered.status).toBe('ready');
    expect(recovered.question.requirements).toHaveLength(256);
    const sentinel = `ghp_${'1234567890'.repeat(3)}123456`;
    const unsafe = session.inspect({ ...raw, contains: sentinel }, session.exchange.exchangeDigest);
    await expect(unsafe).rejects.toThrow(ProjectKnowledgeError);
    await unsafe.catch((error: unknown) => { expect(String(error)).not.toContain(sentinel); });
  });
});
