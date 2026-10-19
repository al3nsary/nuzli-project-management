import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { ActionIcon, Button, Group, Popover, SegmentedControl, Switch, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconCalendarEvent, IconChevronLeft, IconChevronRight, IconFlag } from '@tabler/icons-react';
import { can } from '@nuzli/shared';
import type { TabProps } from './types';
import type { TaskView } from '../../../api/hoursWire';
import { unitOf } from '../../../api/hoursWire';
import { ApiError, errorMessage } from '../../../api/errors';
import { useAuthStore } from '../../../stores/auth';
import { formatLocalTime, formatNumber, getDisplayPrefs, t } from '../../../i18n';
import { riyadhToday } from '../../../features/projects/engine';
import { engineState } from '../../../features/gantt/batch';
import { UserAvatar } from '../../../components/UserAvatar';
import { dirSign } from '../../../lib/direction';
import { taskStatusLabel } from '../parts';
import {
  dayKind,
  deadlinesByDay,
  dragDeltaColumns,
  dragDeltaDays,
  initialAnchor,
  itemsOnDay,
  layoutWeek,
  nearestOutside,
  stepAnchor,
  taskDays,
  viewWeeks,
  type CalendarView,
  type DeadlineMark,
  type IsoDay,
  type SpanItem,
} from '../../../features/calendar/calendarMath';
import { dayNumber, hijriDay, hijriSpan, longDay, monthTitle, shortDate, weekdayNames } from '../../../features/calendar/calendarFormat';
import { previewCalendarMove } from '../../../features/calendar/drag';
import cls from '../../../features/calendar/Calendar.module.css';

interface CalItem extends SpanItem {
  task: TaskView;
}

const MONTH_LANES = 3;
const LANE_H = 27; // 24px bar + 3px gap
const PREF_KEY = 'nz.cal.prefs';

function readPrefs(): { view: CalendarView; groups: boolean } {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    const p = raw ? (JSON.parse(raw) as { view?: string; groups?: boolean }) : {};
    return { view: p.view === 'week' ? 'week' : 'month', groups: p.groups === true };
  } catch {
    return { view: 'month', groups: false };
  }
}
function writePrefs(p: { view: CalendarView; groups: boolean }) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* private mode: the default comes back next time */
  }
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/** Colour carries state (design skill): custom bar colour, else done / overdue / on hold / in progress / not started. */
export function barTone(task: TaskView, end: IsoDay, today: IsoDay): string {
  if (task.barColor && HEX.test(task.barColor)) return task.barColor;
  if (task.type === 'GROUP') return 'var(--ink)';
  if (task.status === 'DONE') return 'var(--live)';
  if (end < today) return 'var(--red)';
  if (task.status === 'ON_HOLD') return 'var(--amber)';
  if (task.status === 'IN_PROGRESS') return 'var(--primary)';
  return 'var(--dim2)';
}

interface DragState {
  id: string;
  pointerId: number;
  x0: number;
  y0: number;
  row0: number;
  cellW: number;
  started: boolean;
  delta: number;
}

