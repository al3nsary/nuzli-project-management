import type { CSSProperties, ReactNode } from 'react';
import { Alert, Badge, Box, Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, type Icon } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Role, UserStatus } from '@nuzli/shared';
import { formatSaudiMobileLocal } from '@nuzli/shared';
import { t, tKey } from '../i18n';
import { errorMessage } from '../api/errors';
import { NozolyLogo } from './Brand';

/** The page heading: the h1 that receives focus after navigation (rule 6). */
export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string;
  lead?: string;
  actions?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-end" wrap="wrap" gap="md" mb="lg">
      <Box style={{ minWidth: 0, flex: '1 1 260px' }}>
        <Title order={1} tabIndex={-1}>
          {title}
        </Title>
        {lead ? (
          <Text c="dimmed" mt={4} size="sm">
            {lead}
          </Text>
        ) : null}
      </Box>
      {actions ? <Group gap="sm">{actions}</Group> : null}
    </Group>
  );
}

/** Empty states give exactly one action (design skill, rule 9). */
export function EmptyState({
  icon: IconCmp,
  title,
  body,
  action,
}: {
  icon: Icon;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="nz-empty" role="status">
      <div className="nz-empty-ic" aria-hidden>
        <IconCmp size={26} stroke={1.6} />
      </div>
      <h3 className="nz-empty-title">{title}</h3>
      {body ? <p className="nz-empty-body">{body}</p> : null}
      {action ? (
        <Button variant="light" mt="md" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/** Before the session is known: the Nozoly logo breathing on the page, no spinner-only page. */
export function FullPageLoader() {
  return (
    <div className="nz-boot" role="status" aria-live="polite">
      <span className="nz-boot-mark" aria-hidden>
        <NozolyLogo width={132} decorative />
      </span>
      <span className="nz-boot-text">{t('app.loading')}</span>
    </div>
  );
}

// ------------------------------------------------------------------ skeletons (rule 9)

function Bar({ w = '100%', h = 12, r, style }: { w?: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <span className="nz-skel" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

export type SkeletonVariant = 'list' | 'table' | 'cards' | 'board' | 'detail' | 'form' | 'gantt' | 'dashboard' | 'tasks';

function HeaderSkel() {
  return (
    <Stack gap={8} mb="lg">
      <Bar w={220} h={26} r={8} />
      <Bar w={320} h={12} />
    </Stack>
  );
}

/**
 * A loading placeholder shaped like the page that is coming (rule 9: no spinner-only pages).
 * `header` adds the page-title placeholder for whole-page loads.
 */
export function LoadingBlock({ variant = 'list', rows = 6, header = false }: { variant?: SkeletonVariant; rows?: number; header?: boolean }) {
  const body = (() => {
    switch (variant) {
      case 'table':
        return (
          <div className="nz-skel-card">
            <Group gap="md" mb="md" wrap="nowrap">
              {[30, 18, 16, 14, 12].map((w, i) => (
                <Bar key={i} w={`${w}%`} h={10} />
              ))}
            </Group>
            <Stack gap={14}>
              {Array.from({ length: rows }, (_, i) => (
                <Group key={i} gap="md" wrap="nowrap">
                  <Bar w={34} h={34} r={99} />
                  <Bar w="32%" h={12} />
                  <Bar w="18%" h={12} />
                  <Bar w="14%" h={12} />
                  <Bar w={64} h={20} r={99} />
                </Group>
              ))}
            </Stack>
          </div>
        );
      case 'cards':
        return (
          <div className="nz-skel-grid">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="nz-skel-card">
                <Group gap="sm" mb="md" wrap="nowrap">
                  <Bar w={6} h={44} r={3} />
                  <Stack gap={8} style={{ flex: 1 }}>
                    <Bar w="60%" h={14} />
                    <Bar w="40%" h={10} />
                  </Stack>
                </Group>
                <Bar w="100%" h={8} r={99} />
                <Group gap="xs" mt="md">
                  <Bar w={70} h={20} r={99} />
                  <Bar w={50} h={20} r={99} />
                </Group>
              </div>
            ))}
          </div>
        );
      case 'board':
        return (
          <div className="nz-skel-board">
            {Array.from({ length: 4 }, (_, c) => (
              <div key={c} className="nz-skel-card nz-skel-col">
                <Bar w="55%" h={14} style={{ marginBottom: 14 }} />
                {Array.from({ length: 5 - (c % 2) }, (_, i) => (
                  <Bar key={i} w="100%" h={46} r={10} style={{ marginBottom: 8 }} />
                ))}
              </div>
            ))}
          </div>
        );
      case 'gantt':
        return (
          <div className="nz-skel-card">
            <Group gap="sm" mb="md">
              <Bar w={90} h={30} r={10} />
              <Bar w={90} h={30} r={10} />
              <Bar w={90} h={30} r={10} />
            </Group>
            <Stack gap={12}>
              {Array.from({ length: rows + 4 }, (_, i) => (
                <Group key={i} gap="md" wrap="nowrap">
                  <Bar w="22%" h={12} />
                  <span style={{ flex: 1, display: 'flex' }}>
                    <Bar w={`${18 + ((i * 13) % 40)}%`} h={16} r={6} style={{ marginInlineStart: `${(i * 7) % 45}%` }} />
                  </span>
                </Group>
              ))}
            </Stack>
          </div>
        );
      case 'detail':
        return (
          <Stack gap="md">
            <div className="nz-skel-card">
              <Group gap="md" wrap="nowrap">
                <Bar w={8} h={56} r={4} />
                <Stack gap={10} style={{ flex: 1 }}>
                  <Bar w="40%" h={20} />
                  <Bar w="60%" h={12} />
                </Stack>
              </Group>
            </div>
            <div className="nz-skel-card">
              <Stack gap={14}>
                {Array.from({ length: rows }, (_, i) => (
                  <Group key={i} gap="md" wrap="nowrap">
                    <Bar w={34} h={34} r={99} />
                    <Bar w="40%" h={12} />
                    <Bar w="20%" h={12} />
                  </Group>
                ))}
              </Stack>
            </div>
          </Stack>
        );
      case 'form':
        return (
          <div className="nz-skel-card">
            <Stack gap={18}>
              {Array.from({ length: Math.min(rows, 6) }, (_, i) => (
                <Stack key={i} gap={8}>
                  <Bar w={120} h={10} />
                  <Bar w="100%" h={40} r={12} />
                </Stack>
              ))}
              <Bar w={140} h={42} r={12} />
            </Stack>
          </div>
        );
      case 'dashboard':
        return (
          <Stack gap="md">
            <div className="nz-skel-grid nz-skel-grid--kpi">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="nz-skel-card">
                  <Bar w="50%" h={10} />
                  <Bar w="40%" h={30} r={8} style={{ marginTop: 14 }} />
                </div>
              ))}
            </div>
            <div className="nz-skel-grid">
              {Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="nz-skel-card">
                  <Bar w="35%" h={14} style={{ marginBottom: 16 }} />
                  <Bar w="100%" h={180} r={12} />
                </div>
              ))}
            </div>
          </Stack>
        );
      case 'tasks':
        return (
          <Stack gap="sm">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="nz-skel-card">
                <Bar w="55%" h={14} />
                <Bar w="35%" h={10} style={{ marginTop: 10 }} />
                <Bar w="100%" h={10} r={99} style={{ marginTop: 16 }} />
              </div>
            ))}
          </Stack>
        );
      default:
        return (
          <Stack gap="sm">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="nz-skel-card">
                <Group gap="md" wrap="nowrap">
                  <Bar w={40} h={40} r={12} />
                  <Stack gap={8} style={{ flex: 1 }}>
                    <Bar w="45%" h={13} />
                    <Bar w="70%" h={10} />
                  </Stack>
                  <Bar w={64} h={22} r={99} />
                </Group>
              </div>
            ))}
          </Stack>
        );
    }
  })();
  return (
    <div className="nz-skel-wrap" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{t('app.loading')}</span>
      {header ? <HeaderSkel /> : null}
      {body}
    </div>
  );
}

