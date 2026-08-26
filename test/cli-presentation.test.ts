import { describe, expect, it } from 'vitest';

import {
  CliQualityGateError,
  CliUsageError,
  mapCliError,
  renderCliResult,
  type CliFailureResult,
  type CliSuccessResult,
} from '../src/cli/index.js';
import {
  CompilerOperationError,
  ProjectCheckError,
  SessionCompileError,
} from '../src/compiler/index.js';
import { KnowledgeError } from '../src/knowledge/errors.js';
import {
  MAX_SYNC_SANITIZATION_DIAGNOSTIC_SOURCES,
  ProjectSyncError,
  type ProjectSyncSanitizationDiagnostics,
} from '../src/projector/index.js';
import { RetrievalOperationError } from '../src/retrieval/index.js';
import { SECURITY_RULES } from '../src/sanitizer/index.js';
import { SecurityOperationError } from '../src/sanitizer/errors.js';

describe('CLI presentation and exit taxonomy', () => {
  it('renders deterministic human output by default', () => {
    const result: CliSuccessResult = {
      command: 'project.show',
      data: { z: 2, a: 1 },
      exitCode: 0,
      ok: true,
      projectId: 'alpha',
      workspacePath: 'projects/alpha',
    };

    expect(renderCliResult(result, 'human')).toEqual({
      exitCode: 0,
      message:
        'project.show: ok\n' +
        'project: alpha\n' +
        'workspace: projects/alpha\n' +
        'result:\n' +
        '{\n  "a": 1,\n  "z": 2\n}\n',
      stream: 'stdout',
    });
  });

  it('renders a bounded session-plan summary in human mode', () => {
    const sourceBody = 'private-plan-body-must-not-be-rendered';
    const result: CliSuccessResult = {
      command: 'compile.plan',
      data: {
        schemaVersion: 'buildlore.compile-plan.v2',
        projectId: 'alpha',
        contractDigest: `sha256:${'a'.repeat(64)}`,
        planDigest: `sha256:${'b'.repeat(64)}`,
        algorithmVersion: 'buildlore.session-planner.v1',
        sources: [{ sanitizedBody: sourceBody }],
        tasks: [{ taskId: 'task' }],
        mergeCandidates: [],
        allowedLinkTargets: [],
      },
      exitCode: 0,
      ok: true,
      projectId: 'alpha',
    };

    const rendered = renderCliResult(result, 'human').message;

    expect(rendered).toContain('"sourceCount": 1');
    expect(rendered).toContain('"taskCount": 1');
    expect(rendered).not.toContain(sourceBody);
    expect(rendered.length).toBeLessThan(2_000);
  });

  it('renders the fixed JSON envelope and one trailing LF', () => {
    const result: CliFailureResult = {
      command: 'compile',
      data: null,
      errors: [{ code: 'COMPILER_FAILED', message: 'Compiler execution failed safely.' }],
      exitCode: 4,
      ok: false,
      partial: false,
      projectId: 'alpha',
    };

    expect(renderCliResult(result, 'json')).toEqual({
      exitCode: 4,
      message:
        '{"schemaVersion":"buildlore.cli-envelope.v1","command":"compile","ok":false,' +
        '"projectId":"alpha","workspacePath":null,"knowledgeRevision":null,"data":null,' +
        '"partial":false,"warnings":[],"errors":[{"code":"COMPILER_FAILED",' +
        '"message":"Compiler execution failed safely."}]}\n',
      stream: 'stderr',
    });
  });

  it('[V9-V-12][V10-V-13] preserves the complete search verdict in human and JSON output', () => {
    const data = {
      embeddingCompatibility: {
        currentIdentity: null,
        reasonCode: 'provider-unconfigured',
        rebuildRequired: false,
        state: 'unavailable',
      },
      effectiveMode: 'lexical',
      excluded: { archived: 1, orphaned: 2, stale: 3, unverified: 4 },
      fallback: {
        fromMode: 'hybrid',
        reasonCode: 'provider-unconfigured',
        toMode: 'lexical',
      },
      hits: [{
        freshness: 'fresh',
        matchedEvidence: [{ field: 'title', matchKind: 'word', matchedFeatureCount: 1 }],
        pageId: 'decisions/page-01',
        rank: 1,
        score: 1,
        scoreComponents: { combinedScore: 1 },
        scoreKind: 'lexical-weighted-coverage',
        sourceRefs: ['repo@v1:docs/page.md'],
        summary: 'summary',
        title: 'title',
      }],
      partial: true,
      projectId: 'alpha',
      recoveryAction: {
        command: ['compile', '--project', 'alpha'],
        rebuildRequired: false,
      },
      requestedMode: 'hybrid',
      retrievalStrategy: {
        normalization: 'NFC+Unicode-lowercase',
        scoring: 'weighted-query-coverage-v1',
        strategyDigest: `sha256:${'1'.repeat(64)}`,
        tokenizerId: 'buildlore-unicode-hangul-ngram',
        tokenizerVersion: 1,
      },
      warnings: [{ code: 'provider-unconfigured' }],
    };
    const result: CliSuccessResult = {
      command: 'search',
      data,
      exitCode: 0,
      ok: true,
      partial: true,
      projectId: 'alpha',
    };

    const human = renderCliResult(result, 'human').message;
    const json = JSON.parse(renderCliResult(result, 'json').message) as { data: unknown };
    const humanData = JSON.parse(
      human.slice(human.indexOf('result:\n') + 'result:\n'.length),
    ) as unknown;
    expect(humanData).toEqual(json.data);
    expect(json.data).toEqual(data);
  });

  it.each([
    {
      error: new CliUsageError('CLI_OPTION_MISSING'),
      exitCode: 2,
    },
    {
      error: new SecurityOperationError('SECURITY_SECRET_SUSPECTED', { projectId: 'alpha' }),
      exitCode: 3,
    },
    {
      error: new Error('token=do-not-reflect'),
      exitCode: 4,
    },
    {
      error: new CliQualityGateError(),
      exitCode: 5,
    },
    {
      error: new KnowledgeError('SUBMODULE_CONFLICT', 'secret', {
        recoveryCommand: ['git', 'submodule', 'status'],
      }),
      exitCode: 6,
    },
  ])('maps a failure to exit $exitCode without raw error reflection', ({ error, exitCode }) => {
    const failure = mapCliError(error, { command: 'check', projectId: 'alpha' });
    const rendered = renderCliResult(failure, 'json');

    expect(failure.exitCode).toBe(exitCode);
    expect(rendered.exitCode).toBe(exitCode);
    expect(rendered.message).not.toContain('do-not-reflect');
    expect(rendered.message).not.toContain('"stack"');
  });

  it.each([
    {
      error: new CompilerOperationError(
        'COMPILER_PROVIDER_UNAVAILABLE',
        'provider=do-not-reflect',
        {
          capability: 'compile',
          projectId: 'alpha',
          recoveryAction: 'check-config',
          retryable: false,
          sideEffectsPossible: false,
        },
      ),
      exitCode: 2,
    },
    {
      error: new ProjectSyncError('SYNC_PLAN_BLOCKED', {
        failedPhase: 'planning-plan',
        partial: false,
        recoveryAction: 'inspect-plan',
      }),
      exitCode: 3,
    },
    {
      error: new SessionCompileError('SESSION_PLAN_STALE', 'alpha'),
      exitCode: 3,
    },
    {
      error: new SessionCompileError('SESSION_ADMISSION_FAILED', 'alpha', {
        sideEffectsPossible: true,
      }),
      exitCode: 4,
    },
    {
      error: new SessionCompileError('SESSION_CANDIDATE_BUSY', 'alpha'),
      exitCode: 4,
    },
    {
      error: new ProjectCheckError('CHECK_COMPONENT_FAILED', 'alpha', ['status-before']),
      exitCode: 4,
    },
    {
      error: new RetrievalOperationError('RETRIEVAL_SEMANTIC_DRIFT', 'alpha'),
      exitCode: 4,
    },
  ])('maps domain failures to stable exit $exitCode', ({ error, exitCode }) => {
    const failure = mapCliError(error, { command: 'check', projectId: 'alpha' });
    const rendered = renderCliResult(failure, 'json');

    expect(rendered.exitCode).toBe(exitCode);
    expect(rendered.message).not.toContain('do-not-reflect');
  });

  it('adds only bounded safe sanitization diagnostics to sync failures', () => {
    const sensitive = ['runtime', 'credential', 'value'].join('-');
    const error = new ProjectSyncError('SYNC_SANITIZATION_FAILED', {
      cause: new Error(sensitive),
      failedPhase: 'sanitization',
      partial: false,
      recoveryAction: 'inspect-plan',
      sanitization: {
        omittedSourceCount: 0,
        sources: [{
          findingsOverflow: false,
          sourceIdentitySha256: 'a'.repeat(64),
          sourceKind: 'markdown',
          sourceRef: `/home/private/${sensitive}.md`,
          summaries: [{
            action: 'block',
            count: 1,
            overriddenCount: 0,
            ruleId: 'entropy.candidate',
          }],
        }],
      },
    });

    const failure = mapCliError(error, { command: 'sync', projectId: 'alpha' });
    const rendered = renderCliResult(failure, 'json');

    expect(error.cause).toBeUndefined();
    expect(failure).toMatchObject({
      data: {
        sanitization: {
          omittedSourceCount: 0,
          sources: [{ sourceRef: null }],
        },
      },
      exitCode: 3,
    });
    expect(rendered.message).toContain('"sanitization"');
    expect(rendered.message).not.toContain(sensitive);
    expect(rendered.message).not.toContain('/home/private');
  });

  it('sorts and caps sanitization diagnostics deterministically', () => {
    const sources = Array.from(
      { length: MAX_SYNC_SANITIZATION_DIAGNOSTIC_SOURCES + 3 },
      (_, index) => ({
        findingsOverflow: false,
        sourceIdentitySha256: index.toString(16).padStart(64, '0'),
        sourceKind: 'markdown' as const,
        sourceRef: `docs/${index.toString().padStart(3, '0')}.md`,
        summaries: [{
          action: 'quarantine' as const,
          count: 1,
          overriddenCount: 0,
          ruleId: 'prompt-injection.tool-action',
        }],
      }),
    );
    const options = {
      failedPhase: 'sanitization' as const,
      partial: false,
      recoveryAction: 'inspect-plan' as const,
      sanitization: { omittedSourceCount: 0, sources },
    };

    const forward = new ProjectSyncError('SYNC_SANITIZATION_FAILED', options);
    const reverse = new ProjectSyncError('SYNC_SANITIZATION_FAILED', {
      ...options,
      sanitization: { omittedSourceCount: 0, sources: [...sources].reverse() },
    });

    expect(reverse.sanitization).toEqual(forward.sanitization);
    expect(forward.sanitization?.sources).toHaveLength(
      MAX_SYNC_SANITIZATION_DIAGNOSTIC_SOURCES,
    );
    expect(forward.sanitization?.omittedSourceCount).toBe(3);
    expect(forward.sanitization?.sources[0]?.sourceRef).toBe('docs/000.md');
    expect(forward.sanitization?.sources.at(-1)?.sourceRef).toBe('docs/031.md');
  });

  it.each([0, 1, 32, 33])('normalizes the %i-source diagnostic boundary', (sourceCount) => {
    const sources = Array.from({ length: sourceCount }, (_, index) => ({
      findingsOverflow: false,
      sourceIdentitySha256: index.toString(16).padStart(64, '0'),
      sourceKind: 'markdown' as const,
      sourceRef: `docs/${String(index).padStart(2, '0')}.md`,
      summaries: [{
        action: 'block' as const,
        count: 1,
        overriddenCount: 0,
        ruleId: 'entropy.candidate',
      }],
    }));
    const error = new ProjectSyncError('SYNC_SANITIZATION_FAILED', {
      failedPhase: 'sanitization',
      partial: false,
      recoveryAction: 'inspect-plan',
      sanitization: { omittedSourceCount: 0, sources },
    });

    expect(error.sanitization?.sources).toHaveLength(Math.min(sourceCount, 32));
    expect(error.sanitization?.omittedSourceCount).toBe(Math.max(0, sourceCount - 32));
  });

  it('bounds summaries to the canonical sanitizer rule table', () => {
    const summaries = [
      ...SECURITY_RULES.map((rule) => ({
        action: rule.action,
        count: 1,
        overriddenCount: 0,
        ruleId: rule.ruleId,
      })),
      ...Array.from({ length: 1_000 }, (_, index) => ({
        action: 'block',
        count: 1,
        overriddenCount: 0,
        ruleId: `unknown.rule-${String(index)}`,
      })),
      {
        action: 'redact',
        count: 1,
        overriddenCount: 0,
        ruleId: 'entropy.candidate',
      },
    ];
    const sanitization = {
      omittedSourceCount: 0,
      sources: [{
        findingsOverflow: false,
        sourceIdentitySha256: 'a'.repeat(64),
        sourceKind: 'markdown',
        sourceRef: 'docs/bounded.md',
        summaries,
      }],
    } as unknown as ProjectSyncSanitizationDiagnostics;

    const error = new ProjectSyncError('SYNC_SANITIZATION_FAILED', {
      failedPhase: 'sanitization',
      partial: false,
      recoveryAction: 'inspect-plan',
      sanitization,
    });

    expect(error.sanitization?.sources[0]?.findingsOverflow).toBe(true);
    expect(error.sanitization?.sources[0]?.summaries).toHaveLength(SECURITY_RULES.length);
    expect(error.sanitization?.sources[0]?.summaries.map((summary) => summary.ruleId))
      .toEqual(SECURITY_RULES.map((rule) => rule.ruleId).sort());
    expect(JSON.stringify(error.toJSON())).not.toContain('unknown.rule');
    expect(JSON.stringify(error.toJSON()).length).toBeLessThan(8_192);
  });

  it('canonicalizes duplicate source references independently of input order', () => {
    const sourceIdentitySha256 = 'b'.repeat(64);
    const summary = {
      action: 'block' as const,
      count: 1,
      overriddenCount: 0,
      ruleId: 'entropy.candidate',
    };
    const sources = ['docs/z.md', 'docs/a.md'].map((sourceRef) => ({
      findingsOverflow: false,
      sourceIdentitySha256,
      sourceKind: 'markdown' as const,
      sourceRef,
      summaries: [summary],
    }));
    const create = (orderedSources: typeof sources) => new ProjectSyncError(
      'SYNC_SANITIZATION_FAILED',
      {
        failedPhase: 'sanitization',
        partial: false,
        recoveryAction: 'inspect-plan',
        sanitization: { omittedSourceCount: 0, sources: orderedSources },
      },
    );

    const forward = create(sources);
    const reverse = create([...sources].reverse());

    expect(reverse.sanitization).toEqual(forward.sanitization);
    expect(forward.sanitization?.sources).toHaveLength(1);
    expect(forward.sanitization?.sources[0]?.sourceRef).toBe('docs/a.md');
    expect(forward.sanitization?.sources[0]?.summaries[0]?.count).toBe(2);
  });

  it('drops unsafe source references and emits repeatable JSON bytes', () => {
    const unsafeRefs = [
      '/private/runtime-value.md',
      '../runtime-value.md',
      'docs\\runtime-value.md',
      'docs/control\u0001.md',
      'docs/format\u2060.md',
      'docs/Cafe\u0301.md',
      'docs/private-key/runtime-value.md',
    ];
    const summary = {
      action: 'block' as const,
      count: 1,
      overriddenCount: 0,
      ruleId: 'entropy.candidate',
    };
    const sources = unsafeRefs.map((sourceRef, index) => ({
      findingsOverflow: false,
      sourceIdentitySha256: index.toString(16).padStart(64, '0'),
      sourceKind: 'markdown' as const,
      sourceRef,
      summaries: [summary],
    }));
    sources.push({
      findingsOverflow: false,
      sourceIdentitySha256: 'f'.repeat(64),
      sourceKind: 'markdown',
      sourceRef: '문서/안내.md',
      summaries: [summary],
    });
    const error = new ProjectSyncError('SYNC_SANITIZATION_FAILED', {
      failedPhase: 'sanitization',
      partial: false,
      recoveryAction: 'inspect-plan',
      sanitization: { omittedSourceCount: 0, sources },
    });
    const failure = mapCliError(error, { command: 'sync', projectId: 'alpha' });
    const first = renderCliResult(failure, 'json').message;
    const second = renderCliResult(failure, 'json').message;

    expect(error.sanitization?.sources.filter((source) => source.sourceRef === null))
      .toHaveLength(unsafeRefs.length);
    expect(error.sanitization?.sources[0]?.sourceRef).toBe('문서/안내.md');
    expect(second).toBe(first);
    for (const sourceRef of unsafeRefs) expect(first).not.toContain(sourceRef);
  });

  it('remains deterministic when a rule count overflows', () => {
    const sourceIdentitySha256 = 'c'.repeat(64);
    const summaries = [Number.MAX_SAFE_INTEGER, 1, 1].map((count) => ({
      action: 'block' as const,
      count,
      overriddenCount: 0,
      ruleId: 'entropy.candidate',
    }));
    const create = (orderedSummaries: typeof summaries) => new ProjectSyncError(
      'SYNC_SANITIZATION_FAILED',
      {
        failedPhase: 'sanitization',
        partial: false,
        recoveryAction: 'inspect-plan',
        sanitization: {
          omittedSourceCount: Number.MAX_SAFE_INTEGER,
          sources: [{
            findingsOverflow: false,
            sourceIdentitySha256,
            sourceKind: 'markdown',
            sourceRef: 'docs/overflow.md',
            summaries: orderedSummaries,
          }],
        },
      },
    );

    const forward = create(summaries);
    const reverse = create([...summaries].reverse());

    expect(reverse.sanitization).toEqual(forward.sanitization);
    expect(forward.sanitization).toMatchObject({
      omittedSourceCount: Number.MAX_SAFE_INTEGER,
      sources: [{ findingsOverflow: true, summaries: [] }],
    });
  });
});
