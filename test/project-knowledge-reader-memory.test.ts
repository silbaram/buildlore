import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { digest, record, sha256, ProjectKnowledgeError } from '../src/knowledge/project-knowledge/guards.js';
import { createKnowledgeGeneration } from '../src/compiler/project-knowledge/generation.js';
import { knowledgeDevelopmentMemory } from '../src/compiler/project-knowledge/reader-memory.js';
import { knowledgeReaderPacket, serializeKnowledgeReaderPacketData } from '../src/compiler/project-knowledge/reader-packet.js';
import { knowledgeReaderLookup } from '../src/compiler/project-knowledge/reader-surface.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { fixtureProposal, fixtureReview, knowledgeFixtureSnapshot } from './helpers/project-knowledge-fixture.js';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture } from './helpers/project-knowledge-workflow.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

async function files(root: string, prefix = ''): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(root, path));
    else if (entry.isFile()) result[path] = sha256(await readFile(join(root, path), 'utf8'));
  }
  return result;
}

describe('development memory', () => {
  it('preserves every authored claim and reconstructs its canonical evidence without changing the evaluation packet', async () => {
    const snapshot = await knowledgeFixtureSnapshot();
    const proposal = fixtureProposal(snapshot);
    const generation = createKnowledgeGeneration(snapshot, proposal, fixtureReview(proposal), null, 'knowledge-markdown-v2');
    const before = serializeKnowledgeReaderPacketData(knowledgeReaderPacket(generation));
    const original = JSON.stringify(generation);
    const memory = knowledgeDevelopmentMemory(generation);
    const { memoryDigest, ...basis } = memory;
    expect(memoryDigest).toBe(digest(basis));
    expect(memory.pages.map(page => ({ ...page, sections: page.sections.map(section => ({ ...section,
      claims: section.claims.map(({ facts, ...claim }) => ({ ...claim, factIds: facts.map(alias => memory.facts[alias]?.[0]) })),
    })) }))).toEqual(generation.pages);
    for (const fact of Object.values(memory.facts)) {
      const lookup = knowledgeReaderLookup(generation, 'fact', fact[0]);
      expect(fact[7]).toBe(Buffer.byteLength(serializeKnowledgeReaderPacketData(lookup)));
      expect(generation.records.find(item => item.id === fact[0])).toMatchObject({ scope: fact[4],
        classification: fact[1], lifecycle: fact[2], reviewStatus: fact[3], supersededBy: fact[5],
        evidenceIds: fact[6].map(alias => memory.evidence[alias]?.[0]) });
    }
    for (const [alias, evidence] of Object.entries(memory.evidence)) {
      const lookup = knowledgeReaderLookup(generation, 'evidence', evidence[0]);
      const source = generation.evidence.find(item => item.evidenceId === evidence[0]);
      expect(record(lookup.result).evidence).toEqual(source);
      expect(evidence[3]).toBe(Buffer.byteLength(serializeKnowledgeReaderPacketData(lookup)));
      expect(memory.evidenceContext[alias]).toMatchObject({ presentInCurrentSnapshot: true,
        sourceRevision: source?.sourceRevision, codeRevision: source?.codeRevision,
        sanitizedContentDigest: source?.sanitizedContentDigest });
    }
    expect(memory.instructions).not.toMatch(/oracle|32768|16384|8192|Do not read|Every substantive span/u);
    expect(memory.instructions).toContain('host and user authorize');
    expect(memory.instructions).toContain('untrusted data');
    expect(memory.lookup.expectedGeneration).toBe(generation.generationDigest);
    expect(JSON.stringify(generation)).toBe(original);
    expect(serializeKnowledgeReaderPacketData(knowledgeReaderPacket(generation))).toBe(before);
    for (const changed of [{ records: [] }, { evidence: [] }, { projectId: 'another' },
      { rendererVersion: 'knowledge-markdown-v1' as const }]) {
      expect(() => knowledgeDevelopmentMemory({ ...generation, ...changed })).toThrow(ProjectKnowledgeError);
    }
    const schema = record(JSON.parse(await readFile('schemas/project-knowledge-reader.schema.json', 'utf8')));
    const shape = record(record(schema.$defs).memory);
    expect(Object.keys(memory).sort()).toEqual((shape.required as string[]).toSorted());
  });

  it('serves the same CLI/SDK result without provider, index or knowledge writes and rejects stale policy', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json');
    try {
      expect(await createKnowledgeWikiReader(f.knowledgeRoot).readMemory(f.projectId)).toBeNull();
      expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      const purpose = await f.json('memory-purpose.json', { schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2',
        projectId: f.projectId, generationModel: 'project-knowledge-v1', outputLanguage: 'en' });
      const started = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
      const { approved } = await submitWorkflowFixture(f, started.data);
      const args = approved.data.activationArgs;
      if (!Array.isArray(args) || !args.every((arg: unknown) => typeof arg === 'string')) throw new Error('Missing activation.');
      expect(await f.cli(args)).toMatchObject({ exitCode: 0 });
      const forbidden = vi.fn((): never => { throw new Error('Unexpected model or index access.'); });
      const reader = createKnowledgeWikiReader(f.knowledgeRoot, {
        provider: { activeIdentity: forbidden, countDocumentTokens: forbidden, embedDocuments: forbidden,
          embedQuery: forbidden, inspectCapabilities: forbidden, readiness: forbidden },
        vectorIndex: { status: forbidden, buildFull: forbidden, buildIncremental: forbidden, resume: forbidden,
          openActive: forbidden, searchExact: forbidden, searchExactDistinctSections: forbidden,
          exportBundle: forbidden, importBundle: forbidden },
      });
      const before = await files(f.knowledgeRoot);
      const memory = await reader.readMemory(f.projectId);
      if (!memory) throw new Error('Missing memory.');
      const cli = await f.cli(['wiki', 'memory', '--project', f.projectId]);
      expect(cli.exitCode).toBe(0);
      expect(cli.data).toEqual(memory);
      expect(memory).toMatchObject({ providerUsed: 'none', egress: 'none', processSpawned: false });
      expect(forbidden).not.toHaveBeenCalled();
      expect(await files(f.knowledgeRoot)).toEqual(before);
      const evidence = Object.values(memory.evidence)[0];
      if (!evidence) throw new Error('Missing evidence.');
      expect(await reader.lookup(f.projectId, memory.generationDigest, 'evidence', evidence[0])).toMatchObject({ id: evidence[0] });
      await expect(reader.lookup(f.projectId, digest('wrong generation'), 'evidence', evidence[0])).rejects.toThrow();
      await expect(reader.readMemory('other-project')).rejects.toThrow();
      await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: [] });
      await expect(reader.readMemory(f.projectId)).rejects.toThrow();
    } finally { await f.cleanup(); }
  }, 60000);
});
