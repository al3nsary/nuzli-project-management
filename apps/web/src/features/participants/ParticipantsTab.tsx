/**
 * «المشاركون» of a project (A12 round 2, docs/a12-roles.md §3): people of the workspace added to
 * THIS project with a free-text منصب and a level (محرّر / مساهم / مطّلع). Admins and assistants
 * with projects:edit (`projects.manage`) add, edit and remove; everyone who sees the project reads.
 * Errors (PARTICIPANT_NOT_MEMBER / PARTICIPANT_EXISTS / PROJECT_ARCHIVED) come back in Arabic.
 */
import { useMemo, useState } from 'react';
import { ActionIcon, Button, Group, Modal, Radio, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPencil, IconTrash, IconUserPlus, IconUsersGroup } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { PARTICIPANT_LEVELS, addParticipantSchema, type ParticipantCandidateDto, type ParticipantDto, type ParticipantLevel } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { a12k, useParticipantCandidates, useParticipants } from '../../api/a12Queries';
import { EmptyState, ErrorBlock, FormError, LoadingBlock, roleLabel } from '../../components/ui';
import { DualRoleBadge } from '../workspaces/DualRole';
import { UserPhotoAvatar } from '../../components/UserAvatar';
import { formatDate, formatNumber, t } from '../../i18n';
import './participants.css';

const LEVEL_PILL: Record<ParticipantLevel, string> = { EDITOR: 'brand', CONTRIBUTOR: 'blue', VIEWER: 'grey' };

export const levelLabel = (l: ParticipantLevel) => t(`participantLevel.${l}`);

export function LevelPill({ level }: { level: ParticipantLevel }) {
  return (
    <span className={`pill ${LEVEL_PILL[level]}`} data-level={level}>
      {levelLabel(level)}
    </span>
  );
}

