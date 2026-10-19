import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Drawer,
  useDirection,
  Group,
  Image,
  Loader,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  Timeline,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconEye,
  IconHistory,
  IconLock,
  IconMessage2,
  IconPhoto,
} from '@tabler/icons-react';
import {
  can,
  changeViolationStatusSchema,
  type ViolationDto,
  type ViolationFileDto,
  type ViolationStatus,
} from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import {
  useInvalidateViolations,
  useViolation,
  useViolationHistory,
  useViolationTypes,
} from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { ErrorBlock, FormError, LoadingBlock } from '../../components/ui';
import { formatDateTime, formatNumber, t, tKey } from '../../i18n';
import { deviceLabel } from '../../features/violations/offline/capture';
import {
  DriftBadge,
  SeverityBadge,
  SnapshotTeam,
  VIOLATION_STATUSES,
  ViolationStatusBadge,
  fmtCoord,
  metres,
  statusLabel,
} from './parts';
import { LocationMap } from './maps';
import { AssignSection, UnassignButton, UnassignedBadge, canAssign } from './assign';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Box fz="sm">{children}</Box>
    </Box>
  );
}

/** A presigned photo URL, fetched when shown; refreshed shortly before it expires. */
function usePhotoUrl(violationId: string, fileId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['violation', violationId, 'file', fileId],
    queryFn: () => api.violations.fileUrl(violationId, fileId),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

function PhotoThumb({
  violationId,
  file,
  index,
  onOpen,
  label,
  className,
}: {
  violationId: string;
  file: ViolationFileDto;
  index: number;
  onOpen: (url: string, alt: string) => void;
  /** A9: a named photo (the person) instead of «صورة N». */
  label?: string;
  className?: string;
}) {
  const q = usePhotoUrl(violationId, file.id, file.ready);
  const alt = label ?? t('record.photos.alt', { n: index + 1 });
  if (!file.ready) {
    return (
      <Box className={['nz-thumb nz-thumb--empty', className].filter(Boolean).join(' ')}>
        <Text size="xs" c="dimmed" ta="center">
          {t('vdetail.photoPending')}
        </Text>
      </Box>
    );
  }
  return (
    <UnstyledButton
      className={['nz-thumb', className].filter(Boolean).join(' ')}
      onClick={() => q.data && onOpen(q.data.url, alt)}
      aria-label={label ? t('vdetail.openNamed', { name: label }) : t('vdetail.openPhoto', { n: index + 1 })}
    >
      {q.data ? <img src={q.data.url} alt={alt} loading="lazy" referrerPolicy="no-referrer" /> : <Loader size="xs" m="auto" />}
    </UnstyledButton>
  );
}

/** The ID card is fetched only on an explicit click, because every view is audited. */
function IdCardPhoto({ violation, file }: { violation: ViolationDto; file: ViolationFileDto | undefined }) {
  const api = useApi();
  const invalidate = useInvalidateViolations();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!file) {
    return (
      <Text size="sm" c="dimmed">
        {t('vdetail.idMissing')}
      </Text>
    );
  }
  if (url) return <Image src={url} alt={t('record.idCard.alt')} radius="md" maw={360} />;
  return (
    <Stack gap={6} align="flex-start">
      <Button
        variant="light"
        color="slate"
        leftSection={<IconEye size={16} />}
        loading={busy}
        disabled={!file.ready}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await api.violations.fileUrl(violation.id, file.id);
            setUrl(res.url);
            void invalidate();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('vdetail.showIdCard')}
      </Button>
      <Text size="xs" c="dimmed">
        {file.ready ? t('vdetail.idAudited') : t('vdetail.photoPending')}
      </Text>
      <FormError error={error} />
    </Stack>
  );
}

