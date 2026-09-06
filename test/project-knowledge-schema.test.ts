import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonStrict } from '../src/knowledge/strict-json.js';
import { record } from '../src/knowledge/project-knowledge/guards.js';
import { knowledgeFixtureSnapshot, fixtureProposal, fixtureReview } from './helpers/project-knowledge-fixture.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';

/** These tests check published shapes/references; semantic truth remains a separate review. */
describe('project knowledge schema parity', () => {
  it('resolves every reference and keeps every object contract closed', async () => {
    const documents = new Map<string, unknown>();
    const inspected = new Set<string>();
    const load = async (name: string) => {
      if (!/^[a-z0-9-]+\.schema\.json$/u.test(name)) throw new Error('Invalid schema reference.');
      if (!documents.has(name)) documents.set(name, parseJsonStrict(await readFile(join(process.cwd(), 'schemas', name), 'utf8')));
      return documents.get(name);
    };
    const walk = async (value: unknown, file: string): Promise<void> => {
      if (Array.isArray(value)) { for (const item of value as readonly unknown[]) await walk(item, file); return; }
      if (value === null || typeof value !== 'object') return;
      const schema = record(value);
      if (schema.type === 'object') expect(schema.additionalProperties).toBe(false);
      if (typeof schema.$ref === 'string') {
        const [name, fragment = ''] = schema.$ref.split('#');
        const targetFile = name || file;
        let target = await load(targetFile);
        for (const component of fragment.split('/').slice(1)) {
          target = record(target)[component.replaceAll('~1', '/').replaceAll('~0', '~')];
        }
        expect(target, 'Every schema reference must resolve.').toBeDefined();
        const identity = `${targetFile}#${fragment}`;
        if (!inspected.has(identity)) { inspected.add(identity); await walk(target, targetFile); }
      }
      for (const child of Object.values(schema)) await walk(child, file);
    };
    for (const name of ['project-knowledge.schema.json', 'project-knowledge-workflow.schema.json',
      'hierarchical-wiki-activation.schema.json', 'hierarchical-markdown-materialization.schema.json']) {
      await walk(await load(name), name);
    }
  });

  it('publishes all canonical fields and discriminators emitted by the core codecs', async () => {
    const schema = record(parseJsonStrict(await readFile(join(process.cwd(), 'schemas/project-knowledge.schema.json'), 'utf8')));
    const defs = record(schema.$defs);
    const snapshot = await knowledgeFixtureSnapshot();
    const proposal = fixtureProposal(snapshot);
    const review = fixtureReview(proposal);
    const generation = createKnowledgeGeneration(snapshot, proposal, review, null);
    const examples = { snapshot, proposal, review, generation, source: snapshot.sources[0], evidence: snapshot.evidence[0],
      record: proposal.facts[0], page: proposal.pages[0], claim: proposal.pages[0]?.sections[0]?.claims[0], actor: proposal.actor };
    for (const [name, input] of Object.entries(examples)) {
      const value = record(input);
      const shape = record(defs[name]);
      const properties = record(shape.properties);
      const required = shape.required as readonly string[];
      expect(required.every((key) => Object.hasOwn(value, key))).toBe(true);
      expect(Object.keys(value).every((key) => Object.hasOwn(properties, key))).toBe(true);
      if (value.schemaVersion !== undefined) expect(record(properties.schemaVersion).const).toBe(value.schemaVersion);
    }
    expect(record(record(defs.snapshot).properties).repositoryRevision).toBeUndefined();
    expect(record(record(defs.source).properties).repositoryRevision).toBeDefined();
    const claimId = record(record(record(defs.claim).properties).claimId);
    if (typeof claimId.pattern !== 'string') throw new Error('Missing claim identifier schema.');
    const pattern = new RegExp(claimId.pattern, 'u');
    expect(pattern.test('claim-overview')).toBe(true);
    for (const reserved of ['title:overview', 'section:overview:0', 'sha256:fact', 'supersession:link', 'conflict:claim']) {
      expect(pattern.test(reserved)).toBe(false);
    }
  });
});
