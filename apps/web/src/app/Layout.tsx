import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Box,
  Burger,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconChevronDown,
  IconLogout,
  IconRefresh,
  IconUserCircle,
  IconX,
} from '@tabler/icons-react';
import { can } from '@nuzli/shared';
import { NAV } from './nav';
import { NotificationBell } from './NotificationBell';
import { useSessionActions } from './useSessionActions';
import { useAuthStore } from '../stores/auth';
import { useApi } from '../api/context';
import { useRegistrations } from '../api/queries';
import { IS_DEMO } from '../api';
import { formatNumber, t } from '../i18n';
import { VestBand } from '../theme/VestBand';
import { roleLabel } from '../components/ui';

const HEADER = 60;
const STRIP = 30;

export function initials(name: string) {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p !== 'بن' && p !== 'بنت');
  return parts
    .slice(0, 2)
    .map((p) => p.replace(/^ال/, '')[0] ?? '')
    .join(' ');
}

function Brand() {
  return (
    <VestBand color="#5FB3B8" style={{ borderRadius: 8 }}>
      <Box py={4}>
        <Text className="display" fz="1.375rem" c="var(--sidebar-text)" lh={1.2}>
          {t('app.name')}
        </Text>
        <Text fz="xs" c="var(--sidebar-muted)">
          {t('app.tagline')}
        </Text>
      </Box>
    </VestBand>
  );
}

function NavCount() {
  const user = useAuthStore((s) => s.user);
  const reg = useRegistrations({ pageSize: 1 }, can(user, 'registrations.review'));
  const total = reg.data?.total ?? 0;
  if (!total) return null;
  return (
    <Badge
      className="nz-count"
      color="signal"
      variant="filled"
      size="sm"
      aria-label={String(total)}
    >
      {formatNumber(total)}
    </Badge>
  );
}

export function DemoResetButton({ variant = 'sidebar' }: { variant?: 'sidebar' | 'menu' }) {
  const api = useApi();
  const { resetDemo } = useSessionActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!api.demo) return null;
  return (
    <>
      {variant === 'sidebar' ? (
        <Button
          variant="subtle"
          color="slate"
          leftSection={<IconRefresh size={16} />}
          onClick={() => setOpen(true)}
          styles={{ root: { color: 'var(--sidebar-muted)' } }}
          fullWidth
          justify="flex-start"
        >
          {t('shell.demoReset')}
        </Button>
      ) : null}
      <Modal opened={open} onClose={() => setOpen(false)} title={t('shell.demoResetConfirmTitle')}>
        <Stack>
          <Text>{t('shell.demoResetConfirmBody')}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              color="breach"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await resetDemo();
                } finally {
                  setBusy(false);
                  setOpen(false);
                }
              }}
            >
              {t('shell.demoReset')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const { logout } = useSessionActions();
  if (!user) return null;
  return (
    <Menu position="bottom-end" width={240} shadow="md">
      <Menu.Target>
        <UnstyledButton
          aria-label={t('shell.userMenu')}
          style={{ minHeight: 44, borderRadius: 8 }}
          px={6}
        >
          <Group gap={8} wrap="nowrap">
            <Avatar color="field" radius="xl" size={34}>
              {initials(user.fullName)}
            </Avatar>
            <Box visibleFrom="sm" style={{ minWidth: 0 }}>
              <Text size="sm" fw={600} lh={1.3} truncate maw={180}>
                {user.fullName}
              </Text>
              <Text size="xs" c="dimmed" lh={1.3}>
                {roleLabel(user.role)}
              </Text>
            </Box>
            <IconChevronDown size={16} color="var(--muted)" />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{user.fullName}</Menu.Label>
        <Menu.Item component={NavLink} to="/profile" leftSection={<IconUserCircle size={18} />}>
          {t('nav.profile')}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          color="breach"
          leftSection={<IconLogout size={18} className="mirror-rtl" />}
          onClick={() => void logout()}
        >
          {t('shell.logout')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export function Layout() {
  const user = useAuthStore((s) => s.user);
  const [opened, setOpened] = useState(false);
  const location = useLocation();

  useEffect(() => setOpened(false), [location.pathname]);

  const items = NAV.filter((item) => !item.permission || can(user, item.permission));
  const headerHeight = HEADER + (IS_DEMO ? STRIP : 0);

  return (
    <AppShell
      layout="alt"
      header={{ height: headerHeight }}
      navbar={{ width: 248, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <a href="#main" className="sr-only-focusable">
        {t('app.skipToContent')}
      </a>
      <AppShell.Header style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
        {IS_DEMO ? (
          <div className="demo-strip" role="note" style={{ height: STRIP }}>
            {t('shell.demoStrip')}
          </div>
        ) : null}
        <Group h={HEADER} px="md" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={() => setOpened((o) => !o)}
              hiddenFrom="sm"
              size="sm"
              aria-label={opened ? t('common.closeMenu') : t('common.openMenu')}
            />
            <Text className="display" hiddenFrom="sm" fz="lg">
              {t('app.name')}
            </Text>
          </Group>
          <Group gap={4} wrap="nowrap">
            <NotificationBell />
            <UserMenu />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar className="nz-sidebar" p="md" aria-label={t('nav.main')}>
        <Group justify="space-between" wrap="nowrap" mb="lg">
          <Brand />
          <ActionIcon
            hiddenFrom="sm"
            variant="subtle"
            color="gray"
            size={44}
            onClick={() => setOpened(false)}
            aria-label={t('common.closeMenu')}
            style={{ color: 'var(--sidebar-text)' }}
          >
            <IconX size={20} />
          </ActionIcon>
        </Group>
        <AppShell.Section grow component="nav">
          <Stack gap={4}>
            {items.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className="nz-nav-link">
                <item.icon size={20} stroke={1.7} aria-hidden />
                <span>{t(item.label)}</span>
                {item.badge === 'registrations' ? <NavCount /> : null}
              </NavLink>
            ))}
          </Stack>
        </AppShell.Section>
        {IS_DEMO ? (
          <AppShell.Section>
            <DemoResetButton />
          </AppShell.Section>
        ) : null}
      </AppShell.Navbar>

      <AppShell.Main id="main" style={{ background: 'var(--ground)' }}>
        <Box maw={1200} mx="auto" pb="xl">
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
