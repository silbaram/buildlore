/** Value-free markers. They denote unavailable data, never affirmative evidence. */
export function containsSecretRedaction(value: string): boolean {
  return /<REDACTED:(?:CREDENTIAL|SECRET)>/u.test(value);
}
