import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { compiler, knowledge, sanitizer } from '../src/index.js';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { compare, digest, invalid, sha256, ProjectKnowledgeError } from '../src/knowledge/project-knowledge/guards.js';
import { reconcileKnowledge } from '../src/knowledge/project-knowledge/reconcile.js';
import { withRecordState } from '../src/knowledge/project-knowledge/records.js';
import type { KnowledgeFactInputV1, KnowledgeGenerationV1, KnowledgeSnapshotV1,
  KnowledgeSourceV1 } from '../src/knowledge/project-knowledge/types.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { inspectKnowledgeChangeImpact, parseKnowledgeChangeImpactRequest } from '../src/compiler/project-knowledge/change-impact.js';
import { fixtureProposal, fixtureReview } from './helpers/project-knowledge-fixture.js';

const exchangeDigest = digest('fixed-exchange');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function source(sourceId = 'entry', content = 'The selected entry prepares local work.\n',
  extra: Partial<KnowledgeSourceV1> = {}): KnowledgeSourceV1 {
  return { sourceId, sourceRef: `src/${sourceId}.md`, content, sourceContentDigest: sha256(content),
    sourceRevision: null, codeRevision: null, tracked: false, format: 'markdown', ...extra };
}
function snapshot(sources: readonly KnowledgeSourceV1[]): KnowledgeSnapshotV1 {
  return createKnowledgeSnapshot({ projectId: 'parcel', sources, selectionDigest: digest('selection'),
    sanitizerPolicyDigest: digest('policy'), sanitizerRulesVersion: sanitizer.SANITIZER_RULES_VERSION }, 'parcel');
}
function fact(s: KnowledgeSnapshotV1, index = 0, ids = s.evidence.map(e => e.evidenceId)): KnowledgeFactInputV1 {
  return { subject: `fixture:${String(index)}`, predicate: 'selected-evidence', statement: `Selected evidence supports fixture statement ${String(index)}.`,
    scope: 'fixed unit fixture; not a semantic evaluation', classification: 'declared', lifecycle: 'current',
    evidenceIds: ids, observation: null };
}
function generation(s: KnowledgeSnapshotV1, facts: readonly KnowledgeFactInputV1[] = [fact(s)]): KnowledgeGenerationV1 {
  const proposal = fixtureProposal(s, facts);
  return createKnowledgeGeneration(s, proposal, fixtureReview(proposal), null, 'knowledge-markdown-v2');
}
function request(s: KnowledgeSnapshotV1, previous: KnowledgeGenerationV1, extra: Readonly<Record<string, unknown>> = {}) {
  return { schemaVersion: compiler.KNOWLEDGE_CHANGE_IMPACT_REQUEST_VERSION, operation: 'change-impact', projectId: 'parcel',
    expectExchangeDigest: exchangeDigest, expectSnapshotDigest: s.snapshotDigest,
    expectBaselineGenerationDigest: previous.generationDigest, expectBaselineSnapshotDigest: previous.snapshot.snapshotDigest, ...extra };
}
function inspect(s: KnowledgeSnapshotV1, previous: KnowledgeGenerationV1, extra: Readonly<Record<string, unknown>> = {}) {
  return inspectKnowledgeChangeImpact(s, previous, exchangeDigest, parseKnowledgeChangeImpactRequest(request(s, previous, extra), 'parcel'));
}

