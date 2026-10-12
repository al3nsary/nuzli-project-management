import { z } from 'zod';
import { email, fullName, nationalId, optionalText, paginationQuery, password, reason, saudiMobile } from './common';
import type { Role, UserStatus } from '../enums';

export const roleSchema = z.enum(['ADMIN', 'SUPERVISOR', 'MONITOR']);
export const selfRegistrableRole = z.enum(['SUPERVISOR', 'MONITOR']);

export const loginSchema = z.object({
  /** Email or Saudi mobile. */
  identifier: z.string().trim().min(3, { message: 'اكتب البريد أو رقم الجوال' }),
  password: z.string().min(1, { message: 'اكتب كلمة المرور' }),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  accountType: selfRegistrableRole,
  fullName,
  email,
  mobile: saudiMobile,
  nationalId,
  password,
  requestedTeamName: optionalText(80),
});
export type RegisterInput = z.input<typeof registerSchema>;

export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: z.string().min(20), password });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, { message: 'اكتب كلمة المرور الحالية' }),
  newPassword: password,
});

export const createUserSchema = z.object({
  fullName,
  email,
  mobile: saudiMobile,
  nationalId,
  role: roleSchema,
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const approveRegistrationSchema = z.object({ role: selfRegistrableRole.optional() });
export const rejectRegistrationSchema = z.object({ reason });
export const changeRoleSchema = z.object({ role: roleSchema });
export const suspendUserSchema = z.object({ reason: optionalText(500) });

export const updateProfileSchema = z.object({
  fullName: fullName.optional(),
  preferences: z
    .object({
      digits: z.enum(['latn', 'arab']).optional(),
      showHijri: z.boolean().optional(),
      emailNotifications: z.record(z.string(), z.boolean()).optional(),
      theme: z.enum(['light', 'dark', 'auto']).optional(),
    })
    .optional(),
});

export interface UserPreferences {
  digits: 'latn' | 'arab';
  showHijri: boolean;
  emailNotifications: Record<string, boolean>;
  theme: 'light' | 'dark' | 'auto';
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  digits: 'latn',
  showHijri: false,
  emailNotifications: {},
  theme: 'auto',
};

export interface UserDto {
  id: string;
  fullName: string;
  email: string;
  mobile: string;
  /** Always present, masked. */
  nationalIdMasked: string;
  /** Only for admins and flows that need the full value. */
  nationalId?: string;
  role: Role;
  /** Role requested at registration (for pending requests). */
  requestedRole?: Role | null;
  requestedTeamName?: string | null;
  status: UserStatus;
  rejectionReason?: string | null;
  mustChangePassword: boolean;
  lastLoginAt?: string | null;
  createdAt: string;
  preferences: UserPreferences;
  /** Owner request A8: profile photo (`GET /users/:id/photo-url`, `GET /me/photo-url`). Always sent by the API. */
  photoFileId?: string | null;
  hasPhoto?: boolean;
}

export interface AuthSession {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: UserDto;
}

/** `POST /users/search` — `GET /users` filters in the body (full national IDs stay out of URLs). */
export const userSearchSchema = paginationQuery.extend({
  role: roleSchema.optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional(),
});
export type UserSearchInput = z.input<typeof userSearchSchema>;
