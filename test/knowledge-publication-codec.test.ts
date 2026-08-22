import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  parseKnowledgeCommitLineage,
  parseKnowledgePublishPlan,
  parseKnowledgePublishResult,
  renderKnowledgeCommitLineageJson,
  renderKnowledgePublishPlan,
  renderKnowledgePublishResult,
} from '../src/knowledge/publication-codec.js';
import {
  KNOWLEDGE_COMMIT_LINEAGE_SCHEMA_VERSION,
  KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION,
  KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
  type KnowledgeCommitLineageV1,
  type KnowledgePublishPlan,
  type KnowledgePublishResult,
} from '../src/knowledge/publication-types.js';

const oid = (character: string): string => character.repeat(40);
const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

function parseUnknownJson(source: string): unknown {
  const value: unknown = JSON.parse(source);
  return value;
}

function plan(): KnowledgePublishPlan {
  return {
    schemaVersion: KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION,
    projectId: 'alpha',
    repositoryIdentityDigest: digest('1'),
    baseRevision: oid('a'),
    localUpstreamRevision: null,
    sourceRevision: oid('b'),
    codeRevision: oid('c'),
    selectedPaths: [{
      classification: 'always-track',
      contentSha256: digest('2'),
      mode: '100644',
      numstat: { added: 1, deleted: null },
      reasonCode: 'selected',
      relativePath: 'projects/alpha/sources/entry.md',
      status: 'modified',
    }],
    foreignChanges: {
      digest: digest('3'),
      staged: { count: 0, entries: [], overflow: false },
      unstaged: { count: 0, entries: [], overflow: false },
      untracked: { count: 0, entries: [], overflow: false },
    },
    registrationManifest: null,
    trackingPolicyDigest: digest('4'),
    lineageDigest: digest('5'),
    indexSnapshotDigest: digest('6'),
    eligible: true,
    blockReasons: [],
    planDigest: digest('7'),
  };
}

function result(): KnowledgePublishResult {
  return {
    schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
    state: 'committed',
    projectId: 'alpha',
    baseRevision: oid('a'),
    foreignCounts: { staged: 0, unstaged: 0, untracked: 0 },
    knowledgeRevision: oid('d'),
    localCommitPreserved: true,
    partial: false,
    pinRequired: true,
    recoveryCommand: ['publish', 'push', '--project', 'alpha'],
    remoteRevision: null,
    stagedPaths: ['projects/alpha/sources/entry.md'],
    treeRevision: oid('e'),
    warnings: [],
  };
}

function lineage(): KnowledgeCommitLineageV1 {
  return {
    schemaVersion: KNOWLEDGE_COMMIT_LINEAGE_SCHEMA_VERSION,
    projectId: 'alpha',
    knowledgeParentRevision: oid('a'),
    knowledgeTreeRevision: oid('e'),
    sourceRevision: oid('b'),
    codeRevision: oid('c'),
    compilerPackage: 'llm-wiki-compiler',
    compilerPackageIntegrity: 'sha512-LJslVmSt8tng8n3t0tw1QEqZJKKD0ualJ/WupdZMCtCzmCNarkP999k6hiNIg5ezvE8B/JQ1C1bUi6eY88Q79A==',
    compilerVersion: '1.1.0',
    embeddingCompatibilityDigest: digest('8'),
    modelCompatibilityDigest: digest('9'),
    planDigest: digest('7'),
    profileDigest: digest('a'),
    promptDigest: digest('b'),
    selectedPathsDigest: digest('c'),
    trackingPolicyDigest: digest('d'),
  };
}

function pushFailedResult(): KnowledgePublishResult {
  return {
    schemaVersion: KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION,
    state: 'push-failed',
    projectId: 'alpha',
    baseRevision: oid('a'),
    errorCode: 'PUBLISH_PUSH_FAILED',
    foreignCounts: { staged: 0, unstaged: 0, untracked: 0 },
    knowledgeRevision: oid('d'),
    localCommitPreserved: true,
    partial: true,
    pinRequired: true,
    recoveryCommand: ['publish', 'push', '--project', 'alpha'],
    remoteRevision: oid('a'),
    stagedPaths: ['projects/alpha/sources/entry.md'],
    treeRevision: oid('e'),
    warnings: [],
  };
}

