import {
  inspectSessionExportCitations,
  type SessionExportCitation,
} from './session/export-citations.js';
import {
  transitionSessionMarkdownFence,
  type SessionMarkdownFence,
} from './session/markdown-fence.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

const CITATION_MARKER_PATTERN = /\^\[([^\]]+)\]/gu;
const COLON_MULTILINE_PATTERN = /^([^:#]+):(\d+(?:,\s*\d+)+)$/u;
const SPAN_SUFFIX_PATTERN =
  /^([^:#]+)(?:(?::(\d+)(?:[,-]\s*(\d+))?)|(?:#L(\d+)(?:-L(\d+))?))?$/u;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function citationKey(citation: SessionExportCitation): string {
  return `${citation.file}\u0000${String(citation.start ?? 0)}\u0000${String(citation.end ?? 0)}`;
}

function span(file: string, startText?: string, endText?: string): SessionExportCitation | null {
  if (startText === undefined) return Object.freeze({ file });
  const start = Number(startText);
  const end = Number(endText ?? startText);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start
    ? Object.freeze({ file, start, end })
    : null;
}

function parseSpanEntry(entry: string): readonly SessionExportCitation[] {
  const multiline = COLON_MULTILINE_PATTERN.exec(entry);
  if (multiline !== null) {
    const file = multiline[1];
    const lines = multiline[2];
    if (file === undefined || lines === undefined) return Object.freeze([{ file: entry }]);
    return Object.freeze(lines.split(/,\s*/u).flatMap((line) => {
      const parsed = span(file, line, line);
      return parsed === null ? [] : [parsed];
    }));
  }
  const match = SPAN_SUFFIX_PATTERN.exec(entry);
  if (match === null) return Object.freeze([{ file: entry }]);
  const file = match[1];
  if (file === undefined) return Object.freeze([{ file: entry }]);
  const parsed = span(file, match[2] ?? match[4], match[3] ?? match[5]);
  return Object.freeze(parsed === null ? [] : [parsed]);
}

function parseCitationEntries(inner: string): readonly SessionExportCitation[] {
  return Object.freeze(inner.split(/,(?!\s*\d+\s*(?:,|$))/u).flatMap((part) => {
    const trimmed = part.trim();
    return trimmed.length === 0 ? [] : parseSpanEntry(trimmed);
  }));
}

function citationVisibleBody(body: string): string {
  let fence: SessionMarkdownFence | null = null;
  return body.split('\n').map((line) => {
    const transition = transitionSessionMarkdownFence(line, fence);
    const wasInsideFence = fence !== null;
    fence = transition.fence;
    return wasInsideFence || transition.isFenceLine ? '' : line;
  }).join('\n');
}

function activeBodyCitations(body: string): readonly SessionExportCitation[] {
  const citations: SessionExportCitation[] = [];
  const seen = new Set<string>();
  const visible = citationVisibleBody(body);
  CITATION_MARKER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_MARKER_PATTERN.exec(visible)) !== null) {
    const inner = match[1];
    if (inner === undefined) continue;
    for (const citation of parseCitationEntries(inner)) {
      const key = citationKey(citation);
      if (!seen.has(key)) {
        seen.add(key);
        citations.push(citation);
      }
    }
  }
  return Object.freeze(citations);
}

function normalizePage(value: unknown): unknown {
  if (!isRecord(value) || typeof value.body !== 'string') return value;
  const upstream = inspectSessionExportCitations(value.citations);
  if (upstream === null) return value;
  const active = activeBodyCitations(value.body);
  const upstreamKeys = new Set(upstream.canonical.map(citationKey));
  if (active.some((citation) => !upstreamKeys.has(citationKey(citation)))) return value;
  if (active.length === upstream.raw.length && active.every((citation, index) => {
    const upstreamCitation = upstream.raw[index];
    return upstreamCitation !== undefined &&
      citationKey(citation) === citationKey(upstreamCitation);
  })) return value;
  return Object.freeze({ ...value, citations: active });
}

/**
 * Correct the upstream export's lexical citation scan at the replaceable adapter boundary.
 * llm-wiki-compiler@1.1.0 scans fenced code as prose; BuildLore treats only markers that
 * are active in Markdown as citations and never invents a citation absent upstream.
 */
export function normalizeLlmWikiCompilerExport(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.pages)) return value;
  const sourcePages: readonly unknown[] = value.pages;
  const pages = sourcePages.map(normalizePage);
  return pages.every((page, index) => page === sourcePages[index])
    ? value
    : Object.freeze({ ...value, pages: Object.freeze(pages) });
}
