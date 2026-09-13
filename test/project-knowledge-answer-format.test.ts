import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addProject } from '../src/knowledge/index.js';
import { sha256 } from '../src/knowledge/project-knowledge/guards.js';
import { consumePreparedSource } from '../src/sanitizer/approval.js';
import { createProjectSecurityService } from '../src/sanitizer/index.js';
import { writeSecurityPolicy } from './fixtures/security-policy.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function securityFixture() {
  const root = await mkdtemp(join(tmpdir(), 'buildlore-answer-format-'));
  roots.push(root);
  await addProject(root, { projectId: 'parcel', displayName: 'Parcel', sourceRepository: 'https://example.test/parcel.git' });
  await writeSecurityPolicy(root, 'parcel', { capabilities: [], sourceSecretHandling: 'reject' });
  const security = createProjectSecurityService({ knowledgeRoot: root });
  return async (body: string) => security.prepareSource({ projectId: 'parcel', source: 'project-knowledge-evaluation.md',
    sourceKind: 'markdown', body, bodyDigest: sha256(body), sourceRevisionOrContentSha256: sha256(body) });
}

function representations(value: string): readonly string[] {
  return [`result.reasonCode=${value}`, `result.reasonCode = ${value}`, `result.reasonCode = "${value}"`,
    `The result reason is "${value}".`, `| Field | Value |\n| --- | --- |\n| result.reasonCode | ${value} |`];
}

describe('answer formatting is presentation, never a security exemption', () => {
  it('preserves a public literal exactly when written as a separated assignment, prose or table', async () => {
    const screen = await securityFixture();
    const value = 'document-reader-semantic-index-unavailable';
    const bodies = representations(value);
    // Pin the current joined-token false positive, not a proposal to permit it.
    const joined = await screen(bodies[0] ?? '');
    expect(joined).toMatchObject({ ok: false, report: { decision: 'blocked' } });
    expect(joined.report.summaries).toContainEqual(expect.objectContaining({ ruleId: 'entropy.candidate' }));
    for (const body of bodies.slice(1)) {
      const result = await screen(body);
      expect(result).toMatchObject({ ok: true, report: { decision: 'include' } });
      if (!result.ok) throw new Error('Expected unchanged public presentation.');
      expect(consumePreparedSource(result.prepared)?.approvedBody).toBe(body);
      expect(body).toContain(value);
      expect(result.report.summaries).toEqual([]);
    }
  });

  it.each(['plain', 'inline-code', 'fenced-code'] as const)('rejects synthetic sensitive values in every %s assignment presentation', async context => {
    const screen = await securityFixture();
    const values = [
      ['aB3dE5fG7hJ9kL2m', 'N4pQ6rS8T0vX'].join(''),
      ['gh', 'p_', 'A1b2C3d4E5f6G7h8J9k0', 'LmNoPq'].join(''),
      ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    ];
    for (const value of values) for (const line of representations(value)) {
      const body = context === 'plain' ? line : context === 'inline-code' ? `\`${line}\`` : ['```text', line, '```'].join('\n');
      const result = await screen(body);
      // Whole evaluation bodies require unchanged approval; redaction is not a pass.
      const approved = result.ok ? consumePreparedSource(result.prepared) : null;
      expect(approved?.approvedBody === body).toBe(false);
      expect(JSON.stringify(result.report)).not.toContain(value);
      expect(result.report.summaries.some(summary => summary.overriddenCount > 0)).toBe(false);
    }
  });

  it('does not allow a benign formatted paragraph to hide a later synthetic entropy value', async () => {
    const screen = await securityFixture();
    const sensitive = ['aB3dE5fG7hJ9kL2m', 'N4pQ6rS8T0vX'].join('');
    const body = ['result.reasonCode = "document-reader-semantic-index-unavailable"',
      `\nAnother field = "${sensitive}"`].join('\n');
    const result = await screen(body);
    expect(result).toMatchObject({ ok: false, report: { decision: 'blocked' } });
    expect(JSON.stringify(result.report)).not.toContain(sensitive);
  });
});
