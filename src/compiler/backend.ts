import {
  createWiki,
  LockUnavailableError,
  ProviderUnavailableError,
  UnknownProviderError,
} from 'llm-wiki-compiler';
import { isAbsolute, relative } from 'node:path';

import { CompilerBackendError } from './errors.js';
import type { CompilerBackend, CompilerRequest } from './types.js';

interface CompilerSdk {
  compile(): Promise<unknown>;
  getContextPack(options: {
    readonly budget?: number;
    readonly depth?: number;
    readonly prompt: string;
    readonly topChunks?: number;
    readonly topPages?: number;
  }): Promise<unknown>;
  lint(): Promise<unknown>;
  query(question: string, options: { readonly debug: false; readonly save: false }): Promise<unknown>;
  runEval(options: {
    readonly mode: 'fast' | 'full';
    readonly record: false;
  }): Promise<unknown>;
  search(question: string): Promise<unknown>;
  status(): Promise<unknown>;
}

type WikiFactory = (workspaceRoot: string) => CompilerSdk;

function defaultWikiFactory(workspaceRoot: string): CompilerSdk {
  return createWiki({ root: workspaceRoot });
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as { readonly code?: unknown; readonly name?: unknown };
  return (
    record.name === 'APIConnectionTimeoutError' ||
    record.name === 'AbortError' ||
    record.code === 'ETIMEDOUT' ||
    record.code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

function classifyBackendError(error: unknown): CompilerBackendError {
  if (error instanceof ProviderUnavailableError) {
    return new CompilerBackendError('provider-unavailable');
  }
  if (error instanceof UnknownProviderError) {
    return new CompilerBackendError('provider-unknown');
  }
  if (error instanceof LockUnavailableError) {
    return new CompilerBackendError('busy');
  }
  if (isTimeoutError(error)) {
    return new CompilerBackendError('timeout');
  }
  return new CompilerBackendError('failed');
}

function noOpCompileResult(status: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof status !== 'object' || status === null) {
    return null;
  }
  const record = status as Readonly<Record<string, unknown>>;
  const warnings = record.warnings;
  if (
    record.stateStatus !== 'ok' ||
    record.pendingChangesCount !== 0 ||
    !Array.isArray(record.pendingChanges) ||
    record.pendingChanges.length !== 0 ||
    typeof record.sources !== 'number' ||
    !Number.isSafeInteger(record.sources) ||
    record.sources < 0 ||
    (warnings !== undefined && (!Array.isArray(warnings) || warnings.length !== 0))
  ) {
    return null;
  }
  return {
    candidates: [],
    compiled: 0,
    concepts: [],
    deleted: 0,
    errors: [],
    pages: [],
    skipped: record.sources,
  };
}

async function runRequest(wiki: CompilerSdk, request: CompilerRequest): Promise<unknown> {
  switch (request.capability) {
    case 'compile': {
      const noOp = noOpCompileResult(await wiki.status());
      return noOp ?? wiki.compile();
    }
    case 'context':
      return wiki.getContextPack({
        prompt: request.prompt,
        ...(request.budget === undefined ? {} : { budget: request.budget }),
        ...(request.depth === undefined ? {} : { depth: request.depth }),
        ...(request.topChunks === undefined ? {} : { topChunks: request.topChunks }),
        ...(request.topPages === undefined ? {} : { topPages: request.topPages }),
      });
    case 'eval-fast':
      return wiki.runEval({ mode: 'fast', record: false });
    case 'eval-full':
      return wiki.runEval({ mode: 'full', record: false });
    case 'lint': {
      const result = await wiki.lint();
      return result;
    }
    case 'query':
      return wiki.query(request.question, { debug: false, save: false });
    case 'search':
      return wiki.search(request.question);
    case 'status':
      return wiki.status();
  }
}

function normalizeLintPaths(result: unknown, workspaceRoot: string): unknown {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('results' in result) ||
    !Array.isArray(result.results)
  ) {
    return result;
  }
  return {
    ...result,
    results: result.results.map((finding: unknown) => {
      if (
        typeof finding !== 'object' ||
        finding === null ||
        !('file' in finding) ||
        typeof finding.file !== 'string'
      ) {
        return finding;
      }
      return {
        ...finding,
        file: isAbsolute(finding.file)
          ? relative(workspaceRoot, finding.file).replaceAll('\\', '/')
          : finding.file.replaceAll('\\', '/'),
      };
    }),
  };
}

export function createLlmWikiCompilerBackend(
  wikiFactory: WikiFactory = defaultWikiFactory,
): CompilerBackend {
  return {
    async run(workspaceRoot, request) {
      try {
        const result = await runRequest(wikiFactory(workspaceRoot), request);
        if (request.capability === 'lint') {
          return normalizeLintPaths(result, workspaceRoot);
        }
        return result;
      } catch (error) {
        if (error instanceof CompilerBackendError) {
          throw error;
        }
        throw classifyBackendError(error);
      }
    },
  };
}
