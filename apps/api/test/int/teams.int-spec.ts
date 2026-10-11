/**
 * Phase 2 acceptance (brief §16):
 *  - "A used colour never appears in the picker" — incl. two concurrent creations with the
 *    same colour: exactly one succeeds, the other gets 409 COLOR_TAKEN.
 *  - "Moving a member records history" — two rows, contiguous intervals, and the exclusion
 *    constraint holds.
 */
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

interface Color {
  id: string;
  hex: string;
}

describeInt('teams, colours and membership history', () => {
  let ctx: IntApp;
  let admin: Session;
  let supA: string;
  let supB: string;

  const createSupervisor = async (n: number) => {
    const res = await ctx
      .http()
      .post('/api/v1/users')
      .set(bearer(admin))
      .send({
        fullName: `مشرف رقم ${n}`,
        email: `sup${n}@nuzli.test`,
        mobile: `+96655000${String(n).padStart(4, '0')}`,
        nationalId: validNationalId(`10000${String(n).padStart(4, '0')}`),
        role: 'SUPERVISOR',
      })
      .expect(201);
    return res.body.id as string;
  };

  const available = async (s: Session, excludeTeamId?: string): Promise<Color[]> => {
    const q = excludeTeamId ? `?excludeTeamId=${excludeTeamId}` : '';
    return (await ctx.http().get(`/api/v1/colors/available${q}`).set(bearer(s)).expect(200)).body;
  };

  beforeAll(async () => {
    ctx = await startApp();
    admin = await bootstrapAdminSession(ctx);
    supA = await createSupervisor(1);
    supB = await createSupervisor(2);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('a used colour never appears in the picker; the edited team keeps its own; archiving frees it', async () => {
    const before = await available(admin);
    expect(before).toHaveLength(24);
    const color = before[0]!;

    const team = await ctx
      .http()
      .post('/api/v1/teams')
      .set(bearer(admin))
      .send({ name: 'فريق الصيانة', colorId: color.id, supervisorId: supA })
      .expect(201);
    expect(team.body).toMatchObject({ status: 'ACTIVE', color: { id: color.id }, memberCount: 0 });

    const after = await available(admin);
    expect(after.map((c) => c.id)).not.toContain(color.id);
    expect(after).toHaveLength(23);
    expect((await available(admin, team.body.id)).map((c) => c.id)).toContain(color.id);

    const palette = await ctx.http().get('/api/v1/colors').set(bearer(admin)).expect(200);
    const held = palette.body.find((c: Color & { inUseBy: unknown }) => c.id === color.id);
    expect(held.inUseBy).toEqual({ teamId: team.body.id, teamName: 'فريق الصيانة' });

    await ctx
      .http()
      .post(`/api/v1/teams/${team.body.id}/archive`)
      .set(bearer(admin))
      .send({ reason: 'انتهى العمل' })
      .expect(200);
    expect((await available(admin)).map((c) => c.id)).toContain(color.id);
  });

  it('two concurrent creations with the same colour: exactly one succeeds', async () => {
    const color = (await available(admin))[1]!;
    const results = await Promise.all(
      [supA, supB].map((supervisorId, i) =>
        ctx
          .http()
          .post('/api/v1/teams')
          .set(bearer(admin))
          .send({ name: `فريق متزامن ${i + 1}`, colorId: color.id, supervisorId }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.code).toBe('COLOR_TAKEN');
    expect(loser.body.details.refresh).toBe('colors');
    expect(loser.body.details.available.map((c: Color) => c.id)).not.toContain(color.id);
    const holders = await ctx.prisma.team.count({
      where: { colorId: color.id, status: { in: ['ACTIVE', 'PENDING_APPROVAL'] } },
    });
    expect(holders).toBe(1);
    expect((await available(admin)).map((c) => c.id)).not.toContain(color.id);
  });

  it('a supervisor team is PENDING (colour still reserved) until an admin approves it', async () => {
    const token = tokenFromMail(ctx, 'sup1@nuzli.test');
    await ctx.http().post('/api/v1/auth/reset-password').send({ token, password: 'SupervisorPass1' }).expect(204);
    const sup = await login(ctx, 'sup1@nuzli.test', 'SupervisorPass1');

    const color = (await available(sup))[0]!;
    const res = await ctx
      .http()
      .post('/api/v1/teams')
      .set(bearer(sup))
      .send({ name: 'فريق المشرف', colorId: color.id, supervisorId: supB })
      .expect(201);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    expect(res.body.supervisor.id).toBe(supA); // always self, whatever was sent
    expect((await available(admin)).map((c) => c.id)).not.toContain(color.id);

    // Scope: the supervisor sees only their own teams.
    const list = await ctx.http().get('/api/v1/teams?status=ALL').set(bearer(sup)).expect(200);
    expect(list.body.every((t: { supervisor: { id: string } }) => t.supervisor.id === supA)).toBe(true);

    const approved = await ctx.http().post(`/api/v1/teams/${res.body.id}/approve`).set(bearer(admin)).expect(200);
    expect(approved.body.status).toBe('ACTIVE');
    const audit = await ctx.http().get(`/api/v1/audit?action=team.approved&entityId=${res.body.id}`).set(bearer(admin)).expect(200);
    expect(audit.body.total).toBe(1);
  });

  it('moving a member records history: two rows, contiguous intervals, no overlap possible', async () => {
    const colors = await available(admin);
    const [teamA, teamB] = await Promise.all(
      ['فريق أ', 'فريق ب'].map((name, i) =>
        ctx
          .http()
          .post('/api/v1/teams')
          .set(bearer(admin))
          .send({ name, colorId: colors[i]!.id, supervisorId: i ? supB : supA }),
      ),
    );
    expect(teamA!.status).toBe(201);
    expect(teamB!.status).toBe(201);

    const member = await ctx
      .http()
      .post(`/api/v1/teams/${teamA!.body.id}/members`)
      .set(bearer(admin))
      .send({ fullName: 'عامر سالم الدوسري', nationalId: validNationalId('123450987') })
      .expect(201);
    const memberId = member.body.id as string;
    expect(member.body.team.id).toBe(teamA!.body.id);

    const moved = await ctx
      .http()
      .post('/api/v1/members/move')
      .set(bearer(admin))
      .send({ memberIds: [memberId], toTeamId: teamB!.body.id, reason: 'إعادة توزيع' })
      .expect(200);
    expect(moved.body[0].team.id).toBe(teamB!.body.id);

    const again = await ctx
      .http()
      .post('/api/v1/members/move')
      .set(bearer(admin))
      .send({ memberIds: [memberId], toTeamId: teamB!.body.id })
      .expect(409);
    expect(again.body.code).toBe('MEMBER_ALREADY_IN_TEAM');

    const history = await ctx.http().get(`/api/v1/members/${memberId}/history`).set(bearer(admin)).expect(200);
    expect(history.body).toHaveLength(2);
    const [current, previous] = history.body;
    expect(current.team.id).toBe(teamB!.body.id);
    expect(current.validTo).toBeNull();
    expect(current.reason).toBe('إعادة توزيع');
    expect(previous.team.id).toBe(teamA!.body.id);
    expect(previous.validTo).toBe(current.validFrom); // contiguous: closed exactly where the new one opens

    const overlaps = await ctx.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM team_memberships a JOIN team_memberships b
        ON a.member_id = b.member_id AND a.id < b.id
       AND tstzrange(a.valid_from, COALESCE(a.valid_to, 'infinity'), '[)')
        && tstzrange(b.valid_from, COALESCE(b.valid_to, 'infinity'), '[)')`;
    expect(Number(overlaps[0]!.n)).toBe(0);

    // The exclusion constraint rejects a back-dated overlapping row even when it is closed.
    await expect(
      ctx.prisma.teamMembership.create({
        data: {
          memberId,
          teamId: teamA!.body.id,
          validFrom: new Date(new Date(previous.validFrom).getTime() + 1),
          validTo: new Date(new Date(current.validFrom).getTime() + 1),
        },
      }),
    ).rejects.toThrow();

    const audit = await ctx.http().get(`/api/v1/audit?action=members.moved`).set(bearer(admin)).expect(200);
    expect(audit.body.items[0].after).toMatchObject({ toTeamId: teamB!.body.id, fromTeamIds: [teamA!.body.id] });

    // Archiving team B leaves the member unassigned.
    await ctx.http().post(`/api/v1/teams/${teamB!.body.id}/archive`).set(bearer(admin)).send({ reason: 'دمج الفرق' }).expect(200);
    const unassigned = await ctx.http().get('/api/v1/members?unassigned=true').set(bearer(admin)).expect(200);
    expect(unassigned.body.items.map((m: { id: string }) => m.id)).toContain(memberId);
  });
});
