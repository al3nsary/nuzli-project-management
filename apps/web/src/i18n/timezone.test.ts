/**
 * Calculations audit L3: HOUR dates are Asia/Riyadh wall time, so what the list, the board and the
 * drawer show must not depend on the device's zone. This file runs with the device in New York
 * (UTC−4 in October), where `new Date('2026-10-22T18:00')` would be the 23rd in Riyadh.
 */
const DEVICE_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { afterAll, describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, setDisplayPrefs } from './index';
import { taskWhen } from '../features/tasks/when';
import { hijriSpan } from '../features/calendar/calendarFormat';

setDisplayPrefs({ digits: 'latn', showHijri: false });
// The worker may run other files next: give the zone back.
afterAll(() => {
  if (DEVICE_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = DEVICE_TZ;
});

describe('L3 — local date-times are read in Asia/Riyadh whatever the device zone', () => {
  it('the device really is in New York for this file', () => {
    expect(new Date('2026-10-22T12:00:00Z').getTimezoneOffset()).toBe(240);
  });

  it('an HOUR end at 18:00 on the 22nd is shown on the 22nd, at 6 pm', () => {
    expect(formatDate('2026-10-22T18:00')).toBe(formatDate('2026-10-22'));
    expect(formatDate('2026-10-22T18:00')).toContain('22');
    expect(formatDateTime('2026-10-22T18:00')).toMatch(/22.*6:00/);
    // London-style late evening: 22:30 stays the 22nd.
    expect(formatDate('2026-10-22T22:30')).toContain('22');
  });

  it('instants with a zone are unchanged (UTC → Riyadh)', () => {
    expect(formatDateTime('2026-10-22T15:00:00Z')).toMatch(/22.*6:00/);
  });

  it('the drawer line uses the same day', () => {
    expect(taskWhen({ startDate: '2026-10-22T09:00', endDate: '2026-10-22T18:00' })).toContain(formatDate('2026-10-22'));
  });
});

describe('L2 — a Hijri range across two years names both years', () => {
  it('ذو الحجة 1447 – محرم 1448', () => {
    const s = hijriSpan('2026-05-20', '2026-06-20', 'latn');
    expect(s.match(/14\d\d/g)).toHaveLength(2);
    expect(s).toContain('1447');
    expect(s).toContain('1448');
  });
  it('the short form within one year', () => {
    const s = hijriSpan('2026-07-01', '2026-07-30', 'latn');
    expect(s.match(/14\d\d/g)).toHaveLength(1);
  });
});
