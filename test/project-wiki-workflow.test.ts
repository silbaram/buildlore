import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createKnowledgeWorkflowFixture, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { wikiDraft, wikiPurpose, wikiReview } from './helpers/project-wiki.js';
import { prepareVerifiedKnowledgeSession } from '../src/compiler/project-knowledge/planned-sources.js';
import { createKnowledgeWikiDraft } from '../src/compiler/project-knowledge/wiki-contracts.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { readApprovedWiki } from '../src/application/wiki-read-service.js';
import { record } from '../src/knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest } from '../src/knowledge/project-knowledge/types.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { matchPublishedShape } from './helpers/published-shape.js';
import { parseReadTool } from '../src/mcp/requests.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
describe('generic Wiki public workflow', () => {
  it.each([1, 4])('writes and activates %i arbitrary pages; all read surfaces retain unresolved status', async count => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true }); fixtures.push(f);
    await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: ['compile'] });
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const start = await f.cli(['compile', 'wiki', 'start', '--project', f.projectId, '--purpose', await f.json('purpose.json', wikiPurpose(f.projectId))]);
    expect(start, start.stderr).toMatchObject({ exitCode: 0, data: { phase: 'awaiting-draft' } });
    await matchPublishedShape(start.data, { $ref: 'project-wiki.schema.json#/$defs/status' });
    const run = String(start.data.runId), args = ['--project', f.projectId, '--run', run];
    const stage = (data: Readonly<Record<string, unknown>>) => String(record(data.stage).stageDigest);
    expect(await f.cli(['compile', 'wiki', 'status', ...args])).toEqual(start);
    const inspected = await f.cli(['compile', 'wiki', 'inspect', ...args, '--expect-stage', stage(start.data), '--input', await f.json('inspect.json', {
      schemaVersion: 'buildlore.wiki-inspection.v1', projectId: f.projectId, mode: 'evidence', offset: 0, limit: 1, maxBytes: 8192 })]);
    expect(inspected, inspected.stderr).toMatchObject({ exitCode: 0, data: { nextOffset: 1 } });
    await matchPublishedShape(inspected.data, { $ref: 'project-wiki.schema.json#/$defs/inspectionResult' });
    const base = (await prepareVerifiedKnowledgeSession({ ...f, outputLanguage: 'ko', rendererVersion: 'knowledge-markdown-v3', authoringMode: 'wiki-v1' })).session;
    const ids = Array.from({ length: count }, (_, i) => `policy-${i}`), draft = wikiDraft(base.exchange.snapshot, ids, true);
    // Distinct child evidence must contribute to the root's inherited search summaries.
    for (const [index, page] of draft.pages.entries()) {
      const evidence = base.exchange.snapshot.evidence[index % base.exchange.snapshot.evidence.length]!;
      page.sections[0]!.claims[0] = { ...page.sections[0]!.claims[0]!, text: evidence.excerpt, evidenceIds: [evidence.evidenceId] };
    }
    const submitted = await f.cli(['compile', 'wiki', 'submit', ...args, '--expect-stage', stage(start.data), '--input', await f.json('draft.json', draft)]);
    expect(submitted, submitted.stderr).toMatchObject({ exitCode: 0, data: { phase: 'awaiting-review' } });
    const proposal = createKnowledgeWikiDraft(draft, base.exchange.snapshot, null);
    const reviewFile = await f.json('review.json', wikiReview(proposal, run));
    expect(await f.cli(['compile', 'wiki', 'review', ...args, '--expect-stage', stage(start.data), '--input', reviewFile])).toMatchObject({ exitCode: 3 });
    const reviewed = await f.cli(['compile', 'wiki', 'review', ...args, '--expect-stage', stage(submitted.data), '--input', reviewFile]);
    expect(reviewed, reviewed.stderr).toMatchObject({ exitCode: 0, data: { phase: 'reviewed', stage: { assessment: 'needs-attention' } } });
    const finalized = await f.cli(['compile', 'wiki', 'finalize', ...args, '--expect-stage', stage(reviewed.data)]);
    expect(finalized, finalized.stderr).toMatchObject({ exitCode: 0, data: { phase: 'finalized' } });
    const approved = await f.cli(['compile', 'wiki', 'approve', ...args, '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
    expect(approved, approved.stderr).toMatchObject({ exitCode: 0, data: { phase: 'approved' } });
    const activated = await f.cli(approved.data.activationArgs as string[]);
    expect(activated, activated.stderr).toMatchObject({ exitCode: 0 });
    const directory = join(f.knowledgeRoot, 'projects', f.projectId, 'wiki/buildlore-hierarchy');
    expect((await readdir(directory)).sort()).toEqual([...ids.map(id => `${id}.md`), 'knowledge.json', 'evidence.json', 'manifest.json'].sort());
    const manifest = record(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    expect(manifest).toMatchObject({ schemaVersion: 'buildlore.hierarchical-markdown-materialization-manifest.v4', pageCount: count });
    await matchPublishedShape(JSON.parse(await readFile(join(directory, 'knowledge.json'), 'utf8')), { $ref: 'project-knowledge.schema.json#/$defs/recordsExportV2' });
    const reader = createKnowledgeWikiReader(f.knowledgeRoot), generation = String(finalized.data.generationDigest) as KnowledgeDigest;
    const first = await reader.list(f.projectId, { limit: 1 });
    expect(first).toMatchObject({ total: count, knowledgeReview: { status: 'needs-attention', openFindingCount: count } });
    if (count > 1) expect((await reader.list(f.projectId, { limit: 10, cursor: String(first?.cursor) }))?.pages).toHaveLength(count - 1);
    const page = await reader.read(f.projectId, ids[0]!);
    expect(page).toMatchObject({ knowledgeReview: { status: 'needs-attention' }, reviewFindings: { openFindingCount: count } });
    expect(page?.markdown).not.toContain('undocumented automatic');
    for (const value of [ids[0]!, `${ids[0]}.md`, `wiki/buildlore-hierarchy/${ids[0]}.md`]) {
      const request = parseReadTool('read', { page: value, expectedGeneration: generation });
      expect(request).not.toBeNull();
      expect((await readApprovedWiki(f.hubRoot, f.projectId, request!)).data).toMatchObject({ role: ids[0], knowledgeReview: { status: 'needs-attention' } });
    }
    for (const value of ['../escape', 'projects/other/wiki/policy-0.md', 'knowledge', 'manifest.md', 'evidence.json']) {
      expect(() => parseReadTool('read', { page: value, expectedGeneration: generation })).toThrow();
    }
    const requests = [
      reader.readContext(f.projectId, ids[0]!), reader.readPacket(f.projectId), reader.readMemory(f.projectId),
      reader.readTaskMemory(f.projectId, { task: 'delivery', maxBytes: 8192 }),
      reader.readProgressiveMemory(f.projectId, { task: 'delivery', maxBytes: 8192 }),
      reader.citations(f.projectId, ids[0]!), reader.search(f.projectId, 'delivery', 'lexical'),
      reader.lookup(f.projectId, generation, 'fact', proposal.facts[0]!.id),
      reader.lookupBatch(f.projectId, generation, 'fact', [proposal.facts[0]!.id]),
    ];
    const responses = await Promise.all(requests);
    for (const response of responses) expect(response).toMatchObject({ knowledgeReview: { status: 'needs-attention', openFindingCount: count } });
    for (const [index, name] of ['pageV2', 'packetV2', 'memoryV2', 'taskMemoryV2', 'progressiveMemoryV2', null, null, 'lookupV2', 'lookupBatchV2'].entries()) {
      if (name !== null) await matchPublishedShape(responses[index], { $ref: `project-knowledge-reader.schema.json#/$defs/${name}` });
    }
    const response = await readApprovedWiki(f.hubRoot, f.projectId, { operation: 'memory', task: 'delivery', maxBytes: 8192, progressive: true });
    expect(response.data).toMatchObject({ knowledgeReview: { status: 'needs-attention' } });
    expect(Buffer.byteLength(JSON.stringify(response.data) + '\n')).toBeLessThanOrEqual(8192);
  }, 60000);
});
