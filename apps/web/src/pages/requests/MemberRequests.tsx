/**
 * A12 round 2 — workers' add/remove requests (طلبات العمّال, docs/API.md «Workers: add / remove by
 * request»). One card per request: kind, worker (masked national ID), team, who asked and when,
 * the status pill and, once decided, who decided and the rejection reason. Approvers
 * (`registrations.review`: admins, owners, assistants with registrations:edit) approve or reject
 * (reason required); `registrations.read` only reads. Every decision refreshes the nav badge.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Box, Button, Card, Group, Modal, SimpleGrid, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconInbox, IconUserMinus, IconUserPlus, IconX } from '@tabler/icons-react';
import type { MemberRequestDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useMemberRequests } from '../../api/a12Queries';
import { useInvalidateTeams } from '../../api/queries';
import { EmptyState, ErrorBlock, FormError, Ltr, LoadingBlock } from '../../components/ui';
import { formatDateTime, localizeDigits, t } from '../../i18n';
import './requests.css';

/** Every member-request list (and the nav badge) starts with this key. */
export const MEMBER_REQUESTS_KEY = ['a12', 'member-requests'] as const;

export type RequestsView = 'pending' | 'decided';

const STATUS_PILL: Record<MemberRequestDto['status'], string> = { PENDING: 'wait', APPROVED: 'live', REJECTED: 'no' };

export const workerName = (r: MemberRequestDto) => r.payload.fullName || r.member?.fullName || t('a12roles.wr.unknownName');
const kindLabel = (r: MemberRequestDto) => t(`a12roles.wr.kind.${r.kind}`);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box style={{ minWidth: 0 }}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" style={{ overflowWrap: 'anywhere' }} component="div">
        {children}
      </Text>
    </Box>
  );
}

export function useInvalidateMemberRequests() {
  const qc = useQueryClient();
  const teams = useInvalidateTeams();
  return async () => {
    await qc.invalidateQueries({ queryKey: MEMBER_REQUESTS_KEY });
    await teams();
  };
}

/**
 * The list for one view. `pending` = PENDING; `decided` = APPROVED and REJECTED (newest decision
 * first). `approver` shows the approve / reject buttons.
 */
export function MemberRequestList({ view, approver, emptyAction }: { view: RequestsView; approver: boolean; emptyAction?: { label: string; onClick(): void } }) {
  const q = useMemberRequests(view === 'pending' ? { status: 'PENDING', pageSize: 100 } : { status: 'ALL', pageSize: 100 });
  const [rejecting, setRejecting] = useState<MemberRequestDto | null>(null);
  const rows = useMemo(() => {
    const items = q.data?.items ?? [];
    if (view === 'pending') return items.filter((r) => r.status === 'PENDING');
    return items
      .filter((r) => r.status !== 'PENDING')
      .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  }, [q.data, view]);

  if (q.isLoading) return <LoadingBlock variant="list" rows={3} />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  if (!rows.length) {
    return view === 'pending' ? (
      <EmptyState
        icon={IconInbox}
        title={approver ? t('a12roles.wr.emptyApprover') : t('a12roles.wr.emptyPending')}
        body={approver ? t('a12roles.wr.emptyApproverBody') : t('a12roles.wr.emptyPendingBody')}
        action={emptyAction}
      />
    ) : (
      <EmptyState icon={IconInbox} title={t('a12roles.wr.emptyDecided')} body={t('a12roles.wr.emptyDecidedBody')} />
    );
  }
  return (
    <Stack gap="sm" data-testid={`worker-requests-${view}`}>
      {rows.map((r) => (
        <MemberRequestCard key={r.id} request={r} approver={approver && r.status === 'PENDING'} onReject={setRejecting} />
      ))}
      <RejectRequestModal request={rejecting} onClose={() => setRejecting(null)} />
    </Stack>
  );
}

