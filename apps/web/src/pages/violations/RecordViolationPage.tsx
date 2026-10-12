import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Card,
  Group,
  List,
  Loader,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCamera,
  IconCheck,
  IconCircleCheck,
  IconClock,
  IconCloudUpload,
  IconCurrentLocation,
  IconDeviceMobile,
  IconId,
  IconMapPinOff,
  IconPhotoPlus,
  IconRefresh,
  IconSearch,
  IconUser,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { can, createViolationSchema, type ViolationTypeDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, PageHeader } from '../../components/ui';
import { formatDateTime, formatNumber, t } from '../../i18n';
import { TeamBadge } from '../../theme/TeamBadge';
import { offlineDb, type RosterRow } from '../../features/violations/offline/db';
import {
  cachedFormSettings,
  cachedTypes,
  DEFAULT_FORM_SETTINGS,
  searchRoster,
} from '../../features/violations/offline/roster';
import {
  compressImage,
  deviceInfo,
  deviceLabel,
  getPosition,
  type GeoErrorKind,
  type GeoFix,
} from '../../features/violations/offline/capture';
import { enqueueViolation } from '../../features/violations/offline/outbox';
import {
  getSyncEngine,
  refreshRosterNow,
  useOfflineStore,
  useOutboxItem,
  useRosterInfo,
} from '../../features/violations/offline/runtime';
import { registerBackgroundSync } from '../../features/violations/offline/sync';
import { uuidv4 } from '../../lib/uuid';
import { useOnline } from '../../lib/useOnline';
import { SeverityBadge, metres, useObjectUrl } from './parts';
import { useStepParam } from '../../lib/useUrlState';

// ---------------------------------------------------------------- hooks

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

type GeoState =
  | { status: 'locating'; fix: GeoFix | null }
  | { status: 'ok'; fix: GeoFix }
  | { status: 'error'; error: GeoErrorKind; fix: GeoFix | null };

/** High-accuracy GPS with a 15 s timeout, started as soon as the page opens. */
function useGeo() {
  const [state, setState] = useState<GeoState>({ status: 'locating', fix: null });
  const run = useCallback(() => {
    setState((s) => ({ status: 'locating', fix: s.fix }));
    getPosition().then(
      (fix) => setState({ status: 'ok', fix }),
      (error: GeoErrorKind) => setState((s) => ({ status: 'error', error, fix: s.fix })),
    );
  }, []);
  useEffect(() => run(), [run]);
  return { ...state, retry: run };
}

interface Photo {
  id: string;
  blob: Blob;
}

// ---------------------------------------------------------------- small pieces

const STEPS = ['record.step.member', 'record.step.idCard', 'record.step.photos', 'record.step.details'] as const;

function StepBar({ step }: { step: number }) {
  return (
    <Box mb="md" aria-label={t('record.stepOf', { n: step + 1, total: STEPS.length })}>
      <Group gap={6} wrap="nowrap" mb={6}>
        {STEPS.map((key, i) => (
          <Box
            key={key}
            className="nz-step-seg"
            data-state={i < step ? 'done' : i === step ? 'current' : 'todo'}
            aria-hidden
          />
        ))}
      </Group>
      <Group justify="space-between" wrap="nowrap">
        <Text fw={600}>{t(STEPS[step]!)}</Text>
        <Text size="sm" c="dimmed">
          {t('record.stepOf', { n: step + 1, total: STEPS.length })}
        </Text>
      </Group>
    </Box>
  );
}

/** Hidden camera input behind a big button (brief §7.2). */
function CameraButton({
  label,
  onPick,
  busy,
  variant = 'tile',
}: {
  label: string;
  onPick: (file: File) => void;
  busy?: boolean;
  variant?: 'tile' | 'big';
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) onPick(file);
        }}
      />
      <UnstyledButton
        className={variant === 'big' ? 'nz-camera-big' : 'nz-camera-tile'}
        onClick={() => ref.current?.click()}
        disabled={busy}
        aria-label={label}
      >
        <Stack align="center" gap={6}>
          {busy ? <Loader size="sm" color="field" /> : <IconCamera size={variant === 'big' ? 36 : 26} stroke={1.6} />}
          <Text fw={600} size={variant === 'big' ? 'md' : 'sm'} ta="center">
            {busy ? t('record.compressing') : label}
          </Text>
        </Stack>
      </UnstyledButton>
    </>
  );
}

