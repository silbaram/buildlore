import { describe, expect, it } from 'vitest';

import { parseJsonWithLocationsStrict } from '../src/knowledge/strict-json.js';
import {
  parseJsonExtractionProfile,
  parseJsonExtractionProfiles,
  renderJsonExtractionProfile,
  selectJsonExtractionProfile,
} from '../src/projector/index.js';

const digest = `sha256:${'a'.repeat(64)}` as const;

function profile(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 'task-summary',
    match: { equals: 'run.v1', pointer: '/schema' },
    schemaVersion: 'buildlore.json-extraction-profile.v1',
    ...overrides,
  };
}

describe('JSON extraction profile', () => {
  it('matches exactly and renders title, named sections, fields, labels, and ordered arrays', () => {
    const parsed = parseJsonWithLocationsStrict(JSON.stringify({
      changed: ['a.ts', 'b.ts'],
      schema: 'run.v1',
      task: 'JSON support',
      verification: { command: 'npm test', internal: 'omit', status: 'passed' },
    }));
    const catalog = parseJsonExtractionProfiles([profile({
      exclude: ['/verification/internal'],
      required: ['/changed', '/task'],
      sections: [
        { arrayMode: 'ordered-list', pointer: '/changed', title: 'Changed files' },
        {
          displayLabels: { command: 'Command', status: 'Result' },
          fields: ['command', 'status'],
          pointer: '/verification',
          sort: 'canonical-key',
          title: 'Verification',
        },
      ],
      title: { pointer: '/task' },
    })]);
    const selected = selectJsonExtractionProfile(parsed, catalog, true);
    expect(selected?.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const rendered = renderJsonExtractionProfile(parsed, selected!, 'run.json', digest);
    expect(rendered.title).toBe('JSON support');
    expect(rendered.body).toBe([
      '## Changed files',
      '1. "a.ts"',
      '2. "b.ts"',
      '## Verification',
      '### Command',
      '"npm test"',
      '### Result',
      '"passed"',
    ].join('\n'));
    expect(rendered.origins.map((entry) => entry.origin.jsonPointer)).not
      .toContain('/verification/internal');
  });

  it('supports table and sections array modes with explicit scalar sorting', () => {
    const parsed = parseJsonWithLocationsStrict(JSON.stringify({
      rows: [
        { id: 2, result: 'second' },
        { id: 1, result: 'first' },
      ],
      schema: 'run.v1',
    }));
    const table = parseJsonExtractionProfile(profile({
      sections: [{
        arrayMode: 'table',
        fields: ['id', 'result'],
        pointer: '/rows',
        sort: { pointer: '/id' },
        title: 'Rows',
      }],
    }));
    const tableApplied = selectJsonExtractionProfile(parsed, [table], true)!;
    expect(renderJsonExtractionProfile(parsed, tableApplied, 'rows.json', digest).body).toBe([
      '## Rows',
      '| id | result |',
      '| --- | --- |',
      '| 1 | "first" |',
      '| 2 | "second" |',
    ].join('\n'));

    const sections = parseJsonExtractionProfile(profile({
      sections: [{ arrayMode: 'sections', pointer: '/rows', title: 'Rows' }],
    }));
    expect(renderJsonExtractionProfile(
      parsed,
      selectJsonExtractionProfile(parsed, [sections], true)!,
      'rows.json',
      digest,
    ).body).toContain('### Item 1');
  });

  it('traverses ancestors for include patterns and excludes complete subtrees', () => {
    const parsed = parseJsonWithLocationsStrict(JSON.stringify({
      ignored: 'outside',
      items: [{ public: 'kept', secret: { nested: 'hidden' } }],
      schema: 'run.v1',
    }));
    const selected = selectJsonExtractionProfile(parsed, [parseJsonExtractionProfile(profile({
      exclude: ['/items/*/secret'],
      include: ['/items/*'],
    }))], true)!;
    const rendered = renderJsonExtractionProfile(parsed, selected, 'run.json', digest);
    expect(rendered.body).toContain('"kept"');
    expect(rendered.body).not.toContain('outside');
    expect(rendered.body).not.toContain('hidden');
  });

  it('fails closed on ambiguous matches, missing required pointers, and pattern conflicts', () => {
    const parsed = parseJsonWithLocationsStrict('{"schema":"run.v1"}');
    const first = parseJsonExtractionProfile(profile({ id: 'a' }));
    const second = parseJsonExtractionProfile(profile({ id: 'b' }));
    expect(() => selectJsonExtractionProfile(parsed, [first, second], true)).toThrow();
    expect(() => selectJsonExtractionProfile(parsed, [
      parseJsonExtractionProfile(profile({ required: ['/missing'] })),
    ], true)).toThrow();
    expect(() => parseJsonExtractionProfile(profile({
      exclude: ['/items/*'],
      include: ['/items/*'],
    }))).toThrow();
    expect(() => selectJsonExtractionProfile(parsed, [], true)).toThrow();
    expect(selectJsonExtractionProfile(parsed, [], false)).toBeUndefined();
  });
});
