import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPublicationBlobPolicy } from '../src/knowledge/publication-validation.js';
import { parseSourceDocument, renderSourceDocument } from '../src/projector/source-document.js';
import { createKnowledgeWorkflowFixture } from './helpers/project-knowledge-workflow.js';

const digest = (text: string): `sha256:${string}` => `sha256:${createHash('sha256').update(text).digest('hex')}`;

it('screens decoded generated sources while rejecting altered bindings, hidden fields and secret prose', async () => {
  const f = await createKnowledgeWorkflowFixture('generic-md-json', { directWorkspace: true });
  try {
    expect((await f.cli(['sync', '--project', f.projectId])).exitCode).toBe(0);
    const directory = `projects/${f.projectId}/sources`;
    const name = (await readdir(join(f.knowledgeRoot, directory))).find(v => v.startsWith('markdown--'));
    if (!name) throw new Error('Missing generated source fixture.');
    const path = `${directory}/${name}`;
    const text = await readFile(join(f.knowledgeRoot, path), 'utf8');
    const policy = createPublicationBlobPolicy(f.knowledgeRoot);
    const check = (body: string, target = path) => policy.validate(f.projectId, target, Buffer.from(body), digest(body));
    expect(await check(text)).toBe(true);
    expect(await check(text, `${directory}/markdown--${'0'.repeat(64)}.md`)).toBe(false);
    expect(await check(text.replace('title:', 'extraField: ignored\ntitle:'))).toBe(false);
    const document = parseSourceDocument(text);
    // Synthetic detector fixture; no real credentials or source values are logged.
    const body = `${document.body}\napi_key: ${['sk', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-')}\n`;
    const altered = renderSourceDocument({ ...document, body, buildlore: { ...document.buildlore, contentHash: digest(body) } });
    expect(await check(altered)).toBe(false);
    const descriptor = document.buildlore.descriptor;
    if (!descriptor) throw new Error('Missing source descriptor fixture.');
    const foreignUri = document.source.replace(encodeURIComponent(`https://example.test/${f.projectId}.git`), encodeURIComponent('https://example.test/other.git'));
    const foreign = renderSourceDocument({ ...document, source: foreignUri,
      buildlore: { ...document.buildlore, descriptor: { ...descriptor, sourceUri: foreignUri } } });
    expect(await check(foreign, `${directory}/markdown--${digest(foreignUri).slice(7)}.md`)).toBe(false);
  } finally { await f.cleanup(); }
}, 30000);
