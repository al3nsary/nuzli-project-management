/**
 * A12 final step (ADR-170) — `npm run verify:fresh-install`: a fresh production install simulated
 * without Docker. An EMPTY PostgreSQL (PGlite, in-process), the full migration chain as the
 * migrator, the production seed, then the real AppModule as `nuzli_app` with DB_REQUIRE_RLS=true
 * and NODE_ENV=production, listening on a real port, and a smoke run over HTTP.
 * Kept out of the default `jest` run (it boots the app twice and prints a report).
 */
module.exports = {
  rootDir: '.',
  roots: ['<rootDir>/test/fresh-install'],
  testRegex: '.*\\.fresh-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testEnvironment: '<rootDir>/test/support/pglite-env.js',
  clearMocks: true,
  verbose: true,
};
