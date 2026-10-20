import { useMemo } from 'react';
import {
  Alert,
  Autocomplete,
  Badge,
  Box,
  Group,
  Loader,
  SimpleGrid,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconCheck, IconPalette } from '@tabler/icons-react';
import { PhotoAvatar } from '../../components/UserAvatar';
import type { ReferenceItemDto, TeamColorDto, TeamStatus } from '@nuzli/shared';
import { DualRoleBadge } from '../../features/workspaces/DualRole';
import { useReference } from '../../api/queries';
import { t, tCount, tKey } from '../../i18n';
import './teams-a9.css';

const TEAM_STATUS_COLOR: Record<TeamStatus, string> = {
  PENDING_APPROVAL: 'signal',
  ACTIVE: 'ok',
  ARCHIVED: 'slate',
};

export function TeamStatusBadge({ status }: { status: TeamStatus }) {
  return (
    <Badge color={TEAM_STATUS_COLOR[status]} variant="light">
      {tKey(`teamStatus.${status}`, 'common.none')}
    </Badge>
  );
}

/**
 * The palette picker (brief §5.2). It receives only colours that are free to take — reserved
 * colours are never passed in, so they are never shown, not even disabled. Each swatch shows
 * its Arabic name next to the colour.
 */
export function ColorPicker({
  colors,
  value,
  onChange,
  error,
  loading,
  label = t('teams.color'),
}: {
  colors: TeamColorDto[] | undefined;
  value: string | null;
  onChange: (id: string) => void;
  error?: string;
  loading?: boolean;
  label?: string;
}) {
  return (
    <Box role="radiogroup" aria-label={label}>
      <Group gap={6} mb={6}>
        <IconPalette size={18} aria-hidden />
        <Text fw={500} size="sm">
          {label}
        </Text>
        {colors ? (
          <Text size="xs" c="dimmed">
            {tCount('teams.colorsAvailable', colors.length)}
          </Text>
        ) : null}
      </Group>
      {loading && !colors ? (
        <Loader size="sm" color="field" />
      ) : colors && colors.length === 0 ? (
        <Alert color="signal" variant="light">
          {t('teams.noColors')}
        </Alert>
      ) : (
        <SimpleGrid cols={{ base: 2, xs: 3, sm: 4 }} spacing={6}>
          {(colors ?? []).map((c) => {
            const selected = c.id === value;
            return (
              <UnstyledButton
                key={c.id}
                role="radio"
                aria-checked={selected}
                data-color-id={c.id}
                onClick={() => onChange(c.id)}
                className="nz-swatch-btn"
                style={{
                  borderColor: selected ? 'var(--field)' : 'var(--line)',
                  boxShadow: selected ? '0 0 0 1px var(--field)' : undefined,
                }}
              >
                <span
                  className="nz-swatch-chip"
                  style={{ background: c.hex }}
                  aria-hidden
                >
                  {selected ? <IconCheck size={16} color="#fff" /> : null}
                </span>
                <span className="nz-swatch-name">{c.name}</span>
              </UnstyledButton>
            );
          })}
        </SimpleGrid>
      )}
      {error ? (
        <Text c="var(--breach)" size="sm" mt={6} role="alert">
          {error}
        </Text>
      ) : null}
    </Box>
  );
}

