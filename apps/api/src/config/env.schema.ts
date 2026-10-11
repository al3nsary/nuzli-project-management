import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1' || v === 'yes'));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** A base64 key that decodes to exactly 32 bytes, optionally prefixed by its version (`v1:`). */
const key32 = z
  .string()
  .min(1)
  .refine(
    (v) => {
      const raw = v.includes(':') ? v.slice(v.indexOf(':') + 1) : v;
      return Buffer.from(raw, 'base64').length === 32;
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
    SWAGGER_ENABLED: bool(true),

    DATABASE_URL: z.string().url(),

    /** Public origin of the web app, used in e-mail links. */
    PUBLIC_WEB_URL: z.string().url().default('https://localhost'),
    CORS_ORIGINS: csv,

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: int(900, 60, 3600),
    REFRESH_TOKEN_TTL_DAYS: int(30, 1, 365),
    /** Only for plain-http automated tests. Forced to true in production. */
    COOKIE_SECURE: bool(true),

    THROTTLE_DEFAULT_LIMIT: int(300, 1),
    THROTTLE_AUTH_LIMIT: int(10, 1),
    LOGIN_MAX_FAILURES: int(5, 1, 100),
    LOGIN_LOCK_MINUTES: int(15, 1, 1440),

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
  })
  .transform((env) => ({
    ...env,
    COOKIE_SECURE: env.NODE_ENV === 'production' ? true : env.COOKIE_SECURE,
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
