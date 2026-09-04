import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  SourceCheckoutHandle,
  sourceRepositoryDigestFor,
} from '../src/knowledge/local-project-registry.js';
import {
  createBuiltInSourceAdapterRegistry,
  createSourceCollectionAdapter,
  JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION,
  MAX_SOURCE_METADATA_BYTES,
  MAX_SOURCE_METADATA_DEPTH,
  MAX_SOURCE_METADATA_KEYS,
  SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
  registerJsonKnowledgeAdapter,
  type JsonKnowledgeAdapterV1,
} from '../src/projector/index.js';
import {
  readSourceCollectionManifest,
  selectDeclaredSourceFiles,
  SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
} from '../src/projector/source-manifest.js';
import { createProfileBindingV2, registerProfileBinding } from '../src/profile/index.js';

const roots: string[] = [];
const repository = 'https://example.test/alpha.git';

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

function registration(adapterId = 'example.summary') {
  return {
    adapterId,
    adapterVersion: 1 as const,
    kinds: [{ kind: 'json' as const, mediaTypes: ['application/json' as const] }],
    limits: {
      maxMetadataBytes: MAX_SOURCE_METADATA_BYTES,
      maxMetadataDepth: MAX_SOURCE_METADATA_DEPTH,
      maxMetadataKeys: MAX_SOURCE_METADATA_KEYS,
    },
    metadataNamespace: adapterId,
    metadataSchemaVersion: `${adapterId}-metadata.v1`,
  } as const;
}

async function fixture(adapterId: string) {
  const sourceRoot = await mkdtemp(join(process.cwd(), '.test-tmp-json-adapter-'));
  roots.push(sourceRoot);
  await mkdir(join(sourceRoot, '.buildlore'));
  await mkdir(join(sourceRoot, 'runs'));
  await writeFile(
    join(sourceRoot, 'runs/a.json'),
    '{"rawOnly":"RAW_ONLY_SENTINEL","result":"A"}',
  );
  await writeFile(join(sourceRoot, 'runs/b.json'), '{"result":"B"}');
  await writeFile(join(sourceRoot, '.buildlore/sources.json'), serializeCanonicalJson({
    projectId: 'alpha',
    schemaVersion: SOURCE_COLLECTION_MANIFEST_V2_SCHEMA_VERSION,
    sourceRepository: repository,
    sources: [{
      adapterId,
      adapterVersion: 1,
      id: 'runs',
      kind: 'json',
      metadata: {
        namespace: adapterId,
        schemaVersion: `${adapterId}-metadata.v1`,
        values: { adapterConfig: { mode: 'summary' } },
      },
      path: 'runs',
      pathType: 'directory',
      recursive: true,
    }],
  }));
  return {
    checkout: new SourceCheckoutHandle(
      'alpha', sourceRepositoryDigestFor(repository), sourceRoot,
    ),
    sourceRoot,
  };
}

