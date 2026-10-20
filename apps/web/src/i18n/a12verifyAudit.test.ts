/**
 * A12 verification D7: the owner's account audit showed «عنصر» for a workspace — every audit
 * entity type written by the API or the demo must have its own Arabic label (and «قسم» is the
 * workspace, not the workers' department «إدارة»).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ar } from './ar';

const ROOTS = [join(__dirname, '..', '..', '..', 'api', 'src'), join(__dirname, '..', 'api', 'demo')];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name)) yield p;
  }
}

describe('audit entity labels', () => {
  it('every entityType literal has an «audit.entity.*» label', () => {
    const types = new Set<string>();
    for (const root of ROOTS) for (const f of files(root)) for (const m of readFileSync(f, 'utf8').matchAll(/entityType: '([a-z_]+)'/g)) types.add(m[1]!);
    types.delete('unknown');
    expect(types.size).toBeGreaterThan(20);
    const missing = [...types].filter((e) => !(`audit.entity.${e}` in ar));
    expect(missing).toEqual([]);
  });

  it('a workspace is «قسم» and a department is «إدارة»', () => {
    expect((ar as Record<string, string>)['audit.entity.workspace']).toBe('قسم');
    expect((ar as Record<string, string>)['audit.entity.department']).toBe('إدارة');
  });
});