/** Says what happened and offers «أعد المحاولة» (rule 9). Without `onRetry`, failed queries refetch. */
export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const qc = useQueryClient();
  const retry = onRetry ?? (() => void qc.refetchQueries({ predicate: (q) => q.state.status === 'error' }));
  return (
    <Alert color="breach" icon={<IconAlertTriangle size={18} />} title={t('common.loadError')} radius="lg" role="alert">
      <Stack gap="xs" align="flex-start">
        <Text size="sm">{errorMessage(error)}</Text>
        <Button size="xs" variant="light" color="breach" leftSection={<IconRefresh size={14} />} onClick={retry}>
          {t('common.retry')}
        </Button>
      </Stack>
    </Alert>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert color="breach" icon={<IconAlertTriangle size={18} />} role="alert" radius="md">
      {errorMessage(error)}
    </Alert>
  );
}

const STATUS_COLOR: Record<UserStatus, string> = {
  PENDING: 'signal',
  ACTIVE: 'ok',
  REJECTED: 'breach',
  SUSPENDED: 'slate',
};

export function StatusBadge({ status }: { status: UserStatus }) {
  return (
    <Badge color={STATUS_COLOR[status]} variant="light">
      {tKey(`status.${status}`, 'common.none')}
    </Badge>
  );
}

/** Roles are not a state, so they stay neutral (colour is for state and team identity). */
export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge color="slate" variant="outline">
      {tKey(`role.${role}`, 'common.none')}
    </Badge>
  );
}

export const roleLabel = (role: string | null | undefined) =>
  role ? tKey(`role.${role}`, 'common.none') : t('common.none');

/** Left-to-right data (emails, phone numbers, IDs) inside RTL text. */
export function Ltr({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <span className={mono ? 'ltr mono' : 'ltr'}>{children}</span>;
}

export function Mobile({ value }: { value: string }) {
  return <Ltr mono>{formatSaudiMobileLocal(value)}</Ltr>;
}
