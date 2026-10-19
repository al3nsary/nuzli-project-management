/**
 * «قائمة»: the editable tree table (brief §6.1). Rows are windowed like the Gantt (44 px rows,
 * visible rows + overscan). Admins edit every field, indent/outdent, add and delete; a
 * supervisor edits progress and status of their own tasks only. Every edit goes through
 * `PATCH /tasks/:id` with the task's version; the server's `affected` list is merged.
 */
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { ActionIcon, Button, Checkbox, Group, Menu, NativeSelect, NumberInput, Text, TextInput, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconArrowBarToLeft,
  IconArrowBarToRight,
  IconDiamond,
  IconFolderPlus,
  IconCheck,
  IconFlag3,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { can, type GanttDto, type Priority, type TaskDto, type TaskStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useSupervisors } from '../../api/queries';
import type { useProjectWrites } from '../../api/projectWrites';
import { useAuthStore } from '../../stores/auth';
import { formatDate, formatMoney, formatNumber, t } from '../../i18n';
import { useViewPref } from '../../api/a9Queries';
import {
  COLUMN_DEFS,
  DEFAULT_LIST_COLUMNS,
  availableColumns,
  clampWidth,
  dropIndex,
  fieldIdOf,
  isCustom,
  moveColumn,
  normalizeColumns,
  resizeColumn,
  type BaseColumnId,
  type ColumnId,
  type ColumnPref,
} from '../../features/gantt/columns';
import { buildRows } from '../../features/gantt/geometry';
import { riyadhToday } from '../../features/projects/engine';
import { PRIORITIES, TASK_STATUSES, priorityLabel, taskStatusLabel } from './parts';
import { ConflictAlert } from './TaskDrawer';
import { TaskChatButton, type ChatCount } from '../../features/tasks/TaskChatButton';

type Writes = ReturnType<typeof useProjectWrites>;
const ROW = 44;
const OVERSCAN = 6;
/** Fixed row height: dates stay on one line (the Hijri date is in the Gantt header and the editor). */
const COMPACT = { showHijri: false } as const;

export function ListView({
  data,
  writes,
  onOpenTask,
  chatCounts,
  onOpenChat,
  selecting = false,
  selected,
  onSelectionChange,
}: {
  data: GanttDto;
  writes: Writes;
  onOpenTask(id: string): void;
  /** A10: the «المحادثة» column (chat icon with count and unread). */
  chatCounts?: ReadonlyMap<string, ChatCount>;
  onOpenChat?(id: string): void;
  selecting?: boolean;
  selected?: ReadonlySet<string>;
  onSelectionChange?(next: Set<string>): void;
}) {
  // A9: the columns are the user's (`list.columns`, per project), like the Gantt grid.
  const [colsRaw, setColsPref] = useViewPref<ColumnPref[] | null>('list.columns', data.project.id, null);
  const cols = useMemo(() => normalizeColumns(colsRaw ?? DEFAULT_LIST_COLUMNS, data.customFields ?? [], DEFAULT_LIST_COLUMNS), [colsRaw, data.customFields]);
  const [liveCols, setLiveCols] = useState<ColumnPref[] | null>(null);
  const shown = liveCols ?? cols;
  const setCols = (next: ColumnPref[]) => setColsPref(next.length ? next : DEFAULT_LIST_COLUMNS);
  const fieldsById = useMemo(() => new Map((data.customFields ?? []).map((x) => [x.id, x])), [data.customFields]);
  const labelsById = useMemo(() => new Map((data.labels ?? []).map((x) => [x.id, x])), [data.labels]);
  const colLabel = (id: ColumnId) => (isCustom(id) ? (fieldsById.get(fieldIdOf(id)!)?.name ?? '') : t(COLUMN_DEFS[id as BaseColumnId].label));
  const headRef = useRef<HTMLTableRowElement>(null);
  const startResize = (e: RPointerEvent, id: ColumnId) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = cols.find((c) => c.id === id)?.width ?? 100;
    const rtl = document.documentElement.dir !== 'ltr';
    let latest = cols;
    const move = (ev: PointerEvent) => {
      latest = resizeColumn(cols, id, clampWidth(id, w0 + (ev.clientX - x0) * (rtl ? -1 : 1)));
      setLiveCols(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLiveCols(null);
      setCols(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const startMove = (e: RPointerEvent, index: number) => {
    if (index === 0 || e.button !== 0) return;
    const head = headRef.current;
    if (!head) return;
    const x0 = e.clientX;
    let moved = false;
    let to = index;
    const rtl = document.documentElement.dir !== 'ltr';
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5) return;
      moved = true;
      const r = head.getBoundingClientRect();
      const offset = selecting ? 40 : 0;
      const total = cols.reduce((a, c) => a + c.width, 0);
      const local = rtl ? r.right - offset - ev.clientX : ev.clientX - r.left - offset;
      to = dropIndex(cols, rtl ? total - local : local, total, rtl);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved && to !== index) setCols(moveColumn(cols, index, to));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const admin = can(user, 'tasks.manage');
  const supervisors = useSupervisors(admin);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = useMemo(() => buildRows(data.tasks, collapsed), [data.tasks, collapsed]);
  const [focus, setFocus] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(560);
  const scroller = useRef<HTMLDivElement | null>(null);
  const focused = rows[focus]?.task ?? null;

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length - 1, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);
  const visible = rows.slice(first, last + 1);

  const update = async (task: TaskDto, patch: Record<string, unknown>, structural = false) => {
    try {
      await writes.updateTask(task.id, { version: task.version, ...patch } as never);
      if (structural) await writes.refresh();
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  const siblings = (task: TaskDto) => data.tasks.filter((x) => x.parentId === task.parentId);

  const indent = (task: TaskDto) => {
    const sibs = siblings(task);
    const i = sibs.findIndex((x) => x.id === task.id);
    const prev = sibs[i - 1];
    if (!prev || prev.type === 'MILESTONE') {
      notifications.show({ color: 'signal', message: t('list.cannotIndent') });
      return;
    }
    void update(task, { parentId: prev.id }, true);
  };
  const outdent = (task: TaskDto) => {
    if (!task.parentId) return;
    const parent = data.tasks.find((x) => x.id === task.parentId);
    void update(task, { parentId: parent?.parentId ?? null }, true);
  };

  const add = async (type: 'TASK' | 'MILESTONE' | 'GROUP') => {
    const anchor = focused;
    const parentId = anchor ? (anchor.type === 'GROUP' && !collapsed.has(anchor.id) ? anchor.id : anchor.parentId) : null;
    const afterId = anchor && parentId === anchor.parentId ? anchor.id : undefined;
    try {
      const created = await writes.run(() =>
        api.tasks.create(data.project.id, {
          name: type === 'MILESTONE' ? t('list.newMilestone') : type === 'GROUP' ? t('list.newGroup') : t('list.newTask'),
          type,
          parentId,
          ...(afterId ? { afterId } : {}),
          startDate: anchor?.startDate ?? (data.project.startDate > riyadhToday() ? data.project.startDate : riyadhToday()),
          durationDays: type === 'MILESTONE' ? 0 : 1,
        }),
      );
      await writes.refresh();
      notifications.show({ color: 'ok', message: t('list.added', { name: created.name }) });
      onOpenTask(created.id);
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  const remove = (task: TaskDto) =>
    modals.openConfirmModal({
      title: t('task.archiveTitle'),
      children: <Text size="sm">{t('task.archiveBody', { name: task.name })}</Text>,
      labels: { confirm: t('task.archive'), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: async () => {
        try {
          await writes.run(() => api.tasks.archive(task.id));
          await writes.refresh();
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    if (e.target !== e.currentTarget) return; // typing in a cell editor
    const go = (i: number) => {
      e.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, i));
      setFocus(next);
      const el = scroller.current;
      if (el) {
        const top = next * ROW;
        if (top < el.scrollTop + ROW) el.scrollTop = Math.max(0, top - ROW);
        else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + 2 * ROW - el.clientHeight;
      }
      requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-list-row="${next}"]`)?.focus());
    };
    if (e.key === 'ArrowDown') go(index + 1);
    else if (e.key === 'ArrowUp') go(index - 1);
    else if (e.key === 'Enter') {
      e.preventDefault();
      onOpenTask(rows[index]!.id);
    } else if (e.key === 'Delete' && admin) {
      e.preventDefault();
      remove(rows[index]!.task);
    }
  };

  const supervisorOptions = [{ value: '', label: t('task.unassigned') }, ...(supervisors.data ?? []).map((u) => ({ value: u.id, label: u.fullName }))];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {writes.conflict ? <ConflictAlert onRefresh={() => void writes.refresh()} /> : null}
      {admin ? (
        <Group gap="xs" wrap="wrap">
          <Button size="xs" leftSection={<IconPlus size={16} />} onClick={() => void add('TASK')}>
            {t('list.addTask')}
          </Button>
          <Button size="xs" variant="light" leftSection={<IconDiamond size={16} />} onClick={() => void add('MILESTONE')}>
            {t('list.addMilestone')}
          </Button>
          <Button size="xs" variant="light" leftSection={<IconFolderPlus size={16} />} onClick={() => void add('GROUP')}>
            {t('list.addGroup')}
          </Button>
          <Tooltip label={t('list.indent')}>
            <ActionIcon variant="default" size="lg" aria-label={t('list.indent')} disabled={!focused} onClick={() => focused && indent(focused)}>
              {/* Indent points to the inline-end (mirrored in RTL). */}
              <IconArrowBarToRight size={18} className="mirror-rtl" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('list.outdent')}>
            <ActionIcon variant="default" size="lg" aria-label={t('list.outdent')} disabled={!focused?.parentId} onClick={() => focused && outdent(focused)}>
              <IconArrowBarToLeft size={18} className="mirror-rtl" />
            </ActionIcon>
          </Tooltip>
          {focused ? (
            <Text size="xs" c="dimmed">
              {t('list.selected', { name: `${focused.wbs} ${focused.name}` })}
            </Text>
          ) : null}
        </Group>
      ) : null}
      <div
        ref={(el) => {
          scroller.current = el;
          if (el && el.clientHeight && el.clientHeight !== height) setHeight(el.clientHeight);
        }}
        className="nz-tree-scroll"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <table className="nz-tree-table" role="treegrid" aria-label={t('list.label', { name: data.project.name })} aria-rowcount={rows.length}>
          <thead>
            <tr ref={headRef}>
              {selecting ? (
                <th style={{ width: 40 }}>
                  <Checkbox
                    size="xs"
                    aria-label={t('grid.selectAll')}
                    checked={Boolean(selected?.size) && rows.every((r) => selected?.has(r.task.id))}
                    onChange={(e) => onSelectionChange?.(e.currentTarget.checked ? new Set(rows.map((r) => r.task.id)) : new Set())}
                  />
                </th>
              ) : null}
              {shown.map((c, i) => (
                <th key={c.id} style={{ width: c.width, position: 'relative', cursor: i > 0 ? 'grab' : undefined }} onPointerDown={(e) => startMove(e, i)} title={i > 0 ? t('col.dragHint') : undefined}>
                  {colLabel(c.id)}
                  <span className="nz-th-resize" role="separator" aria-label={t('col.resize', { name: colLabel(c.id) })} onPointerDown={(e) => startResize(e, c.id)} />
                </th>
              ))}
              <th style={{ width: 44 }}>
                <Menu position="bottom-end" withinPortal shadow="md" width={240}>
                  <Menu.Target>
                    <ActionIcon variant="subtle" size="sm" aria-label={t('col.add')}>
                      <IconPlus size={15} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown mah={420} style={{ overflowY: 'auto' }}>
                    <Menu.Label>{t('col.addTitle')}</Menu.Label>
                    {[...cols.map((c) => c.id), ...availableColumns(cols, data.customFields ?? [])].map((id) => {
                      const on = cols.some((c) => c.id === id);
                      return (
                        <Menu.Item
                          key={id}
                          disabled={id === 'name'}
                          closeMenuOnClick={false}
                          leftSection={<span style={{ width: 16, display: 'inline-flex' }}>{on ? <IconCheck size={15} /> : null}</span>}
                          onClick={() => setCols(on ? cols.filter((x) => x.id !== id) : [...cols, { id, width: isCustom(id) ? 140 : COLUMN_DEFS[id as BaseColumnId].width }])}
                        >
                          {colLabel(id)}
                        </Menu.Item>
                      );
                    })}
                    <Menu.Divider />
                    <Menu.Item onClick={() => setCols(DEFAULT_LIST_COLUMNS)}>{t('col.reset')}</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </th>
            </tr>
          </thead>
          <tbody>
            {first > 0 ? <tr style={{ height: first * ROW }} aria-hidden /> : null}
            {visible.map((r) => {
              const task = r.task;
              const isGroup = r.hasChildren;
              const mine = task.assignee?.id === user?.id && can(user, 'tasks.updateAssigned');
              const editStatus = admin || mine;
              const cellOf = (id: ColumnId): ReactNode => {
                switch (id) {
                  case 'chat':
                    return onOpenChat ? (
                      <TaskChatButton taskName={task.name} chat={chatCounts?.get(task.id)} onOpen={() => onOpenChat(task.id)} />
                    ) : (
                      <span className="num">{formatNumber(chatCounts?.get(task.id)?.count ?? task.commentCount ?? 0)}</span>
                    );
                  case 'wbs':
                    return <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{task.wbs}</span>;
                  case 'name':
                    return (<>
                    <Group gap={4} wrap="nowrap" style={{ paddingInlineStart: r.depth * 16 }}>
                      {isGroup ? (
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          aria-label={collapsed.has(task.id) ? t('gantt.expand') : t('gantt.collapse')}
                          onClick={() =>
                            setCollapsed((c) => {
                              const n = new Set(c);
                              if (n.has(task.id)) n.delete(task.id);
                              else n.add(task.id);
                              return n;
                            })
                          }
                        >
                          <span className={collapsed.has(task.id) ? 'mirror-rtl' : undefined} aria-hidden>
                            {collapsed.has(task.id) ? '▸' : '▾'}
                          </span>
                        </ActionIcon>
                      ) : (
                        <span style={{ width: 22, flex: 'none' }} />
                      )}
                      {admin ? (
                        <CommitText value={task.name} label={t('task.name')} bold={isGroup} onCommit={(name) => name.trim() && name.trim() !== task.name && void update(task, { name: name.trim() })} />
                      ) : (
                        <Text size="sm" fw={isGroup ? 600 : 400} truncate>
                          {task.name}
                        </Text>
                      )}
                      <ActionIcon variant="subtle" size="sm" aria-label={t('list.open', { name: task.name })} onClick={() => onOpenTask(task.id)}>
                        <span aria-hidden>⋯</span>
                      </ActionIcon>
                    </Group>
                  </>);
                  case 'start':
                    return (<>
                    {admin && !isGroup ? (
                      <TextInput size="xs" type="date" aria-label={t('task.start')} value={task.startDate} onChange={(e) => e.currentTarget.value && e.currentTarget.value !== task.startDate && void update(task, { startDate: e.currentTarget.value })} />
                    ) : (
                      <Text size="sm">
                        {formatDate(task.startDate, COMPACT)}
                      </Text>
                    )}
                  </>);
                  case 'duration':
                    return (<>
                    {admin && !isGroup && task.type !== 'MILESTONE' ? (
                      <CommitNumber value={task.durationDays} min={1} max={3650} label={t('task.duration')} onCommit={(v) => v !== task.durationDays && void update(task, { durationDays: v })} />
                    ) : (
                      <Text size="sm" className="num">
                        {formatNumber(task.durationDays)}
                      </Text>
                    )}
                  </>);
                  case 'end':
                    return (<>
                    <Text size="sm">
                      {formatDate(task.endDate, COMPACT)}
                    </Text>
                  </>);
                  case 'progress':
                    return (<>
                    {editStatus && !isGroup ? (
                      <CommitNumber value={task.progress} min={0} max={100} step={5} label={t('task.progress')} suffix="٪" onCommit={(v) => v !== task.progress && void update(task, { progress: v })} />
                    ) : (
                      <Text size="sm" className="num">{`${formatNumber(Math.round(task.progress))}٪`}</Text>
                    )}
                  </>);
                  case 'status':
                    return (<>
                    {editStatus && !isGroup ? (
                      <NativeSelect size="xs" aria-label={t('task.status')} value={task.status} data={TASK_STATUSES.map((s) => ({ value: s, label: taskStatusLabel(s) }))} onChange={(e) => void update(task, { status: e.currentTarget.value as TaskStatus })} />
                    ) : (
                      <Text size="sm">{taskStatusLabel(task.status)}</Text>
                    )}
                  </>);
                  case 'priority':
                    return (<>
                    {admin ? (
                      <NativeSelect size="xs" aria-label={t('task.priority')} value={task.priority} data={PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))} onChange={(e) => void update(task, { priority: e.currentTarget.value as Priority })} />
                    ) : (
                      <Text size="sm">{priorityLabel(task.priority)}</Text>
                    )}
                  </>);
                  case 'assignee':
                    return (<>
                    {admin && !isGroup ? (
                      <NativeSelect
                        size="xs"
                        aria-label={t('task.assignee')}
                        value={task.assignee?.id ?? ''}
                        data={supervisorOptions}
                        onChange={(e) => void update(task, { assigneeId: e.currentTarget.value || null })}
                      />
                    ) : (
                      <Text size="sm" truncate>
                        {task.assignee ? `${task.assignee.fullName}${task.assignee.teamName ? ` — ${task.assignee.teamName}` : ''}` : t('common.none')}
                      </Text>
                    )}
                  </>);
                  case 'deadline':
                    return admin && !isGroup ? (
                      <TextInput size="xs" type="date" aria-label={t('col.deadline')} value={task.deadline ?? ''} onChange={(e) => void update(task, { deadline: e.currentTarget.value || null })} />
                    ) : task.deadline ? (
                      <Text size="sm" c={task.deadlinePassed ? 'var(--red)' : undefined} fw={task.deadlinePassed ? 600 : 400}>
                        <IconFlag3 size={13} style={{ verticalAlign: -2 }} /> {formatDate(task.deadline, COMPACT)}
                      </Text>
                    ) : (
                      <Text size="sm" c="dimmed">{t('common.none')}</Text>
                    );
                  case 'plannedCost':
                    return admin && !isGroup ? (
                      <CommitNumber value={task.plannedCost ?? 0} min={0} max={999999999} label={t('col.plannedCost')} onCommit={(v) => v !== task.plannedCost && void update(task, { plannedCost: v })} />
                    ) : (
                      <Text size="sm" className="num">{formatMoney(task.plannedCost ?? 0)}</Text>
                    );
                  case 'actualCost':
                    return admin && !isGroup ? (
                      <CommitNumber value={task.actualCost ?? 0} min={0} max={999999999} label={t('col.actualCost')} onCommit={(v) => v !== task.actualCost && void update(task, { actualCost: v })} />
                    ) : (
                      <Text size="sm" className="num" c={task.overBudget ? 'var(--red)' : undefined}>{formatMoney(task.actualCost ?? 0)}</Text>
                    );
                  case 'labels':
                    return (
                      <Group gap={4} wrap="nowrap" style={{ overflow: 'hidden' }}>
                        {(task.labelIds ?? []).map((lid) => {
                          const l = labelsById.get(lid);
                          return l ? (
                            <span key={lid} className="nz-chip-label" style={{ '--lc': l.color } as CSSProperties}>
                              {l.name}
                            </span>
                          ) : null;
                        })}
                      </Group>
                    );
                  default: {
                    const fid = fieldIdOf(id);
                    const v = fid ? task.customValues?.[fid] : null;
                    const field = fid ? fieldsById.get(fid) : undefined;
                    const text = v === null || v === undefined ? '' : field?.type === 'CHECKBOX' ? (v ? t('common.yes') : t('common.no')) : field?.type === 'NUMBER' ? formatNumber(Number(v)) : String(v);
                    return <Text size="sm" truncate>{text}</Text>;
                  }
                }
              };
              return (
                <tr
                  key={task.id}
                  tabIndex={focus === r.index ? 0 : -1}
                  data-list-row={r.index}
                  data-focused={focus === r.index}
                  aria-level={r.depth + 1}
                  aria-expanded={isGroup ? !collapsed.has(task.id) : undefined}
                  onFocus={(e) => e.target === e.currentTarget && setFocus(r.index)}
                  onClick={() => setFocus(r.index)}
                  onKeyDown={(e) => onRowKey(e, r.index)}
                >
                  {selecting ? (
                    <td onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        size="xs"
                        aria-label={t('grid.selectRow', { name: task.name })}
                        checked={Boolean(selected?.has(task.id))}
                        onChange={() => {
                          const next = new Set(selected ?? []);
                          if (next.has(task.id)) next.delete(task.id);
                          else next.add(task.id);
                          onSelectionChange?.(next);
                        }}
                      />
                    </td>
                  ) : null}
                  {shown.map((c) => (
                    <td key={c.id} style={{ width: c.width, maxWidth: c.width }}>
                      {cellOf(c.id)}
                    </td>
                  ))}
                  {admin ? (
                    <td>
                      <ActionIcon variant="subtle" color="breach" aria-label={t('list.delete', { name: task.name })} onClick={() => remove(task)}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {last < rows.length - 1 ? <tr style={{ height: (rows.length - 1 - last) * ROW }} aria-hidden /> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A text cell that saves on blur or Enter (Escape restores). */
function CommitText({ value, label, bold, onCommit }: { value: string; label: string; bold?: boolean; onCommit(v: string): void }) {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setV(value);
  }
  return (
    <TextInput
      size="xs"
      variant="unstyled"
      aria-label={label}
      value={v}
      styles={{ input: { fontWeight: bold ? 600 : 400, minWidth: 0 } }}
      style={{ flex: 1, minWidth: 0 }}
      onChange={(e) => setV(e.currentTarget.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
      }}
    />
  );
}

function CommitNumber(p: { value: number; min: number; max: number; step?: number; label: string; suffix?: string; onCommit(v: number): void }) {
  const [v, setV] = useState<number | string>(p.value);
  const [prev, setPrev] = useState(p.value);
  if (prev !== p.value) {
    setPrev(p.value);
    setV(p.value);
  }
  const commit = () => {
    const n = Math.min(p.max, Math.max(p.min, Number(v)));
    if (Number.isFinite(n)) p.onCommit(n);
  };
  return (
    <NumberInput
      size="xs"
      aria-label={p.label}
      value={v}
      min={p.min}
      max={p.max}
      step={p.step ?? 1}
      suffix={p.suffix}
      hideControls
      onChange={setV}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
}
