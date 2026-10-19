/**
 * The worker foreman (مشرف عمّال, ADR-101) made unmistakable everywhere (owner request A10:
 * «يميز بعلامة او ايقونة او لون … ويميز في كل شيء»): the title «مشرف عمّال» (always as text, never
 * colour alone) + a helmet icon + Nozoly indigo — a filled badge, an indigo bar on the inline
 * start of rows/cards (`.nz-foreman-bar`), and a helmet corner mark on the person's avatar.
 * The foreman is a record only: no account and no permission (tooltip).
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Tooltip } from '@mantine/core';
import { HardHat } from './HardHat';
import type { MemberDto, TeamDetailDto } from '@nuzli/shared';
import { useApi } from '../api/context';
import { useAuthStore } from '../stores/auth';
import { t } from '../i18n';
import './foreman.css';

export type ForemanPerson = { id: string; fullName: string; hasPhoto?: boolean; photoFileId?: string | null };

/** The «مشرف عمّال» badge: filled indigo with a helmet, explained by its tooltip. */
export function ForemanBadge({ size = 'sm', variant = 'filled' }: { size?: 'xs' | 'sm' | 'md'; variant?: 'filled' | 'light' }) {
  return (
    <Tooltip label={t('teams.foreman.tooltip')} withArrow multiline maw={240}>
      <Badge
        variant={variant}
        size={size}
        radius="sm"
        className="nz-foreman-badge"
        data-variant={variant}
        leftSection={<HardHat size={size === 'xs' ? 12 : size === 'md' ? 16 : 14} />}
        tabIndex={0}
        aria-label={`${t('teams.foreman.label')} — ${t('teams.foreman.tooltip')}`}
        data-foreman-badge
      >
        {t('teams.foreman.label')}
      </Badge>
    </Tooltip>
  );
}

/**
 * Wraps an avatar and, for the foreman, adds a small indigo helmet badge on its corner (with an
 * accessible name, so the avatar alone still says «مشرف عمّال»).
 */
export function ForemanAvatar({ foreman, size = 28, children }: { foreman: boolean | undefined; size?: number; children: ReactNode }) {
  if (!foreman) return <>{children}</>;
  const mark = Math.max(12, Math.round(size * 0.48));
  return (
    <span className="nz-foreman-avatar" data-foreman style={{ ['--fm' as string]: `${mark}px` }}>
      {children}
      <span className="nz-foreman-mark" role="img" aria-label={t('teams.foreman.label')} title={t('teams.foreman.label')}>
        <HardHat size={Math.round(mark * 0.74)} />
      </span>
    </span>
  );
}

/** «مشرف عمّال: الاسم» — the foreman line under the supervisors on team cards and widgets. */
export function ForemanLine({ person, dense = false }: { person: ForemanPerson | null | undefined; dense?: boolean }) {
  if (!person) return null;
  return (
    <span className="nz-foreman-line" data-dense={dense || undefined}>
      <HardHat size={dense ? 14 : 16} className="nz-foreman-line-icon" />
      <span className="nz-foreman-line-label">{t('teams.foreman.label')}:</span>
      <span className="nz-foreman-line-name">{person.fullName}</span>
    </span>
  );
}

/** The foreman of a team detail: `foreman`, else the member flagged `isForeman`. */
export function foremanOf(team: Pick<TeamDetailDto, 'members'> & { foreman?: { id: string; fullName: string } | null }): ForemanPerson | null {
  const flagged = team.members.find((m) => m.isForeman);
  if (flagged) return flagged;
  return team.foreman ?? null;
}

/** Members with the foreman first (stable order otherwise). */
export function foremanFirst<T extends Pick<MemberDto, 'isForeman'>>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => Number(!!b.isForeman) - Number(!!a.isForeman));
}

/**
 * A team's foreman for list views. The team list may carry `foreman` (the demo sends it; optional);
 * otherwise the team detail is fetched (cached under the same key as the detail page).
 */
export function useTeamForeman(team: { id: string; status?: string; foreman?: ForemanPerson | null }): ForemanPerson | null {
  const api = useApi();
  const signedIn = useAuthStore((s) => s.status === 'authenticated');
  const known = team.foreman !== undefined;
  const detail = useQuery({
    queryKey: ['team', team.id],
    queryFn: () => api.teams.get(team.id),
    enabled: signedIn && !known && team.status !== 'ARCHIVED',
    staleTime: 60_000,
  });
  if (known) return team.foreman ?? null;
  return detail.data ? foremanOf(detail.data) : null;
}
