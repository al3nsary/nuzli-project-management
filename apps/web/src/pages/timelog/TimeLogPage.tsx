import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Button, Group, Modal, NumberInput, SegmentedControl, Select, Stack, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconChevronLeft, IconChevronRight, IconClockHour4, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { can, type TimeEntryDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { qkA9, useMyTime } from '../../api/a9Queries';
import { useGantt, useMyTasks, useProjects } from '../../api/projectQueries';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, FormError, LoadingBlock, PageHeader } from '../../components/ui';
import { formatMinutes, getDisplayPrefs, riyadhDay, t } from '../../i18n';
import { addDays, startOfWeek, weekDays } from '../../features/calendar/calendarMath';
import { dayNumber, longDay, shortDate, weekdayNames } from '../../features/calendar/calendarFormat';
import { QUICK_MINUTES, buildWeekGrid, splitMinutes, toMinutes, validMinutes, type TaskRef, type WeekRow } from '../../features/timelog/timelog';
import cls from '../../features/timelog/TimeLog.module.css';
import { addCalendarDaysIso } from '../../features/projects/engine';

const WEEKEND = [5, 6];

type EntryDraft = { mode: 'add'; taskId?: string; date: string } | { mode: 'edit'; entry: TimeEntryDto };

/** «سجل وقتي» (A9): my logged time, a week at a time, day × task. */
export function TimeLogPage() {
  const user = useAuthStore((s) => s.user);
  const admin = can(user, 'tasks.manage');
  const phone = useMediaQuery('(max-width: 47.99em)', false, { getInitialValueInEffect: false }) ?? false;
  const digits = getDisplayPrefs().digits;
  const today = riyadhDay();

  const [anchor, setAnchor] = useState(() => startOfWeek(today));
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const from = days[0]!;
  const to = days[6]!;
  const time = useMyTime(from, to);
  const mine = useMyTasks();

  const assigned = useMemo<TaskRef[]>(
    () =>
      (mine.data ?? [])
        .filter((x) => x.type !== 'GROUP' && x.status !== 'DONE')
        .map((x) => ({ id: x.id, name: x.name, projectId: x.project.id, projectName: x.project.name })),
    [mine.data],
  );
  const grid = useMemo(() => buildWeekGrid(time.data ?? [], days, assigned), [time.data, days, assigned]);

  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [cell, setCell] = useState<{ row: WeekRow; day: number } | null>(null);
  // Keep the open cell dialog in step with the refreshed data after a write.
  const liveCell = cell
    ? (grid.rows.find((r) => r.task.id === cell.row.task.id) ?? { ...cell.row, entries: cell.row.entries.map(() => []), byDay: cell.row.byDay.map(() => 0), total: 0 })
    : null;

  const names = weekdayNames('long', digits);
  const thisWeek = startOfWeek(today) === anchor;
  const title = t('a9c.range', { from: shortDate(from, digits), to: shortDate(to, digits, true) });

  const openCell = (row: WeekRow, day: number) => {
    if (row.entries[day]!.length) setCell({ row, day });
    else setDraft({ mode: 'add', taskId: row.task.id, date: days[day]! });
  };

  let content;
  if (time.isLoading) content = <LoadingBlock variant="table" rows={6} />;
  else if (time.isError) content = <ErrorBlock error={time.error} onRetry={() => void time.refetch()} />;
  else if (!grid.rows.length)
    content = (
      <EmptyState
        icon={IconClockHour4}
        title={t('a9c.tl.empty')}
        body={t('a9c.tl.emptyBody')}
        action={{ label: t('a9c.tl.add'), onClick: () => setDraft({ mode: 'add', date: days.includes(today) ? today : from }) }}
      />
    );
  else if (phone)
    content = (
      <div className={cls.dayList}>
        {days.map((day, i) => {
          const entries = grid.rows.flatMap((r) => r.entries[i]!);
          return (
            <section key={day} className={`${cls.dayCard} ${day === today ? cls.dayCardToday : ''}`} aria-label={longDay(day, digits)}>
              <div className={cls.dayCardHead}>
                <h3 className={cls.dayCardTitle}>{longDay(day, digits)}</h3>
                {grid.dayTotals[i] ? <span className={cls.dayCardTotal}>{formatMinutes(grid.dayTotals[i]!)}</span> : null}
                <ActionIcon variant="light" size={44} radius="md" onClick={() => setDraft({ mode: 'add', date: day })} aria-label={t('a9c.tl.addOn', { date: shortDate(day, digits) })}>
                  <IconPlus size={18} />
                </ActionIcon>
              </div>
              {entries.length ? (
                entries.map((e) => <EntryRow key={e.id} entry={e} withTask onEdit={() => setDraft({ mode: 'edit', entry: e })} />)
              ) : (
                <Text size="sm" c="dimmed">
                  {t('a9c.tl.dayEmpty')}
                </Text>
              )}
            </section>
          );
        })}
      </div>
    );
  else
    content = (
      <div className={cls.card}>
        <div className={cls.scroller}>
          <table className={cls.grid}>
            <caption className="sr-only">{t('a9c.tl.caption', { range: title })}</caption>
            <thead>
              <tr>
                <th scope="col" className={cls.taskCol}>
                  {t('a9c.tl.task')}
                </th>
                {days.map((day, i) => (
                  <th key={day} scope="col" className={[WEEKEND.includes(i) ? cls.weekendCol : '', day === today ? `${cls.todayCol} ${cls.todayHead}` : ''].join(' ')}>
                    <span className={cls.dayHead}>
                      <span>{names[i]}</span>
                      <b>{dayNumber(day, digits)}</b>
                    </span>
                  </th>
                ))}
                <th scope="col">{t('a9c.tl.total')}</th>
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row) => (
                <tr key={row.task.id}>
                  <th scope="row" className={cls.taskCell}>
                    <span className={cls.taskName} title={row.task.name}>
                      {row.task.name}
                    </span>
                    <span className={cls.projectName}>{row.task.projectName}</span>
                  </th>
                  {days.map((day, i) => {
                    const m = row.byDay[i]!;
                    return (
                      <td key={day} className={[WEEKEND.includes(i) ? cls.weekendCol : '', day === today ? cls.todayCol : ''].join(' ')}>
                        <button
                          type="button"
                          className={`${cls.cell} ${m ? '' : cls.cellEmpty}`}
                          onClick={() => openCell(row, i)}
                          aria-label={
                            m
                              ? t('a9c.tl.cellAria', { task: row.task.name, date: shortDate(day, digits), time: formatMinutes(m) })
                              : t('a9c.tl.cellAddAria', { task: row.task.name, date: shortDate(day, digits) })
                          }
                        >
                          {m ? <span className={cls.cellValue}>{formatMinutes(m)}</span> : '+'}
                        </button>
                      </td>
                    );
                  })}
                  <td className={cls.rowTotal}>{row.total ? formatMinutes(row.total) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className={cls.taskCell}>{t('a9c.tl.dayTotal')}</td>
                {grid.dayTotals.map((m, i) => (
                  <td key={days[i]}>{m ? formatMinutes(m) : '—'}</td>
                ))}
                <td className={cls.grandTotal}>{formatMinutes(grid.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    );

  return (
    <div>
      <PageHeader
        title={t('nav.timeLog')}
        lead={t('a9c.tl.lead')}
        actions={
          <Button leftSection={<IconPlus size={18} />} onClick={() => setDraft({ mode: 'add', date: days.includes(today) ? today : from })}>
            {t('a9c.tl.add')}
          </Button>
        }
      />

      <div className={cls.toolbar}>
        <Group gap={4} wrap="nowrap">
          <ActionIcon variant="default" size={36} radius="md" onClick={() => setAnchor(addDays(anchor, -7))} aria-label={t('a9c.prevWeek')}>
            <IconChevronLeft size={18} className="mirror-rtl" />
          </ActionIcon>
          <Button variant={thisWeek ? 'light' : 'default'} size="sm" h={36} onClick={() => setAnchor(startOfWeek(today))}>
            {t('a9c.tl.thisWeek')}
          </Button>
          <ActionIcon variant="default" size={36} radius="md" onClick={() => setAnchor(addDays(anchor, 7))} aria-label={t('a9c.nextWeek')}>
            <IconChevronRight size={18} className="mirror-rtl" />
          </ActionIcon>
        </Group>
        <h2 className={cls.weekTitle} aria-live="polite">
          {title}
        </h2>
        <span className={cls.spacer} />
        <span className={cls.totalPill}>
          <span>{t('a9c.tl.weekTotal')}</span>
          {formatMinutes(grid.total)}
        </span>
      </div>

      {content}

      {liveCell && cell ? (
        <Modal opened onClose={() => setCell(null)} title={`${liveCell.task.name} · ${longDay(days[cell.day]!, digits)}`} centered>
          <Stack gap={0}>
            <Text size="xs" c="dimmed" mb={4}>
              {liveCell.task.projectName}
            </Text>
            {liveCell.entries[cell.day]!.length ? (
              liveCell.entries[cell.day]!.map((e) => <EntryRow key={e.id} entry={e} onEdit={() => setDraft({ mode: 'edit', entry: e })} />)
            ) : (
              <Text size="sm" c="dimmed" py="sm">
                {t('a9c.tl.dayEmpty')}
              </Text>
            )}
            <Group justify="space-between" mt="md">
              <Text size="sm" fw={600}>
                {t('a9c.tl.cellTotal', { time: formatMinutes(liveCell.byDay[cell.day]!) })}
              </Text>
              <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => setDraft({ mode: 'add', taskId: liveCell.task.id, date: days[cell.day]! })}>
                {t('a9c.tl.addMore')}
              </Button>
            </Group>
          </Stack>
        </Modal>
      ) : null}

      {draft ? <EntryModal draft={draft} admin={admin} assigned={assigned} logged={grid.rows.map((r) => r.task)} onClose={() => setDraft(null)} /> : null}
    </div>
  );
}

/** One entry with edit and delete (delete asks once more inline). */
function EntryRow({ entry, withTask, onEdit }: { entry: TimeEntryDto; withTask?: boolean; onEdit(): void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api.timeEntries.remove(entry.id);
      invalidateTime(qc, entry.task.id);
      notifications.show({ color: 'ok', message: t('a9c.tl.deleted') });
    } catch (err) {
      notifications.show({ color: 'breach', title: t('a9c.tl.deleteFailed'), message: errorMessage(err) });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <div className={cls.entry}>
      <div className={cls.entryMain}>
        <span className={cls.entryMinutes}>{formatMinutes(entry.minutes)}</span>
        {withTask ? (
          <Text size="sm" fw={500} truncate>
            {entry.task.name} <Text span size="xs" c="dimmed">· {entry.task.projectName}</Text>
          </Text>
        ) : null}
        {entry.note ? <div className={cls.entryNote}>{entry.note}</div> : null}
      </div>
      {confirm ? (
        <Group gap={6} wrap="nowrap">
          <Button size="xs" color="breach" loading={busy} onClick={() => void remove()}>
            {t('a9c.tl.confirmDelete')}
          </Button>
          <Button size="xs" variant="default" onClick={() => setConfirm(false)}>
            {t('common.cancel')}
          </Button>
        </Group>
      ) : (
        <Group gap={4} wrap="nowrap">
          <Tooltip label={t('a9c.tl.edit')}>
            <ActionIcon variant="subtle" color="gray" size={44} onClick={onEdit} aria-label={t('a9c.tl.edit')}>
              <IconPencil size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('a9c.tl.delete')}>
            <ActionIcon variant="subtle" color="breach" size={44} onClick={() => setConfirm(true)} aria-label={t('a9c.tl.delete')}>
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
    </div>
  );
}

function invalidateTime(qc: ReturnType<typeof useQueryClient>, taskId: string) {
  // Every week of «سجل وقتي» (the prefix of qkA9.myTime) and the task's time tab.
  void qc.invalidateQueries({ queryKey: ['time', 'mine'] });
  void qc.invalidateQueries({ queryKey: qkA9.taskTime(taskId) });
}

/** Add or edit an entry: task, date, hours and minutes (or a quick duration), note. */
function EntryModal({
  draft,
  admin,
  assigned,
  logged,
  onClose,
}: {
  draft: EntryDraft;
  admin: boolean;
  assigned: TaskRef[];
  logged: TaskRef[];
  onClose(): void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const editing = draft.mode === 'edit' ? draft.entry : null;
  const start = editing ? splitMinutes(editing.minutes) : { hours: 1, minutes: 0 };
  const [source, setSource] = useState<'mine' | 'project'>('mine');
  const [taskId, setTaskId] = useState<string | null>(editing ? editing.task.id : draft.mode === 'add' ? (draft.taskId ?? null) : null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [date, setDate] = useState(editing ? editing.date.slice(0, 10) : draft.mode === 'add' ? draft.date : riyadhDay());
  const [hours, setHours] = useState<number | string>(start.hours);
  const [minutes, setMinutes] = useState<number | string>(start.minutes);
  const [note, setNote] = useState(editing?.note ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const projects = useProjects({}, admin && source === 'project');
  const gantt = useGantt(admin && source === 'project' ? projectId : null);
  useEffect(() => {
    if (source === 'project') setTaskId(null);
  }, [projectId, source]);

  // «مهامي»: tasks assigned to me plus the ones I already logged this week, grouped by project.
  const mineOptions = useMemo(() => {
    const byProject = new Map<string, { group: string; items: { value: string; label: string }[] }>();
    const seen = new Set<string>();
    for (const x of [...assigned, ...logged]) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      const g = byProject.get(x.projectId) ?? { group: x.projectName, items: [] };
      g.items.push({ value: x.id, label: x.name });
      byProject.set(x.projectId, g);
    }
    return [...byProject.values()];
  }, [assigned, logged]);
  const projectOptions = useMemo(() => (projects.data ?? []).map((p) => ({ value: p.id, label: p.name })), [projects.data]);
  const projectTaskOptions = useMemo(
    () => (gantt.data?.tasks ?? []).filter((x) => x.type !== 'GROUP').map((x) => ({ value: x.id, label: `${x.wbs} ${x.name}` })),
    [gantt.data],
  );

  const total = toMinutes(hours, minutes);
  const tooMuch = total > 1440;
  const valid = validMinutes(total) && /^\d{4}-\d{2}-\d{2}$/.test(date) && (!!editing || !!taskId);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const body = { date, minutes: total, note: note.trim() || undefined };
      const res = editing ? await api.timeEntries.update(editing.id, body) : await api.tasks.addTimeEntry(taskId as string, body);
      invalidateTime(qc, res.task.id);
      if (editing && editing.task.id !== res.task.id) invalidateTime(qc, editing.task.id);
      notifications.show({ color: 'ok', message: editing ? t('a9c.tl.updated') : t('a9c.tl.added', { time: formatMinutes(total) }) });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={editing ? t('a9c.tl.editTitle') : t('a9c.tl.addTitle')} centered size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="md">
          {editing ? (
            <div>
              <Text size="sm" fw={600}>
                {editing.task.name}
              </Text>
              <Text size="xs" c="dimmed">
                {editing.task.projectName}
              </Text>
            </div>
          ) : (
            <>
              {admin ? (
                <SegmentedControl
                  fullWidth
                  value={source}
                  onChange={(v) => setSource(v as 'mine' | 'project')}
                  data={[
                    { value: 'mine', label: t('a9c.tl.source.mine') },
                    { value: 'project', label: t('a9c.tl.source.project') },
                  ]}
                  aria-label={t('a9c.tl.source.label')}
                />
              ) : null}
              {source === 'mine' || !admin ? (
                <Select
                  label={t('a9c.tl.task')}
                  placeholder={t('a9c.tl.pickTask')}
                  data={mineOptions}
                  value={taskId}
                  onChange={setTaskId}
                  searchable
                  required
                  nothingFoundMessage={mineOptions.length ? t('a9c.tl.noMatch') : t('a9c.tl.noAssigned')}
                  comboboxProps={{ withinPortal: true }}
                />
              ) : (
                <>
                  <Select
                    label={t('a9c.tl.project')}
                    placeholder={projects.isLoading ? t('a9c.tl.loading') : t('a9c.tl.pickProject')}
                    data={projectOptions}
                    value={projectId}
                    onChange={setProjectId}
                    searchable
                    required
                    nothingFoundMessage={t('a9c.tl.noMatch')}
                    comboboxProps={{ withinPortal: true }}
                  />
                  <Select
                    label={t('a9c.tl.task')}
                    placeholder={gantt.isLoading && projectId ? t('a9c.tl.loading') : t('a9c.tl.pickTask')}
                    data={projectTaskOptions}
                    value={taskId}
                    onChange={setTaskId}
                    searchable
                    required
                    disabled={!projectId}
                    nothingFoundMessage={t('a9c.tl.noMatch')}
                    comboboxProps={{ withinPortal: true }}
                  />
                </>
              )}
            </>
          )}

          <TextInput type="date" label={t('a9c.tl.date')} value={date} min={addCalendarDaysIso(riyadhDay(), -366)} max={addCalendarDaysIso(riyadhDay(), 7)} onChange={(e) => setDate(e.currentTarget.value)} required />

          <div>
            <Group grow gap="sm" align="flex-start">
              <NumberInput label={t('a9c.tl.hours')} value={hours} onChange={setHours} min={0} max={24} step={1} allowDecimal={false} allowNegative={false} />
              <NumberInput label={t('a9c.tl.minutes')} value={minutes} onChange={setMinutes} min={0} max={59} step={5} allowDecimal={false} allowNegative={false} />
            </Group>
            <div className={cls.quick} style={{ marginTop: 8 }} role="group" aria-label={t('a9c.tl.quick')}>
              {QUICK_MINUTES.map((q) => {
                const on = total === q;
                return (
                  <Button
                    key={q}
                    size="compact-sm"
                    variant={on ? 'light' : 'default'}
                    aria-pressed={on}
                    onClick={() => {
                      const s = splitMinutes(q);
                      setHours(s.hours);
                      setMinutes(s.minutes);
                    }}
                  >
                    {formatMinutes(q)}
                  </Button>
                );
              })}
            </div>
            <Text size="xs" c={tooMuch || total < 1 ? 'var(--red)' : 'dimmed'} mt={6}>
              {tooMuch ? t('a9c.tl.tooMuch') : total < 1 ? t('a9c.tl.tooLittle') : t('a9c.tl.totalIs', { time: formatMinutes(total) })}
            </Text>
          </div>

          <Textarea label={t('a9c.tl.note')} placeholder={t('a9c.tl.notePh')} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} autosize minRows={2} maxRows={5} />

          <FormError error={error} />

          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!valid}>
              {editing ? t('a9c.tl.saveEdit') : t('a9c.tl.saveAdd')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
