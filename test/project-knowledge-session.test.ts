import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addProject } from '../src/knowledge/index.js';
import { createProjectSecurityService } from '../src/sanitizer/index.js';
import { digest, ProjectKnowledgeError, record, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { createKnowledgeSessionService } from '../src/compiler/project-knowledge/session.js';
import { renderKnowledgeFiles } from '../src/compiler/project-knowledge/markdown.js';
import { createKnowledgeProposal, parseKnowledgeSemanticReview } from '../src/compiler/project-knowledge/proposal.js';
import { createProposedKnowledgeRecord } from '../src/knowledge/project-knowledge/records.js';
import { bridgeKnowledgeToHierarchy } from '../src/compiler/project-knowledge/hierarchy-bridge.js';
import { digestHierarchyValue, finalizeCompileRun } from '../src/compiler/index.js';
import { approveKnowledgeWikiAuthority } from '../src/retrieval/project-knowledge-authority.js';
import { prepareApprovedWikiPublication, verifyApprovedWikiAuthority } from '../src/retrieval/approved-corpus-store.js';
import { createHierarchicalMarkdownPublication, type HierarchicalMarkdownRepositoryLeasePort } from '../src/retrieval/hierarchical-markdown-publication.js';
import { parseHierarchicalMarkdownManifest, renderHierarchicalMarkdown } from '../src/retrieval/hierarchical-markdown.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { createLocalWikiOperator } from '../src/retrieval/local-wiki-operator.js';
import { knowledgeSemanticProvider } from './helpers/knowledge-semantic-provider.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { fixtureFact, fixtureProposal, fixtureReview, knowledgeFixtureSnapshot, TEST_KNOWLEDGE_ACTOR } from './helpers/project-knowledge-fixture.js';

const roots: string[] = [];
const testLease: HierarchicalMarkdownRepositoryLeasePort = {
  async withLease(_root, _operation, action) {
    return action({ repositoryIdentityDigest: 'unit-test-lease', updatePhase: () => Promise.resolve() });
  },
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function sessionFixture(includeAggregationProbe = false) {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-knowledge-session-'));
  roots.push(root);
  await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
  await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
  const security = createProjectSecurityService({ knowledgeRoot: root });
  const sourceSnapshot = await knowledgeFixtureSnapshot();
  const aggregationProbe = includeAggregationProbe ? [{
    sourceId: 'reveal-probe',
    sourceRef: 'secret.md',
    content: 'Harmless documentation fixture.\n',
    sourceContentDigest: sha256('Harmless documentation fixture.\n'), sourceRevision: 'R1',
    codeRevision: null, tracked: true, format: 'markdown' as const,
  }] : [];
  const sources = await Promise.all([...sourceSnapshot.sources, ...aggregationProbe].map(async (source) => {
    const result = await security.prepareSource({ projectId: 'parcel', source: source.sourceRef,
      sourceKind: source.format, body: source.content, bodyDigest: sha256(source.content),
      sourceRevisionOrContentSha256: source.sourceContentDigest });
    if (!result.ok) throw new Error('Safe fixture source rejected.');
    return { source, prepared: result.prepared };
  }));
  const service = createKnowledgeSessionService({ knowledgeRoot: root });
  return { root, security, service, input: { projectId: 'parcel', selectionDigest: sourceSnapshot.selectionDigest, sources } };
}

describe('project knowledge current-session handoff', () => {
  it('renders Basic prose after rejecting a credential in the same Wiki handoff', async () => {
    const fixture = await sessionFixture();
    const session = await fixture.service.prepare(fixture.input);
    const value = Buffer.from(['fixture', 'synthetic-pass'].join(':')).toString('base64');
    const unsafe = fixtureProposal(session.exchange.snapshot, [fixtureFact(session.exchange.snapshot,
      `Basic ${value}`)]);
    await expect(session.submit(unsafe, session.exchange.exchangeDigest)).rejects.toThrow(ProjectKnowledgeError);
    expect(session.reviewTargets()).toEqual([]);
    const statement = 'Basic information: Parcel prepares local delivery manifests.';
    const proposal = fixtureProposal(session.exchange.snapshot, [fixtureFact(session.exchange.snapshot, statement)]);
    await session.submit(proposal, session.exchange.exchangeDigest);
    const generation = await session.finalize(fixtureReview(proposal), proposal.proposalDigest);
    const pages = renderKnowledgeFiles(generation).filter(file => file.path.endsWith('.md'));
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.body).toContain(statement);
      expect(page.body).not.toContain('<REDACTED:CREDENTIAL>');
      expect(page.body.includes(value)).toBe(false);
    }
  });

  it('requires completeness boundaries in the v2 authoring instructions', async () => {
    const fixture = await sessionFixture();
    const session = await fixture.service.prepare(fixture.input);
    const instructions = session.exchange.instructions.join('\n');
    expect(instructions).toContain('Include unresolved development context');
    expect(instructions).toContain('sanitized evidence is read by the current AI session');
    expect(instructions).toContain('compiler/project-knowledge/session.ts');
    expect(instructions).toContain('exact detected credential or entropy-risk spans');
    expect(instructions).toContain('before the first migration of an existing Wiki');
    expect(instructions).toContain('unknown-full-history');
  });

  it('rejects a proposal with missing caller-required question coverage before accepting it', async () => {
    const fixture = await sessionFixture();
    const session = await fixture.service.prepare(fixture.input);
    const proposal = fixtureProposal(session.exchange.snapshot);
    const question = { id: 'purpose', claimIds: ['claim-overview'], requirements: [
      { id: 'scope', sourceRef: 'README.md', jsonPointer: null, contentKind: 'text' },
    ] };
    await expect(session.submit(proposal, session.exchange.exchangeDigest,
      [{ ...question, claimIds: [] }])).rejects.toThrow(ProjectKnowledgeError);
    expect(session.reviewTargets()).toEqual([]);
    await expect(session.finalize(fixtureReview(proposal), proposal.proposalDigest)).rejects.toThrow(ProjectKnowledgeError);
    const sentinel = `ghp_${'1234567890'.repeat(3)}123456`;
    const unsafe = session.submit(proposal, session.exchange.exchangeDigest, [{ ...question, id: sentinel }]);
    await expect(unsafe).rejects.toThrow(ProjectKnowledgeError);
    await unsafe.catch((error: unknown) => { expect(String(error)).not.toContain(sentinel); });
    expect(session.reviewTargets()).toEqual([]);
    await session.submit(proposal, session.exchange.exchangeDigest, [question]);
    expect(session.reviewTargets().length).toBeGreaterThan(0);
    const result = await session.finalize(fixtureReview(proposal), proposal.proposalDigest);
    expect(result.proposal.proposalDigest).toBe(proposal.proposalDigest);
  });

  it('bridges independently reviewed text through existing hierarchy receipts and integrity', async () => {
    const fixture = await sessionFixture(true);
    const session = await fixture.service.prepare(fixture.input);
    const snapshot = session.exchange.snapshot;
    const roles = ['overview', 'architecture', 'decisions'] as const;
    const inputs = roles.map((role) => {
      const name = role === 'overview' ? 'README.md' : role === 'architecture' ? 'architecture.md' : 'decision.md';
      const evidence = snapshot.evidence.filter((e) => e.sourceRef === name && e.excerpt.length > 80)
        .sort((a, b) => b.excerpt.length - a.excerpt.length)[0];
      if (!evidence) throw new Error('Missing bridge fixture evidence.');
      return { ...fixtureFact(snapshot), subject: `fixture:${role}`, statement: evidence.excerpt,
        lifecycle: role === 'decisions' ? 'historical' as const : 'current' as const,
        evidenceIds: [evidence.evidenceId] };
    });
    const proposal = createKnowledgeProposal({ projectId: snapshot.projectId, snapshotDigest: snapshot.snapshotDigest,
      baselineGenerationDigest: null, actor: TEST_KNOWLEDGE_ACTOR, facts: inputs, supersessions: [], conflicts: [],
      pages: roles.map((role, index) => {
        const input = inputs[index];
        if (!input) throw new Error('Missing bridge claim.');
        const fact = createProposedKnowledgeRecord(input, snapshot, TEST_KNOWLEDGE_ACTOR);
        const title = input.statement.split(/\s/u).slice(0, 5).join(' ');
        return { role, title, sections: [{ title: 'Documented evidence', claims: [{ claimId: `claim-${role}`,
          text: input.statement, factIds: [fact.id], presentation: role === 'decisions' ? 'history' : 'current' }] }] };
      }) }, snapshot);
    const { reviewDigest: old, ...reviewBasis } = fixtureReview(proposal);
    void old;
    const reviewInput = { ...reviewBasis, judgments: reviewBasis.judgments.map((j) => {
      const page = proposal.pages.find((p) => j.targetId === `claim-${p.role}` || j.targetId === `title:${p.role}` || j.targetId === `section:${p.role}:0`);
      const id = page?.sections[0]?.claims[0]?.factIds[0];
      return page === undefined ? j : { ...j, evidenceIds: proposal.facts.find((f) => f.id === id)?.evidenceIds ?? [] };
    }) };
    await session.submit(proposal, session.exchange.exchangeDigest);
    const generation = await session.finalize({ ...reviewInput, reviewDigest: digest(reviewInput) }, proposal.proposalDigest);
    const serializedGeneration = JSON.stringify(generation);
    const serializedDigest = sha256(serializedGeneration);
    const aggregateScan = await fixture.security.prepareSource({ projectId: 'parcel',
      source: 'project-knowledge-reader.md', sourceKind: 'wiki', body: serializedGeneration,
      bodyDigest: serializedDigest, sourceRevisionOrContentSha256: serializedDigest });
    expect(aggregateScan.ok).toBe(false);
    expect(aggregateScan.report.summaries).toContainEqual(expect.objectContaining({
      ruleId: 'prompt-injection.secret-exfiltration', action: 'quarantine',
    }));
    const nextFixture = await sessionFixture(true);
    const resumed = await nextFixture.service.prepare({ ...nextFixture.input, previousGenerations: [generation] });
    expect(resumed.exchange.baselineGenerationDigest).toBe(generation.generationDigest);
    expect(resumed.exchange.previousRecords).toEqual(generation.records);
    const bridge = await bridgeKnowledgeToHierarchy({ knowledgeRoot: fixture.root, generation,
      baselineGenerationDigest: null, baselineProposals: [] });
    expect(bridge.pageMappings.map((m) => m.role).sort()).toEqual([...roles].sort());
    expect(bridge.finalization.integrityReport).toBeDefined();
    expect(() => finalizeCompileRun(bridge.finalization, 'parcel')).not.toThrow();
    for (const e of generation.evidence) {
      const sourceId = `source-${digestHierarchyValue({ projectId: 'parcel', evidenceId: e.evidenceId }).slice(7)}`;
      const unit = bridge.snapshot.textUnits.find((u) => u.sourceId === sourceId);
      const match = bridge.finalization.evidencePacks.flatMap((p) => p.units).find((u) => u.unitId === unit?.unitId);
      expect(bridge.evidenceMappings.find((m) => m.evidenceId === e.evidenceId)).toEqual({
        evidenceId: e.evidenceId, unitId: unit?.unitId, citationId: match?.citation.citationId });
    }
    for (const page of generation.pages) {
      const mapping = bridge.pageMappings.find((m) => m.role === page.role);
      const actual = bridge.finalization.proposals.find((p) => p.pageId === mapping?.pageId);
      for (const claim of page.sections.flatMap((s) => s.claims)) {
        const ids = [...new Set(claim.factIds.flatMap((id) => generation.records.find((f) => f.id === id)?.evidenceIds ?? []))];
        const mapped = ids.map((id) => bridge.evidenceMappings.find((m) => m.evidenceId === id));
        const basis = { text: claim.text, evidenceUnitIds: mapped.map((m) => m?.unitId).sort(),
          citationIds: mapped.map((m) => m?.citationId).sort() };
        expect(actual?.claims).toContainEqual({ ...basis, claimId: `claim-${digestHierarchyValue(basis).slice(7)}` });
      }
    }
    const authority = approveKnowledgeWikiAuthority({ generations: [generation], bridge,
      previousAuthority: null, explicitConfirmation: true });
    expect(() => verifyApprovedWikiAuthority(authority, 'parcel')).not.toThrow();
    expect(prepareApprovedWikiPublication(authority, 'parcel').projection.corpus.pages).toHaveLength(3);
    expect(() => verifyApprovedWikiAuthority({ ...authority, schemaVersion: 'buildlore.approved-wiki-authority.v1' }, 'parcel')).toThrow();
    const plan = renderHierarchicalMarkdown({ publication: prepareApprovedWikiPublication(authority, 'parcel') });
    expect(parseHierarchicalMarkdownManifest(JSON.parse(plan.manifestBody) as unknown, 'parcel')).toEqual(plan.manifest);
    const publication = createHierarchicalMarkdownPublication({ knowledgeRoot: fixture.root, lease: testLease });
    const published = await publication.publish({ authority, projectId: 'parcel' });
    // Existing status counts materialized content files, excluding the manifest itself.
    expect(published.materialization).toMatchObject({ state: 'ready', fileCount: 5, pageCount: 3 });
    const directory = join(fixture.root, 'projects/parcel/wiki/buildlore-hierarchy');
    expect((await readdir(directory)).sort()).toEqual(['architecture.md', 'decisions.md', 'evidence.json', 'knowledge.json', 'manifest.json', 'overview.md']);
    expect(await readFile(join(directory, 'overview.md'), 'utf8')).toContain('declared; current; accepted');
    expect(await publication.status('parcel')).toMatchObject({ state: 'ready' });
    const reader = createKnowledgeWikiReader(fixture.root);
    expect(await reader.list('parcel')).toMatchObject({ total: 3, generationDigest: generation.generationDigest });
    const overview = await reader.read('parcel', 'overview');
    expect(overview).toMatchObject({ generationDigest: generation.generationDigest });
    expect(overview?.facts).toEqual(expect.arrayContaining([expect.objectContaining({ classification: 'declared', reviewStatus: 'accepted' })]));
    expect(await reader.search('parcel', 'documented processing path', 'hybrid')).toMatchObject({
      effectiveMode: 'lexical-graph', fallback: { reasonCode: 'semantic-index-unavailable' },
      generationDigest: generation.generationDigest });
    const current = await reader.search('parcel', 'local', 'lexical', 'current');
    const historical = await reader.search('parcel', 'local', 'lexical', 'historical');
    for (const [response, expected] of [[current, -0.0015], [historical, 0.0015]] as const) {
      if (!Array.isArray(response?.hits)) throw new Error('Missing fixture search results.');
      const hits: readonly unknown[] = response.hits;
      expect(hits.map(record).find((hit) => hit.role === 'decisions'))
        .toMatchObject({ meaningAdjustment: { authority: expected } });
    }
    const provider = knowledgeSemanticProvider();
    const identity = provider.activeIdentity();
    if (!identity) throw new Error('Missing fixture embedding identity.');
    await createLocalWikiOperator({ hubRoot: fixture.root, knowledgeRoot: fixture.root,
      provider, embeddingIdentity: identity, repositoryLease: testLease }).rebuildIndex({ projectId: 'parcel' });
    const semanticReader = createKnowledgeWikiReader(fixture.root, { provider });
    for (const mode of ['semantic', 'hybrid'] as const) {
      for (const [intent, expected] of [['current', -0.0015], ['historical', 0.0015]] as const) {
        const result = await semanticReader.search('parcel', 'local', mode, intent);
        expect(result).toMatchObject({ effectiveMode: mode, fallback: null });
        if (!Array.isArray(result?.hits)) throw new Error('Missing fixture semantic results.');
        const hits: readonly unknown[] = result.hits;
        expect(hits.map(record).find(hit => hit.role === 'decisions'))
          .toMatchObject({ meaningAdjustment: { authority: expected } });
      }
    }
    await expect(reader.evidence('parcel', digest('stale-generation'), generation.evidence[0]?.evidenceId ?? digest('missing'))).rejects.toThrow(ProjectKnowledgeError);
  // Publication plus repeated integrity-checked file reads is an integration path, not a 5s unit test.
  }, 15_000);

  it('uses real sanitizer capabilities and produces three deterministic Markdown pages without provider calls', async () => {
    const fixture = await sessionFixture();
    const session = await fixture.service.prepare(fixture.input);
    expect(session.exchange.boundary).toEqual({ generationActor: 'current-agent-session', egress: 'none', processSpawned: false });
    const proposal = fixtureProposal(session.exchange.snapshot);
    await session.submit(proposal, session.exchange.exchangeDigest);
    const generation = await session.finalize(fixtureReview(proposal), proposal.proposalDigest);
    const files = renderKnowledgeFiles(generation);
    expect(files.map((f) => f.path).sort()).toEqual(['architecture.md', 'decisions.md', 'evidence.json', 'knowledge.json', 'manifest.json', 'overview.md']);
    expect(renderKnowledgeFiles(generation)).toEqual(files);
    expect(files.find((f) => f.path === 'overview.md')?.body).toContain('declared; current; accepted');
    await expect(fixture.service.prepare(fixture.input)).rejects.toThrow(ProjectKnowledgeError);
  });

  it('refuses forged prepared source capabilities', async () => {
    const fixture = await sessionFixture();
    await expect(fixture.service.prepare({ ...fixture.input, sources: fixture.input.sources.map((s) => ({
      ...s, prepared: { opaque: true as const },
    })) })).rejects.toThrow(ProjectKnowledgeError);
  });

  it('requires independent review and complete claim, title and section coverage', async () => {
    const fixture = await sessionFixture();
    const session = await fixture.service.prepare(fixture.input);
    const proposal = fixtureProposal(session.exchange.snapshot);
    await session.submit(proposal, session.exchange.exchangeDigest);
    const review = fixtureReview(proposal);
    const self = { ...review, reviewer: proposal.actor };
    const { reviewDigest: old, ...basis } = self;
    void old;
    await expect(session.finalize({ ...basis, reviewDigest: digest(basis) }, proposal.proposalDigest)).rejects.toThrow(ProjectKnowledgeError);
    const incomplete = { ...basis, reviewer: review.reviewer, judgments: review.judgments.slice(1) };
    expect(() => parseKnowledgeSemanticReview({ ...incomplete, reviewDigest: digest(incomplete) }, proposal, session.exchange.snapshot)).toThrow(ProjectKnowledgeError);
  });

  it('does not confuse structurally valid citations with a supported semantic judgment', async () => {
    const fixture = await sessionFixture();
    const session = await fixture.service.prepare(fixture.input);
    const proposal = fixtureProposal(session.exchange.snapshot);
    await session.submit(proposal, session.exchange.exchangeDigest);
    const { reviewDigest: old, ...review } = fixtureReview(proposal);
    void old;
    const declined = { ...review, judgments: review.judgments.map((j) => j.targetId === 'claim-overview'
      ? { ...j, verdict: 'unsupported', rationale: 'The cited source does not support the claimed scope.' } : j) };
    await expect(session.finalize({ ...declined, reviewDigest: digest(declined) }, proposal.proposalDigest)).rejects.toThrow(ProjectKnowledgeError);
  });

  it('rejects source drift and stale exchange expectations', async () => {
    const fixture = await sessionFixture();
    const session = await fixture.service.prepare(fixture.input);
    const proposal = fixtureProposal(session.exchange.snapshot);
    await expect(session.submit(proposal, digest('wrong-exchange'))).rejects.toThrow(ProjectKnowledgeError);
    await session.submit(proposal, session.exchange.exchangeDigest);
    await expect(session.finalize(fixtureReview(proposal), digest('wrong-proposal'))).rejects.toThrow(ProjectKnowledgeError);
  });
});
