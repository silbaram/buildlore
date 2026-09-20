import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addProject } from '../src/knowledge/index.js';
import { digest, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { createProposedKnowledgeRecord } from '../src/knowledge/project-knowledge/records.js';
import { createProjectSecurityService } from '../src/sanitizer/index.js';
import { createKnowledgeSessionService } from '../src/compiler/project-knowledge/session.js';
import { createKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { bridgeKnowledgeToHierarchy } from '../src/compiler/project-knowledge/hierarchy-bridge.js';
import { finalizeCompileRun } from '../src/compiler/hierarchy/lineage.js';
import { createReviewedKnowledgeQuality, type ReviewedKnowledgeQuality } from '../src/compiler/hierarchy/reviewed-quality.js';
import { approveKnowledgeWikiAuthority, approveKnowledgeWikiHistoryAuthority } from '../src/retrieval/project-knowledge-authority.js';
import { verifyApprovedWikiAuthority, type ApprovedWikiAuthorityV1 } from '../src/retrieval/approved-corpus-store.js';
import { createKnowledgeGenerationHistoryStore } from '../src/retrieval/project-knowledge-history-store.js';
import { createHierarchicalMarkdownPublication } from '../src/retrieval/hierarchical-markdown-publication.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { historyTestLease } from './helpers/project-knowledge-history.js';
import { fixtureReview, knowledgeFixtureSnapshot, TEST_KNOWLEDGE_ACTOR } from './helpers/project-knowledge-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function koreanFixture() {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-reviewed-quality-'));
  roots.push(root);
  await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
  await writeSecurityPolicy(root, 'parcel', { capabilities: [] });
  const security = createProjectSecurityService({ knowledgeRoot: root });
  const original = await knowledgeFixtureSnapshot();
  const sources = await Promise.all(original.sources.map(async source => {
    const result = await security.prepareSource({ projectId: 'parcel', source: source.sourceRef, sourceKind: source.format,
      body: source.content, bodyDigest: sha256(source.content), sourceRevisionOrContentSha256: source.sourceContentDigest });
    if (!result.ok) throw new Error('Safe fixture source rejected.');
    return { source, prepared: result.prepared };
  }));
  const session = await createKnowledgeSessionService({ knowledgeRoot: root }).prepare({
    projectId: 'parcel', selectionDigest: original.selectionDigest, sources, outputLanguage: 'ko' });
  const snapshot = session.exchange.snapshot;
  const pages = [
    { role: 'overview', source: 'README.md', title: '도구의 개요', question: '누가 무엇에 사용하는가',
      text: '오프라인 작업자를 위한 지역 일괄 배송 계획 도구이다. 배송 명세서를 준비하지만 소포를 직접 보내거나 운송 회사에 접속하지 않는다.' },
    { role: 'architecture', source: 'architecture.md', title: '내부 아키텍처', question: '각 구성 요소는 어떤 책임을 맡는가',
      text: '명령행은 선택된 입력 목록을 읽고 옵션을 검증한다. 계획기는 배송을 지역별로 묶으며 저장소는 검토 가능한 명세서를 저장한다. 저장 실패 시 이전 명세서를 보존해야 한다.' },
    { role: 'decisions', source: 'decision.md', title: '저장 기술의 결정', question: '선택의 이유와 대안은 무엇인가',
      text: '지역 명세서를 위한 내장 데이터베이스를 선택한 이유는 서버 없이 트랜잭션을 지원하기 때문이다. 일반 파일도 고려했지만 여러 레코드의 일관된 갱신에 추가 주의가 필요해 보류했다.' },
  ] as const;
  const facts = pages.map(page => {
    const evidence = snapshot.evidence.filter(e => e.sourceRef === page.source && e.excerpt.length > 80)
      .sort((a, b) => b.excerpt.length - a.excerpt.length)[0];
    if (!evidence) throw new Error('Missing English fixture evidence.');
    return { subject: `fixture:${page.role}`, predicate: 'description', scope: 'documented statement', statement: page.text,
      classification: 'declared' as const, lifecycle: 'current' as const, evidenceIds: [evidence.evidenceId], observation: null };
  });
  const records = facts.map(fact => createProposedKnowledgeRecord(fact, snapshot, TEST_KNOWLEDGE_ACTOR));
  const proposal = createKnowledgeProposal({ projectId: 'parcel', snapshotDigest: snapshot.snapshotDigest,
    baselineGenerationDigest: null, actor: TEST_KNOWLEDGE_ACTOR, facts, supersessions: [], conflicts: [],
    pages: pages.map((page, i) => ({ role: page.role, title: page.title,
      sections: [{ title: page.question, claims: [{ claimId: `claim-${page.role}`, text: page.text,
        factIds: [records[i]?.id], presentation: 'current' }] }] })) }, snapshot);
  await session.submit(proposal, session.exchange.exchangeDigest);
  const review = fixtureReview(proposal);
  const generation = await session.finalize(review, proposal.proposalDigest);
  const bridge = await bridgeKnowledgeToHierarchy({ knowledgeRoot: root, generation,
    baselineGenerationDigest: null, baselineProposals: [] });
  return { root, session, proposal, review, generation, bridge };
}

