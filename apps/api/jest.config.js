/** Unit tests (no Docker, no network). Integration tests live in test/int (jest.int.config.js). */
module.exports = {
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\.spec\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testEnvironment: 'node',
  clearMocks: true,
};
