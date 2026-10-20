import { Prisma } from '@prisma/client';
import { GLOBAL_MODELS, readsRelations, scopeArgs, SCOPED_MODELS, withWorkspaceData } from './scoping';
import { newStore, WorkspaceScopeError, workspaceStorage, activeWorkspaceId, runInWorkspace } from './workspace-context';

const A = '0a000000-0000-4000-8000-00000000000a';
const B = '0b000000-0000-4000-8000-00000000000b';
const inA = newStore({ workspaceId: A });
const none = newStore();

describe('A12 scoping layer — model inventory', () => {
  it('every Prisma model is classified as workspace-scoped or global (a new model fails here)', () => {
    const models = Prisma.dmmf.datamodel.models.map((m) => m.name);
    const unclassified = models.filter((m) => !SCOPED_MODELS.has(m) && !GLOBAL_MODELS.has(m));
    expect(unclassified).toEqual([]);
    expect(SCOPED_MODELS.size).toBe(47);
    expect([...GLOBAL_MODELS].sort()).toEqual(['ActionToken', 'RefreshToken', 'User', 'Workspace', 'WorkspaceMembership']);
  });

  it('every scoped model has a workspaceId column (and a workspace relation)', () => {
    for (const m of Prisma.dmmf.datamodel.models.filter((x) => SCOPED_MODELS.has(x.name))) {
      const names = m.fields.map((f) => f.name);
      expect([m.name, names.includes('workspaceId')]).toEqual([m.name, true]);
      expect([m.name, names.includes('workspace')]).toEqual([m.name, true]);
    }
  });
});