function StatusForm({ v }: { v: ViolationDto }) {
  const api = useApi();
  const invalidate = useInvalidateViolations();
  const [status, setStatus] = useState<ViolationStatus>(v.status);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const parsed = changeViolationStatusSchema.safeParse({
      status,
      reason: status === 'CANCELLED' ? reason : undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.violations.setStatus(v.id, parsed.data);
      await invalidate();
      notifications.show({ color: 'ok', message: t('vdetail.statusSaved') });
      setReason('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs">
      <Group align="flex-end" gap="sm" wrap="wrap">
        <Select
          label={t('vdetail.changeStatus')}
          data={VIOLATION_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
          value={status}
          onChange={(x) => x && setStatus(x as ViolationStatus)}
          allowDeselect={false}
          w={220}
          size="sm"
        />
        <Button onClick={() => void save()} loading={busy} disabled={status === v.status && status !== 'CANCELLED'} size="sm">
          {t('vdetail.saveStatus')}
        </Button>
      </Group>
      {status === 'CANCELLED' ? (
        <Textarea
          label={t('vdetail.cancelReason')}
          withAsterisk
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          autosize
          minRows={2}
          maxLength={500}
          size="sm"
        />
      ) : null}
      {error ? (
        <Text size="sm" c="var(--breach)" role="alert">
          {error}
        </Text>
      ) : null}
    </Stack>
  );
}

function EditForm({ v, onDone }: { v: ViolationDto; onDone: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateViolations();
  const types = useViolationTypes(false);
  const [typeId, setTypeId] = useState(v.type.id);
  const [description, setDescription] = useState(v.description);
  const [notes, setNotes] = useState(v.notes ?? '');
  const [error, setError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const typeOptions = [
    ...(types.data ?? []).map((ty) => ({ value: ty.id, label: ty.name })),
    ...(types.data?.some((ty) => ty.id === v.type.id) ? [] : [{ value: v.type.id, label: v.type.name }]),
  ];
  return (
    <Stack gap="sm">
      <Select label={t('record.type.label')} data={typeOptions} value={typeId} onChange={(x) => x && setTypeId(x)} allowDeselect={false} size="sm" />
      <Textarea
        label={t('record.description')}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        error={fieldErrors.description}
        autosize
        minRows={2}
        size="sm"
      />
      <Textarea label={t('record.notes')} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} autosize minRows={2} size="sm" />
      <FormError error={error} />
      <Group gap="sm">
        <Button
          size="sm"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setFieldErrors({});
            try {
              await api.violations.update(v.id, {
                typeId,
                description,
                notes: notes.trim(),
              });
              await invalidate();
              notifications.show({ color: 'ok', message: t('common.saved') });
              onDone();
            } catch (err) {
              setError(err);
              if (err instanceof ApiError) setFieldErrors(err.fieldErrors);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('vdetail.saveEdit')}
        </Button>
        <Button size="sm" variant="default" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </Group>
    </Stack>
  );
}

function ResponseForm({ v }: { v: ViolationDto }) {
  const api = useApi();
  const invalidate = useInvalidateViolations();
  const [body, setBody] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Stack gap="xs">
      <Textarea
        label={t('vdetail.addResponse')}
        description={t('vdetail.addResponseHint')}
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        autosize
        minRows={3}
        maxLength={2000}
      />
      <FormError error={error} />
      <Group>
        <Button
          size="sm"
          loading={busy}
          disabled={body.trim().length < 3}
          leftSection={<IconMessage2 size={16} />}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.violations.respond(v.id, { body });
              setBody('');
              await invalidate();
              notifications.show({ color: 'ok', message: t('vdetail.responseSent') });
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('vdetail.sendResponse')}
        </Button>
      </Group>
    </Stack>
  );
}

function History({ v }: { v: ViolationDto }) {
  const history = useViolationHistory(v.id);
  const entries = history.data?.items ?? [];
  return (
    <Timeline bulletSize={18} lineWidth={2} color="field">
      <Timeline.Item title={t('vdetail.h.captured')}>
        <Text size="xs" c="dimmed">
          {formatDateTime(v.capturedAt)} · {v.recordedBy.fullName}
        </Text>
      </Timeline.Item>
      <Timeline.Item title={t('vdetail.h.received')}>
        <Text size="xs" c="dimmed">
          {formatDateTime(v.receivedAt)}
        </Text>
      </Timeline.Item>
      {[...entries].reverse().map((e) => (
        <Timeline.Item key={e.id} title={tKey(`audit.action.${e.action}`, 'audit.action.other')}>
          <Text size="xs" c="dimmed">
            {formatDateTime(e.at)} · {e.actor?.fullName ?? t('common.system')}
            {e.action === 'violation.status_changed' && e.after && typeof e.after === 'object'
              ? ` · ${statusLabel(String((e.after as { status?: string }).status ?? ''))}`
              : ''}
          </Text>
        </Timeline.Item>
      ))}
      {history.isLoading ? <Loader size="xs" /> : null}
    </Timeline>
  );
}

/**
 * Violation detail (brief §7.5): photos through presigned URLs (the ID card behind an audited
 * click), the map pin with its accuracy circle, history, the clock-drift flag, status changes,
 * edits (admin; the recorder within the window) and supervisor responses.
 */
export function ViolationDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const { dir } = useDirection();
  const q = useViolation(id);
  const [viewer, setViewer] = useState<{ url: string; alt: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const v = q.data;

  const isAdmin = can(user, 'violations.manage');
  const canEditOwn =
    !!v && v.recordedBy.id === user?.id && !!v.editableUntil && Date.parse(v.editableUntil) > Date.now();
  const canRespond = !!v && can(user, 'violations.respond') && user?.role === 'SUPERVISOR';
  const evidence = v?.files.filter((f) => f.kind === 'EVIDENCE') ?? [];
  const idCard = v?.files.find((f) => f.kind === 'ID_CARD');
  const personPhoto = v?.files.find((f) => f.kind === 'PERSON');
  const unassigned = !!v && !v.member;
  const readyEvidence = evidence.filter((f) => f.ready).length;
  const expected = v?.expectedPhotos?.evidence ?? evidence.length;

  return (
    <Drawer
      opened={Boolean(id)}
      onClose={() => {
        setEditing(false);
        onClose();
      }}
      position={dir === 'rtl' ? 'left' : 'right'}
      size="lg"
      title={t('vdetail.title')}
      classNames={{ body: 'nz-drawer-body' }}
    >
      {q.isLoading ? <LoadingBlock variant="detail" rows={3} /> : null}
      {q.isError ? <ErrorBlock error={q.error} onRetry={() => void q.refetch()} /> : null}
      {v ? (
        <Stack gap="md">
          <Group gap="xs" wrap="wrap">
            <ViolationStatusBadge status={v.status} />
            <SeverityBadge severity={v.type.severity} />
            {v.clockDriftSuspect ? <DriftBadge /> : null}
          </Group>
          <Box>
            <Title order={3}>{v.type.name}</Title>
            {v.status === 'CANCELLED' && v.cancelReason ? (
              <Alert color="slate" mt="xs" title={t('vdetail.cancelledBecause')}>
                {v.cancelReason}
              </Alert>
            ) : null}
          </Box>

          <Card padding="md">
            <Group wrap="nowrap" align="flex-start" gap="md">
              {personPhoto ? (
                <PhotoThumb
                  violationId={v.id}
                  file={personPhoto}
                  index={0}
                  label={t('vdetail.personPhoto')}
                  className="nz-person-thumb"
                  onOpen={(url) => setViewer({ url, alt: t('vdetail.personPhoto') })}
                />
              ) : null}
              <Stack gap="xs" style={{ minWidth: 0, flex: 1 }}>
                <Group gap="xs" wrap="wrap">
                  <Text fw={600} size="lg">
                    {v.member?.fullName ?? t('vdetail.personUnknown')}
                  </Text>
                  {unassigned ? <UnassignedBadge /> : null}
                </Group>
                {v.member ? (
                  <Text className="mono ltr" size="sm" c="dimmed">
                    {v.member.nationalIdMasked}
                  </Text>
                ) : (
                  <Text size="sm" c="dimmed">
                    {t('vdetail.unassignedHint')}
                  </Text>
                )}
                <Group gap="xs" wrap="wrap">
                  {v.member ? <SnapshotTeam team={v.team} /> : null}
                  {v.supervisors && v.supervisors.length > 1 ? (
                    <Text size="sm" c="dimmed">
                      {t('vdetail.supervisorsAtTime', { names: v.supervisors.map((s) => s.fullName).join('، ') })}
                    </Text>
                  ) : v.supervisor ? (
                    <Text size="sm" c="dimmed">
                      {t('vdetail.supervisorAtTime', { name: v.supervisor.fullName })}
                    </Text>
                  ) : null}
                </Group>
                {v.member && v.assignedAt ? (
                  <Group gap="xs" wrap="wrap">
                    <Text size="xs" c="dimmed">
                      {t('vdetail.assignedBy', { name: v.assignedBy?.fullName ?? t('common.system'), at: formatDateTime(v.assignedAt) })}
                    </Text>
                    {isAdmin ? <UnassignButton v={v} /> : null}
                  </Group>
                ) : v.member && isAdmin ? (
                  <Group>
                    <UnassignButton v={v} />
                  </Group>
                ) : null}
              </Stack>
            </Group>
          </Card>

          {unassigned && canAssign(user, v) ? <AssignSection v={v} /> : null}

          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
            <Fact label={t('vdetail.capturedAt')}>{formatDateTime(v.capturedAt)}</Fact>
            <Fact label={t('vdetail.receivedAt')}>{formatDateTime(v.receivedAt)}</Fact>
            <Fact label={t('vdetail.recorder')}>{v.recordedBy.fullName}</Fact>
            <Fact label={t('vdetail.location')}>
              <span className="mono ltr">
                {fmtCoord(v.latitude)}, {fmtCoord(v.longitude)}
              </span>{' '}
              · {metres(v.accuracyM)}
            </Fact>
            {isAdmin && v.deviceInfo ? (
              <Fact label={t('record.auto.device')}>
                {deviceLabel(String(v.deviceInfo.userAgent ?? '')) || String(v.deviceInfo.platform ?? t('common.none'))}
                {v.deviceInfo.appVersion ? (
                  <Text span size="xs" c="dimmed">
                    {' '}
                    · {t('vdetail.appVersion', { v: String(v.deviceInfo.appVersion) })}
                  </Text>
                ) : null}
              </Fact>
            ) : null}
          </SimpleGrid>

          <Box>
            <Text size="xs" c="dimmed">
              {t('record.description')}
            </Text>
            <Text style={{ whiteSpace: 'pre-wrap' }}>{v.description}</Text>
            {v.notes ? (
              <>
                <Text size="xs" c="dimmed" mt="xs">
                  {t('record.notes')}
                </Text>
                <Text style={{ whiteSpace: 'pre-wrap' }}>{v.notes}</Text>
              </>
            ) : null}
          </Box>

          <LocationMap lat={v.latitude} lng={v.longitude} accuracyM={v.accuracyM} color={v.team?.color.hex ?? '#C0392B'} />

          <Divider label={t('vdetail.photos')} labelPosition="right" />
          {readyEvidence < expected ? (
            <Alert color="signal" icon={<IconAlertTriangle size={18} />}>
              {t('vdetail.photosIncomplete', { n: readyEvidence, total: expected })}
            </Alert>
          ) : null}
          {evidence.length ? (
            <SimpleGrid cols={3} spacing="xs">
              {evidence.map((f, i) => (
                <PhotoThumb key={f.id} violationId={v.id} file={f} index={i} onOpen={(url, alt) => setViewer({ url, alt })} />
              ))}
            </SimpleGrid>
          ) : (
            <Group gap={6}>
              <IconPhoto size={18} color="var(--muted)" />
              <Text size="sm" c="dimmed">
                {t('vdetail.noPhotos')}
              </Text>
            </Group>
          )}
          {can(user, 'violations.viewIdPhoto') ? (
            <Box>
              <Text size="sm" fw={600} mb={6}>
                {t('record.idCard.alt')}
              </Text>
              <IdCardPhoto violation={v} file={idCard} />
            </Box>
          ) : (
            <Group gap={6}>
              <IconLock size={16} color="var(--muted)" />
              <Text size="xs" c="dimmed">
                {t('vdetail.idHiddenForRole')}
              </Text>
            </Group>
          )}

          {isAdmin ? (
            <>
              <Divider label={t('vdetail.statusSection')} labelPosition="right" />
              <StatusForm key={`${v.id}-${v.status}`} v={v} />
            </>
          ) : null}

          {isAdmin || canEditOwn ? (
            <>
              <Divider label={t('vdetail.editSection')} labelPosition="right" />
              {editing ? (
                <EditForm v={v} onDone={() => setEditing(false)} />
              ) : (
                <Group justify="space-between" wrap="wrap">
                  <Text size="sm" c="dimmed">
                    {isAdmin
                      ? t('vdetail.editAdmin')
                      : t('vdetail.editUntil', { at: formatDateTime(v.editableUntil) })}
                  </Text>
                  <Button size="sm" variant="light" onClick={() => setEditing(true)}>
                    {t('vdetail.edit')}
                  </Button>
                </Group>
              )}
            </>
          ) : null}

          <Divider label={t('vdetail.responses', { n: formatNumber(v.responses.length) })} labelPosition="right" />
          {v.responses.length ? (
            <Stack gap="xs">
              {v.responses.map((r) => (
                <Card key={r.id} padding="sm" withBorder>
                  <Group justify="space-between" wrap="wrap" gap={4}>
                    <Text size="sm" fw={600}>
                      {r.supervisor.fullName}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatDateTime(r.createdAt)}
                    </Text>
                  </Group>
                  <Text size="sm" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
                    {r.body}
                  </Text>
                </Card>
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              {t('vdetail.noResponses')}
            </Text>
          )}
          {canRespond ? <ResponseForm v={v} /> : null}

          {isAdmin ? (
            <>
              <Divider
                label={
                  <Group gap={4}>
                    <IconHistory size={14} />
                    {t('vdetail.history')}
                  </Group>
                }
                labelPosition="right"
              />
              <History v={v} />
            </>
          ) : null}
          {isAdmin ? (
            <Anchor size="xs" c="dimmed" component="span" className="mono ltr">
              {v.id}
            </Anchor>
          ) : null}
        </Stack>
      ) : null}

      <Modal opened={Boolean(viewer)} onClose={() => setViewer(null)} size="xl" title={viewer?.alt} centered>
        {viewer ? <Image src={viewer.url} alt={viewer.alt} radius="md" /> : null}
      </Modal>
    </Drawer>
  );
}

export function SyncedBadge({ n }: { n: number }) {
  return (
    <Badge color="signal" variant="filled" size="sm" className="nz-count">
      {formatNumber(n)}
    </Badge>
  );
}
