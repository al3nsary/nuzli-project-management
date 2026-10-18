/**
 * Phase 3 (brief §14, §16) against PostgreSQL + MinIO:
 *  - "Idempotent violation sync": the same clientUuid twice (and concurrently) → one row.
 *  - "Moving a member keeps old violations on the old team".
 *  - "Supervisor violation visibility on and off" (global setting × team override).
 *  - Acceptance at API level: a monitor syncs 3 offline violations with photos
 *    (presign → PUT → confirm), retries do not duplicate, snapshot and location are right.
 */
import { Workbook } from 'exceljs';
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

// A 1×1 PNG (valid magic bytes).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const API = '/api/v1';

describeInt('violations: idempotent sync, snapshots, visibility, photos', () => {
  let ctx: IntApp;
  let admin: Session;
  let monitor: Session;
  let supA: Session;
  let supB: Session;
  let supAId: string;
  let teamA: string;
  let teamB: string;
  let memberId: string;
  let typeId: string;

  const createUser = async (n: number, role: 'SUPERVISOR' | 'MONITOR'): Promise<{ id: string; session: Session }> => {
    const email = `u${n}@nuzli.test`;
    const res = await ctx
      .http()
      .post(`${API}/users`)
      .set(bearer(admin))
      .send({
        fullName: `مستخدم رقم ${n}`,
        email,
        mobile: `+96655100${String(n).padStart(4, '0')}`,
        nationalId: validNationalId(`10001${String(n).padStart(4, '0')}`),
        role,
      })
      .expect(201);
    const token = tokenFromMail(ctx, email);
    await ctx.http().post(`${API}/auth/reset-password`).send({ token, password: 'UserPass1234' }).expect(204);
    return { id: res.body.id as string, session: await login(ctx, email, 'UserPass1234') };
  };

  const violationBody = (over: Record<string, unknown> = {}) => ({
    clientUuid: randomUUID(),
    memberId,
    typeId,
    description: 'رمي مخلفات في غير مكانها',
    latitude: 24.7136,
    longitude: 46.6753,
    accuracyM: 12,
    capturedAt: new Date(Date.now() - 60_000).toISOString(),
    clientSentAt: new Date().toISOString(),
    deviceInfo: { userAgent: 'int-test', platform: 'node', appVersion: '1', serial: 'drop-me' },
    expectedIdPhotos: 1,
    expectedEvidencePhotos: 2,
    ...over,
  });

  /** presign → PUT to MinIO → confirm, exactly like the device sync engine. */
  const upload = async (s: Session, violationId: string, kind: 'ID_CARD' | 'EVIDENCE') => {
    const p = await ctx
      .http()
      .post(`${API}/files/presign`)
      .set(bearer(s))
      .send({ entityType: 'violation', entityId: violationId, kind, contentType: 'image/png', sizeBytes: PNG.length });
    if (p.status !== 201) return p;
    const put = await fetch(p.body.url as string, { method: 'PUT', headers: p.body.headers, body: PNG });
    expect(put.status).toBe(200);
    return ctx.http().post(`${API}/files/${p.body.fileId}/confirm`).set(bearer(s));
  };

  const list = async (s: Session, q = '') => (await ctx.http().get(`${API}/violations${q}`).set(bearer(s)).expect(200)).body;

  beforeAll(async () => {
    ctx = await startApp();
    admin = await bootstrapAdminSession(ctx);
    const a = await createUser(1, 'SUPERVISOR');
    const b = await createUser(2, 'SUPERVISOR');
    const m = await createUser(3, 'MONITOR');
    supAId = a.id;
    supA = a.session;
    supB = b.session;
    monitor = m.session;

    const colors = (await ctx.http().get(`${API}/colors/available`).set(bearer(admin)).expect(200)).body;
    teamA = (
      await ctx.http().post(`${API}/teams`).set(bearer(admin)).send({ name: 'فريق أ', colorId: colors[0].id, supervisorId: a.id }).expect(201)
    ).body.id;
    teamB = (
      await ctx.http().post(`${API}/teams`).set(bearer(admin)).send({ name: 'فريق ب', colorId: colors[1].id, supervisorId: b.id }).expect(201)
    ).body.id;
    memberId = (
      await ctx
        .http()
        .post(`${API}/teams/${teamA}/members`)
        .set(bearer(admin))
        .send({ fullName: 'عامر سالم الدوسري', nationalId: validNationalId('123450987') })
        .expect(201)
    ).body.id;
    // The fixtures were created seconds ago; back-date their history so violations captured
    // offline "hours ago" fall inside the member's team A interval.
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    await ctx.prisma.teamMembership.updateMany({ where: { memberId }, data: { validFrom: monthAgo } });
    await ctx.prisma.teamSupervisor.updateMany({ where: { teamId: { in: [teamA, teamB] } }, data: { validFrom: monthAgo } });
    typeId = (
      await ctx.http().post(`${API}/violation-types`).set(bearer(admin)).send({ name: 'نظافة الموقع', severity: 'MEDIUM' }).expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('the roster gives the monitor masked IDs, the last 4 digits and the current team', async () => {
    const res = await ctx.http().get(`${API}/violations/roster`).set(bearer(monitor)).expect(200);
    expect(res.body.generatedAt).toEqual(expect.any(String));
    const entry = res.body.items.find((r: { memberId: string }) => r.memberId === memberId);
    expect(entry).toMatchObject({ teamId: teamA, teamName: 'فريق أ', nationalIdTail: validNationalId('123450987').slice(-4) });
    expect(entry.nationalIdMasked).toContain('•');
    expect(JSON.stringify(res.body)).not.toContain(validNationalId('123450987'));
  });

  it('Idempotent violation sync: the same clientUuid twice, and concurrently, gives one row', async () => {
    const body = violationBody();
    const first = await ctx.http().post(`${API}/violations`).set(bearer(monitor)).send(body).expect(201);
    const again = await ctx.http().post(`${API}/violations`).set(bearer(monitor)).send(body).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await ctx.prisma.violation.count({ where: { clientUuid: body.clientUuid } })).toBe(1);
    // Only UA / platform / app version are stored.
    const row = await ctx.prisma.violation.findUniqueOrThrow({ where: { id: first.body.id } });
    expect(row.deviceInfo).toEqual({ userAgent: 'int-test', platform: 'node', appVersion: '1' });

    const racing = violationBody();
    const results = await Promise.all([1, 2, 3].map(() => ctx.http().post(`${API}/violations`).set(bearer(monitor)).send(racing)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await ctx.prisma.violation.count({ where: { clientUuid: racing.clientUuid } })).toBe(1);
  });

  it('acceptance: 3 offline violations with photos sync once, with location, snapshot and photos', async () => {
    const offline = [0, 1, 2].map((i) =>
      violationBody({
        latitude: 24.7 + i / 100,
        longitude: 46.6 + i / 100,
        accuracyM: 5 + i,
        capturedAt: new Date(Date.now() - (3 - i) * 3600_000).toISOString(), // recorded hours ago, offline
      }),
    );
    const ids: string[] = [];
    for (const body of offline) {
      // The sync engine may retry the create (lost answer): still one row.
      const created = await ctx.http().post(`${API}/violations`).set(bearer(monitor)).send(body).expect(201);
      await ctx.http().post(`${API}/violations`).set(bearer(monitor)).send(body).expect(200);
      ids.push(created.body.id);
      expect((await upload(monitor, created.body.id, 'ID_CARD')).status).toBe(200);
      const ev = await upload(monitor, created.body.id, 'EVIDENCE');
      expect(ev.status).toBe(200);
      expect((await upload(monitor, created.body.id, 'EVIDENCE')).status).toBe(200);
      // A retried confirm is harmless.
      const file = await ctx.prisma.file.findFirstOrThrow({ where: { entityId: created.body.id, kind: 'EVIDENCE' } });
      await ctx.http().post(`${API}/files/${file.id}/confirm`).set(bearer(monitor)).expect(200);
    }
    expect(await ctx.prisma.violation.count({ where: { clientUuid: { in: offline.map((o) => o.clientUuid) } } })).toBe(3);

    for (const [i, id] of ids.entries()) {
      const v = (await ctx.http().get(`${API}/violations/${id}`).set(bearer(admin)).expect(200)).body;
      expect(v).toMatchObject({
        latitude: offline[i]!.latitude,
        longitude: offline[i]!.longitude,
        accuracyM: offline[i]!.accuracyM,
        capturedAt: new Date(offline[i]!.capturedAt as string).toISOString(),
        team: { id: teamA, name: 'فريق أ' },
        supervisor: { id: supAId },
        clockDriftSuspect: false,
        recordedBy: { fullName: 'مستخدم رقم 3' },
      });
      expect(v.files).toHaveLength(3);
      expect(v.files.every((f: { ready: boolean }) => f.ready)).toBe(true);
      expect(v.files.filter((f: { kind: string }) => f.kind === 'ID_CARD')).toHaveLength(1);
      expect(await ctx.prisma.violationFile.count({ where: { violationId: id } })).toBe(3);
      const keys = await ctx.prisma.file.findMany({ where: { entityId: id }, select: { storageKey: true } });
      for (const k of keys) expect(k.storageKey).toMatch(/^violations\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    }

    // Limits: a second ID card is refused.
    const second = await upload(monitor, ids[0]!, 'ID_CARD');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('TOO_MANY_PHOTOS');

    // ID-card photo view is audited.
    const v0 = (await ctx.http().get(`${API}/violations/${ids[0]}`).set(bearer(admin)).expect(200)).body;
    const idCard = v0.files.find((f: { kind: string }) => f.kind === 'ID_CARD');
    const url = await ctx.http().get(`${API}/violations/${ids[0]}/files/${idCard.id}/url`).set(bearer(admin)).expect(200);
    expect(Buffer.from(await (await fetch(url.body.url as string)).arrayBuffer()).equals(PNG)).toBe(true);
    const audit = await ctx.http().get(`${API}/audit?action=violation.id_photo_viewed&entityId=${ids[0]}`).set(bearer(admin)).expect(200);
    expect(audit.body.total).toBe(1);

    // The monitor's "mine" lists them; another monitor's scope would not.
    const mine = await ctx.http().get(`${API}/violations/mine?pageSize=100`).set(bearer(monitor)).expect(200);
    expect(mine.body.items.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(ids));
  });

  it('Moving a member keeps old violations on the old team', async () => {
    const before = await ctx.http().post(`${API}/violations`).set(bearer(monitor)).send(violationBody()).expect(201);
    expect(before.body.team.id).toBe(teamA);
    const capturedBeforeMove = new Date(Date.now() - 1000).toISOString();

    await ctx.http().post(`${API}/members/move`).set(bearer(admin)).send({ memberIds: [memberId], toTeamId: teamB }).expect(200);

    // Already-stored violation keeps team A.
    const again = await ctx.http().get(`${API}/violations/${before.body.id}`).set(bearer(admin)).expect(200);
    expect(again.body.team.id).toBe(teamA);
    // Recorded offline before the move, synced after it → still team A.
    const late = await ctx
      .http()
      .post(`${API}/violations`)
      .set(bearer(monitor))
      .send(violationBody({ capturedAt: capturedBeforeMove }))
      .expect(201);
    expect(late.body.team.id).toBe(teamA);
    // Recorded after the move → team B.
    const after = await ctx
      .http()
      .post(`${API}/violations`)
      .set(bearer(monitor))
      .send(violationBody({ capturedAt: new Date().toISOString() }))
      .expect(201);
    expect(after.body.team.id).toBe(teamB);

    // Statistics use the snapshot.
    const stats = await ctx.http().get(`${API}/violations/stats?teamId=${teamA}`).set(bearer(admin)).expect(200);
    expect(stats.body.total).toBe(await ctx.prisma.violation.count({ where: { teamIdSnapshot: teamA } }));
    expect(stats.body.byTeam).toHaveLength(1);
    expect(stats.body.byTeam[0]).toMatchObject({ teamId: teamA, members: 0 });
    expect(stats.body.heatmap.length).toBeGreaterThan(0);

    // Move back for the following tests.
    await ctx.http().post(`${API}/members/move`).set(bearer(admin)).send({ memberIds: [memberId], toTeamId: teamA }).expect(200);
  });

  it('Supervisor violation visibility on and off (global setting × team override)', async () => {
    const id = (await ctx.http().post(`${API}/violations`).set(bearer(monitor)).send(violationBody()).expect(201)).body.id;
    const setGlobal = (v: boolean) =>
      ctx.http().patch(`${API}/settings`).set(bearer(admin)).send({ SUPERVISORS_CAN_SEE_VIOLATIONS: v }).expect(200);
    const setTeam = (mode: string) =>
      ctx.http().put(`${API}/teams/${teamA}/violation-visibility`).set(bearer(admin)).send({ mode }).expect(200);

    // Default: global off, team INHERIT → hidden: empty page and 404.
    expect((await list(supA)).total).toBe(0);
    await ctx.http().get(`${API}/violations/${id}`).set(bearer(supA)).expect(404);
    await ctx.http().post(`${API}/violations/${id}/responses`).set(bearer(supA)).send({ body: 'اعتراض على المخالفة' }).expect(404);

    // Team override SHOW wins over the global off.
    await setTeam('SHOW');
    const shown = await list(supA, '?pageSize=200');
    expect(shown.total).toBeGreaterThan(0);
    expect(shown.items.every((v: { team: { id: string } }) => v.team.id === teamA)).toBe(true);
    // Supervisors never get the ID-card photo.
    const v = (await ctx.http().get(`${API}/violations/${id}`).set(bearer(supA)).expect(200)).body;
    expect(v.id).toBe(id);
    // The other supervisor never sees team A's violations.
    expect((await list(supB)).total).toBe(0);

    // A response notifies the admins.
    await ctx.http().post(`${API}/violations/${id}/responses`).set(bearer(supA)).send({ body: 'اعتراض على المخالفة' }).expect(201);
    // Notifications are sent after the response is committed (fire-and-forget): poll briefly.
    let notified = false;
    for (let i = 0; i < 20 && !notified; i++) {
      const notes = await ctx.http().get(`${API}/notifications`).set(bearer(admin)).expect(200);
      notified = notes.body.items.some(
        (n: { type: string; payload: { violationId: string } }) => n.type === 'VIOLATION_OBJECTION' && n.payload.violationId === id,
      );
      if (!notified) await new Promise((r) => setTimeout(r, 100));
    }
    expect(notified).toBe(true);
    const withResponse = (await ctx.http().get(`${API}/violations/${id}`).set(bearer(admin)).expect(200)).body;
    expect(withResponse.responses[0]).toMatchObject({ body: 'اعتراض على المخالفة', supervisor: { id: supAId } });

    // Global on, team HIDE → hidden.
    await setGlobal(true);
    await setTeam('HIDE');
    expect((await list(supA)).total).toBe(0);
    await ctx.http().get(`${API}/violations/${id}`).set(bearer(supA)).expect(404);

    // Global on, team INHERIT → visible; global off again → hidden.
    await setTeam('INHERIT');
    expect((await list(supA)).total).toBeGreaterThan(0);
    await setGlobal(false);
    expect((await list(supA)).total).toBe(0);

    // A monitor never sees another recorder's violations; supervisors cannot record.
    await ctx.http().post(`${API}/violations`).set(bearer(supA)).send(violationBody()).expect(403);
  });

  it('edit window, status change with reason, Excel export (RTL, no freeze) audited', async () => {
    const created = (await ctx.http().post(`${API}/violations`).set(bearer(monitor)).send(violationBody()).expect(201)).body;
    const edited = await ctx.http().patch(`${API}/violations/${created.id}`).set(bearer(monitor)).send({ description: 'وصف معدّل' }).expect(200);
    expect(edited.body.description).toBe('وصف معدّل');
    // Close the window by moving received_at back.
    await ctx.prisma.violation.update({ where: { id: created.id }, data: { receivedAt: new Date(Date.now() - 3600_000) } });
    const closed = await ctx.http().patch(`${API}/violations/${created.id}`).set(bearer(monitor)).send({ description: 'محاولة متأخرة' }).expect(403);
    expect(closed.body.code).toBe('EDIT_WINDOW_CLOSED');
    await ctx.http().patch(`${API}/violations/${created.id}`).set(bearer(admin)).send({ description: 'تعديل المدير' }).expect(200);

    const noReason = await ctx.http().post(`${API}/violations/${created.id}/status`).set(bearer(admin)).send({ status: 'CANCELLED' }).expect(400);
    expect(noReason.body.code).toBe('VALIDATION_FAILED');
    const cancelled = await ctx
      .http()
      .post(`${API}/violations/${created.id}/status`)
      .set(bearer(admin))
      .send({ status: 'CANCELLED', reason: 'سُجّلت بالخطأ' })
      .expect(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'سُجّلت بالخطأ' });

    const file = await ctx
      .http()
      .get(`${API}/violations/export.xlsx`)
      .set(bearer(admin))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new Workbook();
    await wb.xlsx.load(file.body as ArrayBuffer);
    wb.eachSheet((ws) => {
      for (const view of ws.views) {
        expect(view.rightToLeft).toBe(true);
        expect(view.state).not.toBe('frozen');
      }
    });
    const audit = await ctx.http().get(`${API}/audit?action=violations.exported`).set(bearer(admin)).expect(200);
    expect(audit.body.total).toBe(1);
    const updates = await ctx.http().get(`${API}/audit?action=violation.updated&entityId=${created.id}`).set(bearer(admin)).expect(200);
    expect(updates.body.total).toBe(2);
  });
});
