import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { wikiLargeCorpusFixture } from './helpers/wiki-large-corpus.js';
import { storedSources, TAIL_FACT } from './helpers/long-source.js';
import { wikiDraft, wikiPurpose, wikiReview } from './helpers/project-wiki.js';
import { prepareVerifiedKnowledgeSession } from '../src/compiler/project-knowledge/planned-sources.js';
import { createSessionCompilePlanner, prepareVerifiedSessionSources } from '../src/compiler/session/source-planner.js';
import { createKnowledgeWikiDraft } from '../src/compiler/project-knowledge/wiki-contracts.js';
import { record } from '../src/knowledge/project-knowledge/guards.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { createKnowledgeGenerationHistoryStore } from '../src/retrieval/project-knowledge-history-store.js';
import { createApprovedWikiProjectionStore } from '../src/retrieval/approved-corpus-store.js';
import { latestKnowledgeGeneration } from '../src/retrieval/project-knowledge-authority.js';
import { matchPublishedShape } from './helpers/published-shape.js';

it('takes the issue #54 corpus through inspection, review, history and activation without losing evidence', async () => {
  const f = await wikiLargeCorpusFixture();
  const metrics: object[] = [];
  const suiteStarted = performance.now();
  const timed = async <T>(phase: string, action: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const result = await action();
    const measurement = { phase, elapsedMs: Math.round(performance.now() - started), peakRssKiB: process.resourceUsage().maxRSS };
    metrics.push(measurement);

    return result;
  };
  try {
    expect(await timed('sync', () => f.cli(['sync', '--project', f.projectId]))).toMatchObject({ exitCode: 0 });
    const stored = await storedSources(f);
    expect(stored).toHaveLength(339);
    const bodyBytes = stored.reduce((total, source) => total + Buffer.byteLength(source.document.body), 0);
    expect(bodyBytes).toBeGreaterThan(4_000_000);
    const options = { ...f, rejectCredentialFindings: true };
    await expect(timed('legacy-plan-rejection', () => createSessionCompilePlanner(options).create(f.projectId)))
      .rejects.toMatchObject({ code: 'SESSION_PLAN_DENIED', resourceBudget: { stage: 'legacy-session-sources', maximum: 33554432 } });
    const verified = await timed('verified-sources', () => prepareVerifiedSessionSources(options, f.projectId));
    expect(verified.sources).toHaveLength(stored.length);
    expect(verified.sources.reduce((total, source) => total + Buffer.byteLength(source.sanitizedBody), 0)).toBe(bodyBytes);
    const purposeFile = await f.json('purpose.json', wikiPurpose(f.projectId));
    const start = await timed('start', () => f.cli(['compile', 'wiki', 'start', '--project', f.projectId, '--purpose', purposeFile]));
    expect(start, start.stderr).toMatchObject({ exitCode: 0, data: { phase: 'awaiting-draft' } });
    const args = ['--project', f.projectId, '--run', String(start.data.runId)];
    const stage = (data: Readonly<Record<string, unknown>>) => String(record(data.stage).stageDigest);
    const { session } = await timed('snapshot', () => prepareVerifiedKnowledgeSession({ ...f, outputLanguage: 'ko',
      rendererVersion: 'knowledge-markdown-v3', authoringMode: 'wiki-v1' }));
    const snapshot = session.exchange.snapshot;
    expect(snapshot.sources).toHaveLength(339);
    expect(new Set(snapshot.evidence.map(e => e.sourceId)).size).toBe(339);
    const tail = snapshot.evidence.find(e => e.excerpt === TAIL_FACT)!;
    const code = snapshot.evidence.find(e => e.sourceRef === 'src/module-0.ts' && e.excerpt.startsWith('export const item000'))!;
    const json = snapshot.evidence.find(e => e.origin?.jsonPointer !== undefined)!;
    expect(code.origin?.range).toEqual({ startLine: 1, startColumn: 1, endLine: 16, endColumn: 49 });
    expect(code.excerpt).not.toContain('```');
    expect(json.origin?.sourceRef).toBe(json.sourceRef);
    expect(tail.origin?.range.startLine).toBeGreaterThan(3000);
    await matchPublishedShape(snapshot, { $ref: 'project-knowledge.schema.json#/$defs/snapshot' });
    const inspectedFile = await f.json('inspect.json', { schemaVersion: 'buildlore.wiki-inspection.v1', projectId: f.projectId,
      mode: 'evidence', offset: snapshot.evidence.length - 2, limit: 2, maxBytes: 32768 });
    const inspected = await timed('inspect', () => f.cli(['compile', 'wiki', 'inspect', ...args,
      '--expect-stage', stage(start.data), '--input', inspectedFile]));
    expect(inspected, inspected.stderr).toMatchObject({ exitCode: 0 });
    expect(Buffer.byteLength(JSON.stringify(inspected.data))).toBeLessThanOrEqual(32768);
    const draft = wikiDraft(snapshot, ['archive']);
    draft.pages[0]!.sections[0]!.claims = [tail, code, json].map((e, i) => ({
      id: `source-${i}`, text: e.excerpt, evidenceIds: [e.evidenceId],
    }));
    const draftFile = await f.json('draft.json', draft);
    const submitted = await timed('submit', () => f.cli(['compile', 'wiki', 'submit', ...args,
      '--expect-stage', stage(start.data), '--input', draftFile]));
    expect(submitted, submitted.stderr).toMatchObject({ exitCode: 0 });
    const proposal = createKnowledgeWikiDraft(draft, snapshot, null);
    const reviewFile = await f.json('review.json', wikiReview(proposal, String(start.data.runId)));
    const reviewed = await timed('review', () => f.cli(['compile', 'wiki', 'review', ...args,
      '--expect-stage', stage(submitted.data), '--input', reviewFile]));
    expect(reviewed, reviewed.stderr).toMatchObject({ exitCode: 0 });
    const finalized = await timed('finalize', () => f.cli(['compile', 'wiki', 'finalize', ...args, '--expect-stage', stage(reviewed.data)]));
    expect(finalized, finalized.stderr).toMatchObject({ exitCode: 0 });
    const approved = await timed('approve', () => f.cli(['compile', 'wiki', 'approve', ...args,
      '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']));
    expect(approved, approved.stderr).toMatchObject({ exitCode: 0 });
    const activated = await timed('activate', () => f.cli(approved.data.activationArgs as string[]));
    expect(activated, activated.stderr).toMatchObject({ exitCode: 0 });
    const authority = await createApprovedWikiProjectionStore(f.knowledgeRoot).readAuthority(f.projectId);
    const generation = latestKnowledgeGeneration(authority.knowledgeGeneration!);
    expect(generation.snapshot.snapshotDigest).toBe(snapshot.snapshotDigest);
    expect(generation.snapshot.evidence).toEqual(snapshot.evidence);
    const history = createKnowledgeGenerationHistoryStore({ knowledgeRoot: f.knowledgeRoot });
    const extension = authority.knowledgeGeneration;
    expect(extension?.schemaVersion).toBe('buildlore.knowledge-authority-extension.v2');
    if (extension?.schemaVersion === 'buildlore.knowledge-authority-extension.v2') {
      await timed('history-replay', () => history.verify(extension.history, f.projectId));
    }
    const pagePath = join(f.knowledgeRoot, 'projects', f.projectId, 'wiki/buildlore-hierarchy/archive.md');
    const before = await readFile(pagePath, 'utf8');
    expect(before).toContain(TAIL_FACT);
    const reader = createKnowledgeWikiReader(f.knowledgeRoot);
    expect(await timed('read', () => reader.read(f.projectId, 'archive'))).not.toBeNull();
    await writeFile(join(f.sourceRoot, 'src/module-0.ts'), "export const changed = 'ordinary update';\n");
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    expect(await readFile(pagePath, 'utf8')).toBe(before);
    // A resource rejection must leave the active Wiki and authority usable.
    await writeFile(join(f.sourceRoot, 'docs/dense.md'), 'Ordinary dense evidence paragraph.\n\n'.repeat(4100));
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const rejected = await timed('dense-rejection', () => f.cli(['compile', 'wiki', 'start', '--project', f.projectId, '--purpose', purposeFile]));
    expect(rejected.exitCode).toBe(3);
    expect(record(JSON.parse(rejected.stderr))).toMatchObject({ errors: [{ code: 'RESOURCE_BUDGET_EXCEEDED' }],
      data: { stage: 'knowledge-snapshot', resource: 'evidence', maximum: 8192 } });
    expect(await readFile(pagePath, 'utf8')).toBe(before);
    expect(await reader.read(f.projectId, 'archive')).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(verified.sources))).toBeLessThan(8 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(16 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(generation))).toBeLessThan(16 * 1024 * 1024);
    // Vitest's isolated fork owns this peak; generous regression ceilings allow CI variation.
    expect(process.resourceUsage().maxRSS).toBeLessThan(2 * 1024 * 1024);
    expect(performance.now() - suiteStarted).toBeLessThan(600000);
    metrics.push({ storedSources: stored.length, bodyBytes, verifiedSourceBytes: Buffer.byteLength(JSON.stringify(verified.sources)),
      snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)), evidenceCount: snapshot.evidence.length,
      generationBytes: Buffer.byteLength(JSON.stringify(generation)) });
    const report = JSON.stringify({ issue: 54, node: process.version, elapsedMs: Math.round(performance.now() - suiteStarted),
      peakRssKiB: process.resourceUsage().maxRSS, limits: { peakRssKiB: 2097152, elapsedMs: 600000 },
      recipe: '332 code files x 256 lines, blanks every 16, plus Markdown/JSON/chunked tail', metrics }, null, 2) + '\n';
    const reportPath = process.env.BUILDLORE_WIKI_BENCHMARK_REPORT;
    if (reportPath !== undefined) await writeFile(reportPath, report);
  } finally { await f.cleanup(); }
}, 600000);