describe('trusted local JSON knowledge adapter', () => {
  it('receives only frozen parsed entries/config and returns core-owned multi-input documents', async () => {
    let observedKeys: readonly string[] = [];
    let immutable = false;
    const adapter: JsonKnowledgeAdapterV1 = {
      contractVersion: JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION,
      project(input) {
        observedKeys = Object.keys(input).sort();
        immutable = Object.isFrozen(input) && Object.isFrozen(input.entries) &&
          input.entries.every((entry) => Object.isFrozen(entry.value)) &&
          Object.isFrozen(input.config);
        return [{
          body: '## A\n"A"\n## B\n"B"',
          inputSourceRefs: ['runs/a.json', 'runs/b.json'],
          logicalId: 'combined',
          origins: [
            {
              canonical: { endColumn: 5, endLine: 1, startColumn: 1, startLine: 1 },
              jsonPointer: '/result',
              sourceRef: 'runs/a.json',
            },
            {
              canonical: { endColumn: 4, endLine: 2, startColumn: 1, startLine: 2 },
              jsonPointer: '/result',
              sourceRef: 'runs/a.json',
            },
            {
              canonical: { endColumn: 5, endLine: 3, startColumn: 1, startLine: 3 },
              jsonPointer: '/result',
              sourceRef: 'runs/b.json',
            },
            {
              canonical: { endColumn: 4, endLine: 4, startColumn: 1, startLine: 4 },
              jsonPointer: '/result',
              sourceRef: 'runs/b.json',
            },
          ],
          title: 'Combined run summary',
        }];
      },
      registration: registration(),
    };
    const registered = registerJsonKnowledgeAdapter(adapter);
    const profileBinding = createProfileBindingV2('general', 'en', [registered]);
    expect(registerProfileBinding(profileBinding, {
      registrations: [registered],
    }).sourceAdapters.resolve({
      adapterId: registered.registration.adapterId,
      adapterVersion: 1,
      kind: 'json',
    })).toMatchObject({ kind: 'json', mediaType: 'application/json' });
    expect(() => registerProfileBinding({
      ...profileBinding,
      adapters: profileBinding.adapters.map((entry) => entry.adapterId ===
        registered.registration.adapterId
        ? { ...entry, registrationDigest: `sha256:${'0'.repeat(64)}` }
        : entry),
    }, { registrations: [registered] })).toThrow();
    const registry = createBuiltInSourceAdapterRegistry({ registrations: [registered] });
    const current = await fixture(registered.registration.adapterId);
    const loadedManifest = await readSourceCollectionManifest(current.checkout, 'alpha', {
      sourceAdapterRegistry: registry,
    });
    const inventory = await selectDeclaredSourceFiles(current.checkout, loadedManifest, {
      sourceAdapterRegistry: registry,
    });
    const result = await createSourceCollectionAdapter({
      jsonKnowledgeAdapters: [registered],
      sourceAdapterRegistry: registry,
    }).collect({
      checkout: current.checkout,
      ingestedAt: '2026-09-04T00:00:00.000Z',
      inventory,
      loadedManifest,
      sourceAdapterRegistry: registry,
    });
    expect(observedKeys).toEqual(['config', 'configDigest', 'entries', 'projectId']);
    expect(immutable).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      adapterId: 'example.summary',
      documentKind: 'json',
      producer: 'buildlore',
      sourceKind: 'json',
      title: 'Combined run summary',
    });
    expect(result.candidates[0]?.descriptor).toMatchObject({
      adapterRegistrationDigest: registered.registrationDigest,
      inputBindings: [
        { sourceRef: 'runs/a.json' },
        { sourceRef: 'runs/b.json' },
      ],
    });
    const descriptor = result.candidates[0]?.descriptor;
    expect(descriptor === undefined || !('adapterConfigDigest' in descriptor)
      ? undefined
      : descriptor.adapterConfigDigest).toMatch(/^sha256:/u);
    expect(JSON.stringify(result)).not.toContain(current.sourceRoot);
    expect(JSON.stringify(result)).not.toContain('workspace');
    expect(JSON.stringify(result)).not.toContain('RAW_ONLY_SENTINEL');
  });

  it('rejects duplicate registrations and forged core-owned candidate fields', async () => {
    const registered = registerJsonKnowledgeAdapter({
      contractVersion: JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION,
      project() {
        return [{
          body: 'valid',
          inputSourceRefs: ['runs/a.json'],
          logicalId: 'forged',
          origins: [{
            canonical: { endColumn: 6, endLine: 1, startColumn: 1, startLine: 1 },
            jsonPointer: '',
            sourceRef: 'runs/a.json',
          }],
          target: '/tmp/forged.md',
          title: 'Forged',
        } as never];
      },
      registration: registration('example.forged'),
    });
    expect(() => createBuiltInSourceAdapterRegistry({ registrations: [registered, registered] }))
      .toThrow();
    const registry = createBuiltInSourceAdapterRegistry({ registrations: [registered] });
    const current = await fixture(registered.registration.adapterId);
    const loadedManifest = await readSourceCollectionManifest(current.checkout, 'alpha', {
      sourceAdapterRegistry: registry,
    });
    const inventory = await selectDeclaredSourceFiles(current.checkout, loadedManifest, {
      sourceAdapterRegistry: registry,
    });
    await expect(createSourceCollectionAdapter({
      jsonKnowledgeAdapters: [registered],
      sourceAdapterRegistry: registry,
    }).collect({
      checkout: current.checkout,
      ingestedAt: '2026-09-04T00:00:00.000Z',
      inventory,
      loadedManifest,
    })).rejects.toThrow();
  });

  it('changes the projection revision when semantic adapter output changes', async () => {
    let revisionOrdinal = 0;
    const registered = registerJsonKnowledgeAdapter({
      contractVersion: JSON_KNOWLEDGE_ADAPTER_CONTRACT_VERSION,
      project() {
        revisionOrdinal += 1;
        return [{
          body: '## A\n"A"\n## B\n"B"',
          inputSourceRefs: ['runs/a.json', 'runs/b.json'],
          logicalId: 'semantic-revision',
          origins: [
            {
              canonical: { endColumn: 5, endLine: 1, startColumn: 1, startLine: 1 },
              jsonPointer: '/result',
              sourceRef: 'runs/a.json',
            },
            {
              canonical: { endColumn: 4, endLine: 2, startColumn: 1, startLine: 2 },
              jsonPointer: '/result',
              sourceRef: 'runs/a.json',
            },
            {
              canonical: { endColumn: 5, endLine: 3, startColumn: 1, startLine: 3 },
              jsonPointer: '/result',
              sourceRef: 'runs/b.json',
            },
            {
              canonical: { endColumn: 4, endLine: 4, startColumn: 1, startLine: 4 },
              jsonPointer: '/result',
              sourceRef: 'runs/b.json',
            },
          ],
          retrievalMeaning: {
            authority: 'supporting',
            evidenceKind: 'execution',
            iterationGroup: null,
            lifecycle: 'current',
            revisionOrdinal,
            schemaVersion: SOURCE_RETRIEVAL_MEANING_SCHEMA_VERSION,
            supersededBySourceRefs: [],
            supersedesSourceRefs: [],
            topicGroup: 'adapter-output',
          },
          title: 'Semantic revision',
        }];
      },
      registration: registration('example.semantic-revision'),
    });
    const registry = createBuiltInSourceAdapterRegistry({ registrations: [registered] });
    const current = await fixture(registered.registration.adapterId);
    const loadedManifest = await readSourceCollectionManifest(current.checkout, 'alpha', {
      sourceAdapterRegistry: registry,
    });
    const inventory = await selectDeclaredSourceFiles(current.checkout, loadedManifest, {
      sourceAdapterRegistry: registry,
    });
    const adapter = createSourceCollectionAdapter({
      jsonKnowledgeAdapters: [registered],
      sourceAdapterRegistry: registry,
    });
    const input = {
      checkout: current.checkout,
      ingestedAt: '2026-09-04T00:00:00.000Z',
      inventory,
      loadedManifest,
      sourceAdapterRegistry: registry,
    } as const;
    const first = await adapter.collect(input);
    const second = await adapter.collect(input);
    expect(first.candidates[0]?.body).toBe(second.candidates[0]?.body);
    expect(first.candidates[0]?.sourceRevision).not.toBe(second.candidates[0]?.sourceRevision);
    const firstDescriptor = first.candidates[0]?.descriptor;
    const secondDescriptor = second.candidates[0]?.descriptor;
    if (firstDescriptor === undefined || secondDescriptor === undefined ||
        !('projectionRevision' in firstDescriptor) || !('projectionRevision' in secondDescriptor)) {
      throw new Error('Expected version 2 source descriptors.');
    }
    expect(firstDescriptor.projectionRevision).not.toBe(secondDescriptor.projectionRevision);
  });
});
