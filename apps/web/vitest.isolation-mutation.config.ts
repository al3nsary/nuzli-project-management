/**
 * Security review A12 M5 — the demo isolation suite with ONE scoped table unfiltered
 * (`NZ_MUTATE_TABLE`); see `scripts/isolation-mutation.mjs`.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vite.config';

export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base;
  return mergeConfig(resolved, {
    test: {
      include: ['src/api/demo/isolation.test.ts'],
      setupFiles: ['./src/test/setup.ts', './src/api/demo/isolation.mutation-setup.ts'],
      testTimeout: 180_000,
      hookTimeout: 180_000,
    },
  });
});
