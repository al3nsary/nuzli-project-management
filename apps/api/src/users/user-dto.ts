import type { Prisma, User } from '@prisma/client';
import { maskNationalIdParts, type UserDto } from '@nuzli/shared';
import type { CryptoService } from '../crypto/crypto.service';
import { preferencesOf } from '../notifications/notifications.service';

/** Columns needed to build a UserDto (never the password hash). */
export const USER_DTO_SELECT = {
  id: true,
  fullName: true,
  email: true,
  mobile: true,
  nationalIdEnc: true,
  nationalIdFirst: true,
  nationalIdLast2: true,
  role: true,
  requestedRole: true,
  requestedTeamName: true,
  status: true,
  rejectionReason: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  preferences: true,
} satisfies Prisma.UserSelect;

export type UserRow = Pick<User, keyof typeof USER_DTO_SELECT>;

/**
 * Builds the wire shape. The national ID is always masked; the full value is added only
 * when the caller holds `nationalIds.readFull` (admins) — decided by the caller.
 */
export function toUserDto(
  u: UserRow,
  opts: { fullNationalId?: boolean; crypto?: CryptoService } = {},
): UserDto {
  const dto: UserDto = {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    mobile: u.mobile,
    nationalIdMasked: maskNationalIdParts(u.nationalIdFirst, u.nationalIdLast2),
    role: u.role,
    requestedRole: u.requestedRole,
    requestedTeamName: u.requestedTeamName,
    status: u.status,
    rejectionReason: u.rejectionReason,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    preferences: preferencesOf(u.preferences),
  };
  if (opts.fullNationalId && opts.crypto) {
    dto.nationalId = opts.crypto.decrypt(u.nationalIdEnc);
  }
  return dto;
}

/** Audit snapshot of a user: no secrets, masked national ID only. */
export function auditUser(u: Pick<UserRow, 'id' | 'role' | 'status' | 'email' | 'fullName'> & Partial<UserRow>) {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    role: u.role,
    status: u.status,
    ...(u.nationalIdFirst && u.nationalIdLast2
      ? { nationalIdMasked: maskNationalIdParts(u.nationalIdFirst, u.nationalIdLast2) }
      : {}),
    ...(u.rejectionReason !== undefined ? { rejectionReason: u.rejectionReason } : {}),
  };
}
