export function hasReadControl(value: string): boolean {
  return [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159);
}
export function validReadPage(value: string): boolean {
  return value.length <= 320 && /^(?:(?:concepts|decisions|failures|queries|verifications)\/[a-z0-9]+(?:-[a-z0-9]+)*|page-[a-f0-9]{64}|(?:(?:wiki\/)?buildlore-hierarchy\/)?(?:overview|architecture|decisions)(?:\.md)?)$/u.test(value);
}