function MemberRequestCard({ request: r, approver, onReject }: { request: MemberRequestDto; approver: boolean; onReject(r: MemberRequestDto): void }) {
  const api = useApi();
  const invalidate = useInvalidateMemberRequests();
  const name = workerName(r);
  const approve = useMutation({
    mutationFn: () => api.memberRequests.approve(r.id),
    onSuccess: async () => {
      await invalidate();
      notifications.show({ color: 'ok', message: t('a12roles.wr.approved', { kind: kindLabel(r), name }) });
    },
    onError: (err) => notifications.show({ color: 'breach', message: errorMessage(err) }),
  });
  const KindIcon = r.kind === 'ADD' ? IconUserPlus : IconUserMinus;
  return (
    <Card data-testid="worker-request" data-status={r.status} data-kind={r.kind}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs" mb="sm">
        <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
          <span className="nz-wr-kind" data-kind={r.kind} aria-hidden>
            <KindIcon size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <Text size="xs" c="dimmed">
              {kindLabel(r)}
            </Text>
            <Text fw={600} fz="lg" lh={1.35} style={{ overflowWrap: 'anywhere' }}>
              {name}
            </Text>
          </div>
        </Group>
        <span className={`pill ${STATUS_PILL[r.status]}`} data-testid="worker-request-status">
          {t(`a12roles.wr.status.${r.status}`)}
        </span>
      </Group>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="sm" verticalSpacing="sm">
        <Field label={t('a12roles.wr.team')}>{r.team?.name ?? t('a12roles.wr.noTeam')}</Field>
        {r.payload.nationalIdMasked ? (
          <Field label={t('a12roles.wr.nationalId')}>
            <Ltr mono>{localizeDigits(r.payload.nationalIdMasked)}</Ltr>
          </Field>
        ) : null}
        {r.payload.jobTitle ? <Field label={t('a12roles.wr.jobTitle')}>{r.payload.jobTitle}</Field> : null}
        {r.requestedBy ? <Field label={t('a12roles.wr.requestedBy')}>{r.requestedBy.fullName}</Field> : null}
        <Field label={t('a12roles.wr.requestedAt')}>{formatDateTime(r.createdAt)}</Field>
        {r.reason ? <Field label={t('a12roles.wr.reason')}>{r.reason}</Field> : null}
      </SimpleGrid>
      {r.status !== 'PENDING' ? (
        <Stack gap={4} mt="sm">
          {r.decidedAt ? (
            <Text size="xs" c="dimmed">
              {r.decidedBy ? t('a12roles.wr.decided', { name: r.decidedBy.fullName, date: formatDateTime(r.decidedAt) }) : t('a12roles.wr.decidedAt', { date: formatDateTime(r.decidedAt) })}
            </Text>
          ) : null}
          {r.status === 'REJECTED' && r.decisionReason ? (
            <Text size="sm">
              <Text span c="dimmed" size="sm">
                {`${t('a12roles.wr.decisionReason')}: `}
              </Text>
              {r.decisionReason}
            </Text>
          ) : null}
        </Stack>
      ) : null}
      {approver ? (
        <Group mt="md" gap="sm" wrap="wrap">
          <Button leftSection={<IconCheck size={18} />} loading={approve.isPending} onClick={() => approve.mutate()} data-testid="worker-request-approve">
            {t('a12roles.wr.approve')}
          </Button>
          <Button variant="outline" color="breach" leftSection={<IconX size={18} />} onClick={() => onReject(r)} data-testid="worker-request-reject">
            {t('a12roles.wr.reject')}
          </Button>
        </Group>
      ) : null}
    </Card>
  );
}

function RejectRequestModal({ request, onClose }: { request: MemberRequestDto | null; onClose(): void }) {
  const api = useApi();
  const invalidate = useInvalidateMemberRequests();
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setReason('');
    setFieldError(null);
    setError(null);
    onClose();
  };
  const submit = async () => {
    if (!request) return;
    if (reason.trim().length < 3) {
      setFieldError(t('a12roles.req.reasonRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.memberRequests.reject(request.id, { reason: reason.trim() });
      await invalidate();
      notifications.show({ color: 'ok', message: t('a12roles.wr.rejected', { kind: kindLabel(request), name: workerName(request) }) });
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={Boolean(request)} onClose={close} title={request ? t('a12roles.wr.rejectTitle', { kind: kindLabel(request), name: workerName(request) }) : ''}>
      <Stack>
        <FormError error={error} />
        <Textarea
          label={t('a12roles.wr.rejectReason')}
          description={t('a12roles.wr.rejectHint')}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          error={fieldError}
          autosize
          minRows={3}
          withAsterisk
          data-autofocus
          data-testid="worker-request-reject-reason"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button color="breach" loading={busy} onClick={() => void submit()} data-testid="worker-request-reject-confirm">
            {t('a12roles.wr.reject')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

