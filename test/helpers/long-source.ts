import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createKnowledgeWorkflowFixture, type KnowledgeWorkflowFixture } from './project-knowledge-workflow.js';
import { parseSourceDocument } from '../../src/projector/source-document.js';
import { writeSecurityPolicy } from '../fixtures/security-policy.js';

export const TAIL_FACT = 'The northern archive keeps the violet compass for seven seasons.';
export const LONG_BODY = `# Archive handbook\n\n${'This paragraph describes the archive records and their ordinary storage rules.\n\n'.repeat(1500)}## Final rule\n\n${TAIL_FACT}\n`;

export async function longSourceFixture(body = LONG_BODY): Promise<KnowledgeWorkflowFixture> {
  const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
  await writeFile(join(f.sourceRoot, 'docs/long.md'), body);
  await writeSecurityPolicy(f.knowledgeRoot, f.projectId, { capabilities: ['compile'] });
  return f;
}

export async function storedSources(f: KnowledgeWorkflowFixture) {
  const root = join(f.knowledgeRoot, 'projects', f.projectId, 'sources');
  return Promise.all((await readdir(root)).sort().filter((name) => name.endsWith('.md')).map(async target => ({
    target, document: parseSourceDocument(await readFile(join(root, target), 'utf8')),
  })));
}
