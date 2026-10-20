import { Injectable } from '@nestjs/common';
import type { OwnerDto } from '@nuzli/shared';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { AuthUser, RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithoutWorkspace } from '../prisma/workspace-context';
import { AccountAction, assertNotLastOwner } from '../users/accounts.service';
import { MembershipsService } from '../users/memberships.service';
import { allocateUsername } from '../users/usernames';

const OWNER_SELECT = {
  id: true,
  username: true,
  fullName: true,
  email: true,
  status: true,
  photoFileId: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

type OwnerRow = { id: string; username: string; fullName: string; email: string; status: OwnerDto['status']; photoFileId: string | null; createdAt: Date; lastLoginAt: Date | null };

function toOwnerDto(u: OwnerRow): OwnerDto {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    email: u.email,
    status: u.status,
    hasPhoto: !!u.photoFileId,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  };
}

export type AddOwnerData =
  | { userId: string }
  | { identifier: string }
  | { username: string; fullName: string; email: string; mobile: string; nationalId: string; password: string; mustChangePassword: boolean };

/**
 * A12 round 2 — owners (ملّاك): the account layer above every workspace. Only owners list, add
 * or remove owners; the system never has zero active owners (LAST_OWNER, under a row lock like
 * the last-admin rule). Owner changes are account-level: audited with workspace NULL.
 */
@Injectable()
export class OwnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly passwords: PasswordService,
    private readonly memberships: MembershipsService,
  ) {}

  private assertOwner(viewer: AuthUser): void {
    if (viewer.accountRole !== 'OWNER') throw new AppError('FORBIDDEN');
  }

  async list(viewer: AuthUser): Promise<OwnerDto[]> {
    this.assertOwner(viewer);
    const rows = await this.prisma.user.findMany({ where: { accountRole: 'OWNER' }, select: OWNER_SELECT, orderBy: { createdAt: 'asc' } });
    return rows.map(toOwnerDto);
  }

  /** Promotes an existing ACTIVE account, or creates a new owner account (must change password by default). */
  async add(input: AddOwnerData, viewer: AuthUser, ctx: RequestContext): Promise<OwnerDto> {
    this.assertOwner(viewer);
    const passwordHash = 'password' in input ? await this.passwords.hash(input.password) : null;
    return runWithoutWorkspace(() =>
      withPrismaErrors(() =>
        this.prisma.$transaction(async (tx) => {
          let id: string;
          let created = false;
          if ('username' in input) {
            const nid = this.crypto.protectNationalId(input.nationalId);
            const u = await tx.user.create({
              data: {
                username: await allocateUsername(tx, input.email, input.username),
                accountRole: 'OWNER',
                fullName: input.fullName,
                email: input.email,
                mobile: input.mobile,
                nationalIdEnc: nid.enc,
                nationalIdHash: nid.hash,
                nationalIdFirst: nid.first,
                nationalIdLast2: nid.last2,
                passwordHash,
                mustChangePassword: input.mustChangePassword,
                status: 'ACTIVE',
                approvedAt: new Date(),
                approvedById: viewer.id,
                createdById: viewer.id,
              },
              select: { id: true },
            });
            id = u.id;
            created = true;
          } else {
            const u = await this.memberships.findAccount(tx, input);
            if (u.accountRole === 'OWNER') throw new AppError('INVALID_STATE', { accountRole: 'OWNER' });
            await tx.user.update({ where: { id: u.id }, data: { accountRole: 'OWNER' } });
            id = u.id;
          }
          await this.audit.log(
            {
              actorId: viewer.id,
              action: AccountAction.OWNER_ADDED,
              entityType: 'user',
              entityId: id,
              before: created ? null : { accountRole: 'USER' },
              after: { accountRole: 'OWNER', created },
              ip: ctx.ip,
              requestId: ctx.requestId,
            },
            tx,
          );
          return toOwnerDto(await tx.user.findUniqueOrThrow({ where: { id }, select: OWNER_SELECT }));
        }),
      ),
    );
  }

  /** Demotes an owner to a normal account (their memberships stay). Never the last active owner. */
  async remove(userId: string, viewer: AuthUser, ctx: RequestContext): Promise<void> {
    this.assertOwner(viewer);
    await runWithoutWorkspace(() =>
      this.prisma.$transaction(async (tx) => {
        const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, accountRole: true, status: true } });
        if (!target || target.accountRole !== 'OWNER') throw new AppError('NOT_FOUND');
        await assertNotLastOwner(tx, userId);
        await tx.user.update({ where: { id: userId }, data: { accountRole: 'USER' } });
        // Sessions bound to workspaces the person can no longer enter end now; others on refresh.
        await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        await this.audit.log(
          {
            actorId: viewer.id,
            action: AccountAction.OWNER_REMOVED,
            entityType: 'user',
            entityId: userId,
            before: { accountRole: 'OWNER' },
            after: { accountRole: 'USER', sessionsEnded: true },
            ip: ctx.ip,
            requestId: ctx.requestId,
          },
          tx,
        );
      }),
    );
  }
}
