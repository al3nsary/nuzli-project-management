import { z } from 'zod';
import { isPlaceholder, weakKeyBytesReason, weakPasswordReason, weakRandomSecretReason } from './secret-strength';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1' || v === 'yes'));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** Strips the optional `v1:` version prefix of a key. */
export const keyBody = (v: string) => (v.includes(':') ? v.slice(v.indexOf(':') + 1) : v);

/** A base64 key that decodes to exactly 32 bytes, optionally prefixed by its version (`v1:`). */
const key32 = z
  .string()
  .min(1)
  .refine(
    (v) => {
      return Buffer.from(keyBody(v), 'base64').length === 32;
    },
    { message: 'must be base64 for exactly 32 bytes (openssl rand -base64 32)' },
  );

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/**
 * Every configuration value comes from the environment (brief §3.1).
 * The app refuses to start when something required is missing or malformed.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(3000, 1, 65535),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Number of reverse proxies in front of the API (nginx = 1). Used for req.ip. */
    TRUST_PROXY: int(1, 0, 10),
    /** Unset → on in development/test, OFF in production (security review L5). */
    SWAGGER_ENABLED: z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional(),

    DATABASE_URL: z.string().url(),

    /** Public origin of the web app, used in e-mail links. */
    PUBLIC_WEB_URL: z.string().url().default('https://localhost'),
    CORS_ORIGINS: csv,

    /** Production: base64 of ≥ 32 random bytes, never the placeholder (security review H1). */
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: int(900, 60, 3600),
    REFRESH_TOKEN_TTL_DAYS: int(30, 1, 365),
    /** Only for plain-http automated tests. Forced to true in production. */
    COOKIE_SECURE: bool(true),

    THROTTLE_DEFAULT_LIMIT: int(300, 1),
    THROTTLE_AUTH_LIMIT: int(10, 1),
    /** Short account lock after N failures (ADR-062); per-IP / per-identifier delays do the rest. */
    LOGIN_MAX_FAILURES: int(10, 3, 100),
    LOGIN_LOCK_MINUTES: int(5, 1, 60),

    NATIONAL_ID_ENC_KEY: key32,
    /** Older encryption keys kept for decryption during rotation: `v1:<base64>,v2:<base64>`. */
    NATIONAL_ID_ENC_KEYS_OLD: csv,
    NATIONAL_ID_HMAC_KEY: key32,

    S3_ENDPOINT: z.string().url().optional(),
    /** Endpoint the browser can reach, used only to sign URLs (defaults to S3_ENDPOINT). */
    S3_PUBLIC_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: bool(true),

    /** `smtp` sends real mail; `noop` keeps messages in memory (tests, CI). */
    MAIL_TRANSPORT: z.enum(['smtp', 'noop']).default('smtp'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: int(1025, 1, 65535),
    SMTP_SECURE: bool(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    MAIL_FROM: z.string().default('نزلي <no-reply@nuzli.local>'),

    /** Optional server-side PDF renderer (ADR-024/ADR-043). Unset → GET /cards/batches/:id/pdf answers 501. */
    PDF_SERVICE_URL: z.string().url().optional(),
    PDF_SERVICE_TIMEOUT_MS: int(60000, 1000, 600000),
    /** Shared secret sent as `X-Pdf-Service-Token`; required in production with PDF_SERVICE_URL. */
    PDF_SERVICE_TOKEN: z.string().optional(),

    /** A9 (ADR-104): server-side OCR of violation ID-card photos (tesseract.js, self-hosted ara+eng data). */
    OCR_ENABLED: bool(true),
    /** Parallel OCR jobs in this process (each holds one WASM worker, ~150–250 MB). */
    OCR_CONCURRENCY: int(1, 1, 2),
    /** Attempts per job before FAILED (retries back off 30 s, 2 min, 8 min…). */
    OCR_MAX_ATTEMPTS: int(3, 1, 10),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const fail = (path: string, reason: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `${path} ${reason}` });
    const jwt = weakRandomSecretReason(env.JWT_ACCESS_SECRET);
    if (jwt) fail('JWT_ACCESS_SECRET', jwt);
    for (const name of ['NATIONAL_ID_ENC_KEY', 'NATIONAL_ID_HMAC_KEY'] as const) {
      const reason = weakKeyBytesReason(Buffer.from(keyBody(env[name]), 'base64'));
      if (reason) fail(name, reason);
    }
    env.NATIONAL_ID_ENC_KEYS_OLD.forEach((k, i) => {
      if (Buffer.from(keyBody(k), 'base64').length !== 32) fail(`NATIONAL_ID_ENC_KEYS_OLD.${i}`, 'must be base64 for exactly 32 bytes');
    });
    if (keyBody(env.NATIONAL_ID_ENC_KEY) === keyBody(env.NATIONAL_ID_HMAC_KEY)) {
      fail('NATIONAL_ID_HMAC_KEY', 'must differ from NATIONAL_ID_ENC_KEY');
    }
    const s3 = weakPasswordReason(env.S3_SECRET_KEY, 16);
    if (s3) fail('S3_SECRET_KEY', s3);
    if (isPlaceholder(env.S3_ACCESS_KEY)) fail('S3_ACCESS_KEY', 'is still the CHANGE_ME placeholder');
    if (isPlaceholder(env.SMTP_PASS)) fail('SMTP_PASS', 'is still the CHANGE_ME placeholder');
    if (isPlaceholder(env.DATABASE_URL)) fail('DATABASE_URL', 'contains the CHANGE_ME placeholder password');
    if (env.PDF_SERVICE_URL) {
      const token = env.PDF_SERVICE_TOKEN ? weakRandomSecretReason(env.PDF_SERVICE_TOKEN) : 'is required when PDF_SERVICE_URL is set';
      if (token) fail('PDF_SERVICE_TOKEN', token);
    }
  })
  .transform((env) => ({
    ...env,
    COOKIE_SECURE: env.NODE_ENV === 'production' ? true : env.COOKIE_SECURE,
    SWAGGER_ENABLED:
      env.SWAGGER_ENABLED === undefined
        ? env.NODE_ENV !== 'production'
        : env.SWAGGER_ENABLED === 'true' || env.SWAGGER_ENABLED === '1' || env.SWAGGER_ENABLED === 'yes',
  }));

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // `KEY=` in an env file means "not set", not "empty string".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
