import { useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Divider,
  Drawer,
  Group,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Timeline,
  Title,
  useDirection,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconEye, IconHistory } from '@tabler/icons-react';
import { can, updateMemberSchema, type MemberDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import {
  useInvalidateTeams,
  useMember,
  useMemberHistory,
  useReference,
} from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { ErrorBlock, FormError, Ltr } from '../../components/ui';
import { TeamBadge } from '../../theme/TeamBadge';
import { formatDateTime, localizeDigits, t } from '../../i18n';
import { ReferenceInput, refFields } from '../teams/shared';

/** Membership history (brief §5.3): newest first; the open row is the current team. */
export function MembershipTimeline({ memberId }: { memberId: string }) {
  const history = useMemberHistory(memberId);
  if (history.isLoading) return <Skeleton h={80} />;
  if (history.isError) return <ErrorBlock error={history.error} />;
  if (!history.data?.length)
    return (
      <Text size="sm" c="dimmed">
        {t('members.noHistory')}
      </Text>
    );
  return (
    <Timeline active={0} bulletSize={14} lineWidth={2} color="field">
      {history.data.map((h) => (
        <Timeline.Item
          key={h.id}
          title={<TeamBadge name={h.team.name} color={h.team.color.hex} size="sm" />}
        >
          <Text size="sm" mt={4}>
            {h.validTo
              ? t('members.historyRange', {
                  from: formatDateTime(h.validFrom),
                  to: formatDateTime(h.validTo),
                })
              : t('members.historySince', { from: formatDateTime(h.validFrom) })}
          </Text>
          {h.validTo === null ? (
            <Badge color="ok" variant="light" size="sm" mt={4}>
              {t('members.current')}
            </Badge>
          ) : null}
          {h.movedBy ? (
            <Text size="xs" c="dimmed">
              {t('members.movedBy', { name: h.movedBy.fullName })}
            </Text>
          ) : null}
          {h.reason ? (
            <Text size="xs" c="dimmed">
              {t('members.reason', { reason: h.reason })}
            </Text>
          ) : null}
        </Timeline.Item>
      ))}
    </Timeline>
  );
}

function canManage(user: ReturnType<typeof useAuthStore.getState>['user'], m: MemberDto) {
  if (can(user, 'members.manage')) return true;
  // A supervisor edits members of the teams they lead; the API checks the team.
  return Boolean(m.team) && can(user, 'members.manageOwn');
}

function EditMember({ member, onDone }: { member: MemberDto; onDone: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateTeams();
  const jobTitles = useReference('job-titles');
  const departments = useReference('departments');
  const [fullName, setFullName] = useState(member.fullName);
  const [nationalId, setNationalId] = useState('');
  const [jobTitle, setJobTitle] = useState(member.jobTitle ?? '');
  const [department, setDepartment] = useState(member.department ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const input = {
      fullName,
      ...(nationalId.trim() ? { nationalId } : {}),
      jobTitleId: undefined,
      jobTitleText: '',
      departmentId: undefined,
      departmentText: '',
      ...refFields(jobTitle, jobTitles.data, 'jobTitleId', 'jobTitleText'),
      ...refFields(department, departments.data, 'departmentId', 'departmentText'),
    };
    const parsed = updateMemberSchema.safeParse(input);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setError(null);
    setBusy(true);
    try {
      await api.members.update(member.id, input);
      await invalidate();
      notifications.show({ color: 'ok', message: t('members.saved', { name: fullName }) });
      onDone();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="sm">
      <FormError error={error} />
      <TextInput
        label={t('members.fullName')}
        value={fullName}
        onChange={(e) => setFullName(e.currentTarget.value)}
        error={errors.fullName}
      />
      <TextInput
        label={t('members.newNationalId')}
        description={t('members.newNationalIdHint')}
        value={nationalId}
        onChange={(e) => setNationalId(e.currentTarget.value)}
        error={errors.nationalId}
        inputMode="numeric"
        classNames={{ input: 'ltr mono' }}
      />
      <ReferenceInput
        kind="job-titles"
        label={t('members.jobTitle')}
        value={jobTitle}
        onChange={setJobTitle}
      />
      <ReferenceInput
        kind="departments"
        label={t('members.department')}
        value={department}
        onChange={setDepartment}
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button loading={busy} onClick={() => void submit()}>
          {t('members.save')}
        </Button>
      </Group>
    </Stack>
  );
}

/** Member details, edit and membership history — opened from tables, boards and search. */
export function MemberDrawer({ memberId, onClose }: { memberId: string | null; onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const mobile = useMediaQuery('(max-width: 48em)');
  const member = useMember(memberId);
  const [editing, setEditing] = useState(false);
  const [showId, setShowId] = useState(false);
  // Drawer position is physical: open it on the inline-end side.
  const { dir } = useDirection();

  useEffect(() => {
    setEditing(false);
    setShowId(false);
  }, [memberId]);

  const m = member.data;
  return (
    <Drawer
      opened={Boolean(memberId)}
      onClose={onClose}
      position={dir === 'rtl' ? 'left' : 'right'}
      size={mobile ? '100%' : 'md'}
      title={t('members.detailTitle')}
    >
      {member.isLoading ? (
        <Stack>
          <Skeleton h={28} />
          <Skeleton h={80} />
        </Stack>
      ) : member.isError ? (
        <ErrorBlock error={member.error} onRetry={() => void member.refetch()} />
      ) : m ? (
        <Stack gap="md">
          <Box>
            <Title order={3}>{m.fullName}</Title>
            <Group gap="xs" mt={6}>
              {m.team ? (
                <TeamBadge name={m.team.name} color={m.team.color.hex} />
              ) : (
                <Badge color="slate" variant="outline">
                  {t('formation.unassigned')}
                </Badge>
              )}
            </Group>
          </Box>
          {editing ? (
            <EditMember member={m} onDone={() => setEditing(false)} />
          ) : (
            <Stack gap={6}>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" c="dimmed" w={110}>
                  {t('members.nationalId')}
                </Text>
                <Ltr mono>
                  {localizeDigits(showId && m.nationalId ? m.nationalId : m.nationalIdMasked)}
                </Ltr>
                {m.nationalId && !showId ? (
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    leftSection={<IconEye size={14} />}
                    onClick={() => setShowId(true)}
                  >
                    {t('reg.showFullId')}
                  </Button>
                ) : null}
              </Group>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" c="dimmed" w={110}>
                  {t('members.jobTitle')}
                </Text>
                <Text size="sm">{m.jobTitle ?? t('common.none')}</Text>
              </Group>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" c="dimmed" w={110}>
                  {t('members.department')}
                </Text>
                <Text size="sm">{m.department ?? t('common.none')}</Text>
              </Group>
              {canManage(user, m) ? (
                <Group mt="xs">
                  <Button variant="light" onClick={() => setEditing(true)}>
                    {t('members.edit')}
                  </Button>
                </Group>
              ) : null}
            </Stack>
          )}
          <Divider />
          <Group gap="xs">
            <IconHistory size={18} aria-hidden />
            <Title order={4}>{t('members.history')}</Title>
          </Group>
          <MembershipTimeline memberId={m.id} />
        </Stack>
      ) : null}
    </Drawer>
  );
}
