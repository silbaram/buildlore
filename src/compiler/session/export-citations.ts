import { compareSessionText } from './canonical.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface SessionExportCitation {
  readonly end?: number;
  readonly file: string;
  readonly start?: number;
}

export interface SessionExportCitationInspection {
  readonly canonical: readonly SessionExportCitation[];
  readonly raw: readonly SessionExportCitation[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCitation(
  left: SessionExportCitation,
  right: SessionExportCitation,
): number {
  const fileOrder = compareSessionText(left.file, right.file);
  if (fileOrder !== 0) return fileOrder;
  const startOrder = (left.start ?? 0) - (right.start ?? 0);
  if (startOrder !== 0) return startOrder;
  return (left.end ?? 0) - (right.end ?? 0);
}

function citation(value: unknown): SessionExportCitation | null {
  if (!isRecord(value) || typeof value.file !== 'string' || value.file.length === 0 ||
      value.file.length > 512 || !Object.hasOwn(value, 'file')) {
    return null;
  }
  const hasStart = Object.hasOwn(value, 'start');
  const hasEnd = Object.hasOwn(value, 'end');
  if (hasStart !== hasEnd || Object.keys(value).some((key) =>
    key !== 'file' && key !== 'start' && key !== 'end')) {
    return null;
  }
  if (!hasStart) return Object.freeze({ file: value.file });
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) ||
      Number(value.start) < 1 || Number(value.end) < Number(value.start)) {
    return null;
  }
  return Object.freeze({
    file: value.file,
    start: Number(value.start),
    end: Number(value.end),
  });
}

export function inspectSessionExportCitations(
  value: unknown,
): SessionExportCitationInspection | null {
  if (!Array.isArray(value)) return null;
  const raw: SessionExportCitation[] = [];
  for (const item of value) {
    const parsed = citation(item);
    if (parsed === null) return null;
    raw.push(parsed);
  }
  const canonical: SessionExportCitation[] = [];
  for (const item of [...raw].sort(compareCitation)) {
    const previous = canonical.at(-1);
    if (previous === undefined || compareCitation(previous, item) !== 0) canonical.push(item);
  }
  return Object.freeze({
    canonical: Object.freeze(canonical),
    raw: Object.freeze(raw),
  });
}
