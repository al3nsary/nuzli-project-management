import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA, type SettingKey, type Settings } from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { activeWorkspaceId } from '../prisma/workspace-context';

const SHAPE = SETTINGS_SCHEMA.shape;

/**
 * System toggles (brief §10) stored as `settings(workspace_id, key, value jsonb)` — A12: every
 * workspace has its own settings; defaults from @nuzli/shared.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getAll(): Promise<Settings> {
    const rows = await this.prisma.setting.findMany();
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (!(row.key in SHAPE)) continue;
      const parsed = SHAPE[row.key as SettingKey].safeParse(row.value);
      if (parsed.success) out[row.key] = parsed.data;
    }
    return out as Settings;
  }

  async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
    const row = await this.prisma.setting.findUnique({ where: { workspaceId_key: { workspaceId: activeWorkspaceId(), key } } });
    if (!row) return DEFAULT_SETTINGS[key];
    const parsed = SHAPE[key].safeParse(row.value);
    return parsed.success ? (parsed.data as Settings[K]) : DEFAULT_SETTINGS[key];
  }

  async update(patch: Partial<Settings>, ctx: RequestContext): Promise<Settings> {
    const before = await this.getAll();
    const changed = (Object.keys(patch) as SettingKey[]).filter(
      (k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(before[k]),
    );
    if (changed.length) {
      const workspaceId = activeWorkspaceId();
      await this.prisma.$transaction(async (tx) => {
        for (const key of changed) {
          const value = patch[key] as Prisma.InputJsonValue;
          await tx.setting.upsert({
            where: { workspaceId_key: { workspaceId, key } },
            create: { key, value, updatedById: ctx.actorId },
            update: { value, updatedById: ctx.actorId },
          });
        }
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.SETTINGS_UPDATED,
            entityType: 'settings',
            before: Object.fromEntries(changed.map((k) => [k, before[k]])),
            after: Object.fromEntries(changed.map((k) => [k, patch[k]])),
          },
          tx,
        );
      });
    }
    return this.getAll();
  }
}
