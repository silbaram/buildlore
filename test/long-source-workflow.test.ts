import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { LONG_BODY, TAIL_FACT, longSourceFixture, storedSources } from './helpers/long-source.js';
import type { KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { wikiDraft, wikiPurpose, wikiReview } from './helpers/project-wiki.js';
import { preparePlannedKnowledgeSession } from '../src/compiler/project-knowledge/planned-sources.js';
import { createKnowledgeWikiDraft } from '../src/compiler/project-knowledge/wiki-contracts.js';
import { record } from '../src/knowledge/project-knowledge/guards.js';
import { connectProject } from '../src/connection/service.js';
import { runMcp } from '../src/mcp/run.js';
import { matchPublishedShape } from './helpers/published-shape.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { knowledgeEvidenceContentKind } from '../src/compiler/project-knowledge/citation-support.js';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });

describe('long sources through Wiki and MCP', () => {
  it('uses tail evidence with original locations, then reads the approved Wiki through the real MCP transport', async () => {
    const f = await longSourceFixture(); fixtures.push(f);
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const start = await f.cli(['compile', 'wiki', 'start', '--project', f.projectId,
      '--purpose', await f.json('purpose.json', wikiPurpose(f.projectId))]);
    expect(start, start.stderr).toMatchObject({ exitCode: 0, data: { phase: 'awaiting-draft' } });
    const runId = String(start.data.runId), args = ['--project', f.projectId, '--run', runId];
    const stage = (value: Readonly<Record<string, unknown>>) => String(record(value.stage).stageDigest);
    const { session, plan } = await preparePlannedKnowledgeSession({ ...f, outputLanguage: 'ko',
      rendererVersion: 'knowledge-markdown-v3', authoringMode: 'wiki-v1' });
    const snapshot = session.exchange.snapshot;
    const jsonSource = snapshot.sources.find(source => (source.origins?.length ?? 0) > 0)!;
    const originalOrigin = jsonSource.origins![0]!;
    expect(() => createKnowledgeSnapshot({ projectId: f.projectId, selectionDigest: snapshot.selectionDigest,
      sanitizerPolicyDigest: snapshot.sanitizerPolicyDigest, sanitizerRulesVersion: snapshot.sanitizerRulesVersion,
      sources: snapshot.sources.map(source => source !== jsonSource ? source : { ...source, origins: [{
        projectedLine: originalOrigin.projectedLine, sourceRef: originalOrigin.sourceRef, range: originalOrigin.range,
      }] }),
    }, f.projectId)).toThrow();
    const tail = snapshot.evidence.find(e => e.excerpt === TAIL_FACT)!;
    expect(tail).toMatchObject({ sourceRef: 'docs/long.md', origin: {
      sourceRef: 'docs/long.md', range: { startLine: LONG_BODY.split('\n').indexOf(TAIL_FACT) + 1 },
    } });
    expect(knowledgeEvidenceContentKind({ ...tail, excerpt: '42' })).toBe('text');
    await matchPublishedShape(snapshot, { $ref: 'project-knowledge.schema.json#/$defs/snapshot' });
    await matchPublishedShape(plan, { $ref: 'compile-plan.schema.json' });
    for (const source of await storedSources(f)) {
      if (source.document.buildlore.chunk !== undefined) {
        await matchPublishedShape(source.document, { $ref: 'source-document-v4.schema.json' });
      }
    }
    const draft = wikiDraft(snapshot, ['archive']);
    draft.pages[0]!.title = 'Archive rules';
    draft.pages[0]!.sections[0]!.title = 'Final archive rule';
    draft.pages[0]!.sections[0]!.claims = [{ id: 'tail-rule', text: TAIL_FACT, evidenceIds: [tail.evidenceId] }];
    const submitted = await f.cli(['compile', 'wiki', 'submit', ...args, '--expect-stage', stage(start.data),
      '--input', await f.json('draft.json', draft)]);
    expect(submitted, submitted.stderr).toMatchObject({ exitCode: 0, data: { phase: 'awaiting-review' } });
    const proposal = createKnowledgeWikiDraft(draft, snapshot, null);
    const reviewed = await f.cli(['compile', 'wiki', 'review', ...args, '--expect-stage', stage(submitted.data),
      '--input', await f.json('review.json', wikiReview(proposal, runId))]);
    expect(reviewed, reviewed.stderr).toMatchObject({ exitCode: 0, data: { phase: 'reviewed' } });
    const finalized = await f.cli(['compile', 'wiki', 'finalize', ...args, '--expect-stage', stage(reviewed.data)]);
    expect(finalized, finalized.stderr).toMatchObject({ exitCode: 0, data: { phase: 'finalized' } });
    const approved = await f.cli(['compile', 'wiki', 'approve', ...args,
      '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
    expect(approved, approved.stderr).toMatchObject({ exitCode: 0 });
    expect(await f.cli(approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
    const wikiPath = join(f.knowledgeRoot, 'projects', f.projectId, 'wiki/buildlore-hierarchy/archive.md');
    const wiki = await readFile(wikiPath, 'utf8');
    expect(wiki).toContain(TAIL_FACT);
    expect(wiki).toContain(`lines ${String(tail.origin!.range.startLine)}-${String(tail.origin!.range.endLine)}`);
    const packet = await createKnowledgeWikiReader(f.knowledgeRoot).readPacket(f.projectId);
    expect(JSON.stringify(packet)).toContain(JSON.stringify(['lines', tail.origin!.range.startLine, tail.origin!.range.endLine]));
    const configDir = join(f.root, 'client-config');
    await connectProject(f.sourceRoot, { workspace: f.hubRoot, projectId: f.projectId,
      sourceRepository: `https://example.test/${f.projectId}.git` }, { configDir });
    const input = new PassThrough(), output = new PassThrough();
    let buffered = '', diagnostics = '';
    const messages: Record<string, unknown>[] = [];
    output.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let end: number;
      while ((end = buffered.indexOf('\n')) >= 0) {
        messages.push(record(JSON.parse(buffered.slice(0, end)))); buffered = buffered.slice(end + 1);
      }
    });
    const done = runMcp(['--project-dir', f.sourceRoot, '--read-only'], input, output,
      text => { diagnostics += text; }, { configDir });
    let sequence = 0;
    const request = async (method: string, params: object) => {
      const id = ++sequence; input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      await expect.poll(() => messages.find(m => m.id === id), { timeout: 15000 }).toBeDefined();
      return record(messages.find(m => m.id === id)!.result);
    };
    try {
      await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'long-source-test', version: '1' } });
      input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const searched = await request('tools/call', { name: 'search', arguments: { query: 'violet compass' } });
      expect(searched.isError).not.toBe(true);
      expect(JSON.stringify(searched)).toContain('archive');
      const read = await request('tools/call', { name: 'read', arguments: { page: 'archive', expectedGeneration: finalized.data.generationDigest } });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read)).toContain(TAIL_FACT);
      // Source resync cannot rewrite a previously approved Wiki or its authority.
      await writeFile(join(f.sourceRoot, 'docs/long.md'), '# Short\n\nChanged source.\n');
      expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      expect(await readFile(wikiPath, 'utf8')).toBe(wiki);
      const preserved = await request('tools/call', { name: 'read', arguments: { page: 'archive', expectedGeneration: finalized.data.generationDigest } });
      expect(preserved).toEqual(read);
    } finally {
      input.end(); expect(await done).toBe(0); expect(diagnostics).toBe('');
    }
  }, 120000);

  it('admits a raw file larger than the persisted per-fragment byte limit', async () => {
    const body = `# Large archive\n\n${('Ordinary archive paragraph. '.repeat(10) + '\n\n').repeat(2200)}## Tail\n\n${TAIL_FACT}\n`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(524288);
    const f = await longSourceFixture(body); fixtures.push(f);
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const { session } = await preparePlannedKnowledgeSession({ ...f, authoringMode: 'wiki-v1', rendererVersion: 'knowledge-markdown-v3' });
    expect(session.exchange.snapshot.evidence.some(e => e.excerpt === TAIL_FACT)).toBe(true);
    expect(session.exchange.snapshot.sources.filter(s => s.chunk !== undefined).length).toBeGreaterThan(5);
  }, 60000);
});
