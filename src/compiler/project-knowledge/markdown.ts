import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { digest, invalid, sha256 } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1 } from '../../knowledge/project-knowledge/types.js';

export interface KnowledgeMaterializedFileV1 {
  readonly path: string;
  readonly body: string;
  readonly byteLength: number;
  readonly sha256: string;
}

function label(value: string): string { return value.replaceAll('\n', ' ').replaceAll('\r', ' ').replace(/[\\`*_[\]<>#]/gu, '\\$&'); }

/** No I/O or LLM call; the accepted generation is the only rendering input. */
export function renderKnowledgeFiles(generation: KnowledgeGenerationV1): readonly KnowledgeMaterializedFileV1[] {
  const file = (path: string, body: string): KnowledgeMaterializedFileV1 =>
    Object.freeze({ path, body, byteLength: Buffer.byteLength(body), sha256: sha256(body) });
  const result: KnowledgeMaterializedFileV1[] = [];
  const facts = new Map(generation.records.map((r) => [r.id, r]));
  const evidence = new Map(generation.evidence.map((e) => [e.evidenceId, e]));
  for (const page of generation.pages) {
    const used = new Set<KnowledgeDigest>();
    const body = [`# ${label(page.title)}`, '',
      `Project: ${generation.projectId}`, `Generation: ${generation.generationDigest}`, '',
      ...page.sections.flatMap((section) => [`## ${label(section.title)}`, '',
        ...section.claims.flatMap((claim) => {
          const cited = claim.factIds.map((id) => {
            const fact = facts.get(id);
            if (!fact) return invalid();
            used.add(id);
            return `[^${id}]`;
          });
          return [`${claim.presentation === 'current' ? '' : `[${claim.presentation}] `}${claim.text} ${cited.join('')}`, ''];
        })]),
      '## Evidence and scope', '',
      ...[...used].sort().map((id) => {
        const fact = facts.get(id);
        if (!fact) return invalid();
        const citations = fact.evidenceIds.map((evidenceId) => {
          const entry = evidence.get(evidenceId);
          if (!entry) return invalid();
          return `${label(entry.origin?.sourceRef ?? entry.sourceRef)} ${label(serializeCanonicalJson(entry.origin ?? entry.locator).trimEnd())}; ` +
            `source revision=${label(entry.sourceRevision ?? 'unknown')}; code revision=${label(entry.codeRevision ?? 'unknown')}; evidence=${evidenceId}`;
        });
        return `[^${id}]: ${fact.classification}; ${fact.lifecycle}; ${fact.reviewStatus}; ` +
          `scope: ${label(fact.scope)}. ${citations.join(' | ')}`;
      }), '',
    ].join('\n');
    if (Buffer.byteLength(body) > 262_144) invalid();
    result.push(file(`${page.role}.md`, body));
  }
  result.push(file('knowledge.json', serializeCanonicalJson({ schemaVersion: 'buildlore.knowledge-records.v1',
    projectId: generation.projectId, generationDigest: generation.generationDigest, records: generation.records })));
  result.push(file('evidence.json', serializeCanonicalJson({ schemaVersion: 'buildlore.knowledge-evidence-manifest.v1',
    projectId: generation.projectId, generationDigest: generation.generationDigest, evidence: generation.evidence })));
  const basis = { schemaVersion: 'buildlore.knowledge-materialization.v1', projectId: generation.projectId,
    generationDigest: generation.generationDigest, snapshotDigest: generation.snapshot.snapshotDigest,
    rendererVersion: generation.rendererVersion, recordsDigest: digest(generation.records),
    evidenceDigest: digest(generation.evidence), files: result.map(({ path, byteLength, sha256: hash }) => ({ path, byteLength, sha256: hash })) };
  result.push(file('manifest.json', serializeCanonicalJson({ ...basis, manifestDigest: digest(basis) })));
  return Object.freeze(result);
}
