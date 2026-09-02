import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  assessSemanticCacheState,
  classifyProjectTrackingPath,
  classifyTrackingPath,
  KNOWLEDGE_TRACKING_POLICY,
  LLM_WIKI_COMPILER_INTEGRITY,
  LLM_WIKI_COMPILER_OUTPUT_INVENTORY,
  parseCompilerOutputInventory,
  parseKnowledgeTrackingPolicy,
  renderCompilerOutputInventory,
  renderKnowledgeTrackingPolicy,
  TrackingPolicyClassifier,
  type CompilerPackageIdentity,
  type KnowledgeTrackingPolicyV1,
  type TrackingEntry,
} from '../src/knowledge/index.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';

const packageIdentity: CompilerPackageIdentity = {
  exactVersion: '1.1.0',
  packageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
  upstreamPackage: 'llm-wiki-compiler',
};

const inventoryUrl = new URL(
  './fixtures/tracking-policy/llm-wiki-compiler-1.1.0-inventory.json',
  import.meta.url,
);

interface PackageLockFixture {
  readonly packages: Readonly<Record<string, {
    readonly integrity?: string;
    readonly version?: string;
  }>>;
}

function mutateDigest(value: string): string {
  return value.endsWith('0') ? `${value.slice(0, -1)}1` : `${value.slice(0, -1)}0`;
}

function expectPolicyInvalid(value: string | Uint8Array): void {
  try {
    parseKnowledgeTrackingPolicy(value);
    throw new Error('Invalid tracking policy unexpectedly decoded.');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'TRACKING_POLICY_INVALID',
      message: 'Knowledge tracking contract is invalid.',
    });
  }
}