describe('change impact on verified baseline knowledge', () => {
  it('reports exact snapshots as empty without changing baseline state or asserting semantic review', () => {
    const s = snapshot([source()]); const previous = generation(s); const before = JSON.stringify(previous);
    const result = inspect(s, previous);
    expect(result).toMatchObject({ status: 'empty', impacts: [], total: 0, cursor: null, minimumRequiredBytes: null, retryable: false,
      summary: { baselineRecords: 1, currentRecords: 1, retainedCurrentFacts: 1, affectedFacts: 0, baselineEvidenceLinks: 1, nonExactEvidenceLinks: 0 },
      boundary: { selectedSnapshotOnly: true, checkoutWideVerification: false, semanticReviewPerformed: false,
        knowledgeMutation: 'none', approvalEffect: 'none', egress: 'none', processSpawned: false } });
    const { resultDigest, ...basis } = result; expect(resultDigest).toBe(digest(basis));
    expect(JSON.stringify(previous)).toBe(before);
  });

  it('keeps exact siblings and baseline claim locations, matching actual conservative reconciliation', () => {
    const a = source('entry'); const b = source('other', 'A separate source supports the compound statement.\n');
    const old = snapshot([a, b]); const previous = generation(old);
    const current = snapshot([a, source('other', 'A changed separate source describes new behavior.\n')]);
    const result = inspect(current, previous);
    expect(result.summary).toMatchObject({ currentRecords: 1, affectedFacts: 1, baselineEvidenceLinks: 2, nonExactEvidenceLinks: 1 });
    const impact = result.impacts[0] ?? invalid();
    expect(impact).toMatchObject({ factId: previous.records[0]?.id, impactExtent: 'partial-evidence', lifecycle: 'current',
      reviewStatus: 'accepted', conservativeCurrentnessEffect: 'stale-without-reviewed-reproposal' });
    expect(impact.evidence.map(e => e.disposition).sort()).toEqual(['content-changed', 'exact-current']);
    expect(impact.baselineClaimLocations).toEqual(['architecture', 'decisions', 'overview'].map(pageRole => ({
      pageRole, sectionIndex: 0, claimIndex: 0, claimId: `claim-${pageRole}`, presentation: 'current' })));
    const baseProposal = fixtureProposal(current, [fact(current, 5)]);
    const { proposalDigest: ignored, ...basis } = baseProposal; void ignored;
    const nextBasis = { ...basis, baselineGenerationDigest: previous.generationDigest };
    const proposal = { ...nextBasis, proposalDigest: digest(nextBasis) };
    const reconciled = reconcileKnowledge(current, proposal, fixtureReview(proposal), previous);
    expect(reconciled.filter(r => r.lifecycle === 'stale').map(r => r.id)).toEqual(result.impacts.map(r => r.factId));
    for (const link of impact.evidence) for (const candidate of link.candidates) {
      expect(current.evidence.some(e => e.evidenceId === candidate.evidenceId)).toBe(true);
      expect(candidate).not.toHaveProperty('excerpt');
    }
    expect(impact).not.toHaveProperty('statement');
  });

  it.each([
    { extra: { sourceRevision: 'R2' }, disposition: 'revision-metadata-changed', dimensions: ['source-revision'] },
    { extra: { codeRevision: 'R2' }, disposition: 'revision-metadata-changed', dimensions: ['code-revision'] },
    { extra: { repositoryRevision: 'a'.repeat(40) }, disposition: 'revision-metadata-changed', dimensions: ['repository-revision'] },
    { extra: { sourceId: 'new-id' }, disposition: 'revision-metadata-changed', dimensions: ['source-id'] },
    { extra: { sourceContentDigest: digest('different-raw-same-sanitized') }, disposition: 'same-excerpt-source-changed', dimensions: ['source-content-digest'] },
  ])('separates $dimensions from a changed excerpt', ({ extra, disposition, dimensions }) => {
    const initial = source(); const previous = generation(snapshot([initial]));
    const current = snapshot([{ ...initial, ...extra }]);
    const link = inspect(current, previous).impacts[0]?.evidence[0];
    expect(link).toMatchObject({ disposition, sourceSelection: 'selected', changedDimensions: dimensions, candidateCount: 1,
      matchBasis: 'source-line-locator' });
    expect(link?.baseline.codeRevisionUnavailableReason).toBe('not-proven-by-source-inventory');
  });

  it('does not infer deletion, renaming or matches from excerpt equality', () => {
    const original = source(); const previous = generation(snapshot([original]));
    const renamed = snapshot([source('renamed', original.content)]);
    expect(inspect(renamed, previous).impacts[0]?.evidence[0]).toMatchObject({ sourceSelection: 'unselected',
      disposition: 'source-unselected', matchBasis: 'none', candidates: [], changedDimensions: [] });
    const shifted = snapshot([source('entry', '\n'+original.content)]);
    expect(inspect(shifted, previous).impacts[0]?.evidence[0]).toMatchObject({ sourceSelection: 'selected',
      disposition: 'aligned-evidence-unavailable', matchBasis: 'none', candidates: [] });
  });

  it('uses direct JSON pointers without conflating equal values at other pointers', () => {
    const old = source('settings', '{"mode":"local","other":"local"}', { sourceRef: 'settings.json', format: 'json' });
    const previous = generation(snapshot([old]));
    const current = snapshot([{ ...old, content: '{"other":"local","mode":"reviewed"}', sourceContentDigest: digest('changed-json') }]);
    const links = inspect(current, previous).impacts[0]?.evidence ?? [];
    const mode = links.find(e => e.baseline.locator.kind === 'json-pointer' && e.baseline.locator.pointer === '/mode');
    expect(mode).toMatchObject({ disposition: 'content-changed', matchBasis: 'source-json-pointer', candidateCount: 1 });
    expect(mode?.candidates[0]?.locator).toEqual({ kind: 'json-pointer', pointer: '/mode' });
    expect(links.find(e => e.baseline.locator.kind === 'json-pointer' && e.baseline.locator.pointer === '/other')?.disposition)
      .toBe('same-excerpt-source-changed');
  });

  it('follows explicit moved origins, retains all ambiguous candidates and gives origin matches precedence', () => {
    const origin = { projectedLine: 1, sourceRef: 'decisions.json', jsonPointer: '/reason',
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 } };
    const original = source('projection', 'A local decision.\n', { origins: [origin] });
    const previous = generation(snapshot([original]));
    const current = snapshot([source('moved', '\nA local decision.\nA local decision.\n', {
      origins: [{ ...origin, projectedLine: 2 }, { ...origin, projectedLine: 3 }],
    }), source('projection', 'A competing direct line.\n')]);
    const link = inspect(current, previous).impacts[0]?.evidence[0];
    expect(link).toMatchObject({ disposition: 'ambiguous-current-candidates', matchBasis: 'origin-json-pointer',
      sourceSelection: 'selected', candidateCount: 2 });
    expect(link?.candidates.map(e => e.sourceId)).toEqual(['moved', 'moved']);
    expect(link?.candidates.map(e => e.evidenceId)).toEqual(link?.candidates.map(e => e.evidenceId).sort(compare));
    const onlyMoved = snapshot([source('moved', '\nA local decision.\n', { origins: [{ ...origin, projectedLine: 2 }] })]);
    expect(inspect(onlyMoved, previous).impacts[0]?.evidence[0]).toMatchObject({ sourceSelection: 'selected',
      disposition: 'same-excerpt-source-changed', candidateCount: 1, matchBasis: 'origin-json-pointer' });
  });

  it('excludes historical records from current evidence-link comparison counts', () => {
    const old = snapshot([source()]);
    const previous = generation(old, [fact(old), { ...fact(old, 1), lifecycle: 'historical' }]);
    const current = snapshot([source('entry', 'A different selected statement.\n')]);
    expect(inspect(current, previous).summary).toMatchObject({ baselineRecords: 2, currentRecords: 1,
      excludedHistorical: 1, affectedFacts: 1, baselineEvidenceLinks: 1 });
    // Private projection branch fixture: state identities are recomputed, not supplied to the public history boundary.
    const original = previous.records.find(r => r.lifecycle === 'current') ?? invalid();
    for (const lifecycle of ['stale', 'superseded'] as const) {
      const records = previous.records.map(r => r.id === original.id ? withRecordState({ ...r, lifecycle }) : r);
      const excluded = inspect(current, { ...previous, records });
      expect(excluded.impacts.length).toBe(0);
      expect(excluded.summary).toMatchObject({ currentRecords: 0, baselineEvidenceLinks: 0,
        ...(lifecycle === 'stale' ? { excludedStale: 1 } : { excludedSuperseded: 1 }) });
    }
  });

  it('keeps defensive metadata overflow recovery value-free', () => {
    const old = snapshot([source()]); const previous = generation(old);
    // This internal defensive stress case exceeds the public snapshot codec's metadata bounds.
    const oversized = { ...old, sanitizerRulesVersion: 'version '.repeat(1400) };
    let failure: unknown;
    try { inspect(oversized, previous, { maxBytes: 8192 }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(compiler.KnowledgeChangeImpactBudgetError);
    if (!(failure instanceof compiler.KnowledgeChangeImpactBudgetError)) invalid();
    expect(failure.details).toMatchObject({ schemaVersion: compiler.KNOWLEDGE_CHANGE_IMPACT_BUDGET_VERSION,
      reason: 'response-metadata-too-large', maximumBytes: 1048576, retryable: true });
    expect(JSON.stringify(failure.details)).not.toContain('version ');
    expect(inspect(oversized, previous, { maxBytes: failure.details.minimumRequiredBytes }).status).toBe('empty');
  });

  it('paginates whole facts, binds all authority inputs and permits page-size/budget changes', () => {
    const old = snapshot([source()]); const previous = generation(old, [fact(old), fact(old, 1), fact(old, 2)]);
    const current = snapshot([source('entry', 'The selected entry now requires review.\n')]);
    const all = inspect(current, previous, { limit: 50 });
    const first = inspect(current, previous, { limit: 1 });
    const last = inspect(current, previous, { limit: 50, maxBytes: 131072, cursor: first.cursor });
    expect([...first.impacts, ...last.impacts]).toEqual(all.impacts);
    expect(last.cursor).toBeNull(); expect(first.summary).toEqual(last.summary);
    for (const extra of [{ expectExchangeDigest: digest('other') }, { expectSnapshotDigest: digest('other') },
      { expectBaselineGenerationDigest: digest('other') }, { expectBaselineSnapshotDigest: digest('other') },
      { cursor: `change-impact-1-${'0'.repeat(64)}` }]) {
      expect(() => inspect(current, previous, extra)).toThrow(expect.objectContaining({ code: 'KNOWLEDGE_DRIFT' }));
    }
    const newer = snapshot([source('entry', 'One more change.\n')]);
    expect(() => inspect(newer, previous, { cursor: first.cursor })).toThrow(expect.objectContaining({ code: 'KNOWLEDGE_DRIFT' }));
  });

  it('returns an exact retry budget without clipping a large fact or skipping a fact above the maximum', () => {
    const old = snapshot([source('many', Array.from({ length: 12 }, (_, i) => `Selected statement ${String(i)}.`).join('\n\n'))]);
    const previous = generation(old); const current = snapshot(old.sources.map(s => ({ ...s, sourceRevision: 'R2' })));
    const small = inspect(current, previous, { maxBytes: 8192 });
    expect(small).toMatchObject({ status: 'item-too-large', impacts: [], total: 1, retryable: true });
    const minimum = small.minimumRequiredBytes ?? invalid();
    const retry = inspect(current, previous, { maxBytes: minimum, cursor: small.cursor });
    expect(retry).toMatchObject({ status: 'ready', cursor: null });
    expect(retry.impacts[0]?.evidence).toHaveLength(12);
    expect(Buffer.byteLength(JSON.stringify(retry))).toBe(minimum);
    expect(inspect(current, previous, { maxBytes: minimum - 1, cursor: small.cursor }).status).toBe('item-too-large');
    const hugeOld = snapshot([source('many', Array.from({ length: 800 }, (_, i) => `Selected statement ${String(i)}.`).join('\n\n'))]);
    const hugePrevious = generation(hugeOld);
    const hugeCurrent = snapshot(hugeOld.sources.map(s => ({ ...s, sourceRevision: 'R2' })));
    const huge = inspect(hugeCurrent, hugePrevious, { maxBytes: 1048576 });
    expect(huge.status).toBe('item-too-large'); expect(huge.impacts.length).toBe(0);
    expect(huge.total).toBe(1); expect(huge.retryable).toBe(false);
    expect(huge.minimumRequiredBytes).toBeGreaterThan(1048576);
  });

  it('normalizes raw/parsed requests and rejects malformed, absent baseline and non-JSON inputs', () => {
    const s = snapshot([source()]); const previous = generation(s); const raw = request(s, previous);
    const parsed = parseKnowledgeChangeImpactRequest(raw, 'parcel');
    expect(parsed).toMatchObject({ cursor: null, limit: 10, maxBytes: 65536 });
    expect(parseKnowledgeChangeImpactRequest(parsed, 'parcel')).toEqual(parsed);
    for (const extra of [{ force: true }, { operation: 'approve' }, { projectId: 'other' },
      { expectBaselineGenerationDigest: null }, { expectBaselineSnapshotDigest: null }, { limit: 0 }, { limit: 51 },
      { maxBytes: 8191 }, { maxBytes: 1048577 }, { cursor: 'forged' }, { cursor: `change-impact-9007199254740992-${'0'.repeat(64)}` },
      { limit: Number.NaN }, { maxBytes: undefined }]) {
      expect(() => parseKnowledgeChangeImpactRequest({ ...raw, ...extra }, 'parcel')).toThrow(ProjectKnowledgeError);
    }
    expect(() => inspectKnowledgeChangeImpact(s, null, exchangeDigest, parsed)).toThrow(expect.objectContaining({ code: 'KNOWLEDGE_INVALID' }));
  });
});

async function files(root: string): Promise<readonly unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const { lstat } = await import('node:fs/promises');
    if ((await lstat(path)).isDirectory()) result.push([name, await files(path)]);
    else result.push([name, sha256(await readFile(path, 'utf8'))]);
  }
  return result;
}

