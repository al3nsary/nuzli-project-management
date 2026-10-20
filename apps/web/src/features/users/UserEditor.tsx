import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, Drawer, Group, Stack, Text, useDirection } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAt,
  IconEdit,
  IconInfoCircle,
  IconKey,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  IconUserX,
} from '@tabler/icons-react';
import { ASSISTANT_LEVEL_LABELS, ASSISTANT_MODULE_LABELS, can, type UserDto, type WorkspaceMemberDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useUser } from '../../api/queries';
import { useWorkspaceMembers } from '../../api/a12Queries';
import { ErrorBlock, Ltr, LoadingBlock, Mobile, roleLabel } from '../../components/ui';
import { PhotoUploader } from '../../components/photos/PhotoUploader';
import { useAuthStore } from '../../stores/auth';
import { DualRoleBadge } from '../workspaces/DualRole';
import { formatDateTime, t } from '../../i18n';
import { AllRolesList, ConfirmDialog, OwnerPill, StatePill } from './components';
import {
  AddMembershipDialog,
  EditAccountDialog,
  EditMembershipDialog,
  SetPasswordDialog,
  SuspendAccountDialog,
  UsernameDialog,
} from './dialogs';
import { useInvalidateUserAdmin } from './queries';
import './users.css';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="nz-ua-row">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" ta="end" style={{ overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </div>
  );
}

/** What the caller may do to this account (the API decides; this only hides what would be refused). */
export function accountRights(me: ReturnType<typeof useAuthStore.getState>['user'], target: UserDto, activeId: string | null) {
  const isOwner = me?.accountRole === 'OWNER';
  const self = me?.id === target.id;
  // An admin edits only people who belong to no other workspace and are not owners.
  const elsewhere = (target.allRoles ?? []).some((r) => r.workspaceId === null || (activeId !== null && r.workspaceId !== activeId));
  const ownerTarget = target.accountRole === 'OWNER';
  const editable = isOwner || (!ownerTarget && !elsewhere);
  return {
    isOwner,
    self,
    elsewhere: !isOwner && elsewhere,
    ownerTarget,
    edit: can(me, 'users.edit') && editable,
    roles: can(me, 'users.manageRoles') && (isOwner || !ownerTarget),
    suspend: can(me, 'users.suspend') && !self && (isOwner || !ownerTarget),
  };
}

type Dialog = 'edit' | 'username' | 'password' | 'suspend' | 'addRole' | null;

