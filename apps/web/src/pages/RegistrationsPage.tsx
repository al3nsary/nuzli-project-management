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
  Tabs,
  Text,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation } from '@tanstack/react-query';
import { IconCheck, IconInbox, IconX } from '@tabler/icons-react';
import { can, rejectRegistrationSchema, type UserDto } from '@nuzli/shared';
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
import { useAuthStore } from '../stores/auth';
import { useTabParam } from '../lib/useUrlState';
import { MemberRequestList } from './requests/MemberRequests';
import './requests/requests.css';

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

function RequestCard({ user, onReject, canDecide }: { user: UserDto; onReject: (u: UserDto) => void; canDecide: boolean }) {
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
      {canDecide ? (
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
      ) : null}
      {canDecide && role !== requested ? (
        <Text size="xs" c="dimmed" mt={6}>
          {t('reg.roleChanged', { role: roleLabel(role) })}
        </Text>
      ) : null}
    </Card>
  );
}

const REQUEST_TABS = ['registrations', 'workers'] as const;

/**
 * «الطلبات» (A12 round 2): «طلبات التسجيل» (unchanged) and «طلبات العمّال» (`?tab=workers`) —
 * supervisors' requests to add or remove workers. Deciding needs `registrations.review`; an
 * assistant with registrations:view (`registrations.read`) only reads.
 */
export function RegistrationsPage() {
  const user = useAuthStore((s) => s.user);
  const [tab, setTab] = useTabParam('tab', REQUEST_TABS, 'registrations');
  const canDecide = can(user, 'registrations.review');
  return (
    <>
      <PageHeader title={t('nav.requests')} lead={t('a12roles.requests.lead')} />
      <Tabs value={tab} onChange={setTab} keepMounted={false} className="nz-req-tabs">
        <Tabs.List>
          <Tabs.Tab value="registrations" data-testid="requests-tab-registrations">
            {t('a12roles.requests.tab.registrations')}
          </Tabs.Tab>
          <Tabs.Tab value="workers" data-testid="requests-tab-workers">
            {t('a12roles.requests.tab.workers')}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === 'workers' ? <WorkersTab canDecide={canDecide} /> : <RegistrationsTab canDecide={canDecide} />}
    </>
  );
}

function WorkersTab({ canDecide }: { canDecide: boolean }) {
  return (
    <Stack gap="lg">
      {!canDecide ? (
        <Text size="sm" c="dimmed" className="nz-req-note">
          {t('a12roles.wr.readOnly')}
        </Text>
      ) : null}
      <MemberRequestList view="pending" approver={canDecide} />
      <section aria-labelledby="wr-history">
        <Text component="h2" id="wr-history" fw={600} fz="lg" mb="sm">
          {t('a12roles.wr.history')}
        </Text>
        <MemberRequestList view="decided" approver={false} />
      </section>
    </Stack>
  );
}

/** «طلبات التسجيل» — the registration requests as before A12 round 2. */
function RegistrationsTab({ canDecide }: { canDecide: boolean }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [rejecting, setRejecting] = useState<UserDto | null>(null);
  const q = useRegistrations({ page, pageSize: 10 });

  return (
    <>
      <Text size="sm" c="dimmed" className="nz-req-note">
        {canDecide ? t('reg.lead') : t('a12roles.requests.regReadOnly')}
      </Text>
      {q.isLoading ? (
        <LoadingBlock variant="list" rows={3} />
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
            <RequestCard key={u.id} user={u} onReject={setRejecting} canDecide={canDecide} />
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
