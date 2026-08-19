import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('local document policy', () => {
  it('keeps local documentation out of product commits', async () => {
    const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
    const agentGuide = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');

    expect(gitignore.split('\n')).toContain('plans/');
    expect(agentGuide).toContain('Git-ignored `plans/entries/`');
    expect(agentGuide).toContain('Never add `plans/` to a product commit');
  });
});
