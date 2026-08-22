import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const evidenceDocument = new URL(
  '../docs/acceptance/v11-knowledge-publication.md',
  import.meta.url,
);

function criterion(prefix: 'P' | 'V', number: number): string {
  return `V11-${prefix}-${String(number).padStart(2, '0')}`;
}

describe('V11 publication acceptance evidence', () => {
  it('[V11-V-17] maps every V11 product and verification criterion to executable evidence', async () => {
    const mapping = await readFile(evidenceDocument, 'utf8');

    for (let number = 1; number <= 16; number += 1) {
      expect(mapping, `missing ${criterion('P', number)}`).toContain(criterion('P', number));
    }
    for (let number = 1; number <= 24; number += 1) {
      expect(mapping, `missing ${criterion('V', number)}`).toContain(criterion('V', number));
    }

    const locatorPattern = /`(test\/[^`]+\.test\.ts) :: ([^`]+)`/gu;
    const locators = [...mapping.matchAll(locatorPattern)].map((match) => ({
      file: match[1] as string,
      title: match[2] as string,
    }));
    expect(locators.length).toBeGreaterThanOrEqual(24);

    for (const { file, title } of locators) {
      expect(title).not.toMatch(/\b(?:placeholder|planned|todo|tbd)\b/iu);
      const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source, `missing executable locator: ${file} :: ${title}`).toContain(title);
    }
  });

  it('[V11-V-24] keeps Git publication fixtures local, isolated, and provider-free', async () => {
    const fixtureFiles = [
      'test/git-machine.test.ts',
      'test/knowledge-parent-pin.test.ts',
      'test/knowledge-publication-push.test.ts',
      'test/knowledge-publication.test.ts',
      'test/repository-writer-lease.test.ts',
    ] as const;

    for (const file of fixtureFiles) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source, `${file} must allocate an owned temporary fixture`).toContain('mkdtemp');
      expect(source, `${file} must ignore user-global Git configuration`)
        .toContain('GIT_CONFIG_GLOBAL');
      expect(source, `${file} must ignore system Git configuration`)
        .toContain('GIT_CONFIG_NOSYSTEM');
      expect(source, `${file} must disable credential prompts`)
        .toContain('GIT_TERMINAL_PROMPT');
      expect(source).not.toMatch(/https?:\/\/(?!example\.invalid)|git@|github\.com|node:https?/iu);
    }

    const pushFixture = await readFile(
      new URL('../test/knowledge-publication-push.test.ts', import.meta.url),
      'utf8',
    );
    const pinFixture = await readFile(
      new URL('../test/knowledge-parent-pin.test.ts', import.meta.url),
      'utf8',
    );
    expect(pushFixture).toMatch(/\['init', '--bare'(?:, '[^']+')?\]/u);
    expect(pinFixture).toMatch(/\['init', '--bare'(?:, '[^']+')?\]/u);
    expect(pinFixture).toContain("'protocol.file.allow=always'");
  });
});
