import { demoSeedRefusal, runDemoSeed } from './seed-demo';

/** A12 final step (ADR-169): demo data never enters production by accident. */
describe('seed:demo production guard', () => {
  it('refuses when NODE_ENV=production', () => {
    expect(demoSeedRefusal({ NODE_ENV: 'production' })).toMatch(/refused: NODE_ENV=production/);
    expect(demoSeedRefusal({ NODE_ENV: 'production', ALLOW_DEMO_SEED: 'false' })).not.toBeNull();
    expect(demoSeedRefusal({ NODE_ENV: 'production', ALLOW_DEMO_SEED: '1' })).not.toBeNull();
  });

  it('runs in production only with ALLOW_DEMO_SEED=true exactly, and freely outside production', () => {
    expect(demoSeedRefusal({ NODE_ENV: 'production', ALLOW_DEMO_SEED: 'true' })).toBeNull();
    expect(demoSeedRefusal({ NODE_ENV: 'development' })).toBeNull();
    expect(demoSeedRefusal({ NODE_ENV: 'test' })).toBeNull();
  });

  it('runDemoSeed throws before touching the database in production', async () => {
    const prisma = new Proxy({}, { get: () => { throw new Error('the database was touched'); } });
    await expect(runDemoSeed(prisma as never, { NODE_ENV: 'production' } as never, () => undefined)).rejects.toThrow(/refused/);
  });
});
