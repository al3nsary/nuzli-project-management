import { Prisma } from '@prisma/client';
import type { ErrorCode } from '@nuzli/shared';
import { AppError } from './app-error';

/** Unique-constraint targets → error codes (P2002 / SQLSTATE 23505). */
const UNIQUE_TARGETS: Array<[RegExp, ErrorCode]> = [
  // A9: one open leadership row per (team, user); a live org-unit code is unique.
  [/team_supervisors_one_open_uq|team_id,\s*user_id|teamId,\s*userId/, 'SUPERVISOR_ALREADY_IN_TEAM'],
  [/org_units_code_uq|lower\(code\)/, 'NAME_TAKEN'],
  [/national_id_hash|nationalIdHash/, 'NATIONAL_ID_TAKEN'],
  [/email/, 'EMAIL_TAKEN'],
  [/mobile/, 'MOBILE_TAKEN'],
  [/teams_color_reserved_uq|color_id/, 'COLOR_TAKEN'],
  [/team_colors_hex|hex/, 'COLOR_EXISTS'],
  [/name/, 'NAME_TAKEN'],
];

export function targetText(err: Prisma.PrismaClientKnownRequestError): string {
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.join(',');
  if (typeof target === 'string') return target;
  return err.message;
}

/** Maps a Prisma error to an AppError, or returns null when it is not a known case. */
export function mapPrismaError(err: unknown): AppError | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        const text = targetText(err);
        for (const [re, code] of UNIQUE_TARGETS) if (re.test(text)) return new AppError(code);
        return new AppError('CONFLICT_VERSION');
      }
      case 'P2025':
        return new AppError('NOT_FOUND');
      case 'P2034': // serialization failure / deadlock under SERIALIZABLE
        return new AppError('CONFLICT_VERSION');
      default:
        return null;
    }
  }
  return null;
}

/** Runs `fn` and rethrows Prisma unique violations as Arabic AppErrors. */
export async function withPrismaErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapPrismaError(err) ?? err;
  }
}
