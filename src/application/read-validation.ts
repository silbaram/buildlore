export function hasReadControl(value: string): boolean {
  return [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159);
}
export function validReadPage(value: string): boolean {
  if (value.length > 320) return false;
  if (/^(?:(?:concepts|decisions|failures|queries|verifications)\/[a-z0-9]+(?:-[a-z0-9]+)*|page-[a-f0-9]{64})$/u.test(value)) return true;
  const key = /^(?:(?:wiki\/)?buildlore-hierarchy\/)?([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.md)?$/u.exec(value)?.[1];
  return key !== undefined && key.length <= 64 && !['knowledge', 'evidence', 'manifest'].includes(key);
}
