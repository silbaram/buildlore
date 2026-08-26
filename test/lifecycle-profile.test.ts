import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWiki } from 'llm-wiki-compiler';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createBuildLoreLifecycleProfile,
  deriveLifecyclePageId,
  evaluateLifecycleReview,
  isLifecycleTransitionAllowed,
  materializeLifecycleProfile,
  parseLifecycleProfile,
  renderLifecycleProfile,
  validateLifecycleFixture,
} from '../src/profile/index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('BuildLore lifecycle profile contract', () => {
  it('keeps the packaged source canonical and selects only fixture-proven decisions', async () => {
    const packaged = await readFile(
      new URL('../profiles/buildlore.profile.v1.json', import.meta.url),
      'utf8',
    );
    const profile = parseLifecycleProfile(packaged);

    expect(packaged).toBe(renderLifecycleProfile(createBuildLoreLifecycleProfile('en')));
    expect(profile.entities.map(({ id }) => id)).toEqual([
      'decision',
      'failure',
      'verification',
    ]);
    expect(profile.relations.map(({ id }) => id)).toEqual(['supersedes', 'verified-by']);
    expect(profile.relations.every(({ cardinality }) =>
      cardinality.from === '0..n' && cardinality.to === '0..n')).toBe(true);
    expect(profile.exclusions.entities).toEqual(['project', 'feature', 'task', 'run', 'artifact']);
    expect(profile.exclusions.relations).toEqual([
      'implements',
      'failed-by',
      'produced',
      'belongs-to',
    ]);
  });

  it('rejects unknown, duplicate, reordered, noncanonical, and unsupported profile input', () => {
    const canonical = renderLifecycleProfile(createBuildLoreLifecycleProfile('en'));
    expect(() => parseLifecycleProfile(canonical.replace(
      '"schemaVersion": "buildlore.profile.v1",',
      '"schemaVersion": "buildlore.profile.v1",\n  "schemaVersion": "buildlore.profile.v1",',
    ))).toThrow('Lifecycle profile operation failed safely.');
    expect(() => parseLifecycleProfile(canonical.replace(
      '"outputLanguage": "en",',
      '"outputLanguage": "fr",',
    ))).toThrow('Lifecycle profile operation failed safely.');
    expect(() => parseLifecycleProfile(canonical.replace(
      '"profileId": "buildlore-lifecycle",',
      '"extra": true,\n  "profileId": "buildlore-lifecycle",',
    ))).toThrow('Lifecycle profile operation failed safely.');
    expect(() => parseLifecycleProfile(canonical.replace(
      '{\n  "schemaVersion"',
      '{\n  "profileId": "buildlore-lifecycle",\n  "schemaVersion"',
    ))).toThrow('Lifecycle profile operation failed safely.');
    expect(() => parseLifecycleProfile(canonical.trim())).toThrow(
      'Lifecycle profile operation failed safely.',
    );
  });

  it('materializes a byte-identical exact-pinned profile that public SDK status identifies and lint accepts safely', async () => {
    const english = materializeLifecycleProfile(createBuildLoreLifecycleProfile('en'));
    const korean = materializeLifecycleProfile(createBuildLoreLifecycleProfile('ko'));
    expect(english.profileJson).toBe(korean.profileJson);
    expect(english.configJson).toBe(korean.configJson);
    expect(english.profileJsonHash).toBe(korean.profileJsonHash);
    expect(english.sourceHash).not.toBe(korean.sourceHash);

    const upstream = JSON.parse(english.profileJson) as Readonly<Record<string, unknown>>;
    expect(upstream).toMatchObject({
      profileId: 'buildlore-lifecycle',
      profileVersion: '0.1.0',
      schemaVersion: 1,
    });
    expect(Object.keys(upstream.entities as Readonly<Record<string, unknown>>)).toEqual([
      'decisions',
      'failures',
      'verifications',
    ]);
    expect(Object.keys(upstream.relations as Readonly<Record<string, unknown>>)).toEqual([
      'supersedes',
      'verified-by',
    ]);
    expect(JSON.parse(english.configJson)).toEqual({
      version: 1,
      review: {
        hold: [
          'low-confidence',
          'contradicted',
          'schema-violating',
          'provenance-violating',
        ],
        lowConfidenceThreshold: 0.5,
        treatMissingConfidenceAs: 'low',
      },
    });

    const root = await mkdtemp(join(tmpdir(), 'buildlore-profile-sdk-'));
    temporaryRoots.push(root);
    await Promise.all([
      mkdir(join(root, 'sources')),
      mkdir(join(root, 'wiki')),
      mkdir(join(root, '.llmwiki')),
    ]);
    await Promise.all([
      writeFile(join(root, '.llmwiki', 'profile.json'), english.profileJson, 'utf8'),
      writeFile(join(root, '.llmwiki', 'config.json'), english.configJson, 'utf8'),
    ]);
    const wiki = createWiki({ root });
    await expect(wiki.status()).resolves.toMatchObject({
      profile: {
        entityCounts: { decisions: 0, failures: 0, verifications: 0 },
        profileId: 'buildlore-lifecycle',
      },
    });
    await expect(wiki.lint()).resolves.toMatchObject({ errors: 0 });
  });

  it('enforces lifecycle preconditions without a duplicate failed-by relation', () => {
    expect(validateLifecycleFixture({
      confidence: 0.8,
      entityType: 'decision',
      incomingSupersedesFromActive: 0,
      state: 'superseded',
    })).toMatchObject({ valid: false, issues: ['supersedes-required'] });
    expect(validateLifecycleFixture({
      confidence: 0.8,
      entityType: 'failure',
      outgoingPassedVerifications: 1,
      resolution: 'Corrected the profile binding.',
      state: 'resolved',
    })).toMatchObject({ valid: true, issues: [] });
    expect(validateLifecycleFixture({
      confidence: 0.8,
      entityType: 'verification',
      evidenceRefs: ['verification:test/lifecycle-profile.test.ts'],
      state: 'failed',
    })).toMatchObject({ valid: true, issues: [] });
    expect(isLifecycleTransitionAllowed('verification', 'failed', 'passed')).toBe(false);
    expect(isLifecycleTransitionAllowed('verification', 'failed', 'archived')).toBe(true);
  });

  it('holds the exact review-policy union at the 0.5 boundary', () => {
    expect(evaluateLifecycleReview({})).toEqual(['low-confidence']);
    expect(evaluateLifecycleReview({ confidence: 0.499_999 })).toEqual(['low-confidence']);
    expect(evaluateLifecycleReview({ confidence: 0.5 })).toEqual([]);
    expect(evaluateLifecycleReview({
      confidence: 0.9,
      contradicted: true,
      provenanceViolations: ['missing-source'],
      schemaViolations: ['invalid-state'],
    })).toEqual(['contradicted', 'schema-violating', 'provenance-violating']);
    expect(evaluateLifecycleReview({ confidence: Number.NaN })).toEqual(['schema-violating']);
  });

  it('derives immutable project-scoped typed page identities', () => {
    const first = deriveLifecyclePageId({
      entityType: 'decision',
      producerStableKey: 'p2a:iteration-v7:decision-21',
      projectId: 'alpha',
    });
    const repeated = deriveLifecyclePageId({
      entityType: 'decision',
      producerStableKey: 'p2a:iteration-v7:decision-21',
      projectId: 'alpha',
    });
    const sibling = deriveLifecyclePageId({
      entityType: 'decision',
      producerStableKey: 'p2a:iteration-v7:decision-21',
      projectId: 'beta',
    });
    expect(first).toMatch(/^decisions\/[a-f0-9]{64}$/u);
    expect(repeated).toBe(first);
    expect(sibling).not.toBe(first);
  });
});
