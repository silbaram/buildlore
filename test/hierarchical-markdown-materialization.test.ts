import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import {
  HIERARCHICAL_MARKDOWN_INDEX_FILENAME,
  HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION,
  HIERARCHICAL_MARKDOWN_MAXIMUM_MANIFEST_BYTES,
  HIERARCHICAL_MARKDOWN_RENDERER_DIGEST,
  parseHierarchicalMarkdownManifest,
  prepareApprovedWikiPublication,
  renderHierarchicalMarkdown,
  type ApprovedWikiPublicationSnapshotV1,
} from '../src/retrieval/index.js';
import { createApprovedAuthorityFixture } from './helpers/hierarchical-authority-fixture.js';

const PROJECT_ID = 'markdown-materialization';
const POLICY_DIGEST = `sha256:${'a'.repeat(64)}` as const;

function sha256(body: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function digestValue(value: unknown): `sha256:${string}` {
  return sha256(serializeCanonicalJson(value));
}

function publication(): ApprovedWikiPublicationSnapshotV1 {
  return prepareApprovedWikiPublication(
    createApprovedAuthorityFixture(PROJECT_ID, POLICY_DIGEST),
    PROJECT_ID,
  );
}

describe('hierarchical Markdown materialization renderer', () => {
  it('renders byte-identical, path-safe Markdown and a lineage-bound manifest', () => {
    const approved = publication();
    const first = renderHierarchicalMarkdown({ publication: approved });
    const second = renderHierarchicalMarkdown({ publication: approved });

    expect(second).toEqual(first);
    expect(first.manifest).toMatchObject({
      authorityDigest: approved.authorityDigest,
      corpusDigest: approved.projection.corpus.corpusDigest,
      generationDigest: approved.projection.corpus.generationDigest,
      pageCount: approved.projection.corpus.pages.length,
      projectId: PROJECT_ID,
      projectionDigest: approved.projection.projectionDigest,
      recordDigest: approved.recordDigest,
      rendererDigest: HIERARCHICAL_MARKDOWN_RENDERER_DIGEST,
      sanitizerPolicyDigest: POLICY_DIGEST,
      schemaVersion: HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION,
    });
    expect(parseHierarchicalMarkdownManifest(
      JSON.parse(first.manifestBody) as unknown,
      PROJECT_ID,
    )).toEqual(first.manifest);
    expect(first.files.map((file) => file.path)).toEqual([
      HIERARCHICAL_MARKDOWN_INDEX_FILENAME,
      ...approved.projection.corpus.pages.map((page) => `${page.pageId}.md`).sort(),
    ]);
    expect(first.manifest.files).toEqual(first.files.map((file) =>
      Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'body'))));
    expect(first.files.every((file) =>
      file.body.endsWith('\n') && !file.body.includes('\r') &&
      Buffer.byteLength(file.body, 'utf8') === file.byteLength &&
      sha256(file.body) === file.sha256)).toBe(true);
    expect(first.files.every((file) => file.path === 'index.md' ||
      /^page-[a-f0-9]{64}\.md$/u.test(file.path))).toBe(true);
  });

  it('preserves approved content while resolving page-id Wiki links to readable local links', () => {
    const approved = publication();
    const rendered = renderHierarchicalMarkdown({ publication: approved });
    const pageBodies = rendered.files.filter((file) => file.kind === 'page')
      .map((file) => file.body).join('\n');

    for (const page of approved.projection.corpus.pages) {
      const file = rendered.files.find((candidate) => candidate.pageId === page.pageId);
      expect(file?.body).toContain(`# ${page.title}`);
      expect(file?.body).toContain(page.summary);
      expect(file?.body).toContain(`page_id: "${page.pageId}"`);
      expect(file?.body).toContain('## Navigation');
    }
    expect(pageBodies).not.toMatch(/\[\[page-[a-f0-9]{64}\]\]/u);
    expect(pageBodies).toMatch(/\[[^\]]+\]\(\.\/page-[a-f0-9]{64}\.md\)/u);
    expect(pageBodies).toMatch(/\[\^[a-z0-9._/-]+\]: source /u);
    expect(pageBodies).toContain('Direct edits are not authoritative.');
  });

  it('fails closed for an authority mismatch and non-exact manifest records', () => {
    const approved = publication();
    const tampered = structuredClone(approved) as unknown as {
      projection: { corpus: { pages: Array<{ title: string }> } };
    };
    const originalTitle = tampered.projection.corpus.pages[0]?.title;
    if (originalTitle === undefined) throw new Error('fixture page is unavailable');
    tampered.projection.corpus.pages[0]!.title = `${originalTitle} tampered`;
    expect(() => renderHierarchicalMarkdown({
      publication: tampered as unknown as ApprovedWikiPublicationSnapshotV1,
    })).toThrow(expect.objectContaining({ code: 'HIERARCHICAL_MARKDOWN_CONTRACT_INVALID' }));

    const rendered = renderHierarchicalMarkdown({ publication: approved });
    const manifest = JSON.parse(rendered.manifestBody) as {
      files: Array<Record<string, unknown>>;
    };
    manifest.files[0]!.pageId = `page-${'0'.repeat(64)}`;
    expect(() => parseHierarchicalMarkdownManifest(manifest, PROJECT_ID))
      .toThrow(expect.objectContaining({ code: 'HIERARCHICAL_MARKDOWN_CONTRACT_INVALID' }));
    expect(() => parseHierarchicalMarkdownManifest(
      JSON.parse(rendered.manifestBody) as unknown,
      'another-project',
    )).toThrow(expect.objectContaining({ code: 'HIERARCHICAL_MARKDOWN_CONTRACT_INVALID' }));
  });

  it('keeps the 4096-page manifest inside its dedicated byte limit', () => {
    const digest = `sha256:${'b'.repeat(64)}` as const;
    const files = Object.freeze([
      Object.freeze({ byteLength: 1, kind: 'index' as const, path: 'index.md', sha256: digest }),
      ...Array.from({ length: 4_096 }, (_, ordinal) => {
        const pageId = `page-${ordinal.toString(16).padStart(64, '0')}`;
        return Object.freeze({
          byteLength: 1,
          kind: 'page' as const,
          pageId,
          path: `${pageId}.md`,
          proposalDigest: digest,
          sha256: digest,
        });
      }),
    ]);
    const basis = Object.freeze({
      authorityDigest: digest,
      corpusDigest: digest,
      files,
      generationDigest: digest,
      pageCount: 4_096,
      projectId: PROJECT_ID,
      projectionDigest: digest,
      recordDigest: digest,
      rendererDigest: digest,
      sanitizerPolicyDigest: digest,
      schemaVersion: HIERARCHICAL_MARKDOWN_MANIFEST_SCHEMA_VERSION,
    });
    const manifest = Object.freeze({ ...basis, materializationDigest: digestValue(basis) });
    const body = serializeCanonicalJson(manifest);

    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(body, 'utf8'))
      .toBeLessThanOrEqual(HIERARCHICAL_MARKDOWN_MAXIMUM_MANIFEST_BYTES);
    expect(parseHierarchicalMarkdownManifest(JSON.parse(body) as unknown, PROJECT_ID))
      .toEqual(manifest);
  });
});