/** Job title / department from the admin list, with free text when nothing matches (brief §5.1). */
export function ReferenceInput({
  kind,
  label,
  value,
  onChange,
  error,
}: {
  kind: 'departments' | 'job-titles';
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const q = useReference(kind);
  const data = useMemo(
    () => (q.data ?? []).filter((r) => r.isActive !== false).map((r) => r.name),
    [q.data],
  );
  return (
    <Autocomplete
      label={label}
      description={t('members.refHint')}
      data={data}
      value={value}
      onChange={onChange}
      error={error}
      maxLength={80}
      comboboxProps={{ withinPortal: true }}
    />
  );
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** `{ jobTitleId }` when the text matches a list entry, else `{ jobTitleText }`. */
export function refFields(
  text: string,
  items: ReferenceItemDto[] | undefined,
  idKey: 'jobTitleId' | 'departmentId',
  textKey: 'jobTitleText' | 'departmentText',
) {
  const v = text.trim();
  if (!v) return {};
  const hit = (items ?? []).find((i) => i.isActive !== false && norm(i.name) === norm(v));
  return hit ? { [idKey]: hit.id } : { [textKey]: v };
}

// ---------------------------------------------------------------- A9: supervisors and the foreman

type SupervisorLike = { id: string; fullName: string; isPrimary?: boolean; hasPhoto?: boolean; dualRole?: boolean };

/** A team's supervisors (TeamDto.supervisors, else the single legacy supervisor), primary first. */
export function supervisorsOf(team: {
  supervisors?: SupervisorLike[];
  supervisor: { id: string; fullName: string; dualRole?: boolean } | null;
}): SupervisorLike[] {
  if (team.supervisors?.length) return [...team.supervisors].sort((a, b) => Number(!!b.isPrimary) - Number(!!a.isPrimary));
  return team.supervisor ? [{ ...team.supervisor, isPrimary: true }] : [];
}

/**
 * A12 round 3: a team's supervisors as one line of names («الاسم (رئيسي)، الاسم») — each with the
 * compact «صلاحية مزدوجة» mark when it applies (team cards, formation column headers).
 */
export function SupervisorNames({ supervisors, primaryLabel = true }: { supervisors: SupervisorLike[]; primaryLabel?: boolean }) {
  if (!supervisors.length) return <>{t('teams.noSupervisor')}</>;
  return (
    <>
      {supervisors.map((s, i) => (
        <span key={s.id} className="nz-sup-inline">
          {i > 0 ? '، ' : ''}
          {s.isPrimary && primaryLabel ? t('teams.sup.namePrimary', { name: s.fullName }) : s.fullName}
          <DualRoleBadge user={s} compact />
        </span>
      ))}
    </>
  );
}

/**
 * Every supervisor of a team as overlapping avatars (owner request A9, ADR-100): the primary
 * first with an indigo ring; each avatar's tooltip names the person and «رئيسي». `withNames`
 * also prints «الاسم (رئيسي) · الاسم».
 */
export function SupervisorAvatars({
  supervisors,
  size = 28,
  max = 4,
  withNames = false,
  selfId,
}: {
  supervisors: SupervisorLike[];
  size?: number;
  max?: number;
  withNames?: boolean;
  selfId?: string | null;
}) {
  if (!supervisors.length) {
    return (
      <Text size="sm" c="dimmed">
        {t('teams.noSupervisor')}
      </Text>
    );
  }
  const shown = supervisors.slice(0, max);
  const rest = supervisors.length - shown.length;
  const label = supervisors
    .map((s) => (s.isPrimary ? t('teams.sup.namePrimary', { name: s.fullName }) : s.fullName))
    .join('، ');
  return (
    <span className="nz-sups" aria-label={t('teams.sup.aria', { names: label })} role="group">
      <span className="nz-sups-stack" aria-hidden>
        {shown.map((s) => (
          <Tooltip key={s.id} label={s.isPrimary ? t('teams.sup.namePrimary', { name: s.fullName }) : s.fullName} withArrow>
            <span className="nz-sups-item" data-primary={s.isPrimary || undefined}>
              <PhotoAvatar
                target={s.id === selfId ? { kind: 'me', id: s.id } : { kind: 'user', id: s.id }}
                name={s.fullName}
                hasPhoto={s.hasPhoto}
                size={size}
                ring={false}
              />
            </span>
          </Tooltip>
        ))}
        {rest > 0 ? (
          <span className="nz-sups-more" style={{ width: size, height: size }}>
            +{rest}
          </span>
        ) : null}
      </span>
      {withNames ? (
        <span className="nz-sups-names">
          {supervisors.map((s, i) => (
            <span key={s.id}>
              {i > 0 ? ' · ' : ''}
              {s.fullName}
              <DualRoleBadge user={s} compact />
              {s.isPrimary ? <span className="nz-primary-chip">{t('teams.sup.primary')}</span> : null}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** The worker foreman badge lives in components/Foreman (A10: the same look everywhere). */
export { ForemanBadge } from '../../components/Foreman';
