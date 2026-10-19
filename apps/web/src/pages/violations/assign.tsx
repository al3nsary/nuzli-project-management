import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconId,
  IconLink,
  IconRefresh,
  IconScan,
  IconUserMinus,
  IconUserPlus,
  IconUserQuestion,
} from '@tabler/icons-react';
import {
  can,
  isValidNationalId,
  registerViolationMemberSchema,
  type OcrFieldDto,
  type ViolationDto,
  type ViolationOcrDto,
  type ViolationSuggestionDto,
} from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { useAllMembers, useInvalidateTeams, useInvalidateViolations, useReference, useTeams } from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { FormError } from '../../components/ui';
import { MemberAvatar } from '../../components/UserAvatar';
import { TeamBadge } from '../../theme/TeamBadge';
import { formatDateTime, formatNumber, localizeDigits, t, tKey } from '../../i18n';
import { offlineDb, type RosterRow } from '../../features/violations/offline/db';
import { ReferenceInput, refFields } from '../teams/shared';
import './violations-a9.css';

/** «غير مُسندة»: recorded without a person, waiting to be assigned (ADR-103). */
export function UnassignedBadge({ size = 'sm' }: { size?: 'xs' | 'sm' | 'md' }) {
  return (
    <Badge color="signal" variant="light" size={size} leftSection={<IconUserQuestion size={12} aria-hidden />}>
      {t('violations.unassigned')}
    </Badge>
  );
}

/** The people who assign: admins and the recorder (any time, per the API). */
export function canAssign(user: { id: string; role: string; status?: string } | null, v: ViolationDto): boolean {
  if (!user) return false;
  return can(user as never, 'violations.manage') || (can(user as never, 'violations.create') && v.recordedBy.id === user.id);
}

const confColor = (c: number) => (c >= 80 ? 'ok' : c >= 50 ? 'signal' : 'breach');

function FieldRow({ label, field, mono, suffix }: { label: string; field: OcrFieldDto | null; mono?: boolean; suffix?: string }) {
  return (
    <Box className="nz-ocr-field">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        {field ? (
          <Text size="xs" c="dimmed" className="num" aria-label={t('ocr.confidenceAria', { n: field.confidence })}>
            {t('ocr.confidence', { n: formatNumber(field.confidence) })}
          </Text>
        ) : null}
      </Group>
      {field ? (
        <>
          <Text fw={600} className={mono ? 'mono ltr' : undefined} style={mono ? { textAlign: 'start' } : undefined}>
            {mono ? localizeDigits(field.value) : field.value}
            {suffix ? (
              <Text span size="xs" c="dimmed" fw={400}>
                {' '}
                {suffix}
              </Text>
            ) : null}
          </Text>
          <Progress value={field.confidence} color={confColor(field.confidence)} size={4} radius="xl" mt={4} aria-hidden />
        </>
      ) : (
        <Text size="sm" c="dimmed">
          {t('ocr.notRead')}
        </Text>
      )}
    </Box>
  );
}

function Suggestion({ s, busy, onAssign }: { s: ViolationSuggestionDto; busy: boolean; onAssign: () => void }) {
  return (
    <li className="nz-ocr-sug">
      <MemberAvatar member={{ id: s.memberId, fullName: s.fullName, hasPhoto: s.hasPhoto }} size={36} />
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Text fw={600} truncate>
          {s.fullName}
        </Text>
        <Group gap={6} wrap="wrap">
          <Text size="xs" c="dimmed" className="mono ltr">
            {localizeDigits(s.nationalIdMasked)}
          </Text>
          {s.team ? <TeamBadge name={s.team.name} color={s.team.color.hex} size="sm" /> : <Text size="xs" c="dimmed">{t('record.member.noTeam')}</Text>}
          <Badge size="xs" variant={s.match === 'NATIONAL_ID' ? 'filled' : 'light'} color={s.match === 'NATIONAL_ID' ? 'ok' : 'field'}>
            {s.match === 'NATIONAL_ID' ? t('ocr.matchId') : t('ocr.matchName', { n: formatNumber(Math.round(s.score * 100)) })}
          </Badge>
        </Group>
      </Box>
      <Button size="compact-md" leftSection={<IconLink size={15} />} loading={busy} onClick={onAssign} aria-label={t('ocr.assignTo', { name: s.fullName })}>
        {t('ocr.assign')}
      </Button>
    </li>
  );
}

/**
 * «بيانات البطاقة (قراءة آلية)» + assignment of a violation recorded without a person
 * (owner request A9, ADR-103/104). For admins and the recorder: the OCR state (reading · done ·
 * failed + retry for admins), the extracted fields with their confidence, the number masked for
 * non-admins, suggested members (exact ID match first, then similar names) with «إسناد», a manual
 * picker, and — for admins — «تسجيل عضو جديد من البطاقة» prefilled from the card. Polls the
 * violation (not the audited OCR view) while the reading runs.
 */
