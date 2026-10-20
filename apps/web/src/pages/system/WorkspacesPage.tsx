import { useState } from 'react';
import { Button, Drawer, Group, Modal, SegmentedControl, Stack, Text, TextInput, useDirection } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArchive,
  IconBuildingCommunity,
  IconEdit,
  IconLayoutList,
  IconPlus,
  IconRestore,
  IconTrash,
  IconUserShield,
} from '@tabler/icons-react';
import { z } from 'zod';
import {
  workspaceCodeSchema,
  workspaceNameSchema,
  type WorkspaceAdminDto,
  type WorkspaceMemberDto,
  type WorkspaceRole,
} from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { useWorkspaceAdmins, useWorkspaceSummary, useWorkspacesAdmin } from '../../api/a12Queries';
import { useZodForm } from '../../forms/useZodForm';
import { EmptyState, ErrorBlock, FormError, Ltr, LoadingBlock, PageHeader, roleLabel } from '../../components/ui';
import { useOverlayParam } from '../../lib/useUrlState';
import { useAuthStore } from '../../stores/auth';
import { useDualRoleConfirm } from '../../features/workspaces/DualRole';
import { useRefreshSession } from '../../features/workspaces/useWorkspaceSwitch';
import { AccountPicker, ConfirmDialog, PersonName, StatePill, type AccountChoice } from '../../features/users/components';
import { useInvalidateUserAdmin } from '../../features/users/queries';
import { formatDateTime, t } from '../../i18n';
import '../../features/users/users.css';

type Status = 'ALL' | 'ACTIVE' | 'ARCHIVED';

/** Refresh lists + the session (its workspace list and single-workspace mode change). */
function useAfterChange() {
  const invalidate = useInvalidateUserAdmin();
  const refresh = useRefreshSession();
  return async () => {
    await invalidate();
    try {
      await refresh();
    } catch {
      // The lists are already right; the session catches up on its next refresh.
    }
  };
}

const wsStatusLabel = (s: string) => t(s === 'ARCHIVED' ? 'a12admin.ws.status.ARCHIVED' : 'a12admin.ws.status.ACTIVE');

// ------------------------------------------------------------------ create / rename

function CreateWorkspaceDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const api = useApi();
  const after = useAfterChange();
  const [error, setError] = useState<unknown>(null);
  const initial = { name: '', code: '' };
  const form = useZodForm(
    z.object({ name: workspaceNameSchema, code: z.union([z.literal(''), workspaceCodeSchema]) }),
    initial,
  );
  const close = () => {
    form.reset(initial);
    setError(null);
    onClose();
  };
  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      const ws = await api.workspaces.create({ name: data.name, ...(data.code ? { code: data.code } : {}) });
      await after();
      notifications.show({ color: 'ok', message: t('a12admin.ws.created', { name: ws.name }) });
      close();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WORKSPACE_CODE_TAKEN') {
        form.setErrors({ code: err.message_ar });
        return;
      }
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) form.setErrors(err.fieldErrors);
      setError(err);
    }
  });
  return (
    <Modal opened={opened} onClose={close} title={t('a12admin.ws.createTitle')}>
      <form onSubmit={submit} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t('a12admin.ws.createBody')}
          </Text>
          <FormError error={error} />
          <TextInput label={t('a12admin.ws.name')} withAsterisk data-autofocus data-testid="ws-name-input" {...form.getInputProps('name')} />
          <TextInput
            label={`${t('a12admin.ws.code')} (${t('common.optional')})`}
            description={t('a12admin.ws.codeHint')}
            dir="ltr"
            styles={{ input: { textAlign: 'start' } }}
            autoComplete="off"
            data-testid="ws-code-input"
            {...form.getInputProps('code')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.submitting} leftSection={<IconPlus size={18} />} data-testid="ws-create-submit">
              {t('a12admin.ws.createSubmit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function RenameWorkspaceDialog({ ws, onClose }: { ws: WorkspaceAdminDto; onClose: () => void }) {
  const api = useApi();
  const after = useAfterChange();
  const [error, setError] = useState<unknown>(null);
  const form = useZodForm(z.object({ name: workspaceNameSchema }), { name: ws.name });
  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      await api.workspaces.rename(ws.id, data);
      await after();
      notifications.show({ color: 'ok', message: t('a12admin.ws.renamed', { name: data.name }) });
      onClose();
    } catch (err) {
      setError(err);
    }
  });
  return (
    <Modal opened onClose={onClose} title={t('a12admin.ws.renameTitle', { name: ws.name })}>
      <form onSubmit={submit} noValidate>
        <Stack>
          <FormError error={error} />
          <TextInput label={t('a12admin.ws.name')} withAsterisk data-autofocus {...form.getInputProps('name')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.submitting} data-testid="ws-rename-submit">
              {t('a12admin.ws.renameSubmit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ admins

function AddAdminDialog({ ws, opened, onClose }: { ws: WorkspaceAdminDto; opened: boolean; onClose: () => void }) {
  const api = useApi();
  const after = useAfterChange();
  const dual = useDualRoleConfirm();
  const [choice, setChoice] = useState<AccountChoice>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pickError, setPickError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const close = () => {
    setChoice(null);
    setTitle('');
    setError(null);
    setPickError(undefined);
    onClose();
  };
  const submit = async () => {
    setError(null);
    if (!choice) {
      setPickError(t('a12admin.pick.required'));
      return;
    }
    setBusy(true);
    try {
      const added = await dual.run((confirmDualRole) =>
        api.workspaces.addAdmin(ws.id, {
          ...choice,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(confirmDualRole ? { confirmDualRole: true } : {}),
        }),
      );
      if (!added) return;
      await after();
      notifications.show({ color: 'ok', message: t('a12admin.ws.adminAdded', { name: added.user.fullName, ws: ws.name }) });
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal opened={opened} onClose={close} title={t('a12admin.ws.addAdminTitle', { name: ws.name })} size="lg">
        <Stack>
          <Text size="sm" c="dimmed">
            {t('a12admin.ws.addAdminBody')}
          </Text>
          <FormError error={error} />
          {opened ? (
            <AccountPicker
              canBrowse
              error={pickError}
              onChange={(c) => {
                setChoice(c);
                setPickError(undefined);
              }}
            />
          ) : null}
          <TextInput
            label={`${t('a12admin.position')} (${t('common.optional')})`}
            placeholder={t('a12admin.positionPlaceholder')}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} onClick={() => void submit()} leftSection={<IconUserShield size={18} />} data-testid="ws-admin-add-submit">
              {t('a12admin.ws.addAdminSubmit')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      {dual.dialog}
    </>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="nz-ua-kpi">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

const ROLE_ORDER: WorkspaceRole[] = ['ADMIN', 'ASSISTANT', 'SUPERVISOR', 'MONITOR', 'MEMBER'];

/** The drawer: counts of the workspace (no business rows) and its admins. */
function WorkspaceDetail({ ws, onClose }: { ws: WorkspaceAdminDto | null; onClose: () => void }) {
  const api = useApi();
  const after = useAfterChange();
  const { dir } = useDirection();
  const summary = useWorkspaceSummary(ws?.id ?? null);
  const admins = useWorkspaceAdmins(ws?.id ?? null);
  const me = useAuthStore((s) => s.user);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WorkspaceMemberDto | null>(null);
  const s = summary.data;
  return (
    <Drawer
      opened={Boolean(ws)}
      onClose={onClose}
      title={ws ? t('a12admin.ws.detailTitle', { name: ws.name }) : ''}
      position={dir === 'rtl' ? 'left' : 'right'}
      closeButtonProps={{ 'aria-label': t('common.close') }}
      size="lg"
    >
      {ws ? (
        <Stack gap="lg">
          <Group gap={8}>
            <StatePill status={ws.status} label={wsStatusLabel(ws.status)} />
            <Text size="sm" c="dimmed">
              {t('a12admin.ws.code')}: <Ltr mono>{ws.code}</Ltr>
            </Text>
          </Group>
          <Stack gap="xs">
            <Text fw={600}>{t('a12admin.ws.summary')}</Text>
            {summary.isLoading ? (
              <LoadingBlock variant="dashboard" />
            ) : summary.isError ? (
              <ErrorBlock error={summary.error} onRetry={() => void summary.refetch()} />
            ) : s ? (
              <>
                <div className="nz-ua-kpis" data-testid="ws-summary">
                  <Kpi label={t('a12admin.ws.k.users')} value={s.users.total} />
                  {ROLE_ORDER.map((r) => (
                    <Kpi key={r} label={roleLabel(r)} value={s.users.byRole[r] ?? 0} />
                  ))}
                  <Kpi label={t('a12admin.ws.k.pendingRegistrations')} value={s.users.pendingRegistrations} />
                  <Kpi label={t('a12admin.ws.k.projects')} value={s.projects} />
                  <Kpi label={t('a12admin.ws.k.tasks')} value={s.tasks} />
                  <Kpi label={t('a12admin.ws.k.teams')} value={s.teams} />
                  <Kpi label={t('a12admin.ws.k.members')} value={s.members} />
                  <Kpi label={t('a12admin.ws.k.violations')} value={s.violations} />
                  <Kpi label={t('a12admin.ws.k.pendingMemberRequests')} value={s.pendingMemberRequests} />
                </div>
              </>
            ) : null}
          </Stack>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={600}>{t('a12admin.ws.admins')}</Text>
              <Button
                size="sm"
                variant="light"
                leftSection={<IconUserShield size={16} />}
                onClick={() => setAdding(true)}
                disabled={ws.status === 'ARCHIVED'}
                data-testid="ws-admin-add"
              >
                {t('a12admin.ws.addAdmin')}
              </Button>
            </Group>
            {admins.isLoading ? (
              <LoadingBlock variant="list" rows={2} />
            ) : admins.isError ? (
              <ErrorBlock error={admins.error} onRetry={() => void admins.refetch()} />
            ) : !admins.data?.length ? (
              <EmptyState
                icon={IconUserShield}
                title={t('a12admin.ws.noAdmins')}
                body={t('a12admin.ws.noAdminsBody')}
                action={ws.status === 'ACTIVE' ? { label: t('a12admin.ws.addAdmin'), onClick: () => setAdding(true) } : undefined}
              />
            ) : (
              <div>
                {admins.data.map((a) => (
                  <div key={a.id} className="nz-ua-row" data-testid={`ws-admin-${a.user.username}`}>
                    <PersonName
                      user={{ ...a.user, dualRole: a.dualRole }}
                      self={a.user.id === me?.id}
                      sub={
                        <>
                          <Ltr mono>{a.user.username}</Ltr>
                          {a.title ? ` · ${a.title}` : ''}
                        </>
                      }
                    />
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      color="breach"
                      mih={36}
                      leftSection={<IconTrash size={14} />}
                      onClick={() => setRemoving(a)}
                      data-testid={`ws-admin-remove-${a.user.username}`}
                    >
                      {t('a12admin.ws.removeAdmin')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Stack>
          <AddAdminDialog ws={ws} opened={adding} onClose={() => setAdding(false)} />
          <ConfirmDialog
            opened={Boolean(removing)}
            title={t('a12admin.ws.removeAdminTitle')}
            body={removing ? t('a12admin.ws.removeAdminBody', { name: removing.user.fullName, ws: ws.name }) : ''}
            confirmLabel={t('a12admin.ws.removeAdminConfirm')}
            color="breach"
            testId="ws-admin-remove-confirm"
            onClose={() => setRemoving(null)}
            onConfirm={async () => {
              await api.workspaces.removeAdmin(ws.id, removing!.user.id);
              await after();
              notifications.show({ color: 'ok', message: t('a12admin.ws.adminRemoved', { name: removing!.user.fullName }) });
            }}
          />
        </Stack>
      ) : null}
    </Drawer>
  );
}

// ------------------------------------------------------------------ page

/** «الأقسام» (owners): every workspace, create, rename, archive / restore, summary and admins. */
export function WorkspacesPage() {
  const api = useApi();
  const after = useAfterChange();
  const [status, setStatus] = useState<Status>('ALL');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<WorkspaceAdminDto | null>(null);
  const [archiving, setArchiving] = useState<WorkspaceAdminDto | null>(null);
  const [restoring, setRestoring] = useState<WorkspaceAdminDto | null>(null);
  const detail = useOverlayParam('ws');
  const q = useWorkspacesAdmin(status);
  const allQ = useWorkspacesAdmin('ALL');
  const open = (allQ.data ?? q.data ?? []).find((w) => w.id === detail.value) ?? null;

  return (
    <>
      <PageHeader
        title={t('nav.systemWorkspaces')}
        lead={t('a12admin.ws.lead')}
        actions={
          <Button leftSection={<IconPlus size={18} />} onClick={() => setCreating(true)} data-testid="ws-create">
            {t('a12admin.ws.create')}
          </Button>
        }
      />
      <SegmentedControl
        mb="md"
        value={status}
        onChange={(v) => setStatus(v as Status)}
        data={[
          { value: 'ALL', label: t('common.all') },
          { value: 'ACTIVE', label: t('a12admin.ws.filter.ACTIVE') },
          { value: 'ARCHIVED', label: t('a12admin.ws.filter.ARCHIVED') },
        ]}
        aria-label={t('users.filterStatus')}
      />
      {q.isLoading ? (
        <LoadingBlock variant="cards" rows={3} />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <EmptyState
          icon={IconBuildingCommunity}
          title={status === 'ARCHIVED' ? t('a12admin.ws.emptyArchived') : t('a12admin.ws.empty')}
          body={t('a12admin.ws.emptyBody')}
          action={{ label: t('a12admin.ws.create'), onClick: () => setCreating(true) }}
        />
      ) : (
        <div className="nz-ua-grid">
          {q.data.map((w) => (
            <article key={w.id} className={`nz-ua-card${w.status === 'ARCHIVED' ? ' archived' : ''}`} data-testid={`ws-card-${w.code}`}>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <span className="nz-ua-title">{w.name}</span>
                  <Text size="xs" c="dimmed">
                    <Ltr mono>{w.code}</Ltr>
                  </Text>
                </Stack>
                <StatePill status={w.status} label={wsStatusLabel(w.status)} />
              </Group>
              <div className="nz-ua-meta">
                <span>{t('a12admin.ws.adminCount', { count: w.adminCount })}</span>
                <span>{t('a12admin.ws.memberCount', { count: w.memberCount })}</span>
                <span>{t('a12admin.ws.createdAt', { date: formatDateTime(w.createdAt) })}</span>
              </div>
              <Group gap="xs" wrap="wrap" mt="auto">
                <Button
                  variant="light"
                  leftSection={<IconLayoutList size={16} />}
                  onClick={() => detail.open(w.id)}
                  data-testid={`ws-open-${w.code}`}
                >
                  {t('a12admin.ws.open')}
                </Button>
                <Button variant="default" leftSection={<IconEdit size={16} />} onClick={() => setRenaming(w)} data-testid={`ws-rename-${w.code}`}>
                  {t('a12admin.ws.rename')}
                </Button>
                {w.status === 'ACTIVE' ? (
                  <Button
                    variant="subtle"
                    color="breach"
                    leftSection={<IconArchive size={16} />}
                    onClick={() => setArchiving(w)}
                    data-testid={`ws-archive-${w.code}`}
                  >
                    {t('a12admin.ws.archive')}
                  </Button>
                ) : (
                  <Button
                    variant="subtle"
                    leftSection={<IconRestore size={16} />}
                    onClick={() => setRestoring(w)}
                    data-testid={`ws-restore-${w.code}`}
                  >
                    {t('a12admin.ws.restore')}
                  </Button>
                )}
              </Group>
            </article>
          ))}
        </div>
      )}

      <CreateWorkspaceDialog opened={creating} onClose={() => setCreating(false)} />
      {renaming ? <RenameWorkspaceDialog ws={renaming} onClose={() => setRenaming(null)} /> : null}
      <ConfirmDialog
        opened={Boolean(archiving)}
        title={archiving ? t('a12admin.ws.archiveTitle', { name: archiving.name }) : ''}
        body={
          <Stack gap={6}>
            <Text size="sm">{t('a12admin.ws.archiveBody1')}</Text>
            <Text size="sm">{t('a12admin.ws.archiveBody2')}</Text>
            <Text size="sm">{t('a12admin.ws.archiveBody3')}</Text>
          </Stack>
        }
        confirmLabel={t('a12admin.ws.archiveConfirm')}
        color="breach"
        testId="ws-archive-confirm"
        onClose={() => setArchiving(null)}
        onConfirm={async () => {
          await api.workspaces.archive(archiving!.id);
          await after();
          notifications.show({ color: 'ok', message: t('a12admin.ws.archived', { name: archiving!.name }) });
        }}
      />
      <ConfirmDialog
        opened={Boolean(restoring)}
        title={restoring ? t('a12admin.ws.restoreTitle', { name: restoring.name }) : ''}
        body={t('a12admin.ws.restoreBody')}
        confirmLabel={t('a12admin.ws.restoreConfirm')}
        testId="ws-restore-confirm"
        onClose={() => setRestoring(null)}
        onConfirm={async () => {
          await api.workspaces.restore(restoring!.id);
          await after();
          notifications.show({ color: 'ok', message: t('a12admin.ws.restored', { name: restoring!.name }) });
        }}
      />
      <WorkspaceDetail ws={open} onClose={detail.close} />
    </>
  );
}

