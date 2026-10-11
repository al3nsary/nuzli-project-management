import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_PREFERENCES,
  type NotificationDto,
  type NotificationType,
  type Paginated,
  type Role,
  type UserPreferences,
} from '@nuzli/shared';
import { paginate } from '../common/pagination';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { emails, type RenderedEmail } from './email-templates';
import { MailService } from './mail.service';

type Payload = Record<string, unknown>;

interface Recipient {
  id: string;
  email: string;
  fullName: string;
  preferences: Prisma.JsonValue;
}

export function preferencesOf(value: Prisma.JsonValue | null | undefined): UserPreferences {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Partial<UserPreferences>;
  return {
    ...DEFAULT_PREFERENCES,
    ...raw,
    emailNotifications: { ...DEFAULT_PREFERENCES.emailNotifications, ...(raw.emailNotifications ?? {}) },
  };
}

/** True unless the user switched e-mail off for this event type (brief §9). */
export function wantsEmail(preferences: Prisma.JsonValue | null | undefined, type: string): boolean {
  return preferencesOf(preferences).emailNotifications[type] !== false;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly cfg: AppConfig,
  ) {}

  /**
   * Creates one in-app notification per user and e-mails those who did not opt out.
   * Call it after the business transaction committed; it never throws on mail errors.
   * Payloads must not carry personal data beyond names (never national IDs).
   */
  async notify(userIds: string[], type: NotificationType, payload: Payload = {}): Promise<void> {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const created = await this.prisma.notification.createManyAndReturn({
      data: ids.map((userId) => ({ userId, type, payload: payload as Prisma.InputJsonValue })),
      select: { id: true, userId: true },
    });
    const byUser = new Map(created.map((n) => [n.userId, n.id]));
    const recipients = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, fullName: true, preferences: true },
    });
    for (const r of recipients) {
      if (!wantsEmail(r.preferences, type)) continue;
      const email = this.render(type, payload, r);
      if (!email) continue;
      const ok = await this.mail.send({ to: r.email, ...email });
      if (ok) {
        const notificationId = byUser.get(r.id);
        if (notificationId) {
          await this.prisma.notification.update({
            where: { id: notificationId },
            data: { emailedAt: new Date() },
          });
        }
      }
    }
  }

  /** Notifies every active admin (e.g. a new registration request). */
  async notifyAdmins(type: NotificationType, payload: Payload = {}): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      select: { id: true },
    });
    await this.notify(
      admins.map((a) => a.id),
      type,
      payload,
    );
  }

  private render(type: NotificationType, payload: Payload, to: Recipient): RenderedEmail | null {
    const web = this.cfg.PUBLIC_WEB_URL.replace(/\/$/, '');
    switch (type) {
      case 'REGISTRATION_REQUESTED':
        return emails.registrationRequested({
          adminName: to.fullName,
          applicantName: String(payload.fullName ?? ''),
          role: (payload.requestedRole as Role) ?? 'SUPERVISOR',
          url: `${web}/registrations`,
        });
      case 'REGISTRATION_APPROVED':
        return emails.registrationApproved({
          name: to.fullName,
          role: (payload.role as Role) ?? 'SUPERVISOR',
          url: `${web}/login`,
        });
      case 'REGISTRATION_REJECTED':
        return emails.registrationRejected({ name: to.fullName, reason: String(payload.reason ?? '') });
      case 'TEAM_PENDING_APPROVAL':
        return emails.teamPendingApproval({
          adminName: to.fullName,
          teamName: String(payload.teamName ?? ''),
          supervisorName: String(payload.supervisorName ?? ''),
          url: `${web}/teams`,
        });
      case 'TEAM_APPROVED':
        return emails.teamApproved({
          name: to.fullName,
          teamName: String(payload.teamName ?? ''),
          url: `${web}/teams/${String(payload.teamId ?? '')}`,
        });
      case 'TEAM_REJECTED':
        return emails.teamRejected({
          name: to.fullName,
          teamName: String(payload.teamName ?? ''),
          reason: String(payload.reason ?? ''),
        });
      default:
        // Phase 3+ events get their templates with their modules.
        return null;
    }
  }

  // ─────────────────────────────────────────── in-app center

  async list(
    userId: string,
    q: { page: number; pageSize: number; unread?: boolean },
  ): Promise<Paginated<NotificationDto>> {
    const where: Prisma.NotificationWhereInput = { userId, ...(q.unread ? { readAt: null } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return paginate(
      rows.map((n) => ({
        id: n.id,
        type: n.type,
        payload: (n.payload ?? {}) as Record<string, unknown>,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      q.page,
      q.pageSize,
    );
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    return { count: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /** Logged, not thrown: used for fire-and-forget calls after a response is decided. */
  safe(promise: Promise<unknown>): void {
    promise.catch((err) => this.logger.warn(`Notification failed: ${(err as Error).message}`));
  }
}
