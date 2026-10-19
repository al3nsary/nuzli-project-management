import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Menu,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconArchive,
  IconCheck,
  IconChevronDown,
  IconCrown,
  IconDots,
  IconFileImport,
  IconHelmet,
  IconHelmetOff,
  IconHistory,
  IconSitemap,
  IconUserMinus,
  IconPalette,
  IconPencil,
  IconUserPlus,
  IconUserShield,
  IconUsersGroup,
  IconX,
} from '@tabler/icons-react';
import {
  can,
  memberInputSchema,
  type ColorTakenDetails,
  type TeamColorDto,
  type MemberDto,
  type TeamDetailDto,
  type VisibilityMode,
} from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import {
  useAvailableColors,
  useInvalidateTeams,
  useReference,
  useSupervisorHistory,
  useSupervisors,
  useTeam,
} from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, FormError, Ltr, LoadingBlock } from '../../components/ui';
import { VestBand } from '../../theme/VestBand';
import { formatDate, formatDateTime, formatNumber, localizeDigits, t, tCount } from '../../i18n';
import { MemberDrawer } from '../members/MemberDrawer';
import { MemberAvatar, PhotoAvatar } from '../../components/UserAvatar';
import {
  ColorPicker,
  ForemanBadge,
  ReferenceInput,
  SupervisorAvatars,
  TeamStatusBadge,
  refFields,
  supervisorsOf,
} from './shared';
import { MembersImporter } from './MembersImporter';
import { useOverlayParam } from '../../lib/useUrlState';

type Dialog =
  | 'rename'
  | 'color'
  | 'addSupervisor'
  | 'orgUnit'
  | 'archive'
  | 'reject'
  | 'addMember'
  | 'import'
  | null;

