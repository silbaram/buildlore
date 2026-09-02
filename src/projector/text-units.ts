/** Count Unicode scalar values so serialized character and column units are runtime-neutral. */
export function unicodeScalarLength(value: string): number {
  return Array.from(value).length;
}

/** Slice at a Unicode scalar boundary rather than a UTF-16 code-unit boundary. */
export function sliceUnicodeScalars(value: string, maximum: number): string {
  if (!Number.isSafeInteger(maximum) || maximum < 0) return '';
  return Array.from(value).slice(0, maximum).join('');
}
