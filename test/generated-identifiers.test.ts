import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  GENERATED_IDENTIFIER_PREFIXES,
  GENERATED_SOURCE_KINDS,
  generatedSourceFilenameKind,
  isGeneratedIdentifier,
} from '../src/sanitizer/index.js';

const HEX_64 = '0123456789abcdef'.repeat(4);

function patterns(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(patterns);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'pattern' && typeof child === 'string' ? [child] : patterns(child));
}

describe('generated identifier contract', () => {
  it('owns the exact immutable source-kind and identifier-prefix declarations', () => {
    expect(GENERATED_SOURCE_KINDS).toEqual(['execution', 'markdown', 'planning']);
    expect(GENERATED_IDENTIFIER_PREFIXES).toEqual([
      'anchor',
      'candidate',
      'merge',
      'source',
      'task',
    ]);
    expect(Object.isFrozen(GENERATED_SOURCE_KINDS)).toBe(true);
    expect(Object.isFrozen(GENERATED_IDENTIFIER_PREFIXES)).toBe(true);
  });

  it.each(GENERATED_SOURCE_KINDS)(
    'accepts only the exact generated %s source filename',
    (kind) => {
      const valid = `${kind}--${HEX_64}.md`;
      expect(generatedSourceFilenameKind(valid)).toBe(kind);
      for (const invalid of [
        `${kind}--${HEX_64.slice(1)}.md`,
        `${kind}--${HEX_64}0.md`,
        `${kind}--${HEX_64.toUpperCase()}.md`,
        `${kind}-${HEX_64}.md`,
        `${kind}--${HEX_64}.md.bak`,
        `sources/${valid}`,
      ]) expect(generatedSourceFilenameKind(invalid)).toBeNull();
    },
  );

  it.each(GENERATED_IDENTIFIER_PREFIXES)(
    'accepts only the exact generated %s identifier',
    (prefix) => {
      const valid = `${prefix}-${HEX_64}`;
      expect(isGeneratedIdentifier(valid)).toBe(true);
      expect(isGeneratedIdentifier(valid, prefix)).toBe(true);
      for (const invalid of [
        `${prefix}-${HEX_64.slice(1)}`,
        `${prefix}-${HEX_64}0`,
        `${prefix}-${HEX_64.toUpperCase()}`,
        `${prefix}--${HEX_64}`,
        `other-${HEX_64}`,
        `${valid}.json`,
      ]) expect(isGeneratedIdentifier(invalid)).toBe(false);
    },
  );

  it('keeps expected-prefix validation field-specific', () => {
    expect(isGeneratedIdentifier(`candidate-${HEX_64}`, 'source')).toBe(false);
    expect(isGeneratedIdentifier(`source-${HEX_64}`, 'candidate')).toBe(false);
  });

  it('removes generated-source regex copies from all five confirmed consumers', async () => {
    const consumers = [
      '../src/projector/project-source-writer.ts',
      '../src/projector/sync.ts',
      '../src/compiler/session/review-store.ts',
      '../src/compiler/session/source-planner.ts',
      '../src/sanitizer/service.ts',
    ];
    const bodies = await Promise.all(consumers.map(async (path) =>
      readFile(new URL(path, import.meta.url), 'utf8')));
    for (const body of bodies) {
      expect(body).not.toMatch(/execution\|markdown\|planning|markdown\|planning|execution\|planning/u);
      expect(body).toMatch(/generatedSourceFilenameKind/u);
    }
  });

  it('keeps language-neutral schema patterns conformant with shared generated forms', async () => {
    const schemaNames = [
      'compile-plan.schema.json',
      'compile-proposal.schema.json',
      'session-candidate-list.schema.json',
      'session-candidate-approval.schema.json',
      'session-review-candidate.schema.json',
      'session-promotion-proof.schema.json',
    ];
    const schemaPatterns = new Map(await Promise.all(schemaNames.map(async (name) => {
      const schema = JSON.parse(await readFile(
        new URL(`../schemas/${name}`, import.meta.url),
        'utf8',
      )) as unknown;
      return [name, patterns(schema)] as const;
    })));
    const prefixSchemas = new Map([
      ['anchor', ['compile-plan.schema.json']],
      ['candidate', [
        'session-candidate-list.schema.json',
        'session-candidate-approval.schema.json',
        'session-review-candidate.schema.json',
        'session-promotion-proof.schema.json',
      ]],
      ['merge', ['compile-plan.schema.json', 'compile-proposal.schema.json']],
      ['source', [
        'compile-plan.schema.json',
        'compile-proposal.schema.json',
        'session-review-candidate.schema.json',
      ]],
      ['task', ['compile-plan.schema.json', 'compile-proposal.schema.json']],
    ] as const);

    for (const prefix of GENERATED_IDENTIFIER_PREFIXES) {
      const valid = `${prefix}-${HEX_64}`;
      for (const schemaName of prefixSchemas.get(prefix) ?? []) {
        const relevant = (schemaPatterns.get(schemaName) ?? [])
          .filter((pattern) => pattern.includes(`${prefix}-`));
        expect(relevant.length).toBeGreaterThan(0);
        for (const pattern of relevant) {
          const contract = new RegExp(pattern, 'u');
          expect(contract.test(valid)).toBe(true);
          expect(contract.test(`${prefix}-${HEX_64.slice(1)}`)).toBe(false);
          expect(contract.test(`${prefix}-${HEX_64.toUpperCase()}`)).toBe(false);
        }
      }
    }

    for (const schemaName of ['compile-plan.schema.json', 'session-review-candidate.schema.json']) {
      const relevant = (schemaPatterns.get(schemaName) ?? [])
        .filter((pattern) => pattern.includes('markdown') && pattern.includes('planning'));
      expect(relevant.length).toBeGreaterThan(0);
      for (const pattern of relevant) {
        const contract = new RegExp(pattern, 'u');
        expect(contract.test(`markdown--${HEX_64}.md`)).toBe(true);
        expect(contract.test(`planning--${HEX_64}.md`)).toBe(true);
        expect(contract.test(`execution--${HEX_64}.md`)).toBe(false);
      }
    }
  });
});
