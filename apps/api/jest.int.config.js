/**
 * Integration tests with Testcontainers (PostgreSQL 16 + MinIO).
 * globalSetup starts the containers once, runs `prisma migrate deploy`, creates the bucket
 * and exports the connection settings through process.env. Without Docker every suite is
 * skipped with a clear message instead of failing.
 */
module.exports = {
  rootDir: '.',
  roots: ['<rootDir>/test/int'],
  testRegex: '.*\.int-spec\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/int/global-setup.ts',
  globalTeardown: '<rootDir>/test/int/global-teardown.ts',
  testTimeout: 180000,
};