describe('publication artifact codecs', () => {
  it('round-trips canonical plan, result, and lineage artifacts', () => {
    expect(parseKnowledgePublishPlan(renderKnowledgePublishPlan(plan()))).toEqual(plan());
    expect(parseKnowledgePublishResult(renderKnowledgePublishResult(result()))).toEqual(result());
    expect(parseKnowledgePublishResult(renderKnowledgePublishResult(pushFailedResult())))
      .toEqual(pushFailedResult());
    expect(parseKnowledgeCommitLineage(renderKnowledgeCommitLineageJson(lineage()))).toEqual(lineage());
  });

  it('does not allow PUBLISH_PUSH_FAILED on the blocked discriminant', () => {
    const invalid = renderKnowledgePublishResult(pushFailedResult())
      .replace('"state": "push-failed"', '"state": "blocked"');
    expect(() => parseKnowledgePublishResult(invalid)).toThrowError(
      expect.objectContaining({ code: 'PUBLISH_PLAN_DRIFT' }),
    );
  });

  it('fails closed on unknown, duplicate, reordered, and noncanonical newline input', () => {
    const canonical = renderKnowledgePublishPlan(plan());
    const unknown = canonical.replace(
      '"planDigest":',
      '"unknown": true,\n  "planDigest":',
    );
    const duplicate = canonical.replace(
      '"projectId": "alpha",',
      '"projectId": "alpha",\n  "projectId": "alpha",',
    );
    const reordered = canonical.replace(
      '  "schemaVersion": "buildlore.knowledge-publish-plan.v1",\n  "projectId": "alpha",',
      '  "projectId": "alpha",\n  "schemaVersion": "buildlore.knowledge-publish-plan.v1",',
    );
    for (const invalid of [unknown, duplicate, reordered, canonical.slice(0, -1), `${canonical}\n`]) {
      expect(() => parseKnowledgePublishPlan(invalid)).toThrowError(
        expect.objectContaining({ code: 'PUBLISH_PLAN_DRIFT' }),
      );
    }
  });

  it('[V11-V-18] rejects version, OID, digest, bounds, BOM, UTF-8, and LF drift in publish plans', () => {
    const canonical = renderKnowledgePublishPlan(plan());
    const invalidValues: readonly (string | Uint8Array)[] = [
      canonical.replace('buildlore.knowledge-publish-plan.v1', 'buildlore.knowledge-publish-plan.v2'),
      canonical.replace(oid('a'), 'a'.repeat(39)),
      canonical.replace(digest('7'), 'sha256:short'),
      canonical.replace('"projectId": "alpha"', `"projectId": "${'a'.repeat(65)}"`),
      `\ufeff${canonical}`,
      canonical.replaceAll('\n', '\r\n'),
      canonical.slice(0, -1),
      `${canonical}\n`,
      Uint8Array.from([0xff, 0xfe, 0xfd]),
    ];
    for (const invalid of invalidValues) {
      expect(() => parseKnowledgePublishPlan(invalid)).toThrowError(
        expect.objectContaining({ code: 'PUBLISH_PLAN_DRIFT' }),
      );
    }
  });

  it('[V11-V-18] rejects closed-key, order, version, bounds, OID, and digest drift in results and lineage', () => {
    const canonicalResult = renderKnowledgePublishResult(result());
    const invalidResults = [
      canonicalResult.replace('"state":', '"unknown": true,\n  "state":'),
      canonicalResult.replace('"projectId": "alpha",', '"projectId": "alpha",\n  "projectId": "alpha",'),
      canonicalResult.replace(
        '  "schemaVersion": "buildlore.knowledge-publish-result.v1",\n  "state": "committed",',
        '  "state": "committed",\n  "schemaVersion": "buildlore.knowledge-publish-result.v1",',
      ),
      canonicalResult.replace('buildlore.knowledge-publish-result.v1', 'buildlore.knowledge-publish-result.v2'),
      canonicalResult.replace('"projectId": "alpha"', `"projectId": "${'a'.repeat(65)}"`),
      canonicalResult.replace(oid('d'), 'd'.repeat(39)),
      `\ufeff${canonicalResult}`,
      canonicalResult.slice(0, -1),
      `${canonicalResult}\n`,
    ];
    for (const invalid of invalidResults) {
      expect(() => parseKnowledgePublishResult(invalid)).toThrowError(
        expect.objectContaining({ code: 'PUBLISH_PLAN_DRIFT' }),
      );
    }

    const canonicalLineage = renderKnowledgeCommitLineageJson(lineage());
    const invalidLineage = [
      canonicalLineage.replace('"projectId":', '"unknown": true,\n  "projectId":'),
      canonicalLineage.replace('"projectId": "alpha",', '"projectId": "alpha",\n  "projectId": "alpha",'),
      canonicalLineage.replace(
        '  "schemaVersion": "buildlore.knowledge-commit-lineage.v1",\n  "projectId": "alpha",',
        '  "projectId": "alpha",\n  "schemaVersion": "buildlore.knowledge-commit-lineage.v1",',
      ),
      canonicalLineage.replace('buildlore.knowledge-commit-lineage.v1', 'buildlore.knowledge-commit-lineage.v2'),
      canonicalLineage.replace(oid('c'), 'c'.repeat(39)),
      canonicalLineage.replace(digest('8'), 'sha256:short'),
      `\ufeff${canonicalLineage}`,
      canonicalLineage.replaceAll('\n', '\r\n'),
      canonicalLineage.slice(0, -1),
      `${canonicalLineage}\n`,
    ];
    for (const invalid of invalidLineage) {
      expect(() => parseKnowledgeCommitLineage(invalid)).toThrowError(
        expect.objectContaining({ code: 'PUBLISH_PLAN_DRIFT' }),
      );
    }
  });

  it('keeps runtime schema versions aligned with checked-in schemas', async () => {
    const [planSchema, resultSchema, lineageSchema] = await Promise.all([
      readFile('schemas/knowledge-publish-plan.schema.json', 'utf8'),
      readFile('schemas/knowledge-publish-result.schema.json', 'utf8'),
      readFile('schemas/knowledge-commit-lineage.schema.json', 'utf8'),
    ]);
    expect(planSchema).toContain(KNOWLEDGE_PUBLISH_PLAN_SCHEMA_VERSION);
    expect(resultSchema).toContain(KNOWLEDGE_PUBLISH_RESULT_SCHEMA_VERSION);
    expect(lineageSchema).toContain(KNOWLEDGE_COMMIT_LINEAGE_SCHEMA_VERSION);
    expect(() => parseUnknownJson(planSchema)).not.toThrow();
    expect(() => parseUnknownJson(resultSchema)).not.toThrow();
    expect(() => parseUnknownJson(lineageSchema)).not.toThrow();
  });
});
