import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { bootstrapAdmin, placeholderIdentity, temporaryPassword } from './seed';
import { isValidNationalId, normalizeSaudiMobile, password as passwordSchema } from '@nuzli/shared';

const key = () => `v1:${randomBytes(32).toString('base64')}`;

function fakePrisma(owners = 0) {
  const created: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const tx = {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: 'u1', email: data.email, username: data.username });
      }),
    },
    auditLog: { create: jest.fn(({ data }: { data: Record<string, unknown> }) => audits.push(data)) },
  };
  const prisma = {
    user: { count: jest.fn().mockResolvedValue(owners) },
    workspaceMembership: { count: jest.fn().mockResolvedValue(0) },
    workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'ws' }) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, created, audits };
}

describe('A12 round 2 — bootstrap owner from BOOTSTRAP_OWNER_USERNAME', () => {
  const env = { NATIONAL_ID_ENC_KEY: key(), NATIONAL_ID_HMAC_KEY: key(), BOOTSTRAP_OWNER_USERNAME: 'mmansary' };

  it('username only: a random temporary password, printed ONCE, stored only as an argon2id hash; must change at first login', async () => {
    const { prisma, created, audits } = fakePrisma();
    const lines: string[] = [];
    expect(await bootstrapAdmin(prisma as never, env, (l) => lines.push(l))).toBe(true);
    const u = created[0]!;
    expect(u).toMatchObject({ username: 'mmansary', accountRole: 'OWNER', mustChangePassword: true, status: 'ACTIVE', email: 'mmansary@owner.nuzli.invalid' });
    const shown = /Temporary password \(shown once[^)]*\): (\S+)/.exec(lines.join('\n'))?.[1];
    expect(shown).toBeDefined();
    expect(await argon2.verify(String(u.passwordHash), shown!)).toBe(true);
    expect(JSON.stringify(u)).not.toContain(shown!);
    expect(JSON.stringify(audits)).not.toContain(shown!);
    expect(audits[0]).toMatchObject({ after: expect.objectContaining({ generatedPassword: true, placeholderIdentity: true }) });
    // a second start finds the owner and prints nothing
    const again = fakePrisma(1);
    const later: string[] = [];
    expect(await bootstrapAdmin(again.prisma as never, env, (l) => later.push(l))).toBe(false);
    expect(later).toEqual([]);
  });

  it('BOOTSTRAP_OWNER_PASSWORD is used when set (never logged); the CHANGE_ME placeholder is refused', async () => {
    const { prisma, created } = fakePrisma();
    const lines: string[] = [];
    await bootstrapAdmin(prisma as never, { ...env, BOOTSTRAP_OWNER_PASSWORD: 'Owner-First-Pass-1' }, (l) => lines.push(l));
    expect(await argon2.verify(String(created[0]!.passwordHash), 'Owner-First-Pass-1')).toBe(true);
    expect(lines.join('\n')).not.toContain('Owner-First-Pass-1');
    await expect(bootstrapAdmin(fakePrisma().prisma as never, { ...env, BOOTSTRAP_OWNER_PASSWORD: 'CHANGE_ME_Owner123' }, () => undefined)).rejects.toThrow(/CHANGE_ME/);
  });

  it('generated values are valid: password rule, Saudi mobile, national ID format', () => {
    for (let i = 0; i < 20; i++) {
      expect(passwordSchema.safeParse(temporaryPassword()).success).toBe(true);
      const p = placeholderIdentity('mmansary');
      expect(normalizeSaudiMobile(p.mobile)).toBe(p.mobile);
      expect(isValidNationalId(p.nationalId)).toBe(true);
    }
  });
});
