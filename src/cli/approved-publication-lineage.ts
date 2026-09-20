import { createHash } from 'node:crypto';
import { serializeCanonicalJson } from '../knowledge/atomic-file.js';
import { readApprovedWikiPublicationSnapshot, ApprovedWikiProjectionError } from '../retrieval/approved-corpus-store.js';
import { latestKnowledgeGeneration } from '../retrieval/project-knowledge-authority.js';
import { readSecurityPolicy } from '../sanitizer/policy.js';
import { CliPublicationIdentityError } from './error-map.js';

interface ApprovedPublicationLineage {
  readonly modelCompatibilityDigest: `sha256:${string}`;
  readonly promptDigest: `sha256:${string}`;
  readonly embeddingCompatibilityDigest: `sha256:${string}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serializeCanonicalJson(value)).digest('hex')}`;
}

/** Identity of the verified, approved authoring inputs; never a provider invocation attestation. */
export async function readApprovedPublicationLineage(
  knowledgeRoot: string,
  projectId: string,
): Promise<ApprovedPublicationLineage | null> {
  let publication;
  try {
    publication = await readApprovedWikiPublicationSnapshot(knowledgeRoot, projectId);
  } catch (error) {
    // A missing authority permits the existing compiler workflow. Damaged or
    // incomplete approved authority must never fall back to unrelated pages.
    if (error instanceof ApprovedWikiProjectionError && error.code === 'APPROVED_WIKI_PROJECTION_UNAVAILABLE') return null;
    throw error;
  }
  if (publication.projection.sanitizerPolicyDigest !== (await readSecurityPolicy(knowledgeRoot, projectId)).digest) {
    throw new CliPublicationIdentityError();
  }
  const { authority } = publication;
  const generation = authority.knowledgeGeneration === undefined ? null
    : latestKnowledgeGeneration(authority.knowledgeGeneration);
  const actors = generation === null ? [] : [generation.proposal.actor, ...generation.records.map(r => r.derivation.actor)];
  const declaredModels = [...new Set(actors.map(actor => serializeCanonicalJson({ kind: actor.kind, model: actor.model })))].sort();
  const exchanges = authority.finalization.generationHandoffs.map(({ exchange }) => {
    if (typeof exchange !== 'object' || exchange === null || !('exchangeDigest' in exchange) ||
        typeof exchange.exchangeDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(exchange.exchangeDigest)) {
      throw new CliPublicationIdentityError();
    }
    return exchange.exchangeDigest;
  }).sort();
  if (exchanges.length === 0) throw new CliPublicationIdentityError();
  return {
    modelCompatibilityDigest: digest({ schemaVersion: 1, kind: 'approved-wiki-declared-author-models',
      declaredModels, modelIdentityAvailable: declaredModels.length > 0, executionMode: 'current-session' }),
    promptDigest: digest({ schemaVersion: 1, kind: 'approved-wiki-authoring-exchanges', exchanges,
      generationDigest: generation?.generationDigest ?? publication.projection.corpus.generationDigest }),
    // Local vector caches are excluded by the tracking policy. Publication of
    // approved text needs no configured or downloaded embedding provider.
    embeddingCompatibilityDigest: digest({ schemaVersion: 1, kind: 'embedding-cache-excluded-from-publication' }),
  };
}
