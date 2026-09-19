import { invalid } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgePageV1 } from '../../knowledge/project-knowledge/types.js';
import type { ApprovedChildSummaryV1, HierarchicalWikiProposalV1 } from '../hierarchy/types.js';

/** A closing code fence must stay on its own line; citations after it are prose. */
export function knowledgeCitationSeparator(text: string, generic: boolean): string {
  return generic && /^ {0,3}(?:`{3,}|~{3,})[\t ]*$/u.test(text.split('\n').at(-1) ?? '') ? '\n\n' : ' ';
}

export function knowledgeHierarchySummary(page: KnowledgePageV1): string {
  const claim = page.sections[0]?.claims[0];
  if (!claim) invalid();
  return `${claim.presentation === 'current' ? '' : `[${claim.presentation}] `}${claim.text}`;
}

/** Pure prose mapping is replayed at the authority read boundary as well as authoring. */
export function knowledgeHierarchySections(page: KnowledgePageV1,
  claims: readonly Readonly<{ citationIds: readonly string[] }>[],
  children: readonly ApprovedChildSummaryV1[], links: readonly string[],
): HierarchicalWikiProposalV1['sections'] {
  let offset = 0;
  const generic = page.sections[0]?.sectionId !== undefined;
  const separator = generic && [...page.sections.flatMap(section => section.claims.map(claim => claim.text)), ...children.map(child => child.summary)]
    .some(text => /(?:^|\n) {0,3}(?:`{3,}|~{3,})/u.test(text)) ? '\n\n' : ' ';
  const sections = page.sections.map((section, index) => ({ sectionId: `knowledge-${String(index)}`, title: section.title,
    body: section.claims.map((claim) => {
      const linked = claims[offset++];
      if (!linked) invalid();
      return `${claim.presentation === 'current' ? '' : `[${claim.presentation}] `}${claim.text}${knowledgeCitationSeparator(claim.text, generic)}` +
        linked.citationIds.map((id) => `[^${id}]`).join(' ');
    }).join('\n\n') }));
  const first = sections[0];
  if (!first || offset !== claims.length) invalid();
  const childBody = children.map((child) => `${child.summary}${knowledgeCitationSeparator(child.summary, generic)}${child.citationIds.map((id) => `[^${id}]`).join(' ')}`).join(separator);
  sections[0] = { ...first, body: [first.body, childBody, links.map((id) => `[[${id}]]`).join(' ')].filter(Boolean).join(separator) };
  return sections;
}