describe('knowledge tracking policy v1', () => {
  it('[V11-V-01][V11-P-01] binds the executable 1.1.0 inventory to exact package evidence', async () => {
    const fixture = await readFile(inventoryUrl, 'utf8');
    const decoded = parseCompilerOutputInventory(fixture);
    expect(fixture).toBe(renderCompilerOutputInventory());
    expect(decoded).toEqual(LLM_WIKI_COMPILER_OUTPUT_INVENTORY);
    expect(decoded).toMatchObject({
      exactVersion: '1.1.0',
      packageCommit: '6963a7f8374282de5d4084a324be69b50f62a32d',
      packageIntegrity: LLM_WIKI_COMPILER_INTEGRITY,
      upstreamPackage: 'llm-wiki-compiler',
    });
    const packageLock = JSON.parse(await readFile(
      new URL('../package-lock.json', import.meta.url),
      'utf8',
    )) as PackageLockFixture;
    expect(packageLock.packages['node_modules/llm-wiki-compiler']).toMatchObject({
      integrity: LLM_WIKI_COMPILER_INTEGRITY,
      version: '1.1.0',
    });

    const policyIds = new Set(KNOWLEDGE_TRACKING_POLICY.entries.map(({ id }) => id));
    for (const item of decoded.entries) {
      expect(policyIds.has(item.policyEntryId)).toBe(true);
      expect(classifyProjectTrackingPath(
        'fixture',
        item.projectRelativePath,
        packageIdentity,
        { includePolicyTrack: true },
      )).toEqual({
        classification: item.classification,
        disposition: item.classification === 'always-ignore' ? 'exclude' : 'include',
        entryId: item.policyEntryId,
        ok: true,
      });
    }

    expect(classifyTrackingPath(
      'projects/fixture/wiki/new-upstream-family.data',
      packageIdentity,
    )).toEqual({ code: 'TRACKING_PATH_UNCLASSIFIED', ok: false });
    expect(classifyTrackingPath('projects/fixture/wiki/index.md', {
      ...packageIdentity,
      packageIntegrity: mutateDigest(packageIdentity.packageIntegrity),
    })).toEqual({ code: 'TRACKING_PACKAGE_INTEGRITY_MISMATCH', ok: false });
  });

  it('applies exactly one class and keeps policy-track excluded without explicit review input', () => {
    expect(classifyTrackingPath(
      'projects/fixture/sources/decision.md',
      packageIdentity,
    )).toEqual({
      classification: 'always-track',
      disposition: 'include',
      entryId: 'always-track-source',
      ok: true,
    });
    expect(classifyTrackingPath(
      'projects/fixture/.llmwiki/candidates/review.json',
      packageIdentity,
    )).toEqual({
      classification: 'policy-track',
      disposition: 'exclude',
      entryId: 'policy-track-candidate',
      ok: true,
    });
    expect(classifyTrackingPath(
      'projects/fixture/.llmwiki/candidates/review.json',
      packageIdentity,
      { includePolicyTrack: true },
    )).toEqual({
      classification: 'policy-track',
      disposition: 'include',
      entryId: 'policy-track-candidate',
      ok: true,
    });
    expect(classifyTrackingPath('projects/fixture/.env', packageIdentity)).toMatchObject({
      classification: 'always-ignore',
      disposition: 'exclude',
      ok: true,
    });
    expect(classifyTrackingPath(
      'projects/fixture/PRIVATE-CREDENTIALS.json',
      packageIdentity,
    )).toMatchObject({
      classification: 'always-ignore',
      disposition: 'exclude',
      entryId: 'always-ignore-credential-file',
      ok: true,
    });
    expect(classifyTrackingPath(
      'projects/fixture/.llmwiki/buildlore-embedding-identity.json',
      packageIdentity,
    )).toMatchObject({ classification: 'always-track', disposition: 'include', ok: true });
    expect(classifyTrackingPath(
      'projects/fixture/wiki/buildlore-hierarchy/manifest.json',
      packageIdentity,
    )).toEqual({
      classification: 'always-track',
      disposition: 'include',
      entryId: 'always-track-hierarchical-markdown-manifest',
      ok: true,
    });
    expect(classifyTrackingPath(
      `projects/fixture/wiki/buildlore-hierarchy/page-${'0'.repeat(64)}.md`,
      packageIdentity,
    )).toEqual({
      classification: 'always-track',
      disposition: 'include',
      entryId: 'always-track-wiki-page',
      ok: true,
    });
    expect(classifyTrackingPath(
      'projects/fixture/.buildlore/indexes/semantic/generations/generation-abc/vectors.f32',
      packageIdentity,
    )).toEqual({
      classification: 'always-ignore',
      disposition: 'exclude',
      entryId: 'always-ignore-buildlore-semantic-index',
      ok: true,
    });
    expect(classifyTrackingPath('manifest.json.lock', packageIdentity)).toMatchObject({
      classification: 'always-ignore',
      disposition: 'exclude',
      ok: true,
    });
  });

  it('fails safely for ambiguous, unsafe, traversal, nested-source, and unknown paths', () => {
    const sourceEntry = KNOWLEDGE_TRACKING_POLICY.entries.find(({ id }) =>
      id === 'always-track-source');
    expect(sourceEntry).toBeDefined();
    if (sourceEntry === undefined) throw new Error('Tracking fixture is incomplete.');
    const overlapping: TrackingEntry = {
      ...sourceEntry,
      id: 'always-track-source-overlap',
    };
    const ambiguousPolicy: KnowledgeTrackingPolicyV1 = {
      ...KNOWLEDGE_TRACKING_POLICY,
      entries: [...KNOWLEDGE_TRACKING_POLICY.entries, overlapping],
    };
    expect(new TrackingPolicyClassifier(ambiguousPolicy).classify(
      'projects/fixture/sources/decision.md',
      packageIdentity,
    )).toEqual({ code: 'TRACKING_PATH_AMBIGUOUS', ok: false });

    for (const path of [
      '../projects/fixture/sources/decision.md',
      '/projects/fixture/sources/decision.md',
      'projects/fixture/sources/nested/decision.md',
      'projects/fixture/unknown.json',
      'projects\\fixture\\sources\\decision.md',
      'projects/fixture/source-credential.key',
    ]) {
      const result = classifyTrackingPath(path, packageIdentity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toMatch(/^TRACKING_PATH_(?:AMBIGUOUS|UNCLASSIFIED)$/u);
        expect(JSON.stringify(result)).not.toContain(path);
      }
    }
  });

  it('[V11-V-18] rejects duplicate/unknown keys, version/digest drift, order, and canonical byte drift', () => {
    const canonical = renderKnowledgeTrackingPolicy();
    expect(parseKnowledgeTrackingPolicy(canonical)).toEqual(KNOWLEDGE_TRACKING_POLICY);
    expectPolicyInvalid(canonical.replace(
      '"schemaVersion": "buildlore.knowledge-tracking-policy.v1",',
      '"schemaVersion": "buildlore.knowledge-tracking-policy.v1",\n  "unknown": true,',
    ));
    expectPolicyInvalid(canonical.replace(
      '"schemaVersion": "buildlore.knowledge-tracking-policy.v1",',
      '"schemaVersion": "buildlore.knowledge-tracking-policy.v1",\n  "schemaVersion": "buildlore.knowledge-tracking-policy.v1",',
    ));
    expectPolicyInvalid(canonical.replace('1.1.0', '1.1.1'));
    expectPolicyInvalid(canonical.replace(
      KNOWLEDGE_TRACKING_POLICY.policyDigest,
      mutateDigest(KNOWLEDGE_TRACKING_POLICY.policyDigest),
    ));
    expectPolicyInvalid(canonical.replace(
      '{\n  "schemaVersion": "buildlore.knowledge-tracking-policy.v1",\n  "upstreamPackage": "llm-wiki-compiler",',
      '{\n  "upstreamPackage": "llm-wiki-compiler",\n  "schemaVersion": "buildlore.knowledge-tracking-policy.v1",',
    ));
    expectPolicyInvalid(canonical.trimEnd());
    expectPolicyInvalid(`${canonical}\n`);
    expectPolicyInvalid(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b]));
    expectPolicyInvalid(new Uint8Array([0xc3, 0x28]));
  });

  it('rejects inventory canonical drift without reflecting fixture data', async () => {
    const canonical = await readFile(inventoryUrl, 'utf8');
    const digest = LLM_WIKI_COMPILER_OUTPUT_INVENTORY.inventoryDigest;
    for (const invalid of [
      canonical.trimEnd(),
      `${canonical}\n`,
      canonical.replace(digest, mutateDigest(digest)),
      canonical.replace(
        '"schemaVersion": "buildlore.compiler-output-inventory.v1",',
        '"schemaVersion": "buildlore.compiler-output-inventory.v1",\n  "extra": true,',
      ),
    ]) {
      try {
        parseCompilerOutputInventory(invalid);
        throw new Error('Invalid inventory unexpectedly decoded.');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'TRACKING_INVENTORY_INVALID',
          message: 'Knowledge tracking contract is invalid.',
        });
        expect(JSON.stringify(error)).not.toContain(invalid);
      }
    }
  });

  it('[V11-V-02][V11-P-02] never treats a portable identity marker as an embeddings cache', () => {
    expect(assessSemanticCacheState({
      embeddingsCachePresent: false,
      identityMarkerPresent: true,
    })).toBe('embedding-cache-missing');
    expect(assessSemanticCacheState({
      embeddingsCachePresent: true,
      identityMarkerPresent: true,
    })).toBe('compatible-candidate');
    expect(assessSemanticCacheState({
      embeddingsCachePresent: true,
      identityMarkerPresent: false,
    })).toBe('identity-marker-missing');
  });

  it('keeps the schema enum/bounds surface in parity with runtime policy fields', async () => {
    const schema = JSON.parse(await readFile(
      new URL('../schemas/knowledge-tracking-policy.schema.json', import.meta.url),
      'utf8',
    )) as {
      readonly $defs: Readonly<Record<string, unknown>>;
      readonly properties: Readonly<Record<string, unknown>>;
      readonly required: readonly string[];
    };
    expect(schema.required).toEqual([
      'schemaVersion',
      'upstreamPackage',
      'exactVersion',
      'packageIntegrity',
      'packageCommit',
      'inventoryDigest',
      'entries',
      'policyDigest',
    ]);
    expect(Object.keys(schema.properties)).toEqual(schema.required);
    expect(Object.keys(schema.$defs)).toEqual(['sha256Digest', 'trackingEntry']);
    const rendered = renderKnowledgeTrackingPolicy();
    expect(rendered).toContain(KNOWLEDGE_TRACKING_POLICY.inventoryDigest);
    const { policyDigest, ...withoutDigest } = KNOWLEDGE_TRACKING_POLICY;
    expect(KNOWLEDGE_TRACKING_POLICY.policyDigest).toBe(
      `sha256:${createHash('sha256').update(serializeCanonicalJson(withoutDigest)).digest('hex')}`,
    );
    expect(policyDigest).toBe(KNOWLEDGE_TRACKING_POLICY.policyDigest);
  });

  it('keeps checked-in inventory evidence free of endpoints, private paths, and bodies', async () => {
    const fixture = await readFile(inventoryUrl, 'utf8');
    expect(fixture).not.toMatch(/(?:https?:\/\/|file:|\/home\/|\/Users\/|[A-Za-z]:\\)/u);
    expect(fixture).not.toMatch(/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/u);
    expect(fixture).not.toMatch(/(?:authorization|bearer|api[-_]?key|password)\s*[:=]/iu);
    expect(fixture).not.toContain('sourceBody');
  });
});
