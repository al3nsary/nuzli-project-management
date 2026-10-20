import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconKey, IconUserPlus, IconUserX } from '@tabler/icons-react';
import { z } from 'zod';
import {
  email as emailSchema,
  formatSaudiMobileLocal,
  fullName as fullNameSchema,
  nationalId as nationalIdSchema,
  password as passwordSchema,
  saudiMobile,
  usernameSchema,
  workspaceRoleSchema,
  type AssistantPermissions,
  type AssistantScope,
  type UserDto,
  type WorkspaceMemberDto,
  type WorkspaceRole,
} from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { useWorkspacesAdmin } from '../../api/a12Queries';
import { useZodForm } from '../../forms/useZodForm';
import { FormError, roleLabel } from '../../components/ui';
import { PasswordStrength } from '../../components/PasswordStrength';
import { useAuthStore } from '../../stores/auth';
import { useDualRoleConfirm } from '../workspaces/DualRole';
import { t, tKey } from '../../i18n';
import { AssistantAccessEditor, scopeIncomplete } from './AssistantGrid';
import { AccountPicker, type AccountChoice } from './components';
import { useInvalidateUserAdmin } from './queries';

/** Roles an admin may give inside a workspace (order of strength). */
export const MEMBERSHIP_ROLES: WorkspaceRole[] = ['ADMIN', 'ASSISTANT', 'SUPERVISOR', 'MONITOR', 'MEMBER'];

const roleOptions = () =>
  MEMBERSHIP_ROLES.map((r) => ({ value: r, label: roleLabel(r) }));

const ltr = { dir: 'ltr' as const, styles: { input: { textAlign: 'start' as const } } };

const optionalTitle = z.string().trim().max(120, { message: t('a12admin.titleTooLong') });

/** USERNAME_TAKEN and the other duplicates land under their field; the rest above the form. */
function fieldErrorsOf(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const out = { ...err.fieldErrors };
  if (err.code === 'USERNAME_TAKEN' && !out.username) out.username = err.message_ar;
  return out;
}

function RoleHint({ role }: { role: WorkspaceRole }) {
  return (
    <Text size="xs" c="dimmed">
      {tKey(`a12admin.roleHint.${role}`, 'common.none')}
    </Text>
  );
}

// ------------------------------------------------------------------ create an account

const createFormSchema = z.object({
  username: usernameSchema,
  fullName: fullNameSchema,
  email: emailSchema,
  mobile: saudiMobile,
  nationalId: nationalIdSchema,
  password: passwordSchema,
  mustChangePassword: z.boolean(),
  role: workspaceRoleSchema,
  title: optionalTitle,
  workspaceId: z.string().nullable(),
});

/**
 * «إنشاء مستخدم» (A12 round 2): username, contact data, the first password («يُطلب التغيير عند
 * أول دخول» on by default), the first role and position; owners pick the workspace; an assistant
 * gets the permissions grid. A second role anywhere goes through the dual-role confirmation.
 */
