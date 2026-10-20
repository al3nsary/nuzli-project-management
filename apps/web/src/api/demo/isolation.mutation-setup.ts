/**
 * Security review A12 M5 — the MUTANT of the demo's isolation suite (used only by
 * `vitest.isolation-mutation.config.ts`, run by `npm run test:isolation:mutation`).
 *
 * `NZ_MUTATE_TABLE=<table>` removes the workspace filter of ONE scoped Dexie table (the
 * middleware hands that table through unscoped); the isolation suite must then FAIL.
 * Without the variable this is the control run.
 */
import { vi } from 'vitest';

vi.mock('./scoping', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./scoping')>();
  const target = process.env.NZ_MUTATE_TABLE;
  return {
    ...orig,
    scopingMiddleware: (holder: Parameters<typeof orig.scopingMiddleware>[0]) => {
      const mw = orig.scopingMiddleware(holder);
      return {
        ...mw,
        create(down: Parameters<typeof mw.create>[0]) {
          const core = mw.create!(down);
          return { ...core, table: (name: string) => (target && name === target ? down.table(name) : core.table!(name)) };
        },
      };
    },
  };
});
