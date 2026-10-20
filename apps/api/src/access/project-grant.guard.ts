import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { AuthRequest } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { participantProjectIds, projectBoundGrants } from './access-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which path parameter names a project, directly or through a child row. */
type Anchor = 'project' | 'task' | 'timeEntry' | 'label' | 'customField' | 'dependency';

const ANCHORS: Array<[RegExp, Anchor]> = [
  [/\/projects\/:id(\/|$)/, 'project'],
  [/\/tasks\/:id(\/|$)/, 'task'],
  [/\/time-entries\/:id(\/|$)/, 'timeEntry'],
  [/\/labels\/:id(\/|$)/, 'label'],
  [/\/custom-fields\/:id(\/|$)/, 'customField'],
  [/\/dependencies\/:id(\/|$)/, 'dependency'],
];

/**
 * A12 round 2 — project participants' rights are per project. Runs after JwtAuthGuard and before
 * PermissionsGuard: when the route is about ONE project (its id in the path, or a task / time
 * entry / label / custom field / dependency of it), the request's `grants` become the
 * assistant's modules + the participant level on THAT project (محرّر → tasks.manage …). On any
 * other route the participant keeps only the read (and, for contributors, comment) grants set by
 * JwtAuthGuard. The lookups run inside the request's workspace (scoped): another workspace's ids
 * resolve to nothing, so they never grant anything.
 */
@Injectable()
export class ProjectGrantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest & { route?: { path?: string } }>();
    const user = req.user;
    if (!user?.workspaceId || !participantProjectIds(user).length) return true;
    const path = req.route?.path ?? '';
    const id = (req.params as Record<string, string> | undefined)?.id;
    if (!id || !UUID_RE.test(id)) return true;
    const anchor = ANCHORS.find(([re]) => re.test(path))?.[1];
    if (!anchor) return true;
    const projectId = await this.projectOf(anchor, id);
    user.grants = projectBoundGrants(user, projectId);
    return true;
  }

  private async projectOf(anchor: Anchor, id: string): Promise<string | null> {
    switch (anchor) {
      case 'project':
        return id;
      case 'task':
        return (await this.prisma.task.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null;
      case 'timeEntry':
        return (await this.prisma.timeEntry.findUnique({ where: { id }, select: { task: { select: { projectId: true } } } }))?.task.projectId ?? null;
      case 'label':
        return (await this.prisma.projectLabel.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null;
      case 'customField':
        return (await this.prisma.customField.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null;
      case 'dependency':
        return (await this.prisma.taskDependency.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null;
    }
  }
}
