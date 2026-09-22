import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createKnowledgeSnapshot, extractKnowledgeEvidence, parseKnowledgeSnapshot } from '../src/knowledge/project-knowledge/evidence.js';
import { boundedJson, digest, hash as parseDigest, record, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { normalizeResourceBudget, ResourceBudgetError } from '../src/knowledge/resource-budget.js';
import { mapCliError } from '../src/cli/error-map.js';
import type { KnowledgeSnapshotV1, KnowledgeSourceV1 } from '../src/knowledge/project-knowledge/types.js';
import { longSourceFixture, storedSources } from './helpers/long-source.js';
import { preparePlannedKnowledgeSession, prepareVerifiedKnowledgeSession } from '../src/compiler/project-knowledge/planned-sources.js';
import { prepareVerifiedSessionSources } from '../src/compiler/session/source-planner.js';
import { createKnowledgeWikiSession } from '../src/compiler/project-knowledge/wiki-session.js';
import { wikiPurpose, wikiDraft, wikiReview } from './helpers/project-wiki.js';
import { createKnowledgeWikiDraft } from '../src/compiler/project-knowledge/wiki-contracts.js';
import { matchPublishedShape } from './helpers/published-shape.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { createBuiltInSourceAdapterRegistry, createProjectSyncService, JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION,
  MAX_SOURCE_METADATA_BYTES, MAX_SOURCE_METADATA_DEPTH, MAX_SOURCE_METADATA_KEYS, registerJsonKnowledgeAdapter } from '../src/projector/index.js';
import type { RegisteredJsonKnowledgeAdapterV1 } from '../src/projector/json-knowledge-adapter.js';
import { parseSourceCollectionManifestV2 } from '../src/projector/source-manifest.js';
import { createProfileBindingV2 } from '../src/profile/index.js';
import { createProjectWikiWorkflow } from '../src/cli/project-wiki-workflow.js';
import { createHierarchicalWikiActivationService } from '../src/cli/hierarchical-activation.js';
import type { KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';

const hash = sha256('fixture');
const source = (sourceId: string, content: string): KnowledgeSourceV1 => ({ sourceId, sourceRef: `docs/${sourceId}.md`,
  sourceContentDigest: sha256(content), sourceRevision: null, codeRevision: null, tracked: false, format: 'markdown', content });
const input = (sources: readonly KnowledgeSourceV1[]) => ({ projectId: 'alpha', selectionDigest: hash,
  sanitizerPolicyDigest: hash, sanitizerRulesVersion: 'buildlore.sanitizer-rules.v9', sources });

it('distinguishes dense evidence and byte limits from malformed input, without source values', async () => {
  const dense = Array.from({ length: 2 }, (_, index) => source(`source-${index}`, 'Ordinary fixture paragraph.\n\n'.repeat(4100)));
  let error: unknown;
  try { createKnowledgeSnapshot(input(dense), 'alpha'); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ResourceBudgetError);
  const failure = mapCliError(error);
  expect(failure).toMatchObject({ exitCode: 3, errors: [{ code: 'RESOURCE_BUDGET_EXCEEDED' }],
    data: { stage: 'knowledge-snapshot', resource: 'evidence', observed: 8200, maximum: 8192 } });
  expect(JSON.stringify(failure)).not.toMatch(/Ordinary|docs\//u);
  await matchPublishedShape(failure.data, { $ref: 'resource-budget.schema.json' });
  expect(normalizeResourceBudget({ stage: 'knowledge-snapshot', resource: 'evidence', observed: 8200, maximum: 8192,
    source: 'private-name', get excerpt() { throw new Error('must not execute'); } })).toEqual(failure.data);
  expect(normalizeResourceBudget({ stage: 'private-name', resource: 'evidence', observed: 8200, maximum: 8192 })).toBeUndefined();
  expect(normalizeResourceBudget({ get stage() { throw new Error('must not execute'); } })).toBeUndefined();
  let byteError: unknown;
  try { boundedJson(Array.from({ length: 65 }, () => 'a'.repeat(262144))); } catch (caught) { byteError = caught; }
  expect(byteError).toMatchObject({ diagnostic: { resource: 'utf8-bytes', maximum: 16777216 } });
  expect(() => createKnowledgeSnapshot({ ...input([source('one', 'ordinary')]), extra: true }, 'alpha'))
    .toThrow(expect.objectContaining({ code: 'KNOWLEDGE_INVALID' }));
  expect(() => boundedJson({ get body() { throw new Error('must not execute'); } })).toThrow('Project knowledge contract is invalid.');
});

it('maps Unicode and CRLF code ranges, excludes wrappers and preserves legacy snapshot identities', () => {
  const legacy = source('code', '```ts\r\nconst 북 = "🧭";\r\n\r\nconst tail = 2;\r\n```');
  const mapped: KnowledgeSourceV1 = { ...legacy, originPolicy: 'projected-v1', originMappings: [{
    canonical: { startLine: 2, startColumn: 1, endLine: 4, endColumn: 16 },
    origin: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 16 },
  }] };
  const original = createKnowledgeSnapshot(input([legacy]), 'alpha');
  expect(parseKnowledgeSnapshot(original, 'alpha')).toEqual(original);
  const evidence = extractKnowledgeEvidence(mapped, 'alpha');
  expect(evidence.map(e => e.excerpt)).toEqual(['const 북 = "🧭";', 'const tail = 2;']);
  expect(evidence.map(e => e.origin?.range)).toEqual([
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: 15 },
    { startLine: 3, startColumn: 1, endLine: 3, endColumn: 16 },
  ]);
  const next = createKnowledgeSnapshot(input([mapped]), 'alpha');
  expect(parseKnowledgeSnapshot(next, 'alpha')).toEqual(next);
  expect(next.snapshotDigest).not.toBe(original.snapshotDigest);
  expect(() => createKnowledgeSnapshot(input([{ ...legacy, originMappings: mapped.originMappings! }]), 'alpha')).toThrow();
});

