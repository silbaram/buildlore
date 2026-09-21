import { knowledgeWikiAssessment } from './wiki-contracts.js';
import { knowledgeCitationSeparator } from './hierarchy-prose.js';
import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import { digest, invalid, sha256 } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeDigest, KnowledgeGenerationV1, KnowledgePageV1 } from '../../knowledge/project-knowledge/types.js';
import { knowledgeEvidenceContentKind, knowledgeFactSupport } from './citation-support.js';

export interface KnowledgeMaterializedFileV1 {
  readonly path: string;
  readonly body: string;
  readonly byteLength: number;
  readonly sha256: string;
}

function label(value: string): string { return value.replaceAll('\n', ' ').replaceAll('\r', ' ').replace(/[\\`*_[\]<>#]/gu, '\\$&'); }

function renderPageV2(generation: KnowledgeGenerationV1, page: KnowledgePageV1): string {
  const used = [...new Set(page.sections.flatMap(s => s.claims.flatMap(c => c.factIds)))].sort();
  const supports = used.map(id => knowledgeFactSupport(generation, id));
  const evidenceIds = [...new Set(supports.flatMap(s => s.fact.evidenceIds))].sort();
  return [`# ${label(page.title)}`, '', `Project: ${generation.projectId}`, `Generation: ${generation.generationDigest}`,
    `Snapshot: ${generation.snapshot.snapshotDigest}`, '',
    ...(generation.wikiProof === undefined ? [] : [`Review: ${knowledgeWikiAssessment(generation)?.status}; open issues: ${knowledgeWikiAssessment(generation)?.openFindingCount}.`,
      'Unsupported assertions are withheld. Review findings and unresolved source gaps: knowledge.json (assessment).', '']),
    'Cite [evidence:sha256:…] for source content and [fact:sha256:…] for recorded knowledge state. ' +
      'A heading is not a value. State does not prove running code; absent evidence does not prove feature removal.', '',
    ...page.sections.flatMap(section => [`## ${label(section.title)}`, '', ...section.claims.flatMap(claim => [
      `${claim.presentation === 'current' ? '' : `[${claim.presentation}] `}${claim.text}${knowledgeCitationSeparator(claim.text, generation.rendererVersion === 'knowledge-markdown-v3')}` +
        claim.factIds.map(id => `[^citation-${id.slice(7)}]`).join(' '), ''])]),
    '## Knowledge state', '', ...supports.map(s => {
      const f = s.fact;
      return `[^citation-${f.id.slice(7)}]: cite: [fact:${f.id}]; ${f.classification}; ${f.lifecycle}; ${f.reviewStatus}; ` +
        `record: ${f.recordDigest}; scope: ${label(f.scope)}; derived snapshot: ${f.derivation.snapshotDigest}; ` +
        `superseded by: ${f.supersededBy.join(', ') || 'none'}; ` +
        `present evidence: ${s.presentEvidenceIds.join(', ') || 'none'}; absent evidence: ${s.absentEvidenceIds.join(', ') || 'none'}.`;
    }), '', '## Source evidence', '', ...evidenceIds.map(id => {
      const e = generation.evidence.find(item => item.evidenceId === id);
      if (!e) return invalid();
      const location = e.origin?.jsonPointer ?? (e.origin !== undefined
        ? `lines ${String(e.origin.range.startLine)}-${String(e.origin.range.endLine)}`
        : e.locator.kind === 'json-pointer' ? e.locator.pointer : `lines ${String(e.locator.start)}-${String(e.locator.end)}`);
      return `- cite: [evidence:${id}]; kind: ${knowledgeEvidenceContentKind(e)}; ` +
        `source: ${label(e.origin?.sourceRef ?? e.sourceRef)}; location: ${label(JSON.stringify(location))}; ` +
        `source revision: ${label(e.sourceRevision ?? 'unknown')}; code revision: ${label(e.codeRevision ?? 'unknown')}; ` +
        `excerpt: ${label(JSON.stringify(e.excerpt))}`;
    }), '',
  ].join('\n');
}

/** No I/O or LLM call; the accepted generation is the only rendering input. */
export function renderKnowledgeFiles(generation: KnowledgeGenerationV1): readonly KnowledgeMaterializedFileV1[] {
  const file = (path: string, body: string): KnowledgeMaterializedFileV1 =>
    Object.freeze({ path, body, byteLength: Buffer.byteLength(body), sha256: sha256(body) });
  const result: KnowledgeMaterializedFileV1[] = [];
  const facts = new Map(generation.records.map((r) => [r.id, r]));
  const evidence = new Map(generation.evidence.map((e) => [e.evidenceId, e]));
  for (const page of generation.pages) {
    if (generation.rendererVersion === 'knowledge-markdown-v2' || generation.rendererVersion === 'knowledge-markdown-v3') {
      const body = renderPageV2(generation, page);
      if (Buffer.byteLength(body) > 262_144) invalid();
      result.push(file(`${page.role}.md`, body));
      continue;
    }
    if (generation.rendererVersion !== 'knowledge-markdown-v1') invalid();
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
  result.push(file('knowledge.json', serializeCanonicalJson({ schemaVersion: generation.wikiProof === undefined ? 'buildlore.knowledge-records.v1' : 'buildlore.knowledge-records.v2',
    projectId: generation.projectId, generationDigest: generation.generationDigest, records: generation.records,
    ...(generation.wikiProof === undefined ? {} : { assessment: knowledgeWikiAssessment(generation) }) })));
  result.push(file('evidence.json', serializeCanonicalJson({ schemaVersion: 'buildlore.knowledge-evidence-manifest.v1',
    projectId: generation.projectId, generationDigest: generation.generationDigest, evidence: generation.evidence })));
  const basis = { schemaVersion: 'buildlore.knowledge-materialization.v1', projectId: generation.projectId,
    generationDigest: generation.generationDigest, snapshotDigest: generation.snapshot.snapshotDigest,
    rendererVersion: generation.rendererVersion, recordsDigest: digest(generation.records),
    evidenceDigest: digest(generation.evidence), files: result.map(({ path, byteLength, sha256: hash }) => ({ path, byteLength, sha256: hash })) };
  result.push(file('manifest.json', serializeCanonicalJson({ ...basis, manifestDigest: digest(basis) })));
  return Object.freeze(result);
}
