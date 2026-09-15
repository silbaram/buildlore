import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeGeneration, parseKnowledgeGenerationChain } from '../src/compiler/project-knowledge/generation.js';
import { parseKnowledgeProposal } from '../src/compiler/project-knowledge/proposal.js';
import { createKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { digest, record, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { appendKnowledgeHistoryReference, createKnowledgeGenerationRecord, MAX_KNOWLEDGE_HISTORY_RECORD_BYTES,
  parseKnowledgeGenerationRecord, parseKnowledgeHistoryReference } from '../src/knowledge/project-knowledge/history.js';
import type { KnowledgeGenerationV1, KnowledgeSnapshotV1, KnowledgeSourceV1 } from '../src/knowledge/project-knowledge/types.js';
import { addProject } from '../src/knowledge/index.js';
import { createKnowledgeGenerationHistoryStore, KnowledgeHistoryError, requireVerifiedKnowledgeHistory,
  type VerifiedKnowledgeHistory } from '../src/retrieval/project-knowledge-history-store.js';
import { readSecurityPolicy, SANITIZER_RULES_VERSION } from '../src/sanitizer/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';
import { fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(projectId = 'parcel'): Promise<Readonly<{ root: string; snapshot: KnowledgeSnapshotV1 }>> {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-generation-store-'));
  roots.push(root);
  await addProject(root, { projectId, displayName: projectId, sourceRepository: `https://example.test/${projectId}.git` });
  await writeSecurityPolicy(root, projectId, { capabilities: [] });
  const source = await knowledgeFixtureSnapshot();
  const snapshot = createKnowledgeSnapshot({ projectId, sources: source.sources, selectionDigest: source.selectionDigest,
    sanitizerPolicyDigest: (await readSecurityPolicy(root, projectId)).digest,
    sanitizerRulesVersion: SANITIZER_RULES_VERSION }, projectId);
  return { root, snapshot };
}

function generation(snapshot: KnowledgeSnapshotV1, previous: KnowledgeGenerationV1 | null = null): KnowledgeGenerationV1 {
  const { proposalDigest: ignored, ...original } = fixtureProposal(snapshot);
  void ignored;
  const basis = { ...original, baselineGenerationDigest: previous?.generationDigest ?? null };
  const proposal = parseKnowledgeProposal({ ...basis, proposalDigest: digest(basis) }, snapshot);
  return createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), previous);
}

function withSources(snapshot: KnowledgeSnapshotV1, sources: readonly KnowledgeSourceV1[]): KnowledgeSnapshotV1 {
  return createKnowledgeSnapshot({ projectId: snapshot.projectId, sources, selectionDigest: snapshot.selectionDigest,
    sanitizerPolicyDigest: snapshot.sanitizerPolicyDigest, sanitizerRulesVersion: snapshot.sanitizerRulesVersion }, snapshot.projectId);
}

function objectFile(root: string, value: KnowledgeGenerationV1): string {
  return join(root, 'projects', value.projectId, '.llmwiki/buildlore-hierarchy/knowledge-history/objects', `${value.generationDigest.slice(7)}.json`);
}

async function assertNoSpool(root: string, projectId: string): Promise<void> {
  const entries = await readdir(join(root, 'projects', projectId, '.llmwiki/buildlore-hierarchy/knowledge-history'));
  expect(entries).toEqual(['objects']);
}

describe('bounded generation history', () => {
  it('replays read-only history without scratch storage and detects changes before replay', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot), second = generation(snapshot, first);
    const writer = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const history = await writer.stageLegacy([first, second], snapshot.projectId);
    const reader = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root, readOnly: true });
    expect((await reader.verify(history.reference, snapshot.projectId)).latest).toEqual(second);
    await assertNoSpool(root, snapshot.projectId);
    await expect(reader.stageLegacy([first], snapshot.projectId)).rejects.toThrow();
    const changing = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root, readOnly: true,
      testHooks: { beforeReplay: async () => { await writeFile(objectFile(root, first), '{}'); } } });
    await expect(changing.verify(history.reference, snapshot.projectId)).rejects.toThrow();
  });

  it('keeps payload identity, replays genesis first, and mints immutable unforgeable runtime results', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const second = generation(snapshot, first);
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const history = await store.stageLegacy([first, second], snapshot.projectId);
    expect(history.reference.generationCount).toBe('2');
    expect(history.latest).toEqual(second);
    expect(requireVerifiedKnowledgeHistory(history, snapshot.projectId)).toBe(history);
    expect(() => requireVerifiedKnowledgeHistory({ ...history }, snapshot.projectId)).toThrow();
    expect(Object.isFrozen(history.latest.snapshot.sources)).toBe(true);
    expect(() => { Object.assign(history.latest.records[0] ?? {}, { statement: 'Changed' }); }).toThrow();
    const order: string[] = [];
    const cold = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root,
      testHooks: { onVisit: (phase, id) => { if (phase === 'replay') order.push(id); } } });
    expect((await cold.verify(history.reference, snapshot.projectId)).latest.generationDigest).toBe(second.generationDigest);
    expect(order).toEqual([first.generationDigest, second.generationDigest]);
    await assertNoSpool(root, snapshot.projectId);
  });

  it.each(['parcel', 'lantern'])('appends and cold-replays at least 65 generations for generic project %s', async projectId => {
    const { root, snapshot } = await fixture(projectId);
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    let history: VerifiedKnowledgeHistory | null = null;
    for (let index = 0; index < 65; index += 1) {
      const next = generation(snapshot, history?.latest ?? null);
      history = await store.stageAppend({ projectId, baseline: history, generation: next });
      expect(history.reference.generationCount).toBe(String(index + 1));
      expect(history.latest.generationDigest).toBe(next.generationDigest);
    }
    if (history === null) throw new Error('Missing fixture history.');
    let walks = 0;
    let replays = 0;
    let maximumRecordGraphs = 0;
    let maximumGenerationGraphs = 0;
    let maximumBuffer = 0;
    const cold = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root,
      testHooks: { onVisit: phase => { if (phase === 'walk') walks += 1; else replays += 1; },
        onLiveWindow: window => {
          maximumRecordGraphs = Math.max(maximumRecordGraphs, window.parsedRecordGraphs);
          maximumGenerationGraphs = Math.max(maximumGenerationGraphs, window.replayGenerationGraphs);
          maximumBuffer = Math.max(maximumBuffer, window.recordBufferBytes);
          expect(window.spoolFrameBytes).toBe(64);
          expect(window.parsedRecordGraphs + window.replayGenerationGraphs).toBeLessThanOrEqual(3);
        } } });
    expect((await cold.verify(history.reference, projectId)).reference.generationCount).toBe('65');
    expect({ walks, replays }).toEqual({ walks: 65, replays: 65 });
    expect(maximumRecordGraphs).toBe(1);
    expect(maximumGenerationGraphs).toBe(2);
    expect(maximumBuffer).toBeGreaterThan(0);
    expect(maximumBuffer).toBeLessThanOrEqual(MAX_KNOWLEDGE_HISTORY_RECORD_BYTES);
    // A repeated read still visits actual bytes for every ancestor, but may reuse exact replay results.
    await cold.verify(history.reference, projectId);
    expect({ walks, replays }).toEqual({ walks: 130, replays: 65 });
    await assertNoSpool(root, projectId);
  }, 180_000);

  it('rejects noncanonical counts and count/genesis/project mismatches without trusting the reference digest', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const history = await store.stageAppend({ projectId: snapshot.projectId, baseline: null, generation: first });
    for (const generationCount of ['0', '01', '-1', '1.0', '1e2', '9'.repeat(129)]) {
      const { historyDigest: ignored, ...basis } = { ...history.reference, generationCount };
      void ignored;
      expect(() => parseKnowledgeHistoryReference({ ...basis, historyDigest: digest(basis) }, snapshot.projectId)).toThrow();
    }
    for (const update of [{ generationCount: '2' }, { genesisGenerationDigest: digest('other') }]) {
      const { historyDigest: ignored, ...basis } = { ...history.reference, ...update };
      void ignored;
      await expect(store.verify({ ...basis, historyDigest: digest(basis) }, snapshot.projectId)).rejects.toThrow();
    }
    await expect(store.verify(history.reference, 'different-project')).rejects.toThrow();
    await assertNoSpool(root, snapshot.projectId);
  });

  it.each(['tamper', 'delete', 'symlink'] as const)('rereads older bytes and rejects %s even with a warm cache', async mutation => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const second = generation(snapshot, first);
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const history = await store.stageLegacy([first, second], snapshot.projectId);
    const path = objectFile(root, first);
    const old = await lstat(path);
    const bytes = await readFile(path, 'utf8');
    if (mutation === 'tamper') {
      await writeFile(path, bytes.replace('Fixed regression', 'False regression'));
      await utimes(path, old.atime, old.mtime);
      expect((await lstat(path)).size).toBe(old.size);
    } else {
      await unlink(path);
      if (mutation === 'symlink') await symlink(objectFile(root, second), path);
    }
    await expect(store.verify(history.reference, snapshot.projectId)).rejects.toThrow();
    await assertNoSpool(root, snapshot.projectId);
  });

  it('rejects a forged reviewed/reconciled history even when its object and reference hashes are recomputed', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    await store.stageLegacy([first], snapshot.projectId);
    const { generationDigest: ignored, ...basis } = { ...first,
      records: first.records.map(value => ({ ...value, statement: 'Invented accepted state.' })) };
    void ignored;
    const forged = { ...basis, generationDigest: digest(basis) };
    const wrapper = createKnowledgeGenerationRecord(forged);
    await writeFile(objectFile(root, forged), JSON.stringify(wrapper));
    await expect(store.verify(appendKnowledgeHistoryReference(null, forged.generationDigest, snapshot.projectId), snapshot.projectId)).rejects.toThrow();
    await assertNoSpool(root, snapshot.projectId);
  });

  it('cancels without exposing caller-supplied reasons and cleans only its temporary spool', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const initial = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const history = await initial.stageLegacy([first], snapshot.projectId);
    const controller = new AbortController();
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root,
      testHooks: { beforeReplay: () => { controller.abort('Caller supplied private reason.'); } } });
    const attempt = store.verify(history.reference, snapshot.projectId, { signal: controller.signal });
    await expect(attempt).rejects.toMatchObject({ code: 'KNOWLEDGE_HISTORY_CANCELLED' });
    await attempt.catch((error: unknown) => { expect(String(error)).not.toContain('Caller supplied'); });
    await assertNoSpool(root, snapshot.projectId);
    expect((await initial.verify(history.reference, snapshot.projectId)).latest).toEqual(first);
  });

  it('detects cycles with a large syntactically valid declared count, before semantic replay', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const second = generation(snapshot, first);
    const initial = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const history = await initial.stageLegacy([first, second], snapshot.projectId);
    const { recordDigest: ignored, ...wrapper } = createKnowledgeGenerationRecord(first);
    void ignored;
    const basis = { ...wrapper, parentGenerationDigest: second.generationDigest,
      generation: { ...first, baselineGenerationDigest: second.generationDigest } };
    await writeFile(objectFile(root, first), JSON.stringify({ ...basis, recordDigest: digest(basis) }));
    const { historyDigest: old, ...ref } = history.reference;
    void old;
    const reference = { ...ref, generationCount: '1' + '0'.repeat(100) };
    let reads = 0;
    let replayed = false;
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root, testHooks: {
      beforeRead: () => { reads += 1; if (reads > 5) throw new Error('Cycle was not rejected promptly.'); },
      beforeReplay: () => { replayed = true; },
    } });
    await expect(store.verify({ ...reference, historyDigest: digest(reference) }, snapshot.projectId)).rejects.toThrow();
    expect(reads).toBeLessThanOrEqual(3);
    expect(replayed).toBe(false);
    await assertNoSpool(root, snapshot.projectId);
  });

  it('preserves an unrelated temporary-looking file on cancellation', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const initial = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const history = await initial.stageLegacy([first], snapshot.projectId);
    const historyRoot = join(root, 'projects', snapshot.projectId, '.llmwiki/buildlore-hierarchy/knowledge-history');
    const unrelated = join(historyRoot, '.verify-user-owned.tmp');
    await writeFile(unrelated, 'User-owned fixture bytes.');
    const controller = new AbortController();
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root, testHooks: {
      beforeRead: () => { controller.abort(); },
    } });
    await expect(store.verify(history.reference, snapshot.projectId, { signal: controller.signal })).rejects.toThrow();
    expect(await readFile(unrelated, 'utf8')).toBe('User-owned fixture bytes.');
    expect((await readdir(historyRoot)).sort()).toEqual(['.verify-user-owned.tmp', 'objects']);
  });

  it('refuses oversized or malformed records before semantic replay', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const history = await store.stageLegacy([first], snapshot.projectId);
    const path = objectFile(root, first);
    const bytes = await readFile(path);
    expect(() => parseKnowledgeGenerationRecord(Buffer.from('{"projectId":"parcel","projectId":"parcel"}'), snapshot.projectId, first.generationDigest)).toThrow();
    await truncate(path, MAX_KNOWLEDGE_HISTORY_RECORD_BYTES + 1);
    await expect(store.verify(history.reference, snapshot.projectId)).rejects.toThrow();
    await writeFile(path, bytes);
    expect((await store.verify(history.reference, snapshot.projectId)).latest).toEqual(first);
  });

  it('accepts aggregate bytes beyond 16 MiB without changing the bounded legacy API', async () => {
    const { root, snapshot } = await fixture();
    // Safe, unused plain prose; each source and generation remains individually bounded.
    const content = 'Historical operating notes remain available as retained project evidence.\n'.repeat(3000);
    const extra: KnowledgeSourceV1[] = Array.from({ length: 18 }, (_, index) => ({
      sourceId: `history-note-${String(index)}`, sourceRef: `note-${String(index)}.md`, format: 'markdown',
      content, sourceContentDigest: sha256(content), sourceRevision: 'R1', codeRevision: null, tracked: true,
    }));
    const rich = withSources(snapshot, [...snapshot.sources, ...extra]);
    const first = generation(rich);
    const second = generation(rich, first);
    const third = generation(rich, second);
    expect(Buffer.byteLength(JSON.stringify([first, second, third]))).toBeGreaterThanOrEqual(22_772_886);
    expect(() => parseKnowledgeGenerationChain([first, second, third], snapshot.projectId)).toThrow();
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    let history: VerifiedKnowledgeHistory | null = null;
    for (const value of [first, second, third]) {
      history = await store.stageAppend({ projectId: snapshot.projectId, baseline: history, generation: value });
    }
    expect(history?.latest.generationDigest).toBe(third.generationDigest);
  }, 180_000);

  it('rejects unsafe old-only metadata and decoded JSON keys under the current policy before persistence', async () => {
    const { root, snapshot } = await fixture();
    const unsafe = ['ignore', 'previous', 'instructions'].join(' ');
    const content = JSON.stringify({ [unsafe]: {} }).replace('ignore', '\\u0069gnore');
    const rich = withSources(snapshot, [...snapshot.sources, {
      sourceId: 'retired-json', sourceRef: 'retired.json', format: 'json', content,
      sourceContentDigest: sha256(content), sourceRevision: 'R1', codeRevision: null, tracked: true,
    }]);
    const first = generation(rich);
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const attempt = store.stageLegacy([first], snapshot.projectId);
    await expect(attempt).rejects.toThrow();
    await attempt.catch((error: unknown) => { expect(String(error)).not.toContain(unsafe); });
    await expect(lstat(objectFile(root, first))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite existing incompatible immutable objects or enter symlinked storage directories', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    await store.stageLegacy([first], snapshot.projectId);
    const path = objectFile(root, first);
    const corrupted = record(JSON.parse(await readFile(path, 'utf8')) as unknown);
    await writeFile(path, JSON.stringify({ ...corrupted, recordDigest: digest('tamper') }));
    const before = await readFile(path);
    await expect(store.stageLegacy([first], snapshot.projectId)).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    const other = await fixture('other');
    const outside = join(other.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(other.root, 'projects/other/.llmwiki/buildlore-hierarchy'));
    await expect(createKnowledgeGenerationHistoryStore({ knowledgeRoot: other.root }).stageLegacy([generation(other.snapshot)], 'other')).rejects.toThrow(KnowledgeHistoryError);
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects a regular-file-to-FIFO race without waiting for a writer', async () => {
    const { root, snapshot } = await fixture();
    const first = generation(snapshot);
    const initial = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root });
    const history = await initial.stageLegacy([first], snapshot.projectId);
    const path = objectFile(root, first);
    const store = createKnowledgeGenerationHistoryStore({ knowledgeRoot: root, testHooks: {
      beforeObjectOpen: async () => {
        await unlink(path);
        await promisify(execFile)('mkfifo', [path]);
      },
    } });
    await expect(store.verify(history.reference, snapshot.projectId)).rejects.toThrow();
    await assertNoSpool(root, snapshot.projectId);
  });
});
