import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectReferences(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectReferences(item));
  }
  if (!isJsonObject(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => (
    key === '$ref' && typeof item === 'string'
      ? [item]
      : collectReferences(item)
  ));
}

function collectObjectSchemas(value: unknown): readonly JsonObject[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObjectSchemas(item));
  }
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

describe('hierarchical current-session JSON Schema', () => {
  it('publishes closed local and authorized external contracts with resolvable references', async () => {
    const [currentSessionSchema, corpusSchema] = await Promise.all([
      readFile(
        new URL('../schemas/hierarchical-current-session.schema.json', import.meta.url),
        'utf8',
      ),
      readFile(new URL('../schemas/hierarchical-corpus.schema.json', import.meta.url), 'utf8'),
    ]).then(([currentSession, corpus]) => [
      JSON.parse(currentSession) as unknown,
      JSON.parse(corpus) as unknown,
    ]);

    expect(isJsonObject(currentSessionSchema)).toBe(true);
    expect(isJsonObject(corpusSchema)).toBe(true);
    if (!isJsonObject(currentSessionSchema) || !isJsonObject(corpusSchema)) return;

    expect(currentSessionSchema.oneOf).toEqual([
      { $ref: '#/$defs/generationExchange' },
      { $ref: '#/$defs/proposalSubmission' },
      { $ref: '#/$defs/generationReceipt' },
      { $ref: '#/$defs/externalGenerationPayload' },
      { $ref: '#/$defs/externalGenerationExecutionRequest' },
      { $ref: '#/$defs/externalGenerationProposalSubmission' },
      { $ref: '#/$defs/externalGenerationProviderReceipt' },
      { $ref: '#/$defs/externalGenerationAudit' },
    ]);
    expect(isJsonObject(currentSessionSchema.$defs)).toBe(true);
    if (!isJsonObject(currentSessionSchema.$defs)) return;
    expect(Object.keys(currentSessionSchema.$defs)).toEqual([
      'generationExchange',
      'proposalSubmission',
      'generationReceipt',
      'externalGenerationPayload',
      'externalGenerationExecutionRequest',
      'externalGenerationProposalSubmission',
      'externalGenerationProviderReceipt',
      'externalGenerationAudit',
    ]);

    for (const objectSchema of collectObjectSchemas(currentSessionSchema)) {
      expect(objectSchema.additionalProperties).toBe(false);
    }

    const documents = new Map<string, unknown>([
      ['', currentSessionSchema],
      ['hierarchical-corpus.schema.json', corpusSchema],
    ]);
    for (const reference of collectReferences(currentSessionSchema)) {
      const [path = '', fragment = ''] = reference.split('#', 2);
      const document = documents.get(path);
      expect(document, `missing schema document for ${reference}`).toBeDefined();
      expect(
        resolvesJsonPointer(document, fragment),
        `unresolved schema reference ${reference}`,
      ).toBe(true);
    }

    for (const reference of collectReferences(corpusSchema)) {
      const [path = '', fragment = ''] = reference.split('#', 2);
      expect(path, `unexpected external corpus reference ${reference}`).toBe('');
      expect(
        resolvesJsonPointer(corpusSchema, fragment),
        `unresolved corpus schema reference ${reference}`,
      ).toBe(true);
    }
  });

  it('keeps the agent and authorized external audit boundaries exact', async () => {
    const schema = JSON.parse(await readFile(
      new URL('../schemas/hierarchical-current-session.schema.json', import.meta.url),
      'utf8',
    )) as {
      readonly $defs: {
        readonly generationExchange: JsonObject;
        readonly proposalSubmission: JsonObject;
        readonly generationReceipt: JsonObject;
        readonly externalGenerationPayload: JsonObject;
        readonly externalGenerationProviderReceipt: JsonObject;
        readonly externalGenerationAudit: JsonObject;
      };
    };
    const serialized = JSON.stringify(schema);

    expect(serialized).toContain('buildlore.current-session-generation-exchange.v1');
    expect(serialized).toContain('buildlore.current-session-proposal-submission.v1');
    expect(serialized).toContain('buildlore.current-session-generation-receipt.v1');
    expect(serialized).toContain('buildlore.external-generation-payload.v1');
    expect(serialized).toContain('buildlore.external-generation-execution-request.v1');
    expect(serialized).toContain('buildlore.external-generation-provider-receipt.v1');
    expect(serialized).toContain('buildlore.external-generation-audit.v1');
    expect(serialized).toContain('sanitized-evidence-only');
    expect(serialized).toContain('current-agent-session');
    expect(serialized).toContain('buildlore.sanitizer-rules.v5');
    expect(serialized).toContain('sanitizerInputDigest');
    expect(serialized).not.toContain('claimId');
    expect(schema.$defs.generationExchange['x-buildlore-maxUtf8Bytes']).toBe(524_288);
    expect(schema.$defs.proposalSubmission['x-buildlore-maxUtf8Bytes']).toBe(524_288);
    const receiptRequired = schema.$defs.generationReceipt.required;
    expect(receiptRequired).toEqual(expect.arrayContaining([
      'purposeDigest',
      'blueprintDigest',
      'evidencePackDigest',
      'snapshotDigest',
    ]));
    expect(schema.$defs.generationReceipt['x-buildlore-digestExcludes'])
      .toEqual(['receiptDigest']);
    expect(schema.$defs.externalGenerationPayload['x-buildlore-digestExcludes'])
      .toEqual(['sanitizedPayloadScopeDigest']);
    expect(schema.$defs.externalGenerationProviderReceipt['x-buildlore-digestExcludes'])
      .toEqual(['receiptDigest']);
    expect(schema.$defs.externalGenerationAudit['x-buildlore-digestExcludes'])
      .toEqual(['auditDigest']);
  });
});
