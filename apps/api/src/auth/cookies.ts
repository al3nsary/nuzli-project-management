import type { CookieOptions, Response } from 'express';
import { randomToken } from '../crypto/crypto.service';

export const REFRESH_COOKIE = 'nz_rt';
export const CSRF_COOKIE = 'nz_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface CookieSettings {
  secure: boolean;
  maxAgeMs: number;
}

function base(settings: CookieSettings): CookieOptions {
  return { secure: settings.secure, sameSite: 'strict', maxAge: settings.maxAgeMs };
}

/**
 * Refresh token: httpOnly, Secure, SameSite=Strict, scoped to /api/v1/auth (ADR-010).
 * CSRF token: readable by the web app (double submit), echoed in X-CSRF-Token.
 */
export function setSessionCookies(res: Response, refreshToken: string, settings: CookieSettings) {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base(settings),
    httpOnly: true,
    path: REFRESH_COOKIE_PATH,
  });
  res.cookie(CSRF_COOKIE, randomToken(24), { ...base(settings), httpOnly: false, path: '/' });
}

export function clearSessionCookies(res: Response, settings: Pick<CookieSettings, 'secure'>) {
  const common: CookieOptions = { secure: settings.secure, sameSite: 'strict' };
  res.clearCookie(REFRESH_COOKIE, { ...common, httpOnly: true, path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { ...common, path: '/' });
}
