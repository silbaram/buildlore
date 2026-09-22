import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { longSourceFixture } from './long-source.js';
import { parseSourceCollectionManifestV2 } from '../../src/projector/source-manifest.js';
import { serializeCanonicalJson } from '../../src/knowledge/atomic-file.js';

/** Ordinary generated text; no repository content, credentials or external compiler. */
export async function wikiLargeCorpusFixture() {
  const f = await longSourceFixture();
  try {
    await mkdir(join(f.sourceRoot, 'src'));
    const body = Array.from({ length: 256 }, (_, index) =>
      `export const item${String(index).padStart(3, '0')} = 'ordinary fixture value';${(index + 1) % 16 === 0 ? '\n' : ''}`
    ).join('\n');
    await Promise.all(Array.from({ length: 332 }, (_, index) =>
      writeFile(join(f.sourceRoot, 'src', `module-${index}.ts`), body)));
    const manifestPath = join(f.sourceRoot, '.buildlore/sources.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { sources: unknown[] };
    manifest.sources.push({ adapterId: 'buildlore.generic', adapterVersion: 1,
      id: 'code', kind: 'code', path: 'src', pathType: 'directory', recursive: true });
    await writeFile(manifestPath, serializeCanonicalJson(parseSourceCollectionManifestV2(manifest)));
    return f;
  } catch (error) { await f.cleanup(); throw error; }
}
