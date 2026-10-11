/**
 * Phase 1 acceptance (brief §16): a new supervisor registers, cannot log in, an admin
 * approves them, and they log in. Also: forced first password change and refresh rotation.
 */
import { BOOTSTRAP, bearer, bootstrapAdminSession, cookiesFrom, describeInt, login, startApp, validNationalId, type IntApp } from './helpers';

describeInt('registration → approval → login', () => {
  let ctx: IntApp;

  beforeAll(async () => {
    ctx = await startApp();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('seeds settings, 24 colours, the default calendar and 6 card sizes idempotently', async () => {
    expect(await ctx.prisma.teamColor.count()).toBe(24);
    expect(await ctx.prisma.cardSize.count({ where: { isBuiltin: true } })).toBe(6);
    const cal = await ctx.prisma.calendar.findFirstOrThrow({ where: { isDefault: true } });
    expect(cal.weekendDays).toEqual([5, 6]);
    const { runSeed } = await import('../../src/seed/seed');
    const again = await runSeed(ctx.prisma, process.env as never, () => undefined);
    expect(again).toEqual({ settingsCreated: 0, colorsCreated: 0, cardSizesCreated: 0, calendarCreated: false, adminCreated: false });
  });

  it('the bootstrap admin must change the password before doing anything else', async () => {
    const first = await login(ctx, BOOTSTRAP.email, BOOTSTRAP.password);
    expect((first.body.user as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
    const blocked = await ctx.http().get('/api/v1/users').set(bearer(first)).expect(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await ctx.http().get('/api/v1/auth/me').set(bearer(first)).expect(200);
  });

  it('a supervisor registers, is refused while pending, then logs in after approval', async () => {
    const admin = await bootstrapAdminSession(ctx);
    const applicant = {
      accountType: 'SUPERVISOR',
      fullName: 'خالد العتيبي',
      email: 'khaled@nuzli.test',
      mobile: '0551234567',
      nationalId: validNationalId('123456789'),
      password: 'Supervisor123',
      requestedTeamName: 'فريق الشمال',
    };

    const reg = await ctx.http().post('/api/v1/auth/register').send(applicant).expect(201);
    expect(reg.body).toEqual({ status: 'PENDING' });

    // Duplicate national ID is caught by the blind-index unique constraint.
    const dup = await ctx.http().post('/api/v1/auth/register')
      .send({ ...applicant, email: 'other@nuzli.test', mobile: '0551234568' }).expect(409);
    expect(dup.body.code).toBe('NATIONAL_ID_TAKEN');

    const pending = await ctx.http().post('/api/v1/auth/login')
      .send({ identifier: applicant.email, password: applicant.password }).expect(403);
    expect(pending.body.code).toBe('ACCOUNT_PENDING');

    // Admins were notified in-app and by e-mail.
    const count = await ctx.http().get('/api/v1/notifications/unread-count').set(bearer(admin)).expect(200);
    expect(count.body.count).toBeGreaterThanOrEqual(1);
    expect(ctx.sentMail.some((m) => m.to === BOOTSTRAP.email && /طلب تسجيل/.test(m.subject))).toBe(true);

    const list = await ctx.http().get('/api/v1/registrations').set(bearer(admin)).expect(200);
    const request = (list.body.items as Array<{ id: string; email: string; nationalIdMasked: string; requestedTeamName: string }>).find((u) => u.email === applicant.email);
    expect(request).toBeDefined();
    expect(request!.nationalIdMasked).toMatch(/^1•{7}\d{2}$/);
    expect(request!.requestedTeamName).toBe('فريق الشمال');

    const approved = await ctx.http().post(`/api/v1/registrations/${request!.id}/approve`).set(bearer(admin)).send({}).expect(200);
    expect(approved.body.status).toBe('ACTIVE');
    expect(approved.body.role).toBe('SUPERVISOR');
    expect(approved.body.nationalId).toBe(applicant.nationalId); // full value for admins

    const again = await ctx.http().post(`/api/v1/registrations/${request!.id}/approve`).set(bearer(admin)).send({}).expect(409);
    expect(again.body.code).toBe('NOT_PENDING');

    // Login by mobile in local format works and is normalised to E.164.
    const session = await login(ctx, '0551234567', applicant.password);
    const user = session.body.user as { role: string; nationalId?: string; mobile: string };
    expect(user.role).toBe('SUPERVISOR');
    expect(user.mobile).toBe('+966551234567');
    expect(user.nationalId).toBeUndefined(); // not an admin → masked only

    const audit = await ctx.http().get('/api/v1/audit?action=registration.approved').set(bearer(admin)).expect(200);
    expect(audit.body.total).toBe(1);
    expect(JSON.stringify(audit.body)).not.toContain(applicant.nationalId);
  });

  it('a rejected applicant gets the reason by e-mail and a distinct login error', async () => {
    const admin = await login(ctx, BOOTSTRAP.email, 'AdminPass456');
    await ctx.http().post('/api/v1/auth/register').send({
      accountType: 'MONITOR', fullName: 'سارة الحربي', email: 'sara@nuzli.test', mobile: '0559876543',
      nationalId: validNationalId('298765432'), password: 'Monitor12345',
    }).expect(201);
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'sara@nuzli.test' } });
    const noReason = await ctx.http().post(`/api/v1/registrations/${u.id}/reject`).set(bearer(admin)).send({}).expect(400);
    expect(noReason.body.code).toBe('VALIDATION_FAILED');
    await ctx.http().post(`/api/v1/registrations/${u.id}/reject`).set(bearer(admin)).send({ reason: 'البيانات غير مكتملة' }).expect(200);
    expect(ctx.sentMail.some((m) => m.to === 'sara@nuzli.test' && m.text.includes('البيانات غير مكتملة'))).toBe(true);
    const res = await ctx.http().post('/api/v1/auth/login').send({ identifier: 'sara@nuzli.test', password: 'Monitor12345' }).expect(403);
    expect(res.body.code).toBe('ACCOUNT_REJECTED');
  });

  it('refresh rotates the cookie; replaying the old cookie revokes the family', async () => {
    const s = await login(ctx, BOOTSTRAP.email, 'AdminPass456');
    const r1 = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).expect(200);
    const next = cookiesFrom(r1);
    expect(next.cookie).not.toBe(s.cookie);
    const replay = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).expect(401);
    expect(replay.body.code).toBe('REFRESH_REUSED');
    // The legitimate newer token died with its family.
    await ctx.http().post('/api/v1/auth/refresh').set('Cookie', next.cookie).set('X-CSRF-Token', next.csrf).expect(401);
  });

  it('locks the account after 5 failed attempts', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await ctx.http().post('/api/v1/auth/login').send({ identifier: 'khaled@nuzli.test', password: 'wrong-password-1' }).expect(401);
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await ctx.http().post('/api/v1/auth/login').send({ identifier: 'khaled@nuzli.test', password: 'wrong-password-1' }).expect(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    const evenRight = await ctx.http().post('/api/v1/auth/login').send({ identifier: 'khaled@nuzli.test', password: 'Supervisor123' }).expect(423);
    expect(evenRight.body.code).toBe('ACCOUNT_LOCKED');
  });
});
