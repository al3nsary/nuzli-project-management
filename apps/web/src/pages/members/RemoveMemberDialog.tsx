/**
 * A12 round 2 — removing a worker (`POST /members/:id/archive { reason }`): an admin
 * (`members.manage`) archives at once; a supervisor of the worker's team (`members.manageOwn`)
 * sends a REMOVE request (202) that an approver decides — the worker stays until then.
 */
import { useState } from 'react';
import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { can } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { isMemberRequestAccepted } from '../../api/client';
import { useInvalidateTeams } from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { FormError } from '../../components/ui';
import { t } from '../../i18n';
import { useInvalidateMemberRequests } from '../requests/MemberRequests';

/** True when the signed-in user removes directly (admins); false = a removal request (supervisors). */
export function useRemovesDirectly(): boolean {
  return can(useAuthStore((s) => s.user), 'members.manage');
}

export function RemoveMemberDialog({ member, onClose, onDone }: { member: { id: string; fullName: string } | null; onClose(): void; onDone?(): void }) {
  const api = useApi();
  const direct = useRemovesDirectly();
  const invalidateTeams = useInvalidateTeams();
  const invalidateRequests = useInvalidateMemberRequests();
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
    if (!member) return;
    if (reason.trim().length < 3) {
      setFieldError(t('a12roles.req.reasonRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.members.archive(member.id, { reason: reason.trim() });
      if (isMemberRequestAccepted(res)) {
        await invalidateRequests();
        notifications.show({ color: 'ok', message: t('a12roles.req.sent') });
      } else {
        await invalidateTeams();
        notifications.show({ color: 'ok', message: t('a12roles.req.removed', { name: member.fullName }) });
      }
      onDone?.();
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      opened={Boolean(member)}
      onClose={close}
      title={member ? (direct ? t('a12roles.req.removeDirectTitle', { name: member.fullName }) : t('a12roles.req.removeRequestTitle', { name: member.fullName })) : ''}
    >
      <Stack>
        <Text size="sm">{direct ? t('a12roles.req.removeDirectBody') : t('a12roles.req.removeRequestBody')}</Text>
        <FormError error={error} />
        <Textarea
          label={t('a12roles.req.reason')}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          error={fieldError}
          autosize
          minRows={2}
          withAsterisk
          data-autofocus
          data-testid="member-remove-reason"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button color="breach" loading={busy} onClick={() => void submit()} data-testid="member-remove-confirm">
            {direct ? t('a12roles.req.removeDirectConfirm') : t('a12roles.req.removeRequestConfirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
