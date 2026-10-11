import { nationalIdCheckDigit } from '@nuzli/shared';
import { randomBytes } from 'node:crypto';
import { assertNoNationalIdInQuery } from '../common/search-term';
import { bootstrapAdmin } from '../seed/seed';
import { loadEnv } from './env.schema';
import { isPlaceholder, weakRandomSecretReason } from './secret-strength';

const key = () => randomBytes(32).toString('base64');
const strong = () => randomBytes(48).toString('base64');

function prodEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://nuzli:Zr8kQ2xLmP4vT9wB@db:5432/nuzli',
    JWT_ACCESS_SECRET: strong(),
    NATIONAL_ID_ENC_KEY: `v1:${key()}`,
    NATIONAL_ID_HMAC_KEY: key(),
    S3_BUCKET: 'nuzli',
    S3_ACCESS_KEY: 'ocid1.credential.abc',
    S3_SECRET_KEY: randomBytes(24).toString('base64'),
    ...over,
  };
}

const errorOf = (env: NodeJS.ProcessEnv) => {
  try {
    loadEnv(env);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

describe('start-up secret checks in production (security review H1)', () => {
  it('a properly generated production configuration starts', () => {
    expect(errorOf(prodEnv())).toBe('');
  });

  it('the .env.example JWT placeholder is refused (it is long enough, but public)', () => {
    expect(errorOf(prodEnv({ JWT_ACCESS_SECRET: 'CHANGE_ME_at_least_32_random_characters_here' }))).toMatch(/JWT_ACCESS_SECRET .*CHANGE_ME/);
    expect(errorOf(prodEnv({ JWT_ACCESS_SECRET: 'change-me-' + strong() }))).toMatch(/JWT_ACCESS_SECRET/);
  });

  it('hand-typed or repetitive JWT secrets are refused; base64 of 32+ random bytes is required', () => {
    expect(errorOf(prodEnv({ JWT_ACCESS_SECRET: 'mysupersecretjwtkeyfornuzliapplication2026abc' }))).toMatch(/JWT_ACCESS_SECRET/);
    expect(errorOf(prodEnv({ JWT_ACCESS_SECRET: 'x'.repeat(64) }))).toMatch(/JWT_ACCESS_SECRET/);
    expect(errorOf(prodEnv({ JWT_ACCESS_SECRET: randomBytes(16).toString('base64').padEnd(32, 'A') }))).toMatch(/JWT_ACCESS_SECRET/);
    expect(errorOf(prodEnv({ JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') }))).toBe('');
  });

  it('national-ID keys must be random bytes and distinct; placeholders never parse', () => {
    expect(errorOf(prodEnv({ NATIONAL_ID_ENC_KEY: 'CHANGE_ME' }))).toMatch(/NATIONAL_ID_ENC_KEY/);
    expect(errorOf(prodEnv({ NATIONAL_ID_ENC_KEY: Buffer.alloc(32).toString('base64') }))).toMatch(/NATIONAL_ID_ENC_KEY .*not random/);
    const same = key();
    expect(errorOf(prodEnv({ NATIONAL_ID_ENC_KEY: same, NATIONAL_ID_HMAC_KEY: same }))).toMatch(/must differ/);
  });

  it('S3, SMTP and database placeholders are refused in production', () => {
    expect(errorOf(prodEnv({ S3_SECRET_KEY: 'CHANGE_ME_minio_secret_min_8_chars' }))).toMatch(/S3_SECRET_KEY/);
    expect(errorOf(prodEnv({ S3_ACCESS_KEY: 'CHANGE_ME_minio_user' }))).toMatch(/S3_ACCESS_KEY/);
    expect(errorOf(prodEnv({ SMTP_PASS: 'CHANGE_ME' }))).toMatch(/SMTP_PASS/);
    expect(errorOf(prodEnv({ DATABASE_URL: 'postgresql://nuzli:CHANGE_ME_db_password@db:5432/nuzli' }))).toMatch(/DATABASE_URL/);
  });

  it('a PDF service URL requires a strong PDF_SERVICE_TOKEN in production', () => {
    expect(errorOf(prodEnv({ PDF_SERVICE_URL: 'http://pdf:4000' }))).toMatch(/PDF_SERVICE_TOKEN is required/);
    expect(errorOf(prodEnv({ PDF_SERVICE_URL: 'http://pdf:4000', PDF_SERVICE_TOKEN: 'CHANGE_ME' }))).toMatch(/PDF_SERVICE_TOKEN/);
    expect(errorOf(prodEnv({ PDF_SERVICE_URL: 'http://pdf:4000', PDF_SERVICE_TOKEN: strong() }))).toBe('');
  });

  it('development keeps working with simple local values', () => {
    expect(
      errorOf({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://nuzli:dev@localhost:5432/nuzli',
        JWT_ACCESS_SECRET: 'x'.repeat(40),
        NATIONAL_ID_ENC_KEY: key(),
        NATIONAL_ID_HMAC_KEY: key(),
        S3_BUCKET: 'nuzli',
        S3_ACCESS_KEY: 'minio',
        S3_SECRET_KEY: 'minio-secret',
      }),
    ).toBe('');
  });

  it('helpers: placeholder detection is case-insensitive', () => {
    expect(isPlaceholder('change_me')).toBe(true);
    expect(isPlaceholder('Change-Me-123')).toBe(true);
    expect(isPlaceholder('real-value')).toBe(false);
    expect(weakRandomSecretReason(strong())).toBeNull();
  });
});

describe('Swagger default (security review L5)', () => {
  it('is off in production unless SWAGGER_ENABLED=true explicitly, on by default elsewhere', () => {
    expect(loadEnv(prodEnv()).SWAGGER_ENABLED).toBe(false);
    expect(loadEnv(prodEnv({ SWAGGER_ENABLED: 'true' })).SWAGGER_ENABLED).toBe(true);
    expect(loadEnv({ ...prodEnv(), NODE_ENV: 'development' }).SWAGGER_ENABLED).toBe(true);
    expect(loadEnv({ ...prodEnv(), NODE_ENV: 'development', SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED).toBe(false);
  });
});

describe('bootstrap admin password (security review H1)', () => {
  const env = {
    NATIONAL_ID_ENC_KEY: key(),
    NATIONAL_ID_HMAC_KEY: key(),
    BOOTSTRAP_ADMIN_EMAIL: 'admin@example.sa',
    BOOTSTRAP_ADMIN_NAME: 'مدير النظام',
    BOOTSTRAP_ADMIN_MOBILE: '0500000000',
    BOOTSTRAP_ADMIN_NATIONAL_ID: '100000000' + nationalIdCheckDigit('100000000'),
  };
  const prisma = () => ({ user: { count: jest.fn().mockResolvedValue(0) }, $transaction: jest.fn() });

  it('the example placeholder is refused in every environment', async () => {
    const p = prisma();
    await expect(bootstrapAdmin(p as never, { ...env, BOOTSTRAP_ADMIN_PASSWORD: 'CHANGE_ME_Admin12345' }, () => undefined)).rejects.toThrow(
      /CHANGE_ME placeholder/,
    );
    expect(p.$transaction).not.toHaveBeenCalled();
  });
});

describe('national IDs never in GET query strings (security review L4)', () => {
  it('a full ID in ?q= is refused with a pointer to the POST search; last-4, names and mobiles pass', () => {
    expect(() => assertNoNationalIdInQuery('1000000023', '/api/v1/members/search')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED', details: expect.objectContaining({ useInstead: 'POST /api/v1/members/search' }) }),
    );
    expect(() => assertNoNationalIdInQuery('0023', '/x')).not.toThrow();
    expect(() => assertNoNationalIdInQuery('محمد', '/x')).not.toThrow();
    expect(() => assertNoNationalIdInQuery('0551234567', '/x')).not.toThrow();
    expect(() => assertNoNationalIdInQuery(undefined, '/x')).not.toThrow();
  });
});
