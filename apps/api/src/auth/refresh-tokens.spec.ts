import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../crypto/crypto.service';
import {
  RefreshTokenService,
  type NewRefreshToken,
  type RefreshTokenRecord,
  type RefreshTokenRepo,
} from './refresh-tokens';

/** In-memory repo with the same conditional-update semantics as the Prisma one. */
class MemoryRepo implements RefreshTokenRepo {
  rows: RefreshTokenRecord[] = [];

  async create(data: NewRefreshToken): Promise<RefreshTokenRecord> {
    const row = { id: randomUUID(), revokedAt: null, replacedById: null, ...data };
    this.rows.push(row);
    return { ...row };
  }
  async findByHash(hash: string) {
    const row = this.rows.find((r) => r.tokenHash === hash);
    return row ? { ...row } : null;
  }
  async markRotated(id: string, replacedById: string, at: Date) {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.revokedAt) return false;
    row.revokedAt = at;
    row.replacedById = replacedById;
    return true;
  }
  async revokeFamily(familyId: string, at: Date) {
    let n = 0;
    for (const r of this.rows) if (r.familyId === familyId && !r.revokedAt) (r.revokedAt = at), n++;
    return n;
  }
  async revokeAllForUser(userId: string, at: Date) {
    let n = 0;
    for (const r of this.rows) if (r.userId === userId && !r.revokedAt) (r.revokedAt = at), n++;
    return n;
  }
  active() {
    return this.rows.filter((r) => !r.revokedAt);
  }
}

const meta = { ip: '127.0.0.1', userAgent: 'jest' };

describe('RefreshTokenService (ADR-010)', () => {
  let repo: MemoryRepo;
  let now: Date;
  let svc: RefreshTokenService;

  beforeEach(() => {
    repo = new MemoryRepo();
    now = new Date('2026-10-11T10:00:00Z');
    svc = new RefreshTokenService(repo, { REFRESH_TOKEN_TTL_DAYS: 30 }, () => now);
  });

  it('stores only the SHA-256 of the token', async () => {
    const { token, record } = await svc.issue('u1', meta);
    expect(record.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(repo.rows)).not.toContain(token);
    expect(record.expiresAt.getTime() - now.getTime()).toBe(30 * 86_400_000);
  });

  it('rotates: the new token works, the old one is revoked and linked', async () => {
    const first = await svc.issue('u1', meta);
    const r = await svc.rotate(first.token, meta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token).not.toBe(first.token);
    expect(r.familyId).toBe(first.record.familyId);
    const old = repo.rows.find((x) => x.id === first.record.id)!;
    expect(old.revokedAt).not.toBeNull();
    expect(old.replacedById).toBe(repo.rows.find((x) => x.tokenHash === sha256Hex(r.token))!.id);
    expect(repo.active()).toHaveLength(1);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const first = await svc.issue('u1', meta);
    const second = await svc.rotate(first.token, meta);
    expect(second.ok).toBe(true);
    const reuse = await svc.rotate(first.token, meta);
    expect(reuse).toEqual({ ok: false, reason: 'reused', userId: 'u1', familyId: first.record.familyId });
    expect(repo.active()).toHaveLength(0);
    // The attacker's or the victim's newer token is dead too.
    if (second.ok) expect((await svc.rotate(second.token, meta)).ok).toBe(false);
  });

  it('does not touch other families of the same user', async () => {
    const phone = await svc.issue('u1', meta);
    const laptop = await svc.issue('u1', meta);
    await svc.rotate(phone.token, meta);
    await svc.rotate(phone.token, meta); // reuse on the phone family
    const ok = await svc.rotate(laptop.token, meta);
    expect(ok.ok).toBe(true);
  });

  it('treats a lost race (concurrent rotation of the same token) as reuse', async () => {
    const first = await svc.issue('u1', meta);
    const original = repo.markRotated.bind(repo);
    // Another request rotates the token between our read and our conditional update.
    repo.markRotated = async (id, replacedBy, at) => {
      await original(id, 'someone-else', at);
      return original(id, replacedBy, at);
    };
    const r = await svc.rotate(first.token, meta);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reused');
    expect(repo.active()).toHaveLength(0);
  });

  it('rejects unknown, missing and expired tokens', async () => {
    expect(await svc.rotate(undefined, meta)).toEqual({ ok: false, reason: 'invalid' });
    expect(await svc.rotate('nope', meta)).toEqual({ ok: false, reason: 'invalid' });
    const t = await svc.issue('u1', meta);
    now = new Date(now.getTime() + 31 * 86_400_000);
    expect(await svc.rotate(t.token, meta)).toEqual({ ok: false, reason: 'expired' });
  });

  it('logout revokes the family; suspension revokes everything for the user', async () => {
    const a = await svc.issue('u1', meta);
    await svc.issue('u1', meta);
    await svc.issue('u2', meta);
    await svc.revokeByToken(a.token);
    expect(repo.active()).toHaveLength(2);
    expect(await svc.revokeAllForUser('u1')).toBe(1);
    expect(repo.active().map((r) => r.userId)).toEqual(['u2']);
  });
});
