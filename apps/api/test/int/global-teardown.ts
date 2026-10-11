import type { StartedTestContainer } from 'testcontainers';

export default async function globalTeardown(): Promise<void> {
  const containers = (globalThis as Record<string, unknown>).__NUZLI_CONTAINERS__ as
    | StartedTestContainer[]
    | undefined;
  for (const c of containers ?? []) await c.stop();
}
