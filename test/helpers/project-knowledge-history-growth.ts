import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApprovedWikiPublicationReader, readApprovedWikiPublicationSnapshot,
  type CurrentApprovedWikiAuthority } from '../../src/retrieval/approved-corpus-store.js';
import { latestKnowledgeGeneration, knowledgeAuthorityHistory } from '../../src/retrieval/project-knowledge-authority.js';
import { createKnowledgeWikiReader } from '../../src/retrieval/project-knowledge-reader.js';
import { record } from '../../src/knowledge/project-knowledge/guards.js';
import { historyPublicationFixture } from './project-knowledge-history.js';

/** Separate workers keep the independent growth contracts within the runner command budget. */
export function defineHistoryGrowthTest(projectId: string): void {
  it(`approves, activates and rereads 65 sequential generations for ${projectId}`, async () => {
    const f = await historyPublicationFixture(projectId);
    try {
    const publication = f.publication();
    const reader = createApprovedWikiPublicationReader(f.root);
    let current: CurrentApprovedWikiAuthority | null = null;
    for (let i = 0; i < 65; i += 1) {
      current = await f.next(current);
      await publication.publish({ projectId, authority: current });
      const read = await reader.read(projectId);
      if (read?.authority.schemaVersion !== 'buildlore.approved-wiki-authority.v3') throw new Error('Missing pointer authority.');
      expect(read.authority.knowledgeGeneration.history.generationCount).toBe(String(i + 1));
      expect(knowledgeAuthorityHistory(read.authority.knowledgeGeneration).latest.generationDigest)
        .toBe(current.knowledgeGeneration?.generationDigest);
      current = read.authority;
    }
    const wiki = createKnowledgeWikiReader(f.root);
    expect((await wiki.read(projectId, 'overview'))?.markdown).toContain(projectId === 'lantern' ? 'offline maintainer' : 'local batch-delivery planner');
    const result = await wiki.search(projectId, projectId === 'lantern' ? 'local documentation links' : 'delivery manifests', 'lexical');
    expect(Array.isArray(result?.hits)).toBe(true);
    expect((result?.hits as readonly unknown[]).some(hit => record(hit).role === 'overview')).toBe(true);
    await expect(wiki.read(`${projectId}-other`, 'overview')).rejects.toThrow();
    const objects = await readdir(join(f.root, 'projects', projectId, '.llmwiki/buildlore-hierarchy/knowledge-history/objects'));
    expect(objects).toHaveLength(65);
    } finally { await f.cleanup(); }
  }, 600_000);

}

export function defineHistoryAggregateTest(): void {
  it('publishes and cold-reads more than 22,772,886 retained bytes while keeping each generation bounded', async () => {
    const f = await historyPublicationFixture('parcel', true);
    try {
    let current: CurrentApprovedWikiAuthority | null = null;
    let totalBytes = 0;
    for (let i = 0; i < 3; i += 1) {
      current = await f.next(current);
      if (!current.knowledgeGeneration) throw new Error('Missing generation.');
      const bytes = Buffer.byteLength(JSON.stringify(latestKnowledgeGeneration(current.knowledgeGeneration)));
      expect(bytes).toBeLessThan(16 * 1024 * 1024);
      totalBytes += bytes;
      await f.publication().publish({ projectId: f.projectId, authority: current });
    }
    expect(totalBytes).toBeGreaterThanOrEqual(22_772_886);
    const cold = await readApprovedWikiPublicationSnapshot(f.root, f.projectId);
    expect(cold.authority.knowledgeGeneration?.generationDigest).toBe(current?.knowledgeGeneration?.generationDigest);
    expect((await createKnowledgeWikiReader(f.root).read(f.projectId, 'overview'))?.markdown).toContain('local batch-delivery planner');
    } finally { await f.cleanup(); }
  }, 600_000);}
