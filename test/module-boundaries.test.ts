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
    expect(typeof buildlore.projector.createP2aExecutionKnowledgeProjector).toBe('function');
    expect(typeof buildlore.projector.createP2aPlanningProjector).toBe('function');
    expect(typeof buildlore.projector.createSourceDocument).toBe('function');
    expect(typeof buildlore.projector.parseSourceDocument).toBe('function');
    expect(typeof buildlore.projector.renderSourceDocument).toBe('function');
    expect(buildlore.projector).not.toHaveProperty('decodeP2aRun');
    expect(typeof buildlore.sanitizer.issueSanitizationApproval).toBe('function');
  });
});
