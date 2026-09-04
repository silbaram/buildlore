import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

interface PackageContract {
  readonly bin: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly engines: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly files: readonly string[];
  readonly packageManager: string;
  readonly scripts: Readonly<Record<string, string>>;
}

interface PackageLockContract {
  readonly packages: Readonly<Record<string, {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly integrity?: string;
    readonly version?: string;
  }>>;
}

const compilerIntegrity =
  'sha512-LJslVmSt8tng8n3t0tw1QEqZJKKD0ualJ/WupdZMCtCzmCNarkP999k6hiNIg5ezvE8B/JQ1C1bUi6eY88Q79A==';

const approvedDevDependencies = {
  '@eslint/js': '10.0.1',
  '@types/node': '24.13.3',
  eslint: '10.8.1',
  globals: '17.11.0',
  typescript: '6.0.3',
  'typescript-eslint': '8.67.0',
  vitest: '4.1.11',
} as const;

const approvedRuntimeDependencies = {
  '@huggingface/transformers': '4.2.0',
  'llm-wiki-compiler': '1.1.0',
  yaml: '2.9.0',
} as const;

describe('package contract', () => {
  it('publishes closed v0.2 profile and bounded metadata schema contracts', async () => {
    const profile = JSON.parse(await readFile(
      new URL('../schemas/profile-binding.schema.json', import.meta.url),
      'utf8',
    )) as { readonly oneOf?: readonly unknown[] };
    const metadata = JSON.parse(await readFile(
      new URL('../schemas/source-metadata.schema.json', import.meta.url),
      'utf8',
    )) as Readonly<Record<string, unknown>>;
    const manifest = JSON.parse(await readFile(
      new URL('../schemas/source-collection-manifest-v2.schema.json', import.meta.url),
      'utf8',
    )) as Readonly<Record<string, unknown>>;
    const descriptor = JSON.parse(await readFile(
      new URL('../schemas/source-descriptor.schema.json', import.meta.url),
      'utf8',
    )) as Readonly<Record<string, unknown>>;
    const sourceDocument = JSON.parse(await readFile(
      new URL('../schemas/source-document-v2.schema.json', import.meta.url),
      'utf8',
    )) as Readonly<Record<string, unknown>>;
    const wikiExport = JSON.parse(await readFile(
      new URL('../schemas/wiki-export.schema.json', import.meta.url),
      'utf8',
    )) as Readonly<Record<string, unknown>>;
    const hierarchicalCorpus = JSON.parse(await readFile(
      new URL('../schemas/hierarchical-corpus.schema.json', import.meta.url),
      'utf8',
    )) as { readonly $defs: Readonly<Record<string, unknown>> };

    expect(profile.oneOf).toHaveLength(2);
    expect(metadata).toMatchObject({
      'x-buildlore-maxAggregateKeys': 64,
      'x-buildlore-maxDepth': 8,
      'x-buildlore-maxUtf8Bytes': 16_384,
    });
    expect(JSON.stringify(manifest)).toContain('source-metadata.schema.json');
    expect(JSON.stringify(descriptor)).toContain('source-metadata.schema.json');
    expect((metadata.$defs as Readonly<Record<string, unknown>>).sourceRef)
      .toEqual(hierarchicalCorpus.$defs.sourceRef);

    const descriptorContract = descriptor as unknown as {
      readonly properties: {
        readonly kind: { readonly enum: readonly string[] };
      };
      readonly $defs: {
        readonly relativePath: {
          readonly pattern: string;
          readonly 'x-buildlore-maxSegments': number;
          readonly 'x-buildlore-normalization': string;
        };
      };
    };
    expect(descriptorContract.properties.kind.enum).toEqual([
      'code',
      'execution',
      'markdown',
      'planning',
      'text',
    ]);
    const wikiContract = wikiExport as unknown as {
      readonly $id: string;
      readonly $defs: {
        readonly sourceRef: {
          readonly pattern: string;
          readonly 'x-buildlore-maxSegments': number;
          readonly 'x-buildlore-normalization': string;
        };
      };
      readonly 'x-buildlore-canonicalOrderBy': string;
      readonly 'x-buildlore-uniqueBy': string;
    };
    expect(wikiContract.$id).toBe('https://buildlore.local/schemas/wiki-export.schema.json');
    for (const contract of [
      descriptorContract.$defs.relativePath,
      wikiContract.$defs.sourceRef,
    ]) {
      const pattern = new RegExp(contract.pattern, 'u');
      expect(contract['x-buildlore-maxSegments']).toBe(64);
      expect(contract['x-buildlore-normalization']).toBe('NFC');
      expect(pattern.test('docs/guide.md')).toBe(true);
      expect(pattern.test('.buildlore/sources.json')).toBe(false);
      expect(pattern.test('.llmwiki/index.json')).toBe(false);
      expect(pattern.test('knowledge/projects/alpha.md')).toBe(false);
      expect(pattern.test('projects/alpha/wiki.md')).toBe(false);
      expect(pattern.test('sources/generated.md')).toBe(false);
      expect(pattern.test('wiki/generated.md')).toBe(false);
      expect(pattern.test('export/wiki.json')).toBe(false);
      expect(pattern.test('exports/wiki.json')).toBe(false);
      expect(pattern.test('docs/access-token/value.md')).toBe(false);
      expect(pattern.test('docs/guide\u2060.md')).toBe(false);
      expect(pattern.test(`${'a/'.repeat(64)}guide.md`)).toBe(false);
    }

    const sourceDocumentContract = sourceDocument as unknown as {
      readonly dependentRequired: Readonly<Record<string, readonly string[]>>;
      readonly properties: {
        readonly body: {
          readonly maxLength: number;
          readonly 'x-buildlore-contentHash': string;
          readonly 'x-buildlore-truncatedPayloadLength': number;
        };
        readonly buildlore: {
          readonly properties: {
            readonly originMappings: { readonly 'x-buildlore-boundedBy': string };
          };
        };
      };
      readonly $defs: {
        readonly range: { readonly 'x-buildlore-orderedRange': boolean };
        readonly rangeMapping: {
          readonly 'x-buildlore-equalLineSpan': readonly string[];
        };
      };
    };
    expect(sourceDocumentContract.dependentRequired).toEqual({
      originalChars: ['truncated'],
      truncated: ['originalChars'],
    });
    expect(sourceDocumentContract.properties.body).toMatchObject({
      maxLength: 100_001,
      'x-buildlore-contentHash': 'buildlore.contentHash',
      'x-buildlore-truncatedPayloadLength': 100_000,
    });
    expect(sourceDocumentContract.$defs.range['x-buildlore-orderedRange']).toBe(true);
    expect(sourceDocumentContract.$defs.rangeMapping['x-buildlore-equalLineSpan'])
      .toEqual(['canonical', 'origin']);
    expect(sourceDocumentContract.properties.buildlore.properties.originMappings[
      'x-buildlore-boundedBy'
    ]).toBe('body');
    expect(wikiContract['x-buildlore-canonicalOrderBy']).toBe('pages.pageRef');
    expect(wikiContract['x-buildlore-uniqueBy']).toBe('pages.pageRef');
  });

  it('ignores only repository-root generated test residue in the lint configuration', async () => {
    const eslintConfig = await readFile(
      new URL('../eslint.config.mjs', import.meta.url),
      'utf8',
    );

    expect(eslintConfig.match(/['"]\.test-tmp\/\*\*['"]/gu)).toHaveLength(1);
    expect(eslintConfig).toContain("'.test-tmp/**'");
    expect(eslintConfig).toContain("'node_modules/**'");
    expect(eslintConfig).not.toMatch(/['"](?:src|test|scripts)\/\*\*['"]/gu);

    const eslint = new ESLint({
      cwd: fileURLToPath(new URL('../', import.meta.url)),
    });
    await expect(eslint.isPathIgnored(
      '.test-tmp/buildlore-installed-cli-review/package/dist/index.js',
    )).resolves.toBe(true);
    for (const path of [
      'src/sanitizer/service.ts',
      'test/sanitizer-rules.test.ts',
      'scripts/bootstrap-p2a.mjs',
      '.other-generated/residue.ts',
    ]) {
      await expect(eslint.isPathIgnored(path)).resolves.toBe(false);
    }
  });

  it('pins the approved runtime and development toolchain exactly', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageContract;

    expect(packageJson.packageManager).toBe('npm@11.19.0');
    expect(packageJson.bin).toEqual({ buildlore: './dist/cli/bin.js' });
    expect(packageJson.exports['./schemas/source-document.schema.json']).toBe(
      './schemas/source-document.schema.json',
    );
    expect(packageJson.exports['./schemas/lifecycle-profile.schema.json']).toBe(
      './schemas/lifecycle-profile.schema.json',
    );
    expect(packageJson.exports['./schemas/retrieval-corpus.schema.json']).toBe(
      './schemas/retrieval-corpus.schema.json',
    );
    expect(packageJson.exports['./schemas/retrieval-evaluation.schema.json']).toBe(
      './schemas/retrieval-evaluation.schema.json',
    );
    for (const schema of [
      'knowledge-tracking-policy.schema.json',
      'knowledge-publish-plan.schema.json',
      'knowledge-publish-result.schema.json',
      'knowledge-commit-lineage.schema.json',
      'knowledge-parent-pin-plan.schema.json',
      'knowledge-parent-pin-result.schema.json',
      'local-project-registry.schema.json',
      'source-collection-manifest.schema.json',
      'source-collection-manifest-v2.schema.json',
      'source-descriptor.schema.json',
      'source-document-v2.schema.json',
      'source-metadata.schema.json',
      'profile-binding.schema.json',
      'wiki-export.schema.json',
      'compile-plan.schema.json',
      'compile-proposal.schema.json',
      'compile-apply-result.schema.json',
      'session-compile-provenance.schema.json',
      'session-review-candidate.schema.json',
      'session-candidate-list.schema.json',
      'session-candidate-approval.schema.json',
      'session-promotion-proof.schema.json',
      'hierarchical-corpus.schema.json',
      'hierarchical-current-session.schema.json',
      'hierarchical-workflow.schema.json',
      'hierarchical-wiki-activation.schema.json',
      'hierarchical-markdown-materialization.schema.json',
      'hierarchical-retrieval.schema.json',
      'local-embedding.schema.json',
      'llm-wiki-retrieval-evaluation.schema.json',
      'semantic-index.schema.json',
      'retrieval-result-v2.schema.json',
      'retrieval-result-v3.schema.json',
    ]) {
      expect(packageJson.exports[`./schemas/${schema}`]).toBe(`./schemas/${schema}`);
    }
    expect(packageJson.exports['./profiles/buildlore.profile.v1.json']).toBe(
      './profiles/buildlore.profile.v1.json',
    );
    expect(packageJson.files).toEqual(['dist', 'schemas', 'profiles']);
    expect(packageJson.dependencies).toEqual(approvedRuntimeDependencies);
    expect(packageJson.engines).toEqual({ node: '>=24', npm: '>=11 <12' });
    expect(packageJson.devDependencies).toEqual(approvedDevDependencies);
    expect(packageJson.scripts).toEqual({
      build: 'tsc -p tsconfig.build.json',
      'eval:retrieval': 'npm run build --silent && node dist/retrieval/evaluation/cli.js',
      lint: 'eslint . --max-warnings 0',
      'p2a:init': 'node scripts/bootstrap-p2a.mjs',
      test: 'vitest run',
      typecheck: 'tsc -p tsconfig.json --noEmit',
    });
  });

  it('pins package-root SDK adapters and forbids deep imports, child processes, agent runtimes, unrelated mutations, and new dependencies', async () => {
    const packageLock = JSON.parse(
      await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    ) as PackageLockContract;
    expect(packageLock.packages['']?.dependencies).toEqual(approvedRuntimeDependencies);
    expect(packageLock.packages['node_modules/llm-wiki-compiler']).toMatchObject({
      version: '1.1.0',
    });
    expect(packageLock.packages['node_modules/@huggingface/transformers']).toMatchObject({
      version: '4.2.0',
    });
    expect(packageLock.packages['node_modules/@huggingface/transformers']?.dependencies)
      .toMatchObject({ 'onnxruntime-node': '1.24.3' });
    expect(packageLock.packages['node_modules/onnxruntime-node']).toMatchObject({
      version: '1.24.3',
    });
    expect(packageLock).not.toHaveProperty('overrides');
    expect(packageLock.packages['node_modules/llm-wiki-compiler']?.integrity).toBe(
      compilerIntegrity,
    );
    expect(packageLock.packages['node_modules/yaml']).toMatchObject({
      integrity:
        'sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==',
      version: '2.9.0',
    });

    const adapterSource = await readFile(
      new URL('../src/compiler/backend.ts', import.meta.url),
      'utf8',
    );
    expect(adapterSource).toContain("from 'llm-wiki-compiler'");
    expect(adapterSource).not.toMatch(/\btype\s+Wiki\b/u);
    const publicCompilerSource = await readFile(
      new URL('../src/compiler/index.ts', import.meta.url),
      'utf8',
    );
    expect(publicCompilerSource).not.toContain('createLlmWikiCompilerBackend');
    expect(publicCompilerSource).not.toContain('createProjectEmbeddingIdentityStore');
    expect(publicCompilerSource).not.toContain('ProjectEmbeddingIdentityPort');
    const sourceRoot = new URL('../src/', import.meta.url);
    const sourcePaths = (await readdir(sourceRoot, { recursive: true })).filter((path) =>
      path.endsWith('.ts'),
    );
    const allSource = (
      await Promise.all(
        sourcePaths.map(async (path) =>
          readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8'),
        ),
      )
    ).join('\n');
    expect(allSource).not.toMatch(/from\s+['"]llm-wiki-compiler\//u);
    const retrievalSource = (
      await Promise.all(
        sourcePaths
          .filter((path) => path.startsWith('retrieval/'))
          .map(async (path) =>
            readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8'),
          ),
      )
    ).join('\n');
    expect(retrievalSource).not.toMatch(/Intl\.Segmenter/u);
    expect(retrievalSource).not.toMatch(/from\s+['"](?:garu-ko|node:child_process|llm-wiki-compiler\/)/u);
    const compilerSource = (
      await Promise.all(
        sourcePaths
          .filter((path) => path.startsWith('compiler/'))
          .map(async (path) =>
            readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8'),
          ),
      )
    ).join('\n');
    const externalImports = [
      ...compilerSource.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
    ]
      .map((match) => match[1])
      .filter(
        (specifier): specifier is string =>
          specifier !== undefined &&
          !specifier.startsWith('.') &&
          !specifier.startsWith('node:'),
      );
    expect([...new Set(externalImports)].sort()).toEqual(['llm-wiki-compiler', 'yaml']);
    expect(compilerSource).not.toMatch(/node:child_process|Promise\.race|process\.(?:on|once)\(/u);

    const sessionPaths = sourcePaths.filter((path) => path.startsWith('compiler/session/'));
    const sessionSource = (
      await Promise.all(sessionPaths.map(async (path) =>
        readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8')))
    ).join('\n');
    const nonAdapterSessionSource = (
      await Promise.all(sessionPaths
        .filter((path) => path !== 'compiler/session/admission.ts' &&
          path !== 'compiler/session/review-service.ts')
        .map(async (path) =>
          readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8')))
    ).join('\n');
    expect(sourcePaths.some((path) => path.startsWith('compiler/harness/'))).toBe(false);
    expect(sessionSource).not.toMatch(
      /node:child_process|\b(?:execFile|spawn|fork)\s*\(|shell\s*:\s*true|claude-code|@anthropic-ai|@openai\/codex|agent-sdk|llmwiki\/(?:cli|bin)|\b(?:server|scheduler|database)\b/u,
    );
    expect(nonAdapterSessionSource).not.toMatch(
      /\.stageEntityPage\s*\(|\.promoteStagedPage\s*\(|\.importOkf\s*\(|\.writeArtifact\s*\(|\.createRelation\s*\(|\.transitionLifecycle\s*\(/u,
    );
    expect(sessionSource).toContain("from 'llm-wiki-compiler'");
    expect(sessionSource).toContain('trusted: false');
    expect(sessionSource).toContain('trusted: true');
    expect(sessionSource).toContain('.stageEntityPage(');
    expect(sessionSource).toContain('.promoteStagedPage(');

    const projectionSource = (
      await Promise.all(
        sourcePaths
          .filter((path) => path.startsWith('projector/') || path.startsWith('sanitizer/'))
          .map(async (path) =>
            readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8'),
          ),
      )
    ).join('\n');
    const projectionExternalImports = [
      ...projectionSource.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
    ]
      .map((match) => match[1])
      .filter(
        (specifier): specifier is string =>
          specifier !== undefined &&
          !specifier.startsWith('.') &&
          !specifier.startsWith('node:'),
      );
    expect([...new Set(projectionExternalImports)]).toEqual(['yaml']);
    expect(projectionSource).not.toMatch(
      /node:child_process|from\s+['"]plan2agent(?:\/|['"])|Date\.now\s*\(|new\s+Date\s*\(\s*\)|\bmtime(?:Ms|Ns)?\b|\b(?:YAML|yaml)\.stringify\b|\bstringifyDocument\b/u,
    );
  });

  it('keeps the CLI on domain ports without upstream CLI fallback or stdout scraping', async () => {
    const cliRoot = new URL('../src/cli/', import.meta.url);
    const cliPaths = (await readdir(cliRoot, { recursive: true }))
      .filter((path) => path.endsWith('.ts'));
    const cliSource = (
      await Promise.all(
        cliPaths.map(async (path) =>
          readFile(new URL(path.replaceAll('\\', '/'), cliRoot), 'utf8')),
      )
    ).join('\n');

    expect(cliSource).not.toMatch(/from\s+['"]llm-wiki-compiler(?:\/|['"])/u);
    expect(cliSource).not.toMatch(/node:child_process|\b(?:exec|execFile|spawn|fork)\s*\(/u);
    expect(cliSource).not.toMatch(/JSON\.parse\s*\([^)]*\.stdout|\.stdout\s*\.\s*(?:match|split|trim)\s*\(/u);
  });

  it('[V12-V-02][V12-V-10] keeps publication authority internal and exports every schema', async () => {
    const knowledgeIndex = await readFile(
      new URL('../src/knowledge/index.ts', import.meta.url),
      'utf8',
    );
    expect(knowledgeIndex).not.toMatch(
      /KnowledgePublication(?:Service|Push)(?:Test|Internal)?Options|PublicationBlobPolicyPort|PublicationFaultHooks/u,
    );
    expect(knowledgeIndex).not.toContain('createKnowledgePublicationServiceForTesting');
    expect(knowledgeIndex).not.toContain('createInternalKnowledgePublicationPushService');

    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageContract;
    for (const schema of [
      'knowledge-tracking-policy.schema.json',
      'knowledge-publish-plan.schema.json',
      'knowledge-publish-result.schema.json',
      'knowledge-commit-lineage.schema.json',
      'knowledge-parent-pin-plan.schema.json',
      'knowledge-parent-pin-result.schema.json',
      'local-project-registry.schema.json',
      'source-collection-manifest.schema.json',
      'source-collection-manifest-v2.schema.json',
      'source-descriptor.schema.json',
      'source-document-v2.schema.json',
      'source-metadata.schema.json',
      'profile-binding.schema.json',
      'wiki-export.schema.json',
      'compile-plan.schema.json',
      'compile-proposal.schema.json',
      'compile-apply-result.schema.json',
      'session-compile-provenance.schema.json',
      'session-review-candidate.schema.json',
      'session-candidate-list.schema.json',
      'session-candidate-approval.schema.json',
      'session-promotion-proof.schema.json',
      'hierarchical-corpus.schema.json',
      'hierarchical-current-session.schema.json',
      'hierarchical-workflow.schema.json',
      'hierarchical-wiki-activation.schema.json',
      'hierarchical-retrieval.schema.json',
      'local-embedding.schema.json',
      'llm-wiki-retrieval-evaluation.schema.json',
      'semantic-index.schema.json',
      'retrieval-result-v2.schema.json',
      'retrieval-result-v3.schema.json',
    ]) {
      const subpath = `./schemas/${schema}`;
      expect(packageJson.exports[subpath]).toBe(subpath);
      expect(() => new URL(`../schemas/${schema}`, import.meta.url)).not.toThrow();
      expect((await readFile(new URL(`../schemas/${schema}`, import.meta.url), 'utf8')).length)
        .toBeGreaterThan(0);
    }
  });

  it('[V11-V-23] forbids Git authority, unsafe commands, services, and dependency expansion outside knowledge', async () => {
    const sourceRoot = new URL('../src/', import.meta.url);
    const sourcePaths = (await readdir(sourceRoot, { recursive: true }))
      .filter((path) => path.endsWith('.ts'));
    const readSources = async (prefixes: readonly string[]): Promise<string> => (
      await Promise.all(sourcePaths
        .filter((path) => prefixes.some((prefix) => path.startsWith(prefix)))
        .map(async (path) => readFile(
          new URL(path.replaceAll('\\', '/'), sourceRoot),
          'utf8',
        )))
    ).join('\n');
    const nonKnowledgeGitConsumers = await readSources(['compiler/', 'projector/', 'retrieval/']);
    expect(nonKnowledgeGitConsumers).not.toMatch(
      /knowledge\/(?:git-machine|parent-pin|publication|repository-writer-lease)/u,
    );

    const allSource = await readSources(['']);
    expect(allSource).not.toMatch(/from\s+['"]llm-wiki-compiler\//u);
    expect(allSource).not.toMatch(/\bGIT_INDEX_FILE\b/u);
    expect(allSource).not.toMatch(/['"](?:pull|rebase|stash)['"]/u);
    expect(allSource).not.toMatch(/['"]--force(?:-with-lease)?['"]/u);
    expect(allSource).not.toMatch(
      /from\s+['"](?:express|fastify|pg|postgres|sqlite3|better-sqlite3|node:http|node:http2)['"]/u,
    );
    expect(allSource).not.toMatch(/['"](?:checkout|switch)['"][\s\S]{0,80}['"]-(?:b|c)['"]/u);

    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageContract;
    expect(packageJson.dependencies).toEqual(approvedRuntimeDependencies);
  });
});
