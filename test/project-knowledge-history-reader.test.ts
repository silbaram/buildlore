import { readFile, readdir, lstat, writeFile, utimes, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApprovedWikiPublicationReader, readApprovedWikiPublicationSnapshot,
  prepareApprovedWikiPublication, prepareCurrentApprovedWikiPublication, createApprovedWikiProjectionStore,
  type ApprovedWikiAuthorityV1 } from '../src/retrieval/approved-corpus-store.js';
import { latestKnowledgeGeneration, createKnowledgeHistoryAppend,
  verifyKnowledgeHistoryAppend } from '../src/retrieval/project-knowledge-authority.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { historyPublicationFixture } from './helpers/project-knowledge-history.js';
import { digest } from '../src/knowledge/project-knowledge/guards.js';

const fixtures: Awaited<ReturnType<typeof historyPublicationFixture>>[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
async function fixture(projectId = 'parcel', rich = false) {
  const f = await historyPublicationFixture(projectId, rich); fixtures.push(f); return f;
}
function authorityPath(root: string, projectId: string) {
  return join(root, 'projects', projectId, '.llmwiki/buildlore-hierarchy/approved-authority.json');
}

describe('bounded history publication and reader integration', () => {
  it('reads legacy without migration, archives exact v2 bytes at explicit activation, and preserves all generations', async () => {
    const f = await fixture();
    const publication = f.publication();
    const first = await f.next(null, true);
    await publication.publish({ projectId: f.projectId, authority: first });
    const path = authorityPath(f.root, f.projectId);
    // Legacy ingress accepts valid noncanonical whitespace and archival must preserve it too.
    const priorBytes = Buffer.from(JSON.stringify(JSON.parse(await readFile(path, 'utf8')) as unknown, null, 4) + '\n');
    await writeFile(path, priorBytes);
    const legacy = await readApprovedWikiPublicationSnapshot(f.root, f.projectId);
    expect(legacy.authority.schemaVersion).toBe('buildlore.approved-wiki-authority.v2');
    expect(await readFile(path)).toEqual(priorBytes);
    const second = await f.next(legacy.authority);
    expect(await readFile(path)).toEqual(priorBytes);
    expect(second.schemaVersion).toBe('buildlore.approved-wiki-authority.v3');
    // Synchronous legacy entrypoints must not trust unresolved pointer objects.
    expect(() => prepareApprovedWikiPublication(second as ApprovedWikiAuthorityV1, f.projectId)).toThrow();
    const activated = await publication.publish({ projectId: f.projectId, authority: second });
    expect(activated.materialization.state).toBe('ready');
    const current = await readApprovedWikiPublicationSnapshot(f.root, f.projectId);
    if (current.authority.schemaVersion !== 'buildlore.approved-wiki-authority.v3') throw new Error('Missing pointer authority.');
    expect(current.authority.knowledgeGeneration.history.generationCount).toBe('2');
    const extension = current.authority.knowledgeGeneration;
    const previousGeneration = first.knowledgeGeneration && latestKnowledgeGeneration(first.knowledgeGeneration);
    expect(extension.baselineHistory?.headGenerationDigest).toBe(previousGeneration?.generationDigest);
    const archive = join(f.root, 'projects', f.projectId, '.llmwiki/buildlore-hierarchy/archives', `${legacy.recordDigest.slice(7)}.record.json`);
    expect(await readFile(archive)).toEqual(priorBytes);
    const reader = createKnowledgeWikiReader(f.root);
    expect((await reader.read(f.projectId, 'overview'))?.generationDigest).toBe(extension.generationDigest);
    const activeBytes = await readFile(path);
    await reader.read(f.projectId, 'overview');
    expect(await readFile(path)).toEqual(activeBytes);
    expect(await publication.publish({ projectId: f.projectId, authority: second })).toEqual(activated);
  }, 60_000);

  it.each(['beforeAuthorityCommit', 'afterNewGenerationMove'] as const)('restores prior authority and Wiki after %s and retries without duplicate history', async hook => {
    const f = await fixture();
    const first = await f.next(null);
    await f.publication().publish({ projectId: f.projectId, authority: first });
    const before = await readFile(authorityPath(f.root, f.projectId));
    const wiki = join(f.root, 'projects', f.projectId, 'wiki/buildlore-hierarchy/overview.md');
    const wikiBefore = await readFile(wiki);
    const second = await f.next(first);
    await expect(f.publication({ [hook]: () => { throw new Error('Injected boundary failure.'); } })
      .publish({ projectId: f.projectId, authority: second })).rejects.toThrow();
    expect(await readFile(authorityPath(f.root, f.projectId))).toEqual(before);
    expect(await readFile(wiki)).toEqual(wikiBefore);
    expect((await f.publication().publish({ projectId: f.projectId, authority: second })).materialization.state).toBe('ready');
    const current = await readApprovedWikiPublicationSnapshot(f.root, f.projectId);
    if (current.authority.schemaVersion !== 'buildlore.approved-wiki-authority.v3') throw new Error('Missing pointer authority.');
    expect(current.authority.knowledgeGeneration.history.generationCount).toBe('2');
  }, 60_000);

  it('keeps v2 active when archival is interrupted, then safely reuses the exact archive on retry', async () => {
    const f = await fixture();
    const first = await f.next(null, true);
    await f.publication().publish({ projectId: f.projectId, authority: first });
    const before = await readFile(authorityPath(f.root, f.projectId));
    const second = await f.next(first);
    await expect(f.publication({ afterLegacyArchive: () => { throw new Error('Injected archive interruption.'); } })
      .publish({ projectId: f.projectId, authority: second })).rejects.toThrow();
    expect(await readFile(authorityPath(f.root, f.projectId))).toEqual(before);
    expect((await f.publication().publish({ projectId: f.projectId, authority: second })).materialization.state).toBe('ready');
    expect((await readdir(join(f.root, 'projects', f.projectId, '.llmwiki/buildlore-hierarchy/archives'))).length).toBe(1);
  }, 60_000);

  it('checks single-candidate append binding and exact baseline record before any swap', async () => {
    const f = await fixture();
    const first = await f.next(null);
    await f.publication().publish({ projectId: f.projectId, authority: first });
    const second = await f.next(first);
    if (second.schemaVersion !== 'buildlore.approved-wiki-authority.v3') throw new Error('Missing pointer authority.');
    let reads = 0;
    const forbiddenStore = {
      verify: () => { reads += 1; return Promise.reject(new Error('Unexpected cross-project read.')); },
      stageAppend: () => Promise.reject(new Error('Unexpected stage.')),
      stageLegacy: () => Promise.reject(new Error('Unexpected migration.')),
    };
    await expect(prepareCurrentApprovedWikiPublication(second, 'another-project', f.root, forbiddenStore))
      .rejects.toMatchObject({ code: 'APPROVED_WIKI_PROJECTION_PROJECT_MISMATCH' });
    expect(reads).toBe(0);
    const append = createKnowledgeHistoryAppend(second);
    expect(() => verifyKnowledgeHistoryAppend(append, second)).not.toThrow();
    expect(() => verifyKnowledgeHistoryAppend({ ...append, baselineRecordDigest: digest('different') }, second)).toThrow();
    const path = authorityPath(f.root, f.projectId);
    const before = await readFile(path);
    await expect(f.publication().publish({ projectId: f.projectId,
      authority: { ...second, baselineRecordDigest: digest('different-record') } })).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    const store = createApprovedWikiProjectionStore(f.root, { beforeCommit: async () => {
      await writeFile(path, JSON.stringify(JSON.parse(await readFile(path, 'utf8')) as unknown, null, 4) + '\n');
    } });
    await expect(store.publish({ projectId: f.projectId, authority: second })).rejects.toThrow();
    expect((await readApprovedWikiPublicationSnapshot(f.root, f.projectId)).authority.state).toEqual(first.state);
  }, 60_000);

  it.each(['tamper', 'delete'] as const)('rejects older history %s on a warm publication cache without changing active output', async mutation => {
    const f = await fixture();
    const first = await f.next(null);
    await f.publication().publish({ projectId: f.projectId, authority: first });
    const second = await f.next(first);
    await f.publication().publish({ projectId: f.projectId, authority: second });
    const reader = createApprovedWikiPublicationReader(f.root);
    const current = await reader.read(f.projectId);
    if (current?.authority.schemaVersion !== 'buildlore.approved-wiki-authority.v3') throw new Error('Missing pointer authority.');
    const ref = current.authority.knowledgeGeneration.history;
    const path = join(f.root, 'projects', f.projectId, '.llmwiki/buildlore-hierarchy/knowledge-history/objects', `${ref.genesisGenerationDigest.slice(7)}.json`);
    const before = await lstat(path);
    const bytes = await readFile(path, 'utf8');
    const active = await readFile(authorityPath(f.root, f.projectId));
    if (mutation === 'delete') await unlink(path);
    else {
      await writeFile(path, bytes.replace('Fixed regression', 'False regression'));
      await utimes(path, before.atime, before.mtime);
      expect((await lstat(path)).size).toBe(before.size);
    }
    await expect(reader.read(f.projectId)).rejects.toThrow();
    expect(await readFile(authorityPath(f.root, f.projectId))).toEqual(active);
  }, 60_000);


});
