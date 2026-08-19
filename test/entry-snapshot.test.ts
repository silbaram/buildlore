import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

function parseFrontmatter(frontmatter: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    frontmatter.split('\n').map((line) => {
      const separator = line.indexOf(': ');
      if (separator < 1) {
        throw new Error(`Invalid entry frontmatter line: ${line}`);
      }

      return [line.slice(0, separator), line.slice(separator + 2)];
    }),
  );
}

describe('P2A entry snapshot', () => {
  it('binds issue #2 metadata to the exact captured body', async () => {
    const entry = await readFile(
      new URL('../docs/entries/github-issue-2.md', import.meta.url),
      'utf8',
    );
    expect(entry.startsWith('---\n')).toBe(true);

    const closingDelimiter = entry.indexOf('\n---\n', 4);
    expect(closingDelimiter).toBeGreaterThan(4);

    const metadata = parseFrontmatter(entry.slice(4, closingDelimiter));
    const capturedBody = entry.slice(closingDelimiter + '\n---\n'.length);
    const bodyHash = createHash('sha256').update(capturedBody).digest('hex');

    expect(metadata).toMatchObject({
      issue_number: '2',
      repository: 'silbaram/buildlore',
      source_type: 'github_issue',
      source_url: 'https://github.com/silbaram/buildlore/issues/2',
    });
    expect(bodyHash).toBe(metadata.source_content_sha256);
  });
});
