import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { VIEW_PREF_MAX_BYTES, type PermissionSubject, type ViewPrefDto } from '@nuzli/shared';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectStore } from './project-store';

type Viewer = PermissionSubject & { id: string };

/** UTF-8 size of the JSON text of a value. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function toDto(r: { projectId: string | null; key: string; value: Prisma.JsonValue; updatedAt: Date }): ViewPrefDto {
  return { projectId: r.projectId, key: r.key, value: r.value, updatedAt: r.updatedAt.toISOString() };
}

/**
 * A9 per-user view preferences (columns, saved views): `(user, project | null, key) → value`,
 * at most 32 KB of JSON each. Personal UI state, so it is not audited (ADR-097). A project
 * preference needs a project the user can see.
 */
@Injectable()
export class ViewPrefsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
  ) {}

  async list(viewer: Viewer, q: { projectId?: string; key?: string }): Promise<ViewPrefDto[]> {
    const rows = await this.prisma.userViewPref.findMany({
      where: { userId: viewer.id, ...(q.projectId ? { projectId: q.projectId } : { projectId: null }), ...(q.key ? { key: q.key } : {}) },
      select: { projectId: true, key: true, value: true, updatedAt: true },
      orderBy: { key: 'asc' },
    });
    return rows.map(toDto);
  }

  async put(viewer: Viewer, input: { projectId?: string | null; key: string; value?: unknown }): Promise<ViewPrefDto> {
    if (input.value === undefined) throw new AppError('VALIDATION_FAILED', { fieldErrors: { value: ['أرسل قيمة'] } });
    const bytes = jsonBytes(input.value);
    if (bytes > VIEW_PREF_MAX_BYTES) throw new AppError('VIEW_PREF_TOO_LARGE', { bytes, max: VIEW_PREF_MAX_BYTES });
    const projectId = input.projectId ?? null;
    if (projectId) await this.store.visibleProject(projectId, viewer);
    const value = input.value as Prisma.InputJsonValue;
    const where = { userId: viewer.id, projectId, key: input.key };
    const select = { projectId: true, key: true, value: true, updatedAt: true } as const;
    const write = async () => {
      const cur = await this.prisma.userViewPref.findFirst({ where, select: { id: true } });
      return cur
        ? this.prisma.userViewPref.update({ where: { id: cur.id }, data: { value }, select })
        : this.prisma.userViewPref.create({ data: { ...where, value }, select });
    };
    try {
      return toDto(await write());
    } catch (err) {
      // Two first writes raced on the partial unique index: the second one updates.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return toDto(await write());
      throw err;
    }
  }

  async remove(viewer: Viewer, q: { projectId?: string; key: string }): Promise<void> {
    await this.prisma.userViewPref.deleteMany({ where: { userId: viewer.id, projectId: q.projectId ?? null, key: q.key } });
  }
}
