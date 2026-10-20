/**
 * Security review A12 M5 — the MUTANT run of the isolation suite (not part of `npx jest`: the file
 * name does not match the default test regex; `test/isolation/mutation-check.ts` runs it).
 *
 * `MUT_MODEL=<Model>` removes the application-layer workspace filter of ONE scoped model for
 * reads, updates and deletes (creates are still stamped) — exactly the reviewer's mutation — and
 * runs the real isolation suite with RLS off (the app layer alone). The suite must FAIL: a green
 * run means the suite would not notice that model losing its filter. `MUT_MODEL` unset = control.
 * `MUT_HTTP_ONLY=1` skips the direct model-by-model probe, to measure what the HTTP probes alone
 * detect.
 */
jest.mock('../../src/prisma/scoping', () => {
  const real = jest.requireActual('../../src/prisma/scoping');
  const target = process.env.MUT_MODEL;
  return {
    ...real,
    scopeArgs: (model: string, op: string, args: unknown, store: unknown) => {
      if (target && model === target && !['create', 'createMany', 'createManyAndReturn', 'upsert'].includes(op)) {
        return { ...((args as object) ?? {}) };
      }
      return real.scopeArgs(model, op, args, store);
    },
  };
});

import { defineIsolationSuite } from './isolation-suite';

jest.setTimeout(600_000);
defineIsolationSuite({ rls: false, skipModelProbe: process.env.MUT_HTTP_ONLY === '1' });