it('reuses the same admission checks for Wiki and keeps legacy JSON origins intact', async () => {
  const f = await longSourceFixture();
  try {
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const options = { ...f, outputLanguage: 'ko', rendererVersion: 'knowledge-markdown-v3' as const, authoringMode: 'wiki-v1' as const };
    const legacy = await preparePlannedKnowledgeSession(options), next = await prepareVerifiedKnowledgeSession(options);
    for (const original of legacy.session.exchange.snapshot.sources) {
      const matched = next.session.exchange.snapshot.sources.find(s => s.sourceId === original.sourceId)!;
      expect(matched.origins).toEqual(original.origins);
      expect(matched.content).toBe(original.content);
    }
    await writeFile(join(f.sourceRoot, 'docs/long.md'), '# Changed after sync\n\nOrdinary changed content.\n');
    await expect(prepareVerifiedSessionSources({ ...f, rejectCredentialFindings: true }, f.projectId))
      .rejects.toMatchObject({ code: 'SESSION_PLAN_DENIED', recoveryAction: 'sync' });
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    await expect(prepareVerifiedKnowledgeSession(options)).resolves.toBeDefined();
  } finally { await f.cleanup(); }
}, 60000);

async function activateSourceWiki(f: KnowledgeWorkflowFixture, snapshot: KnowledgeSnapshotV1, sourceRef: string,
  jsonKnowledgeAdapters: readonly RegisteredJsonKnowledgeAdapterV1[] = []): Promise<void> {
  const options = { ...f, jsonKnowledgeAdapters };
  const started = await createProjectWikiWorkflow(options).start(f.projectId, await f.json('purpose.json', wikiPurpose(f.projectId)));
  const workflow = createProjectWikiWorkflow(options);
  const resumed = await workflow.status(f.projectId, started.runId);
  const stage = (value: unknown) => parseDigest(record(record(value).stage).stageDigest);
  expect(stage(resumed)).toBe(stage(started));
  const evidence = snapshot.evidence.find(item => item.sourceRef === sourceRef);
  if (evidence === undefined) throw new Error('Missing regression evidence.');
  const draft = { ...wikiDraft(snapshot), rootPageId: 'source', pages: [{ id: 'source', title: 'Selected source',
    sections: [{ id: 'details', title: 'Source details', claims: [{ id: 'source-claim', text: evidence.excerpt,
      evidenceIds: [evidence.evidenceId] }] }] }] };
  const submitted = await workflow.submit(f.projectId, started.runId, await f.json('draft.json', draft), stage(resumed));
  const proposal = createKnowledgeWikiDraft(draft, snapshot, null);
  const reviewed = await workflow.review(f.projectId, started.runId,
    await f.json('review.json', wikiReview(proposal, started.runId)), stage(submitted));
  const finalized = await workflow.finalize(f.projectId, started.runId, stage(reviewed));
  const approved = await workflow.approve(f.projectId, started.runId, parseDigest(finalized.ledgerDigest), true);
  const inputFile = approved.activationArgs[approved.activationArgs.indexOf('--input') + 1];
  if (inputFile === undefined) throw new Error('Missing activation input.');
  const confirmationDigest = parseDigest(approved.activationArgs[approved.activationArgs.indexOf('--confirm-approval') + 1]);
  await expect(createHierarchicalWikiActivationService(options).activate({ projectId: f.projectId, inputFile, confirmationDigest }))
    .resolves.toMatchObject({ pageCount: 1, egress: 'none', providerUsed: 'none' });
  await expect(workflow.status(f.projectId, started.runId)).resolves.toMatchObject({ phase: 'approved', active: true });
}

