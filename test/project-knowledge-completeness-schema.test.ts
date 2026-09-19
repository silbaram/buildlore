import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { compiler } from '../src/index.js';
import { parseCliArguments } from '../src/cli/parser.js';
import { record } from '../src/knowledge/project-knowledge/guards.js';
import { parseJsonStrict } from '../src/knowledge/strict-json.js';
import { createKnowledgeWorkflowFixture, type KnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { completenessFixture, completenessMappingFixture, completenessReviewFixture } from './helpers/project-knowledge-completeness.js';
import { captureKnowledgeCompletenessSession } from '../src/compiler/project-knowledge/completeness-session.js';
import { fixtureReview } from './helpers/project-knowledge-fixture.js';
import { mapCliError } from '../src/cli/error-map.js';

const execute = promisify(execFile), roots: string[] = [], fixtures: KnowledgeWorkflowFixture[] = [];
afterEach(async () => { await Promise.all([...roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  ...fixtures.splice(0).map(f => f.cleanup())]); });
const schemaName = 'project-knowledge-completeness.schema.json';
const schema = async (file = schemaName) => record(parseJsonStrict(await readFile(join(process.cwd(), 'schemas', file), 'utf8')));

describe('published completeness contracts and public SDK', () => {
  it('resolves references, keeps nested objects closed, and adds v4 without changing legacy definitions', async () => {
    const documents = new Map<string, Readonly<Record<string, unknown>>>(), visited = new Set<string>();
    const get = async (file: string) => { if (!documents.has(file)) documents.set(file, await schema(file)); return documents.get(file) ?? record(null); };
    const walk = async (value: unknown, file: string): Promise<void> => {
      if (Array.isArray(value)) { for (const item of value as unknown[]) await walk(item, file); return; }
      if (value === null || typeof value !== 'object') return;
      const r = record(value);
      if (r.type === 'object') expect(r.additionalProperties).toBe(false);
      if (typeof r.$ref === 'string') {
        const [name, fragment = ''] = r.$ref.split('#'), targetFile = name || file, identity = `${targetFile}#${fragment}`;
        let target: unknown = await get(targetFile);
        for (const key of fragment.split('/').slice(1)) target = record(target)[key.replaceAll('~1', '/').replaceAll('~0', '~')];
        expect(target, identity).toBeDefined();
        if (!visited.has(identity)) { visited.add(identity); await walk(target, targetFile); }
      }
      for (const child of Object.values(r)) await walk(child, file);
    };
    await walk(await get(schemaName), schemaName);
    const workflow = await schema('project-knowledge-workflow.schema.json'), defs = record(workflow.$defs);
    expect(record(record(defs.status).properties).stage).toBeUndefined();
    expect(record(record(defs.run).properties).state).toBeUndefined();
    expect((workflow.oneOf as unknown[]).slice(0, 3)).toEqual(['purpose', 'run', 'status'].map(name => ({ $ref: `${schemaName}#/$defs/${name}` })));
  });

  it('matches emitted artifacts, role projections and the final replayable state to the published closed shapes', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json'); fixtures.push(f);
    expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
    const { session } = await compiler.preparePlannedKnowledgeCompletenessSession({ hubRoot: f.hubRoot, knowledgeRoot: f.knowledgeRoot,
      projectId: f.projectId, runId: `run-${'0123456789abcdef'.repeat(4)}`, authoringQuestions: (['overview', 'architecture', 'decisions'] as const).map(role => ({
        id: role, role, question: `Explain ${role}.`, requirements: [{ id: 'source', sourceRef: `docs/${role === 'overview' ? 'README.md' : role === 'architecture' ? 'architecture.md' : 'decision.md'}`,
          jsonPointer: null, contentKind: 'text' as const }] })) });
    const exchange = session.exchange, inputs = completenessFixture(exchange);
    const stage = async (role: compiler.CompletenessRole) => (await session.status(role)).stageViewDigest;
    await session.submitShadowInventory(inputs.shadow, await stage('completeness-reviewer'));
    await session.submitAuthorInventory(inputs.author, await stage('author'));
    await session.submitInventoryReview(inputs.review, await stage('completeness-reviewer'));
    const accepted = (await captureKnowledgeCompletenessSession(session)).state.acceptedInventory;
    if (!accepted) throw new Error('Missing accepted inventory.');
    const mapping = completenessMappingFixture(exchange, accepted, inputs.proposal), submission = {
      schemaVersion: 'buildlore.knowledge-completeness-prose-submission.v1', projectId: f.projectId, runId: exchange.runId,
      proposal: inputs.proposal, mapping, attempt: 1, correctionOfReviewRoundDigest: null };
    await session.submitProse(submission, await stage('author'));
    const omission = completenessReviewFixture(exchange, accepted, mapping);
    await session.submitCompletenessReview(omission, await stage('completeness-reviewer'));
    await session.submitSourceReview(fixtureReview(inputs.proposal), await stage('source-reviewer'));
    const view = await session.status('author'), round = (await captureKnowledgeCompletenessSession(session)).state.attempts[0]?.reviewRound;
    if (!round) throw new Error('Missing independent review round.');
    const final = { schemaVersion: 'buildlore.knowledge-completeness-finalize-input.v1', projectId: f.projectId, runId: exchange.runId,
      proposalDigest: round.proposalDigest, mappingDigest: round.mappingDigest, completenessReviewDigest: round.completenessReviewDigest,
      semanticReviewDigest: round.semanticReviewDigest, reviewViewDigest: view.stageViewDigest };
    const generation = await session.finalize(final, view.stageViewDigest);
    const state = (await captureKnowledgeCompletenessSession(session)).state, document = await schema();
    // Shape parity, reference traversal and numeric/list limits supplement the
    // runtime semantic/security tests; this is not a JSON Schema implementation.
    const match = async (value: unknown, shapeValue: unknown, file = schemaName): Promise<void> => {
      const shape = record(shapeValue);
      if (typeof shape.$ref === 'string') {
        const [name, fragment = ''] = shape.$ref.split('#');
        let target: unknown = await schema(name || file);
        for (const key of fragment.split('/').slice(1)) target = record(target)[key];
        await match(value, target, name || file); return;
      }
      if (Array.isArray(shape.oneOf)) {
        let valid = 0;
        for (const alternative of shape.oneOf as unknown[]) { try { await match(value, alternative, file); valid++; } catch { /* Next closed branch. */ } }
        expect(valid).toBe(1); return;
      }
      if (Object.hasOwn(shape, 'const')) expect(value).toEqual(shape.const);
      if (Array.isArray(shape.enum)) expect(shape.enum).toContainEqual(value);
      if (typeof shape.type === 'string' && !['object', 'array', 'integer', 'null'].includes(shape.type)) {
        expect(typeof value).toBe(shape.type);
      }
      if (Array.isArray(shape.type)) expect(shape.type).toContain(value === null ? 'null' : typeof value);
      if (typeof value === 'string' && typeof shape.pattern === 'string') expect(value).toMatch(new RegExp(shape.pattern, 'u'));
      if (shape.type === 'null') { expect(value).toBeNull(); return; }
      if (shape.type === 'object') {
        const r = record(value), props = record(shape.properties);
        for (const key of shape.required as string[]) expect(Object.hasOwn(r, key)).toBe(true);
        for (const [key, child] of Object.entries(r)) { expect(Object.hasOwn(props, key)).toBe(true); await match(child, props[key], file); }
      }
      if (shape.type === 'array') {
        expect(Array.isArray(value)).toBe(true); const items = value as unknown[];
        if (typeof shape.minItems === 'number') expect(items.length).toBeGreaterThanOrEqual(shape.minItems);
        if (typeof shape.maxItems === 'number') expect(items.length).toBeLessThanOrEqual(shape.maxItems);
        for (const item of items) await match(item, shape.items, file);
      }
      if (shape.type === 'integer') {
        expect(Number.isSafeInteger(value)).toBe(true);
        if (typeof shape.minimum === 'number') expect(Number(value)).toBeGreaterThanOrEqual(shape.minimum);
        if (typeof shape.maximum === 'number') expect(Number(value)).toBeLessThanOrEqual(shape.maximum);
      }
    };
    for (const [name, value] of Object.entries({ exchange, inventory: inputs.author, inventoryReview: inputs.review,
      acceptedInventory: accepted, mapping, proseSubmission: submission, completenessReview: omission, reviewRound: round,
      stage: view, finalizeInput: final, state, proof: generation.completenessProof })) await match(value, record(document.$defs)[name]);
    const knowledgeSchema = await schema('project-knowledge.schema.json');
    await match(generation, record(knowledgeSchema.$defs).generation, 'project-knowledge.schema.json');
    await expect(match({ ...state, undisclosedField: true }, record(document.$defs).state)).rejects.toThrow();
  }, 60_000);

  it('requires explicit write bindings and emits a value-free budget failure', () => {
    const run = `run-${'0'.repeat(64)}`, digest = `sha256:${'0'.repeat(64)}`;
    for (const action of ['shadow', 'inventory', 'inventory-review', 'reconcile', 'submit', 'review', 'source-review', 'correct']) {
      const args = ['compile', 'hierarchy', 'completeness', action, '--project', 'parcel', '--run', run, '--input', 'input.json'];
      expect(() => parseCliArguments(args)).toThrow();
      expect(parseCliArguments([...args, '--expect-stage', digest]).kind).toBe('command');
      expect(() => parseCliArguments([...args, '--expect-stage', 'invalid'])).toThrow();
    }
    expect(() => parseCliArguments(['compile', 'hierarchy', 'status', '--project', 'parcel', '--run', run, '--role', 'grader'])).toThrow();
    const failure = mapCliError(new compiler.KnowledgeCompletenessBudgetError(262144), { command: 'compile.hierarchy.completeness.shadow',
      projectId: 'parcel', knowledgeRevision: null, workspacePath: null });
    expect(failure).toMatchObject({ exitCode: 3, data: { maximumBytes: 262144 } });
    expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThan(4096);
  });

  it('resolves the packed ESM entry, declaration exports and new schema without publishing or network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buildlore-completeness-package-')); roots.push(root);
    await execute('npm', ['pack', '--offline', '--ignore-scripts', '--pack-destination', root, '--cache', join(root, 'cache')],
      { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
    const archives = (await readdir(root)).filter(name => name.endsWith('.tgz'));
    expect(archives).toHaveLength(1);
    const filename = archives[0]; if (!filename) throw new Error('Missing local pack.');
    const modules = join(root, 'node_modules'); await mkdir(modules);
    await execute('tar', ['-xzf', join(root, filename), '-C', modules]);
    expect((await readdir(join(modules, 'package/schemas'))).includes(schemaName)).toBe(true);
    const entries = await readdir(join(modules, 'package'));
    expect(entries).not.toContain('plans'); expect(entries).not.toContain('.plan2agent');
    await symlink(join(modules, 'package'), join(modules, 'buildlore'));
    await symlink(join(process.cwd(), 'node_modules'), join(modules, 'package/node_modules'));
    const program = `import { compiler } from 'buildlore';
      import { readFile, writeFile } from 'node:fs/promises';
      const schema = JSON.parse(await readFile(new URL(import.meta.resolve('buildlore/schemas/project-knowledge-completeness.schema.json')), 'utf8'));
      if (typeof compiler.createKnowledgeCompletenessSessionService !== 'function' || typeof compiler.preparePlannedKnowledgeCompletenessSession !== 'function' || !schema.$defs.inventory) throw new Error('SDK_EXPORT_MISSING');
      if (compiler.requireKnowledgePreparedSessionCore || compiler.captureKnowledgeCompletenessSession || compiler.replayKnowledgeCompletenessSession) throw new Error('INTERNAL_CAPABILITY_EXPORTED');
      await writeFile('sdk-verified.json', JSON.stringify({ verified: true }));`;
    await execute(process.execPath, ['--input-type=module', '--eval', program], { cwd: root });
    expect(parseJsonStrict(await readFile(join(root, 'sdk-verified.json'), 'utf8'))).toEqual({ verified: true });
    await writeFile(join(root, 'consumer.mts'), `import { compiler } from 'buildlore';\nconst make: typeof compiler.createKnowledgeCompletenessSessionService = compiler.createKnowledgeCompletenessSessionService;\nlet session: compiler.KnowledgeCompletenessSessionV1;\nvoid make;\nvoid (null as unknown as typeof session);\n`);
    await execute(process.execPath, [join(process.cwd(), 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext',
      '--target', 'ES2024', '--skipLibCheck', 'false', '--types', 'node', '--typeRoots', join(process.cwd(), 'node_modules/@types'), 'consumer.mts'],
      { cwd: root, maxBuffer: 1024 * 1024 });
  }, 60_000);
});
