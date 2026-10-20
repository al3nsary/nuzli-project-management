import { useState, type ReactNode } from 'react';
import { Button, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCrown } from '@tabler/icons-react';
import type { UserDto, UserRoleEntryDto, UserStatus, WorkspaceRole } from '@nuzli/shared';
import { FormError, roleLabel } from '../../components/ui';
import { UserPhotoAvatar } from '../../components/UserAvatar';
import { DualRoleBadge, roleEntryText } from '../workspaces/DualRole';
import { useAllUsers } from '../../api/a12Queries';
import { t, tKey } from '../../i18n';
import './users.css';

const STATUS_PILL: Record<string, string> = {
  ACTIVE: 'live',
  PENDING: 'wait',
  SUSPENDED: 'grey',
  REJECTED: 'no',
  ARCHIVED: 'grey',
};

/** An account / membership / workspace state as a pill (colour = state). */
export function StatePill({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`pill ${STATUS_PILL[status] ?? 'grey'}`}>
      {label ?? tKey(`status.${status}`, 'common.none')}
    </span>
  );
}

/** «مالك النظام» marker: a crown with text (never colour alone). */
export function OwnerPill() {
  return (
    <span className="pill brand" data-testid="owner-pill">
      <IconCrown size={13} aria-hidden />
      {t('accountRole.OWNER')}
    </span>
  );
}

/** The person: photo, name, «صلاحية مزدوجة» — a button when `onOpen` is given. */
export function PersonName({
  user,
  onOpen,
  self,
  sub,
}: {
  user: { id: string; fullName: string; hasPhoto?: boolean; photoFileId?: string | null; dualRole?: boolean; allRoles?: UserRoleEntryDto[] };
  onOpen?: () => void;
  self?: boolean;
  sub?: ReactNode;
}) {
  const body = (
    <>
      <UserPhotoAvatar user={user} self={self} size={30} />
      <span>
        {user.fullName}
        {self ? (
          <Text span size="xs" c="dimmed" fw={400}>
            {' '}
            ({t('users.you')})
          </Text>
        ) : null}
        {sub ? (
          <Text component="span" display="block" size="xs" c="dimmed" fw={400}>
            {sub}
          </Text>
        ) : null}
      </span>
    </>
  );
  return (
    <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
      {onOpen ? (
        <UnstyledButton className="nz-ua-person" onClick={onOpen}>
          {body}
        </UnstyledButton>
      ) : (
        <span className="nz-ua-person" style={{ color: 'var(--ink)' }}>
          {body}
        </span>
      )}
      <DualRoleBadge user={user} />
    </Group>
  );
}

/** Roles of a person in the active workspace (owners marked). */
export function WorkspaceRolePills({ user }: { user: Pick<UserDto, 'role' | 'accountRole' | 'workspaceRoles'> }) {
  const roles: WorkspaceRole[] = user.workspaceRoles ?? (user.role ? [user.role] : []);
  return (
    <span className="nz-ua-roles">
      {user.accountRole === 'OWNER' ? <OwnerPill /> : null}
      {roles.map((r) => (
        <span key={r} className="pill grey">
          {roleLabel(r)}
        </span>
      ))}
      {!roles.length && user.accountRole !== 'OWNER' ? <span className="pill grey">{t('a12admin.noRoleHere')}</span> : null}
    </span>
  );
}

/** Every role with its workspace (owners see where; others «صفة في قسم آخر»). */
export function AllRolesList({ roles }: { roles: UserRoleEntryDto[] | undefined }) {
  if (!roles?.length) return <Text size="sm" c="dimmed">{t('a12admin.noRoles')}</Text>;
  return (
    <span className="nz-ua-roles">
      {roles.map((r, i) => (
        <span key={`${r.workspaceId ?? 'x'}-${r.role}-${i}`} className={`pill ${r.status === 'ACTIVE' ? 'grey' : 'wait'}`}>
          {roleEntryText(r)}
          {r.status !== 'ACTIVE' ? ` · ${tKey(`status.${r.status}`, 'common.none')}` : ''}
        </span>
      ))}
    </span>
  );
}

/**
 * A confirmation with a verb on the button. `onConfirm` may throw: the Arabic error is shown
 * in place (LAST_ADMIN, LAST_OWNER, LAST_WORKSPACE…) and the dialog stays open.
 */
export function ConfirmDialog({
  opened,
  title,
  body,
  confirmLabel,
  color = 'field',
  onConfirm,
  onClose,
  testId,
  children,
}: {
  opened: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  color?: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  testId?: string;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const close = () => {
    setError(null);
    onClose();
  };
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={close} title={title} centered>
      <Stack gap="sm">
        {typeof body === 'string' ? <Text size="sm">{body}</Text> : body}
        {children}
        <FormError error={error} />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button color={color} loading={busy} onClick={() => void go()} data-testid={testId}>
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export type AccountChoice = { userId: string } | { identifier: string } | null;

/**
 * Picks an EXISTING account: by identifier (username / e-mail / mobile / national ID — everyone)
 * or, for owners, from the list of all accounts (searchable).
 */
export function AccountPicker({
  canBrowse,
  onChange,
  error,
}: {
  canBrowse: boolean;
  onChange: (choice: AccountChoice) => void;
  error?: string;
}) {
  const [mode, setMode] = useState<'identifier' | 'browse'>('identifier');
  const [identifier, setIdentifier] = useState('');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 250);
  const [picked, setPicked] = useState<string | null>(null);
  const all = useAllUsers({ q: q || undefined, pageSize: 20, status: 'ACTIVE' }, canBrowse && mode === 'browse');
  const data = (all.data?.items ?? []).map((u) => ({
    value: u.id,
    label: u.username ? `${u.fullName} — ${u.username}` : u.fullName,
  }));
  return (
    <Stack gap="xs">
      {canBrowse ? (
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(v) => {
            setMode(v as 'identifier' | 'browse');
            onChange(v === 'browse' ? (picked ? { userId: picked } : null) : identifier.trim() ? { identifier: identifier.trim() } : null);
          }}
          data={[
            { value: 'identifier', label: t('a12admin.pick.byIdentifier') },
            { value: 'browse', label: t('a12admin.pick.fromList') },
          ]}
        />
      ) : null}
      {mode === 'identifier' ? (
        <TextInput
          label={t('a12admin.pick.identifier')}
          description={t('a12admin.pick.identifierHint')}
          dir="ltr"
          styles={{ input: { textAlign: 'start' } }}
          value={identifier}
          withAsterisk
          error={error}
          data-autofocus
          data-testid="account-identifier"
          onChange={(e) => {
            const v = e.currentTarget.value;
            setIdentifier(v);
            onChange(v.trim() ? { identifier: v.trim() } : null);
          }}
        />
      ) : (
        <Select
          label={t('a12admin.pick.account')}
          placeholder={t('a12admin.pick.accountPlaceholder')}
          searchable
          data={data}
          value={picked}
          searchValue={search}
          onSearchChange={setSearch}
          filter={({ options }) => options}
          nothingFoundMessage={all.isFetching ? t('app.loading') : t('a12admin.pick.nothing')}
          withAsterisk
          error={error}
          comboboxProps={{ withinPortal: true }}
          onChange={(v) => {
            setPicked(v);
            onChange(v ? { userId: v } : null);
          }}
        />
      )}
    </Stack>
  );
}

/** Statuses for filters. */
export const ACCOUNT_STATUSES: UserStatus[] = ['ACTIVE', 'PENDING', 'SUSPENDED', 'REJECTED'];