export function AssignSection({ v }: { v: ViolationDto }) {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const invalidate = useInvalidateViolations();
  const invalidateTeams = useInvalidateTeams();
  const isAdmin = can(user, 'violations.manage');
  const canRegister = can(user, 'members.manage');
  const status = v.ocrStatus ?? null;
  const reading = status === 'PENDING' || status === 'RUNNING';
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [registering, setRegistering] = useState(false);

  const ocr = useQuery({
    queryKey: ['violation', v.id, 'ocr', status],
    queryFn: () => api.violations.ocr(v.id),
    enabled: !reading,
    staleTime: Infinity,
    retry: false,
  });

  const assign = (memberId: string, name: string) =>
    modals.openConfirmModal({
      title: t('ocr.confirmTitle', { name }),
      children: <Text size="sm">{t('ocr.confirmBody', { at: formatDateTime(v.capturedAt) })}</Text>,
      labels: { confirm: t('ocr.assignConfirm'), cancel: t('common.cancel') },
      onConfirm: async () => {
        setBusy(memberId);
        setError(null);
        try {
          await api.violations.assign(v.id, { memberId });
          await invalidate();
          notifications.show({ color: 'ok', message: t('ocr.assigned', { name }) });
        } catch (err) {
          setError(err);
        } finally {
          setBusy(null);
        }
      },
    });

  const data = ocr.data;
  const f = data?.fields;
  const statusLine = reading ? (
    <Badge color="field" variant="light" leftSection={<Loader size={10} color="field" />}>
      {t('ocr.status.reading')}
    </Badge>
  ) : status === 'DONE' ? (
    <Badge color="ok" variant="light" leftSection={<IconCircleCheck size={12} />}>
      {t('ocr.status.done')}
    </Badge>
  ) : status === 'FAILED' ? (
    <Badge color="breach" variant="light" leftSection={<IconAlertTriangle size={12} />}>
      {t('ocr.status.failed')}
    </Badge>
  ) : (
    <Badge color="slate" variant="light">
      {t('ocr.status.none')}
    </Badge>
  );

  return (
    <Card padding="md" className="nz-assign" withBorder>
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Group gap={8} wrap="nowrap">
            <IconScan size={20} color="var(--accent)" aria-hidden />
            <Title order={4} fz="md">
              {t('ocr.title')}
            </Title>
          </Group>
          <span role="status" aria-live="polite">
            {statusLine}
          </span>
        </Group>
        {reading ? (
          <Text size="sm" c="dimmed">
            {t('ocr.readingBody')}
          </Text>
        ) : null}
        {status === 'FAILED' ? (
          <Alert color="breach" icon={<IconAlertTriangle size={16} />} p="xs">
            <Text size="sm">{t('ocr.failedBody', { reason: ocrReason(data?.error) })}</Text>
          </Alert>
        ) : null}
        {isAdmin && (status === 'FAILED' || status === 'DONE') ? (
          <Group>
            <Button
              size="compact-sm"
              variant="subtle"
              leftSection={<IconRefresh size={14} />}
              loading={busy === 'retry'}
              onClick={async () => {
                setBusy('retry');
                setError(null);
                try {
                  await api.violations.retryOcr(v.id);
                  await invalidate();
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {t('ocr.retry')}
            </Button>
          </Group>
        ) : null}
        {ocr.isLoading && !reading ? <Loader size="sm" /> : null}
        {f && status === 'DONE' ? (
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm" verticalSpacing="sm">
            <FieldRow
              label={f.nationalId?.kind === 'RESIDENT' ? t('ocr.f.iqama') : t('ocr.f.nationalId')}
              field={f.nationalId ? { value: f.nationalId.value, confidence: f.nationalId.confidence } : null}
              mono
              suffix={f.nationalId && !f.nationalId.full ? t('ocr.masked') : undefined}
            />
            <FieldRow label={t('ocr.f.name')} field={f.name} />
            {f.nameLatin ? <FieldRow label={t('ocr.f.nameLatin')} field={f.nameLatin} mono /> : null}
            <FieldRow label={t('ocr.f.nationality')} field={f.nationality} />
            <FieldRow
              label={t('ocr.f.birthDate')}
              field={f.birthDate}
              mono
              suffix={f.birthDate ? t(f.birthDate.calendar === 'HIJRI' ? 'ocr.hijri' : 'ocr.gregorian') : undefined}
            />
            <FieldRow
              label={t('ocr.f.expiryDate')}
              field={f.expiryDate}
              mono
              suffix={f.expiryDate ? t(f.expiryDate.calendar === 'HIJRI' ? 'ocr.hijri' : 'ocr.gregorian') : undefined}
            />
          </SimpleGrid>
        ) : null}
        {f && status === 'DONE' ? (
          <Text size="xs" c="dimmed">
            {t('ocr.disclaimer')}
          </Text>
        ) : null}

        <FormError error={error ?? (ocr.isError ? ocr.error : null)} />

        {data?.suggestedMembers.length ? (
          <Box>
            <Text fw={600} size="sm" mb={6}>
              {t('ocr.suggestions')}
            </Text>
            <ul className="nz-ocr-sugs">
              {data.suggestedMembers.map((s) => (
                <Suggestion key={s.memberId} s={s} busy={busy === s.memberId} onAssign={() => assign(s.memberId, s.fullName)} />
              ))}
            </ul>
          </Box>
        ) : status === 'DONE' ? (
          <Text size="sm" c="dimmed">
            {t('ocr.noSuggestions')}
          </Text>
        ) : null}
        {data?.suggestedUsers.length ? (
          <Alert color="field" variant="light" p="xs">
            <Text size="sm">
              {t('ocr.userMatch', { names: data.suggestedUsers.map((u) => u.fullName).join('، ') })}
            </Text>
          </Alert>
        ) : null}

        <ManualAssign v={v} onAssign={assign} busy={busy} />

        {canRegister ? (
          registering ? (
            <RegisterMemberForm
              v={v}
              ocr={data ?? null}
              onCancel={() => setRegistering(false)}
              onAssignExisting={(id, name) => {
                setRegistering(false);
                assign(id, name);
              }}
              onDone={async () => {
                setRegistering(false);
                await Promise.all([invalidate(), invalidateTeams()]);
              }}
            />
          ) : (
            <Button variant="light" leftSection={<IconUserPlus size={16} />} onClick={() => setRegistering(true)}>
              {t('ocr.register')}
            </Button>
          )
        ) : null}
      </Stack>
    </Card>
  );
}

/** Short Arabic reason for a failed reading (the server's codes, never OCR text). */
export function ocrReason(code: string | null | undefined): string {
  if (!code) return t('ocr.err.generic');
  const key = code.startsWith('ENGINE_') ? 'ocr.err.ENGINE' : `ocr.err.${code}`;
  return tKey(key, 'ocr.err.generic');
}

/** Manual pick: admins from every member, the recorder from the roster cached on the device. */
function ManualAssign({ v, onAssign, busy }: { v: ViolationDto; onAssign: (id: string, name: string) => void; busy: string | null }) {
  const user = useAuthStore((s) => s.user);
  const isAdmin = can(user, 'violations.manage');
  const members = useAllMembers(isAdmin);
  const roster = useLiveQuery<RosterRow[]>(() => (isAdmin ? [] : offlineDb().roster.toArray()), [isAdmin]);
  const [pick, setPick] = useState<string | null>(null);
  const options = useMemo(
    () =>
      isAdmin
        ? (members.data ?? []).filter((m) => m.status === 'ACTIVE').map((m) => ({ value: m.id, label: m.team ? `${m.fullName} — ${m.team.name}` : m.fullName }))
        : (roster ?? []).map((r) => ({ value: r.memberId, label: r.teamName ? `${r.fullName} — ${r.teamName}` : r.fullName })),
    [isAdmin, members.data, roster],
  );
  const name = options.find((o) => o.value === pick)?.label.split(' — ')[0] ?? '';
  return (
    <Group align="flex-end" gap="xs" wrap="wrap">
      <Select
        label={t('ocr.manual')}
        placeholder={t('ocr.manualPlaceholder')}
        data={options}
        value={pick}
        onChange={setPick}
        searchable
        limit={40}
        clearable
        nothingFoundMessage={t('ocr.manualNone')}
        style={{ flex: '1 1 240px' }}
      />
      <Button variant="default" disabled={!pick} loading={Boolean(pick) && busy === pick} onClick={() => pick && onAssign(pick, name)}>
        {t('ocr.assign')}
      </Button>
    </Group>
  );
}

/** «تسجيل عضو جديد من البطاقة» (admins): prefilled from the reading, then registered and assigned. */
function RegisterMemberForm({
  v,
  ocr,
  onCancel,
  onDone,
  onAssignExisting,
}: {
  v: ViolationDto;
  ocr: ViolationOcrDto | null;
  onCancel: () => void;
  onDone: () => Promise<void> | void;
  onAssignExisting: (id: string, name: string) => void;
}) {
  const api = useApi();
  const teams = useTeams({ status: 'ACTIVE' });
  const jobTitles = useReference('job-titles');
  const hasPerson = v.files.some((x) => x.kind === 'PERSON' && x.ready);
  const fullId = ocr?.fields.nationalId?.full ? ocr.fields.nationalId.value : '';
  const [fullName, setFullName] = useState(ocr?.fields.name?.value ?? '');
  const [nationalId, setNationalId] = useState(fullId);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [jobTitle, setJobTitle] = useState('');
  const [usePhoto, setUsePhoto] = useState(hasPerson);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [existing, setExisting] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ocr?.fields.name?.value && !fullName) setFullName(ocr.fields.name.value);
    if (fullId && !nationalId) setNationalId(fullId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocr]);

  const submit = async () => {
    const input = {
      fullName: fullName.trim(),
      nationalId: nationalId.trim(),
      teamId: teamId ?? undefined,
      ...refFields(jobTitle, jobTitles.data, 'jobTitleId', 'jobTitleText'),
      usePersonPhoto: usePhoto,
    };
    const parsed = registerViolationMemberSchema.safeParse(input);
    const errs: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
    if (!teamId) errs.teamId = t('ocr.reg.teamRequired');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    setExisting(null);
    try {
      const res = await api.violations.registerMember(v.id, input);
      notifications.show({ color: 'ok', message: t('ocr.reg.done', { name: res.member.fullName }) });
      await onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NATIONAL_ID_TAKEN') {
        const id = (err.details as { existingMemberId?: string } | undefined)?.existingMemberId;
        if (id) {
          const m = await api.members.get(id).catch(() => null);
          setExisting({ id, name: m?.fullName ?? t('common.unknownUser') });
        }
      }
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="sm" className="nz-register" withBorder>
      <Stack gap="sm">
        <Group gap={8}>
          <IconId size={18} color="var(--accent)" aria-hidden />
          <Text fw={600}>{t('ocr.register')}</Text>
        </Group>
        <Text size="xs" c="dimmed">
          {t('ocr.reg.lead')}
        </Text>
        <FormError error={error} />
        {existing ? (
          <Alert color="signal" p="xs">
            <Group justify="space-between" wrap="wrap" gap="xs">
              <Text size="sm">{t('ocr.reg.existing', { name: existing.name })}</Text>
              <Button size="compact-sm" onClick={() => onAssignExisting(existing.id, existing.name)}>
                {t('ocr.reg.assignExisting')}
              </Button>
            </Group>
          </Alert>
        ) : null}
        <TextInput label={t('members.fullName')} value={fullName} onChange={(e) => setFullName(e.currentTarget.value)} error={errors.fullName} withAsterisk />
        <TextInput
          label={t('members.nationalId')}
          description={nationalId && !isValidNationalId(nationalId) ? t('ocr.reg.idInvalid') : t('register.nationalIdHint')}
          value={nationalId}
          onChange={(e) => setNationalId(e.currentTarget.value)}
          error={errors.nationalId}
          inputMode="numeric"
          classNames={{ input: 'ltr mono' }}
          withAsterisk
        />
        <Select
          label={t('ocr.reg.team')}
          description={t('ocr.reg.teamHint', { at: formatDateTime(v.capturedAt) })}
          data={(teams.data ?? []).map((tm) => ({ value: tm.id, label: tm.name }))}
          value={teamId}
          onChange={setTeamId}
          error={errors.teamId}
          searchable
          withAsterisk
        />
        <ReferenceInput kind="job-titles" label={t('members.jobTitle')} value={jobTitle} onChange={setJobTitle} />
        <Checkbox
          label={t('ocr.reg.usePhoto')}
          description={hasPerson ? t('ocr.reg.usePhotoHint') : t('ocr.reg.noPersonPhoto')}
          checked={usePhoto}
          disabled={!hasPerson}
          onChange={(e) => setUsePhoto(e.currentTarget.checked)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button loading={busy} leftSection={<IconUserPlus size={16} />} onClick={() => void submit()}>
            {t('ocr.reg.submit')}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

/** Admin: back to «غير مُسندة» (wrong person); the team snapshot is cleared with the member. */
export function UnassignButton({ v }: { v: ViolationDto }) {
  const api = useApi();
  const invalidate = useInvalidateViolations();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <Button size="compact-sm" variant="subtle" color="breach" leftSection={<IconUserMinus size={14} />} onClick={() => setOpen(true)}>
        {t('ocr.unassign')}
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title={t('ocr.unassignTitle')}>
        <Stack>
          <Text size="sm">{t('ocr.unassignBody')}</Text>
          <FormError error={error} />
          <Textarea label={t('teams.reasonOptional')} value={reason} onChange={(e) => setReason(e.currentTarget.value)} autosize minRows={2} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              color="breach"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api.violations.unassign(v.id, { reason: reason.trim() || undefined });
                  await invalidate();
                  notifications.show({ color: 'ok', message: t('ocr.unassigned') });
                  setOpen(false);
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('ocr.unassignConfirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
