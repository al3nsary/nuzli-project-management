import { describe, expect, it } from 'vitest';
import Dexie, { type Table } from 'dexie';
import { ScopeHolder, scopingMiddleware, tagTransaction, SCOPED_TABLES, GLOBAL_TABLES } from './scoping';
import { DemoDb } from './db';

class Mini extends Dexie {
  teams!: Table<{ id: string; name: string; wid?: string }, string>;
  users!: Table<{ id: string; fullName: string; status: string; role: string; accountRole?: string }, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ teams: 'id, name', users: 'id, status' });
  }
}

describe('scoping middleware (ADR-153)', () => {
  it('every DemoDb table is classified', () => {
    const db = new DemoDb(`cls-${Date.now()}`);
    const known = new Set<string>([...SCOPED_TABLES, ...GLOBAL_TABLES]);
    const missing = db.tables.map((t) => t.name).filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });

  it('filters reads, stamps writes, fails closed, honours tagged transactions', async () => {
    const holder = new ScopeHolder();
    const db = new Mini(`mini-${Date.now()}`);
    db.use(scopingMiddleware(holder));
    holder.current = { wid: 'A' };
    await db.teams.bulkPut([{ id: 't1', name: 'a1' }, { id: 't2', name: 'a2' }]);
    holder.current = { wid: 'B' };
    await db.teams.put({ id: 't3', name: 'b1' });
    expect((await db.teams.toArray()).map((t) => t.id)).toEqual(['t3']);
    expect(await db.teams.get('t1')).toBeUndefined();
    expect(await db.teams.count()).toBe(1);
    expect(await db.teams.where('name').startsWith('a').count()).toBe(0);
    expect(await db.teams.filter(() => true).toArray()).toHaveLength(1);
    await expect(db.teams.put({ id: 't1', name: 'stolen' })).rejects.toThrow();
    await db.teams.delete('t1'); // silently nothing
    await db.teams.where('name').equals('a1').modify({ name: 'x' });
    holder.current = { wid: 'A' };
    expect((await db.teams.get('t1'))?.name).toBe('a1');
    expect(await db.teams.where('id').anyOf(['t1', 't3']).toArray()).toHaveLength(1);
    expect((await db.teams.where('name').equals('a2').first())?.id).toBe('t2');
    await db.teams.update('t2', { name: 'a2b' });
    expect((await db.teams.get('t2'))?.name).toBe('a2b');
    holder.current = { wid: null };
    await expect(db.teams.toArray()).rejects.toThrow(/القسم/);
    const all = await db.transaction('r', db.teams, () => {
      tagTransaction({ wid: null, bypass: true });
      return db.teams.toArray();
    });
    expect(all).toHaveLength(3);
    const onlyB = await db.transaction('r', db.teams, () => {
      tagTransaction({ wid: 'B' });
      return db.teams.toArray();
    });
    expect(onlyB.map((t) => t.id)).toEqual(['t3']);
    holder.current = { wid: 'A' };
    await db.teams.clear();
    holder.current = { wid: 'B' };
    expect(await db.teams.count()).toBe(1);
  });
});
