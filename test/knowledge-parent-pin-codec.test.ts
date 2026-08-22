import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  parseParentKnowledgePinPlan,
  parseParentKnowledgePinResult,
  renderParentKnowledgePinPlan,
  renderParentKnowledgePinResult,
} from '../src/knowledge/parent-pin-codec.js';
import {
  PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION,
  PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION,
  type ParentKnowledgePinPlan,
  type ParentKnowledgePinResult,
} from '../src/knowledge/parent-pin-types.js';
import type { PublicationDigest } from '../src/knowledge/publication-types.js';

const oid = (character: string): string => character.repeat(40);
const digest = (character: string): PublicationDigest => `sha256:${character.repeat(64)}`;

function plan(overrides: Partial<ParentKnowledgePinPlan> = {}): ParentKnowledgePinPlan {
  return {
    schemaVersion: PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION,
    intent: 'iteration-close',
    iterationId: 'v11-knowledge-git-publish-concurrency',
    path: 'knowledge',
    parentRepositoryIdentityDigest: digest('1'),
    knowledgeRepositoryIdentityDigest: digest('2'),
    parentBaseRevision: oid('a'),
    codeRevision: oid('a'),
    oldKnowledgeGitlink: oid('b'),
    newKnowledgeGitlink: oid('c'),
    projectId: 'alpha',
    sourceRevision: oid('d'),
    lineageDigest: digest('3'),
    targetRemoteReachability: true,
    noOp: false,
    eligible: true,
    blockReasons: [],
    planDigest: digest('4'),
    ...overrides,
  };
}

function appliedResult(): ParentKnowledgePinResult {
  return {
    schemaVersion: PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION,
    intent: 'iteration-close',
    iterationId: 'v11-knowledge-git-publish-concurrency',
    path: 'knowledge',
    projectId: 'alpha',
    sourceRevision: oid('d'),
    parentBaseRevision: oid('a'),
    codeRevision: oid('a'),
    oldKnowledgeGitlink: oid('b'),
    newKnowledgeGitlink: oid('c'),
    targetRemoteReachability: true,
    planDigest: digest('4'),
    state: 'applied',
    applied: true,
    noOp: false,
    partial: false,
    resultingParentCommitSha: oid('e'),
    recoveryCommand: ['knowledge', 'status'],
  };
}

