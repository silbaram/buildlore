import { KnowledgeError } from '../knowledge/errors.js';
import {
  resolveLocalProjectBinding,
  type Sha256Digest,
} from '../knowledge/local-project-registry.js';
import type { ProjectRegistryEntry } from '../knowledge/types.js';
import { SourceSelectionError } from './errors.js';
import { readSourceCollectionManifest } from './source-manifest.js';

export type LocalSourceState = 'invalid' | 'missing' | 'ready';
export type LocalSourceManifestStatus = 'invalid' | 'missing' | 'ready' | 'unavailable';

export interface LocalSourceStatus {
  readonly bindingDigest: Sha256Digest | null;
  readonly manifestDigest: Sha256Digest | null;
  readonly manifestStatus: LocalSourceManifestStatus;
  readonly reasonCode: string;
  readonly state: LocalSourceState;
}

function status(
  state: LocalSourceState,
  manifestStatus: LocalSourceManifestStatus,
  reasonCode: string,
  bindingDigest: Sha256Digest | null = null,
  manifestDigest: Sha256Digest | null = null,
): LocalSourceStatus {
  return Object.freeze({
    bindingDigest,
    manifestDigest,
    manifestStatus,
    reasonCode,
    state,
  });
}

/**
 * Resolves local-only source state into a path-free CLI-safe status. The
 * checkout capability and all absolute paths remain confined to this module.
 */
export async function inspectLocalSourceStatus(
  hubRoot: string,
  project: ProjectRegistryEntry,
): Promise<LocalSourceStatus> {
  let resolved: Awaited<ReturnType<typeof resolveLocalProjectBinding>>;
  try {
    resolved = await resolveLocalProjectBinding(
      hubRoot,
      project.projectId,
      project.sourceRepository,
    );
  } catch (error) {
    if (error instanceof KnowledgeError) {
      return status(
        error.code === 'SOURCE_BINDING_REQUIRED' ? 'missing' : 'invalid',
        'unavailable',
        error.code,
      );
    }
    throw error;
  }

  try {
    const loaded = await readSourceCollectionManifest(resolved.checkout, project.projectId);
    return status(
      'ready',
      'ready',
      'READY',
      resolved.bindingDigest,
      loaded.manifestDigest,
    );
  } catch (error) {
    if (error instanceof SourceSelectionError) {
      return status(
        'ready',
        error.code === 'SOURCE_MANIFEST_REQUIRED' ? 'missing' : 'invalid',
        error.code,
        resolved.bindingDigest,
      );
    }
    throw error;
  }
}
