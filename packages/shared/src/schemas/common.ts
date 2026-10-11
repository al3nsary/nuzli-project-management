import { z } from 'zod';
import { isValidNationalId, toWesternDigits } from '../validators/national-id';
import { normalizeSaudiMobile } from '../validators/mobile';

// zod messages are Arabic because the web app shows them directly under the field.

export const uuid = z.string().uuid({ message: 'معرّف غير صالح' });

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'تاريخ غير صالح' });

export const isoDateTime = z.string().datetime({ offset: true, message: 'وقت غير صالح' });

export const fullName = z
  .string()
  .trim()
  .min(3, { message: 'اكتب الاسم الكامل' })
  .max(120, { message: 'الاسم أطول من المسموح' });

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .email({ message: 'بريد إلكتروني غير صالح' });

export const nationalId = z
  .string()
  .transform((v) => toWesternDigits(v).trim())
  .refine(isValidNationalId, {
    message: 'رقم الهوية أو الإقامة غير صحيح: ١٠ أرقام تبدأ بـ ١ أو ٢',
  });

export const saudiMobile = z
  .string()
  .transform((v, ctx) => {
    const n = normalizeSaudiMobile(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'رقم جوال سعودي غير صحيح: 05XXXXXXXX' });
      return z.NEVER;
    }
    return n;
  });

export const password = z
  .string()
  .min(10, { message: 'كلمة المرور ١٠ أحرف على الأقل' })
  .max(128)
  .regex(/[A-Za-z؀-ۿ]/, { message: 'أضف حرفًا واحدًا على الأقل' })
  .regex(/\d/, { message: 'أضف رقمًا واحدًا على الأقل' });

export const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, { message: 'لون غير صالح' });

export const reason = z.string().trim().min(3, { message: 'اكتب السبب' }).max(500);

export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z
    .string()
    .regex(/^[a-zA-Z_.]+:(asc|desc)$/)
    .optional(),
  q: z.string().trim().max(100).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

/**
 * True when a search term contains a full national ID / Iqama number (10 digits starting with 1 or 2).
 * Saudi mobile numbers (05…, +9665…) do not match.
 * Such terms must go in a POST body (`POST /members/search`, `POST /users/search`), never in a
 * URL (brief §13, security review L4). Last-4 and name searches stay on GET.
 */
export function isFullNationalIdTerm(term: string | null | undefined): boolean {
  if (!term) return false;
  const western = term.replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
  return /(?<!\d)[12]\d{9}(?!\d)/.test(western.replace(/[\s-]/g, ''));
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
