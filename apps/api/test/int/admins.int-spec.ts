/**
 * Phase 1 acceptance (brief §16): an admin creates another admin; the last admin cannot be
 * demoted (or suspended). Also: suspension ends sessions at once.
 */
import { bearer, bootstrapAdminSession, describeInt, login, startApp, tokenFromMail, validNationalId, type IntApp, type Session } from './helpers';

describeInt('admin management and last-admin protection', () => {
  let ctx: IntApp;
  let root: Session;
  let rootId: string;

  beforeAll(async () => {
    ctx = await startApp();
    root = await bootstrapAdminSession(ctx);
    rootId = (root.body.user as { id: string }).id;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('the only admin cannot demote or suspend themselves', async () => {
    const demote = await ctx.http().patch(`/api/v1/users/${rootId}/role`).set(bearer(root)).send({ role: 'SUPERVISOR' }).expect(409);
    expect(demote.body.code).toBe('LAST_ADMIN');
    const suspend = await ctx.http().post(`/api/v1/users/${rootId}/suspend`).set(bearer(root)).send({}).expect(409);
    expect(suspend.body.code).toBe('LAST_ADMIN');
  });

  let secondId: string;
  let second: Session;

  it('an admin creates another admin, who sets a password from the e-mailed link', async () => {
    const created = await ctx.http().post('/api/v1/users').set(bearer(root)).send({
      fullName: 'نورة القحطاني',
      email: 'noura@nuzli.test',
      mobile: '+966561112223',
      nationalId: validNationalId('111222333'),
      role: 'ADMIN',
    }).expect(201);
    expect(created.body).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', mustChangePassword: false });
    secondId = created.body.id;

    const dup = await ctx.http().post('/api/v1/users').set(bearer(root)).send({
      fullName: 'مكرر', email: 'noura@nuzli.test', mobile: '+966561112224', nationalId: validNationalId('111222334'), role: 'MONITOR',
    }).expect(409);
    expect(dup.body.code).toBe('EMAIL_TAKEN');

    const token = tokenFromMail(ctx, 'noura@nuzli.test');
    await ctx.http().post('/api/v1/auth/reset-password').send({ token, password: 'NouraPass789' }).expect(204);
    // One-time: the same link cannot be used twice.
    const reuse = await ctx.http().post('/api/v1/auth/reset-password').send({ token, password: 'NouraPass000' }).expect(400);
    expect(reuse.body.code).toBe('TOKEN_INVALID');

    second = await login(ctx, 'noura@nuzli.test', 'NouraPass789');
    expect((second.body.user as { role: string }).role).toBe('ADMIN');

    const audit = await ctx.http().get(`/api/v1/audit?action=user.created&entityId=${secondId}`).set(bearer(root)).expect(200);
    expect(audit.body.total).toBe(1);
  });

  it('with two admins one can be demoted; the remaining one then cannot', async () => {
    const ok = await ctx.http().patch(`/api/v1/users/${secondId}/role`).set(bearer(root)).send({ role: 'MONITOR' }).expect(200);
    expect(ok.body.role).toBe('MONITOR');
    // The demoted user loses admin rights immediately (role reloaded on every request).
    await ctx.http().get('/api/v1/users').set(bearer(second)).expect(403);

    const blocked = await ctx.http().patch(`/api/v1/users/${rootId}/role`).set(bearer(root)).send({ role: 'SUPERVISOR' }).expect(409);
    expect(blocked.body.code).toBe('LAST_ADMIN');
  });

  it('concurrent mutual demotion leaves at least one admin', async () => {
    await ctx.http().patch(`/api/v1/users/${secondId}/role`).set(bearer(root)).send({ role: 'ADMIN' }).expect(200);
    const results = await Promise.all([
      ctx.http().patch(`/api/v1/users/${secondId}/role`).set(bearer(root)).send({ role: 'SUPERVISOR' }),
      ctx.http().patch(`/api/v1/users/${rootId}/role`).set(bearer(second)).send({ role: 'SUPERVISOR' }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toContain(200);
    expect(await ctx.prisma.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } })).toBe(1);
  });

  it('suspending a user revokes their sessions immediately', async () => {
    const admin = await ctx.prisma.user.findFirstOrThrow({ where: { role: 'ADMIN', status: 'ACTIVE' } });
    const adminSession = admin.id === rootId ? root : second;
    const targetId = admin.id === rootId ? secondId : rootId;
    const target = await ctx.prisma.user.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.role).not.toBe('ADMIN');

    const victim = target.id === rootId ? root : second;
    await ctx.http().post(`/api/v1/users/${targetId}/suspend`).set(bearer(adminSession)).send({ reason: 'اختبار' }).expect(200);
    const res = await ctx.http().get('/api/v1/auth/me').set(bearer(victim)).expect(403);
    expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
    expect(await ctx.prisma.refreshToken.count({ where: { userId: targetId, revokedAt: null } })).toBe(0);

    await ctx.http().post(`/api/v1/users/${targetId}/reactivate`).set(bearer(adminSession)).expect(200);
  });
});