export function ParticipantsTab({ projectId, projectName, canManage }: { projectId: string; projectName: string; canManage: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const list = useParticipants(projectId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ParticipantDto | null>(null);
  const rows = useMemo(() => [...(list.data ?? [])].sort((a, b) => a.user.fullName.localeCompare(b.user.fullName, 'ar')), [list.data]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: a12k.participants(projectId) });
    void qc.invalidateQueries({ queryKey: a12k.participations });
  };

  const remove = (p: ParticipantDto) =>
    modals.openConfirmModal({
      title: t('a12roles.part.removeTitle', { name: p.user.fullName }),
      children: <Text size="sm">{t('a12roles.part.removeBody', { name: p.user.fullName })}</Text>,
      labels: { confirm: t('a12roles.part.removeConfirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'breach', 'data-testid': 'participant-remove-confirm' } as never,
      onConfirm: async () => {
        try {
          await api.participants.remove(projectId, p.user.id);
          invalidate();
          notifications.show({ color: 'ok', message: t('a12roles.part.removed', { name: p.user.fullName }) });
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });

  return (
    <section className="nz-part" aria-labelledby="nz-part-title" data-testid="participants-panel">
      <header className="nz-part-head">
        <div style={{ minWidth: 0 }}>
          <h2 id="nz-part-title" className="nz-part-title">
            {t('a12roles.part.title')}
          </h2>
          <Text size="sm" c="dimmed">
            {canManage ? t('a12roles.part.lead') : t('a12roles.part.readOnlyNote')}
          </Text>
        </div>
        {canManage && rows.length ? (
          <Button leftSection={<IconUserPlus size={18} />} onClick={() => setAdding(true)} data-testid="participant-add">
            {t('a12roles.part.add')}
          </Button>
        ) : null}
      </header>

      {list.isLoading ? (
        <LoadingBlock variant="list" rows={3} />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !rows.length ? (
        canManage ? (
          <div data-testid="participants-empty">
            <EmptyState icon={IconUsersGroup} title={t('a12roles.part.empty')} body={t('a12roles.part.emptyBody')} />
            <Group justify="center" mt="sm">
              <Button leftSection={<IconUserPlus size={18} />} onClick={() => setAdding(true)} data-testid="participant-add">
                {t('a12roles.part.add')}
              </Button>
            </Group>
          </div>
        ) : (
          <EmptyState icon={IconUsersGroup} title={t('a12roles.part.empty')} body={t('a12roles.part.emptyReader')} />
        )
      ) : (
        <>
          <Text size="xs" c="dimmed" mb={6}>
            {t('a12roles.part.count', { n: formatNumber(rows.length) })}
          </Text>
          <ul className="nz-part-list" aria-label={t('a12roles.part.title')}>
            {rows.map((p) => (
              <li key={p.user.id} className="nz-part-row" data-testid="participant-row" data-user={p.user.id}>
                <UserPhotoAvatar user={p.user} size={40} />
                <div className="nz-part-who">
                  <Group gap={6} wrap="nowrap">
                    <Text fw={600} truncate>
                      {p.user.fullName}
                    </Text>
                    <DualRoleBadge user={p.user} compact />
                  </Group>
                  <Text size="sm" c="dimmed" truncate>
                    {p.title}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {p.addedBy ? t('a12roles.part.addedBy', { name: p.addedBy.fullName, date: formatDate(p.createdAt.slice(0, 10)) }) : t('a12roles.part.addedOn', { date: formatDate(p.createdAt.slice(0, 10)) })}
                  </Text>
                </div>
                <LevelPill level={p.level} />
                {canManage ? (
                  <Group gap={4} wrap="nowrap" className="nz-part-actions">
                    <Tooltip label={t('a12roles.part.edit', { name: p.user.fullName })} withinPortal openDelay={300}>
                      <ActionIcon variant="subtle" size={44} aria-label={t('a12roles.part.edit', { name: p.user.fullName })} onClick={() => setEditing(p)} data-testid="participant-edit">
                        <IconPencil size={18} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t('a12roles.part.remove', { name: p.user.fullName })} withinPortal openDelay={300}>
                      <ActionIcon variant="subtle" color="breach" size={44} aria-label={t('a12roles.part.remove', { name: p.user.fullName })} onClick={() => remove(p)} data-testid="participant-remove">
                        <IconTrash size={18} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {canManage ? (
        <>
          <ParticipantDialog
            opened={adding}
            onClose={() => setAdding(false)}
            projectId={projectId}
            projectName={projectName}
            taken={rows.map((r) => r.user.id)}
            onDone={invalidate}
          />
          <ParticipantDialog
            key={editing?.user.id ?? 'none'}
            opened={Boolean(editing)}
            onClose={() => setEditing(null)}
            projectId={projectId}
            projectName={projectName}
            editing={editing}
            taken={[]}
            onDone={invalidate}
          />
        </>
      ) : null}
    </section>
  );
}

const pickedLabel = (c: Pick<ParticipantCandidateDto, 'fullName' | 'username'>) => `${c.fullName} — ${c.username}`;

/** One person in the picker: name, username, role in the workspace and the dual-role mark. */
function CandidateOption({ c }: { c: ParticipantCandidateDto }) {
  return (
    <Group gap="sm" wrap="nowrap" data-testid="participant-candidate" data-user={c.id}>
      <UserPhotoAvatar user={c} size={28} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={600} truncate>
            {c.fullName}
          </Text>
          <DualRoleBadge user={c} compact />
        </Group>
        <Text size="xs" c="dimmed" truncate>
          <span className="ltr">{c.username}</span> · {roleLabel(c.role)}
        </Text>
      </div>
    </Group>
  );
}

/** Add (pick a person) or edit (منصب and level) one participant. */
function ParticipantDialog({
  opened,
  onClose,
  projectId,
  projectName,
  editing = null,
  taken,
  onDone,
}: {
  opened: boolean;
  onClose(): void;
  projectId: string;
  projectName: string;
  editing?: ParticipantDto | null;
  taken: string[];
  onDone(): void;
}) {
  const api = useApi();
  const phone = useMediaQuery('(max-width: 600px)') ?? false;
  // A12 round 3: the picker reads `participant-candidates` (the API's minimal list for whoever
  // manages participants) — an assistant with projects:edit needs no users module.
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search.trim(), 250);
  const [userId, setUserId] = useState<string | null>(null);
  const [picked, setPicked] = useState<ParticipantCandidateDto | null>(null);
  const members = useParticipantCandidates(projectId, picked && search === pickedLabel(picked) ? '' : debounced, opened && !editing);
  const [title, setTitle] = useState(editing?.title ?? '');
  const [level, setLevel] = useState<ParticipantLevel>(editing?.level ?? 'CONTRIBUTOR');
  const [errors, setErrors] = useState<{ userId?: string; title?: string }>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const byId = useMemo(() => {
    const out = new Map<string, ParticipantCandidateDto>();
    if (picked) out.set(picked.id, picked);
    for (const c of members.data ?? []) if (!taken.includes(c.id)) out.set(c.id, c);
    return out;
  }, [members.data, taken, picked]);
  const options = useMemo(() => [...byId.values()].map((c) => ({ value: c.id, label: pickedLabel(c) })), [byId]);

  const reset = () => {
    setUserId(null);
    setPicked(null);
    setSearch('');
    setTitle(editing?.title ?? '');
    setLevel(editing?.level ?? 'CONTRIBUTOR');
    setErrors({});
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    setError(null);
    const errs: { userId?: string; title?: string } = {};
    if (!editing && !userId) errs.userId = t('a12roles.part.personRequired');
    if (!title.trim()) errs.title = t('a12roles.part.positionRequired');
    if (!editing && userId) {
      const parsed = addParticipantSchema.safeParse({ userId, title, level });
      if (!parsed.success) for (const i of parsed.error.issues) if (i.path[0] === 'title') errs.title ??= i.message;
    }
    setErrors(errs);
    if (errs.userId || errs.title) return;
    setBusy(true);
    try {
      if (editing) {
        await api.participants.update(projectId, editing.user.id, { title: title.trim(), level });
        notifications.show({ color: 'ok', message: t('a12roles.part.updated', { name: editing.user.fullName }) });
      } else {
        const res = await api.participants.add(projectId, { userId: userId!, title: title.trim(), level });
        notifications.show({ color: 'ok', message: t('a12roles.part.added', { name: res.user.fullName, level: levelLabel(res.level) }) });
      }
      onDone();
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={editing ? t('a12roles.part.editTitle', { name: editing.user.fullName }) : t('a12roles.part.addTitle', { project: projectName })}
      size="lg"
      fullScreen={phone}
    >
      <Stack gap="md">
        <FormError error={error ?? (members.isError ? members.error : null)} />
        {editing ? (
          <Group gap="sm" wrap="nowrap">
            <UserPhotoAvatar user={editing.user} size={36} />
            <Text fw={600}>{editing.user.fullName}</Text>
          </Group>
        ) : (
          <Select
            label={t('a12roles.part.person')}
            description={t('a12roles.part.personHint')}
            placeholder={t('a12roles.part.personPlaceholder')}
            data={options}
            value={userId}
            onChange={(v) => {
              setUserId(v);
              setPicked(v ? (byId.get(v) ?? null) : null);
            }}
            searchable
            searchValue={search}
            onSearchChange={setSearch}
            // The API already searched (name or username): show its answer as is.
            filter={({ options: all }) => all}
            renderOption={({ option }) => {
              const c = byId.get(option.value);
              return c ? <CandidateOption c={c} /> : option.label;
            }}
            clearable
            withAsterisk
            nothingFoundMessage={members.isFetching ? t('app.loading') : t('a12roles.part.noPeople')}
            error={errors.userId}
            comboboxProps={{ withinPortal: true }}
            data-testid="participant-person"
            data-autofocus
          />
        )}
        <TextInput
          label={t('a12roles.part.position')}
          placeholder={t('a12roles.part.positionPlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          maxLength={120}
          withAsterisk
          error={errors.title}
          data-testid="participant-title"
        />
        <Radio.Group label={t('a12roles.part.level')} value={level} onChange={(v) => setLevel(v as ParticipantLevel)} withAsterisk>
          <Stack gap="xs" mt={6}>
            {PARTICIPANT_LEVELS.map((l) => (
              <label key={l} className="nz-level-option" data-checked={level === l || undefined}>
                <Radio value={l} aria-describedby={`lvl-hint-${l}`} data-testid={`participant-level-${l}`} />
                <span className="nz-level-text">
                  <span className="nz-level-name">{levelLabel(l)}</span>
                  <span className="nz-level-hint" id={`lvl-hint-${l}`}>
                    {t(`participantLevel.${l}.hint`)}
                  </span>
                </span>
              </label>
            ))}
          </Stack>
        </Radio.Group>
        <Group justify="flex-end" className="nz-part-dialog-actions">
          <Button variant="default" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} loading={busy} data-testid="participant-submit">
            {editing ? t('a12roles.part.save') : t('a12roles.part.addConfirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
