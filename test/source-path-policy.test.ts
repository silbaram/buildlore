import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validatePortableSourceRef } from '../src/projector/source-contracts.js';
import { validateSourceSelectionPath } from '../src/projector/source-manifest.js';

const accepted = ['tokens.ts', 'src/compiler/hierarchy/tokens.ts',
  'test/source-secret-masking.test.ts', 'auth/credentials.py', 'src/access-token.go',
  'docs/guide.md'];
const denied = ['docs/access-token/value.md', 'credentials/helper.ts', 'src/password.json',
  'src/tokens.ts/helper.ts', 'src/.git/tokens.ts', '../tokens.ts',
  `src/${['gh', 'p_', 'A'.repeat(24)].join('')}.ts`];

describe('credential-related code filenames', () => {
  it('aligns manifest and provenance paths without allowing credential locations or values', () => {
    for (const validate of [validateSourceSelectionPath, validatePortableSourceRef]) {
      for (const path of accepted) expect(validate(path)).toBe(path);
      for (const path of denied) expect(() => validate(path)).toThrow();
    }
  });

  it('keeps published path schemas consistent with both runtime boundaries', async () => {
    for (const name of ['source-collection-manifest', 'source-collection-manifest-v2',
      'source-descriptor', 'source-descriptor-v2']) {
      const schema = JSON.parse(await readFile(`schemas/${name}.schema.json`, 'utf8')) as {
        $defs: { relativePath: { pattern: string } };
      };
      const pattern = new RegExp(schema.$defs.relativePath.pattern, 'u');
      for (const path of accepted) expect(pattern.test(path), `${name}: ${path}`).toBe(true);
      for (const path of denied) expect(pattern.test(path), `${name}: rejected case`).toBe(false);
    }
  });
});
