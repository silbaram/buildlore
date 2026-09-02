import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CompilerWikiBackend } from '../src/compiler/types.js';
import {
  bindLocalProject,
  initializeLocalProjectRegistry,
} from '../src/knowledge/local-project-registry.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';
import { addProject } from '../src/knowledge/index.js';
import {
  createWikiExportService,
  type WikiSnapshotPort,
} from '../src/wiki/index.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const DEFAULT_PAGE_BODY = 'A sanitized, project-confined Wiki page.';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd, env: { ...process.env, LC_ALL: 'C' } });
}

function wiki(
  digests: readonly `sha256:${string}`[] = [`sha256:${'1'.repeat(64)}`],
  citationIdOverride?: string,
  pageBody: string = DEFAULT_PAGE_BODY,
): WikiSnapshotPort {
  let call = 0;
  const range = { endColumn: 12, endLine: 3, startColumn: 1, startLine: 2 };
  const sourceRevision = `sha256:${'d'.repeat(64)}` as const;
  const citationId = citationIdOverride ?? `citation-${sha256(serializeCanonicalJson({
    pageRef: 'concepts/portable-wiki',
    projectId: 'alpha',
    range,
    sourceRef: 'docs/portable.md',
    sourceRevision,
  }))}`;
  return Object.freeze({
    snapshot: vi.fn(() => {
      const digest = digests[Math.min(call, digests.length - 1)] as `sha256:${string}`;
      call += 1;
      return Promise.resolve({
        digest,
        pages: [{
          body: pageBody,
          citations: [{
            citationId,
            pageRef: 'concepts/portable-wiki' as const,
            projectId: 'alpha',
            range,
            sourceRef: 'docs/portable.md',
            sourceRevision,
          }],
          pageRef: 'concepts/portable-wiki' as const,
          sourceRefs: ['markdown--' + 'a'.repeat(64) + '.md'],
          summary: 'Portable local knowledge.',
          title: 'Portable Wiki',
        }],
        projectId: 'alpha',
      });
    }),
  });
}

