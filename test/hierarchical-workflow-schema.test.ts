import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseJsonStrict } from '../src/knowledge/strict-json.js';

type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectReferences(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectReferences(item));
  if (!isJsonObject(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => (
    key === '$ref' && typeof item === 'string'
      ? [item]
      : collectReferences(item)
  ));
}

function collectObjectSchemas(value: unknown): readonly JsonObject[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectObjectSchemas(item));
  if (!isJsonObject(value)) return [];
  const nested = Object.values(value).flatMap((item) => collectObjectSchemas(item));
  return value.type === 'object' ? [value, ...nested] : nested;
}

function resolvesJsonPointer(document: unknown, fragment: string): boolean {
  if (!fragment.startsWith('/')) return fragment.length === 0;
  let current = document;
  for (const encodedToken of fragment.slice(1).split('/')) {
    const token = encodedToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isJsonObject(current) || !(token in current)) return false;
    current = current[token];
  }
  return current !== undefined;
}

async function loadSchemas(): Promise<Readonly<{
  workflow: JsonObject;
  corpus: JsonObject;
  currentSession: JsonObject;
}>> {
  const [workflowSource, corpusSource, currentSessionSource] = await Promise.all([
    readFile(new URL('../schemas/hierarchical-workflow.schema.json', import.meta.url), 'utf8'),
    readFile(new URL('../schemas/hierarchical-corpus.schema.json', import.meta.url), 'utf8'),
    readFile(
      new URL('../schemas/hierarchical-current-session.schema.json', import.meta.url),
      'utf8',
    ),
  ]);
  const workflow = parseJsonStrict(workflowSource);
  const corpus = parseJsonStrict(corpusSource);
  const currentSession = parseJsonStrict(currentSessionSource);
  if (!isJsonObject(workflow) || !isJsonObject(corpus) || !isJsonObject(currentSession)) {
    throw new Error('Hierarchical workflow schemas are invalid.');
  }
  return { workflow, corpus, currentSession };
}

function schemaDefinitions(schema: JsonObject): JsonObject {
  if (!isJsonObject(schema.$defs)) throw new Error('Schema definitions are invalid.');
  return schema.$defs;
}

function definition(definitions: JsonObject, name: string): JsonObject {
  const value = definitions[name];
  if (!isJsonObject(value)) throw new Error(`Schema definition ${name} is invalid.`);
  return value;
}

