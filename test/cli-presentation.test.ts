import { describe, expect, it } from 'vitest';

import {
  CliQualityGateError,
  CliUsageError,
  mapCliError,
  renderCliResult,
  type CliFailureResult,
  type CliSuccessResult,
} from '../src/cli/index.js';
import { CompilerOperationError, ProjectCheckError } from '../src/compiler/index.js';
import { KnowledgeError } from '../src/knowledge/errors.js';
import { ProjectSyncError } from '../src/projector/index.js';
import { RetrievalOperationError } from '../src/retrieval/index.js';
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
});
