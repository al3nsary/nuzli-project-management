import { DEFAULT_SETTINGS, toWesternDigits, type ViolationTypeDto } from '@nuzli/shared';
import type { ApiClient } from '../../../api/client';
import { getMeta, setMeta, type OfflineDb, type RosterRow } from './db';

/** Settings the record form needs offline. */
export interface FormSettings {
  maxPhotos: number;
  gpsWarnMeters: number;
}

export const DEFAULT_FORM_SETTINGS: FormSettings = {
  maxPhotos: DEFAULT_SETTINGS.VIOLATION_MAX_PHOTOS,
  gpsWarnMeters: DEFAULT_SETTINGS.GPS_ACCURACY_WARN_METERS,
};

/** Refresh the cached roster at most this often in the background while online. */
export const ROSTER_REFRESH_MS = 15 * 60 * 1000;

/**
 * Arabic search normalisation: no diacritics or tatweel, one form of alef, yaa and taa marbuta,
 * single spaces. "عبدالله" and "عبد الله" both match "عبدالله".
 */
export function normalizeArabic(s: string): string {
  return toWesternDigits(s)
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Downloads the roster, the active violation types and the form settings, and replaces the
 * device copy in one transaction. Only masked IDs and the last four digits are ever stored.
 */
export async function refreshRoster(api: ApiClient, db: OfflineDb, userId: string) {
  const [roster, types, settings] = await Promise.all([
    api.violations.roster(),
    api.violationTypes.list({ active: true }),
    api.settings.get().catch(() => null),
  ]);
  const rows: RosterRow[] = roster.items.map((r) => ({
    memberId: r.memberId,
    fullName: r.fullName,
    nationalIdMasked: r.nationalIdMasked,
    nationalIdTail: r.nationalIdTail,
    teamId: r.teamId,
    teamName: r.teamName,
    teamColor: r.teamColor,
    searchName: normalizeArabic(r.fullName),
  }));
  await db.transaction('rw', db.roster, db.meta, async () => {
    await db.roster.clear();
    await db.roster.bulkPut(rows);
    await setMeta(db, 'lastRosterAt', roster.generatedAt);
    await setMeta(db, 'rosterUserId', userId);
    await setMeta(
      db,
      'types',
      types.filter((ty) => ty.isActive),
    );
    if (settings) {
      const form: FormSettings = {
        maxPhotos: settings.VIOLATION_MAX_PHOTOS,
        gpsWarnMeters: settings.GPS_ACCURACY_WARN_METERS,
      };
      await setMeta(db, 'formSettings', form);
    }
  });
  return { count: rows.length, generatedAt: roster.generatedAt };
}

export async function cachedTypes(db: OfflineDb): Promise<ViolationTypeDto[]> {
  return (await getMeta<ViolationTypeDto[]>(db, 'types')) ?? [];
}

export async function cachedFormSettings(db: OfflineDb): Promise<FormSettings> {
  return { ...DEFAULT_FORM_SETTINGS, ...((await getMeta<FormSettings>(db, 'formSettings')) ?? {}) };
}

/**
 * On-device member search: digits match the last four of the national ID (as typed so far),
 * anything else matches every word of the normalised name.
 */
export function searchRoster(rows: RosterRow[], query: string, limit = 30): RosterRow[] {
  const q = normalizeArabic(query);
  if (!q) return [];
  if (/^\d+$/.test(q)) {
    if (q.length > 4) return [];
    return rows.filter((r) => r.nationalIdTail.startsWith(q)).slice(0, limit);
  }
  const words = q.split(' ');
  return rows.filter((r) => words.every((w) => r.searchName.includes(w))).slice(0, limit);
}
