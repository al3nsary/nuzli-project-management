/**
 * DemoApi copy of `ensureProjectCalendar` (apps/api/src/projects/calendars.service.ts, ADR-109):
 * the create form's `workingDays` / `workingHours` and imports get a calendar that matches them.
 * The base calendar (the given one, else the default) is reused when the requested working days
 * and hours equal its own and no exceptions are imposed; otherwise a calendar is created — with
 * the base calendar's holidays, or the given exceptions — and audited `calendar.created`.
 */
import type { DemoCalendar } from './db';
import type { DemoInternals } from './phase2';
import { DEFAULT_WORKING_HOURS } from '../hoursWire';
import { fail, newId } from './util';

export interface WorkingInterval {
  start: string;
  end: string;
}

export interface CalendarSpec {
  baseId?: string;
  weekendDays?: number[];
  workingHours?: WorkingInterval[];
  exceptions?: Array<{
    date: string;
    isWorking: boolean;
    name: string;
    workingHours?: WorkingInterval[] | null;
  }>;
  name: string;
}

const normalizeWeekend = (days: readonly number[]): number[] =>
  [...new Set(days)].sort((a, b) => a - b);

/** Sorted intervals as a stable string (equality of working days). */
export const hoursKey = (h: readonly WorkingInterval[]): string =>
  [...h]
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .map((w) => `${w.start}-${w.end}`)
    .join(',');

/** Weekend days from a list of working days (0 = Sunday … 6 = Saturday). */
export const weekendFromWorkingDays = (working: readonly number[]): number[] =>
  [0, 1, 2, 3, 4, 5, 6].filter((d) => !working.includes(d));

export async function ensureProjectCalendar(
  api: Pick<DemoInternals, 'db' | 'writeAudit'>,
  actorId: string,
  spec: CalendarSpec,
): Promise<{ id: string; created: boolean }> {
  const all = await api.db.calendars.toArray();
  const base = spec.baseId
    ? all.find((c) => c.id === spec.baseId)
    : (all.find((c) => c.isDefault) ?? all[0]);
  if (spec.baseId && !base) {
    fail('VALIDATION_FAILED', {
      fieldErrors: { calendarId: ['التقويم غير موجود. أنشئ تقويمًا أو اختر تقويمًا آخر'] },
    });
  }
  const baseWeekend = base ? normalizeWeekend(base.weekendDays) : [5, 6];
  const baseHours = base?.workingHours?.length ? base.workingHours : DEFAULT_WORKING_HOURS;
  const weekendDays = spec.weekendDays ? normalizeWeekend(spec.weekendDays) : baseWeekend;
  const workingHours = spec.workingHours ?? baseHours;
  if (
    base &&
    !spec.exceptions &&
    weekendDays.join(',') === baseWeekend.join(',') &&
    hoursKey(workingHours) === hoursKey(baseHours)
  ) {
    return { id: base.id, created: false };
  }
  if (weekendDays.length >= 7) {
    fail('VALIDATION_FAILED', { fieldErrors: { workingDays: ['اختر يوم عمل واحدًا على الأقل'] } });
  }
  const exceptions =
    spec.exceptions ??
    (base?.exceptions ?? []).map((e) => ({
      date: e.date,
      isWorking: e.isWorking,
      name: e.name,
      workingHours: e.workingHours ?? null,
    }));
  const unique = new Map(exceptions.map((e) => [e.date.slice(0, 10), e]));
  const row: DemoCalendar = {
    id: newId(),
    name: spec.name.slice(0, 80),
    weekendDays,
    isDefault: false,
    createdAt: new Date().toISOString(),
    workingHours: workingHours.map((w) => ({ start: w.start, end: w.end })),
    exceptions: [...unique.values()].map((e) => ({
      id: newId(),
      date: e.date.slice(0, 10),
      isWorking: e.isWorking,
      name: e.name.slice(0, 120) || 'استثناء',
      workingHours: e.isWorking && e.workingHours ? e.workingHours.map((w) => ({ ...w })) : null,
    })),
  };
  await api.db.calendars.add(row);
  await api.writeAudit({
    actorId,
    action: 'calendar.created',
    entityType: 'calendar',
    entityId: row.id,
    before: null,
    after: {
      name: spec.name,
      weekendDays,
      workingHours,
      exceptions: unique.size,
      baseCalendarId: base?.id ?? null,
    },
  });
  return { id: row.id, created: true };
}
