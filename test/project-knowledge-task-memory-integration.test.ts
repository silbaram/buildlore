import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { digest, sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
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

describe('task memory approved reader integration', () => {
  it('serves the same CLI/SDK result without provider, index or knowledge writes and rejects stale policy', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json');
    try {
      expect(await createKnowledgeWikiReader(f.knowledgeRoot).readTaskMemory(f.projectId, { task: 'local' })).toBeNull();
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
      const fullBefore = await reader.readMemory(f.projectId);
      const packetBefore = await reader.readPacket(f.projectId);
      const memory = await reader.readTaskMemory(f.projectId, { task: 'local' });
      if (!memory) throw new Error('Missing memory.');
      const cli = await f.cli(['wiki', 'memory', '--project', f.projectId, '--task', 'local']);
      expect(cli.exitCode).toBe(0);
      expect(cli.data).toEqual(memory);
      expect(memory).toMatchObject({ providerUsed: 'none', egress: 'none', processSpawned: false });
      expect(await reader.readMemory(f.projectId)).toEqual(fullBefore);
      expect(await reader.readPacket(f.projectId)).toEqual(packetBefore);
      expect((await f.cli(['wiki', 'memory', '--project', f.projectId, '--max-bytes', '8192'])).exitCode).toBe(2);
      expect((await f.cli(['wiki', 'memory', '--project', f.projectId, '--task', 'local', '--max-bytes', 'no'])).exitCode).toBe(2);
      expect(forbidden).not.toHaveBeenCalled();
      expect(await files(f.knowledgeRoot)).toEqual(before);
      const evidence = Object.values(memory.evidence)[0];
      if (!evidence) throw new Error('Missing evidence.');
      expect(await reader.lookup(f.projectId, memory.generationDigest, 'evidence', evidence[0])).toMatchObject({ id: evidence[0] });
      await expect(reader.lookup(f.projectId, digest('wrong generation'), 'evidence', evidence[0])).rejects.toThrow();
      await expect(reader.readTaskMemory('other-project', { task: 'local' })).rejects.toThrow();
      await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: [] });
      await expect(reader.readTaskMemory(f.projectId, { task: 'local' })).rejects.toThrow();
    } finally { await f.cleanup(); }
  }, 60000);
});