it.each(['single line', 'Unicode CRLF'])('activates sanitized code with shorter canonical columns: %s', async (variant) => {
  const f = await longSourceFixture('# Ordinary handbook\n\nSafe information.\n');
  try {
    const lastLine = `const directory = "/${['home', 'example', 'ordinary', 'long', 'project', 'location'].join('/')}";`;
    const originalLines = variant === 'single line' ? [lastLine] : ['const 북 = "🧭";', `const 북쪽 = "🧭"; ${lastLine}`];
    const newline = variant === 'single line' ? '\n' : '\r\n';
    await mkdir(join(f.sourceRoot, 'src'));
    await writeFile(join(f.sourceRoot, 'src/example.ts'), `${originalLines.join(newline)}${newline}`);
    const path = join(f.sourceRoot, '.buildlore/sources.json');
    const manifest = parseSourceCollectionManifestV2(JSON.parse(await readFile(path, 'utf8')));
    await writeFile(path, serializeCanonicalJson(parseSourceCollectionManifestV2({ ...manifest, sources: [...manifest.sources,
      { adapterId: 'buildlore.generic', adapterVersion: 1, id: 'code', kind: 'code', path: 'src', pathType: 'directory', recursive: true }] })));
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const storedBefore = await storedSources(f);
    const options = { ...f, outputLanguage: 'ko', rendererVersion: 'knowledge-markdown-v3' as const, authoringMode: 'wiki-v1' as const };
    const legacy = await preparePlannedKnowledgeSession(options);
    const { session } = await prepareVerifiedKnowledgeSession(options);
    const snapshot = session.exchange.snapshot;
    const code = snapshot.sources.find(item => item.sourceRef === 'src/example.ts');
    const mapping = code?.originMappings?.[0];
    if (code === undefined || mapping === undefined) throw new Error('Missing code origin.');
    const lastOriginal = originalLines.at(-1);
    if (lastOriginal === undefined) throw new Error('Missing original code line.');
    const origin = { startLine: 1, startColumn: 1, endLine: originalLines.length, endColumn: Array.from(lastOriginal).length + 1 };
    const stored = storedBefore.find(item => item.document.buildlore.sourceKind === 'code');
    expect(stored?.document.buildlore.originMappings?.[0]?.canonical.endColumn).toBeGreaterThan(mapping.canonical.endColumn);
    expect(mapping.canonical).toEqual({ startLine: 2, startColumn: 1, endLine: originalLines.length + 1,
      endColumn: Array.from(code.content.split('\n')[originalLines.length] ?? '').length + 1 });
    expect(mapping.origin).toEqual(origin);
    expect(code.content).toContain('<HOME>');
    expect(code.content).toBe(legacy.session.exchange.snapshot.sources.find(item => item.sourceId === code.sourceId)?.content);
    const evidence = snapshot.evidence.filter(item => item.sourceId === code.sourceId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.origin?.range).toEqual(origin);
    expect(evidence[0]?.excerpt).not.toContain('```');
    expect(parseKnowledgeSnapshot(snapshot, f.projectId)).toEqual(snapshot);
    expect(() => createKnowledgeSnapshot({ ...input([{ ...code, originMappings: [{ ...mapping, canonical: {
      ...mapping.canonical, endColumn: mapping.canonical.endColumn + 1 } }] }]), projectId: f.projectId }, f.projectId))
      .toThrow(expect.objectContaining({ code: 'KNOWLEDGE_INVALID' }));
    await activateSourceWiki(f, snapshot, code.sourceRef);
    expect(await storedSources(f)).toEqual(storedBefore);
    expect((await preparePlannedKnowledgeSession(options)).plan).toEqual(legacy.plan);
  } finally { await f.cleanup(); }
}, 60000);

