import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config';
import { randomToken, sha256Hex } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  /** A12: the session's workspace (kept across rotations). */
  workspaceId?: string | null;
}

export interface NewRefreshToken {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
  workspaceId?: string | null;
}

/** Storage port for refresh tokens, so rotation logic is unit-testable without a database. */
export interface RefreshTokenRepo {
  create(data: NewRefreshToken): Promise<RefreshTokenRecord>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /** Marks the token rotated **only if it is still active**. False when another request won. */
  markRotated(id: string, replacedById: string, at: Date): Promise<boolean>;
  revokeFamily(familyId: string, at: Date): Promise<number>;
  revokeAllForUser(userId: string, at: Date): Promise<number>;
}

export const REFRESH_TOKEN_REPO = Symbol('REFRESH_TOKEN_REPO');

@Injectable()
export class PrismaRefreshTokenRepo implements RefreshTokenRepo {
  constructor(private readonly prisma: PrismaService) {}

  create(data: NewRefreshToken): Promise<RefreshTokenRecord> {
    return this.prisma.refreshToken.create({ data });
  }

  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async markRotated(id: string, replacedById: string, at: Date): Promise<boolean> {
    const res = await this.prisma.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at, replacedById },
    });
    return res.count === 1;
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    const res = await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: at },
    });
    return res.count;
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const res = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    });
    return res.count;
  }
}

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export type RotateResult =
  | { ok: true; userId: string; familyId: string; token: string; expiresAt: Date; workspaceId: string | null }
  | { ok: false; reason: 'invalid' | 'expired' }
  | { ok: false; reason: 'reused'; userId: string; familyId: string };

/**
 * Rotating refresh tokens with family reuse detection (ADR-010).
 * - Every login starts a family. Each refresh replaces the presented token with a new one.
 * - Presenting a token that was already rotated or revoked revokes the whole family.
 * - Only the SHA-256 of a token is stored.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    @Inject(REFRESH_TOKEN_REPO) private readonly repo: RefreshTokenRepo,
    private readonly cfg: Pick<AppConfig, 'REFRESH_TOKEN_TTL_DAYS'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get ttlMs(): number {
    return this.cfg.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  /** Issues a token; without `familyId` a new family starts (= a new login). */
  async issue(
    userId: string,
    meta: ClientMeta,
    familyId: string = randomUUID(),
    workspaceId: string | null = null,
  ): Promise<{ token: string; record: RefreshTokenRecord }> {
    const token = randomToken(32);
    const record = await this.repo.create({
      userId,
      familyId,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(this.now().getTime() + this.ttlMs),
      userAgent: meta.userAgent,
      ip: meta.ip,
      workspaceId,
    });
    return { token, record };
  }

  async rotate(presented: string | undefined, meta: ClientMeta): Promise<RotateResult> {
    if (!presented) return { ok: false, reason: 'invalid' };
    const current = await this.repo.findByHash(sha256Hex(presented));
    if (!current) return { ok: false, reason: 'invalid' };
    const now = this.now();

    if (current.revokedAt) {
      await this.repo.revokeFamily(current.familyId, now);
      return { ok: false, reason: 'reused', userId: current.userId, familyId: current.familyId };
    }
    if (current.expiresAt.getTime() <= now.getTime()) {
      await this.repo.revokeFamily(current.familyId, now);
      return { ok: false, reason: 'expired' };
    }

    const next = await this.issue(current.userId, meta, current.familyId, current.workspaceId ?? null);
    const won = await this.repo.markRotated(current.id, next.record.id, now);
    if (!won) {
      // A concurrent request rotated the same token first: treat as reuse.
      await this.repo.revokeFamily(current.familyId, now);
      return { ok: false, reason: 'reused', userId: current.userId, familyId: current.familyId };
    }
    return {
      ok: true,
      userId: current.userId,
      familyId: current.familyId,
      token: next.token,
      expiresAt: next.record.expiresAt,
      workspaceId: current.workspaceId ?? null,
    };
  }

  /** A12: the session record of a presented token (switch-workspace revokes its family). */
  async familyOf(presented: string | undefined): Promise<string | null> {
    if (!presented) return null;
    return (await this.repo.findByHash(sha256Hex(presented)))?.familyId ?? null;
  }

  /** Logout: revokes the family of the presented token (if any). */
  async revokeByToken(presented: string | undefined): Promise<void> {
    if (!presented) return;
    const current = await this.repo.findByHash(sha256Hex(presented));
    if (current) await this.repo.revokeFamily(current.familyId, this.now());
  }

  /** Suspension, password reset and password change end every session at once. */
  revokeAllForUser(userId: string): Promise<number> {
    return this.repo.revokeAllForUser(userId, this.now());
  }
}
