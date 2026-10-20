import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { applyDualRole, personRefIds } from '@nuzli/shared';
import { mergeMap } from 'rxjs';
import type { AuthRequest } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MembershipReader = { workspaceMembership: Pick<Prisma.TransactionClient['workspaceMembership'], 'groupBy'> };

/**
 * A12 round 3: which of `ids` hold more than one live role (two in one workspace, or roles in
 * several — the same rule as `isDualRole` on a full user DTO). ONE grouped query; memberships are a
 * global table (no workspace filter), and only the yes/no leaves this function — never where.
 */
export async function dualRoleUserIds(prisma: MembershipReader, ids: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(ids)].filter((id) => UUID.test(id));
  if (!wanted.length) return new Set();
  const rows = await prisma.workspaceMembership.groupBy({
    by: ['userId'],
    where: { userId: { in: wanted }, archivedAt: null },
    having: { userId: { _count: { gt: 1 } } },
  });
  return new Set(rows.map((r) => r.userId));
}

/**
 * A12 round 3 (owner rule «شارة صلاحية مزدوجة في كل مكان»): every JSON answer inside a workspace
 * gets `dualRole: true` on its embedded person refs — a task's assignee, a comment's author, a
 * team's supervisors, participants, the people of an approval, hub rows (`PERSON_REF_KEYS` in
 * @nuzli/shared). One helper for every route, so a new endpoint cannot forget the badge; one
 * grouped query per request, and none when the answer names nobody.
 */
@Injectable()
export class DualRoleInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  // Typed loosely: the workspace has two rxjs copies (root and apps/api); the operator works on both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): any {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!req.user?.workspaceId) return next.handle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (next.handle() as any).pipe(mergeMap((data: unknown) => this.decorate(data)));
  }

  async decorate<T>(data: T): Promise<T> {
    if (data === null || typeof data !== 'object' || Buffer.isBuffer(data)) return data;
    const ids = personRefIds(data);
    if (!ids.length) return data;
    return applyDualRole(data, await dualRoleUserIds(this.prisma, ids));
  }
}