it('activates disjoint JSON column origins on one line using the legacy first origin', async () => {
  const registered = registerJsonKnowledgeAdapter({ contractVersion: JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION,
    registration: { adapterId: 'example.inline', adapterVersion: 1, kinds: [{ kind: 'json', mediaTypes: ['application/json'] }],
      limits: { maxMetadataBytes: MAX_SOURCE_METADATA_BYTES, maxMetadataDepth: MAX_SOURCE_METADATA_DEPTH, maxMetadataKeys: MAX_SOURCE_METADATA_KEYS },
      metadataNamespace: 'example.inline', metadataSchemaVersion: 'example.inline-metadata.v1' },
    project() { return [{ logicalId: 'inline-values', title: 'Inline values', body: 'left | right', inputSourceRefs: ['inline.json'], origins: [
      { canonical: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 }, jsonPointer: '/first', sourceRef: 'inline.json' },
      { canonical: { startLine: 1, startColumn: 8, endLine: 1, endColumn: 13 }, jsonPointer: '/second', sourceRef: 'inline.json' },
    ] }]; } });
  const f = await longSourceFixture('# Ordinary handbook\n\nSafe information.\n');
  try {
    await writeFile(join(f.sourceRoot, 'inline.json'), JSON.stringify({ first: 'left', second: 'right' }));
    const path = join(f.sourceRoot, '.buildlore/sources.json');
    const registry = createBuiltInSourceAdapterRegistry({ registrations: [registered] });
    const manifest = parseSourceCollectionManifestV2(JSON.parse(await readFile(path, 'utf8')), registry);
    await writeFile(path, serializeCanonicalJson(parseSourceCollectionManifestV2({ ...manifest, sources: [...manifest.sources,
      { adapterId: 'example.inline', adapterVersion: 1, id: 'inline', kind: 'json', path: 'inline.json', pathType: 'file' }] }, registry)));
    await writeFile(join(f.knowledgeRoot, 'projects', f.projectId, 'profile-binding.json'),
      serializeCanonicalJson(createProfileBindingV2('general', 'en', [registered])));
    await createProjectSyncService({ jsonKnowledgeAdapters: [registered] }).sync({ dryRun: false, hubRoot: f.hubRoot, projectId: f.projectId });
    const storedBefore = await storedSources(f);
    const options = { ...f, jsonKnowledgeAdapters: [registered], outputLanguage: 'ko',
      rendererVersion: 'knowledge-markdown-v3' as const, authoringMode: 'wiki-v1' as const };
    const legacy = await preparePlannedKnowledgeSession(options);
    const { session } = await prepareVerifiedKnowledgeSession(options);
    const snapshot = session.exchange.snapshot;
    const projected = snapshot.sources.find(item => item.sourceRef === 'inline.json');
    if (projected === undefined) throw new Error('Missing JSON source.');
    expect(projected.content).toBe('left | right\n');
    expect(projected.origins).toHaveLength(1);
    expect(projected.origins?.[0]).toMatchObject({ projectedLine: 1, sourceRef: 'inline.json', jsonPointer: '/first' });
    expect(projected.origins).toEqual(legacy.session.exchange.snapshot.sources.find(item => item.sourceId === projected.sourceId)?.origins);
    expect(snapshot.evidence.filter(item => item.sourceId === projected.sourceId)).toEqual(
      legacy.session.exchange.snapshot.evidence.filter(item => item.sourceId === projected.sourceId));
    expect(parseKnowledgeSnapshot(snapshot, f.projectId)).toEqual(snapshot);
    expect(() => createKnowledgeSnapshot({ ...input([{ ...projected, origins: [
      ...(projected.origins ?? []), ...(projected.origins ?? []),
    ] }]), projectId: f.projectId }, f.projectId)).toThrow(expect.objectContaining({ code: 'KNOWLEDGE_INVALID' }));
    await activateSourceWiki(f, snapshot, projected.sourceRef, [registered]);
    expect(await storedSources(f)).toEqual(storedBefore);
    expect((await preparePlannedKnowledgeSession(options)).plan).toEqual(legacy.plan);
  } finally { await f.cleanup(); }
}, 60000);

