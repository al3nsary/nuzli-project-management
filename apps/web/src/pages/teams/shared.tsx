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
  UnstyledButton,
} from '@mantine/core';
import { IconCheck, IconPalette } from '@tabler/icons-react';
import type { ReferenceItemDto, TeamColorDto, TeamStatus } from '@nuzli/shared';
import { useReference } from '../../api/queries';
import { t, tKey } from '../../i18n';

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
            {t('teams.colorsAvailable', { count: colors.length })}
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
