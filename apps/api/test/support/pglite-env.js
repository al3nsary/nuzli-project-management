/**
 * A12: Jest test environment for the PGlite suites. Jest runs tests inside a vm context, where
 * PGlite's WebAssembly loader (dynamic `import()` of Node built-ins) cannot run without
 * --experimental-vm-modules. This environment exposes Node's own `require` as
 * `globalThis.__nativeRequire`, so test/support/pglite.ts loads PGlite (and its Prisma driver
 * adapter) in the real Node realm. Everything else — the app, Prisma, the services — still runs
 * inside the normal Jest sandbox.
 */
const { TestEnvironment } = require('jest-environment-node');

class PgliteEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.global.__nativeRequire = require;
  }
}

module.exports = PgliteEnvironment;
