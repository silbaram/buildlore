import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  MAX_JSON_ARRAY_ITEMS,
  MAX_JSON_STRING_SCALARS,
  parseJsonStrict,
  parseJsonWithLocationsStrict,
} from '../src/knowledge/strict-json.js';
import {
  SourceCheckoutHandle,
  sourceRepositoryDigestFor,
} from '../src/knowledge/local-project-registry.js';
import {
  createSourceCollectionAdapter,
  parseSourceDocument,
  renderSourceDocument,
  SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
} from '../src/projector/index.js';
import {
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
} from '../src/projector/source-manifest.js';

const temporaryRoots: string[] = [];
const repository = 'https://example.test/alpha.git';

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

async function fixture(source: string): Promise<Readonly<{
  checkout: SourceCheckoutHandle;
  sourceRoot: string;
}>> {
  const sourceRoot = await mkdtemp(join(process.cwd(), '.test-tmp-json-projector-'));
  temporaryRoots.push(sourceRoot);
  await mkdir(join(sourceRoot, '.buildlore'));
  await mkdir(join(sourceRoot, 'data'));
  await writeFile(join(sourceRoot, 'data/state.json'), source);
  await writeFile(join(sourceRoot, '.buildlore/sources.json'), serializeCanonicalJson({
    projectId: 'alpha',
    schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
    sourceRepository: repository,
    sources: [{
      adapterId: 'buildlore.json',
      adapterVersion: 1,
      id: 'state',
      kind: 'json',
      path: 'data/state.json',
      pathType: 'file',
    }],
  }));
  return Object.freeze({
    checkout: new SourceCheckoutHandle(
      'alpha',
      sourceRepositoryDigestFor(repository),
      sourceRoot,
    ),
    sourceRoot,
  });
}

describe('generic JSON projector', () => {
  it('strict-parses immutable values with RFC 6901 locations and Unicode columns', () => {
    const parsed = parseJsonWithLocationsStrict('{\n  "😀/~": "값"\n}');
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(parsed.locations).toEqual([
      {
        pointer: '',
        range: { end: { column: 2, line: 3 }, start: { column: 1, line: 1 } },
      },
      {
        pointer: '/😀~1~0',
        range: { end: { column: 13, line: 2 }, start: { column: 10, line: 2 } },
      },
    ]);
  });

  it('creates deterministic Markdown and pointer-bound SourceDocument v3 provenance', async () => {
    const current = await fixture(
      '{"z":null,"a":{"~x/y":"😀"},"items":[true,3]}',
    );
    const loadedManifest = await readSourceCollectionManifest(current.checkout, 'alpha');
    const inventory = await selectDeclaredSourceFiles(current.checkout, loadedManifest);
    const input = {
      checkout: current.checkout,
      ingestedAt: '2026-09-04T00:00:00.000Z',
      inventory,
      loadedManifest,
    } as const;
    const adapter = createSourceCollectionAdapter();
    const first = await adapter.collect(input);
    const second = await adapter.collect(input);
    expect(second).toEqual(first);
    const candidate = first.candidates[0];
    expect(candidate).toMatchObject({
      adapterId: 'buildlore.json',
      documentKind: 'json',
      mediaType: 'application/json',
      sourceKind: 'json',
      sourceRef: 'data/state.json',
      title: 'state',
    });
    expect(candidate?.body).toBe([
      '## "a"',
      '### "~x/y"',
      '"😀"',
      '## "items"',
      '1. true',
      '2. 3',
      '## "z"',
      'null',
    ].join('\n'));
    expect(candidate?.canonicalDocument.schemaVersion).toBe('buildlore.source.v3');
    expect(candidate?.descriptor?.schemaVersion).toBe('buildlore.source-descriptor.v2');
    expect(candidate?.jsonOrigins?.map((entry) => entry.origin.jsonPointer)).toEqual([
      '/a', '/a/~0x~1y', '/a/~0x~1y', '/items', '/items/0', '/items/1', '/z', '/z',
    ]);
    const rendered = renderSourceDocument(candidate?.canonicalDocument as NonNullable<typeof candidate>['canonicalDocument']);
    expect(parseSourceDocument(rendered)).toEqual(candidate?.canonicalDocument);
    expect(JSON.stringify(first)).not.toContain(current.sourceRoot);
  });

  it('fails closed on duplicate keys, invalid surrogates, and finite limits', () => {
    expect(() => parseJsonWithLocationsStrict('{"a":1,"a":2}')).toThrow();
    expect(() => parseJsonWithLocationsStrict(String.raw`"\ud800"`)).toThrow();
    expect(() => parseJsonWithLocationsStrict(
      `[${Array.from({ length: MAX_JSON_ARRAY_ITEMS + 1 }, () => '0').join(',')}]`,
    )).toThrow();
  });

  it('keeps legacy strict parsing compatible with bounded documents containing long strings', () => {
    const value = 'x'.repeat(MAX_JSON_STRING_SCALARS + 1);
    const source = JSON.stringify({ body: value });
    expect((parseJsonStrict(source) as { body: string }).body).toBe(value);
    expect(() => parseJsonWithLocationsStrict(source)).toThrow();
  });
});