export function ProjectCalendarTab({ data, writes, onOpenTask, visible }: TabProps) {
  const user = useAuthStore((s) => s.user);
  const editable = can(user, 'tasks.manage');
  const showHijri = user?.preferences.showHijri ?? false;
  const digits = getDisplayPrefs().digits;
  const phone = useMediaQuery('(max-width: 47.99em)', false, { getInitialValueInEffect: false }) ?? false;
  const unit = unitOf(data.project);
  const today = riyadhToday();

  const [prefs, setPrefs] = useState(readPrefs);
  const view = prefs.view;
  const setView = (v: CalendarView) => {
    const next = { ...prefs, view: v };
    setPrefs(next);
    writePrefs(next);
  };
  const setGroups = (g: boolean) => {
    const next = { ...prefs, groups: g };
    setPrefs(next);
    writePrefs(next);
  };

  // ------------------------------------------------------------ drag preview
  const state = useMemo(() => engineState(data), [data]);
  const [drag, setDrag] = useState<{ id: string; delta: number } | null>(null);
  const preview = useMemo(() => {
    if (!drag || !drag.delta) return null;
    const task = data.tasks.find((x) => x.id === drag.id);
    return task ? previewCalendarMove(data, state, task, drag.delta) : null;
  }, [drag, data, state]);

  const tasks = useMemo<TaskView[]>(
    () => (preview?.changes.length ? data.tasks.map((x) => (preview.byId.get(x.id) as TaskView | undefined) ?? x) : data.tasks),
    [data.tasks, preview],
  );

  const items = useMemo<CalItem[]>(
    () =>
      tasks
        .filter((x) => visible(x) && (prefs.groups || x.type !== 'GROUP'))
        .map((task) => ({ id: task.id, ...taskDays(task, unit), task })),
    [tasks, visible, prefs.groups, unit],
  );
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const deadlines = useMemo(() => deadlinesByDay(tasks.filter(visible), today), [tasks, visible, today]);
  const taskName = useCallback((id: string) => data.tasks.find((x) => x.id === id)?.name ?? '', [data.tasks]);

  // ------------------------------------------------------------ anchor and range
  const [anchor, setAnchor] = useState<IsoDay>(() =>
    initialAnchor(
      data.tasks.map((x) => ({ id: x.id, ...taskDays(x, unit) })),
      today,
    ),
  );
  const weeks = useMemo(() => viewWeeks(view, anchor), [view, anchor]);
  const from = weeks[0]![0]!;
  const to = weeks[weeks.length - 1]![6]!;
  const inRange = items.some((i) => i.end >= from && i.start <= to);
  const nearest = inRange ? null : nearestOutside(items, from, to);
  const [selected, setSelected] = useState<IsoDay | null>(null);
  useEffect(() => setSelected(null), [view, anchor]);

  const title = view === 'month' ? monthTitle(anchor, digits) : t('a9c.range', { from: shortDate(from, digits), to: shortDate(to, digits, true) });
  const subTitle = showHijri ? hijriSpan(view === 'month' ? `${anchor.slice(0, 7)}-01` : from, view === 'month' ? weeks[weeks.length - 1]![0]! : to, digits) : null;

  // ------------------------------------------------------------ pointer drag (mouse and touch)
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);

  const rowAt = (y: number): number => {
    const rows = rowsRef.current;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]?.getBoundingClientRect();
      if (r && y < r.bottom) return i;
    }
    return Math.max(0, rows.length - 1);
  };

  const commitMove = useCallback(
    async (id: string, delta: number) => {
      const task = data.tasks.find((x) => x.id === id);
      setDrag(null);
      if (!task || !delta) return;
      const p = previewCalendarMove(data, state, task, delta);
      if (!p.changes.length) return;
      const res = await writes.commitBatch(p.changes, t('undo.label.move'));
      if (!res.ok && !(res.error instanceof ApiError && res.error.code === 'CONFLICT_VERSION')) {
        notifications.show({ color: 'breach', title: t('a9c.moveFailed'), message: errorMessage(res.error) });
      }
    },
    [data, state, writes],
  );

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>, id: string, row: number) => {
    if (!editable || e.button !== 0 || phone) return;
    const rowEl = rowsRef.current[row];
    const cellW = (rowEl?.getBoundingClientRect().width ?? 700) / 7;
    dragRef.current = { id, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, row0: row, cellW, started: false, delta: 0 };
    const sign = dirSign(e.currentTarget);
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      const dx = ev.clientX - d.x0;
      const dy = ev.clientY - d.y0;
      if (!d.started && Math.hypot(dx, dy) < 5) return;
      d.started = true;
      ev.preventDefault();
      const dRows = view === 'month' ? rowAt(ev.clientY) - d.row0 : 0;
      const delta = dragDeltaDays(dragDeltaColumns(dx, d.cellW, sign), dRows);
      if (delta !== d.delta) {
        d.delta = delta;
        setDrag({ id: d.id, delta });
      }
    };
    const end = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      dragRef.current = null;
      if (!d.started) return; // a click: onClick opens the task
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      if (ev.type === 'pointercancel') setDrag(null);
      else void commitMove(d.id, d.delta);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const onBarClick = (id: string) => {
    if (suppressClick.current) return;
    onOpenTask(id);
  };

  const onBarKey = (e: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenTask(id);
      return;
    }
    if (editable && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      // Physical arrow × direction sign: in RTL the left arrow goes to a later day.
      const delta = (e.key === 'ArrowLeft' ? -1 : 1) * dirSign(e.currentTarget);
      void commitMove(id, delta);
    }
  };

  // ------------------------------------------------------------ rendering helpers
  const dragStatus = drag && drag.delta ? t(drag.delta > 0 ? 'a9c.drag.later' : 'a9c.drag.earlier', { n: Math.abs(drag.delta) }) : '';

  const tooltipFor = (it: CalItem): ReactNode => {
    const x = it.task;
    const range =
      unit === 'HOUR'
        ? it.start === it.end
          ? `${shortDate(it.start, digits)} · ${formatLocalTime(x.startDate)} – ${formatLocalTime(x.endDate)}`
          : `${shortDate(it.start, digits)} ${formatLocalTime(x.startDate)} – ${shortDate(it.end, digits)} ${formatLocalTime(x.endDate)}`
        : it.start === it.end
          ? shortDate(it.start, digits, true)
          : t('a9c.range', { from: shortDate(it.start, digits), to: shortDate(it.end, digits, true) });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <strong>{x.name}</strong>
        <span>{range}</span>
        <span>
          {x.type === 'MILESTONE' ? t('a9c.legend.milestone') : x.type === 'GROUP' ? t('a9c.legend.group') : taskStatusLabel(x.status)}
          {x.assignee ? ` · ${x.assignee.fullName}${x.assignee.teamName ? ` — ${x.assignee.teamName}` : ''}` : ''}
        </span>
        {x.deadline ? <span>{t('a9c.deadlineOn', { date: shortDate(x.deadline.slice(0, 10), digits, true) })}</span> : null}
      </div>
    );
  };

  const ariaFor = (it: CalItem) =>
    t('a9c.barAria', {
      name: it.task.name,
      from: shortDate(it.start, digits),
      to: shortDate(it.end, digits),
      status: it.task.type === 'MILESTONE' ? t('a9c.legend.milestone') : taskStatusLabel(it.task.status),
    });

  const renderBar = (it: CalItem, seg: { colStart: number; colEnd: number; lane: number; continuesBefore: boolean; continuesAfter: boolean }, row: number, weekView: boolean) => {
    const x = it.task;
    const tone = barTone(x, it.end, today);
    const moving = !!preview?.byId.has(x.id);
    const kind = x.type === 'GROUP' ? cls.group : x.type === 'MILESTONE' ? cls.milestone : '';
    const className = [cls.bar, kind, editable ? cls.editable : '', seg.continuesBefore ? cls.cutStart : '', seg.continuesAfter ? cls.cutEnd : '', moving ? cls.moving : '']
      .filter(Boolean)
      .join(' ');
    const showTime = weekView && unit === 'HOUR' && !seg.continuesBefore && x.type !== 'GROUP';
    const style = {
      '--c': tone,
      gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 2}`,
      gridRow: seg.lane + 1,
    } as CSSProperties;
    return (
      <Tooltip key={x.id} label={tooltipFor(it)} multiline w={280} openDelay={350} disabled={!!drag} withinPortal>
        <div
          role="button"
          tabIndex={0}
          className={className}
          style={style}
          aria-label={ariaFor(it)}
          onPointerDown={(e) => onPointerDown(e, x.id, row)}
          onClick={() => onBarClick(x.id)}
          onKeyDown={(e) => onBarKey(e, x.id)}
          data-task-id={x.id}
        >
          {x.type === 'MILESTONE' ? <span className={cls.diamond} aria-hidden /> : null}
          {x.type === 'TASK' && x.progress > 0 ? <span className={cls.progress} style={{ width: `${Math.min(100, x.progress)}%` }} aria-hidden /> : null}
          {showTime ? <span className={cls.barTime}>{formatLocalTime(x.startDate)}</span> : null}
          <span className={cls.barText}>{x.name}</span>
          {x.assignee && x.type !== 'GROUP' && seg.colEnd > seg.colStart ? (
            <UserAvatar name={x.assignee.fullName} size={18} ring={false} className={cls.barAvatar} />
          ) : null}
        </div>
      </Tooltip>
    );
  };

  const flagButton = (day: IsoDay, marks: DeadlineMark[] | undefined) => {
    if (!marks?.length) return null;
    const passed = marks.some((m) => m.passed);
    return (
      <Popover position="bottom" withArrow shadow="md" withinPortal>
        <Popover.Target>
          <button
            type="button"
            className={`${cls.flagBtn} ${passed ? cls.flagPassed : ''}`}
            aria-label={t(passed ? 'a9c.deadlinesPassedAria' : 'a9c.deadlinesAria', { n: marks.length, date: shortDate(day, digits) })}
          >
            <IconFlag size={14} stroke={2} aria-hidden />
            {marks.length > 1 ? formatNumber(marks.length) : null}
          </button>
        </Popover.Target>
        <Popover.Dropdown>
          <Text size="xs" fw={600} c="dimmed" mb={6}>
            {t('a9c.deadlinesOf', { date: shortDate(day, digits, true) })}
          </Text>
          <div className={cls.list}>
            {marks.map((m) => (
              <button
                key={m.id}
                type="button"
                className={cls.listItem}
                style={{ '--c': m.passed ? 'var(--red)' : 'var(--accent)' } as CSSProperties}
                onClick={() => onOpenTask(m.id)}
              >
                <IconFlag size={14} aria-hidden />
                <span className={cls.listMain}>
                  <span className={cls.listName}>{taskName(m.id)}</span>
                  <span className={cls.listMeta}>{m.passed ? t('a9c.deadlinePassed') : t('a9c.deadline')}</span>
                </span>
              </button>
            ))}
          </div>
        </Popover.Dropdown>
      </Popover>
    );
  };

  const itemList = (list: CalItem[]) => (
    <div className={cls.list}>
      {list.map((it) => (
        <button
          key={it.id}
          type="button"
          className={cls.listItem}
          style={{ '--c': barTone(it.task, it.end, today) } as CSSProperties}
          onClick={() => onOpenTask(it.id)}
        >
          {it.task.type === 'MILESTONE' ? <span className={cls.diamond} aria-hidden /> : null}
          <span className={cls.listMain}>
            <span className={cls.listName}>{it.task.name}</span>
            <span className={cls.listMeta}>
              {(unit === 'HOUR' && it.start === it.end
                ? `${formatLocalTime(it.task.startDate)} – ${formatLocalTime(it.task.endDate)}`
                : it.start === it.end
                  ? shortDate(it.start, digits)
                  : t('a9c.range', { from: shortDate(it.start, digits), to: shortDate(it.end, digits) })) +
                ` · ${it.task.type === 'MILESTONE' ? t('a9c.legend.milestone') : it.task.type === 'GROUP' ? t('a9c.legend.group') : taskStatusLabel(it.task.status)}`}
            </span>
          </span>
          {it.task.assignee ? <UserAvatar name={it.task.assignee.fullName} size={24} ring={false} /> : null}
        </button>
      ))}
    </div>
  );

  // ------------------------------------------------------------ views
  const weekNames = weekdayNames(phone ? 'narrow' : 'long', digits);
  const monthKey = anchor.slice(0, 7);
  const headH = showHijri ? 44 : 30;

  const desktopWeek = (week: IsoDay[], row: number) => {
    const weekView = view === 'week';
    const lay = layoutWeek(week, items, weekView ? Infinity : MONTH_LANES);
    const shownLanes = weekView ? lay.lanes : Math.min(lay.lanes, MONTH_LANES);
    const anyHidden = lay.hidden.some((h) => h.length);
    const rowH = weekView ? Math.max(380, headH + shownLanes * LANE_H + 16) : headH + Math.max(shownLanes, 2) * LANE_H + (anyHidden ? 26 : 8);
    return (
      <div
        key={week[0]}
        className={cls.week}
        ref={(el) => {
          rowsRef.current[row] = el;
        }}
        style={{ '--row-h': `${rowH}px`, '--head-h': `${headH}px` } as CSSProperties}
      >
        <div className={cls.days}>
          {week.map((day, c) => {
            const k = dayKind(day, data.calendar);
            const outside = view === 'month' && day.slice(0, 7) !== monthKey;
            const isToday = day === today;
            const hidden = lay.hidden[c]!;
            return (
              <div
                key={day}
                className={[cls.day, k.holiday !== null ? cls.holiday : k.weekend ? cls.weekend : '', outside ? cls.outside : '', isToday ? cls.today : ''].filter(Boolean).join(' ')}
                aria-label={longDay(day, digits)}
              >
                <div className={cls.dayHead}>
                  <span className={`${cls.dayNum} ${isToday ? cls.todayNum : ''}`} aria-current={isToday ? 'date' : undefined}>
                    {dayNumber(day, digits)}
                  </span>
                  {k.holiday !== null ? (
                    <Tooltip label={k.holiday || t('a9c.holiday')} withinPortal>
                      <span className={cls.holidayName}>{k.holiday || t('a9c.holiday')}</span>
                    </Tooltip>
                  ) : null}
                  <span className={cls.dayFlags}>{flagButton(day, deadlines.get(day))}</span>
                </div>
                {showHijri ? <span className={cls.hijri}>{hijriDay(day, digits)}</span> : null}
                {hidden.length ? (
                  <Popover position="bottom" withArrow shadow="md" withinPortal>
                    <Popover.Target>
                      <button type="button" className={cls.more} aria-label={t('a9c.moreAria', { n: hidden.length, date: shortDate(day, digits) })}>
                        {t('a9c.more', { n: hidden.length })}
                      </button>
                    </Popover.Target>
                    <Popover.Dropdown>
                      <Text size="xs" fw={600} c="dimmed" mb={6}>
                        {longDay(day, digits)}
                      </Text>
                      {itemList(hidden.map((id) => byId.get(id)!).filter(Boolean))}
                    </Popover.Dropdown>
                  </Popover>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className={cls.bars}>
          {lay.segments.filter((s) => s.lane < shownLanes).map((s) => renderBar(byId.get(s.id)!, s, row, weekView))}
        </div>
      </div>
    );
  };

  const compactWeek = (week: IsoDay[]) => (
    <div key={week[0]} className={cls.week}>
      <div className={cls.days}>
        {week.map((day) => {
          const k = dayKind(day, data.calendar);
          const outside = day.slice(0, 7) !== monthKey;
          const on = itemsOnDay(items, day);
          const marks = deadlines.get(day);
          const isToday = day === today;
          return (
            <button
              key={day}
              type="button"
              className={[cls.day, cls.compactDay, k.holiday !== null ? cls.holiday : k.weekend ? cls.weekend : '', outside ? cls.outside : '', selected === day ? cls.selected : ''].filter(Boolean).join(' ')}
              aria-pressed={selected === day}
              aria-label={t('a9c.dayAria', { date: longDay(day, digits), n: on.length })}
              onClick={() => setSelected(selected === day ? null : day)}
            >
              <span className={`${cls.dayNum} ${isToday ? cls.todayNum : ''}`}>{dayNumber(day, digits)}</span>
              {showHijri ? <span className={cls.hijri}>{hijriDay(day, digits)}</span> : null}
              <span className={cls.dots} aria-hidden>
                {on.slice(0, 3).map((it) => (
                  <span key={it.id} className={cls.dot} style={{ '--c': barTone(it.task, it.end, today) } as CSSProperties} />
                ))}
                {on.length > 3 ? <span className={cls.dotMore}>{t('a9c.more', { n: on.length - 3 })}</span> : null}
                {marks?.length ? (
                  <span className={`${cls.compactFlag} ${marks.some((m) => m.passed) ? cls.flagPassed : ''}`}>
                    <IconFlag size={10} stroke={2.4} />
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const dayPanel = (day: IsoDay) => {
    const k = dayKind(day, data.calendar);
    const list = itemsOnDay(items, day);
    const marks = deadlines.get(day) ?? [];
    return (
      <section key={day} className={cls.dayPanel} aria-label={longDay(day, digits)}>
        <div className={cls.dayPanelHead}>
          <h3 className={cls.dayPanelTitle}>{longDay(day, digits)}</h3>
          {showHijri ? <Text size="xs" c="dimmed">{hijriDay(day, digits)}</Text> : null}
          {k.holiday !== null ? <Text size="xs" c="dimmed">{k.holiday || t('a9c.holiday')}</Text> : k.weekend ? <Text size="xs" c="dimmed">{t('a9c.legend.weekend')}</Text> : null}
        </div>
        {list.length ? itemList(list) : <Text size="sm" c="dimmed">{t('a9c.dayEmpty')}</Text>}
        {marks.length ? (
          <div className={cls.list}>
            {marks.map((m) => (
              <button key={m.id} type="button" className={cls.listItem} style={{ '--c': m.passed ? 'var(--red)' : 'var(--accent)' } as CSSProperties} onClick={() => onOpenTask(m.id)}>
                <IconFlag size={14} aria-hidden />
                <span className={cls.listMain}>
                  <span className={cls.listName}>{taskName(m.id)}</span>
                  <span className={cls.listMeta}>{m.passed ? t('a9c.deadlinePassed') : t('a9c.deadline')}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    );
  };

  let body: ReactNode;
  if (phone && view === 'week') {
    body = <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{weeks[0]!.map((d) => dayPanel(d))}</div>;
  } else if (phone) {
    body = (
      <>
        <div className={cls.board}>
          <div className={cls.head} aria-hidden>
            {weekNames.map((n, i) => (
              <div key={i} className={cls.headCell} style={{ textAlign: 'center' }}>
                {n}
              </div>
            ))}
          </div>
          {weeks.map((w) => compactWeek(w))}
        </div>
        {selected ? dayPanel(selected) : <Text size="sm" c="dimmed">{t('a9c.tapDay')}</Text>}
      </>
    );
  } else {
    rowsRef.current.length = weeks.length;
    body = (
      <div className={cls.board} role="grid" aria-label={title} aria-readonly={!editable}>
        <div className={cls.head} role="row">
          {weekNames.map((n, i) => (
            <div key={i} role="columnheader" className={`${cls.headCell} ${data.calendar.weekendDays.includes(i) ? cls.headWeekend : ''}`}>
              {n}
            </div>
          ))}
        </div>
        {weeks.map((w, i) => desktopWeek(w, i))}
      </div>
    );
  }

  return (
    <div className={cls.root}>
      <div className={cls.toolbar}>
        <SegmentedControl
          size="sm"
          value={view}
          onChange={(v) => setView(v as CalendarView)}
          data={[
            { value: 'month', label: t('a9c.view.month') },
            { value: 'week', label: t('a9c.view.week') },
          ]}
          aria-label={t('a9c.view.label')}
        />
        <Group gap={4} wrap="nowrap">
          <ActionIcon variant="default" size={36} radius="md" onClick={() => setAnchor(stepAnchor(view, anchor, -1))} aria-label={t(view === 'month' ? 'a9c.prevMonth' : 'a9c.prevWeek')}>
            <IconChevronLeft size={18} className="mirror-rtl" />
          </ActionIcon>
          <Button variant="default" size="sm" h={36} onClick={() => setAnchor(today)}>
            {t('a9c.today')}
          </Button>
          <ActionIcon variant="default" size={36} radius="md" onClick={() => setAnchor(stepAnchor(view, anchor, 1))} aria-label={t(view === 'month' ? 'a9c.nextMonth' : 'a9c.nextWeek')}>
            <IconChevronRight size={18} className="mirror-rtl" />
          </ActionIcon>
        </Group>
        <h2 className={cls.title} aria-live="polite">
          {title}
          {subTitle ? <span className={cls.titleSub}>{subTitle}</span> : null}
        </h2>
        <span className={cls.spacer} />
        <Switch size="sm" label={t('a9c.showGroups')} checked={prefs.groups} onChange={(e) => setGroups(e.currentTarget.checked)} />
      </div>

      <VisuallyHidden aria-live="assertive">{dragStatus}</VisuallyHidden>

      {!inRange ? (
        <div className={cls.emptyStrip} role="status">
          <span className={cls.emptyIcon} aria-hidden>
            <IconCalendarEvent size={20} stroke={1.7} />
          </span>
          <div className={cls.emptyText}>
            <Text fw={600} size="sm">
              {items.length ? t(view === 'month' ? 'a9c.empty.month' : 'a9c.empty.week') : t('a9c.empty.none')}
            </Text>
            <Text size="xs" c="dimmed">
              {items.length ? t('a9c.empty.body') : t('a9c.empty.noneBody')}
            </Text>
          </div>
          {nearest ? (
            <Button variant="light" size="sm" onClick={() => setAnchor(nearest)}>
              {t('a9c.empty.goto', { date: shortDate(nearest, digits, true) })}
            </Button>
          ) : null}
        </div>
      ) : null}

      {body}

      <Legend editable={editable && !phone} />
    </div>
  );
}

function Legend({ editable }: { editable: boolean }) {
  const tones: Array<[string, string]> = [
    ['var(--dim2)', t('a9c.legend.notStarted')],
    ['var(--primary)', t('a9c.legend.inProgress')],
    ['var(--amber)', t('a9c.legend.onHold')],
    ['var(--live)', t('a9c.legend.done')],
    ['var(--red)', t('a9c.legend.overdue')],
  ];
  return (
    <div className={cls.legend} aria-label={t('a9c.legend.label')} role="note">
      {tones.map(([c, label]) => (
        <span key={label} className={cls.legendItem}>
          <span className={cls.swatch} style={{ '--c': c } as CSSProperties} aria-hidden />
          {label}
        </span>
      ))}
      <span className={cls.legendItem}>
        <span className={cls.diamond} style={{ '--c': 'var(--ink)', width: 9, height: 9 } as CSSProperties} aria-hidden />
        {t('a9c.legend.milestone')}
      </span>
      <span className={cls.legendItem}>
        <IconFlag size={13} style={{ color: 'var(--red)' }} aria-hidden />
        {t('a9c.legend.deadline')}
      </span>
      <span className={cls.legendItem}>
        <span className={cls.swatchWeekend} aria-hidden />
        {t('a9c.legend.weekend')}
      </span>
      <span className={cls.legendItem}>
        <span className={cls.swatchHoliday} aria-hidden />
        {t('a9c.legend.holiday')}
      </span>
      {editable ? <span className={cls.legendItem}>{t('a9c.legend.dragHint')}</span> : null}
    </div>
  );
}
