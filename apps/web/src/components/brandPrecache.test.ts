/// <reference types="node" />
/**
 * A9 QA: every logo the shell draws must be in the service-worker precache, or the monitor's
 * offline pages show a broken image.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('brand precache', () => {
  it('precaches every brand file Brand.tsx renders', () => {
    const brand = readFileSync(join(process.cwd(), 'src/components/Brand.tsx'), 'utf8');
    const config = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
    const used = [...new Set([...brand.matchAll(/brandUrl\('([^']+)'\)/g)].map((m) => m[1]!))];
    expect(used.length).toBeGreaterThan(1);
    for (const file of used) expect(config, file).toContain(`'brand/${file}'`);
  });
});
