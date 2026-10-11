import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Text,
  TextInput,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import {
  can,
  createTeamSchema,
  type ColorTakenDetails,
  type TeamColorDto,
  type TeamDto,
} from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import {
  qk2,
  useAvailableColors,
  useInvalidateTeams,
  useReference,
  useSettings,
  useSupervisors,
} from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { FormError } from '../../components/ui';
import { validateImportRows } from '../../features/members/importRows';
import { t } from '../../i18n';
import { ColorPicker } from './shared';
import { MembersImporter } from './MembersImporter';

type SupMode = 'existing' | 'new';
const EMPTY_SUP = { fullName: '', email: '', mobile: '', nationalId: '' };

/**
 * Create a team (brief §5.1). Admin: pick a supervisor or create one inline; the team is
 * active at once. Supervisor: leads the team; it waits for approval when the setting is on.
 * The colour picker lists free colours only; on a COLOR_TAKEN race it is replaced with the
 * fresh list from the error details.
 */
export function CreateTeamDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invalidate = useInvalidateTeams();
  const user = useAuthStore((s) => s.user);
  const isAdmin = can(user, 'teams.create');
  const mobile = useMediaQuery('(max-width: 48em)');
  const settings = useSettings();
  const colors = useAvailableColors(undefined, opened);
  const supervisors = useSupervisors(opened && isAdmin);
  const jobTitles = useReference('job-titles', opened);
  const departments = useReference('departments', opened);

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [supMode, setSupMode] = useState<SupMode>('existing');
  const [supervisorId, setSupervisorId] = useState<string | null>(null);
  const [newSup, setNewSup] = useState(EMPTY_SUP);
  const [colorId, setColorId] = useState<string | null>(null);
  const [colorOverride, setColorOverride] = useState<TeamColorDto[] | null>(null);
  const [colorTaken, setColorTaken] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [created, setCreated] = useState<TeamDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!opened) return;
    setStep(0);
    setName('');
    setSupMode('existing');
    setSupervisorId(null);
    setNewSup(EMPTY_SUP);
    setColorId(null);
    setColorOverride(null);
    setColorTaken(null);
    setErrors({});
    setFormError(null);
    setCreated(null);
    setRound((r) => r + 1);
  }, [opened]);

  const payload = () => ({
    name,
    colorId: colorId ?? '',
    ...(isAdmin && supMode === 'existing' && supervisorId ? { supervisorId } : {}),
    ...(isAdmin && supMode === 'new' ? { newSupervisor: newSup } : {}),
    members: [],
  });

  const checkDetails = () => {
    const r = createTeamSchema.safeParse(payload());
    const errs: Record<string, string> = {};
    if (!r.success) {
      for (const issue of r.error.issues) {
        const key = issue.path.join('.');
        if (!errs[key]) errs[key] = key === 'colorId' ? t('teams.chooseColor') : issue.message;
      }
    }
    if (isAdmin && supMode === 'existing' && !supervisorId)
      errs.supervisorId = t('teams.supervisorRequired');
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /** Creates the team once; a retry of the member import reuses it. */
  const ensureTeam = async (): Promise<TeamDto | null> => {
    if (created) return created;
    setFormError(null);
    try {
      const team = await api.teams.create(payload());
      setCreated(team);
      await invalidate();
      notifications.show({
        color: team.status === 'ACTIVE' ? 'ok' : 'signal',
        message:
          team.status === 'ACTIVE'
            ? t('teams.created', { name: team.name })
            : t('teams.createdPending', { name: team.name }),
      });
      return team;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'COLOR_TAKEN') {
        // Someone took the colour a moment ago: show the fresh list from the server.
        const details = err.details as ColorTakenDetails | undefined;
        setColorOverride(details?.available ?? null);
        setColorId(null);
        setColorTaken(err.message_ar);
        void qc.invalidateQueries({ queryKey: qk2.availableColors() });
        setStep(0);
        return null;
      }
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
        setErrors(err.fieldErrors);
        setStep(0);
      }
      setFormError(err);
      setStep(0);
      return null;
    }
  };

  const finish = (team: TeamDto) => {
    onClose();
    navigate(`/teams/${team.id}`);
  };

  const pickerColors = colorOverride ?? colors.data;
  const willBePending = !isAdmin && (settings.data?.REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS ?? true);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('teams.createTitle')}
      size="xl"
      fullScreen={mobile}
      closeOnClickOutside={false}
    >
      <Stepper active={step} size="sm" mb="lg" allowNextStepsSelect={false}>
        <Stepper.Step label={t('teams.step.details')} />
        <Stepper.Step label={t('teams.step.members')} />
      </Stepper>

      <Box hidden={step !== 0}>
        <Stack gap="md">
          {colorTaken ? (
            <Alert color="signal" icon={<IconAlertTriangle size={18} />} role="alert">
              {colorTaken}
            </Alert>
          ) : null}
          <FormError error={colorTaken ? null : formError} />
          <TextInput
            label={t('teams.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={errors.name}
            maxLength={80}
            data-autofocus
          />
          {isAdmin ? (
            <Stack gap="xs">
              <Text fw={500} size="sm">
                {t('teams.supervisor')}
              </Text>
              <SegmentedControl
                value={supMode}
                onChange={(v) => setSupMode(v as SupMode)}
                data={[
                  { value: 'existing', label: t('teams.supExisting') },
                  { value: 'new', label: t('teams.supNew') },
                ]}
              />
              {supMode === 'existing' ? (
                <Select
                  aria-label={t('teams.supervisor')}
                  placeholder={t('teams.chooseSupervisor')}
                  data={(supervisors.data ?? []).map((s) => ({ value: s.id, label: s.fullName }))}
                  value={supervisorId}
                  onChange={setSupervisorId}
                  searchable
                  nothingFoundMessage={t('teams.noSupervisors')}
                  error={errors.supervisorId}
                />
              ) : (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label={t('register.fullName')}
                    value={newSup.fullName}
                    onChange={(e) => setNewSup({ ...newSup, fullName: e.currentTarget.value })}
                    error={errors['newSupervisor.fullName']}
                  />
                  <TextInput
                    label={t('register.email')}
                    type="email"
                    value={newSup.email}
                    onChange={(e) => setNewSup({ ...newSup, email: e.currentTarget.value })}
                    error={errors['newSupervisor.email']}
                    classNames={{ input: 'ltr' }}
                  />
                  <TextInput
                    label={t('register.mobile')}
                    placeholder={t('register.mobilePlaceholder')}
                    inputMode="tel"
                    value={newSup.mobile}
                    onChange={(e) => setNewSup({ ...newSup, mobile: e.currentTarget.value })}
                    error={errors['newSupervisor.mobile']}
                    classNames={{ input: 'ltr mono' }}
                  />
                  <TextInput
                    label={t('register.nationalId')}
                    inputMode="numeric"
                    value={newSup.nationalId}
                    onChange={(e) => setNewSup({ ...newSup, nationalId: e.currentTarget.value })}
                    error={errors['newSupervisor.nationalId']}
                    classNames={{ input: 'ltr mono' }}
                  />
                </SimpleGrid>
              )}
            </Stack>
          ) : (
            <Alert color="field" variant="light" icon={<IconInfoCircle size={18} />}>
              {willBePending ? t('teams.selfLeadPending') : t('teams.selfLead')}
            </Alert>
          )}
          <ColorPicker
            colors={pickerColors}
            loading={colors.isLoading}
            value={colorId}
            onChange={(id) => {
              setColorId(id);
              setColorTaken(null);
              setErrors((e) => ({ ...e, colorId: '' }));
            }}
            error={errors.colorId}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (checkDetails()) setStep(1);
              }}
            >
              {t('teams.next')}
            </Button>
          </Group>
        </Stack>
      </Box>

      <Box hidden={step !== 1}>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t('teams.membersLead')}
          </Text>
          <MembersImporter
            key={round}
            onPreview={async (rows) =>
              validateImportRows(rows, {
                jobTitles: jobTitles.data,
                departments: departments.data,
              })
            }
            onCommit={async (rows) => {
              const team = await ensureTeam();
              if (!team) return;
              return api.teams.importMembers({ teamId: team.id, rows, commit: true });
            }}
            commitLabel={(n) => t('teams.createWithMembers', { count: n })}
            extraActions={
              created ? (
                <Button variant="light" onClick={() => finish(created)}>
                  {t('teams.openTeam')}
                </Button>
              ) : (
                <>
                  <Button variant="subtle" onClick={() => setStep(0)}>
                    {t('common.back')}
                  </Button>
                  <Button
                    variant="default"
                    loading={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const team = await ensureTeam();
                        if (team) finish(team);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t('teams.createWithoutMembers')}
                  </Button>
                </>
              )
            }
          />
        </Stack>
      </Box>
    </Modal>
  );
}