async function fixture(
  options: {
    readonly extraOkfPage?: boolean;
    readonly hardlinkedOkfPage?: boolean;
    readonly pageBody?: string;
    readonly tamperedOkfPage?: boolean;
    readonly tamperedOkfPageWithExpectedHash?: boolean;
  } = {},
): Promise<Readonly<{
  readonly backend: CompilerWikiBackend;
  readonly hardlinkTarget: string;
  readonly hubRoot: string;
  readonly knowledgeRoot: string;
  readonly okfCalls: readonly string[];
}>> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-wiki-export-'));
  temporaryRoots.push(root);
  const hubRoot = join(root, 'hub');
  const knowledgeRoot = join(hubRoot, 'knowledge');
  const sourceRoot = join(root, 'source');
  await Promise.all([
    mkdir(knowledgeRoot, { recursive: true }),
    mkdir(sourceRoot),
  ]);
  await git(sourceRoot, ['init', '--initial-branch=main']);
  await git(sourceRoot, ['config', 'user.name', 'BuildLore Test']);
  await git(sourceRoot, ['config', 'user.email', 'buildlore@example.invalid']);
  await writeFile(join(sourceRoot, 'README.md'), '# Source\n');
  await git(sourceRoot, ['add', 'README.md']);
  await git(sourceRoot, ['commit', '-m', 'seed']);
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });
  await initializeLocalProjectRegistry(hubRoot);
  await bindLocalProject(hubRoot, {
    expectedBindingDigest: null,
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
    sourceRoot,
  });
  const hardlinkTarget = join(root, 'hardlink-sentinel.md');
  const okfCalls: string[] = [];
  const exportProjectOkf = vi.fn(async (_workspace: string, outputRoot: string) => {
    okfCalls.push(outputRoot);
    const pageRoot = join(outputRoot, 'concepts');
    const referenceRoot = join(outputRoot, 'references');
    await Promise.all([
      mkdir(pageRoot, { recursive: true }),
      mkdir(referenceRoot, { recursive: true }),
    ]);
    const index = join(outputRoot, 'index.md');
    const log = join(outputRoot, 'log.md');
    const page = join(pageRoot, 'portable-wiki.md');
    const reference = join(referenceRoot, 'source.md');
    const expectedPageBody = options.pageBody ?? DEFAULT_PAGE_BODY;
    const pageBody = options.tamperedOkfPage === true ||
        options.tamperedOkfPageWithExpectedHash === true
      ? 'Different but superficially safe Wiki content.'
      : expectedPageBody;
    const hashedBody = options.tamperedOkfPageWithExpectedHash === true
      ? expectedPageBody
      : pageBody;
    const pageContents = [
      '---',
      'description: Portable local knowledge.',
      'foreign-project-note: safe-cross-project-sentinel',
      'title: Portable Wiki',
      'type: concept',
      'x-llmwiki:',
      `  contentHash: ${sha256(`${hashedBody}\n`)}`,
      '  schemaVersion: "0.1"',
      '---',
      pageBody,
      '',
      '# Citations',
      '',
      '1. [source:1](/references/source.md)',
      '',
    ].join('\n');
    const writePage = options.hardlinkedOkfPage === true
      ? writeFile(hardlinkTarget, pageContents).then(async () => link(hardlinkTarget, page))
      : writeFile(page, pageContents);
    await Promise.all([
      writeFile(index, '---\nokf_version: "0.1"\n---\n# raw-index-sentinel\n'),
      writeFile(log, '# Log\n\nsafe-log-sentinel\n'),
      writePage,
      writeFile(reference, 'sk-this-source-body-must-never-be-published\n'),
    ]);
    const extra = join(pageRoot, 'foreign-project.md');
    if (options.extraOkfPage === true) await writeFile(extra, '# Foreign\n');
    return {
      outDir: outputRoot,
      warnings: [],
      writtenPaths: [
        index,
        log,
        page,
        reference,
        ...(options.extraOkfPage === true ? [extra] : []),
      ],
    };
  });
  const backend: CompilerWikiBackend = {
    exportProjectOkf,
    getProjectPage: vi.fn(() => Promise.resolve(null)),
    listProjectPages: vi.fn(() => Promise.resolve({ pages: [] })),
  };
  return { backend, hardlinkTarget, hubRoot, knowledgeRoot, okfCalls };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('project-confined Wiki export', () => {
  it('publishes a canonical JSON bundle without exposing a local destination', async () => {
    const current = await fixture();
    const parent = join(current.hubRoot, 'exports');
    await mkdir(parent);
    const outputRoot = join(parent, 'json');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki(),
    });

    const result = await service.export({ format: 'json', outputRoot, projectId: 'alpha' });
    expect(result).toMatchObject({
      fileCount: 1,
      format: 'json',
      pageCount: 1,
      projectId: 'alpha',
      schemaVersion: 'buildlore.wiki-export.v1',
    });
    expect(result).not.toHaveProperty('outputRoot');
    const exported: unknown = JSON.parse(
      await readFile(join(outputRoot, 'buildlore.wiki.json'), 'utf8'),
    );
    expect(exported).toMatchObject({
      format: 'json',
      pages: [{ pageRef: 'concepts/portable-wiki' }],
      projectId: 'alpha',
      schemaVersion: 'buildlore.wiki-export.v1',
    });
    expect(JSON.stringify(exported)).not.toContain(current.hubRoot);
  });

  it('rejects a citation id that is not derived from its canonical mapping', async () => {
    const current = await fixture();
    const parent = join(current.hubRoot, 'exports');
    await mkdir(parent);
    const outputRoot = join(parent, 'invalid-citation');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki([`sha256:${'1'.repeat(64)}`], `citation-${'c'.repeat(64)}`),
    });

    await expect(service.export({ format: 'json', outputRoot, projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'WIKI_CONTRACT_INVALID' });
    await expect(readdir(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes only deterministic snapshot-owned OKF content', async () => {
    const current = await fixture();
    const parent = join(current.hubRoot, 'exports');
    await mkdir(parent);
    const outputRoot = join(parent, 'okf');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki(),
    });

    const result = await service.export({ format: 'okf', outputRoot, projectId: 'alpha' });
    expect(result).toMatchObject({ fileCount: 2, format: 'okf', pageCount: 1 });
    expect(current.okfCalls).toHaveLength(1);
    await expect(readdir(outputRoot)).resolves.toEqual(['concepts', 'index.md']);
    const page = await readFile(join(outputRoot, 'concepts', 'portable-wiki.md'), 'utf8');
    const index = await readFile(join(outputRoot, 'index.md'), 'utf8');
    expect(page).toContain('docs/portable.md');
    expect(page).toContain('buildlore.wiki-export.v1');
    expect(page).not.toContain('source:1');
    expect(page).not.toContain('/references/');
    expect(page).not.toContain('sk-this-source-body');
    expect(page).not.toContain('safe-cross-project-sentinel');
    expect(index).not.toContain('raw-index-sentinel');
    expect(index).not.toContain('safe-log-sentinel');
  });

  it('preserves a snapshot-owned Citations section in the normalized page body', async () => {
    const pageBody = [
      DEFAULT_PAGE_BODY,
      '',
      '# Citations',
      '',
      'This heading is part of the approved Wiki body.',
    ].join('\n');
    const current = await fixture({ pageBody });
    const parent = join(current.hubRoot, 'exports');
    await mkdir(parent);
    const outputRoot = join(parent, 'okf-citations-body');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki([`sha256:${'1'.repeat(64)}`], undefined, pageBody),
    });

    await expect(service.export({ format: 'okf', outputRoot, projectId: 'alpha' }))
      .resolves.toMatchObject({ format: 'okf', pageCount: 1 });
    await expect(readFile(join(outputRoot, 'concepts/portable-wiki.md'), 'utf8'))
      .resolves.toContain('This heading is part of the approved Wiki body.');
  });

  it('rejects a hardlinked SDK OKF page before normalization', async () => {
    const current = await fixture({ hardlinkedOkfPage: true });
    const parent = join(current.hubRoot, 'exports');
    await mkdir(parent);
    const outputRoot = join(parent, 'okf-hardlink');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki(),
    });

    await expect(service.export({ format: 'okf', outputRoot, projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'WIKI_CONTRACT_INVALID' });
    const sentinel = await readFile(current.hardlinkTarget, 'utf8');
    expect(sentinel).toContain('/references/source.md');
    await expect(readdir(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a non-empty destination without overwriting it', async () => {
    const current = await fixture();
    const outputRoot = join(current.hubRoot, 'exports', 'existing');
    await mkdir(outputRoot, { recursive: true });
    await writeFile(join(outputRoot, 'keep.txt'), 'preserve me\n');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki(),
    });

    await expect(service.export({ format: 'json', outputRoot, projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'WIKI_EXPORT_DESTINATION_INVALID' });
    await expect(readFile(join(outputRoot, 'keep.txt'), 'utf8')).resolves.toBe('preserve me\n');
  });

  it('rejects an OKF export whose page set exceeds the validated project snapshot', async () => {
    const current = await fixture({ extraOkfPage: true });
    const parent = join(current.hubRoot, 'exports');
    await mkdir(parent);
    const outputRoot = join(parent, 'okf-extra');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki(),
    });

    await expect(service.export({ format: 'okf', outputRoot, projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'WIKI_CONTRACT_INVALID' });
    await expect(readdir(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an OKF page whose content identity is not bound to the snapshot', async () => {
    const current = await fixture({ tamperedOkfPage: true });
    const parent = join(current.hubRoot, 'exports');
    await mkdir(parent);
    const outputRoot = join(parent, 'okf-tampered');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki(),
    });

    await expect(service.export({ format: 'okf', outputRoot, projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'WIKI_CONTRACT_INVALID' });
    await expect(readdir(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a safe OKF body that reuses the expected snapshot hash', async () => {
    const current = await fixture({ tamperedOkfPageWithExpectedHash: true });
    const parent = join(current.hubRoot, 'exports');
    await mkdir(parent);
    const outputRoot = join(parent, 'okf-fixed-hash-tamper');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki(),
    });

    await expect(service.export({ format: 'okf', outputRoot, projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'WIKI_CONTRACT_INVALID' });
    await expect(readdir(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a destination inside another registered project source checkout', async () => {
    const current = await fixture();
    const betaRoot = join(current.hubRoot, '..', 'beta-source');
    await mkdir(betaRoot);
    await git(betaRoot, ['init', '--initial-branch=main']);
    await git(betaRoot, ['config', 'user.name', 'BuildLore Test']);
    await git(betaRoot, ['config', 'user.email', 'buildlore@example.invalid']);
    await writeFile(join(betaRoot, 'README.md'), '# Beta\n');
    await git(betaRoot, ['add', 'README.md']);
    await git(betaRoot, ['commit', '-m', 'seed beta']);
    await addProject(current.knowledgeRoot, {
      displayName: 'Beta',
      projectId: 'beta',
      sourceRepository: 'https://example.test/beta.git',
    });
    await bindLocalProject(current.hubRoot, {
      expectedBindingDigest: null,
      projectId: 'beta',
      sourceRepository: 'https://example.test/beta.git',
      sourceRoot: betaRoot,
    });
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki(),
    });

    await expect(service.export({
      format: 'json',
      outputRoot: join(betaRoot, 'export'),
      projectId: 'alpha',
    })).rejects.toMatchObject({ code: 'WIKI_EXPORT_DESTINATION_INVALID' });
  });

  it('refuses publication when the validated Wiki snapshot changes during export', async () => {
    const current = await fixture();
    const parent = join(current.hubRoot, 'exports');
    await mkdir(parent);
    const outputRoot = join(parent, 'changed');
    const service = createWikiExportService({
      backend: current.backend,
      hubRoot: current.hubRoot,
      knowledgeRoot: current.knowledgeRoot,
      wiki: wiki([
        `sha256:${'1'.repeat(64)}`,
        `sha256:${'2'.repeat(64)}`,
      ]),
    });

    await expect(service.export({ format: 'json', outputRoot, projectId: 'alpha' }))
      .rejects.toMatchObject({ code: 'WIKI_SNAPSHOT_CHANGED' });
    await expect(readFile(join(outputRoot, 'buildlore.wiki.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
