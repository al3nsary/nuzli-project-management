import { Injectable } from '@nestjs/common';
import {
  ERRORS,
  type ColorTakenDetails,
  type TeamColorDto,
  type TeamColorPaletteDto,
} from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { canReadTeam, COLOR_SELECT, RESERVING, toColorDto, type Viewer } from '../teams/team-dto';

interface ColorRow {
  id: string;
  name: string;
  hex: string;
  isActive: boolean;
}

interface ReservingTeam {
  id: string;
  name: string;
  colorId: string;
}

/**
 * Brief §5.2: the picker shows only ACTIVE palette colours that no ACTIVE/PENDING_APPROVAL
 * team holds. When a team is being edited its own colour stays selectable (even if it was
 * retired since). Reserved colours are never returned, not even disabled.
 */
export function availableColors(
  colors: readonly ColorRow[],
  reserving: readonly ReservingTeam[],
  excludeTeamId?: string,
): TeamColorDto[] {
  const own = excludeTeamId ? reserving.find((t) => t.id === excludeTeamId)?.colorId : undefined;
  const taken = new Set(reserving.filter((t) => t.id !== excludeTeamId).map((t) => t.colorId));
  return colors
    .filter((c) => c.id === own || (c.isActive && !taken.has(c.id)))
    .map(toColorDto);
}

@Injectable()
export class ColorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private reservingTeams(db: Db = this.prisma): Promise<ReservingTeam[]> {
    return db.team.findMany({
      where: { status: { in: RESERVING } },
      select: { id: true, name: true, colorId: true },
    });
  }

  private palette(db: Db = this.prisma): Promise<ColorRow[]> {
    return db.teamColor.findMany({ select: COLOR_SELECT, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  async available(excludeTeamId: string | undefined, viewer: Viewer | null, db: Db = this.prisma): Promise<TeamColorDto[]> {
    let exclude = excludeTeamId;
    if (exclude && viewer) {
      // A supervisor may only "keep" the colour of a team they lead.
      const team = await db.team.findUnique({ where: { id: exclude }, select: { supervisorId: true } });
      if (!team || !canReadTeam(viewer, team)) exclude = undefined;
    }
    const [colors, reserving] = await Promise.all([this.palette(db), this.reservingTeams(db)]);
    return availableColors(colors, reserving, exclude);
  }

  /** Admin palette with the team that currently holds each colour. */
  async list(): Promise<TeamColorPaletteDto[]> {
    const [colors, reserving] = await Promise.all([this.palette(), this.reservingTeams()]);
    const holder = new Map(reserving.map((t) => [t.colorId, t]));
    return colors.map((c) => {
      const t = holder.get(c.id);
      return { ...toColorDto(c), inUseBy: t ? { teamId: t.id, teamName: t.name } : null };
    });
  }

  async create(input: { name: string; hex: string }, ctx: RequestContext): Promise<TeamColorDto> {
    const hex = input.hex.toUpperCase();
    const created = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const last = await tx.teamColor.aggregate({ _max: { sortOrder: true } });
        const row = await tx.teamColor.create({
          data: { name: input.name, hex, sortOrder: (last._max.sortOrder ?? 0) + 1, createdById: ctx.actorId },
          select: COLOR_SELECT,
        });
        await this.audit.logCtx(
          ctx,
          { action: AuditAction.COLOR_CREATED, entityType: 'team_color', entityId: row.id, after: row },
          tx,
        );
        return row;
      }),
    );
    return toColorDto(created);
  }

  /** Rename, retire or restore. A retired colour stays on the teams that use it. */
  async update(id: string, patch: { name?: string; isActive?: boolean }, ctx: RequestContext): Promise<TeamColorDto> {
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await tx.teamColor.findUnique({ where: { id }, select: COLOR_SELECT });
        if (!before) throw new AppError('NOT_FOUND');
        const after = await tx.teamColor.update({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          },
          select: COLOR_SELECT,
        });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.COLOR_UPDATED,
            entityType: 'team_color',
            entityId: id,
            before: { name: before.name, isActive: before.isActive },
            after: { name: after.name, isActive: after.isActive },
          },
          tx,
        );
        return after;
      }),
    );
    return toColorDto(row);
  }

  /**
   * 409 COLOR_TAKEN with the fresh list of available colours, so the client can replace its
   * picker without another round trip (brief §5.2: "a clear Arabic message that refreshes the picker").
   */
  async colorTakenError(excludeTeamId?: string): Promise<AppError> {
    let available: TeamColorDto[] = [];
    try {
      available = await this.available(excludeTeamId, null);
    } catch {
      // The error itself matters more than the convenience list.
    }
    const details: ColorTakenDetails = {
      fieldErrors: { colorId: [ERRORS.COLOR_TAKEN] },
      refresh: 'colors',
      available,
    };
    return new AppError('COLOR_TAKEN', details);
  }
}
