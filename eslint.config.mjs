import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.agents/**',
      '.claude/**',
      '.codex/**',
      '.gemini/**',
      '.plan2agent/**',
      '.test-tmp/**',
      'dist/**',
      'eslint.config.mjs',
      'node_modules/**',
      // Local-only planning/evaluation artifacts are outside the product TypeScript project.
      'plans/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['scripts/*.mjs', 'vitest.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