describe('independently reviewed multilingual quality', () => {
  it('finalizes Korean prose over English evidence without title repetition or artificial overlap', async () => {
    const f = await koreanFixture();
    expect(finalizeCompileRun(f.bridge.finalization, 'parcel', f.bridge.reviewedQuality)).toMatchObject({ status: 'finalized' });
    for (const report of f.bridge.finalization.pageQualityReports) {
      expect(report).toMatchObject({ schemaVersion: 'buildlore.page-quality-report.v3', hardQualityPassed: true,
        lexicalClaimEvidenceSupportBasisPoints: 0, claimEvidenceSupportBasisPoints: 10000,
        questionCoverageBasisPoints: 10000, summaryGrounded: true, semanticReviewDigest: f.review.reviewDigest });
    }
    await expect(bridgeKnowledgeToHierarchy({ knowledgeRoot: f.root, generation: f.generation,
      baselineGenerationDigest: null, baselineProposals: [], qualityMode: 'lexical' })).rejects.toMatchObject({
      code: 'KNOWLEDGE_HIERARCHY_QUALITY_REQUIRED' });
  });

  it('rejects absent, self, stale, incomplete and negative semantic reviews', async () => {
    const f = await koreanFixture();
    const { reviewDigest: old, ...basis } = f.review;
    void old;
    for (const changed of [
      { ...basis, reviewer: f.proposal.actor },
      { ...basis, snapshotDigest: digest('different snapshot') },
      { ...basis, judgments: basis.judgments.slice(1) },
      { ...basis, judgments: basis.judgments.map(j => j.targetId === 'claim-architecture' ? { ...j, verdict: 'unsupported' } : j) },
      { ...basis, judgments: basis.judgments.map(j => j.targetId === 'section:architecture:0' ? { ...j, verdict: 'insufficient' } : j) },
    ]) await expect(f.session.finalize({ ...changed, reviewDigest: digest(changed) }, f.proposal.proposalDigest)).rejects.toThrow();
    await expect(f.session.finalize(null, f.proposal.proposalDigest)).rejects.toThrow();
  });

  it('rejects serialized pass capabilities, copied generations and modified prose or citations', async () => {
    const f = await koreanFixture();
    const finalization = f.bridge.finalization;
    expect(() => finalizeCompileRun(finalization, 'parcel')).toThrow();
    const forged = JSON.parse(JSON.stringify(f.bridge.reviewedQuality)) as ReviewedKnowledgeQuality;
    expect(() => finalizeCompileRun(finalization, 'parcel', forged)).toThrow();
    const inputs = { outline: finalization.outline, proposals: finalization.proposals, evidencePacks: finalization.evidencePacks };
    expect(() => createReviewedKnowledgeQuality({ ...f.generation }, inputs)).toThrow();
    for (const proposals of [
      finalization.proposals.map((p, i) => i !== 0 ? p : { ...p, summary: '무관한 주장을 삽입한다.' }),
      finalization.proposals.map((p, i) => i !== 0 ? p : { ...p, sections: p.sections.map(s => ({ ...s, body: s.body + ' 근거 없는 추가 문장.' })) }),
      finalization.proposals.map((p, i) => i !== 0 ? p : { ...p, claims: p.claims.map(c => ({ ...c, citationIds: [] })) }),
    ]) expect(() => createReviewedKnowledgeQuality(f.generation, { ...inputs, proposals })).toThrow();
    expect(() => createReviewedKnowledgeQuality(f.generation, { ...inputs, outline: { ...inputs.outline, projectId: 'other' } })).toThrow();
  });

  it('rejects a supported heading whose reviewed evidence belongs to a different section', async () => {
    const f = await koreanFixture();
    const unrelated = f.review.judgments.find(j => j.targetId === 'claim-decisions');
    if (!unrelated) throw new Error('Missing test judgment.');
    const { reviewDigest: old, ...basis } = f.review;
    void old;
    const changed = { ...basis, judgments: basis.judgments.map(j => j.targetId === 'section:architecture:0'
      ? { ...j, evidenceIds: unrelated.evidenceIds } : j) };
    const generation = await f.session.finalize({ ...changed, reviewDigest: digest(changed) }, f.proposal.proposalDigest);
    await expect(bridgeKnowledgeToHierarchy({ knowledgeRoot: f.root, generation,
      baselineGenerationDigest: null, baselineProposals: [] })).rejects.toThrow();
  });

  it('replays serialized authority and rejects changed review bindings or a downgraded quality report', async () => {
    const f = await koreanFixture();
    const authority = approveKnowledgeWikiAuthority({ generations: [f.generation], bridge: f.bridge,
      previousAuthority: null, explicitConfirmation: true });
    const persisted = JSON.parse(JSON.stringify(authority)) as ApprovedWikiAuthorityV1;
    expect(() => verifyApprovedWikiAuthority(persisted, 'parcel')).not.toThrow();
    for (const change of [
      { semanticReviewDigest: digest('different review') },
      { knowledgeGenerationDigest: digest('different generation') },
      { schemaVersion: 'buildlore.corpus-quality-report.v2' as const },
    ]) {
      const altered = { ...persisted, finalization: { ...persisted.finalization,
        corpusQualityReport: { ...persisted.finalization.corpusQualityReport, ...change } } };
      expect(() => verifyApprovedWikiAuthority(altered, 'parcel')).toThrow();
    }
    const { knowledgeGeneration: removed, ...withoutReview } = persisted;
    void removed;
    expect(() => verifyApprovedWikiAuthority({ ...withoutReview, schemaVersion: 'buildlore.approved-wiki-authority.v1' }, 'parcel')).toThrow();
  });

  it('persists explicit approval and replays semantic support when a fresh reader loads the Wiki', async () => {
    const f = await koreanFixture();
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: f.root });
    const authority = await approveKnowledgeWikiHistoryAuthority({ generation: f.generation, bridge: f.bridge,
      previousAuthority: null, explicitConfirmation: true, store });
    const publication = createHierarchicalMarkdownPublication({ knowledgeRoot: f.root, lease: historyTestLease });
    await publication.publish({ projectId: 'parcel', authority });
    const reader = createKnowledgeWikiReader(f.root);
    expect(await reader.list('parcel')).toMatchObject({ total: 3, generationDigest: f.generation.generationDigest });
    const page = await reader.read('parcel', 'architecture');
    expect(JSON.stringify(page)).toContain('저장 실패 시 이전 명세서를 보존해야 한다');
    expect(await publication.status('parcel')).toMatchObject({ state: 'ready' });
  });
});
