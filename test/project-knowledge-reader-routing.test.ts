import { describe, expect, it } from 'vitest';
import { digest } from '../src/knowledge/project-knowledge/guards.js';
import { createKnowledgeWikiReader } from '../src/retrieval/project-knowledge-reader.js';
import { createKnowledgeWorkflowFixture, submitWorkflowFixture } from './helpers/project-knowledge-workflow.js';

describe('knowledge reader routing contracts', () => {
  it('validates selective requests before missing authority and keeps strict lookups distinct from optional reads', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json');
    try {
      const reader = createKnowledgeWikiReader(f.knowledgeRoot);
      expect(await reader.readMemory(f.projectId)).toBeNull();
      expect(await reader.readTaskMemory(f.projectId, { task: 'local' })).toBeNull();
      expect(await reader.readProgressiveMemory(f.projectId, { task: 'local' })).toBeNull();
      expect(await reader.read(f.projectId, 'overview')).toBeNull();
      expect(await reader.readContext(f.projectId, 'overview')).toBeNull();
      await expect(reader.readTaskMemory(f.projectId, { task: '' })).rejects.toMatchObject({ code: 'TASK_MEMORY_REQUEST_INVALID' });
      await expect(reader.readProgressiveMemory(f.projectId, { task: 'local', cursor: 'invalid' }))
        .rejects.toMatchObject({ code: 'PROGRESSIVE_MEMORY_CURSOR_INVALID' });
      const generation = digest('missing generation'), id = digest('missing evidence or fact');
      await expect(reader.lookup(f.projectId, generation, 'evidence', id)).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID' });
      await expect(reader.evidence(f.projectId, generation, id)).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID' });
      await expect(reader.fact(f.projectId, generation, id)).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID' });
    } finally { await f.cleanup(); }
  }, 15000);

  it('resolves all documented page aliases consistently and rejects stale generations in every canonical lookup', async () => {
    const f = await createKnowledgeWorkflowFixture('generic-md-json');
    try {
      expect(await f.cli(['sync', '--project', f.projectId])).toMatchObject({ exitCode: 0 });
      const purpose = await f.json('reader-routing-purpose.json', {
        schemaVersion: 'buildlore.hierarchical-workflow-purpose-input.v2', projectId: f.projectId,
        generationModel: 'project-knowledge-v1', outputLanguage: 'en',
      });
      const started = await f.cli(['compile', 'hierarchy', 'start', '--project', f.projectId, '--purpose', purpose]);
      const { approved } = await submitWorkflowFixture(f, started.data);
      const args = approved.data.activationArgs;
      if (!Array.isArray(args) || !args.every((arg: unknown) => typeof arg === 'string')) throw new Error('Missing activation.');
      expect(await f.cli(args)).toMatchObject({ exitCode: 0 });
      const reader = createKnowledgeWikiReader(f.knowledgeRoot);
      for (const role of ['overview', 'architecture', 'decisions']) {
        const page = await reader.read(f.projectId, role), context = await reader.readContext(f.projectId, role);
        if (!page || !context) throw new Error('Missing approved page.');
        for (const alias of [page.pageId, `${role}.md`, `wiki/buildlore-hierarchy/${role}.md`, `buildlore-hierarchy/${role}.md`]) {
          expect(await reader.read(f.projectId, alias)).toEqual(page);
          expect(await reader.readContext(f.projectId, alias)).toEqual(context);
        }
      }
      await expect(reader.read(f.projectId, 'unknown.md')).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID' });
      await expect(reader.readContext(f.projectId, 'unknown.md')).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID' });
      const page = await reader.read(f.projectId, 'overview');
      const fact = page?.facts[0], evidence = page?.evidence[0];
      if (!page || !fact || !evidence) throw new Error('Missing approved support.');
      expect(await reader.evidence(f.projectId, page.generationDigest, evidence.evidenceId)).toEqual(evidence);
      expect(await reader.fact(f.projectId, page.generationDigest, fact.id)).toMatchObject({ fact });
      const stale = digest('different generation');
      await expect(reader.lookup(f.projectId, stale, 'evidence', evidence.evidenceId)).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID' });
      await expect(reader.lookup(f.projectId, stale, 'fact', fact.id)).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID' });
      await expect(reader.evidence(f.projectId, stale, evidence.evidenceId)).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID' });
      await expect(reader.fact(f.projectId, stale, fact.id)).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID' });
    } finally { await f.cleanup(); }
  }, 60000);
});
