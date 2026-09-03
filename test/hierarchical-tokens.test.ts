import { describe, expect, it } from 'vitest';

import { hierarchySurfaceTokens, hierarchyTokens } from '../src/compiler/index.js';

describe('shared hierarchy tokenizer', () => {
  it('keeps Korean originals and adds only guarded closed-list suffix variants', () => {
    const tokens = hierarchyTokens('결제의 흐름은 롤백 절차를 사과');
    expect(tokens).toEqual([
      '결제의', '결제', '흐름은', '흐름', '롤백', '절차를', '절차', '사과',
    ]);
  });

  it('normalizes NFC and preserves the existing English variants', () => {
    expect(hierarchySurfaceTokens('Cafe\u0301 architectures')).toEqual([
      'café', 'architectures',
    ]);
    expect(hierarchyTokens('Cafe\u0301 architectures')).toEqual([
      'café', 'architectures', 'architecture',
    ]);
  });

  it('strips supported Korean endings only when at least two stem scalars remain', () => {
    expect(hierarchyTokens('처리했다 저장된다 과')).toEqual([
      '처리했다', '처리', '저장된다', '저장', '과',
    ]);
  });
});
