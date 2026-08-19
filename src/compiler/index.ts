import { basename } from 'node:path';

import { createWiki } from 'llm-wiki-compiler';

import { KnowledgeError } from '../knowledge/errors.js';
import {
  type CompilerChangeStatus,
  type CompilerPendingChange,
  type CompilerStatusPort,
} from '../knowledge/types.js';

const ALLOWED_PENDING_STATUS = new Set(['changed', 'deleted', 'new']);
const ALLOWED_STATE_STATUS = new Set(['corrupt', 'missing', 'ok', 'too-new']);

function normalizeChange(change: { readonly file: string; readonly status: string }): CompilerPendingChange {
  if (
    basename(change.file) !== change.file ||
    change.file.includes('\\') ||
    !change.file.endsWith('.md') ||
    !ALLOWED_PENDING_STATUS.has(change.status)
  ) {
    throw new KnowledgeError('COMPILER_STATUS_UNSAFE', 'Compiler returned an unsafe status item.');
  }
  return {
    file: change.file,
    status: change.status as CompilerPendingChange['status'],
  };
}

export function normalizeCompilerStatus(status: {
  readonly pendingChanges: ReadonlyArray<{ readonly file: string; readonly status: string }>;
  readonly pendingChangesCount: number;
  readonly stateStatus: string;
}): CompilerChangeStatus {
  if (status.pendingChanges.length > 100) {
    throw new KnowledgeError('COMPILER_STATUS_UNSAFE', 'Compiler returned an unsafe status result.');
  }
  const pendingChanges = status.pendingChanges.map(normalizeChange).sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0,
  );
  const uniqueFiles = new Set(pendingChanges.map((change) => change.file));
  if (
    !Number.isSafeInteger(status.pendingChangesCount) ||
    status.pendingChangesCount < pendingChanges.length ||
    uniqueFiles.size !== pendingChanges.length ||
    !ALLOWED_STATE_STATUS.has(status.stateStatus)
  ) {
    throw new KnowledgeError('COMPILER_STATUS_UNSAFE', 'Compiler returned an unsafe status result.');
  }
  if (
    (status.stateStatus === 'corrupt' || status.stateStatus === 'too-new') &&
    (pendingChanges.length !== 0 || status.pendingChangesCount !== 0)
  ) {
    throw new KnowledgeError('COMPILER_STATUS_UNSAFE', 'Compiler returned an unsafe status result.');
  }
  return {
    pendingChanges,
    pendingChangesCount: status.pendingChangesCount,
    stateStatus: status.stateStatus as CompilerChangeStatus['stateStatus'],
  };
}

export async function detectSourceChanges(workspaceRoot: string): Promise<CompilerChangeStatus> {
  try {
    return normalizeCompilerStatus(await createWiki({ root: workspaceRoot }).status());
  } catch (error) {
    if (error instanceof KnowledgeError) {
      throw error;
    }
    throw new KnowledgeError('COMPILER_STATUS_UNSAFE', 'Compiler status could not be read safely.', {
      cause: error,
    });
  }
}

export const compilerStatusPort: CompilerStatusPort = {
  status: detectSourceChanges,
};
