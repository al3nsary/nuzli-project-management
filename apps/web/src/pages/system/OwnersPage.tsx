import { useState } from 'react';
import { Button, Card, Checkbox, Group, Modal, PasswordInput, SegmentedControl, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCrown, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { z } from 'zod';
import {
  email as emailSchema,
  fullName as fullNameSchema,
  nationalId as nationalIdSchema,
  password as passwordSchema,
  saudiMobile,
  usernameSchema,
  type OwnerDto,
} from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { useOwners } from '../../api/a12Queries';
import { useZodForm } from '../../forms/useZodForm';
import { EmptyState, ErrorBlock, FormError, Ltr, LoadingBlock, PageHeader } from '../../components/ui';
import { PasswordStrength } from '../../components/PasswordStrength';
import { useOverlayParam } from '../../lib/useUrlState';
import { useAuthStore } from '../../stores/auth';
import { AccountPicker, ConfirmDialog, PersonName, StatePill, type AccountChoice } from '../../features/users/components';
import { UserEditor } from '../../features/users/UserEditor';
import { useInvalidateUserAdmin } from '../../features/users/queries';
import { useRefreshSession } from '../../features/workspaces/useWorkspaceSwitch';
import { formatDateTime, t } from '../../i18n';
import '../../features/users/users.css';

const ltr = { dir: 'ltr' as const, styles: { input: { textAlign: 'start' as const } } };

const newOwnerSchema = z.object({
  username: usernameSchema,
  fullName: fullNameSchema,
  email: emailSchema,
  mobile: saudiMobile,
  nationalId: nationalIdSchema,
  password: passwordSchema,
  mustChangePassword: z.boolean(),
});

/** «إضافة مالك»: an existing account (identifier or list) or a new account. */
function AddOwnerDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [choice, setChoice] = useState<AccountChoice>(null);
  const [pickError, setPickError] = useState<string>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const initial = { username: '', fullName: '', email: '', mobile: '', nationalId: '', password: '', mustChangePassword: true };
  const form = useZodForm(newOwnerSchema, initial);

  const close = () => {
    form.reset(initial);
    setChoice(null);
    setPickError(undefined);
    setError(null);
    setMode('existing');
    onClose();
  };

  const done = async (o: OwnerDto) => {
    await invalidate();
    notifications.show({ color: 'ok', message: t('a12admin.owners.added', { name: o.fullName }) });
    close();
  };

  const addExisting = async () => {
    setError(null);
    if (!choice) {
      setPickError(t('a12admin.pick.required'));
      return;
    }
    setBusy(true);
    try {
      await done(await api.owners.add(choice));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const addNew = form.onSubmit(async (data) => {
    setError(null);
    try {
      await done(await api.owners.add(data));
    } catch (err) {
      if (err instanceof ApiError) {
        const fe = { ...err.fieldErrors };
        if (err.code === 'USERNAME_TAKEN') fe.username = err.message_ar;
        if (Object.keys(fe).length) {
          form.setErrors(fe);
          return;
        }
      }
      setError(err);
    }
  });

  return (
    <Modal opened={opened} onClose={close} title={t('a12admin.owners.addTitle')} size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          {t('a12admin.owners.addBody')}
        </Text>
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(v) => {
            setMode(v as 'existing' | 'new');
            setError(null);
          }}
          data={[
            { value: 'existing', label: t('a12admin.owners.existing') },
            { value: 'new', label: t('a12admin.owners.new') },
          ]}
        />
        <FormError error={error} />
        {mode === 'existing' ? (
          <>
            <AccountPicker
              canBrowse
              error={pickError}
              onChange={(c) => {
                setChoice(c);
                setPickError(undefined);
              }}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button loading={busy} onClick={() => void addExisting()} leftSection={<IconCrown size={18} />} data-testid="owner-add-submit">
                {t('a12admin.owners.addSubmit')}
              </Button>
            </Group>
          </>
        ) : (
          <form onSubmit={addNew} noValidate>
            <Stack>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput
                  label={t('a12admin.username')}
                  description={t('a12admin.usernameHint')}
                  withAsterisk
                  autoComplete="off"
                  data-testid="owner-username"
                  {...ltr}
                  {...form.getInputProps('username')}
                />
                <TextInput label={t('register.fullName')} withAsterisk {...form.getInputProps('fullName')} />
              </SimpleGrid>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label={t('register.email')} type="email" withAsterisk {...ltr} {...form.getInputProps('email')} />
                <TextInput
                  label={t('register.mobile')}
                  placeholder={t('register.mobilePlaceholder')}
                  type="tel"
                  withAsterisk
                  {...ltr}
                  {...form.getInputProps('mobile')}
                />
              </SimpleGrid>
              <TextInput
                label={t('register.nationalId')}
                description={t('register.nationalIdHint')}
                inputMode="numeric"
                maxLength={10}
                withAsterisk
                {...ltr}
                {...form.getInputProps('nationalId')}
              />
              <PasswordInput
                label={t('a12admin.firstPassword')}
                withAsterisk
                autoComplete="new-password"
                {...form.getInputProps('password')}
              />
              <PasswordStrength value={form.values.password} />
              <Checkbox label={t('a12admin.mustChange')} {...form.getCheckboxProps('mustChangePassword')} />
              <Group justify="flex-end">
                <Button variant="default" onClick={close}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" loading={form.submitting} leftSection={<IconUserPlus size={18} />} data-testid="owner-create-submit">
                  {t('a12admin.owners.createSubmit')}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Stack>
    </Modal>
  );
}

/** «الملّاك» (owners): list, add (existing or new account), remove (never the last one). */
export function OwnersPage() {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const refresh = useRefreshSession();
  const me = useAuthStore((s) => s.user);
  const q = useOwners();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<OwnerDto | null>(null);
  const detail = useOverlayParam('account');

  const removeBtn = (o: OwnerDto) => (
    <Button
      size="compact-sm"
      variant="subtle"
      color="breach"
      mih={40}
      leftSection={<IconTrash size={14} />}
      onClick={() => setRemoving(o)}
      data-testid={`owner-remove-${o.username}`}
    >
      {t('a12admin.owners.remove')}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('nav.systemOwners')}
        lead={t('a12admin.owners.lead')}
        actions={
          <Button leftSection={<IconCrown size={18} />} onClick={() => setAdding(true)} data-testid="owner-add">
            {t('a12admin.owners.add')}
          </Button>
        }
      />
      {q.isLoading ? (
        <LoadingBlock variant="table" rows={3} />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <EmptyState
          icon={IconCrown}
          title={t('a12admin.owners.empty')}
          action={{ label: t('a12admin.owners.add'), onClick: () => setAdding(true) }}
        />
      ) : (
        <>
          <Stack hiddenFrom="sm" gap="sm">
            {q.data.map((o) => (
              <div key={o.id} className="nz-row-card" data-testid={`owner-${o.username}`}>
                <PersonName user={o} self={o.id === me?.id} onOpen={() => detail.open(o.id)} sub={<Ltr mono>{o.username}</Ltr>} />
                <Group gap={6} mt={6} justify="space-between">
                  <StatePill status={o.status} />
                  {removeBtn(o)}
                </Group>
              </div>
            ))}
          </Stack>
          <Card p={0} visibleFrom="sm">
            <Table.ScrollContainer minWidth={720}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('users.col.name')}</Table.Th>
                    <Table.Th>{t('a12admin.username')}</Table.Th>
                    <Table.Th>{t('register.email')}</Table.Th>
                    <Table.Th>{t('users.col.status')}</Table.Th>
                    <Table.Th>{t('users.col.lastLogin')}</Table.Th>
                    <Table.Th>
                      <span className="sr-only">{t('common.actions')}</span>
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {q.data.map((o) => (
                    <Table.Tr key={o.id} data-testid={`owner-row-${o.username}`}>
                      <Table.Td>
                        <PersonName user={o} self={o.id === me?.id} onOpen={() => detail.open(o.id)} />
                      </Table.Td>
                      <Table.Td>
                        <Ltr mono>{o.username}</Ltr>
                      </Table.Td>
                      <Table.Td>
                        <Ltr>{o.email}</Ltr>
                      </Table.Td>
                      <Table.Td>
                        <StatePill status={o.status} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c={o.lastLoginAt ? undefined : 'dimmed'}>
                          {o.lastLoginAt ? formatDateTime(o.lastLoginAt) : t('users.neverLoggedIn')}
                        </Text>
                      </Table.Td>
                      <Table.Td>{removeBtn(o)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>
        </>
      )}

      <AddOwnerDialog opened={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        opened={Boolean(removing)}
        title={removing ? t('a12admin.owners.removeTitle', { name: removing.fullName }) : ''}
        body={removing?.id === me?.id ? t('a12admin.owners.removeSelfBody') : t('a12admin.owners.removeBody')}
        confirmLabel={t('a12admin.owners.removeConfirm')}
        color="breach"
        testId="owner-remove-confirm"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          const self = removing!.id === me?.id;
          await api.owners.remove(removing!.id);
          await invalidate();
          if (self) {
            try {
              await refresh();
            } catch {
              // the next refresh catches up
            }
          }
          notifications.show({ color: 'ok', message: t('a12admin.owners.removed', { name: removing!.fullName }) });
        }}
      />
      <UserEditor id={detail.value} onClose={detail.close} />
    </>
  );
}