describe('A12 scoping layer — scopeArgs', () => {
  it('adds the workspace to the where of every read, update, delete and aggregate', () => {
    for (const op of ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'delete', 'deleteMany']) {
      const out = scopeArgs('Team', op, { where: { id: 'x' } }, inA);
      expect(out.where).toEqual({ id: 'x', AND: [{ workspaceId: A }] });
    }
  });

  it('keeps an existing AND and works without a where', () => {
    expect(scopeArgs('Task', 'findMany', { where: { AND: [{ a: 1 }] } }, inA).where).toEqual({ AND: [{ a: 1 }, { workspaceId: A }] });
    expect(scopeArgs('Task', 'findMany', { where: { AND: { a: 1 } } }, inA).where).toEqual({ AND: [{ a: 1 }, { workspaceId: A }] });
    expect(scopeArgs('Task', 'findMany', undefined, inA).where).toEqual({ AND: [{ workspaceId: A }] });
  });

  it('a caller-supplied workspaceId of another workspace cannot widen the filter (AND, never OR)', () => {
    const out = scopeArgs('Project', 'findMany', { where: { workspaceId: B } }, inA);
    expect(out.where).toEqual({ workspaceId: B, AND: [{ workspaceId: A }] }); // B AND A = nothing
  });

  it('sets the workspace on creates (unchecked → workspaceId, checked → workspace.connect)', () => {
    expect(scopeArgs('TeamColor', 'create', { data: { name: 'x', hex: '#000000' } }, inA).data).toEqual({ name: 'x', hex: '#000000', workspaceId: A });
    const checked = scopeArgs('Team', 'create', { data: { name: 'x', color: { connect: { id: 'c' } } } }, inA).data as Record<string, unknown>;
    expect(checked.workspace).toEqual({ connect: { id: A } });
    expect(checked.workspaceId).toBeUndefined();
    const many = scopeArgs('Notification', 'createMany', { data: [{ userId: 'u', type: 't' }, { userId: 'v', type: 't' }] }, inA);
    expect(many.data).toEqual([{ userId: 'u', type: 't', workspaceId: A }, { userId: 'v', type: 't', workspaceId: A }]);
    const ret = scopeArgs('Notification', 'createManyAndReturn', { data: [{ userId: 'u', type: 't' }] }, inA);
    expect(ret.data).toEqual([{ userId: 'u', type: 't', workspaceId: A }]);
  });

  it('upsert: where scoped, create gets the workspace', () => {
    const out = scopeArgs('Setting', 'upsert', { where: { workspaceId_key: { workspaceId: A, key: 'k' } }, create: { key: 'k', value: 1 }, update: { value: 1 } }, inA);
    expect(out.where).toEqual({ workspaceId_key: { workspaceId: A, key: 'k' }, AND: [{ workspaceId: A }] });
    expect(out.create).toEqual({ key: 'k', value: 1, workspaceId: A });
  });

  it('refuses to write another workspace id (create, update, upsert)', () => {
    expect(() => scopeArgs('Team', 'create', { data: { name: 'x', workspaceId: B } }, inA)).toThrow(WorkspaceScopeError);
    expect(() => scopeArgs('Team', 'create', { data: { name: 'x', workspace: { connect: { id: B } } } }, inA)).toThrow(WorkspaceScopeError);
    expect(() => scopeArgs('Team', 'update', { where: { id: 'x' }, data: { workspaceId: B } }, inA)).toThrow(WorkspaceScopeError);
    expect(() => scopeArgs('Team', 'updateMany', { where: {}, data: { workspaceId: B } }, inA)).toThrow(WorkspaceScopeError);
    expect(() => scopeArgs('Team', 'upsert', { where: { id: 'x' }, create: { name: 'x' }, update: { workspaceId: B } }, inA)).toThrow(WorkspaceScopeError);
  });

  it('FAILS CLOSED: a scoped model without a workspace context throws, for every operation', () => {
    for (const op of ['findUnique', 'findMany', 'count', 'aggregate', 'groupBy', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
      expect(() => scopeArgs('Violation', op, { where: { id: 'x' }, data: {} }, none)).toThrow(WorkspaceScopeError);
      expect(() => scopeArgs('Violation', op, { where: { id: 'x' }, data: {} }, undefined)).toThrow(WorkspaceScopeError);
    }
  });

  it('FAILS CLOSED: an unknown operation or an unknown model throws', () => {
    expect(() => scopeArgs('Team', 'findRaw', {}, inA)).toThrow(WorkspaceScopeError);
    expect(() => scopeArgs('NewModel', 'findMany', {}, inA)).toThrow(/SCOPED_MODELS or GLOBAL_MODELS/);
  });

  it('global models pass through untouched, with or without a workspace', () => {
    const args = { where: { email: 'a@b.c' } };
    expect(scopeArgs('User', 'findUnique', args, none)).toEqual(args);
    expect(scopeArgs('WorkspaceMembership', 'findMany', args, inA)).toEqual(args);
  });

  it('audit entries without a workspace are written with workspace NULL; reading them needs a workspace', () => {
    const out = scopeArgs('AuditLog', 'create', { data: { action: 'auth.account_locked', entityType: 'user' } }, none);
    expect(out.data).toEqual({ action: 'auth.account_locked', entityType: 'user', workspaceId: null });
    expect(() => scopeArgs('AuditLog', 'findMany', {}, none)).toThrow(WorkspaceScopeError);
    expect(scopeArgs('AuditLog', 'findMany', {}, inA).where).toEqual({ AND: [{ workspaceId: A }] });
  });

  it('user photos are global files: created with workspace NULL, readable with the workspace OR-clause', () => {
    expect(withWorkspaceData('File', { entityType: 'user_photo', storageKey: 'k' }, A)).toEqual({ entityType: 'user_photo', storageKey: 'k', workspaceId: null });
    expect(withWorkspaceData('File', { entityType: 'task', storageKey: 'k' }, A)).toEqual({ entityType: 'task', storageKey: 'k', workspaceId: A });
    expect(scopeArgs('File', 'findUnique', { where: { id: 'f' } }, inA).where).toEqual({
      id: 'f',
      AND: [{ OR: [{ workspaceId: A }, { workspaceId: null, entityType: 'user_photo' }] }],
    });
  });

  it('the owner escape hatch (bypass) disables the filter only inside its own context', () => {
    const bypass = newStore({ workspaceId: A, bypass: true });
    expect(scopeArgs('Team', 'findMany', { where: { id: 'x' } }, bypass)).toEqual({ where: { id: 'x' } });
  });

  it('security review A12 M1: outside any workspace an OWNER reads ONLY the account-level audit (workspace NULL); nobody else reads anything', () => {
    const ownerOutside = newStore({ accountRole: 'OWNER', userId: 'o1' });
    expect(scopeArgs('AuditLog', 'findMany', { where: { entityType: 'user' } }, ownerOutside).where).toEqual({ entityType: 'user', AND: [{ workspaceId: null }] });
    expect(scopeArgs('AuditLog', 'count', {}, ownerOutside).where).toEqual({ AND: [{ workspaceId: null }] });
    expect(() => scopeArgs('AuditLog', 'findMany', {}, newStore({ userId: 'u1' }))).toThrow(WorkspaceScopeError);
    expect(() => scopeArgs('AuditLog', 'deleteMany', {}, ownerOutside)).toThrow(WorkspaceScopeError);
    expect(() => scopeArgs('Team', 'findMany', {}, ownerOutside)).toThrow(WorkspaceScopeError);
  });

  it('readsRelations spots include and nested selects (they may touch scoped tables)', () => {
    expect(readsRelations({ include: { photo: true } })).toBe(true);
    expect(readsRelations({ select: { id: true, photo: { select: { id: true } } } })).toBe(true);
    expect(readsRelations({ select: { id: true } })).toBe(false);
    expect(readsRelations({ where: { id: 'x' } })).toBe(false);
  });
});

describe('A12 workspace context', () => {
  it('runInWorkspace scopes a callback and does not leak out of it', () => {
    workspaceStorage.run(newStore(), () => {
      expect(runInWorkspace(B, () => activeWorkspaceId())).toBe(B);
      expect(() => activeWorkspaceId()).toThrow(WorkspaceScopeError);
    });
  });

  it('a LAZY query (Prisma starts on .then) returned from runInWorkspace still runs inside that workspace', async () => {
    let seenAt: string | null | undefined;
    const lazy = {
      then(resolve: (v: string) => unknown) {
        seenAt = workspaceStorage.getStore()?.workspaceId;
        return Promise.resolve('done').then(resolve);
      },
    };
    const out = workspaceStorage.run(newStore({ workspaceId: A }), () => runInWorkspace(B, () => lazy as unknown as Promise<string>));
    await expect(out).resolves.toBe('done');
    expect(seenAt).toBe(B);
  });

  it('the context follows async continuations of the same request only', async () => {
    const seen: Array<string | null> = [];
    await Promise.all([
      workspaceStorage.run(newStore({ workspaceId: A }), async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(activeWorkspaceId());
      }),
      workspaceStorage.run(newStore({ workspaceId: B }), async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(activeWorkspaceId());
      }),
    ]);
    expect(seen.sort()).toEqual([A, B].sort());
  });
});