describe('parent knowledge pin canonical codecs', () => {
  it('round-trips canonical plans and enforces ordered eligibility invariants', () => {
    const eligible = plan();
    expect(parseParentKnowledgePinPlan(renderParentKnowledgePinPlan(eligible))).toEqual(eligible);

    const ineligible = plan({
      blockReasons: ['KNOWLEDGE_REMOTE_MISSING', 'PARENT_DIRTY'],
      eligible: false,
      lineageDigest: null,
      projectId: null,
      sourceRevision: null,
      targetRemoteReachability: false,
    });
    expect(parseParentKnowledgePinPlan(renderParentKnowledgePinPlan(ineligible)))
      .toEqual(ineligible);
    expect(() => renderParentKnowledgePinPlan(plan({ eligible: false }))).toThrow();
    expect(() => renderParentKnowledgePinPlan(plan({
      blockReasons: ['PARENT_DIRTY', 'KNOWLEDGE_REMOTE_MISSING'],
      eligible: false,
    }))).toThrow();
    expect(() => renderParentKnowledgePinPlan(plan({ noOp: true }))).toThrow();
    expect(() => renderParentKnowledgePinPlan(plan({ targetRemoteReachability: false })))
      .toThrow();
    expect(() => renderParentKnowledgePinPlan(plan({ codeRevision: oid('f') }))).toThrow();
  });

  it('rejects unknown, duplicate, shuffled, wrong-version, bounds, OID, and LF negatives', () => {
    const canonical = renderParentKnowledgePinPlan(plan());
    const unknown = canonical.replace(
      '  "planDigest"',
      '  "unknown": true,\n  "planDigest"',
    );
    const duplicate = canonical.replace(
      '  "intent": "iteration-close",',
      '  "intent": "iteration-close",\n  "intent": "iteration-close",',
    );
    const shuffled = canonical.replace(
      '  "intent": "iteration-close",\n  "iterationId": "v11-knowledge-git-publish-concurrency",',
      '  "iterationId": "v11-knowledge-git-publish-concurrency",\n  "intent": "iteration-close",',
    );
    const invalids = [
      unknown,
      duplicate,
      shuffled,
      canonical.replace(PARENT_KNOWLEDGE_PIN_PLAN_SCHEMA_VERSION, 'unknown.v2'),
      canonical.replace('v11-knowledge-git-publish-concurrency', 'x'.repeat(121)),
      canonical.replace(oid('a'), 'A'.repeat(40)),
      canonical.slice(0, -1),
      `${canonical}\n`,
      `\ufeff${canonical}`,
    ];
    for (const invalid of invalids) {
      expect(() => parseParentKnowledgePinPlan(invalid)).toThrow();
    }
    expect(() => parseParentKnowledgePinPlan(
      new Uint8Array([0xff, 0x0a]),
    )).toThrow();
  });

  it('round-trips applied, no-op, and exact blocked result semantics', () => {
    const applied = appliedResult();
    expect(parseParentKnowledgePinResult(renderParentKnowledgePinResult(applied))).toEqual(applied);

    const noOp: ParentKnowledgePinResult = {
      ...applied,
      state: 'no-op',
      applied: false,
      noOp: true,
      parentBaseRevision: oid('f'),
      oldKnowledgeGitlink: oid('c'),
      partial: false,
      resultingParentCommitSha: null,
    };
    expect(parseParentKnowledgePinResult(renderParentKnowledgePinResult(noOp))).toEqual(noOp);
    expect(() => renderParentKnowledgePinResult({
      ...applied,
      codeRevision: oid('f'),
    })).toThrow();

    const blockedBase = {
      schemaVersion: applied.schemaVersion,
      intent: applied.intent,
      iterationId: applied.iterationId,
      path: applied.path,
      projectId: applied.projectId,
      sourceRevision: applied.sourceRevision,
      parentBaseRevision: applied.parentBaseRevision,
      codeRevision: applied.codeRevision,
      oldKnowledgeGitlink: applied.oldKnowledgeGitlink,
      newKnowledgeGitlink: applied.newKnowledgeGitlink,
      targetRemoteReachability: applied.targetRemoteReachability,
      planDigest: applied.planDigest,
    };
    const blocked: readonly ParentKnowledgePinResult[] = [
      { ...blockedBase, state: 'blocked', errorCode: 'PARENT_PIN_INELIGIBLE', applied: false, noOp: false, partial: false, resultingParentCommitSha: null, recoveryCommand: ['knowledge', 'status'] },
      { ...blockedBase, state: 'blocked', errorCode: 'PARENT_PIN_PLAN_DRIFT', applied: false, noOp: false, partial: false, resultingParentCommitSha: null, recoveryCommand: ['knowledge', 'status'] },
      { ...blockedBase, state: 'blocked', errorCode: 'PARENT_PIN_REPOSITORY_BUSY', applied: false, noOp: false, partial: false, resultingParentCommitSha: null, recoveryCommand: ['knowledge', 'status'] },
      { ...blockedBase, state: 'blocked', errorCode: 'PARENT_PIN_TRANSACTION_FAILED', applied: false, noOp: false, partial: false, resultingParentCommitSha: null, recoveryCommand: ['knowledge', 'status'] },
      { ...blockedBase, state: 'blocked', errorCode: 'PARENT_PIN_PARTIAL', applied: false, noOp: false, partial: true, resultingParentCommitSha: null, recoveryCommand: ['knowledge', 'status'] },
      { ...blockedBase, state: 'blocked', errorCode: 'PARENT_PIN_POSTVERIFY_FAILED', applied: false, noOp: false, partial: true, resultingParentCommitSha: oid('e'), recoveryCommand: ['knowledge', 'status'] },
    ];
    for (const result of blocked) {
      expect(parseParentKnowledgePinResult(renderParentKnowledgePinResult(result))).toEqual(result);
    }
  });

  it('rejects contradictory blocked code/partial/commit combinations and noncanonical JSON', () => {
    const base = appliedResult();
    const invalids = [
      { ...base, state: 'blocked', errorCode: 'PARENT_PIN_INELIGIBLE', applied: false, partial: true },
      { ...base, state: 'blocked', errorCode: 'PARENT_PIN_PARTIAL', applied: false, partial: false, resultingParentCommitSha: null },
      { ...base, state: 'blocked', errorCode: 'PARENT_PIN_PARTIAL', applied: false, partial: true },
      { ...base, state: 'blocked', errorCode: 'PARENT_PIN_POSTVERIFY_FAILED', applied: false, partial: true, resultingParentCommitSha: null },
    ];
    for (const invalid of invalids) {
      expect(() => renderParentKnowledgePinResult(
        invalid as unknown as ParentKnowledgePinResult,
      )).toThrow();
    }
    const canonical = renderParentKnowledgePinResult(base);
    const invalidJson = [
      canonical.slice(0, -1),
      `${canonical}\n`,
      `\ufeff${canonical}`,
      canonical.replace(
        '  "intent": "iteration-close",',
        '  "intent": "iteration-close",\n  "intent": "iteration-close",',
      ),
      canonical.replace(
        '  "resultingParentCommitSha":',
        '  "unknown": true,\n  "resultingParentCommitSha":',
      ),
      canonical.replace(
        '  "intent": "iteration-close",\n  "iterationId": "v11-knowledge-git-publish-concurrency",',
        '  "iterationId": "v11-knowledge-git-publish-concurrency",\n  "intent": "iteration-close",',
      ),
      canonical.replace(PARENT_KNOWLEDGE_PIN_RESULT_SCHEMA_VERSION, 'unknown.result.v2'),
      canonical.replace('v11-knowledge-git-publish-concurrency', 'x'.repeat(121)),
      canonical.replace(oid('a'), 'A'.repeat(40)),
      canonical.replace(digest('4'), 'sha256:INVALID'),
    ];
    for (const invalid of invalidJson) {
      expect(() => parseParentKnowledgePinResult(invalid)).toThrow();
    }
    expect(() => parseParentKnowledgePinResult(new Uint8Array([0xff, 0x0a]))).toThrow();
  });

  it('keeps checked-in parent pin plan/result schemas bounded and closed', async () => {
    const [planSchema, resultSchema] = await Promise.all([
      readFile('schemas/knowledge-parent-pin-plan.schema.json', 'utf8'),
      readFile('schemas/knowledge-parent-pin-result.schema.json', 'utf8'),
    ]);
    const parsedPlan: unknown = JSON.parse(planSchema);
    const parsedResult: unknown = JSON.parse(resultSchema);
    expect(parsedPlan).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(typeof parsedResult === 'object' && parsedResult !== null &&
      'oneOf' in parsedResult && Array.isArray(parsedResult.oneOf)).toBe(true);
    expect(planSchema).toContain('"maxItems": 8');
    expect(resultSchema).toContain('PARENT_PIN_POSTVERIFY_FAILED');
  });
});