it('resumes, reviews and activates a persisted v1 Wiki run using its original evidence identity', async () => {
  const f = await longSourceFixture('# Prior handbook\n\nAn ordinary previously selected rule.\n');
  try {
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const purpose = wikiPurpose(f.projectId);
    const start = await f.cli(['compile', 'wiki', 'start', '--project', f.projectId, '--purpose', await f.json('purpose.json', purpose)]);
    expect(start, start.stderr).toMatchObject({ exitCode: 0 });
    const runId = String(start.data.runId), args = ['--project', f.projectId, '--run', runId];
    const { session: legacy } = await preparePlannedKnowledgeSession({ ...f, outputLanguage: 'ko', rendererVersion: 'knowledge-markdown-v3', authoringMode: 'wiki-v1' });
    const session = await createKnowledgeWikiSession(legacy, purpose, runId);
    const path = join(f.hubRoot, '.buildlore/hierarchy-runs', f.projectId, runId, 'run.json');
    const stored = record(JSON.parse(await readFile(path, 'utf8')));
    const { recordDigest: _, ...rest } = stored; void _;
    const basis = { ...rest, schemaVersion: 'buildlore.wiki-workflow-run.v1', state: session.state() };
    await writeFile(path, JSON.stringify({ ...basis, recordDigest: digest(basis) }));
    const status = await f.cli(['compile', 'wiki', 'status', ...args]);
    expect(status, status.stderr).toMatchObject({ exitCode: 0 });
    const stage = (data: Readonly<Record<string, unknown>>) => String(record(data.stage).stageDigest);
    const draft = wikiDraft(legacy.exchange.snapshot);
    const submitted = await f.cli(['compile', 'wiki', 'submit', ...args, '--expect-stage', stage(status.data), '--input', await f.json('draft.json', draft)]);
    expect(submitted, submitted.stderr).toMatchObject({ exitCode: 0 });
    const proposal = createKnowledgeWikiDraft(draft, legacy.exchange.snapshot, null);
    const reviewed = await f.cli(['compile', 'wiki', 'review', ...args, '--expect-stage', stage(submitted.data), '--input', await f.json('review.json', wikiReview(proposal, runId))]);
    expect(reviewed, reviewed.stderr).toMatchObject({ exitCode: 0 });
    const finalized = await f.cli(['compile', 'wiki', 'finalize', ...args, '--expect-stage', stage(reviewed.data)]);
    expect(finalized, finalized.stderr).toMatchObject({ exitCode: 0 });
    const approved = await f.cli(['compile', 'wiki', 'approve', ...args, '--expect-ledger', String(finalized.data.ledgerDigest), '--confirm-approval']);
    expect(approved, approved.stderr).toMatchObject({ exitCode: 0 });
    expect(await f.cli(approved.data.activationArgs as string[])).toMatchObject({ exitCode: 0 });
  } finally { await f.cleanup(); }
}, 60000);
