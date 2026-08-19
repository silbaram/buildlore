import { describe, expect, it } from 'vitest';

import * as buildlore from '../src/index.js';

describe('public module boundaries', () => {
  it('exports every approved architecture boundary', () => {
    expect(Object.keys(buildlore).sort()).toEqual([
      'cli',
      'compiler',
      'knowledge',
      'projector',
      'retrieval',
      'sanitizer',
    ]);
  });
});
