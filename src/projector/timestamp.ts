export function normalizeRfc3339Instant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (match === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const offset = match[7] ?? 'Z';
  const offsetMinutes = offset === 'Z'
    ? 0
    : (offset.startsWith('-') ? -1 : 1) *
      (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = new Date(parsed + offsetMinutes * 60_000).toISOString();
  const expected = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  return Math.abs(offsetMinutes) <= 14 * 60 && local.startsWith(expected)
    ? new Date(parsed).toISOString()
    : null;
}