describe('public change-impact session', () => {
  it('screens real prepared sources and replayed history without changing exchange or durable files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buildlore-impact-sdk-')); roots.push(root);
    await knowledge.addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
    await writeFile(join(root, 'projects/parcel/security-policy.json'), sanitizer.serializeSecurityPolicy({
      schemaVersion: sanitizer.SECURITY_POLICY_SCHEMA_VERSION, projectId: 'parcel', defaultClassification: 'public',
      classificationRules: [], egressRules: [], overrides: [],
    }));
    const security = sanitizer.createProjectSecurityService({ knowledgeRoot: root });
    const service = compiler.createKnowledgeSessionService({ knowledgeRoot: root });
    const prepare = async (selected: KnowledgeSourceV1, previousGenerations: readonly KnowledgeGenerationV1[] = []) => {
      const screened = await security.prepareSource({ projectId: 'parcel', source: selected.sourceRef, sourceKind: 'code',
        body: selected.content, bodyDigest: sha256(selected.content), sourceRevisionOrContentSha256: selected.sourceContentDigest });
      if (!screened.ok) throw new Error('Safe fixture rejected.');
      return service.prepare({ projectId: 'parcel', selectionDigest: digest('selection'),
        sources: [{ source: selected, prepared: screened.prepared }], previousGenerations });
    };
    const first = await prepare(source()); const proposal = fixtureProposal(first.exchange.snapshot, [fact(first.exchange.snapshot)]);
    await first.submit(proposal, first.exchange.exchangeDigest);
    const previous = await first.finalize(fixtureReview(proposal), proposal.proposalDigest);
    const next = await prepare(source('entry', 'A revised selected entry requires a new review.\n'), [previous]);
    const raw = request(next.exchange.snapshot, previous, { expectExchangeDigest: next.exchange.exchangeDigest });
    const before = await files(root); const oldExchange = JSON.stringify(next.exchange);
    const result = await next.inspectChangeImpact(raw, next.exchange.exchangeDigest);
    expect(result.status).toBe('ready');
    expect(await next.inspectChangeImpact(compiler.parseKnowledgeChangeImpactRequest(raw, 'parcel'), next.exchange.exchangeDigest)).toEqual(result);
    expect(await files(root)).toEqual(before); expect(JSON.stringify(next.exchange)).toBe(oldExchange);
    await expect(next.inspect({}, next.exchange.exchangeDigest)).rejects.toThrow(ProjectKnowledgeError);
    await expect(next.inspectChangeImpact(raw, digest('wrong'))).rejects.toThrow(expect.objectContaining({ code: 'KNOWLEDGE_DRIFT' }));
    await expect(first.inspectChangeImpact(request(first.exchange.snapshot, previous, { expectExchangeDigest: first.exchange.exchangeDigest }), first.exchange.exchangeDigest))
      .rejects.toThrow(expect.objectContaining({ code: 'KNOWLEDGE_INVALID' }));
    await expect(prepare(source(), [{ ...previous, generationDigest: digest('forged') }])).rejects.toThrow(ProjectKnowledgeError);
    const sentinel = `ghp_${'1234567890'.repeat(3)}123456`;
    const unsafe = prepare(source('entry', 'Safe source text.\n', { sourceRevision: sentinel }), [previous]);
    await expect(unsafe).rejects.toThrow(ProjectKnowledgeError);
    await unsafe.catch((error: unknown) => expect(String(error)).not.toContain(sentinel));
    await writeFile(join(root, 'projects/parcel/security-policy.json'), sanitizer.serializeSecurityPolicy({
      schemaVersion: sanitizer.SECURITY_POLICY_SCHEMA_VERSION, projectId: 'parcel', defaultClassification: 'internal',
      classificationRules: [], egressRules: [], overrides: [],
    }));
    await expect(next.inspectChangeImpact(raw, next.exchange.exchangeDigest)).rejects.toThrow(ProjectKnowledgeError);
  });
});
