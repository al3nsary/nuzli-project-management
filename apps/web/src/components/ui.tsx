import type { ReactNode } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, type Icon } from '@tabler/icons-react';
import type { Role, UserStatus } from '@nuzli/shared';
import { formatSaudiMobileLocal } from '@nuzli/shared';
import { t, tKey } from '../i18n';
import { errorMessage } from '../api/errors';

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
        <Title order={1}>{title}</Title>
        {lead ? (
          <Text c="dimmed" mt={4}>
            {lead}
          </Text>
        ) : null}
      </Box>
      {actions ? <Group gap="sm">{actions}</Group> : null}
    </Group>
  );
}

/** Empty states give exactly one action (design skill). */
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
    <Center py={48} px="md" className="surface-card">
      <Stack align="center" gap="xs" maw={420} ta="center">
        <IconCmp size={40} stroke={1.5} color="var(--muted)" aria-hidden />
        <Title order={3}>{title}</Title>
        {body ? <Text c="dimmed">{body}</Text> : null}
        {action ? (
          <Button variant="light" mt="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
      </Stack>
    </Center>
  );
}

export function FullPageLoader() {
  return (
    <Center h="100dvh" bg="var(--ground)">
      <Stack align="center" gap="sm">
        <Loader color="field" />
        <Text c="dimmed">{t('app.loading')}</Text>
      </Stack>
    </Center>
  );
}

export function LoadingBlock() {
  return (
    <Center py={48}>
      <Loader color="field" />
    </Center>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert color="breach" icon={<IconAlertTriangle size={18} />} title={t('common.loadError')}>
      <Stack gap="xs" align="flex-start">
        <Text size="sm">{errorMessage(error)}</Text>
        {onRetry ? (
          <Button size="xs" variant="light" color="breach" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : null}
      </Stack>
    </Alert>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert color="breach" icon={<IconAlertTriangle size={18} />} role="alert">
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
