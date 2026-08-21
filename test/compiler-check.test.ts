import { describe, expect, it, vi } from 'vitest';

import {
  createProjectCheck,
  ProjectCheckError,
  type CompilerOperationResult,
  type EvalSummary,
  type NormalizedLintSummary,
  type ProjectCheckGateCode,
  type ProjectCompilerPort,
  type StatusSummary,
} from '../src/compiler/index.js';

const CLEAN_STATUS: StatusSummary = {
  lastCompiledAt: '2026-08-21T00:00:00.000Z',
  orphanedCount: 0,
  orphanedPages: [],
  pageCount: 1,
  pendingCandidates: 0,
  pendingChanges: [],
  pendingChangesCount: 0,
  sourceCount: 1,
  staleCount: 0,
  stalePages: [],
  stateStatus: 'ok',
};

const CLEAN_LINT: NormalizedLintSummary = {
  errors: 0,
  findings: [],
  info: 0,
  warnings: 0,
};

const CLEAN_EVAL: EvalSummary = {
  citationCoveragePercent: 100,
  citationPrecisionPercent: 100,
  embeddingsAvailable: false,
  healthScore: 100,
  pageCount: 1,
  pendingReviews: 0,
  sourceCount: 1,
  suite: 'fast',
  thresholdViolationCount: 0,
};

function operation(
  capability: 'eval-fast' | 'lint' | 'status',
  data: EvalSummary | NormalizedLintSummary | StatusSummary,
): CompilerOperationResult {
  return {
    capability,
    data,
    ok: true,
    outcome: 'succeeded',
    projectId: 'alpha',
    warnings: [],
  };
}

function fakeCompiler(options: {
  readonly after?: StatusSummary;
  readonly evaluation?: EvalSummary;
  readonly failAt?: 'eval-fast' | 'lint' | 'status';
  readonly lint?: NormalizedLintSummary;
  readonly status?: StatusSummary;
} = {}): {
  readonly capabilities: readonly string[];
  readonly compiler: ProjectCompilerPort;
  readonly execute: ReturnType<typeof vi.fn>;
} {
  let statusCalls = 0;
  const capabilities: string[] = [];
  const execute = vi.fn((request: { readonly capability: string }) => {
    capabilities.push(request.capability);
    if (request.capability === options.failAt) {
      return Promise.reject(new Error('CREDENTIAL-SENTINEL /private/path'));
    }
    if (request.capability === 'status') {
      statusCalls += 1;
      return Promise.resolve(operation(
        'status',
        statusCalls === 1
          ? options.status ?? CLEAN_STATUS
          : options.after ?? options.status ?? CLEAN_STATUS,
      ));
    }
    if (request.capability === 'lint') {
      return Promise.resolve(operation('lint', options.lint ?? CLEAN_LINT));
    }
    return Promise.resolve(operation('eval-fast', options.evaluation ?? CLEAN_EVAL));
  });
  return {
    capabilities,
    compiler: {
      execute,
      status: () => Promise.resolve(CLEAN_STATUS),
    },
    execute,
  };
}

describe('credential-free project quality check', () => {
  it('passes only a stable clean snapshot and calls no provider capability', async () => {
    const fixture = fakeCompiler();
    await expect(createProjectCheck(fixture.compiler).check('alpha')).resolves.toMatchObject({
      gateCodes: [],
      passed: true,
      projectId: 'alpha',
      status: { stateStatus: 'ok' },
    });
    expect(fixture.capabilities).toEqual([
      'status',
      'lint',
      'eval-fast',
      'status',
    ]);
  });

  it.each<readonly [ProjectCheckGateCode, Parameters<typeof fakeCompiler>[0]]>([
    ['pending-changes', { status: { ...CLEAN_STATUS, pendingChangesCount: 1 } }],
    ['state-unhealthy', { status: { ...CLEAN_STATUS, stateStatus: 'missing' } }],
    ['pending-candidates', { status: { ...CLEAN_STATUS, pendingCandidates: 1 } }],
    ['pending-reviews', { evaluation: { ...CLEAN_EVAL, pendingReviews: 1 } }],
    ['stale-pages', { status: { ...CLEAN_STATUS, staleCount: 1 } }],
    ['orphaned-pages', { status: { ...CLEAN_STATUS, orphanedCount: 1 } }],
    ['lint-errors', { lint: { ...CLEAN_LINT, errors: 1 } }],
    ['eval-threshold-violations', {
      evaluation: { ...CLEAN_EVAL, thresholdViolationCount: 1 },
    }],
  ])('returns a completed quality block for %s', async (gateCode, options) => {
    const fixture = fakeCompiler(options);
    await expect(createProjectCheck(fixture.compiler).check('alpha')).resolves.toMatchObject({
      gateCodes: [gateCode],
      passed: false,
    });
  });

  it('fails safely with partial component identity when a component fails', async () => {
    const fixture = fakeCompiler({ failAt: 'lint' });
    const failure = await createProjectCheck(fixture.compiler).check('alpha')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProjectCheckError);
    expect(failure).toMatchObject({
      code: 'CHECK_COMPONENT_FAILED',
      completedComponents: ['status-before'],
      partial: true,
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toMatch(/CREDENTIAL|private/u);
  });

  it('requires retry when the status snapshot changes during the read', async () => {
    const fixture = fakeCompiler({
      after: { ...CLEAN_STATUS, pendingCandidates: 1 },
    });
    await expect(createProjectCheck(fixture.compiler).check('alpha')).rejects.toMatchObject({
      code: 'CHECK_SNAPSHOT_CHANGED',
      completedComponents: ['status-before', 'lint', 'eval-fast', 'status-after'],
      retryable: true,
    });
  });
});
