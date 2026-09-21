import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LONG_BODY, TAIL_FACT, longSourceFixture, storedSources } from './helpers/long-source.js';
import type { KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { runHubProjectSync } from '../src/projector/hub-sync.js';
import { ProjectSyncError } from '../src/projector/sync.js';
import { sourceChunkPayload } from '../src/projector/source-chunk-contract.js';
import { assertCompleteSourceChunks } from '../src/projector/source-chunks.js';
import { createSourceDocument, normalizeSourceBody, renderSourceDocument } from '../src/projector/source-document.js';
import { createSessionCompilePlanner } from '../src/compiler/session/source-planner.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { createProjectSecurityService } from '../src/sanitizer/index.js';
import { consumePreparedSource } from '../src/sanitizer/approval.js';

const fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
const failure = { fail(code: ConstructorParameters<typeof ProjectSyncError>[0],
  failedPhase: ConstructorParameters<typeof ProjectSyncError>[1]['failedPhase'],
  options: Partial<ConstructorParameters<typeof ProjectSyncError>[1]> = {}): never {
  throw new ProjectSyncError(code, { failedPhase, partial: false, recoveryAction: 'retry-sync', ...options });
} };

describe('long source synchronization', () => {
  it('collects the actual README without losing its sanitized tail', async () => {
    const body = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const f = await longSourceFixture(body); fixtures.push(f);
    await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: ['compile'], sourceSecretHandling: 'mask' });
    const synced = await f.cli(['sync', '--project', f.projectId]);
    expect(synced, synced.stderr).toMatchObject({ exitCode: 0 });
    const chunks = (await storedSources(f)).filter(s => s.document.buildlore.chunk !== undefined)
      .sort((a, b) => a.document.buildlore.chunk!.index - b.document.buildlore.chunk!.index);
    const first = chunks[0]!.document;
    const normalized = normalizeSourceBody(body);
    const screened = await createProjectSecurityService({ knowledgeRoot: f.knowledgeRoot, sourceIngestion: true }).prepareSource({
      body: normalized, bodyDigest: `sha256:${createHash('sha256').update(normalized).digest('hex')}`,
      projectId: f.projectId, source: first.buildlore.chunk!.parentSource,
      sourceKind: 'markdown', sourceRevisionOrContentSha256: first.buildlore.sourceRevision,
    });
    if (!screened.ok) throw new Error('README fixture security preparation failed.');
    const approved = consumePreparedSource(screened.prepared)!;
    const recovered = chunks.map(s => sourceChunkPayload(s.document.body, s.document.buildlore.chunk!)).join('');
    expect(recovered).toBe(normalizeSourceBody(approved.approvedBody));
    expect(Array.from(recovered).length).toBeGreaterThan(100_000);
    expect(recovered.endsWith(normalized.slice(-200))).toBe(true);
    const { plan } = await createSessionCompilePlanner(f).create(f.projectId);
    expect(plan.sources.some(s => s.sanitizedBody.includes(normalized.slice(-200)))).toBe(true);
  }, 30000);

  it('preserves full source and original tail position; resync is idempotent and shrinking removes only owned parts', async () => {
    const f = await longSourceFixture(); fixtures.push(f);
    const args = ['sync', '--project', f.projectId];
    expect(await f.cli([...args, '--dry-run'])).toMatchObject({ exitCode: 0 });
    expect(await storedSources(f)).toEqual([]);
    expect(await f.cli(args)).toMatchObject({ exitCode: 0 });
    const before = await storedSources(f);
    const chunks = before.filter(s => s.document.buildlore.chunk !== undefined)
      .sort((a, b) => a.document.buildlore.chunk!.index - b.document.buildlore.chunk!.index);
    expect(chunks).toHaveLength(2);
    expect(chunks.map(s => sourceChunkPayload(s.document.body, s.document.buildlore.chunk!)).join(''))
      .toBe(normalizeSourceBody(LONG_BODY));
    expect(chunks.at(-1)!.document.body).toContain(TAIL_FACT);
    // Reproduce the previously persisted v2/truncated input before upgrading.
    const first = chunks[0]!.document;
    const lines = normalizeSourceBody(LONG_BODY).split('\n');
    const range = { startLine: 1, startColumn: 1, endLine: lines.length,
      endColumn: Array.from(lines.at(-1) ?? '').length + 1 };
    const legacy = createSourceDocument({ body: LONG_BODY, descriptor: first.buildlore.descriptor!,
      ingestedAt: first.ingestedAt, originMappings: [{ canonical: range, origin: range }], producer: 'buildlore',
      projectId: f.projectId, source: first.source, sourceKind: 'markdown',
      sourceRevision: first.buildlore.sourceRevision, sourceType: 'file', title: first.title });
    expect(legacy.truncated).toBe(true);
    const sourcesRoot = join(f.knowledgeRoot, 'projects', f.projectId, 'sources');
    await writeFile(join(sourcesRoot, chunks[0]!.target), renderSourceDocument(legacy));
    for (const part of chunks.slice(1)) await unlink(join(sourcesRoot, part.target));
    expect(await f.cli(args)).toMatchObject({ exitCode: 0 });
    expect(await storedSources(f)).toEqual(before);
    expect(await f.cli(args)).toMatchObject({ exitCode: 0, data: { appliedCount: 0 } });
    const planner = createSessionCompilePlanner(f);
    const { plan } = await planner.create(f.projectId);
    const tail = plan.sources.flatMap(s => s.citationAnchors).find(a => a.quote === TAIL_FACT)!;
    expect(tail).toMatchObject({ originalFile: 'docs/long.md', originalLine: LONG_BODY.split('\n').indexOf(TAIL_FACT) + 1 });
    const unrelated = before.filter(s => s.document.buildlore.chunk === undefined);
    await writeFile(join(f.sourceRoot, 'docs/long.md'), '# Small\n\nThe archive remains available.\n');
    const preview = await f.cli([...args, '--dry-run']);
    expect(JSON.stringify(preview.data)).toContain('retired_source_chunk');
    expect(await storedSources(f)).toEqual(before);
    const shrunk = await f.cli(args);
    expect(shrunk, shrunk.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.stringify(shrunk.data)).toContain('"writeStatus":"remove"');
    const after = await storedSources(f);
    expect(after.filter(s => s.document.buildlore.chunk !== undefined)).toHaveLength(0);
    for (const source of unrelated) expect(after.find(s => s.target === source.target)).toEqual(source);
    expect(await f.cli(args)).toMatchObject({ exitCode: 0, data: { appliedCount: 0 } });
  }, 30000);

  it('checks tail credentials before writing any fragment and preserves explicit masking', async () => {
    const credential = ['sk-', 'A1b2C3d4E5f6G7h8J9k0', 'LmNoPqRs'].join('');
    const f = await longSourceFixture(`${LONG_BODY}\nAPI_KEY=${credential}\n`); fixtures.push(f);
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 3 });
    expect(await storedSources(f)).toEqual([]);
    await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: ['compile'], sourceSecretHandling: 'mask' });
    const synced = await f.cli(['sync', '--project', f.projectId]);
    expect(synced, synced.stderr).toMatchObject({ exitCode: 0 });
    const serialized = JSON.stringify(await storedSources(f));
    expect(serialized).not.toContain(credential);
    expect(serialized).toContain('<REDACTED:CREDENTIAL>');
    expect(serialized).toContain(TAIL_FACT);
    await expect(createSessionCompilePlanner(f).create(f.projectId)).resolves.toBeDefined();
  }, 30000);

  it('rejects an incomplete set and safely recovers after interrupted persistence', async () => {
    const f = await longSourceFixture(); fixtures.push(f);
    await expect(runHubProjectSync({ ...f, dryRun: false }, { failure,
      hooks: { afterSourceWrite: () => { throw new Error('simulated interruption'); } } }))
      .rejects.toMatchObject({ code: 'SYNC_APPLY_FAILED', partial: true });
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const chunks = (await storedSources(f)).filter(s => s.document.buildlore.chunk !== undefined);
    await unlink(join(f.knowledgeRoot, 'projects', f.projectId, 'sources', chunks[1]!.target));
    expect(() => assertCompleteSourceChunks(chunks.slice(0, 1).map(s => s.document))).toThrow();
    await expect(createSessionCompilePlanner(f).create(f.projectId)).rejects.toThrow();
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    await expect(createSessionCompilePlanner(f).create(f.projectId)).resolves.toBeDefined();
    // A crash after replacing the first part with a short source leaves old
    // siblings. The next sync must find them without relying on the first part.
    await writeFile(join(f.sourceRoot, 'docs/long.md'), '# Short\n\nShort source.\n');
    await expect(runHubProjectSync({ ...f, dryRun: false }, { failure, hooks: {
      afterSourceWrite: async () => {
        if ((await storedSources(f)).some(s => s.document.buildlore.descriptor?.sourceRef === 'docs/long.md' && !s.document.buildlore.chunk)) {
          throw new Error('simulated interruption after replacement');
        }
      },
    } })).rejects.toMatchObject({ partial: true });
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    expect((await storedSources(f)).filter(s => s.document.buildlore.chunk !== undefined)).toHaveLength(0);
  }, 30000);

  it('does not remove a fragment changed after the plan', async () => {
    const f = await longSourceFixture(); fixtures.push(f);
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const part = (await storedSources(f)).find(s => s.document.buildlore.chunk?.index === 2)!;
    const path = join(f.knowledgeRoot, 'projects', f.projectId, 'sources', part.target);
    const original = await readFile(path, 'utf8');
    await writeFile(join(f.sourceRoot, 'docs/long.md'), '# Short\n\nShort source.\n');
    await expect(runHubProjectSync({ ...f, dryRun: false }, { failure, hooks: {
      afterPlan: async () => { await writeFile(path, original + '\n'); },
    } })).rejects.toMatchObject({ code: 'SYNC_INPUT_DRIFT' });
    expect(await readFile(path, 'utf8')).toBe(original + '\n');
  }, 30000);
});