export function CreateAccountDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const me = useAuthStore((s) => s.user);
  const active = useAuthStore((s) => s.activeWorkspace);
  const isOwner = me?.accountRole === 'OWNER';
  const workspaces = useWorkspacesAdmin('ACTIVE', isOwner && opened);
  const dual = useDualRoleConfirm();
  const [error, setError] = useState<unknown>(null);
  const [permissions, setPermissions] = useState<AssistantPermissions>({});
  const [scope, setScope] = useState<AssistantScope>({});
  const initial = {
    username: '',
    fullName: '',
    email: '',
    mobile: '',
    nationalId: '',
    password: '',
    mustChangePassword: true,
    role: 'SUPERVISOR' as WorkspaceRole,
    title: '',
    workspaceId: (active?.id ?? null) as string | null,
  };
  const form = useZodForm(createFormSchema, initial);
  const role = form.values.role;
  const sameWorkspace = !form.values.workspaceId || form.values.workspaceId === active?.id;
  const wsOptions = (workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }));

  const close = () => {
    form.reset(initial);
    setPermissions({});
    setScope({});
    setError(null);
    onClose();
  };

  const submit = form.onSubmit(async (data) => {
    setError(null);
    if (data.role === 'ASSISTANT' && sameWorkspace && scopeIncomplete(scope)) {
      setError(new ApiError(400, 'VALIDATION_FAILED', t('a12admin.scope.incomplete')));
      return;
    }
    const membership = {
      ...(isOwner && data.workspaceId ? { workspaceId: data.workspaceId } : {}),
      role: data.role,
      ...(data.title ? { title: data.title } : {}),
      ...(data.role === 'ASSISTANT' ? { permissions, ...(sameWorkspace ? { scope } : {}) } : {}),
    };
    try {
      const created = await dual.run((confirmDualRole) =>
        api.users.create({
          username: data.username,
          fullName: data.fullName,
          email: data.email,
          mobile: data.mobile,
          nationalId: data.nationalId,
          password: data.password,
          mustChangePassword: data.mustChangePassword,
          memberships: [membership],
          ...(confirmDualRole ? { confirmDualRole: true } : {}),
        }),
      );
      if (!created) return;
      await invalidate();
      notifications.show({ color: 'ok', message: t('a12admin.created', { name: created.fullName }) });
      close();
    } catch (err) {
      const fe = fieldErrorsOf(err);
      if (Object.keys(fe).length) {
        form.setErrors(fe);
        if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') return;
      }
      setError(err);
    }
  });

  return (
    <>
      <Modal opened={opened} onClose={close} title={t('a12admin.create.title')} size="xl">
        <form onSubmit={submit} noValidate>
          <Stack>
            <Text size="sm" c="dimmed">
              {t('a12admin.create.body')}
            </Text>
            <FormError error={error} />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label={t('a12admin.username')}
                description={t('a12admin.usernameHint')}
                withAsterisk
                data-autofocus
                autoComplete="off"
                data-testid="user-username"
                {...ltr}
                {...form.getInputProps('username')}
              />
              <TextInput label={t('register.fullName')} withAsterisk {...form.getInputProps('fullName')} />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label={t('register.email')}
                placeholder={t('register.emailPlaceholder')}
                type="email"
                withAsterisk
                {...ltr}
                {...form.getInputProps('email')}
              />
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
            <Divider label={t('a12admin.create.passwordSection')} labelPosition="center" />
            <PasswordInput
              label={t('a12admin.firstPassword')}
              withAsterisk
              autoComplete="new-password"
              data-testid="user-password"
              {...form.getInputProps('password')}
            />
            <PasswordStrength value={form.values.password} />
            <Checkbox
              label={t('a12admin.mustChange')}
              description={t('a12admin.mustChangeHint')}
              {...form.getCheckboxProps('mustChangePassword')}
            />
            <Divider label={t('a12admin.create.roleSection')} labelPosition="center" />
            {isOwner ? (
              <Select
                label={t('a12admin.workspace')}
                data={wsOptions}
                allowDeselect={false}
                withAsterisk
                comboboxProps={{ withinPortal: true }}
                {...form.getInputProps('workspaceId')}
              />
            ) : null}
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Stack gap={4}>
                <Select
                  label={t('a12admin.initialRole')}
                  data={roleOptions()}
                  allowDeselect={false}
                  withAsterisk
                  data-testid="user-role"
                  comboboxProps={{ withinPortal: true }}
                  {...form.getInputProps('role')}
                />
                <RoleHint role={role} />
              </Stack>
              <TextInput
                label={`${t('a12admin.position')} (${t('common.optional')})`}
                placeholder={t('a12admin.positionPlaceholder')}
                {...form.getInputProps('title')}
              />
            </SimpleGrid>
            {role === 'ASSISTANT' ? (
              <AssistantAccessEditor
                permissions={permissions}
                scope={scope}
                onPermissions={setPermissions}
                onScope={setScope}
                withScope={sameWorkspace}
              />
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={form.submitting} leftSection={<IconUserPlus size={18} />} data-testid="user-create-submit">
                {t('a12admin.create.submit')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
      {dual.dialog}
    </>
  );
}

// ------------------------------------------------------------------ edit an account

const editFormSchema = z.object({
  fullName: fullNameSchema,
  email: emailSchema,
  mobile: saudiMobile,
  nationalId: z.union([z.literal(''), nationalIdSchema]),
});

/** «تعديل البيانات»: name, e-mail, mobile, national ID (only the changed fields are sent). */
export function EditAccountDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const [error, setError] = useState<unknown>(null);
  const initial = {
    fullName: user.fullName,
    email: user.email,
    mobile: formatSaudiMobileLocal(user.mobile),
    nationalId: user.nationalId ?? '',
  };
  const form = useZodForm(editFormSchema, initial);

  const submit = form.onSubmit(async (data) => {
    setError(null);
    const patch: Record<string, string> = {};
    if (data.fullName !== user.fullName) patch.fullName = data.fullName;
    if (data.email !== user.email) patch.email = data.email;
    if (data.mobile !== user.mobile) patch.mobile = data.mobile;
    if (data.nationalId && data.nationalId !== user.nationalId) patch.nationalId = data.nationalId;
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    try {
      await api.users.update(user.id, patch);
      await invalidate();
      notifications.show({ color: 'ok', message: t('a12admin.edit.done', { name: data.fullName }) });
      onClose();
    } catch (err) {
      const fe = fieldErrorsOf(err);
      if (Object.keys(fe).length) form.setErrors(fe);
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED' && Object.keys(fe).length) return;
      setError(err);
    }
  });

  return (
    <Modal opened onClose={onClose} title={t('a12admin.edit.title', { name: user.fullName })} size="lg">
      <form onSubmit={submit} noValidate>
        <Stack>
          <FormError error={error} />
          <TextInput label={t('register.fullName')} withAsterisk data-autofocus {...form.getInputProps('fullName')} />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label={t('register.email')} type="email" withAsterisk {...ltr} {...form.getInputProps('email')} />
            <TextInput label={t('register.mobile')} type="tel" withAsterisk {...ltr} {...form.getInputProps('mobile')} />
          </SimpleGrid>
          <TextInput
            label={t('register.nationalId')}
            description={user.nationalId ? t('register.nationalIdHint') : t('a12admin.edit.nationalIdHidden')}
            placeholder={user.nationalId ? undefined : user.nationalIdMasked}
            inputMode="numeric"
            maxLength={10}
            {...ltr}
            {...form.getInputProps('nationalId')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.submitting} data-testid="user-edit-submit">
              {t('a12admin.edit.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ username

/** «تغيير اسم المستخدم» — any time; USERNAME_TAKEN in Arabic under the field. */
export function UsernameDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const [error, setError] = useState<unknown>(null);
  const form = useZodForm(z.object({ username: usernameSchema }), { username: user.username ?? '' });
  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      await api.users.setUsername(user.id, data);
      await invalidate();
      notifications.show({ color: 'ok', message: t('a12admin.username.done', { username: data.username }) });
      onClose();
    } catch (err) {
      const fe = fieldErrorsOf(err);
      if (fe.username) {
        form.setErrors({ username: fe.username });
        return;
      }
      setError(err);
    }
  });
  return (
    <Modal opened onClose={onClose} title={t('a12admin.username.title', { name: user.fullName })}>
      <form onSubmit={submit} noValidate>
        <Stack>
          <Text size="sm">{t('a12admin.username.body')}</Text>
          <FormError error={error} />
          <TextInput
            label={t('a12admin.username')}
            description={t('a12admin.usernameHint')}
            withAsterisk
            data-autofocus
            autoComplete="off"
            data-testid="user-username-input"
            {...ltr}
            {...form.getInputProps('username')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.submitting} data-testid="user-username-submit">
              {t('a12admin.username.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ password

/** «تعيين كلمة مرور جديدة»: never shows nor asks the old one; ends every session of the user. */
export function SetPasswordDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const [error, setError] = useState<unknown>(null);
  const form = useZodForm(z.object({ password: passwordSchema, mustChangePassword: z.boolean() }), {
    password: '',
    mustChangePassword: true,
  });
  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      await api.users.setPassword(user.id, data);
      await invalidate();
      notifications.show({ color: 'ok', message: t('a12admin.password.done', { name: user.fullName }) });
      onClose();
    } catch (err) {
      const fe = fieldErrorsOf(err);
      if (fe.password) form.setErrors({ password: fe.password });
      else setError(err);
    }
  });
  return (
    <Modal opened onClose={onClose} title={t('a12admin.password.title', { name: user.fullName })}>
      <form onSubmit={submit} noValidate>
        <Stack>
          <Alert color="signal" icon={<IconAlertTriangle size={18} />}>
            {t('a12admin.password.sessions')}
          </Alert>
          <Text size="sm" c="dimmed">
            {t('a12admin.password.noRead')}
          </Text>
          <FormError error={error} />
          <PasswordInput
            label={t('a12admin.password.new')}
            withAsterisk
            data-autofocus
            autoComplete="new-password"
            data-testid="user-new-password"
            {...form.getInputProps('password')}
          />
          <PasswordStrength value={form.values.password} />
          <Checkbox label={t('a12admin.mustChange')} {...form.getCheckboxProps('mustChangePassword')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.submitting} leftSection={<IconKey size={18} />} data-testid="user-set-password-submit">
              {t('a12admin.password.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ add an existing account / a role

/**
 * «إضافة مستخدم موجود» to the active workspace (or a further role for a known person when
 * `userId` is given). Through the dual-role confirmation.
 */
export function AddMembershipDialog({
  opened,
  onClose,
  workspaceId,
  user,
}: {
  opened: boolean;
  onClose: () => void;
  workspaceId: string;
  /** Known person: give them another role here (no picker). */
  user?: { id: string; fullName: string };
}) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const me = useAuthStore((s) => s.user);
  const active = useAuthStore((s) => s.activeWorkspace);
  const withScope = workspaceId === active?.id;
  const dual = useDualRoleConfirm();
  const [choice, setChoice] = useState<AccountChoice>(user ? { userId: user.id } : null);
  const [role, setRole] = useState<WorkspaceRole>('SUPERVISOR');
  const [title, setTitle] = useState('');
  const [permissions, setPermissions] = useState<AssistantPermissions>({});
  const [scope, setScope] = useState<AssistantScope>({});
  const [error, setError] = useState<unknown>(null);
  const [pickError, setPickError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (opened) setChoice(user ? { userId: user.id } : null);
  }, [opened, user]);

  const close = () => {
    setError(null);
    setPickError(undefined);
    setRole('SUPERVISOR');
    setTitle('');
    setPermissions({});
    setScope({});
    onClose();
  };

  const submit = async () => {
    setError(null);
    if (!choice) {
      setPickError(t('a12admin.pick.required'));
      return;
    }
    if (title.trim().length > 120) {
      setError(new ApiError(400, 'VALIDATION_FAILED', t('a12admin.titleTooLong')));
      return;
    }
    if (role === 'ASSISTANT' && withScope && scopeIncomplete(scope)) {
      setError(new ApiError(400, 'VALIDATION_FAILED', t('a12admin.scope.incomplete')));
      return;
    }
    setBusy(true);
    try {
      const added = await dual.run((confirmDualRole) =>
        api.workspaces.addMember(workspaceId, {
          ...choice,
          role,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(role === 'ASSISTANT' ? { permissions, ...(withScope ? { scope } : {}) } : {}),
          ...(confirmDualRole ? { confirmDualRole: true } : {}),
        }),
      );
      if (!added) return;
      await invalidate();
      notifications.show({
        color: 'ok',
        message: t('a12admin.member.added', { name: added.user.fullName, role: roleLabel(added.role) }),
      });
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        opened={opened}
        onClose={close}
        title={user ? t('a12admin.member.addRoleTitle', { name: user.fullName }) : t('a12admin.member.addTitle')}
        size="xl"
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {user ? t('a12admin.member.addRoleBody') : t('a12admin.member.addBody')}
          </Text>
          <FormError error={error} />
          {user ? null : (
            <AccountPicker
              canBrowse={me?.accountRole === 'OWNER'}
              error={pickError}
              onChange={(c) => {
                setChoice(c);
                setPickError(undefined);
              }}
            />
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Stack gap={4}>
              <Select
                label={t('users.role')}
                data={roleOptions()}
                value={role}
                onChange={(v) => v && setRole(v as WorkspaceRole)}
                allowDeselect={false}
                withAsterisk
                data-testid="member-role"
                comboboxProps={{ withinPortal: true }}
              />
              <RoleHint role={role} />
            </Stack>
            <TextInput
              label={`${t('a12admin.position')} (${t('common.optional')})`}
              placeholder={t('a12admin.positionPlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
            />
          </SimpleGrid>
          {role === 'ASSISTANT' ? (
            <AssistantAccessEditor
              permissions={permissions}
              scope={scope}
              onPermissions={setPermissions}
              onScope={setScope}
              withScope={withScope}
            />
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} onClick={() => void submit()} leftSection={<IconUserPlus size={18} />} data-testid="member-add-submit">
              {user ? t('a12admin.member.addRoleSubmit') : t('a12admin.member.addSubmit')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      {dual.dialog}
    </>
  );
}

/** «تعديل الصفة»: the position (منصب) and, for an assistant, the grid and the scope. */
export function EditMembershipDialog({
  membership,
  onClose,
  readOnly,
}: {
  membership: WorkspaceMemberDto;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const [title, setTitle] = useState(membership.title ?? '');
  const [permissions, setPermissions] = useState<AssistantPermissions>(membership.permissions ?? {});
  const [scope, setScope] = useState<AssistantScope>(membership.scope ?? {});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const assistant = membership.role === 'ASSISTANT';
  const active = useAuthStore((st) => st.activeWorkspace);
  const withScope = membership.workspaceId === active?.id;

  const save = async () => {
    setError(null);
    if (title.trim().length > 120) {
      setError(new ApiError(400, 'VALIDATION_FAILED', t('a12admin.titleTooLong')));
      return;
    }
    if (assistant && withScope && scopeIncomplete(scope)) {
      setError(new ApiError(400, 'VALIDATION_FAILED', t('a12admin.scope.incomplete')));
      return;
    }
    setBusy(true);
    try {
      await api.workspaces.updateMember(membership.workspaceId, membership.id, {
        title: title.trim() ? title.trim() : null,
        ...(assistant ? { permissions, ...(withScope ? { scope } : {}) } : {}),
      });
      await invalidate();
      notifications.show({ color: 'ok', message: t('a12admin.membership.saved', { name: membership.user.fullName }) });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={t('a12admin.membership.title', { name: membership.user.fullName, role: roleLabel(membership.role) })}
      size={assistant ? 'xl' : 'md'}
    >
      <Stack>
        <FormError error={error} />
        <TextInput
          label={`${t('a12admin.position')} (${t('common.optional')})`}
          placeholder={t('a12admin.positionPlaceholder')}
          value={title}
          disabled={readOnly}
          onChange={(e) => setTitle(e.currentTarget.value)}
          data-autofocus
        />
        {assistant ? (
          <AssistantAccessEditor
            permissions={permissions}
            scope={scope}
            onPermissions={setPermissions}
            onScope={setScope}
            disabled={readOnly}
            withScope={withScope}
          />
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {readOnly ? t('common.close') : t('common.cancel')}
          </Button>
          {readOnly ? null : (
            <Button loading={busy} onClick={() => void save()} data-testid="membership-save">
              {t('a12admin.membership.submit')}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

// ------------------------------------------------------------------ suspend

/** Suspension in this workspace (default) or, for owners, in the whole system. */
export function SuspendAccountDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const me = useAuthStore((s) => s.user);
  const isOwner = me?.accountRole === 'OWNER';
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<'workspace' | 'global'>('workspace');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const scopeOptions = useMemo(
    () => [
      { value: 'workspace', label: t('a12admin.suspend.workspace') },
      { value: 'global', label: t('a12admin.suspend.global') },
    ],
    [],
  );
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.users.suspend(user.id, { reason: reason.trim() || undefined, scope });
      await invalidate();
      notifications.show({ color: 'ok', message: t('users.suspended', { name: user.fullName }) });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('users.suspendTitle', { name: user.fullName })}>
      <Stack>
        <Text size="sm">{scope === 'global' ? t('a12admin.suspend.globalBody') : t('a12admin.suspend.workspaceBody')}</Text>
        <FormError error={error} />
        {isOwner ? (
          <Select
            label={t('a12admin.suspend.scope')}
            data={scopeOptions}
            value={scope}
            onChange={(v) => v && setScope(v as 'workspace' | 'global')}
            allowDeselect={false}
            data-testid="suspend-scope"
            comboboxProps={{ withinPortal: true }}
          />
        ) : null}
        <Textarea
          label={`${t('users.suspendReason')} (${t('common.optional')})`}
          autosize
          minRows={2}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button color="breach" loading={busy} leftSection={<IconUserX size={18} />} onClick={() => void go()} data-testid="user-suspend-submit">
            {scope === 'global' ? t('a12admin.suspend.globalSubmit') : t('users.suspendConfirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
