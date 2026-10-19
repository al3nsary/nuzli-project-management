/**
 * Owner request A9 demo seed for teams, the organisational structure and violations without a
 * person (seed/demo/a9-teams.json, clearly marked «(تجريبي)»). Runs once on top of the earlier
 * seeds — also on demo databases created before this round:
 *  - two teams with two supervisors each (a co-supervisor added after the primary);
 *  - one worker foreman (مشرف عمّال) per active team;
 *  - an organisational structure with positions held by demo users and members, one vacant;
 *  - 8 unassigned violations, each with a person silhouette, evidence placeholders and a
 *    synthetic «بطاقة تجريبية» ID card drawn on a canvas with a generated, check-digit-valid
 *    number in large clear digits, so the in-browser OCR reads it. Their OCR jobs start PENDING
 *    and run the first time an admin (or the recorder) opens them.
 */
import { nationalIdCheckDigit } from '@nuzli/shared';
import seed from '../../../../../seed/demo/a9-teams.json';
import { riyadhTimeDaysAgo } from '../../features/violations/time';
import type {
  DemoDb,
  DemoFile,
  DemoMember,
  DemoOrgPosition,
  DemoOrgUnit,
  DemoTeamSupervisor,
  DemoViolation,
  DemoViolationOcr,
} from './db';

const SEED_KEY = 'seededA9Teams';

/** A national ID from a 9-digit body: the body plus its check digit. */
export function withCheckDigit(first9: string): string {
  return `${first9}${nationalIdCheckDigit(first9)}`;
}

interface CardSeed {
  /** `member:<id>` = that member's own card (exact ID match); else a new or a look-alike person. */
  person: string;
  name?: string;
  nameLatin?: string;
  idBody?: string;
  nationality: string;
  birthDate: string;
  expiryDate: string;
}

