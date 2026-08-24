import { readGitRevisionSnapshot } from '../knowledge/git.js';
import type { SourceCheckoutHandle } from '../knowledge/local-project-registry.js';
import { ProjectionError } from './errors.js';
import { normalizeRfc3339Instant } from './timestamp.js';

const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface SourceRevisionSnapshot {
  readonly committedAt: string;
  readonly head: string;
}

export interface SourceRevisionReader {
  read(checkout: SourceCheckoutHandle): Promise<SourceRevisionSnapshot>;
}

function fail(): never {
  throw new ProjectionError(
    'PROJECTION_ARTIFACT_INVALID',
    'The bound source revision could not be verified.',
  );
}

export function createSourceRevisionReader(): SourceRevisionReader {
  return {
    async read(checkout): Promise<SourceRevisionSnapshot> {
      let snapshot;
      try {
        snapshot = await readGitRevisionSnapshot(checkout.resolveRootForInternalUse());
      } catch {
        return fail();
      }
      const committedAt = normalizeRfc3339Instant(snapshot.committedAt);
      if (!GIT_OBJECT_ID_PATTERN.test(snapshot.head) || committedAt === null) return fail();
      return Object.freeze({ committedAt, head: snapshot.head });
    },
  };
}
