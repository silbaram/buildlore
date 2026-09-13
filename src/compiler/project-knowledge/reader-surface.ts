import { hash, invalid } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1, KnowledgePageRole } from '../../knowledge/project-knowledge/types.js';
import { knowledgeFactSupport, type KnowledgeFactSupportV1 } from './citation-support.js';
import { knowledgeEvidenceSectionContext } from './evidence-section-context.js';
import { renderKnowledgeReaderPages } from './reader-context.js';

export interface KnowledgeReaderPageV1 {
  readonly schemaVersion: 'buildlore.knowledge-reader-page.v1';
  readonly projectId: string;
  readonly generationDigest: KnowledgeDigest;
  readonly page: KnowledgePageRole;
  readonly markdown: string;
  readonly egress: 'none';
}

export interface KnowledgeReaderLookupV1 {
  readonly schemaVersion: 'buildlore.knowledge-reader-lookup.v1';
  readonly projectId: string;
  readonly generationDigest: KnowledgeDigest;
  readonly kind: 'evidence' | 'fact';
  readonly id: KnowledgeDigest;
  readonly result: KnowledgeFactSupportV1 | Readonly<{
    evidence: KnowledgeGenerationV1['evidence'][number];
    sectionContext: ReturnType<typeof knowledgeEvidenceSectionContext>;
  }>;
  readonly egress: 'none';
}

/** Shared CLI/evaluation data surface. Call only with a verified, sanitized generation.
 * Never edits the full export, clips prose, or silently switches generations.
 */
export function knowledgeReaderPage(generation: KnowledgeGenerationV1, page: KnowledgePageRole): KnowledgeReaderPageV1 {
  const file = renderKnowledgeReaderPages(generation).find(item => item.path === `${page}.md`) ?? invalid();
  return Object.freeze({ schemaVersion: 'buildlore.knowledge-reader-page.v1', projectId: generation.projectId,
    generationDigest: generation.generationDigest, page, markdown: file.body, egress: 'none' });
}

export function knowledgeReaderLookup(generation: KnowledgeGenerationV1, kind: 'evidence' | 'fact',
  idValue: KnowledgeDigest): KnowledgeReaderLookupV1 {
  const id = hash(idValue);
  if (kind !== 'evidence' && kind !== 'fact') invalid();
  const result = kind === 'fact' ? knowledgeFactSupport(generation, id) : (() => {
    const evidence = generation.evidence.find(item => item.evidenceId === id) ?? invalid();
    return Object.freeze({ evidence, sectionContext: knowledgeEvidenceSectionContext(generation, evidence) });
  })();
  return Object.freeze({ schemaVersion: 'buildlore.knowledge-reader-lookup.v1', projectId: generation.projectId,
    generationDigest: generation.generationDigest, kind, id, result, egress: 'none' });
}
