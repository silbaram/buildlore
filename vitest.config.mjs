import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Local evaluation fixtures use their own runners and are not product tests.
    exclude: [...configDefaults.exclude, 'plans/**'],
  },
});
