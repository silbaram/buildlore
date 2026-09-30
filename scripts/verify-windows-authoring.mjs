import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { inspectArchive, packLocal } from './pack-local.mjs';

const exec = promisify(execFile);
/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @returns {string} */
function string(value) { assert.equal(typeof value, 'string'); return /** @type {string} */ (value); }
/** @param {string} value @returns {Record<string, unknown>} */
function parse(value) { return object(/** @type {unknown} */ (JSON.parse(value))); }

// This command must never turn a Linux/WSL protocol check into Windows evidence.
assert.equal(process.platform, 'win32', 'Native Windows is required; Linux/WSL is not Windows verification.');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node.js 24+ is required.');
const npm = process.env.npm_execpath;
assert(npm, 'Run through npm@11.19.0.');
assert.equal((await exec(process.execPath, [npm, '--version'])).stdout.trim(), '11.19.0');
const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === '--archive', 'Usage: verify:windows-authoring [--archive <tgz>]');
const repo = resolve(import.meta.dirname, '..');
const root = await realpath(await mkdtemp(join(tmpdir(), 'buildlore Windows authoring ')));
/** @type {string[]} */
const stages = [];
let stage = 'archive';
try {
  const suppliedArchive = join(root, 'candidate.tgz');
  // Inspect and install the same private copy even if the caller replaces its archive.
  if (args.length !== 0) await copyFile(resolve(args[1]), suppliedArchive);
  const archive = args.length === 0 ? await packLocal(repo, root, npm) : await inspectArchive(repo, suppliedArchive);
  const archivePath = args.length === 0 ? join(root, archive.filename) : suppliedArchive;
  const workspace = join(root, 'Knowledge with spaces'), source = join(root, 'Source with spaces');
  const config = join(root, 'client settings'), projectId = 'windows-fixture';
  /** @param {string} cwd @param {...string} arguments_ */
  const git = async (cwd, ...arguments_) => exec('git', ['-c', 'user.name=BuildLore Fixture',
    '-c', 'user.email=fixture@example.invalid', ...arguments_], { cwd });
  stage = 'install';
  const origin = join(root, 'knowledge.git');
  await git(root, 'init', '--bare', '--initial-branch=main', origin);
  await git(root, 'clone', origin, workspace);
  await exec(process.execPath, [npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--save-exact', archivePath], { cwd: workspace, maxBuffer: 8 * 1024 * 1024 });
  const binary = join(workspace, 'node_modules/buildlore/dist/cli/bin.js');
  const env = { ...process.env, BUILDLORE_CONFIG_DIR: config };
  /** @param {string[]} arguments_ @param {string} [expectedError] */
  async function cli(arguments_, expectedError) {
    const ok = expectedError === undefined;
    let stdout, stderr;
    let status = 0;
    try {
      const result = await exec(process.execPath, [binary, ...arguments_, '--json'], { cwd: workspace, env, maxBuffer: 8 * 1024 * 1024 });
      stdout = result.stdout; stderr = result.stderr;
    } catch (error) {
      const failed = object(error);
      assert.equal(typeof failed.code, 'number', 'CLI must start before its result can be checked.');
      status = /** @type {number} */ (failed.code);
      stdout = string(failed.stdout); stderr = string(failed.stderr);
    }
    const envelope = parse(stdout || stderr);
    assert.equal(status === 0, ok, `Unexpected command outcome at ${stage}.`);
    assert.equal(envelope.ok, ok);
    if (!ok) {
      assert(Array.isArray(envelope.errors));
      assert.deepEqual(envelope.errors.map(error => object(error).code), [expectedError]);
    }
    return object(envelope.data ?? {});
  }
  const metadata = parse(await readFile(join(workspace, 'node_modules/buildlore/package.json'), 'utf8'));
  assert.equal((await exec(process.execPath, [binary, '--version'], { cwd: workspace })).stdout.trim(), `buildlore ${string(metadata.version)}`);
  stages.push(stage);
  stage = 'hierarchical-store-persistence';
  /** @type {typeof import('../src/cli/hierarchical-run-store.js')} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Inspected installed archive; this private API is used only by the persistence fixture.
  const persistence = await import(pathToFileURL(join(workspace, 'node_modules/buildlore/dist/cli/hierarchical-run-store.js')).href);
  /** @type {typeof import('../src/compiler/index.js')} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Installed implementation creates the fixture's actual purpose digest.
  const compiler = await import(pathToFileURL(join(workspace, 'node_modules/buildlore/dist/compiler/index.js')).href);
  const storeRoot = join(root, 'Isolated persistence fixture'); await mkdir(storeRoot);
  const fixtureDigest = /** @type {`sha256:${string}`} */ (`sha256:${'1'.repeat(64)}`);
  /** @type {import('../src/cli/hierarchical-run-store.js').CreateHierarchicalWorkflowRunRecordInputV1} */
  const basis = { projectId, runId: `run-${'2'.repeat(64)}`, revision: 0, phase: 'awaiting-proposal',
    purpose: compiler.createCompilationPurpose({ projectId, audience: ['Maintainers'], goals: ['Verify state persistence'],
      keyQuestions: ['Can a run resume?'], scopeHints: ['Fixture state'], excludedTopics: [], outputLanguage: 'en', requestedPageRoles: ['overview'] }),
    baselineAuthorityDigest: null, baselineState: null, baselineProposals: [],
    startDigests: { baselineGenerationDigest: null, graphDigest: fixtureDigest, outlineDigest: fixtureDigest,
      planDigest: fixtureDigest, planningInventoryDigest: fixtureDigest, sanitizerPolicyDigest: fixtureDigest, snapshotDigest: fixtureDigest },
    submissions: [], resubmissions: [], childDecisions: [], integratedDecisions: [], relationDecisions: [],
    rejection: null, approvalDecision: null, pendingExchangeDigest: null, pendingChildReviewDigest: null,
    pendingReviewDigest: null, pendingLedgerDigest: null };
  const initial = persistence.createHierarchicalWorkflowRunRecord(basis);
  const store = persistence.createHierarchicalWorkflowRunStore(storeRoot);
  await store.create(initial);
  assert.deepEqual(await persistence.createHierarchicalWorkflowRunStore(storeRoot).read(projectId, initial.runId), initial);
  const next = persistence.createHierarchicalWorkflowRunRecord({ ...basis, revision: 1 });
  const update = { projectId, runId: initial.runId, expectedRevision: 0, expectedRecordDigest: initial.recordDigest, next };
  await store.replace(update);
  await assert.rejects(store.replace(update), { code: 'HIERARCHICAL_WORKFLOW_RUN_CONFLICT' });
  assert.deepEqual(await store.read(projectId, initial.runId), next); stages.push(stage);
  stage = 'state-locks-and-tampering';
  const stateDirectory = join(storeRoot, '.buildlore/hierarchy-runs', projectId, initial.runId);
  const statePath = join(stateDirectory, 'run.json'), lockPath = join(stateDirectory, 'run.lock');
  const nextRevision = persistence.createHierarchicalWorkflowRunRecord({ ...basis, revision: 2 });
  const replacement = { ...update, expectedRevision: 1, expectedRecordDigest: next.recordDigest, next: nextRevision };
  for (const host of [hostname(), 'foreign-fixture-host']) {
    const owner = JSON.stringify({ schemaVersion: 'buildlore.hierarchical-workflow-run-lock.v1',
      hostname: host, pid: process.pid, token: '3'.repeat(64) }, null, 2) + '\n';
    await writeFile(lockPath, owner, { mode: 0o600, flag: 'wx' });
    await assert.rejects(store.replace(replacement), { code: 'HIERARCHICAL_WORKFLOW_RUN_BUSY' });
    assert.equal(await readFile(lockPath, 'utf8'), owner);
    assert.deepEqual(await store.read(projectId, initial.runId), next); await unlink(lockPath);
  }
  const deadPid = Number((await exec(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])).stdout);
  assert(Number.isSafeInteger(deadPid) && deadPid > 0);
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  await writeFile(lockPath, JSON.stringify({ schemaVersion: 'buildlore.hierarchical-workflow-run-lock.v1',
    hostname: hostname(), pid: deadPid, token: '4'.repeat(64) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await store.replace(replacement);
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
  assert.deepEqual(await store.read(projectId, initial.runId), nextRevision);
  const savedState = await readFile(statePath);
  await writeFile(statePath, JSON.stringify({ ...nextRevision, revision: 3 }));
  try { await assert.rejects(store.read(projectId, initial.runId), { code: 'HIERARCHICAL_WORKFLOW_RUN_INVALID' }); }
  finally { await writeFile(statePath, savedState); }
  const projectDirectory = join(storeRoot, '.buildlore/hierarchy-runs', projectId), redirected = join(storeRoot, 'redirected project');
  await rename(projectDirectory, redirected);
  try {
    await symlink(redirected, projectDirectory, 'junction');
    try { await assert.rejects(store.read(projectId, initial.runId), { code: 'HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED' }); }
    finally { await unlink(projectDirectory); }
  } finally { await rename(redirected, projectDirectory); }
  assert.deepEqual(await store.read(projectId, initial.runId), nextRevision); stages.push(stage);
  stage = 'initialize-and-register';
  /** @type {typeof import('../src/projector/source-manifest.js')} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Installed parser produces the canonical public fixture declaration.
  const sourceContracts = await import(pathToFileURL(join(workspace, 'node_modules/buildlore/dist/projector/source-manifest.js')).href);
  /** @type {typeof import('../src/sanitizer/policy.js')} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Installed serializer produces the explicit public fixture policy.
  const policyContracts = await import(pathToFileURL(join(workspace, 'node_modules/buildlore/dist/sanitizer/policy.js')).href);
  assert.equal((await cli(['workspace', 'init', '--knowledge-repo', '../knowledge.git'])).outcome, 'created');
  await mkdir(join(source, 'docs'), { recursive: true });
  await writeFile(join(source, 'docs/README.md'), '# Delivery operations\n\nDelivery instructions use SQLite to record delivery status locally. Maintainers inspect delivery history before approving a new delivery. The delivery log stays inside this project.\n');
  await mkdir(join(source, '.buildlore'), { mode: 0o700 });
  await writeFile(join(source, '.buildlore/sources.json'), JSON.stringify(sourceContracts.parseSourceCollectionManifestV2({
    schemaVersion: 'buildlore.sources.v2', projectId, sourceRepository: 'https://example.test/windows-fixture.git', sources: [],
  }), null, 2) + '\n', { mode: 0o600 });
  await git(source, 'init', '--initial-branch=main'); await git(source, 'add', '.'); await git(source, 'commit', '-m', 'public fixture sources');
  await cli(['project', 'add', '--id', projectId, '--source-repo', 'https://example.test/windows-fixture.git', '--source-root', source]);
  await cli(['source', 'add', '--project', projectId, '--id', 'docs', '--kind', 'markdown', '--path', 'docs']);
  await git(source, 'add', '.'); await git(source, 'commit', '-m', 'declared fixture sources');
  await writeFile(join(workspace, 'projects', projectId, 'security-policy.json'), policyContracts.serializeSecurityPolicy(policyContracts.parseSecurityPolicy({
    schemaVersion: 'buildlore.security-policy.v1', projectId, defaultClassification: 'public', classificationRules: [],
    egressRules: ['compile', 'context', 'eval-full', 'query', 'search'].map(capability => ({ capability, allowedClassifications: ['internal', 'public'] })), overrides: [],
  }, projectId)));
  stages.push(stage);
  stage = 'sync'; await cli(['sync', '--project', projectId]); stages.push(stage);
  const inputs = join(workspace, '.buildlore/knowledge-inputs'); await mkdir(inputs, { recursive: true, mode: 0o700 });
  /** @param {string} name @param {unknown} value */
  async function input(name, value) { await writeFile(join(inputs, name), JSON.stringify(value), { mode: 0o600 }); return `.buildlore/knowledge-inputs/${name}`; }
  const purpose = await input('purpose.json', { schemaVersion: 'buildlore.wiki-purpose.v1', projectId,
    outputLanguage: 'en', goal: 'Explain delivery operations from the selected documents.', audience: 'Maintainers', template: 'general' });
  stage = 'start-and-resume';
  const started = await cli(['compile', 'wiki', 'start', '--project', projectId, '--purpose', purpose]);
  assert.equal(started.phase, 'awaiting-draft');
  const runId = string(started.runId), runArgs = ['--project', projectId, '--run', runId];
  assert.deepEqual(await cli(['compile', 'wiki', 'status', ...runArgs]), started); // A new CLI process restores persisted state.
  stages.push(stage);
  /** @param {Record<string, unknown>} value */
  const digest = value => string(object(value.stage).stageDigest);
  /** @param {string} mode @param {string} stageDigest */
  async function inspect(mode, stageDigest) {
    return cli(['compile', 'wiki', 'inspect', ...runArgs, '--expect-stage', stageDigest, '--input',
      await input(`${mode}.json`, { schemaVersion: 'buildlore.wiki-inspection.v1', projectId, mode,
        offset: 0, limit: 128, maxBytes: 131072 })]);
  }
  stage = 'readonly-state';
  const runPath = join(workspace, '.buildlore/hierarchy-runs', projectId, runId, 'run.json');
  const extraLink = join(workspace, '.buildlore/hierarchy-runs', projectId, runId, 'extra.json');
  await link(runPath, extraLink);
  try { await cli(['compile', 'wiki', 'status', ...runArgs], 'HIERARCHICAL_WORKFLOW_RUN_INVALID'); }
  finally { await unlink(extraLink); }
  await chmod(runPath, 0o444);
  try { await cli(['compile', 'wiki', 'status', ...runArgs], 'HIERARCHICAL_WORKFLOW_RUN_INVALID'); }
  finally { await chmod(runPath, 0o600); }
  assert.deepEqual(await cli(['compile', 'wiki', 'status', ...runArgs]), started); stages.push(stage);
  stage = 'draft';
  const inspected = await inspect('evidence', digest(started));
  assert(Array.isArray(inspected.items) && inspected.items.length > 0 && inspected.nextOffset === null);
  const evidence = object(inspected.items.find(value => string(object(value).excerpt).length > 80) ?? inspected.items[0]);
  const evidenceId = string(evidence.evidenceId);
  const submitted = await cli(['compile', 'wiki', 'submit', ...runArgs, '--expect-stage', digest(started), '--input',
    await input('draft.json', { schemaVersion: 'buildlore.wiki-draft.v1', projectId,
      actor: { sessionId: 'fixture-author', model: 'fixed-protocol-fixture', kind: 'agent' }, rootPageId: 'delivery',
      pages: [{ id: 'delivery', title: 'Delivery operations', sections: [{ id: 'instructions', title: 'Delivery instructions',
        claims: [{ id: 'delivery-instructions', text: string(evidence.excerpt), evidenceIds: [evidenceId] }] }] }] })]);
  assert.equal(submitted.phase, 'awaiting-review'); stages.push(stage);
  stage = 'review';
  const targets = await inspect('targets', digest(submitted)); assert(Array.isArray(targets.items) && targets.nextOffset === null);
  const reviewed = await cli(['compile', 'wiki', 'review', ...runArgs, '--expect-stage', digest(submitted), '--input',
    await input('review.json', { schemaVersion: 'buildlore.wiki-review.v1', projectId, runId,
      proposalDigest: string(object(submitted.stage).proposalDigest), snapshotDigest: string(inspected.snapshotDigest),
      reviewer: { sessionId: 'fixture-reviewer', model: 'fixed-protocol-fixture', kind: 'agent' },
      judgments: targets.items.map(targetId => ({ targetId: string(targetId), verdict: 'supported', evidenceIds: [evidenceId],
        rationale: 'Fixed protocol judgment; no real AI quality evaluation.' })), findings: [], baselineReview: null,
      usable: true, rationale: 'The fixed delivery statement is supported by the fixture document.' })]);
  assert.equal(reviewed.phase, 'reviewed'); stages.push(stage);
  stage = 'finalize-and-explicit-test-approval';
  const finalized = await cli(['compile', 'wiki', 'finalize', ...runArgs, '--expect-stage', digest(reviewed)]);
  assert.equal(finalized.phase, 'finalized');
  const beforeApproval = await cli(['compile', 'wiki', 'status', ...runArgs]);
  const beforeApprovalState = await readFile(runPath);
  await cli(['compile', 'wiki', 'approve', ...runArgs, '--expect-ledger', string(finalized.ledgerDigest)], 'CLI_OPTION_MISSING');
  assert.deepEqual(await readFile(runPath), beforeApprovalState);
  assert.deepEqual(await cli(['compile', 'wiki', 'status', ...runArgs]), beforeApproval);
  const approved = await cli(['compile', 'wiki', 'approve', ...runArgs, '--expect-ledger', string(finalized.ledgerDigest), '--confirm-approval']);
  assert.equal(approved.phase, 'approved'); stages.push(stage);
  stage = 'activate-and-connect';
  assert(Array.isArray(approved.activationArgs)); await cli(approved.activationArgs.map(string));
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'approved fixture Wiki');
  await cli(['workspace', 'connect', '--project', projectId, '--client', 'codex', '--apply']); stages.push(stage);
  stage = 'mcp-search-and-read';
  const child = spawn(process.execPath, [binary, 'mcp', '--project-dir', source, '--read-only'], { cwd: source, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  /** @type {Map<number, {resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void}>} */
  const pending = new Map(); let nextId = 0;
  /** @param {Error} error */
  const rejectPending = error => { for (const request of pending.values()) request.reject(error); };
  const closed = new Promise(resolve => { child.once('close', resolve); child.once('error', () => resolve(-1)); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const result = parse(line); if (typeof result.id === 'number') pending.get(result.id)?.resolve(result); }
    catch { rejectPending(new Error('Invalid MCP response.')); }
  });
  child.on('error', rejectPending);
  child.stdin.on('error', rejectPending);
  child.on('close', () => rejectPending(new Error('MCP exited before replying.')));
  /** @param {string} method @param {object} [params] @returns {Promise<Record<string, unknown>>} */
  async function request(method, params = {}) {
    const id = ++nextId;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      /** @type {Promise<Record<string, unknown>>} */
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error('MCP request timed out.')), 30000);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      return await response;
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  try {
    const initialized = object(await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'windows-authoring-verifier', version: '1' } }));
    assert.equal(object(object(initialized.result).serverInfo).version, metadata.version);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const available = object(object(await request('tools/list')).result);
    assert(Array.isArray(available.tools));
    const definitions = /** @type {unknown[]} */ (available.tools);
    for (const name of ['status', 'list', 'search', 'read']) {
      const definition = definitions.find(value => object(value).name === name);
      assert.equal(object(object(definition).annotations).readOnlyHint, true);
    }
    /** @param {string} name @param {object} [arguments_] @param {boolean} [ok] */
    async function tool(name, arguments_ = {}, ok = true) {
      const message = object(await request('tools/call', { name, arguments: arguments_ }));
      const result = object(message.result); assert.equal(result.isError === true, !ok);
      const envelope = object(result.structuredContent);
      assert.equal(envelope.ok, ok); assert.equal(envelope.projectId, projectId);
      return envelope;
    }
    const status = await tool('status'); assert.equal(object(status.data).projectId, projectId);
    assert.equal(object(status.data).readable, true); assert.equal(object(status.data).dirty, 'clean');
    const generation = string(object(status.data).generation); assert.equal(generation, finalized.generationDigest);
    const listed = await tool('list', { expectedGeneration: generation });
    assert.equal(object(listed.readContext).generation, generation);
    const listedPages = object(listed.data).pages;
    assert(Array.isArray(listedPages));
    const deliveryPage = object(listedPages.find(value => object(value).role === 'delivery'));
    const deliveryPageId = string(deliveryPage.pageId);
    const searched = await tool('search', { query: 'SQLite', expectedGeneration: generation });
    assert(Array.isArray(object(searched.data).hits) && object(searched.data).hits.length > 0);
    assert.equal(object(searched.readContext).generation, generation);
    const page = await tool('read', { page: 'delivery', expectedGeneration: generation });
    assert.equal(object(page.readContext).generation, generation);
    assert.equal(object(page.data).pageId, deliveryPageId);
    assert.equal(object(page.data).role, 'delivery');
    assert(string(object(page.data).markdown).trim().length > 0);
    const stale = await tool('read', { page: 'delivery', expectedGeneration: `sha256:${'f'.repeat(64)}` }, false);
    assert(Array.isArray(stale.errors)); assert.equal(object(stale.errors[0]).code, 'GENERATION_CHANGED');
    const wrongProject = await tool('list', { projectId: 'different-project' }, false);
    assert(Array.isArray(wrongProject.errors)); assert.equal(object(wrongProject.errors[0]).code, 'CLI_ARGUMENT_INVALID');
  } finally {
    child.stdin.end(); const timer = setTimeout(() => child.kill(), 5000);
    try { assert.equal(await closed, 0); } finally { clearTimeout(timer); lines.close(); }
  }
  stages.push(stage);
  process.stdout.write(JSON.stringify({ platform: process.platform, node: process.version, npm: '11.19.0',
    archiveSha256: archive.sha256, stages, passed: true, published: false, aiQuality: 'not evaluated',
    isolation: 'temporary repositories and client configuration; no OS network/read-only mount proof' }) + '\n');
} catch {
  process.stderr.write(JSON.stringify({ platform: process.platform, stages, failedStage: stage, passed: false }) + '\n');
  process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