interface ViolationSeed {
  n: number;
  recordedBy: string;
  typeId: string;
  daysAgo: number;
  riyadhTime: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  description: string;
  evidence: number;
  card: CardSeed;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const vid = (n: number) => `00000000-0000-4000-8000-d9${pad(n, 10)}`;
const cid = (n: number) => `00000000-0000-4000-8000-d8${pad(n, 10)}`;
const fid = (n: number, kind: string, k: number) =>
  `00000000-0000-4000-8000-d7${kind}${pad(k, 2)}${pad(n, 7)}`;

export async function seedA9Teams(db: DemoDb, now: Date = new Date()): Promise<void> {
  if (await db.kv.get(SEED_KEY)) return;
  await db.transaction('rw', db.tables, async () => {
    const at = now.toISOString();
    const teams = await db.teams.toArray();
    if (!teams.length) return;

    // 0. Every live team has leadership rows (databases from before ADR-100 without history).
    const leaderRows = await db.teamSupervisors.toArray();
    for (const tm of teams) {
      if (leaderRows.some((r) => r.teamId === tm.id)) continue;
      await db.teamSupervisors.add({
        id: `00000000-0000-4000-8000-e0${tm.id.slice(-10)}`,
        teamId: tm.id,
        userId: tm.supervisorId,
        isPrimary: true,
        validFrom: tm.createdAt,
        validTo: tm.status === 'ARCHIVED' ? (tm.archivedAt ?? at) : null,
        addedById: tm.createdById,
        reason: null,
      });
    }

    // 1. Co-supervisors.
    for (const c of seed.coSupervisors) {
      const team = teams.find((tm) => tm.id === c.teamId);
      const user = await db.users.get(c.userId);
      if (!team || team.status === 'ARCHIVED' || !user || user.role !== 'SUPERVISOR') continue;
      const open = (await db.teamSupervisors.where('teamId').equals(c.teamId).toArray()).filter((r) => r.validTo === null);
      if (open.some((r) => r.userId === c.userId)) continue;
      const row: DemoTeamSupervisor = {
        id: c.id,
        teamId: c.teamId,
        userId: c.userId,
        isPrimary: false,
        validFrom: c.validFrom,
        validTo: null,
        addedById: c.addedById,
        reason: c.reason,
      };
      await db.teamSupervisors.put(row);
    }

    // 2. One foreman per active team: the member named in the seed, else the first by name.
    const memberships = await db.memberships.toArray();
    const members = new Map((await db.members.toArray()).map((m) => [m.id, m]));
    for (const tm of teams.filter((x) => x.status === 'ACTIVE')) {
      const open = memberships.filter((m) => m.teamId === tm.id && m.validTo === null);
      if (!open.length || open.some((m) => m.role === 'FOREMAN')) continue;
      const wanted = (seed.foremen as Record<string, string>)[tm.id];
      const pick =
        open.find((m) => m.memberId === wanted) ??
        [...open].sort((a, b) =>
          (members.get(a.memberId)?.fullName ?? '').localeCompare(members.get(b.memberId)?.fullName ?? '', 'ar'),
        )[0]!;
      await db.memberships.update(pick.id, { role: 'FOREMAN' });
    }

    // 3. The organisational structure.
    if (!(await db.orgUnits.count())) {
      const units: DemoOrgUnit[] = seed.org.units.map((u) => ({
        id: u.id,
        parentId: u.parentId,
        name: u.name,
        kind: u.kind as DemoOrgUnit['kind'],
        code: u.code ?? null,
        sort: u.sort,
        archivedAt: null,
        createdAt: '2026-08-01T06:00:00.000Z',
      }));
      await db.orgUnits.bulkPut(units);
      const foremanOf = (teamId: string) =>
        memberships.find((m) => m.teamId === teamId && m.validTo === null && m.role === 'FOREMAN')?.memberId ?? null;
      const refreshed = await db.memberships.toArray();
      const positions: DemoOrgPosition[] = seed.org.positions.map((p) => {
        let holderMemberId: string | null = null;
        if (p.holderForemanOf) {
          holderMemberId =
            refreshed.find((m) => m.teamId === p.holderForemanOf && m.validTo === null && m.role === 'FOREMAN')?.memberId ??
            foremanOf(p.holderForemanOf);
        }
        return {
          id: p.id,
          unitId: p.unitId,
          title: p.title,
          holderUserId: p.holderUserId ?? null,
          holderMemberId: holderMemberId ?? (p as { holderMemberId?: string }).holderMemberId ?? null,
          reportsToPositionId: p.reportsTo ?? null,
          sort: p.sort,
          createdAt: '2026-08-01T06:00:00.000Z',
        };
      });
      await db.orgPositions.bulkPut(positions);
      for (const [teamId, unitId] of Object.entries(seed.org.teamUnits as Record<string, string>)) {
        const tm = teams.find((x) => x.id === teamId);
        if (tm) await db.teams.update(teamId, { orgUnitId: unitId });
      }
    }

    // 4. Violations recorded without a person, with person + evidence + synthetic ID card.
    const types = await db.violationTypes.toArray();
    const latest = now.getTime() - 15 * 60_000;
    const violations: DemoViolation[] = [];
    const files: DemoFile[] = [];
    const ocr: DemoViolationOcr[] = [];
    for (const r of seed.violations as ViolationSeed[]) {
      if (!types.some((ty) => ty.id === r.typeId)) continue;
      let captured = riyadhTimeDaysAgo(now, r.daysAgo, r.riyadhTime).getTime();
      if (captured > latest) captured -= 24 * 60 * 60 * 1000;
      const capturedAt = new Date(captured).toISOString();
      const receivedAt = new Date(Math.min(latest, captured + 7 * 60_000)).toISOString();
      const id = vid(r.n);
      violations.push({
        id,
        clientUuid: cid(r.n),
        memberId: null,
        typeId: r.typeId,
        teamIdSnapshot: null,
        supervisorIdSnapshot: null,
        supervisorIdsSnapshot: [],
        assignedAt: null,
        assignedById: null,
        recordedById: r.recordedBy,
        description: r.description,
        notes: null,
        latitude: r.latitude,
        longitude: r.longitude,
        accuracyM: r.accuracyM,
        capturedAt,
        receivedAt,
        clientSentAt: receivedAt,
        clockDriftSuspect: false,
        deviceInfo: { platform: 'demo', appVersion: 'demo', online: false },
        expectedIdPhotos: 1,
        expectedEvidence: r.evidence,
        expectedPersonPhotos: 1,
        status: 'SUBMITTED',
        cancelReason: null,
        responses: [],
      });
      const card = cardFace(r.card, members);
      const hue = (r.n * 53) % 360;
      const base = Date.parse(receivedAt);
      const file = (kind: 'PERSON' | 'ID_CARD' | 'EVIDENCE', k: number, extra: Partial<DemoFile['placeholder']> = {}): DemoFile => ({
        id: fid(r.n, kind === 'PERSON' ? 'a' : kind === 'ID_CARD' ? 'b' : 'c', k),
        entityType: 'violation',
        entityId: id,
        kind,
        mimeType: kind === 'ID_CARD' ? 'image/png' : 'image/jpeg',
        sizeBytes: 0,
        status: 'READY',
        createdById: r.recordedBy,
        createdAt: new Date(base + (kind === 'PERSON' ? 0 : kind === 'ID_CARD' ? 1 : 1 + k) * 1000).toISOString(),
        expiresAt: receivedAt,
        violationId: id,
        placeholder: { label: `مخالفة دون شخص رقم ${r.n} — صورة ${k}`, hue, ...extra },
      });
      files.push(file('PERSON', 0, { variant: r.n % 3 }));
      const idFile = file('ID_CARD', 0, { card });
      files.push(idFile);
      for (let k = 1; k <= r.evidence; k++) files.push(file('EVIDENCE', k));
      ocr.push({
        violationId: id,
        fileId: idFile.id,
        status: 'PENDING',
        attempts: 0,
        error: null,
        extracted: null,
        extractedAt: null,
        updatedAt: at,
      });
    }
    // 5. Task attachments for «المرفقات» (placeholders drawn on first view; one PDF).
    const tasks = (await db.tasks.toArray())
      .filter((t) => t.type === 'TASK' && !t.archivedAt)
      .sort((a, b) => a.id.localeCompare(b.id));
    const assigned = tasks.filter((t) => t.assigneeId).slice(0, 7);
    const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
    assigned.forEach((task, i) => {
      const pdf = i === 2 || i === 5;
      const createdAt = new Date(now.getTime() - (i + 1) * 26 * 3_600_000).toISOString();
      files.push({
        id: '00000000-0000-4000-8000-d6' + pad(i + 1, 10),
        entityType: 'task',
        entityId: task.id,
        kind: 'ATTACHMENT',
        mimeType: pdf ? 'application/pdf' : 'image/jpeg',
        sizeBytes: pdf ? 182_400 + i * 1_311 : 412_000 + i * 37_500,
        status: 'READY',
        createdById: i % 3 === 0 ? ADMIN_ID : task.assigneeId!,
        createdAt,
        expiresAt: createdAt,
        violationId: null,
        placeholder: { label: pdf ? 'تقرير تجريبي' : 'صورة موقع تجريبية ' + String(i + 1), hue: (i * 61 + 200) % 360 },
      });
    });

    await db.violations.bulkPut(violations);
    await db.files.bulkPut(files);
    await db.violationOcr.bulkPut(ocr);
    await db.kv.put({ key: SEED_KEY, value: at });
  });
}

function cardFace(c: CardSeed, members: Map<string, DemoMember>) {
  if (c.person.startsWith('member:')) {
    const m = members.get(c.person.slice('member:'.length));
    if (m) {
      return {
        name: c.name ?? m.fullName,
        ...(c.nameLatin ? { nameLatin: c.nameLatin } : {}),
        nationalId: m.nationalId,
        nationality: c.nationality,
        birthDate: c.birthDate,
        expiryDate: c.expiryDate,
      };
    }
  }
  return {
    name: c.name ?? '—',
    ...(c.nameLatin ? { nameLatin: c.nameLatin } : {}),
    nationalId: withCheckDigit(c.idBody ?? '109876543'),
    nationality: c.nationality,
    birthDate: c.birthDate,
    expiryDate: c.expiryDate,
  };
}
