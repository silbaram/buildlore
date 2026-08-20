import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createSourceDocument,
  MAX_SOURCE_BODY_CHARS,
  parseSourceDocument,
  renderSourceDocument,
  SourceDocumentError,
  validateSourceDocument,
} from '../src/projector/index.js';

const revision = `sha256:${'a'.repeat(64)}` as const;

function fixture(body = '승인된 제품 명세입니다.'): ReturnType<typeof createSourceDocument> {
  return createSourceDocument({
    body,
    ingestedAt: '2026-08-19T23:00:00.000Z',
    producer: 'p2a',
    projectId: 'buildlore',
    source: 'buildlore+p2a:https%3A%2F%2Fexample.test%2Fbuildlore.git/v1/product-spec',
    sourceKind: 'planning',
    sourceRevision: revision,
    sourceType: 'file',
    title: '제품 명세 "v1"',
  });
}

describe('SourceDocument', () => {
  it('renders fixed-order byte-identical Markdown and round-trips it', () => {
    const document = fixture();
    const contentHash = `sha256:${createHash('sha256').update(document.body).digest('hex')}`;
    const expected = `---
title: "제품 명세 \\"v1\\""
source: "buildlore+p2a:https%3A%2F%2Fexample.test%2Fbuildlore.git/v1/product-spec"
ingestedAt: "2026-08-19T23:00:00.000Z"
sourceType: "file"
buildlore:
  schemaVersion: "buildlore.source.v1"
  sourceKind: "planning"
  producer: "p2a"
  projectId: "buildlore"
  sourceRevision: "${revision}"
  contentHash: "${contentHash}"
---

승인된 제품 명세입니다.
`;
    expect(renderSourceDocument(document)).toBe(expected);
    expect(parseSourceDocument(expected)).toEqual(document);
    expect(renderSourceDocument(parseSourceDocument(expected))).toBe(expected);
  });

  it('normalizes line endings and applies the upstream UTF-16 truncation boundary', () => {
    const document = fixture(`${'가'.repeat(MAX_SOURCE_BODY_CHARS)}\r\n끝`);
    expect(document.truncated).toBe(true);
    expect(document.originalChars).toBe(MAX_SOURCE_BODY_CHARS + 2);
    expect(document.body).toBe(`${'가'.repeat(MAX_SOURCE_BODY_CHARS)}\n`);
    expect(parseSourceDocument(renderSourceDocument(document))).toEqual(document);
  });

  it('omits truncation metadata at exactly 100000 code units', () => {
    const document = fixture('x'.repeat(MAX_SOURCE_BODY_CHARS));
    expect(document.truncated).toBeUndefined();
    expect(document.originalChars).toBeUndefined();
    expect(document.body.length).toBe(MAX_SOURCE_BODY_CHARS + 1);
  });

  it('requires a truncated payload to contain exactly the upstream limit', () => {
    const document = fixture('short body');
    const body = 'x\n';
    expect(() => validateSourceDocument({
      ...document,
      body,
      buildlore: {
        ...document.buildlore,
        contentHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      },
      originalChars: MAX_SOURCE_BODY_CHARS + 1,
      truncated: true,
    })).toThrowError(SourceDocumentError);
  });

  it('matches JavaScript slicing when truncation splits an astral character', () => {
    const document = fixture(`${'x'.repeat(MAX_SOURCE_BODY_CHARS - 1)}😀Z`);
    expect(document.originalChars).toBe(MAX_SOURCE_BODY_CHARS + 2);
    expect(document.truncated).toBe(true);
    expect(document.body).toBe(`${'x'.repeat(MAX_SOURCE_BODY_CHARS - 1)}�\n`);
  });

  it('rejects duplicate YAML keys, aliases, invalid hashes, and unsafe bodies safely', () => {
    const canonical = renderSourceDocument(fixture());
    const duplicate = canonical.replace('title:', 'title: "duplicate"\ntitle:');
    expect(() => parseSourceDocument(duplicate)).toThrowError(SourceDocumentError);
    const alias = canonical.replace('title: "', 'title: &title "').replace(
      /^source: .*$/mu,
      'source: *title',
    );
    expect(() => parseSourceDocument(alias)).toThrowError(SourceDocumentError);
    const invalidHash = canonical.replace(
      /contentHash: "sha256:[a-f0-9]+"/u,
      `contentHash: "sha256:${'0'.repeat(64)}"`,
    );
    expect(() => parseSourceDocument(invalidHash)).toThrowError(SourceDocumentError);
    const customTag = canonical.replace('title: ', 'title: !unsupported ');
    expect(() => parseSourceDocument(customTag)).toThrowError(SourceDocumentError);
    const documentEnd = canonical.replace(/^source:/mu, '...\nsource:');
    expect(() => parseSourceDocument(documentEnd)).toThrowError(SourceDocumentError);
    const nestedUnknown = canonical.replace(
      '  contentHash:',
      '  unsupported: "value"\n  contentHash:',
    );
    expect(() => parseSourceDocument(nestedUnknown)).toThrowError(SourceDocumentError);
    expect(() => fixture('unsafe\0value')).toThrowError(SourceDocumentError);
    expect(() => fixture('unsafe\u0085value')).toThrowError(SourceDocumentError);
    expect(() => fixture('\ud800')).toThrowError(SourceDocumentError);
    expect(() => createSourceDocument({
      ...fixture().buildlore,
      body: 'valid body',
      ingestedAt: '2026-02-30T00:00:00Z',
      source: 'https://example.test/source',
      sourceRevision: revision,
      title: 'Invalid timestamp',
    })).toThrowError(SourceDocumentError);
    expect(() => createSourceDocument({
      body: 'valid body',
      ingestedAt: '2026-08-19T00:00:00Z',
      producer: 'p2a',
      projectId: 'buildlore',
      source: 'https://example.test/source',
      sourceKind: 'planning',
      sourceRevision: revision,
      title: 'unsafe\nmetadata',
    })).toThrowError(SourceDocumentError);
    expect(() => createSourceDocument({
      body: 'valid body',
      ingestedAt: '2026-08-19T00:00:00Z',
      producer: 'p2a',
      projectId: 'buildlore',
      source: 'https://example.test/source\nforged',
      sourceKind: 'planning',
      sourceRevision: revision,
      title: 'safe title',
    })).toThrowError(SourceDocumentError);
    expect(() => parseSourceDocument(`---\ntitle: "x"\n---\n\n${'x'.repeat(513 * 1024)}`))
      .toThrowError(SourceDocumentError);
  });

  it('ignores bounded unknown top-level frontmatter on canonical re-render', () => {
    const canonical = renderSourceDocument(fixture());
    const extended = canonical.replace('buildlore:\n', 'producerNote: "ignored"\nbuildlore:\n');
    expect(renderSourceDocument(parseSourceDocument(extended))).toBe(canonical);
  });

  it('escapes Unicode line separators in metadata without changing their value', () => {
    const value = createSourceDocument({
      body: 'valid body',
      ingestedAt: '2026-08-19T00:00:00Z',
      producer: 'p2a',
      projectId: 'buildlore',
      source: 'https://example.test/source',
      sourceKind: 'planning',
      sourceRevision: revision,
      title: 'line\u2028separator',
    });
    const markdown = renderSourceDocument(value);
    expect(markdown).toContain('title: "line\\u2028separator"');
    expect(parseSourceDocument(markdown).title).toBe(value.title);
  });

  it('never reflects rejected source content in its error', () => {
    const sentinel = 'DO-NOT-ECHO-SENTINEL';
    try {
      fixture(`${sentinel}\0`);
      expect.unreachable('unsafe fixture should fail');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(sentinel);
    }
  });
});
