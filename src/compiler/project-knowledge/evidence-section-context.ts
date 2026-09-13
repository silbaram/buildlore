import { sha256 } from '../../knowledge/project-knowledge/guards.js';
import type { KnowledgeEvidenceV1, KnowledgeGenerationV1 } from '../../knowledge/project-knowledge/types.js';
import { containsSecretRedaction } from '../../sanitizer/redaction-marker.js';

interface SectionHeading {
  readonly level: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
}

export interface KnowledgeEvidenceSectionContextV1 {
  readonly status: 'available' | 'partial' | 'unavailable';
  readonly headings: readonly SectionHeading[];
  readonly unavailableReason: 'source-not-in-current-snapshot' | 'not-markdown-lines' | 'redacted-heading' | null;
}

/** Exact enclosing headings from the matching sanitized snapshot, not semantic interpretation.
 * Historical evidence is not joined to a newer source merely because its path is equal.
 * Fenced examples are not document headings. No redacted heading text is returned.
 */
export function knowledgeEvidenceSectionContext(generation: KnowledgeGenerationV1,
  evidence: KnowledgeEvidenceV1): KnowledgeEvidenceSectionContextV1 {
  const unavailable = (reason: KnowledgeEvidenceSectionContextV1['unavailableReason']): KnowledgeEvidenceSectionContextV1 =>
    Object.freeze({ status: 'unavailable', headings: Object.freeze([]), unavailableReason: reason });
  const source = generation.snapshot.sources.find(item => item.sourceId === evidence.sourceId &&
    item.sourceRef === evidence.sourceRef && item.sourceContentDigest === evidence.sourceContentDigest &&
    sha256(item.content) === evidence.sanitizedContentDigest);
  if (!source) return unavailable('source-not-in-current-snapshot');
  if (source.format !== 'markdown' || evidence.locator.kind !== 'lines') return unavailable('not-markdown-lines');
  const lines = source.content.split(/\r\n|\r|\n/u);
  const stack: SectionHeading[] = [];
  let fence: Readonly<{ marker: string; length: number }> | null = null;
  let paragraphStart: number | null = null;
  for (let i = 0; i < evidence.locator.start - 1; i += 1) {
    const line = lines[i] ?? '';
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (boundary) {
      const marker = boundary[1] ?? '';
      if (fence === null) {
        if (marker.startsWith('~') || !(boundary[2] ?? '').includes('`')) fence = { marker: marker[0] ?? '', length: marker.length };
      } else if (marker[0] === fence.marker && marker.length >= fence.length && (boundary[2] ?? '').trim() === '') fence = null;
      paragraphStart = null;
      continue;
    }
    if (fence !== null) { paragraphStart = null; continue; }
    const atx = /^ {0,3}(#{1,6})(?:[\t ]+|$)/u.exec(line);
    const setext: RegExpExecArray | null = paragraphStart !== null ? /^ {0,3}(=+|-+)[\t ]*$/u.exec(line) : null;
    const level: number = atx ? (atx[1] ?? '').length : setext ? (setext[1]?.startsWith('=') ? 1 : 2) : 0;
    if (level > 0) {
      while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
      const start = setext ? paragraphStart ?? i : i;
      stack.push({ level, startLine: start + 1, endLine: i + 1, excerpt: lines.slice(start, i + 1).join('\n') });
    }
    const paragraphText = level === 0 && line.trim() !== '' &&
      !/^(?: {4}|\t| {0,3}(?:>|[-+*][\t ]|\d+[.)][\t ]))/u.test(line) &&
      !/^ {0,3}([*_-])(?:[\t ]*\1){2,}[\t ]*$/u.test(line);
    paragraphStart = paragraphText ? paragraphStart ?? i : null;
  }
  const redacted = stack.some(heading => containsSecretRedaction(heading.excerpt));
  return Object.freeze({ status: redacted ? 'partial' : 'available',
    headings: Object.freeze(stack.filter(heading => !containsSecretRedaction(heading.excerpt)).map(heading => Object.freeze(heading))),
    unavailableReason: redacted ? 'redacted-heading' : null });
}