/** The memberships of one person in one workspace, with edit / remove (owners: any workspace). */
function WorkspaceMemberships({
  user,
  workspaceId,
  workspaceName,
  canManage,
}: {
  user: UserDto;
  workspaceId: string;
  workspaceName: string | null;
  canManage: boolean;
}) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const q = useWorkspaceMembers(workspaceId);
  const [editing, setEditing] = useState<WorkspaceMemberDto | null>(null);
  const [removing, setRemoving] = useState<WorkspaceMemberDto | null>(null);
  const [adding, setAdding] = useState(false);
  const mine = (q.data ?? []).filter((m) => m.user.id === user.id);

  return (
    <Stack gap="xs" data-testid={`memberships-${workspaceId}`}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={600}>
          {workspaceName ? t('a12admin.memberships.in', { name: workspaceName }) : t('a12admin.memberships.here')}
        </Text>
        {canManage ? (
          <Button size="compact-sm" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} mih={36}>
            {t('a12admin.member.addRole')}
          </Button>
        ) : null}
      </Group>
      {q.isLoading ? (
        <LoadingBlock variant="list" rows={1} />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !mine.length ? (
        <Text size="sm" c="dimmed">
          {t('a12admin.memberships.none')}
        </Text>
      ) : (
        mine.map((m) => {
          const modules = Object.entries(m.permissions ?? {}).filter(([, l]) => l && l !== 'none');
          return (
            <div key={m.id} className="nz-ua-membership">
              <Group justify="space-between" wrap="wrap" gap={6}>
                <Group gap={6} wrap="wrap">
                  <span className="pill grey">{roleLabel(m.role)}</span>
                  {m.title ? <Text size="sm">{m.title}</Text> : null}
                  {m.status !== 'ACTIVE' ? <StatePill status={m.status} /> : null}
                </Group>
                {canManage ? (
                  <Group gap={4}>
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      leftSection={<IconEdit size={14} />}
                      onClick={() => setEditing(m)}
                      mih={36}
                      data-testid={`membership-edit-${m.role}`}
                    >
                      {m.role === 'ASSISTANT' ? t('a12admin.membership.editAssistant') : t('a12admin.membership.edit')}
                    </Button>
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      color="breach"
                      leftSection={<IconTrash size={14} />}
                      onClick={() => setRemoving(m)}
                      mih={36}
                      data-testid={`membership-remove-${m.role}`}
                    >
                      {t('a12admin.membership.remove')}
                    </Button>
                  </Group>
                ) : m.role === 'ASSISTANT' ? (
                  <Button size="compact-sm" variant="subtle" onClick={() => setEditing(m)} mih={36}>
                    {t('a12admin.membership.view')}
                  </Button>
                ) : null}
              </Group>
              {m.role === 'ASSISTANT' ? (
                <Text size="xs" c="dimmed">
                  {modules.length
                    ? modules
                        .map(([mod, level]) => `${ASSISTANT_MODULE_LABELS[mod as keyof typeof ASSISTANT_MODULE_LABELS]}: ${ASSISTANT_LEVEL_LABELS[level as keyof typeof ASSISTANT_LEVEL_LABELS]}`)
                        .join('، ')
                    : t('a12admin.preview.nothing')}
                </Text>
              ) : null}
            </div>
          );
        })
      )}
      {editing ? <EditMembershipDialog membership={editing} onClose={() => setEditing(null)} readOnly={!canManage} /> : null}
      <ConfirmDialog
        opened={Boolean(removing)}
        title={t('a12admin.membership.removeTitle', { name: user.fullName })}
        body={removing ? t('a12admin.membership.removeBody', { role: roleLabel(removing.role) }) : ''}
        confirmLabel={t('a12admin.membership.removeConfirm')}
        color="breach"
        testId="membership-remove-confirm"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          await api.workspaces.removeMember(workspaceId, removing!.id);
          await invalidate();
          notifications.show({ color: 'ok', message: t('a12admin.membership.removed', { name: user.fullName }) });
        }}
      />
      <AddMembershipDialog opened={adding} onClose={() => setAdding(false)} workspaceId={workspaceId} user={user} />
    </Stack>
  );
}

