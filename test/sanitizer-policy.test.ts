import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addProject } from '../src/knowledge/index.js';
import {
  defaultSecurityPolicy,
  parseSecurityPolicy,
  readSecurityPolicy,
  SECURITY_POLICY_SCHEMA_VERSION,
  serializeSecurityPolicy,
  type SecurityPolicy,
} from '../src/sanitizer/index.js';

const temporaryRoots: string[] = [];

async function fixture(): Promise<Readonly<{ knowledgeRoot: string; workspace: string }>> {
  const root = await mkdtemp(join(process.cwd(), '.test-tmp-sanitizer-policy-'));
  temporaryRoots.push(root);
  const knowledgeRoot = join(root, 'knowledge');
  await mkdir(knowledgeRoot);
  await addProject(knowledgeRoot, {
    displayName: 'Alpha',
    projectId: 'alpha',
    sourceRepository: 'https://example.test/alpha.git',
  });
  return { knowledgeRoot, workspace: join(knowledgeRoot, 'projects', 'alpha') };
}

function allowedPolicy(): SecurityPolicy {
  return {
    schemaVersion: SECURITY_POLICY_SCHEMA_VERSION,
    projectId: 'alpha',
    defaultClassification: 'internal',
    classificationRules: [
      { classification: 'public', sourceKind: 'planning' },
    ],
    egressRules: [
      { allowedClassifications: ['internal', 'public'], capability: 'compile' },
    ],
    overrides: [],
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('security policy', () => {
  it('uses a deterministic restricted and deny-by-default policy when the file is absent', async () => {
    const item = await fixture();
    const loaded = await readSecurityPolicy(item.knowledgeRoot, 'alpha');

    expect(loaded.policy).toEqual(defaultSecurityPolicy('alpha'));
    expect(loaded.policy.defaultClassification).toBe('restricted');
    expect(loaded.policy.egressRules).toEqual([]);
    expect(loaded.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('round-trips the strict canonical project policy', async () => {
    const item = await fixture();
    const policy = allowedPolicy();
    const serialized = serializeSecurityPolicy(policy);
    await writeFile(join(item.workspace, 'security-policy.json'), serialized, 'utf8');

    const loaded = await readSecurityPolicy(item.knowledgeRoot, 'alpha');
    expect(loaded.policy).toEqual(parseSecurityPolicy(policy, 'alpha'));
    expect(serializeSecurityPolicy(loaded.policy)).toBe(serialized);
    expect(Object.isFrozen(loaded.policy)).toBe(true);
    expect(loaded.policy.classificationRules.every((rule) => Object.isFrozen(rule))).toBe(true);
    expect(loaded.policy.egressRules.every((rule) =>
      Object.isFrozen(rule) && Object.isFrozen(rule.allowedClassifications))).toBe(true);
    expect(loaded.policy.overrides.every((override) => Object.isFrozen(override))).toBe(true);
  });

  it('canonicalizes semantically equivalent rule ordering', () => {
    const policy: SecurityPolicy = {
      ...allowedPolicy(),
      classificationRules: [
        { classification: 'internal', sourceKind: 'wiki' },
        { classification: 'public', sourceKind: 'planning' },
      ],
      egressRules: [
        { allowedClassifications: ['public'], capability: 'search' },
        { allowedClassifications: ['public', 'internal'], capability: 'compile' },
      ],
    };
    expect(serializeSecurityPolicy(policy)).toBe(serializeSecurityPolicy({
      ...policy,
      classificationRules: [...policy.classificationRules].reverse(),
      egressRules: [...policy.egressRules].reverse(),
    }));
  });

  it.each([
    {
      name: 'unknown field',
      value: { ...allowedPolicy(), unexpected: true },
    },
    {
      name: 'wrong project',
      value: { ...allowedPolicy(), projectId: 'beta' },
    },
    {
      name: 'restricted egress',
      value: {
        ...allowedPolicy(),
        egressRules: [{ allowedClassifications: ['restricted'], capability: 'compile' }],
      },
    },
    {
      name: 'duplicate selector',
      value: {
        ...allowedPolicy(),
        classificationRules: [
          { classification: 'public', sourceKind: 'planning' },
          { classification: 'internal', sourceKind: 'planning' },
        ],
      },
    },
    {
      name: 'free-form audit reference',
      value: {
        ...allowedPolicy(),
        overrides: [{
          auditRef: '/home/person/private-note',
          reasonCode: 'non-secret-identifier',
          ruleId: 'entropy.candidate',
          sourceIdentitySha256: 'a'.repeat(64),
          sourceRevisionOrContentSha256: `sha256:${'b'.repeat(64)}`,
        }],
      },
    },
    {
      name: 'non-home absolute audit reference',
      value: {
        ...allowedPolicy(),
        overrides: [{
          auditRef: '/etc/buildlore/security-review',
          reasonCode: 'non-secret-identifier',
          ruleId: 'entropy.candidate',
          sourceIdentitySha256: 'a'.repeat(64),
          sourceRevisionOrContentSha256: `sha256:${'b'.repeat(64)}`,
        }],
      },
    },
    {
      name: 'UNC absolute audit reference',
      value: {
        ...allowedPolicy(),
        overrides: [{
          auditRef: '\\\\server\\share\\security-review',
          reasonCode: 'non-secret-identifier',
          ruleId: 'entropy.candidate',
          sourceIdentitySha256: 'a'.repeat(64),
          sourceRevisionOrContentSha256: `sha256:${'b'.repeat(64)}`,
        }],
      },
    },
    {
      name: 'unpaired Unicode audit reference',
      value: {
        ...allowedPolicy(),
        overrides: [{
          auditRef: `SECURITY-${'\ud800'}`,
          reasonCode: 'non-secret-identifier',
          ruleId: 'entropy.candidate',
          sourceIdentitySha256: 'a'.repeat(64),
          sourceRevisionOrContentSha256: `sha256:${'b'.repeat(64)}`,
        }],
      },
    },
    {
      name: 'relative audit query',
      value: {
        ...allowedPolicy(),
        overrides: [{
          auditRef: 'SECURITY-1?detail=private',
          reasonCode: 'non-secret-identifier',
          ruleId: 'entropy.candidate',
          sourceIdentitySha256: 'a'.repeat(64),
          sourceRevisionOrContentSha256: `sha256:${'b'.repeat(64)}`,
        }],
      },
    },
    {
      name: 'credential-bearing audit reference',
      value: {
        ...allowedPolicy(),
        overrides: [{
          auditRef: `SECURITY-${['gh', 'p_', 'A1b2C3d4E5f6G7h8J9k0', 'LmNoPq'].join('')}`,
          reasonCode: 'non-secret-identifier',
          ruleId: 'entropy.candidate',
          sourceIdentitySha256: 'a'.repeat(64),
          sourceRevisionOrContentSha256: `sha256:${'b'.repeat(64)}`,
        }],
      },
    },
    {
      name: 'free-form audit prose',
      value: {
        ...allowedPolicy(),
        overrides: [{
          auditRef: 'security team reviewed this false positive',
          reasonCode: 'non-secret-identifier',
          ruleId: 'entropy.candidate',
          sourceIdentitySha256: 'a'.repeat(64),
          sourceRevisionOrContentSha256: `sha256:${'b'.repeat(64)}`,
        }],
      },
    },
    {
      name: 'non-overridable rule',
      value: {
        ...allowedPolicy(),
        overrides: [{
          reasonCode: 'non-secret-identifier',
          ruleId: 'private-key.pem',
          sourceIdentitySha256: 'a'.repeat(64),
          sourceRevisionOrContentSha256: `sha256:${'b'.repeat(64)}`,
        }],
      },
    },
  ])('rejects $name without echoing policy values', ({ value }) => {
    expect(() => parseSecurityPolicy(value, 'alpha')).toThrowError(
      expect.objectContaining({ code: 'SECURITY_POLICY_INVALID' }),
    );
  });

  it('rejects non-canonical and symlink policy files', async () => {
    const nonCanonical = await fixture();
    await writeFile(
      join(nonCanonical.workspace, 'security-policy.json'),
      JSON.stringify(allowedPolicy()),
      'utf8',
    );
    await expect(readSecurityPolicy(nonCanonical.knowledgeRoot, 'alpha')).rejects.toMatchObject({
      code: 'SECURITY_POLICY_INVALID',
    });

    const linked = await fixture();
    const outside = join(linked.knowledgeRoot, 'outside-policy.json');
    await writeFile(outside, serializeSecurityPolicy(allowedPolicy()), 'utf8');
    await symlink(outside, join(linked.workspace, 'security-policy.json'));
    await expect(readSecurityPolicy(linked.knowledgeRoot, 'alpha')).rejects.toMatchObject({
      code: 'SECURITY_POLICY_INVALID',
    });
  });
});
