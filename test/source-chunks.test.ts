import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { splitProjectSource, assertCompleteSourceChunks } from '../src/projector/source-chunks.js';
import { sourceChunkPayload } from '../src/projector/source-chunk-contract.js';
import { parseSourceDocument, normalizeSourceBody } from '../src/projector/source-document.js';
import { renderExpectedProjectSource, type ProjectSourceInput } from '../src/projector/project-source-writer.js';
import { createCollectionSourceIdentity, validateCollectionSourceIdentityBinding } from '../src/projector/source-identity.js';

export function longSourceInput(body: string, kind: 'markdown' | 'text' | 'code' = 'markdown'): ProjectSourceInput {
  const normalized = normalizeSourceBody(body);
  const lines = normalized.split('\n');
  const range = { startLine: 1, startColumn: 1, endLine: lines.length,
    endColumn: Array.from(lines.at(-1) ?? '').length + 1 };
  const revision = `sha256:${createHash('sha256').update(body).digest('hex')}` as const;
  const sourceUri = createCollectionSourceIdentity({ repository: 'https://example.test/alpha.git',
    projectId: 'alpha', declarationId: 'docs', documentKind: kind, sourceRef: 'README.md' });
  return { body, ingestedAt: '2026-09-20T00:00:00.000Z', sourceUri, sourceKind: kind,
    sourceRevision: revision, producer: 'buildlore', title: 'Long source',
    target: `${kind}--${createHash('sha256').update(sourceUri).digest('hex')}.md`,
    originMappings: [{ canonical: range, origin: range }], descriptor: {
      adapterId: 'buildlore.generic', adapterVersion: 1, schemaVersion: 'buildlore.source-descriptor.v1',
      kind, mediaType: kind === 'markdown' ? 'text/markdown' : 'text/plain',
      projectId: 'alpha', declarationId: 'docs', sourceRef: 'README.md', sourceUri,
      sourceRevision: revision, contentHash: revision,
    } };
}

function verify(body: string, kind: 'markdown' | 'text' | 'code' = 'markdown') {
  const input = longSourceInput(body, kind);
  const parts = splitProjectSource(input);
  const documents = parts.map((part) => parseSourceDocument(renderExpectedProjectSource(part, 'alpha')));
  expect(parts.length).toBeGreaterThan(1);
  expect(documents.map((doc) => sourceChunkPayload(doc.body, doc.buildlore.chunk!)).join(''))
    .toBe(normalizeSourceBody(body));
  for (const doc of documents) {
    expect(doc.body.length).toBeLessThanOrEqual(100_000);
    expect(doc.truncated).toBeUndefined();
    expect(doc.schemaVersion).toBe('buildlore.source.v4');
    expect(validateCollectionSourceIdentityBinding({ repository: 'https://example.test/alpha.git',
      projectId: 'alpha', documentKind: kind }, doc.source)).not.toBeNull();
  }
  expect(() => assertCompleteSourceChunks(documents)).not.toThrow();
  expect(splitProjectSource(input)).toEqual(parts);
  return { documents, parts };
}

describe('lossless source partitions', () => {
  it('keeps short source identity and serialized format unchanged', () => {
    const input = longSourceInput('hello\r\nworld\n');
    expect(splitProjectSource(input)).toEqual([input]);
    expect(parseSourceDocument(renderExpectedProjectSource(input, 'alpha')).schemaVersion).toBe('buildlore.source.v2');
  });

  it.each([99_999, 100_000, 100_001])('handles the %i unit boundary without upstream truncation', (length) => {
    const body = 'x'.repeat(length);
    if (length === 99_999) expect(splitProjectSource(longSourceInput(body))).toHaveLength(1);
    else verify(body);
  });

  it('preserves emoji and original columns across a very long single line', () => {
    const { documents } = verify('가😀'.repeat(75_000), 'text');
    let endColumn = 1;
    for (const doc of documents) {
      const mapping = doc.buildlore.originMappings![0]!;
      expect(mapping.origin.startLine).toBe(1);
      expect(mapping.origin.startColumn).toBe(endColumn);
      endColumn = mapping.origin.endColumn;
    }
    expect(endColumn).toBe(150_001);
  });

  it('prefers headings and retains all paragraph whitespace', () => {
    const body = `# Start\n${'paragraph words\n\n'.repeat(4000)}## Tail\n${'tail words\n\n'.repeat(5000)}END`;
    const { documents } = verify(body);
    expect(documents[1]!.body.startsWith('## Tail\n')).toBe(true);
    expect(documents.at(-1)!.body).toContain('END');
  });

  it('closes and reopens continued fenced code without adding to the payload', () => {
    const body = `\`\`\`typescript\n${'const value = 1;\n'.repeat(15000)}\`\`\``;
    const { documents } = verify(body, 'code');
    for (const doc of documents) {
      expect(doc.body.startsWith('```typescript\n')).toBe(true);
      expect(doc.body.endsWith('```\n')).toBe(true);
      expect(doc.body.match(/^```/gmu)).toHaveLength(2);
    }
  });

  it('retains large whitespace spans and arbitrary fence lengths', () => {
    verify(`begin\n${'\n'.repeat(205_000)}end`);
    verify(`${'`'.repeat(105_000)}\nbody\n${'`'.repeat(105_000)}`, 'code');
  });

  it('rejects missing, duplicate, mixed and tampered chunk sets', () => {
    const { documents } = verify('body words\n'.repeat(22000));
    expect(() => assertCompleteSourceChunks(documents.slice(1))).toThrow(/retry source sync/u);
    expect(() => assertCompleteSourceChunks([...documents, documents[0]!])).toThrow();
    expect(() => assertCompleteSourceChunks(documents.map((doc, i) => i === 1
      ? { ...doc, body: doc.body.replace('body', 'fake') } : doc))).toThrow();
    expect(() => parseSourceDocument(renderExpectedProjectSource({ ...splitProjectSource(longSourceInput('x'.repeat(100_001)))[1]!,
      sourceUri: 'buildlore+source:/other/other/text/docs/README.md/part/2' }, 'alpha'))).toThrow();
  });

  it('preserves the actual repository README including its tail', async () => {
    const body = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const { documents } = verify(body);
    expect(documents.at(-1)!.body).toContain(normalizeSourceBody(body).slice(-300));
  });
});