describe('hierarchical workflow JSON Schema', () => {
  it('strictly parses closed contracts and resolves every local and external reference', async () => {
    const schemas = await loadSchemas();
    expect(schemas.workflow.oneOf).toEqual([
      { $ref: '#/$defs/purposeInput' },
      { $ref: '#/$defs/childReviewInput' },
      { $ref: '#/$defs/finalizeInput' },
      { $ref: '#/$defs/runRecord' },
      { $ref: '#/$defs/status' },
      { $ref: '#/$defs/startResult' },
      { $ref: '#/$defs/submitResult' },
      { $ref: '#/$defs/childReviewResult' },
      { $ref: '#/$defs/childReviewView' },
      { $ref: '#/$defs/reviewView' },
      { $ref: '#/$defs/finalizeResult' },
      { $ref: '#/$defs/approveResult' },
    ]);

    for (const objectSchema of collectObjectSchemas(schemas.workflow)) {
      expect(objectSchema.additionalProperties).toBe(false);
    }

    const documents = new Map<string, unknown>([
      ['', schemas.workflow],
      ['hierarchical-corpus.schema.json', schemas.corpus],
      ['hierarchical-current-session.schema.json', schemas.currentSession],
    ]);
    for (const reference of collectReferences(schemas.workflow)) {
      const [path = '', fragment = ''] = reference.split('#', 2);
      const document = documents.get(path);
      expect(document, `missing schema document for ${reference}`).toBeDefined();
      expect(
        resolvesJsonPointer(document, fragment),
        `unresolved schema reference ${reference}`,
      ).toBe(true);
    }

    for (const [path, schema] of [
      ['hierarchical-corpus.schema.json', schemas.corpus],
      ['hierarchical-current-session.schema.json', schemas.currentSession],
    ] as const) {
      const externalDocuments = new Map<string, unknown>([
        ['', schema],
        ['hierarchical-corpus.schema.json', schemas.corpus],
      ]);
      for (const reference of collectReferences(schema)) {
        const [referencePath = '', fragment = ''] = reference.split('#', 2);
        const document = externalDocuments.get(referencePath);
        expect(document, `missing ${path} dependency for ${reference}`).toBeDefined();
        expect(
          resolvesJsonPointer(document, fragment),
          `unresolved ${path} reference ${reference}`,
        ).toBe(true);
      }
    }
  });

  it('keeps input, persisted run, status, and result contracts exact', async () => {
    const { workflow } = await loadSchemas();
    const definitions = schemaDefinitions(workflow);

    expect(definition(definitions, 'purposeInput').required).toEqual([
      'schemaVersion', 'projectId', 'audience', 'goals', 'keyQuestions',
      'scopeHints', 'excludedTopics', 'outputLanguage', 'requestedPageRoles',
    ]);
    expect(definition(definitions, 'childReviewInput').required).toEqual([
      'schemaVersion', 'projectId', 'runId', 'pageId', 'reviewViewDigest',
      'decision', 'reasonCodes',
    ]);
    expect(definition(definitions, 'finalizeInput').required).toEqual([
      'schemaVersion', 'projectId', 'runId', 'reviewDigest', 'surfaceDigest',
      'candidateDecisions', 'relationDecisions',
    ]);
    expect(definition(definitions, 'runRecord').required).toEqual([
      'schemaVersion', 'projectId', 'runId', 'revision', 'phase', 'purpose',
      'baselineAuthorityDigest', 'baselineState', 'baselineProposals', 'startDigests',
      'submissions', 'childDecisions', 'integratedDecisions', 'relationDecisions',
      'rejection', 'approvalDecision', 'pendingExchangeDigest',
      'pendingChildReviewDigest', 'pendingReviewDigest', 'pendingLedgerDigest',
      'recordDigest',
    ]);
    expect(definition(definitions, 'status').required).toEqual([
      'schemaVersion', 'projectId', 'runId', 'revision', 'phase', 'purpose',
      'nextAction', 'currentExchange', 'childReview', 'review', 'ledger', 'rejection',
      'activationState', 'authorityCheckStatus', 'authorityCheck', 'egress',
      'providerUsed', 'processSpawned',
    ]);
    expect(definition(definitions, 'approveResult').required).toEqual([
      'schemaVersion', 'projectId', 'runId', 'approvalDigest', 'generationDigest',
      'activationBundlePath', 'activationBundleDigest', 'activationArgs', 'egress',
      'providerUsed', 'processSpawned',
    ]);
  });

  it('matches runtime bounds, digest bases, and the eight-argument activation handoff',
    async () => {
      const { workflow } = await loadSchemas();
      const definitions = schemaDefinitions(workflow);
      const purposeProperties = definition(
        definition(definitions, 'purposeInput'),
        'properties',
      );
      const audience = definition(purposeProperties, 'audience');
      const scopeHints = definition(purposeProperties, 'scopeHints');
      expect(audience.allOf).toEqual([
        { $ref: 'hierarchical-corpus.schema.json#/$defs/purposeTextList' },
        { minItems: 1 },
      ]);
      expect(scopeHints).toEqual({
        $ref: 'hierarchical-corpus.schema.json#/$defs/purposeTextList',
      });
      expect(definition(definitions, 'purposeInput')['x-buildlore-maxUtf8Bytes'])
        .toBe(262_144);
      expect(definition(definitions, 'runRecord')['x-buildlore-maxUtf8Bytes'])
        .toBe(67_108_864);
      expect(definition(definitions, 'runRecord')['x-buildlore-digestExcludes'])
        .toEqual(['recordDigest']);
      expect(definition(definitions, 'childReviewView')['x-buildlore-digestExcludes'])
        .toEqual(['reviewViewDigest']);
      expect(definition(definitions, 'reviewView')['x-buildlore-digestExcludes'])
        .toEqual(['reviewDigest']);

      const approveProperties = definition(
        definition(definitions, 'approveResult'),
        'properties',
      );
      const activationArgs = definition(approveProperties, 'activationArgs');
      expect(activationArgs).toMatchObject({ items: false, minItems: 8, maxItems: 8 });
      expect(activationArgs.prefixItems).toEqual([
        { const: 'compile' },
        { const: 'activate' },
        { const: '--project' },
        { $ref: '#/$defs/projectId' },
        { const: '--input' },
        { $ref: '#/$defs/activationBundlePath' },
        { const: '--confirm-approval' },
        { $ref: '#/$defs/digest' },
      ]);
    });

  it('does not persist provider, process, path, credential, or raw trace fields', async () => {
    const { workflow } = await loadSchemas();
    const definitions = schemaDefinitions(workflow);
    const persistedDefinitions = Object.fromEntries([
      'runRecord',
      'storedSubmission',
      'storedChildDecision',
      'storedIntegratedDecision',
      'storedRelationDecision',
      'startDigests',
      'rejection',
      'approvalDecision',
    ].map((name) => [name, definitions[name]]));
    const serialized = JSON.stringify(persistedDefinitions).toLowerCase();

    for (const unsafeField of [
      'absolutepath', 'accesstoken', 'apikey', 'authorization', 'credential',
      'privatekey', 'providerused', 'processspawned', 'rawstdout', 'rawstderr',
      'tooltrace',
    ]) {
      expect(serialized).not.toContain(`"${unsafeField}"`);
    }
  });
});
