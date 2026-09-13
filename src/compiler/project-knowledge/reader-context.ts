import { invalid } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeGenerationV1 } from '../../knowledge/project-knowledge/types.js';

function label(value: string): string {
  return value.replace(/[\r\n]/gu, ' ').replace(/[\\`*_[\]<>#]/gu, '\\$&');
}

/** Pure presentation of validated records, not approval or disclosure authority.
 * No ranking, oracle, truncation, summarization or mutation of stored Markdown.
 * Full prose, scope, state and evidence identities stay visible; excerpts use lookup.
 */
export function renderKnowledgeReaderPages(input: Pick<KnowledgeGenerationV1, 'projectId' | 'records' | 'pages'>):
readonly Readonly<{ path: string; body: string }>[] {
  const records = new Map(input.records.map(fact => [fact.id, fact]));
  return Object.freeze(input.pages.map(page => {
    const used = [...new Set(page.sections.flatMap(section => section.claims.flatMap(claim => claim.factIds)))].sort();
    const body = [`# ${label(page.title)}`, '', `Project: ${input.projectId}; reading format: knowledge-reader-v1`, '',
      'Full Wiki prose below. Source excerpts and full fact provenance are available through lookup, not omitted facts. ' +
      'Fact state is not proof of running code. Read source evidence before making source-level assertions.', '',
      ...page.sections.flatMap(section => [`## ${label(section.title)}`, '', ...section.claims.flatMap(claim => [
        `${claim.presentation === 'current' ? '' : `[${claim.presentation}] `}${claim.text} ` +
          claim.factIds.map(id => `[fact:${id}]`).join(' '), ''])]),
      '## Fact scope, state and source lookup IDs', '', ...used.map(id => {
        const fact = records.get(id);
        if (!fact || fact.projectId !== input.projectId) return invalid();
        return `[fact:${id}] ${fact.classification}/${fact.lifecycle}/${fact.reviewStatus}; scope: ${label(fact.scope)}; ` +
          `superseded by: ${fact.supersededBy.map(next => `[fact:${next}]`).join(' ') || 'none'}; ` +
          fact.evidenceIds.map(evidenceId => `[evidence:${evidenceId}]`).join(' ');
      }), '',
    ].join('\n');
    if (Buffer.byteLength(body) > 262_144) invalid();
    return Object.freeze({ path: `${page.role}.md`, body });
  }));
}