function Thumb({ blob, alt, onRemove }: { blob: Blob; alt: string; onRemove?: () => void }) {
  const url = useObjectUrl(blob);
  return (
    <Box className="nz-thumb">
      {url ? <img src={url} alt={alt} /> : null}
      {onRemove ? (
        <ActionIcon
          className="nz-thumb-remove"
          color="breach"
          variant="filled"
          radius="xl"
          size={32}
          onClick={onRemove}
          aria-label={alt ? t('record.removePhotoNamed', { name: alt }) : t('record.removePhoto')}
        >
          <IconX size={16} />
        </ActionIcon>
      ) : null}
    </Box>
  );
}

function AutoRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <ThemeIcon variant="light" color="slate" size={32} radius="md" aria-hidden>
        {icon}
      </ThemeIcon>
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Box fz="sm">{children}</Box>
      </Box>
    </Group>
  );
}

/** Location status, retry, and the "how to allow location" help when denied. */
function LocationPanel({
  geo,
  warnMeters,
  compact,
}: {
  geo: ReturnType<typeof useGeo>;
  warnMeters: number;
  compact?: boolean;
}) {
  const poor = geo.fix && geo.fix.accuracyM > warnMeters;
  if (geo.status === 'error' && (geo.error === 'denied' || geo.error === 'insecure')) {
    return (
      <Alert color="breach" icon={<IconMapPinOff size={20} />} title={t('record.geo.deniedTitle')}>
        <Stack gap="xs">
          <Text size="sm">{t('record.geo.deniedBody')}</Text>
          <Text size="sm" fw={600}>
            {t('record.geo.iosTitle')}
          </Text>
          <List size="sm" spacing={2}>
            <List.Item>{t('record.geo.ios1')}</List.Item>
            <List.Item>{t('record.geo.ios2')}</List.Item>
            <List.Item>{t('record.geo.ios3')}</List.Item>
          </List>
          <Text size="sm" fw={600}>
            {t('record.geo.androidTitle')}
          </Text>
          <List size="sm" spacing={2}>
            <List.Item>{t('record.geo.android1')}</List.Item>
            <List.Item>{t('record.geo.android2')}</List.Item>
          </List>
          <Group>
            <Button size="sm" variant="light" color="breach" leftSection={<IconRefresh size={16} />} onClick={geo.retry}>
              {t('record.geo.retry')}
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  }
  return (
    <Group justify="space-between" wrap="nowrap" gap="xs" className="nz-geo-line" data-state={geo.status === 'error' ? 'error' : poor ? 'poor' : geo.status}>
      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
        {geo.status === 'locating' ? (
          <Loader size={16} color="field" />
        ) : geo.status === 'error' ? (
          <IconAlertTriangle size={18} color="var(--breach)" aria-hidden />
        ) : (
          <IconCurrentLocation size={18} color={poor ? 'var(--signal)' : 'var(--ok)'} aria-hidden />
        )}
        <Text size="sm" truncate>
          {geo.status === 'locating'
            ? t('record.geo.locating')
            : geo.status === 'error'
              ? t(`record.geo.err.${geo.error}` as 'record.geo.err.timeout')
              : poor
                ? t('record.geo.poor', { m: Math.round(geo.fix.accuracyM) })
                : t('record.geo.ok', { m: Math.round(geo.fix.accuracyM) })}
        </Text>
      </Group>
      {geo.status !== 'locating' && (geo.status === 'error' || poor || !compact) ? (
        <Button size="compact-sm" variant="subtle" leftSection={<IconRefresh size={14} />} onClick={geo.retry}>
          {t('record.geo.retryShort')}
        </Button>
      ) : null}
    </Group>
  );
}

// ---------------------------------------------------------------- step 1: member

function MemberStep({
  selected,
  onSelect,
}: {
  selected: RosterRow | null;
  onSelect: (m: RosterRow | null) => void;
}) {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const online = useOnline();
  const info = useRosterInfo();
  const refreshing = useOfflineStore((s) => s.rosterRefreshing);
  const rosterError = useOfflineStore((s) => s.rosterError);
  const [q, setQ] = useState('');
  const rows = useLiveQuery(() => offlineDb().roster.toArray(), []);
  const results = useMemo(() => (rows ? searchRoster(rows, q) : []), [rows, q]);
  const refresh = () => user && void refreshRosterNow(api, user.id);

  const header = (
    <Group justify="space-between" wrap="wrap" gap="xs" mb="sm">
      <Text size="sm" c="dimmed">
        {info?.lastRosterAt
          ? t('record.roster.updated', { at: formatDateTime(info.lastRosterAt), count: info.count })
          : t('record.roster.never')}
      </Text>
      <Button
        size="compact-sm"
        variant="light"
        leftSection={<IconRefresh size={14} />}
        onClick={refresh}
        loading={refreshing}
        disabled={!online}
      >
        {t('record.roster.refresh')}
      </Button>
    </Group>
  );

  if (selected) {
    return (
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('record.member.selected')}
        </Text>
        <Card padding="md" className="nz-member-picked">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Stack gap={4} style={{ minWidth: 0 }}>
              <Text fw={600} size="lg">
                {selected.fullName}
              </Text>
              <Text className="mono ltr" size="sm" c="dimmed">
                {selected.nationalIdMasked}
              </Text>
              {selected.teamName && selected.teamColor ? (
                <TeamBadge name={selected.teamName} color={selected.teamColor} size="sm" />
              ) : (
                <Text size="sm" c="dimmed">
                  {t('record.member.noTeam')}
                </Text>
              )}
            </Stack>
            <Button variant="subtle" size="compact-md" onClick={() => onSelect(null)}>
              {t('record.member.change')}
            </Button>
          </Group>
        </Card>
      </Stack>
    );
  }

  if (rows && rows.length === 0) {
    return (
      <>
        {header}
        {rosterError ? (
          <Alert color="breach" mb="sm" icon={<IconAlertTriangle size={18} />}>
            {rosterError}
          </Alert>
        ) : null}
        <EmptyState
          icon={IconUsers}
          title={t('record.roster.emptyTitle')}
          body={online ? t('record.roster.emptyOnline') : t('record.roster.emptyOffline')}
          action={online ? { label: t('record.roster.load'), onClick: refresh } : undefined}
        />
      </>
    );
  }

  return (
    <Stack gap="sm">
      {header}
      <TextInput
        label={t('record.member.searchLabel')}
        placeholder={t('record.member.searchPlaceholder')}
        leftSection={<IconSearch size={18} />}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        autoComplete="off"
        inputMode="search"
        data-autofocus
      />
      {q.trim() && results.length === 0 ? (
        <Text size="sm" c="dimmed" py="sm">
          {t('record.member.noResults')}
        </Text>
      ) : null}
      <Stack gap={6} role="list" aria-label={t('record.member.results')}>
        {results.map((m) => (
          <UnstyledButton
            key={m.memberId}
            role="listitem"
            className="nz-roster-row"
            onClick={() => onSelect(m)}
          >
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Box style={{ minWidth: 0 }}>
                <Text fw={600} truncate>
                  {m.fullName}
                </Text>
                <Text className="mono ltr" size="sm" c="dimmed">
                  {m.nationalIdMasked}
                </Text>
              </Box>
              {m.teamName && m.teamColor ? <TeamBadge name={m.teamName} color={m.teamColor} size="sm" /> : null}
            </Group>
          </UnstyledButton>
        ))}
      </Stack>
      {!q.trim() ? (
        <Text size="sm" c="dimmed">
          {t('record.member.hint')}
        </Text>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------- page

type Phase = { kind: 'form' } | { kind: 'saved'; id: string };

export function RecordViolationPage() {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const geo = useGeo();
  const now = useNow(1000);
  const online = useOnline();
  // The step is in the URL (?step=2…4): the browser back button returns to the previous step.
  const wizard = useStepParam('step', STEPS.length);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [member, setMember] = useState<RosterRow | null>(null);
  const [idPhoto, setIdPhoto] = useState<Photo | null>(null);
  const [evidence, setEvidence] = useState<Photo[]>([]);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<'id' | 'evidence' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const types = useLiveQuery(() => cachedTypes(offlineDb()), []) as ViolationTypeDto[] | undefined;
  const form = useLiveQuery(() => cachedFormSettings(offlineDb()), []) ?? DEFAULT_FORM_SETTINGS;
  const device = useMemo(() => deviceInfo(), []);

  const reset = () => {
    wizard.reset();
    setPhase({ kind: 'form' });
    setMember(null);
    setIdPhoto(null);
    setEvidence([]);
    setTypeId(null);
    setDescription('');
    setNotes('');
    setError(null);
    setFieldErrors({});
    geo.retry();
  };

  const addPhoto = async (file: File, kind: 'id' | 'evidence') => {
    setBusy(kind);
    setError(null);
    try {
      const blob = await compressImage(file);
      const photo = { id: uuidv4(), blob };
      if (kind === 'id') setIdPhoto(photo);
      else setEvidence((list) => (list.length >= form.maxPhotos ? list : [...list, photo]));
    } catch {
      setError(t('record.photoError'));
    } finally {
      setBusy(null);
    }
  };

  // A step can only be shown once the steps before it are complete (deep links, back/forward).
  const reachable = !member ? 0 : !idPhoto ? 1 : evidence.length === 0 ? 2 : 3;
  const step = Math.min(wizard.step, reachable);
  useEffect(() => {
    if (phase.kind === 'form' && wizard.step > reachable) wizard.go(reachable, 'replace');
  }, [wizard.step, reachable, phase.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const geoBlocked = geo.status === 'error' && (geo.error === 'denied' || geo.error === 'insecure');
  const canNext = [Boolean(member), Boolean(idPhoto), evidence.length > 0, true][step];

  const save = async () => {
    if (!user || !member || !idPhoto) return;
    const errs: Record<string, string> = {};
    if (!typeId) errs.typeId = t('record.err.type');
    if (description.trim().length < 3) errs.description = t('record.err.description');
    setFieldErrors(errs);
    if (!geo.fix) {
      setError(geoBlocked ? t('record.err.locationDenied') : t('record.err.location'));
      return;
    }
    if (Object.keys(errs).length) return;
    const type = types?.find((ty) => ty.id === typeId);
    const payload = {
      clientUuid: uuidv4(),
      memberId: member.memberId,
      typeId: typeId as string,
      description: description.trim(),
      notes: notes.trim() || undefined,
      latitude: geo.fix.latitude,
      longitude: geo.fix.longitude,
      accuracyM: Math.round(geo.fix.accuracyM * 10) / 10,
      capturedAt: new Date().toISOString(),
      deviceInfo: deviceInfo(),
      expectedIdPhotos: 1,
      expectedEvidencePhotos: evidence.length,
    };
    const parsed = createViolationSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('error.unknown'));
      return;
    }
    setBusy('save');
    try {
      // Always to the outbox first, online or not (brief §7.4).
      const item = await enqueueViolation(offlineDb(), {
        userId: user.id,
        payload,
        display: {
          memberName: member.fullName,
          nationalIdMasked: member.nationalIdMasked,
          teamName: member.teamName,
          teamColor: member.teamColor,
          typeName: type?.name ?? '',
        },
        photos: [
          { kind: 'ID_CARD', blob: idPhoto.blob },
          ...evidence.map((p) => ({ kind: 'EVIDENCE' as const, blob: p.blob })),
        ],
      });
      setPhase({ kind: 'saved', id: item.id });
      void registerBackgroundSync();
      void getSyncEngine(api).runNow();
    } catch {
      setError(t('record.err.save'));
    } finally {
      setBusy(null);
    }
  };

  if (phase.kind === 'saved') return <SavedView id={phase.id} onAnother={reset} />;

  const typesEmpty = types !== undefined && types.length === 0;

  return (
    <Box maw={640} mx="auto">
      <PageHeader title={t('record.title')} />
      <StepBar step={step} />

      <Card padding="sm" mb="md">
        <LocationPanel geo={geo} warnMeters={form.gpsWarnMeters} compact />
        {!online ? (
          <Text size="xs" c="dimmed" mt={6}>
            {t('record.offlineNote')}
          </Text>
        ) : null}
      </Card>

      {error ? (
        <Alert color="breach" mb="md" icon={<IconAlertTriangle size={18} />} role="alert">
          {error}
        </Alert>
      ) : null}

      <Card padding="md" mb="md">
        {step === 0 ? <MemberStep selected={member} onSelect={setMember} /> : null}

        {step === 1 ? (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              {t('record.idCard.lead')}
            </Text>
            {idPhoto ? (
              <Stack gap="sm">
                <Thumb blob={idPhoto.blob} alt={t('record.idCard.alt')} />
                <Group>
                  <CameraButton
                    variant="tile"
                    label={t('record.idCard.retake')}
                    busy={busy === 'id'}
                    onPick={(f) => void addPhoto(f, 'id')}
                  />
                </Group>
              </Stack>
            ) : (
              <CameraButton
                variant="big"
                label={t('record.idCard.take')}
                busy={busy === 'id'}
                onPick={(f) => void addPhoto(f, 'id')}
              />
            )}
            <Text size="xs" c="dimmed">
              {t('record.idCard.privacy')}
            </Text>
          </Stack>
        ) : null}

        {step === 2 ? (
          <Stack gap="sm">
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {t('record.photos.lead')}
              </Text>
              <Text size="sm" fw={600}>
                {t('record.photos.count', { n: evidence.length, max: form.maxPhotos })}
              </Text>
            </Group>
            <SimpleGrid cols={3} spacing="xs">
              {evidence.map((p, i) => (
                <Thumb
                  key={p.id}
                  blob={p.blob}
                  alt={t('record.photos.alt', { n: i + 1 })}
                  onRemove={() => setEvidence((list) => list.filter((x) => x.id !== p.id))}
                />
              ))}
              {evidence.length < form.maxPhotos ? (
                <CameraButton
                  label={evidence.length ? t('record.photos.addMore') : t('record.photos.add')}
                  busy={busy === 'evidence'}
                  onPick={(f) => void addPhoto(f, 'evidence')}
                />
              ) : null}
            </SimpleGrid>
            {evidence.length >= form.maxPhotos ? (
              <Text size="xs" c="dimmed">
                {t('record.photos.max')}
              </Text>
            ) : null}
          </Stack>
        ) : null}

        {step === 3 ? (
          <Stack gap="md">
            {typesEmpty ? (
              <Alert color="signal" icon={<IconAlertTriangle size={18} />} title={t('record.types.emptyTitle')}>
                <Text size="sm">
                  {can(user, 'violations.manage') ? t('record.types.emptyAdmin') : t('record.types.emptyMonitor')}
                </Text>
                {can(user, 'violations.manage') ? (
                  <Button component={Link} to="/settings/reference?tab=violation-types" size="xs" mt="sm" variant="light">
                    {t('record.types.addAction')}
                  </Button>
                ) : null}
              </Alert>
            ) : (
              <Radio.Group
                label={t('record.type.label')}
                value={typeId}
                onChange={setTypeId}
                error={fieldErrors.typeId}
                withAsterisk
              >
                <Stack gap={6} mt="xs">
                  {(types ?? []).map((ty) => (
                    <Radio.Card key={ty.id} value={ty.id} className="nz-type-card" radius="md">
                      <Group wrap="nowrap" justify="space-between" gap="sm">
                        <Group wrap="nowrap" gap="sm" style={{ minWidth: 0 }}>
                          <Radio.Indicator />
                          <Text fw={500}>{ty.name}</Text>
                        </Group>
                        <SeverityBadge severity={ty.severity} />
                      </Group>
                    </Radio.Card>
                  ))}
                </Stack>
              </Radio.Group>
            )}
            <Textarea
              label={t('record.description')}
              placeholder={t('record.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              error={fieldErrors.description}
              withAsterisk
              autosize
              minRows={3}
              maxLength={2000}
            />
            <Textarea
              label={t('record.notes')}
              description={t('common.optional')}
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              autosize
              minRows={2}
              maxLength={2000}
            />
            <Card padding="sm" bg="var(--ground)" withBorder={false} shadow="none">
              <Text size="sm" fw={600} mb="xs">
                {t('record.auto.title')}
              </Text>
              <Stack gap="sm">
                <AutoRow icon={<IconClock size={18} />} label={t('record.auto.time')}>
                  <Text className="num" size="sm">
                    {formatDateTime(now)}
                  </Text>
                </AutoRow>
                <AutoRow icon={<IconCurrentLocation size={18} />} label={t('record.auto.location')}>
                  {geo.fix ? (
                    <Text size="sm">
                      <span className="mono ltr">
                        {geo.fix.latitude.toFixed(5)}, {geo.fix.longitude.toFixed(5)}
                      </span>{' '}
                      · {metres(geo.fix.accuracyM)}
                    </Text>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {t('record.geo.none')}
                    </Text>
                  )}
                </AutoRow>
                <AutoRow icon={<IconUser size={18} />} label={t('record.auto.recorder')}>
                  {user?.fullName}
                </AutoRow>
                <AutoRow icon={<IconDeviceMobile size={18} />} label={t('record.auto.device')}>
                  {deviceLabel(device.userAgent) || t('common.none')}
                </AutoRow>
              </Stack>
            </Card>
            {geoBlocked || geo.status === 'error' ? (
              <LocationPanel geo={geo} warnMeters={form.gpsWarnMeters} />
            ) : null}
          </Stack>
        ) : null}
      </Card>

      <Box className="nz-record-actions">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Button
            variant="default"
            onClick={wizard.back}
            disabled={step === 0 || busy === 'save'}
          >
            {t('record.back')}
          </Button>
          {step < 3 ? (
            <Button onClick={wizard.next} disabled={!canNext || busy !== null} style={{ flex: 1 }}>
              {t('record.next')}
            </Button>
          ) : (
            <Button
              color="breach"
              onClick={() => void save()}
              loading={busy === 'save'}
              disabled={geoBlocked || !geo.fix || typesEmpty}
              leftSection={<IconCheck size={18} />}
              style={{ flex: 1 }}
            >
              {t('record.save')}
            </Button>
          )}
        </Group>
        {step === 3 && (geoBlocked || !geo.fix) ? (
          <Text size="xs" c="var(--breach)" mt={6} ta="center">
            {geoBlocked ? t('record.err.locationDenied') : t('record.err.location')}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

/** After saving: «حُفظت المخالفة — ستُرسل عند توفّر الاتصال» until the engine reports «أُرسلت». */
function SavedView({ id, onAnother }: { id: string; onAnother: () => void }) {
  const item = useOutboxItem(id);
  const synced = item?.status === 'synced';
  const failed = item?.status === 'failed';
  return (
    <Box maw={520} mx="auto" pt="lg">
      <Card padding="xl">
        <Stack align="center" ta="center" gap="sm">
          <ThemeIcon
            size={64}
            radius="xl"
            variant="light"
            color={synced ? 'ok' : failed ? 'breach' : 'signal'}
            aria-hidden
          >
            {synced ? <IconCircleCheck size={36} /> : failed ? <IconAlertTriangle size={36} /> : <IconCloudUpload size={36} />}
          </ThemeIcon>
          <Title order={2} role="status" aria-live="polite">
            {synced ? t('record.saved.synced') : failed ? t('record.saved.failed') : t('record.saved.pending')}
          </Title>
          <Text c="dimmed">
            {synced
              ? t('record.saved.syncedBody')
              : failed
                ? item?.error ?? ''
                : item?.status === 'uploading'
                  ? t('record.saved.uploading')
                  : t('record.saved.pendingBody')}
          </Text>
          {item ? (
            <Text size="sm" c="dimmed">
              {t('outbox.photosProgress', {
                done: item.photos.filter((p) => p.confirmed).length,
                total: item.photos.length,
              })}
            </Text>
          ) : null}
          <Stack w="100%" gap="xs" mt="md">
            <Button onClick={onAnother} leftSection={<IconPhotoPlus size={18} />}>
              {t('record.saved.another')}
            </Button>
            <Button component={Link} to="/violations/pending" variant="default" leftSection={<IconId size={18} />}>
              {t('record.saved.openPending', { n: formatNumber(1) })}
            </Button>
          </Stack>
        </Stack>
      </Card>
    </Box>
  );
}
