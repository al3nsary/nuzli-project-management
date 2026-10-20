/**
 * Unit tests (no Docker, no network) — src/…/*.spec.ts — and, since A12, the real-PostgreSQL
 * suites on PGlite (in-process WebAssembly, still no Docker): test/pglite (migration, RLS, guards)
 * and test/isolation (every route, workspace A against workspace B). Integration tests with
 * Testcontainers live in test/int (jest.int.config.js).
 */
module.exports = {
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test/pglite', '<rootDir>/test/isolation'],
  testRegex: '.*\\.(spec|pg-spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  // A12: the node environment plus Node's own require, for PGlite (test/support/pglite-env.js).
  testEnvironment: '<rootDir>/test/support/pglite-env.js',
  clearMocks: true,
  // A12: a default workspace context for services called outside a request (unit tests only;
  // the PGlite suites switch it off — there a missing context must fail).
  setupFiles: ['<rootDir>/test/unit/workspace-setup.ts'],
};
