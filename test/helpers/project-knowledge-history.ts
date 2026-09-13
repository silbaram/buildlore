import { createProposedKnowledgeRecord } from '../../src/knowledge/project-knowledge/records.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProject } from '../../src/knowledge/index.js';
import { sha256 } from '../../src/knowledge/project-knowledge/guards.js';
import { createProjectSecurityService } from '../../src/sanitizer/index.js';
import { createKnowledgeSessionService } from '../../src/compiler/project-knowledge/session.js';
import { createKnowledgeProposal } from '../../src/compiler/project-knowledge/proposal.js';
import { bridgeKnowledgeToHierarchy } from '../../src/compiler/project-knowledge/hierarchy-bridge.js';
import { createKnowledgeGenerationHistoryStore } from '../../src/retrieval/project-knowledge-history-store.js';
import { approveKnowledgeWikiAuthority, approveKnowledgeWikiHistoryAuthority, knowledgeAuthorityHistory } from '../../src/retrieval/project-knowledge-authority.js';
import type { CurrentApprovedWikiAuthority } from '../../src/retrieval/approved-corpus-store.js';
import { createHierarchicalMarkdownPublication, type HierarchicalMarkdownPublicationTestHooks,
  type HierarchicalMarkdownRepositoryLeasePort } from '../../src/retrieval/hierarchical-markdown-publication.js';
import { fixtureReview, knowledgeFixtureSnapshot, TEST_KNOWLEDGE_ACTOR } from './project-knowledge-fixture.js';
import { writeSecurityPolicy } from '../fixtures/security-policy.js';

export const historyTestLease: HierarchicalMarkdownRepositoryLeasePort = {
  async withLease(_root, _operation, action) {
    return action({ repositoryIdentityDigest: 'deterministic-history-test', updatePhase: () => Promise.resolve() });
  },
};

export async function historyPublicationFixture(projectId = 'parcel', rich = false): Promise<{
  root: string; projectId: string;
  next(previous: CurrentApprovedWikiAuthority | null, legacy?: boolean): Promise<CurrentApprovedWikiAuthority>;
  publication(hooks?: HierarchicalMarkdownPublicationTestHooks): ReturnType<typeof createHierarchicalMarkdownPublication>;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-history-publication-'));
  await addProject(root, { projectId, displayName: projectId, sourceRepository: `https://example.test/${projectId}.git` });
  await writeSecurityPolicy(root, projectId, { capabilities: [] });
  const original = await knowledgeFixtureSnapshot();
  const content = 'Historical operating notes remain available as retained project evidence.\n'.repeat(3000);
  const extra = rich ? Array.from({ length: 18 }, (_, i) => ({ sourceId: `history-note-${String(i)}`,
    sourceRef: `note-${String(i)}.md`, format: 'markdown' as const, content, sourceContentDigest: sha256(content),
    sourceRevision: 'R1', codeRevision: null, tracked: true })) : [];
  const sourcesForProject = projectId === 'lantern' ? await Promise.all(['README.md', 'decision.md'].map(async sourceRef => {
    const content = await readFile(join(process.cwd(), 'test/fixtures/project-knowledge/v1/optional-p2a/R1', sourceRef), 'utf8');
    return { sourceId: sourceRef.replaceAll('.', '-'), sourceRef, format: 'markdown' as const, content,
      sourceContentDigest: sha256(content), sourceRevision: 'R1', codeRevision: null, tracked: true };
  })) : original.sources;
  const sourceValues = [...sourcesForProject, ...extra];
  const security = createProjectSecurityService({ knowledgeRoot: root });
  const sessions = createKnowledgeSessionService({ knowledgeRoot: root });
  const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
  return { root, projectId,
    publication: hooks => createHierarchicalMarkdownPublication({ knowledgeRoot: root, lease: historyTestLease,
      ...(hooks === undefined ? {} : { hooks }) }),
    cleanup: () => rm(root, { recursive: true, force: true }),
    async next(previous, legacy = false) {
      const sources = await Promise.all(sourceValues.map(async source => {
        const result = await security.prepareSource({ projectId, source: source.sourceRef, sourceKind: source.format,
          body: source.content, bodyDigest: sha256(source.content), sourceRevisionOrContentSha256: source.sourceContentDigest });
        if (!result.ok) throw new Error('Safe history fixture source rejected.');
        return { source, prepared: result.prepared };
      }));
      const extension = previous?.knowledgeGeneration;
      const session = await sessions.prepare({ projectId, sources, selectionDigest: original.selectionDigest,
        ...(extension?.schemaVersion === 'buildlore.knowledge-authority-extension.v2'
          ? { previousHistory: knowledgeAuthorityHistory(extension) } : { previousGenerations: extension?.generations ?? [] }) });
      const roles = ['overview', 'architecture', 'decisions'] as const;
      const snapshot = session.exchange.snapshot;
      const facts = roles.map(role => {
        const name = role === 'overview' || (role === 'architecture' && projectId === 'lantern') ? 'README.md' : role === 'architecture' ? 'architecture.md' : 'decision.md';
        const evidence = snapshot.evidence.filter(e => e.sourceRef === name && e.excerpt.length > 80 &&
          (role === 'overview' ? e.excerpt.includes(projectId === 'lantern' ? 'offline maintainer' : 'local batch')
            : projectId === 'lantern' && role === 'architecture' ? e.excerpt.includes('documented flow') : true))
          .sort((a, b) => b.excerpt.length - a.excerpt.length)[0];
        if (!evidence) throw new Error('Missing safe fixture evidence.');
        return { subject: `fixture:${role}`, predicate: 'description', scope: 'documented project',
          statement: evidence.excerpt, classification: 'declared' as const, lifecycle: 'current' as const,
          evidenceIds: [evidence.evidenceId], observation: null };
      });
      const records = facts.map(fact => createProposedKnowledgeRecord(fact, snapshot, TEST_KNOWLEDGE_ACTOR));
      const proposal = createKnowledgeProposal({ projectId, snapshotDigest: snapshot.snapshotDigest,
        baselineGenerationDigest: session.exchange.baselineGenerationDigest, actor: TEST_KNOWLEDGE_ACTOR,
        facts, supersessions: [], conflicts: [], pages: roles.map((role, i) => {
          const fact = records[i];
          if (!fact) throw new Error('Missing safe fixture fact.');
          return { role, title: fact.statement.split(/\s/u).slice(0, 5).join(' '),
            sections: [{ title: 'Documented evidence', claims: [{ claimId: `claim-${role}`, text: fact.statement,
              factIds: [fact.id], presentation: 'current' }] }] };
        }) }, snapshot);
      await session.submit(proposal, session.exchange.exchangeDigest);
      const generation = await session.finalize(fixtureReview(proposal), proposal.proposalDigest);
      const bridge = await bridgeKnowledgeToHierarchy({ knowledgeRoot: root, generation,
        baselineGenerationDigest: previous?.state.generationDigest ?? null, baselineProposals: previous?.finalization.proposals ?? [] });
      if (legacy) {
        if (previous?.schemaVersion === 'buildlore.approved-wiki-authority.v3') throw new Error('Cannot downgrade fixture.');
        return approveKnowledgeWikiAuthority({ generations: [...(previous?.knowledgeGeneration?.generations ?? []), generation],
          bridge, previousAuthority: previous, explicitConfirmation: true });
      }
      return approveKnowledgeWikiHistoryAuthority({ generation, bridge, previousAuthority: previous, explicitConfirmation: true, store });
    },
  };
}
