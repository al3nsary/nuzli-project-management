import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Anchor,
  Box,
  Button,
  Card,
  Group,
  Modal,
  Pagination,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation } from '@tanstack/react-query';
import { IconCheck, IconInbox, IconX } from '@tabler/icons-react';
import { rejectRegistrationSchema, type UserDto } from '@nuzli/shared';
import { useApi } from '../api/context';
import { errorMessage } from '../api/errors';
import { useInvalidateAccounts, useRegistrations, useUser } from '../api/queries';
import { useZodForm } from '../forms/useZodForm';
import {
  EmptyState,
  ErrorBlock,
  FormError,
  Ltr,
  LoadingBlock,
  Mobile,
  PageHeader,
  RoleBadge,
  roleLabel,
} from '../components/ui';
import { formatDateTime, t } from '../i18n';

type ReviewRole = 'SUPERVISOR' | 'MONITOR';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box style={{ minWidth: 0 }}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </Box>
  );
}

/** The full national ID is fetched only on request, from the admin detail endpoint. */
function NationalIdField({ user }: { user: UserDto }) {
  const [reveal, setReveal] = useState(false);
  const detail = useUser(reveal ? user.id : null);
  return (
    <Field label={t('users.col.nationalId')}>
      <Ltr mono>{detail.data?.nationalId ?? user.nationalIdMasked}</Ltr>
      {!reveal ? (
        <Anchor
          component="button"
          type="button"
          size="xs"
          display="block"
          onClick={() => setReveal(true)}
        >
          {t('reg.showFullId')}
        </Anchor>
      ) : null}
    </Field>
  );
}

function RejectModal({ user, onClose }: { user: UserDto | null; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateAccounts();
  const [error, setError] = useState<unknown>(null);
  const form = useZodForm(rejectRegistrationSchema, { reason: '' });

  const submit = form.onSubmit(async (data) => {
    if (!user) return;
    setError(null);
    try {
      await api.registrations.reject(user.id, data);
      await invalidate();
      notifications.show({ color: 'ok', message: t('reg.rejected', { name: user.fullName }) });
      form.reset();
      onClose();
    } catch (err) {
      setError(err);
    }
  });

  return (
    <Modal
      opened={Boolean(user)}
      onClose={onClose}
      title={user ? t('reg.rejectTitle', { name: user.fullName }) : ''}
    >
      <form onSubmit={submit} noValidate>
        <Stack>
          <FormError error={error} />
          <Textarea
            label={t('reg.rejectReason')}
            description={t('reg.rejectReasonHint')}
            autosize
            minRows={3}
            withAsterisk
            data-autofocus
            {...form.getInputProps('reason')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" color="breach" loading={form.submitting}>
              {t('reg.rejectConfirm')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function RequestCard({ user, onReject }: { user: UserDto; onReject: (u: UserDto) => void }) {
  const api = useApi();
  const invalidate = useInvalidateAccounts();
  const requested = (user.requestedRole ?? user.role) as ReviewRole;
  const [role, setRole] = useState<ReviewRole>(requested === 'MONITOR' ? 'MONITOR' : 'SUPERVISOR');

  const approve = useMutation({
    mutationFn: () => api.registrations.approve(user.id, role !== requested ? { role } : {}),
    onSuccess: async () => {
      await invalidate();
      notifications.show({ color: 'ok', message: t('reg.approved', { name: user.fullName }) });
    },
    onError: (err) => notifications.show({ color: 'breach', message: errorMessage(err) }),
  });

  return (
    <Card>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs" mb="sm">
        <Text fw={600} fz="lg">
          {user.fullName}
        </Text>
        <Group gap={6}>
          <Text size="xs" c="dimmed">
            {t('reg.requestedRole')}
          </Text>
          <RoleBadge role={requested} />
        </Group>
      </Group>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="sm" verticalSpacing="sm">
        <Field label={t('register.email')}>
          <Ltr>{user.email}</Ltr>
        </Field>
        <Field label={t('register.mobile')}>
          <Mobile value={user.mobile} />
        </Field>
        <NationalIdField user={user} />
        <Field label={t('reg.requestedTeam')}>{user.requestedTeamName || t('common.none')}</Field>
        <Field label={t('reg.submittedAt')}>{formatDateTime(user.createdAt)}</Field>
      </SimpleGrid>
      <Group mt="md" align="flex-end" wrap="wrap" gap="sm">
        <Select
          label={t('reg.approveAs')}
          data={(['SUPERVISOR', 'MONITOR'] as const).map((r) => ({
            value: r,
            label: roleLabel(r),
          }))}
          value={role}
          onChange={(v) => v && setRole(v as ReviewRole)}
          allowDeselect={false}
          w={200}
          size="sm"
        />
        <Button
          leftSection={<IconCheck size={18} />}
          loading={approve.isPending}
          onClick={() => approve.mutate()}
        >
          {t('reg.approve')}
        </Button>
        <Button
          variant="outline"
          color="breach"
          leftSection={<IconX size={18} />}
          onClick={() => onReject(user)}
        >
          {t('reg.reject')}
        </Button>
      </Group>
      {role !== requested ? (
        <Text size="xs" c="dimmed" mt={6}>
          {t('reg.roleChanged', { role: roleLabel(role) })}
        </Text>
      ) : null}
    </Card>
  );
}

export function RegistrationsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [rejecting, setRejecting] = useState<UserDto | null>(null);
  const q = useRegistrations({ page, pageSize: 10 });

  return (
    <>
      <PageHeader title={t('reg.title')} lead={t('reg.lead')} />
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.items.length ? (
        <EmptyState
          icon={IconInbox}
          title={t('reg.empty')}
          body={t('reg.emptyBody')}
          action={{ label: t('reg.emptyAction'), onClick: () => navigate('/users') }}
        />
      ) : (
        <Stack>
          {q.data.items.map((u) => (
            <RequestCard key={u.id} user={u} onReject={setRejecting} />
          ))}
          {q.data.total > q.data.pageSize ? (
            <Pagination
              total={Math.ceil(q.data.total / q.data.pageSize)}
              value={page}
              onChange={setPage}
              mx="auto"
            />
          ) : null}
        </Stack>
      )}
      <RejectModal user={rejecting} onClose={() => setRejecting(null)} />
    </>
  );
}