/** The account itself: data, actions, every role, and the memberships to manage. */
export function UserEditorBody({ user }: { user: UserDto }) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const me = useAuthStore((s) => s.user);
  const active = useAuthStore((s) => s.activeWorkspace);
  const rights = accountRights(me, user, active?.id ?? null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  // Owners manage every workspace the person belongs to; others their session's workspace.
  const workspaceIds = rights.isOwner
    ? [
        ...new Map(
          [
            ...(active ? [[active.id, active.name] as const] : []),
            ...(user.allRoles ?? []).filter((r) => r.workspaceId).map((r) => [r.workspaceId!, r.workspaceName] as const),
          ].map(([id, name]) => [id, name]),
        ),
      ]
    : active
      ? [[active.id, null] as const]
      : [];

  const reactivate = async (scope: 'workspace' | 'global') => {
    setBusy(true);
    try {
      await api.users.reactivate(user.id, { scope });
      await invalidate();
      notifications.show({ color: 'ok', message: t('users.reactivated', { name: user.fullName }) });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md">
      <Group gap="md" wrap="nowrap" align="flex-start">
        <PhotoUploader
          target={user.id === me?.id ? { kind: 'me', id: user.id } : { kind: 'user', id: user.id }}
          name={user.fullName}
          hasPhoto={Boolean(user.hasPhoto ?? user.photoFileId)}
          fileId={user.photoFileId}
          canEdit={can(me, 'users.manageRoles') || user.id === me?.id}
          size={64}
        />
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Text fw={600} fz="lg" style={{ overflowWrap: 'anywhere' }}>
            {user.fullName}
          </Text>
          {user.username ? (
            <Text size="sm" c="dimmed">
              <Ltr mono>{user.username}</Ltr>
            </Text>
          ) : null}
          <Group gap={6}>
            {rights.ownerTarget ? <OwnerPill /> : null}
            <StatePill status={user.status} />
            <DualRoleBadge user={user} />
          </Group>
        </Stack>
      </Group>

      {rights.elsewhere ? (
        <Alert color="blue" icon={<IconInfoCircle size={18} />} data-testid="user-elsewhere">
          {t('a12admin.elsewhere')}
        </Alert>
      ) : null}

      {rights.edit || rights.suspend ? (
        <Group gap="xs" wrap="wrap">
          {rights.edit ? (
            <>
              <Button variant="default" leftSection={<IconEdit size={16} />} onClick={() => setDialog('edit')} data-testid="user-edit">
                {t('a12admin.edit.open')}
              </Button>
              <Button variant="default" leftSection={<IconAt size={16} />} onClick={() => setDialog('username')} data-testid="user-change-username">
                {t('a12admin.username.open')}
              </Button>
              <Button variant="default" leftSection={<IconKey size={16} />} onClick={() => setDialog('password')} data-testid="user-set-password">
                {t('a12admin.password.open')}
              </Button>
            </>
          ) : null}
          {rights.suspend && user.status === 'ACTIVE' ? (
            <Button variant="light" color="breach" leftSection={<IconUserX size={16} />} onClick={() => setDialog('suspend')} data-testid="user-suspend">
              {t('users.suspend')}
            </Button>
          ) : null}
          {rights.suspend && user.status === 'SUSPENDED' ? (
            <>
              <Button
                variant="light"
                loading={busy}
                leftSection={<IconPlayerPlay size={16} className="mirror-rtl" />}
                onClick={() => void reactivate('workspace')}
                data-testid="user-reactivate"
              >
                {rights.isOwner ? t('a12admin.reactivate.workspace') : t('users.reactivate')}
              </Button>
              {rights.isOwner ? (
                <Button variant="light" loading={busy} onClick={() => void reactivate('global')} data-testid="user-reactivate-global">
                  {t('a12admin.reactivate.global')}
                </Button>
              ) : null}
            </>
          ) : null}
        </Group>
      ) : null}

      <Box>
        <Row label={t('a12admin.username')}>{user.username ? <Ltr mono>{user.username}</Ltr> : t('common.none')}</Row>
        <Row label={t('register.email')}>
          <Ltr>{user.email}</Ltr>
        </Row>
        <Row label={t('register.mobile')}>
          <Mobile value={user.mobile} />
        </Row>
        <Row label={t('register.nationalId')}>
          <Ltr mono>{user.nationalId ?? user.nationalIdMasked}</Ltr>
        </Row>
        <Row label={t('a12admin.accountRole')}>{t(user.accountRole === 'OWNER' ? 'accountRole.OWNER' : 'accountRole.USER')}</Row>
        <Row label={t('users.createdAt')}>{formatDateTime(user.createdAt)}</Row>
        <Row label={t('users.col.lastLogin')}>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : t('users.neverLoggedIn')}</Row>
        {user.mustChangePassword ? <Row label={t('a12admin.mustChangeShort')}>{t('common.yes')}</Row> : null}
      </Box>

      <Stack gap={6}>
        <Text size="sm" fw={600}>
          {t('a12admin.allRoles')}
        </Text>
        <AllRolesList roles={user.allRoles} />
      </Stack>

      {workspaceIds.map(([wid, name]) => (
        <WorkspaceMemberships
          key={wid}
          user={user}
          workspaceId={wid}
          workspaceName={rights.isOwner ? name : null}
          canManage={rights.roles}
        />
      ))}

      {dialog === 'edit' ? <EditAccountDialog user={user} onClose={() => setDialog(null)} /> : null}
      {dialog === 'username' ? <UsernameDialog user={user} onClose={() => setDialog(null)} /> : null}
      {dialog === 'password' ? <SetPasswordDialog user={user} onClose={() => setDialog(null)} /> : null}
      {dialog === 'suspend' ? <SuspendAccountDialog user={user} onClose={() => setDialog(null)} /> : null}
    </Stack>
  );
}

/** The user drawer (deep-linkable through the caller's `?user=` / `?account=` param). */
export function UserEditor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useUser(id);
  const { dir } = useDirection();
  return (
    <Drawer
      opened={Boolean(id)}
      onClose={onClose}
      title={t('users.detailTitle')}
      position={dir === 'rtl' ? 'left' : 'right'}
      closeButtonProps={{ 'aria-label': t('common.close') }}
      size="lg"
    >
      {q.isLoading ? (
        <LoadingBlock variant="detail" rows={3} />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data ? (
        <UserEditorBody user={q.data} />
      ) : null}
    </Drawer>
  );
}