function useTeamAction() {
  const invalidate = useInvalidateTeams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>, okMessage: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await invalidate();
      notifications.show({ color: 'ok', message: okMessage });
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function ReasonDialog({
  opened,
  onClose,
  title,
  body,
  confirm,
  onConfirm,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirm: string;
  onConfirm: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={opened} onClose={onClose} title={title}>
      <Stack>
        <Text>{body}</Text>
        <Textarea
          label={t('teams.reason')}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          error={error}
          autosize
          minRows={2}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            color="breach"
            loading={busy}
            onClick={async () => {
              if (reason.trim().length < 3) {
                setError(t('teams.reasonRequired'));
                return;
              }
              setBusy(true);
              const ok = await onConfirm(reason.trim());
              setBusy(false);
              if (ok) {
                setReason('');
                onClose();
              }
            }}
          >
            {confirm}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ColorDialog({ team, opened, onClose }: { team: TeamDetailDto; opened: boolean; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  // The team's own colour stays in the list (excludeTeamId); reserved ones never appear.
  const colors = useAvailableColors(team.id, opened);
  const [value, setValue] = useState<string | null>(team.color.id);
  const [override, setOverride] = useState<TeamColorDto[] | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const action = useTeamAction();
  return (
    <Modal opened={opened} onClose={onClose} title={t('teams.changeColor')} size="lg">
      <Stack>
        {taken ? (
          <Alert color="signal" icon={<IconAlertTriangle size={18} />} role="alert">
            {taken}
          </Alert>
        ) : (
          <FormError error={action.error} />
        )}
        <ColorPicker
          colors={override ?? colors.data}
          loading={colors.isLoading}
          value={value}
          onChange={(id) => {
            setValue(id);
            setTaken(null);
          }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={action.busy}
            disabled={!value || value === team.color.id}
            onClick={async () => {
              try {
                await api.teams.update(team.id, { colorId: value! });
              } catch (err) {
                if (err instanceof ApiError && err.code === 'COLOR_TAKEN') {
                  setOverride((err.details as ColorTakenDetails | undefined)?.available ?? null);
                  setValue(team.color.id);
                  setTaken(err.message_ar);
                  void qc.invalidateQueries({ queryKey: ['colors'] });
                  return;
                }
                action.setError(err);
                return;
              }
              const ok = await action.run(async () => undefined, t('teams.colorChanged'));
              if (ok) onClose();
            }}
          >
            {t('teams.saveColor')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function RenameDialog({ team, opened, onClose }: { team: TeamDetailDto; opened: boolean; onClose: () => void }) {
  const api = useApi();
  const [name, setName] = useState(team.name);
  const action = useTeamAction();
  return (
    <Modal opened={opened} onClose={onClose} title={t('teams.rename')}>
      <Stack>
        <FormError error={action.error} />
        <TextInput
          label={t('teams.name')}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={80}
          data-autofocus
          error={name.trim().length > 0 && name.trim().length < 2 ? t('teams.nameShort') : undefined}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={action.busy}
            disabled={name.trim().length < 2 || name.trim() === team.name}
            onClick={async () => {
              if (await action.run(() => api.teams.update(team.id, { name }), t('teams.renamed')))
                onClose();
            }}
          >
            {t('teams.saveName')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** A9 (ADR-100): add a supervisor — optionally as the new primary (the old one stays as co-supervisor). */
function AddSupervisorDialog({
  team,
  opened,
  onClose,
}: {
  team: TeamDetailDto;
  opened: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const supervisors = useSupervisors(opened);
  const current = new Set(supervisorsOf(team).map((s) => s.id));
  const [value, setValue] = useState<string | null>(null);
  const [primary, setPrimary] = useState(false);
  const [reason, setReason] = useState('');
  const action = useTeamAction();
  const close = () => {
    setValue(null);
    setPrimary(false);
    setReason('');
    action.setError(null);
    onClose();
  };
  return (
    <Modal opened={opened} onClose={close} title={t('teams.sup.addTitle', { team: team.name })}>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('teams.sup.addBody')}
        </Text>
        <FormError error={action.error} />
        <Select
          label={t('teams.sup.pick')}
          data={(supervisors.data ?? []).filter((s) => !current.has(s.id)).map((s) => ({ value: s.id, label: s.fullName }))}
          value={value}
          onChange={setValue}
          searchable
          nothingFoundMessage={t('teams.noSupervisors')}
          data-autofocus
        />
        <Checkbox
          label={t('teams.sup.makePrimary')}
          description={t('teams.sup.makePrimaryHint')}
          checked={primary}
          onChange={(e) => setPrimary(e.currentTarget.checked)}
        />
        <Textarea label={t('teams.reasonOptional')} value={reason} onChange={(e) => setReason(e.currentTarget.value)} autosize minRows={2} />
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={action.busy}
            disabled={!value}
            onClick={async () => {
              const ok = await action.run(
                () => api.teams.addSupervisor(team.id, { userId: value!, isPrimary: primary, reason: reason.trim() || undefined }),
                t('teams.sup.added'),
              );
              if (ok) close();
            }}
          >
            {t('teams.sup.addConfirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * A9 (ADR-100): remove a supervisor. The primary needs a successor (another current supervisor);
 * the last one cannot be removed — the API's Arabic message is shown as is.
 */
function RemoveSupervisorDialog({
  team,
  target,
  onClose,
}: {
  team: TeamDetailDto;
  target: { id: string; fullName: string; isPrimary?: boolean } | null;
  onClose: () => void;
}) {
  const api = useApi();
  const others = supervisorsOf(team).filter((s) => s.id !== target?.id);
  const [reason, setReason] = useState('');
  const [successor, setSuccessor] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const action = useTeamAction();
  const close = () => {
    setReason('');
    setSuccessor(null);
    setReasonError(null);
    action.setError(null);
    onClose();
  };
  return (
    <Modal opened={Boolean(target)} onClose={close} title={target ? t('teams.sup.removeTitle', { name: target.fullName }) : ''}>
      {target ? (
        <Stack>
          <Text size="sm">{target.isPrimary ? t('teams.sup.removePrimaryBody') : t('teams.sup.removeBody')}</Text>
          <FormError error={action.error} />
          {target.isPrimary ? (
            <Select
              label={t('teams.sup.successor')}
              description={t('teams.sup.successorHint')}
              withAsterisk
              data={others.map((s) => ({ value: s.id, label: s.fullName }))}
              value={successor}
              onChange={setSuccessor}
              nothingFoundMessage={t('teams.sup.noOthers')}
            />
          ) : null}
          <Textarea
            label={t('teams.reason')}
            withAsterisk
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            error={reasonError}
            autosize
            minRows={2}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              color="breach"
              loading={action.busy}
              onClick={async () => {
                if (reason.trim().length < 3) {
                  setReasonError(t('teams.reasonRequired'));
                  return;
                }
                setReasonError(null);
                const ok = await action.run(
                  () =>
                    api.teams.removeSupervisor(team.id, target.id, {
                      reason: reason.trim(),
                      newPrimaryUserId: target.isPrimary ? (successor ?? undefined) : undefined,
                    }),
                  t('teams.sup.removed', { name: target.fullName }),
                );
                if (ok) close();
              }}
            >
              {t('teams.sup.removeConfirm')}
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}

/** A9 (ADR-102): link the team to an organisational unit (admin). */
function OrgUnitDialog({ team, opened, onClose }: { team: TeamDetailDto; opened: boolean; onClose: () => void }) {
  const api = useApi();
  const org = useQuery({ queryKey: ['org', 'tree'], queryFn: () => api.org.tree(), enabled: opened });
  const [value, setValue] = useState<string | null>(team.orgUnit?.id ?? null);
  const action = useTeamAction();
  return (
    <Modal opened={opened} onClose={onClose} title={t('teams.org.title')}>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('teams.org.body')}
        </Text>
        <FormError error={action.error} />
        <Select
          label={t('teams.org.unit')}
          placeholder={t('teams.org.none')}
          data={(org.data?.units ?? []).map((u) => ({ value: u.id, label: u.name }))}
          value={value}
          onChange={setValue}
          clearable
          searchable
          nothingFoundMessage={t('teams.org.noUnits')}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={action.busy}
            disabled={value === (team.orgUnit?.id ?? null)}
            onClick={async () => {
              if (await action.run(() => api.teams.update(team.id, { orgUnitId: value }), t('teams.org.saved'))) onClose();
            }}
          >
            {t('teams.org.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** A9: the team's current supervisors (primary first) with the admin actions. */
function SupervisorsCard({
  team,
  isAdmin,
  archived,
  onAdd,
  onRemove,
}: {
  team: TeamDetailDto;
  isAdmin: boolean;
  archived: boolean;
  onAdd: () => void;
  onRemove: (s: { id: string; fullName: string; isPrimary?: boolean }) => void;
}) {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const action = useTeamAction();
  const list = supervisorsOf(team);
  return (
    <Card mt="md">
      <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
        <Group gap="xs">
          <IconUserShield size={20} aria-hidden />
          <Title order={2} fz="lg">
            {t('teams.sup.title')}
          </Title>
          <Badge variant="light" color="slate" size="sm">
            {formatNumber(list.length)}
          </Badge>
        </Group>
        {isAdmin && !archived ? (
          <Button size="sm" variant="light" leftSection={<IconUserPlus size={16} />} onClick={onAdd}>
            {t('teams.sup.add')}
          </Button>
        ) : null}
      </Group>
      <FormError error={action.error} />
      <ul className="nz-sup-list">
        {list.map((s) => {
          const full = team.supervisors?.find((x) => x.id === s.id);
          return (
            <li key={s.id} className="nz-sup-row" data-primary={s.isPrimary || undefined}>
              <PhotoAvatar
                target={s.id === user?.id ? { kind: 'me', id: s.id } : { kind: 'user', id: s.id }}
                name={s.fullName}
                hasPhoto={s.hasPhoto}
                size={36}
                ring={Boolean(s.isPrimary)}
              />
              <div className="nz-sup-main">
                <span className="nz-sup-name">
                  {s.fullName}
                  {s.isPrimary ? (
                    <Badge size="xs" variant="filled" color="field" leftSection={<IconCrown size={11} aria-hidden />}>
                      {t('teams.sup.primary')}
                    </Badge>
                  ) : null}
                </span>
                {full?.since ? (
                  <Text size="xs" c="dimmed">
                    {t('teams.sup.since', { date: formatDate(full.since) })}
                  </Text>
                ) : null}
              </div>
              {isAdmin && !archived ? (
                <Menu position="bottom-end" width={230} shadow="md">
                  <Menu.Target>
                    <ActionIcon variant="subtle" size={36} aria-label={t('teams.sup.actionsOf', { name: s.fullName })}>
                      <IconDots size={18} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {!s.isPrimary ? (
                      <Menu.Item
                        leftSection={<IconCrown size={16} />}
                        onClick={() =>
                          void action.run(() => api.teams.setPrimarySupervisor(team.id, s.id, {}), t('teams.sup.primarySet', { name: s.fullName }))
                        }
                      >
                        {t('teams.sup.makePrimaryAction')}
                      </Menu.Item>
                    ) : null}
                    <Menu.Item color="breach" leftSection={<IconUserMinus size={16} />} onClick={() => onRemove(s)}>
                      {t('teams.sup.remove')}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function AddMemberDialog({ team, opened, onClose }: { team: TeamDetailDto; opened: boolean; onClose: () => void }) {
  const api = useApi();
  const jobTitles = useReference('job-titles');
  const departments = useReference('departments');
  const [fullName, setFullName] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const action = useTeamAction();

  const submit = async () => {
    const input = {
      fullName,
      nationalId,
      ...refFields(jobTitle, jobTitles.data, 'jobTitleId', 'jobTitleText'),
      ...refFields(department, departments.data, 'departmentId', 'departmentText'),
    };
    const parsed = memberInputSchema.safeParse(input);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    let fieldErrs: Record<string, string> = {};
    const ok = await action.run(async () => {
      try {
        await api.teams.addMember(team.id, input);
      } catch (err) {
        if (err instanceof ApiError) fieldErrs = err.fieldErrors;
        throw err;
      }
    }, t('members.added', { name: fullName }));
    setErrors(fieldErrs);
    if (ok) {
      setFullName('');
      setNationalId('');
      setJobTitle('');
      setDepartment('');
      onClose();
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('members.addTitle', { team: team.name })}>
      <Stack gap="sm">
        <FormError error={action.error} />
        <TextInput
          label={t('members.fullName')}
          value={fullName}
          onChange={(e) => setFullName(e.currentTarget.value)}
          error={errors.fullName}
          data-autofocus
        />
        <TextInput
          label={t('members.nationalId')}
          description={t('register.nationalIdHint')}
          value={nationalId}
          onChange={(e) => setNationalId(e.currentTarget.value)}
          error={errors.nationalId}
          inputMode="numeric"
          classNames={{ input: 'ltr mono' }}
        />
        <ReferenceInput kind="job-titles" label={t('members.jobTitle')} value={jobTitle} onChange={setJobTitle} />
        <ReferenceInput
          kind="departments"
          label={t('members.department')}
          value={department}
          onChange={setDepartment}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={action.busy} onClick={() => void submit()}>
            {t('members.add')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ImportDialog({ team, opened, onClose }: { team: TeamDetailDto; opened: boolean; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateTeams();
  const mobile = useMediaQuery('(max-width: 48em)');
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('members.importTitle', { team: team.name })}
      size="xl"
      fullScreen={mobile}
    >
      {opened ? (
        <MembersImporter
          onPreview={async (rows) =>
            (await api.teams.importMembers({ teamId: team.id, rows, commit: false })).results
          }
          onCommit={async (rows) => {
            const res = await api.teams.importMembers({ teamId: team.id, rows, commit: true });
            await invalidate();
            return res;
          }}
          extraActions={
            <Button variant="default" onClick={onClose}>
              {t('common.close')}
            </Button>
          }
        />
      ) : null}
    </Modal>
  );
}

function SupervisorHistory({ teamId }: { teamId: string }) {
  const history = useSupervisorHistory(teamId);
  if (history.isLoading) return <LoadingBlock variant="list" rows={3} />;
  if (history.isError) return <ErrorBlock error={history.error} />;
  return (
    <Table.ScrollContainer minWidth={520}>
      <Table fz="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('teams.supervisor')}</Table.Th>
            <Table.Th>{t('teams.sup.role')}</Table.Th>
            <Table.Th>{t('teams.history.from')}</Table.Th>
            <Table.Th>{t('teams.history.to')}</Table.Th>
            <Table.Th>{t('teams.history.by')}</Table.Th>
            <Table.Th>{t('teams.reason')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(history.data ?? []).map((h) => (
            <Table.Tr key={h.id}>
              <Table.Td fw={500}>{h.supervisor.fullName}</Table.Td>
              <Table.Td>
                {h.isPrimary ? (
                  <Badge size="sm" variant="light" color="field">
                    {t('teams.sup.primary')}
                  </Badge>
                ) : (
                  <Text size="sm" c="dimmed">
                    {t('teams.sup.co')}
                  </Text>
                )}
              </Table.Td>
              <Table.Td className="mono">{formatDateTime(h.validFrom)}</Table.Td>
              <Table.Td className="mono">
                {h.validTo ? formatDateTime(h.validTo) : t('teams.history.current')}
              </Table.Td>
              <Table.Td>{h.changedBy?.fullName ?? t('common.system')}</Table.Td>
              <Table.Td>{h.reason ?? t('common.none')}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

const VISIBILITY: VisibilityMode[] = ['INHERIT', 'SHOW', 'HIDE'];

/** A9 (ADR-101): set or clear the worker foreman (admin or a leading supervisor). */
function ForemanAction({
  team,
  member,
  run,
}: {
  team: TeamDetailDto;
  member: MemberDto;
  run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;
}) {
  const api = useApi();
  if (member.isForeman) {
    return (
      <Button
        variant="subtle"
        size="compact-sm"
        color="slate"
        leftSection={<IconHelmetOff size={16} />}
        onClick={() => void run(() => api.teams.clearForeman(team.id), t('teams.foreman.cleared', { name: member.fullName }))}
        aria-label={t('teams.foreman.clearOf', { name: member.fullName })}
      >
        {t('teams.foreman.clear')}
      </Button>
    );
  }
  return (
    <Button
      variant="subtle"
      size="compact-sm"
      leftSection={<IconHelmet size={16} />}
      onClick={() => void run(() => api.teams.setForeman(team.id, member.id), t('teams.foreman.set', { name: member.fullName }))}
      aria-label={t('teams.foreman.setOf', { name: member.fullName })}
    >
      {t('teams.foreman.setShort')}
    </Button>
  );
}

export function TeamDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const team = useTeam(id);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [removing, setRemoving] = useState<{ id: string; fullName: string; isPrimary?: boolean } | null>(null);
  const member = useOverlayParam('member');
  const action = useTeamAction();

  if (team.isLoading) return <LoadingBlock variant="detail" header />;
  if (team.isError || !team.data) return <ErrorBlock error={team.error} onRetry={() => void team.refetch()} />;
  const tm = team.data;
  const isAdmin = can(user, 'teams.manageAll');
  // A9 (ADR-100): any current supervisor (primary or co-supervisor) leads the team.
  const own = supervisorsOf(tm).some((s) => s.id === user?.id);
  const manageable = isAdmin || (can(user, 'teams.manageOwn') && own);
  const membersManageable = can(user, 'members.manage') || (can(user, 'members.manageOwn') && own);
  const archived = tm.status === 'ARCHIVED';
  const close = () => setDialog(null);

  return (
    <>
      <VestBand color={tm.color.hex} className="surface-card nz-team-header">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Box style={{ minWidth: 0, flex: '1 1 280px' }}>
            <Group gap="sm" wrap="wrap">
              <Title order={1} tabIndex={-1}>
                {tm.name}
              </Title>
              <TeamStatusBadge status={tm.status} />
            </Group>
            <Group gap="lg" mt={6} wrap="wrap">
              <Text c="dimmed">{t('teams.colorName', { name: tm.color.name })}</Text>
              <Group gap={8} wrap="nowrap">
                <Text c="dimmed" size="sm">
                  {t('teams.sup.label')}
                </Text>
                <SupervisorAvatars supervisors={supervisorsOf(tm)} size={30} withNames selfId={user?.id} />
              </Group>
              {tm.orgUnit ? (
                <Group gap={4} wrap="nowrap">
                  <IconSitemap size={16} aria-hidden color="var(--accent)" />
                  <Text size="sm">{tm.orgUnit.name}</Text>
                </Group>
              ) : null}
              <Text className="num">{tCount('teams.memberCount', tm.memberCount)}</Text>
              <Text c="dimmed" size="sm">
                {t('teams.createdAt', { date: formatDate(tm.createdAt) })}
              </Text>
            </Group>
          </Box>
          {!archived && (manageable || membersManageable) ? (
            <Group gap="xs" wrap="wrap">
              {tm.status === 'PENDING_APPROVAL' && can(user, 'teams.approve') ? (
                <>
                  <Button
                    color="ok"
                    leftSection={<IconCheck size={18} />}
                    loading={action.busy}
                    onClick={() => void action.run(() => api.teams.approve(tm.id), t('teams.approved', { name: tm.name }))}
                  >
                    {t('teams.approve')}
                  </Button>
                  <Button
                    color="breach"
                    variant="light"
                    leftSection={<IconX size={18} />}
                    onClick={() => setDialog('reject')}
                  >
                    {t('teams.reject')}
                  </Button>
                </>
              ) : null}
              {membersManageable ? (
                <Button leftSection={<IconUserPlus size={18} />} variant="light" onClick={() => setDialog('addMember')}>
                  {t('members.add')}
                </Button>
              ) : null}
              {manageable ? (
                <Menu position="bottom-end" width={240} shadow="md">
                  <Menu.Target>
                    <Button variant="default" rightSection={<IconChevronDown size={16} />}>
                      {t('teams.more')}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {membersManageable ? (
                      <Menu.Item leftSection={<IconFileImport size={18} />} onClick={() => setDialog('import')}>
                        {t('members.import')}
                      </Menu.Item>
                    ) : null}
                    <Menu.Item leftSection={<IconPencil size={18} />} onClick={() => setDialog('rename')}>
                      {t('teams.rename')}
                    </Menu.Item>
                    <Menu.Item leftSection={<IconPalette size={18} />} onClick={() => setDialog('color')}>
                      {t('teams.changeColor')}
                    </Menu.Item>
                    {isAdmin ? (
                      <Menu.Item leftSection={<IconUserShield size={18} />} onClick={() => setDialog('addSupervisor')}>
                        {t('teams.sup.add')}
                      </Menu.Item>
                    ) : null}
                    {isAdmin ? (
                      <Menu.Item leftSection={<IconSitemap size={18} />} onClick={() => setDialog('orgUnit')}>
                        {t('teams.org.title')}
                      </Menu.Item>
                    ) : null}
                    <Menu.Divider />
                    <Menu.Item color="breach" leftSection={<IconArchive size={18} />} onClick={() => setDialog('archive')}>
                      {t('teams.archive')}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              ) : null}
            </Group>
          ) : null}
        </Group>
        <FormError error={action.error} />
      </VestBand>

      {archived ? (
        <Alert color="slate" mt="md" icon={<IconArchive size={18} />}>
          {t('teams.archivedNote')}
        </Alert>
      ) : null}

      {isAdmin && !archived ? (
        <Card mt="md">
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Box style={{ flex: '1 1 260px' }}>
              <Text fw={600}>{t('teams.visibility')}</Text>
              <Text size="sm" c="dimmed">
                {t('teams.visibilityHint')}
              </Text>
            </Box>
            <Select
              aria-label={t('teams.visibility')}
              w={240}
              allowDeselect={false}
              value={tm.violationVisibility ?? 'INHERIT'}
              data={VISIBILITY.map((v) => ({ value: v, label: t(`teams.visibility.${v}`) }))}
              onChange={(v) =>
                v &&
                void action.run(
                  () => api.teams.setViolationVisibility(tm.id, v as VisibilityMode),
                  t('common.saved'),
                )
              }
            />
          </Group>
        </Card>
      ) : null}

      <SupervisorsCard
        team={tm}
        isAdmin={isAdmin}
        archived={archived}
        onAdd={() => setDialog('addSupervisor')}
        onRemove={setRemoving}
      />

      <Card mt="md">
        <Group justify="space-between" mb="sm">
          <Group gap="xs">
            <IconUsersGroup size={20} aria-hidden />
            <Title order={2} fz="lg">
              {t('teams.members')}
            </Title>
          </Group>
          <Text size="sm" c="dimmed">
            {t('teams.memberHistoryHint')}
          </Text>
        </Group>
        {tm.members.length === 0 ? (
          <EmptyState
            icon={IconUsersGroup}
            title={t('teams.noMembers')}
            action={
              membersManageable && !archived
                ? { label: t('members.import'), onClick: () => setDialog('import') }
                : undefined
            }
          />
        ) : (
          <Table.ScrollContainer minWidth={560}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('members.fullName')}</Table.Th>
                  <Table.Th>{t('members.nationalId')}</Table.Th>
                  <Table.Th>{t('members.jobTitle')}</Table.Th>
                  <Table.Th>{t('members.department')}</Table.Th>
                  <Table.Th w={manageable && !archived ? 200 : 140}>{t('members.history')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {tm.members.map((m) => (
                  <Table.Tr key={m.id} className={m.isForeman ? 'nz-foreman-row' : undefined}>
                    <Table.Td fw={500}>
                      <Group gap={8} wrap="nowrap">
                        <UnstyledButton
                          onClick={() => member.open(m.id)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600 }}
                        >
                          <MemberAvatar member={m} size={28} />
                          {m.fullName}
                        </UnstyledButton>
                        {m.isForeman ? <ForemanBadge /> : null}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Ltr mono>{localizeDigits(m.nationalIdMasked)}</Ltr>
                    </Table.Td>
                    <Table.Td>{m.jobTitle ?? t('common.none')}</Table.Td>
                    <Table.Td>{m.department ?? t('common.none')}</Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Button
                          variant="subtle"
                          size="compact-sm"
                          leftSection={<IconHistory size={16} />}
                          onClick={() => member.open(m.id)}
                          aria-label={t('members.historyOf', { name: m.fullName })}
                        >
                          {t('members.history')}
                        </Button>
                        {manageable && !archived ? <ForemanAction team={tm} member={m} run={action.run} /> : null}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        <Text size="xs" c="dimmed" mt="xs">
          {t('common.total', { count: formatNumber(tm.members.length) })}
        </Text>
      </Card>

      <Card mt="md">
        <Group gap="xs" mb="sm">
          <IconUserShield size={20} aria-hidden />
          <Title order={2} fz="lg">
            {t('teams.supervisorHistory')}
          </Title>
        </Group>
        <SupervisorHistory teamId={tm.id} />
      </Card>

      <RenameDialog key={`r${tm.name}`} team={tm} opened={dialog === 'rename'} onClose={close} />
      <ColorDialog key={`c${tm.color.id}${dialog}`} team={tm} opened={dialog === 'color'} onClose={close} />
      <AddSupervisorDialog team={tm} opened={dialog === 'addSupervisor'} onClose={close} />
      <RemoveSupervisorDialog team={tm} target={removing} onClose={() => setRemoving(null)} />
      <OrgUnitDialog key={`o${tm.orgUnit?.id ?? ''}${dialog}`} team={tm} opened={dialog === 'orgUnit'} onClose={close} />
      <AddMemberDialog team={tm} opened={dialog === 'addMember'} onClose={close} />
      <ImportDialog team={tm} opened={dialog === 'import'} onClose={close} />
      <ReasonDialog
        opened={dialog === 'archive'}
        onClose={close}
        title={t('teams.archiveTitle', { name: tm.name })}
        body={t('teams.archiveBody')}
        confirm={t('teams.archiveConfirm')}
        onConfirm={(reason) =>
          action.run(() => api.teams.archive(tm.id, { reason }), t('teams.archived', { name: tm.name }))
        }
      />
      <ReasonDialog
        opened={dialog === 'reject'}
        onClose={close}
        title={t('teams.rejectTitle', { name: tm.name })}
        body={t('teams.rejectBody')}
        confirm={t('teams.rejectConfirm')}
        onConfirm={(reason) =>
          action.run(() => api.teams.reject(tm.id, { reason }), t('teams.rejected', { name: tm.name }))
        }
      />
      <MemberDrawer memberId={member.value} onClose={member.close} />
    </>
  );
}

