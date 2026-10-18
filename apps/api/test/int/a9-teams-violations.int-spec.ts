/**
 * A9 acceptance against PostgreSQL (ADR-100..104), skipped without Docker:
 *  - several supervisors: a co-supervisor manages members; the partial unique indexes hold
 *    (one open row per team+user, one open primary per team) and the migration copied history;
 *  - worker foreman: at most one open FOREMAN per team (index), moving him clears the flag,
 *    a member linked to an account cannot be foreman (trigger);
 *  - organisational structure: cycles refused, move works;
 *  - a violation without a person: created, invisible to supervisors, assigned later with the
 *    snapshot resolved at captured_at, counted as "unassigned" until then.
 */
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  bearer,
  bootstrapAdminSession,
  describeInt,
  login,
  startApp,
  tokenFromMail,
  validNationalId,
  type IntApp,
  type Session,
} from './helpers';

const API = '/api/v1';

describeInt('A9 — supervisors, foreman, org structure, violations without a person', () => {
  let ctx: IntApp;
  let admin: Session;
  let monitor: Session;
  let supA: { id: string; session: Session };
  let supB: { id: string; session: Session };
  let supC: { id: string; session: Session };
  let teamId: string;
  let otherTeamId: string;
  let typeId: string;

  const createUser = async (n: number, role: 'SUPERVISOR' | 'MONITOR') => {
    const email = `a9u${n}@nuzli.test`;
    const res = await ctx
      .http()
      .post(`${API}/users`)
      .set(bearer(admin))
      .send({
        fullName: `مستخدم A9 رقم ${n}`,
        email,
        mobile: `+96655900${String(n).padStart(4, '0')}`,
        nationalId: validNationalId(`10009${String(n).padStart(4, '0')}`),
        role,
      })
      .expect(201);
    const token = tokenFromMail(ctx, email);
    await ctx.http().post(`${API}/auth/reset-password`).send({ token, password: 'UserPass1234' }).expect(204);
    return { id: res.body.id as string, session: await login(ctx, email, 'UserPass1234') };
  };

  const addMember = async (team: string, name: string, first9: string) =>
    (
      await ctx
        .http()
        .post(`${API}/teams/${team}/members`)
        .set(bearer(admin))
        .send({ fullName: name, nationalId: validNationalId(first9) })
        .expect(201)
    ).body.id as string;

  beforeAll(async () => {
    ctx = await startApp();
    admin = await bootstrapAdminSession(ctx);
    supA = await createUser(1, 'SUPERVISOR');
    supB = await createUser(2, 'SUPERVISOR');
    supC = await createUser(3, 'SUPERVISOR');
    monitor = (await createUser(4, 'MONITOR')).session;
    const colors = (await ctx.http().get(`${API}/colors/available`).set(bearer(admin)).expect(200)).body;
    const team = await ctx
      .http()
      .post(`${API}/teams`)
      .set(bearer(admin))
      .send({ name: 'فريق الإنشاءات', colorId: colors[0].id, supervisorIds: [supA.id, supB.id], primarySupervisorId: supA.id })
      .expect(201);
    teamId = team.body.id;
    otherTeamId = (
      await ctx.http().post(`${API}/teams`).set(bearer(admin)).send({ name: 'فريق آخر', colorId: colors[1].id, supervisorId: supC.id }).expect(201)
    ).body.id;
    typeId = (await ctx.http().post(`${API}/violation-types`).set(bearer(admin)).send({ name: 'سلامة', severity: 'HIGH' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('a team created with two supervisors: one primary, both lead; the co-supervisor adds members', async () => {
    const detail = (await ctx.http().get(`${API}/teams/${teamId}`).set(bearer(supB.session)).expect(200)).body;
    expect(detail.supervisor.id).toBe(supA.id);
    expect(detail.supervisors.map((s: { id: string; isPrimary: boolean }) => [s.id, s.isPrimary])).toEqual([
      [supA.id, true],
      [supB.id, false],
    ]);
    const m = await ctx
      .http()
      .post(`${API}/teams/${teamId}/members`)
      .set(bearer(supB.session))
      .send({ fullName: 'عضو أضافه المساعد', nationalId: validNationalId('100000771') })
      .expect(201);
    expect(m.body.team.id).toBe(teamId);
    const list = (await ctx.http().get(`${API}/teams`).set(bearer(supB.session)).expect(200)).body;
    expect(list.map((t: { id: string }) => t.id)).toEqual([teamId]);
  });

  it('the database keeps one open primary and one open row per (team, user)', async () => {
    const at = new Date();
    await expect(
      ctx.prisma.teamSupervisor.create({ data: { teamId, userId: supC.id, isPrimary: true, validFrom: at } }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(
      ctx.prisma.teamSupervisor.create({ data: { teamId, userId: supB.id, isPrimary: false, validFrom: at } }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('removing the primary needs a successor; then teams.supervisor_id follows', async () => {
    const r = await ctx.http().delete(`${API}/teams/${teamId}/supervisors/${supA.id}`).set(bearer(admin)).send({ reason: 'نقل إلى موقع آخر' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PRIMARY_SUPERVISOR_REQUIRED');
    const ok = await ctx
      .http()
      .delete(`${API}/teams/${teamId}/supervisors/${supA.id}`)
      .set(bearer(admin))
      .send({ reason: 'نقل إلى موقع آخر', newPrimaryUserId: supB.id })
      .expect(200);
    expect(ok.body.supervisor.id).toBe(supB.id);
    expect((await ctx.prisma.team.findUniqueOrThrow({ where: { id: teamId } })).supervisorId).toBe(supB.id);
    const hist = (await ctx.http().get(`${API}/teams/${teamId}/supervisors`).set(bearer(admin)).expect(200)).body;
    expect(hist.current.map((s: { id: string }) => s.id)).toEqual([supB.id]);
    expect(hist.history.length).toBeGreaterThanOrEqual(3);
  });

  it('foreman: one per team, cleared by a move; an account-linked member is refused by the trigger', async () => {
    const f1 = await addMember(teamId, 'مشرف العمال الأول', '123400001');
    const f2 = await addMember(teamId, 'مشرف العمال الثاني', '123400002');
    await ctx.http().post(`${API}/teams/${teamId}/foreman`).set(bearer(supB.session)).send({ memberId: f1 }).expect(200);
    const after = (await ctx.http().post(`${API}/teams/${teamId}/foreman`).set(bearer(admin)).send({ memberId: f2 }).expect(200)).body;
    expect(after.foreman.id).toBe(f2);
    expect(after.members.filter((m: { isForeman: boolean }) => m.isForeman)).toHaveLength(1);
    await expect(
      ctx.prisma.teamMembership.updateMany({ where: { memberId: f1, validTo: null }, data: { role: 'FOREMAN' } }),
    ).rejects.toBeDefined(); // partial unique index
    await ctx.http().post(`${API}/members/move`).set(bearer(admin)).send({ memberIds: [f2], toTeamId: otherTeamId }).expect(200);
    const moved = await ctx.prisma.teamMembership.findFirstOrThrow({ where: { memberId: f2, validTo: null } });
    expect(moved.role).toBe('WORKER');
    const audit = (await ctx.http().get(`${API}/audit?action=team.foreman_cleared`).set(bearer(admin)).expect(200)).body;
    expect(audit.total).toBe(1);
    await ctx.prisma.teamMembership.updateMany({ where: { memberId: f1, validTo: null }, data: { role: 'FOREMAN' } });
    await expect(ctx.prisma.teamMember.update({ where: { id: f1 }, data: { userId: supC.id } })).rejects.toBeDefined();
  });

  it('org structure: a unit cannot move under its own descendant', async () => {
    const root = (await ctx.http().post(`${API}/org/units`).set(bearer(admin)).send({ name: 'الإدارة العامة', kind: 'DEPARTMENT' }).expect(201)).body;
    const child = (await ctx.http().post(`${API}/org/units`).set(bearer(admin)).send({ name: 'قسم المشاريع', kind: 'SECTION', parentId: root.id }).expect(201)).body;
    const bad = await ctx.http().post(`${API}/org/units/${root.id}/move`).set(bearer(admin)).send({ parentId: child.id });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('ORG_CYCLE');
    await ctx.http().patch(`${API}/teams/${teamId}`).set(bearer(admin)).send({ orgUnitId: child.id }).expect(200);
    const tree = (await ctx.http().get(`${API}/org`).set(bearer(supB.session)).expect(200)).body;
    expect(tree.units.map((u: { id: string }) => u.id)).toEqual([root.id, child.id]);
    expect(tree.units[1].teams.map((t: { id: string }) => t.id)).toEqual([teamId]);
    await ctx.http().post(`${API}/org/units`).set(bearer(supB.session)).send({ name: 'ممنوع', kind: 'UNIT' }).expect(403);
  });

  it('a violation without a person: hidden from supervisors, assigned later with the snapshot at captured_at', async () => {
    await ctx.http().patch(`${API}/settings`).set(bearer(admin)).send({ SUPERVISORS_CAN_SEE_VIOLATIONS: true }).expect(200);
    const memberId = await addMember(teamId, 'العامل المجهول سابقًا', '123400009');
    const capturedAt = new Date(Date.now() - 3_600_000);
    await ctx.prisma.teamMembership.updateMany({ where: { memberId }, data: { validFrom: new Date(Date.now() - 86_400_000) } });
    const v = (
      await ctx
        .http()
        .post(`${API}/violations`)
        .set(bearer(monitor))
        .send({
          clientUuid: randomUUID(),
          typeId,
          description: 'بدون خوذة',
          latitude: 24.7,
          longitude: 46.7,
          accuracyM: 10,
          capturedAt: capturedAt.toISOString(),
          expectedIdPhotos: 1,
          expectedEvidencePhotos: 1,
          expectedPersonPhotos: 1,
        })
        .expect(201)
    ).body;
    expect(v).toMatchObject({ member: null, assigned: false, team: null });
    const stats = (await ctx.http().get(`${API}/violations/stats`).set(bearer(admin)).expect(200)).body;
    expect(stats.unassigned).toBe(1);
    await ctx.http().get(`${API}/violations/${v.id}`).set(bearer(supB.session)).expect(404);
    const assigned = (await ctx.http().post(`${API}/violations/${v.id}/assign`).set(bearer(monitor)).send({ memberId }).expect(200)).body;
    expect(assigned).toMatchObject({ assigned: true, member: { id: memberId }, team: { id: teamId }, supervisor: { id: supB.id } });
    expect(assigned.supervisors.map((s: { id: string }) => s.id)).toEqual([supB.id]);
    const unassignedNow = (await ctx.http().get(`${API}/violations?assigned=false`).set(bearer(admin)).expect(200)).body;
    expect(unassignedNow.total).toBe(0);
    const ocr = (await ctx.http().get(`${API}/violations/${v.id}/ocr`).set(bearer(monitor)).expect(200)).body;
    expect(ocr.status).toBe('NONE');
  });
});
